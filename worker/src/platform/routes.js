import { errorResponse, HttpError, json, readJson } from '../util.js';
import { MO } from '../users.js';
import * as auth from './auth.js';
import * as ai from './ai.js';
import * as features from './features.js';
import { selfCheck } from './selfcheck.js';
import { adminToken } from './admin.js';
import { ankiPushWithKey } from './cards.js';
import { PUBLIC_ROUTES as EXAM_PUBLIC, uploadLinkFor } from './exams.js';

const SESSION_COOKIE_HEADERS = token => ({ 'Set-Cookie': auth.sessionCookie(token) });

function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.append(k, v);
  return r;
}

const okJson = (data, status = 200) => json(data, status);

// ------------------------------------------------------------------ handlers

async function login(request, env) {
  const body = await readJson(request, 10_000);
  const r = await auth.login(env, request, body);
  return withHeaders(okJson({ user: r.user, name: r.name, profile: r.profile, must_change: r.must_change, csrf: r.csrf }), SESSION_COOKIE_HEADERS(r.token));
}

async function logout(request, env, ctx, params, url, user, session) {
  await auth.logout(env, session);
  return withHeaders(okJson({ ok: true }), { 'Set-Cookie': auth.clearCookie() });
}

const me = async (request, env, ctx, params, url, user, session) =>
  okJson({ user, name: session.name, profile: session.profile, must_change: session.must_change, csrf: session.csrf });

async function changePassword(request, env, ctx, params, url, user, session) {
  return okJson(await auth.changePassword(env, user, session, await readJson(request, 10_000)));
}

async function acceptInvite(request, env) {
  const r = await auth.acceptInvite(env, request, await readJson(request, 10_000));
  return withHeaders(okJson({ user: r.user, name: r.name, profile: r.profile, must_change: false, csrf: r.csrf }), SESSION_COOKIE_HEADERS(r.token));
}

// Owner mode (their own copy): is the setup screen open, and claiming it (auth.claimOwner).
const claimGet = async (request, env) => okJson({ open: await auth.claimOpen(env) });
async function claimPost(request, env) {
  const body = await readJson(request, 20_000);
  const r = await auth.claimOwner(env, request, body);
  if (features.onAccountCreated) await features.onAccountCreated(env, r.user, { profile: r.profile });
  return withHeaders(okJson({ user: r.user, name: r.name, profile: r.profile, must_change: false, csrf: r.csrf }, 201), SESSION_COOKIE_HEADERS(r.token));
}

const inviteLink = (url, token) => `${url.origin}/#invite=${token}`;

const resetCode = async (request, env) => okJson(await auth.resetWithCode(env, request, await readJson(request, 10_000)).then(() => ({ ok: true })));
const resetEmail = async (request, env, ctx, params, url) => okJson(await auth.requestEmailReset(env, request, await readJson(request, 10_000), url.origin));
const resetEmailConfirm = async (request, env) => okJson(await auth.resetWithEmailToken(env, request, await readJson(request, 10_000)).then(() => ({ ok: true })));

const setEmail = async (request, env, ctx, params, url, user) => okJson(await auth.setEmail(env, user, (await readJson(request, 10_000)).email));

const aiGet = async (request, env, ctx, params, url, user) => okJson(await ai.aiOverview(env, user));
const aiPut = async (request, env, ctx, params, url, user) => okJson(await ai.setAiSettings(env, user, await readJson(request, 10_000)));
const keyPut = async (request, env, ctx, params, url, user) => okJson(await ai.saveKey(env, user, params.provider, (await readJson(request, 10_000)).key));
const keyDelete = async (request, env, ctx, params, url, user) => okJson(await ai.deleteKey(env, user, params.provider));
const keyCheck = async (request, env, ctx, params, url, user) => okJson({ provider: params.provider, status: await ai.checkKey(env, user, params.provider) });

const connList = async (request, env, ctx, params, url, user) => okJson({ links: await auth.listConnectorKeys(env, user) });
async function connCreate(request, env, ctx, params, url, user) {
  const k = await auth.createConnectorKey(env, user, (await readJson(request, 10_000)).label);
  return okJson({ id: k.id, url: url.origin + k.path, shown_once: true }, 201);
}
const connDelete = async (request, env, ctx, params, url, user) => okJson(await auth.revokeConnectorKey(env, user, params.id));

const adminList = async (request, env) => okJson({ accounts: await auth.listAccounts(env) });
async function adminCreate(request, env, ctx, params, url) {
  const body = await readJson(request, 20_000);
  const a = await auth.createAccount(env, MO, body);
  if (body.cap_usd != null) await ai.setAdminCap(env, MO, a.id, body.cap_usd);
  if (features.onAccountCreated) await features.onAccountCreated(env, a.id, body);
  return okJson({ id: a.id, username: a.username, name: a.name, invite_link: inviteLink(url, a.invite), invite_expires_at: a.invite_expires_at,
    note: 'Text this link to the person. It works once, for 7 days: they choose their own password and are signed in.' }, 201);
}
async function adminInvite(request, env, ctx, params, url) {
  const r = await auth.issueInvite(env, MO, params.id);
  return okJson({ id: r.id, invite_link: inviteLink(url, r.invite), invite_expires_at: r.invite_expires_at, note: 'Older links for this person stop working.' });
}
const adminStatus = async (request, env, ctx, params) => okJson(await auth.setStatus(env, MO, params.id, (await readJson(request, 10_000)).status));
const adminReset = async (request, env, ctx, params) => okJson({ ...(await auth.issueResetCode(env, MO, params.id)), note: 'Single use, for 30 minutes.' });
const adminCap = async (request, env, ctx, params) => okJson(await ai.setAdminCap(env, MO, params.id, (await readJson(request, 10_000)).cap_usd));

const adminConnector = async (request, env, ctx, params, url) => okJson({ url: `${url.origin}/mcp/admin/${await adminToken(env.HUB_KEY)}`,
  note: 'Add this to your own Claude as a custom connector, then say "invite my nephew Adam to the study hub, GCSE".' });

// Workers AI's vision model needs Meta's licence accepted once per Cloudflare account (plan §18 step 7).
async function agreeVision(request, env) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new HttpError(503, 'Workers AI is not bound.');
  await env.AI.run(ai.VISION_DEFAULT.workers_ai, { prompt: 'agree' }).catch(e => ({ note: String(e && e.message) }));
  return okJson({ ok: true });
}

// ------------------------------------------------------------------ tables

const PUBLIC = [
  ['POST', '/api/auth/login', login],
  ['POST', '/api/auth/invite', acceptInvite],
  ['GET', '/api/auth/claim', claimGet],
  ['POST', '/api/auth/claim', claimPost],
  ['POST', '/api/auth/reset', resetCode],
  ['POST', '/api/auth/reset/email', resetEmail],
  ['POST', '/api/auth/reset/email/confirm', resetEmailConfirm],
];

// What an upload link may do: 2.5's library upload steps (the page makes a PDF, sends it in parts, then its pages).
const UPLOAD_ROUTES = new Set(['POST /api/p/library/docs', 'PUT /api/p/library/docs/:id/parts/:n', 'POST /api/p/library/docs/:id/complete',
  'POST /api/p/library/docs/:id/pages', 'POST /api/p/library/docs/:id/extract', 'GET /api/p/library/docs/:id', 'POST /api/p/library/run', 'GET /api/p/library']);

// Allowed while a generated password still has to be changed.
const BEFORE_CHANGE = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/password']);

const SIGNED_IN = [
  ['GET', '/api/auth/me', me],
  ['POST', '/api/auth/logout', logout],
  ['POST', '/api/auth/password', changePassword],
  ['PUT', '/api/p/email', setEmail],
  ['GET', '/api/p/self-check', async (request, env, ctx, params, url, user) => okJson(await selfCheck(env, user))],
  ['GET', '/api/p/ai', aiGet],
  ['PUT', '/api/p/ai', aiPut],
  ['PUT', '/api/p/ai/keys/:provider', keyPut],
  ['DELETE', '/api/p/ai/keys/:provider', keyDelete],
  ['POST', '/api/p/ai/keys/:provider/check', keyCheck],
  ['GET', '/api/p/connector', connList],
  ['POST', '/api/p/connector', connCreate],
  ['DELETE', '/api/p/connector/:id', connDelete],
];

const ADMIN = [
  ['GET', '/api/admin/accounts', adminList],
  ['POST', '/api/admin/accounts', adminCreate],
  ['PATCH', '/api/admin/accounts/:id', adminStatus],
  ['POST', '/api/admin/accounts/:id/reset', adminReset],
  ['POST', '/api/admin/accounts/:id/invite', adminInvite],
  ['PUT', '/api/admin/accounts/:id/cap', adminCap],
  ['GET', '/api/admin/connector', adminConnector],
  ['POST', '/api/admin/ai/agree', agreeVision],
];

function compile(list) {
  return list.map(([method, pattern, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { method, pattern, re, keys, handler };
  });
}

let tables = null;
function routeTables() {
  if (tables) return tables;
  const fr = features.routes();
  for (const [, p] of fr) if (!p.startsWith('/api/p/')) throw new Error(`platform feature route ${p} must start with /api/p/`);
  return (tables = { pub: compile([...PUBLIC, ...EXAM_PUBLIC]), signed: compile([...SIGNED_IN, ...fr]), admin: compile(ADMIN) });
}

// Every route, for the tests: [{method, pattern, who}].
export function platformRoutes() {
  const t = routeTables();
  return [...t.pub.map(r => ({ ...r, who: 'public' })), ...t.signed.map(r => ({ ...r, who: 'session' })), ...t.admin.map(r => ({ ...r, who: 'admin' }))]
    .map(({ method, pattern, who }) => ({ method, pattern, who }));
}

export const isPlatformPath = p => p.startsWith('/api/auth/') || p.startsWith('/api/p/') || p.startsWith('/api/admin/');

function match(table, request, url) {
  let pathMatched = false;
  for (const r of table) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return pathMatched ? 'method' : null;
}

async function run(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.status, e.message);
    if (e instanceof URIError) return errorResponse(400, 'That address is not valid.');
    console.error('platform error', e && e.stack || e);
    return errorResponse(500, 'Something went wrong. Please try again in a moment.');
  }
}

/** handlePlatform(request, env, ctx, url, {isAdmin}) for /api/auth/*, /api/p/* and /api/admin/*. */
export async function handlePlatform(request, env, ctx, url, { isAdmin = false } = {}) {
  return run(async () => {
    const t = routeTables();
    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin) return errorResponse(401, 'This needs the admin key.');
      const m = match(t.admin, request, url);
      if (!m) return errorResponse(404, 'There is nothing at that address.');
      if (m === 'method') return errorResponse(405, 'That action is not available here.');
      return m.route.handler(request, env, ctx, m.params, url, MO);
    }
    // The Anki desktop add-on pushes read-only stats with its own key (Bearer), not a browser session.
    if (url.pathname === '/api/p/anki/push' && request.method === 'POST' && /^Bearer\s/i.test(request.headers.get('Authorization') || '')) {
      return ankiPushWithKey(request, env);
    }
    // A one-time upload link from their Claude (exams.js): adds files to that person's library and nothing else.
    const upToken = request.headers.get('X-Upload-Token');
    if (upToken && !url.pathname.startsWith('/api/p/up/')) {
      const m = match(t.signed, request, url);
      if (!m || m === 'method' || !UPLOAD_ROUTES.has(`${request.method} ${m.route.pattern}`)) return errorResponse(403, 'An upload link can only add files.');
      const link = await uploadLinkFor(env, upToken);
      if (!link) return errorResponse(401, 'This upload link has run out. Ask your Claude for a new one.');
      const session = { user: link.user_id, profile: link.profile, prefs_json: link.prefs_json, upload: link };
      return m.route.handler(request, env, ctx, m.params, url, link.user_id, session);
    }
    const pub = match(t.pub, request, url);
    if (pub && pub !== 'method') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return errorResponse(403, 'That request came from another site.');
      return pub.route.handler(request, env, ctx, pub.params, url);
    }
    const m = match(t.signed, request, url);
    if (!m) return errorResponse(pub === 'method' ? 405 : 404, pub === 'method' ? 'That action is not available here.' : 'There is nothing at that address.');
    const session = await auth.resolveSession(env, request);
    if (!session) return withHeaders(errorResponse(401, 'Please sign in.'), { 'Set-Cookie': auth.clearCookie() });
    if (!(await auth.checkCsrf(request, session))) return errorResponse(403, 'Please reload the page and try again.');
    if (m === 'method') return errorResponse(405, 'That action is not available here.');
    if (session.must_change && !BEFORE_CHANGE.has(url.pathname)) return errorResponse(403, 'Please choose your own password first.');
    return m.route.handler(request, env, ctx, m.params, url, session.user, session);
  });
}
