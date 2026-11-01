import { HttpError, json, readJson } from '../util.js';
import { noteJob } from '../job-log.js';
import { looksLikeStem } from '../map/guard.js';
import { WEIGHTS_VERSION } from '../map/weights.js';
import { liveSet } from '../map/weight-sets.js';
import { FORM_VERSIONS } from '../answer-core.js';
import { fromRing, persistTrace, rawDb, TRACE_ID_RE } from './trace.js';

export const BUG = { noteMax: 2000, pageMax: 200, callsMax: 30, crumbsMax: 30, errorsMax: 10, bundleMax: 48_000, shotMax: 1_200_000,
  listMax: 30, strMax: 2000, tracesMax: 12 };
export const SOURCES = ['hub', 'anki_voice', 'voice'];
export const SHOT_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const LEFT_OUT = '(left out: it read like question text)';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SECRET_KEY = /^(authorization|cookie|set-cookie|x-hub-key|hub_key|key|token|password|passphrase|secret|api_key|apikey|bearer)$/i;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** An address without its query string, hash or connector token. */
export function cleanUrl(u) {
  const s = String(u || '').slice(0, 400);
  return s.replace(/[?#].*$/, '').replace(/\/mcp\/[0-9a-f]{16,}/gi, '/mcp/<token>');
}

/** The bundle scrubbed (pure): secret-named fields dropped, addresses cleaned, question-like text left out, strings cut. */
export function scrubBundle(v, depth = 0, key = '') {
  if (depth > 6) return null;
  if (typeof v === 'string') {
    let s = /url|href|path/i.test(key) ? cleanUrl(v) : v;
    if (s.length > BUG.strMax) s = `${s.slice(0, BUG.strMax - 1)}…`;
    return s.length > 40 && looksLikeStem(s) ? LEFT_OUT : s;
  }
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 60).map(x => scrubBundle(x, depth + 1, key));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (!SECRET_KEY.test(k)) out[k] = scrubBundle(x, depth + 1, k);
    return out;
  }
  return null;
}

/** The trace ids a bundle names (each call's id, trace_id or retrace_id), unique, at most BUG.tracesMax. */
export function traceIdsOf(bundle) {
  const ids = new Set();
  for (const c of [...(bundle.calls || []), ...(bundle.extra && Array.isArray(bundle.extra.calls) ? bundle.extra.calls : [])]) {
    for (const k of ['id', 'trace_id', 'retrace_id']) if (c && TRACE_ID_RE.test(String(c[k] || ''))) ids.add(String(c[k]));
  }
  return [...ids].slice(-BUG.tracesMax);
}

const list = (v, max) => (Array.isArray(v) ? v.slice(-max) : []);

/** The report as stored (pure apart from the versions): {row, bundle}. Throws HttpError(400) on a bad report. */
export function reportOf(body, env = {}, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Nothing to report.');
  const id = String(body.id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'A report needs its id.');
  const source = SOURCES.includes(body.source) ? body.source : 'hub';
  let note = String(body.note || '').trim().slice(0, BUG.noteMax);
  if (note && looksLikeStem(note)) note = LEFT_OUT;
  const shot = body.shot && typeof body.shot === 'object' ? body.shot : null;
  if (!note && !shot) throw new HttpError(400, 'Say what went wrong, or add a screenshot.');
  const bundle = scrubBundle({
    page: String(body.page || '').slice(0, BUG.pageMax), state: body.state && typeof body.state === 'object' ? body.state : {},
    calls: list(body.calls, BUG.callsMax), crumbs: list(body.crumbs, BUG.crumbsMax), errors: list(body.errors, BUG.errorsMax),
    app: body.app && typeof body.app === 'object' ? body.app : {}, extra: body.extra && typeof body.extra === 'object' ? body.extra : null,
  });
  bundle.server = versionsOf(env);
  // Held under bundleMax: the oldest breadcrumbs go first, then the calls' summaries.
  while (JSON.stringify(bundle).length > BUG.bundleMax && bundle.crumbs.length) bundle.crumbs.shift();
  if (JSON.stringify(bundle).length > BUG.bundleMax) bundle.calls = bundle.calls.map(c => ({ ...c, summary: undefined }));
  if (JSON.stringify(bundle).length > BUG.bundleMax) { bundle.state = {}; bundle.extra = null; }
  return { row: { id, at: now, source, page: bundle.page || null, note }, bundle, shot };
}

/** The versions a report carries: deploy, commit, scoring rules, the live weight set and the answer forms. */
export function versionsOf(env = {}) {
  const dep = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id ? String(env.CF_VERSION_METADATA.id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) : null;
  let live = null;
  try { const s = liveSet(); live = s ? { id: s.id, version: s.version } : null; } catch { live = null; }
  return { deploy: dep, commit: env.GIT_COMMIT ? String(env.GIT_COMMIT).slice(0, 40) : null, weights_version: WEIGHTS_VERSION, weight_set: live, form_versions: FORM_VERSIONS };
}

/** The open topic's last evidence, changes and their words, for the report (one batch; nothing when it fails). */
export async function topicContext(env, user, topicId) {
  if (!topicId || typeof topicId !== 'string' || topicId.length > 120) return null;
  try {
    const db = rawDb(env.DB);
    const [ev, ch] = await db.batch([
      db.prepare('SELECT id, kind, at, source, result, rating FROM evidence WHERE user_id = ?1 AND topic_id = ?2 ORDER BY at DESC, id DESC LIMIT 10').bind(user, topicId),
      db.prepare('SELECT seq, batch_id, at, actor, kind, summary, undone_by FROM map_events WHERE user_id = ?1 AND topic_id = ?2 ORDER BY seq DESC LIMIT 10').bind(user, topicId),
    ]);
    const changes = ch.results || [];
    return { topic_id: topicId, evidence: (ev.results || []).map(r => ({ id: r.id, kind: r.kind, at: r.at, source: r.source, result: r.result ?? r.rating ?? null })),
      changes: changes.map(r => ({ seq: r.seq, batch_id: r.batch_id, at: r.at, actor: r.actor, kind: r.kind, undone: !!r.undone_by })),
      activity: changes.map(r => (r.summary && looksLikeStem(r.summary) ? LEFT_OUT : r.summary)).filter(Boolean) };
  } catch (e) {
    return { topic_id: topicId, error: noTable(e) ? 'no map tables' : String(e && e.message).slice(0, 120) };
  }
}

async function putShot(env, id, shot) {
  const mime = SHOT_MIMES[shot.mime] ? shot.mime : null;
  const data = typeof shot.data === 'string' ? shot.data.replace(/^data:[^,]*,/, '') : '';
  if (!mime || !data || data.length > BUG.shotMax || !B64_RE.test(data)) throw new HttpError(400, 'That screenshot is not a JPEG, PNG or WebP picture under about 900 KB.');
  if (env.LIBRARY && typeof env.LIBRARY.put === 'function') {
    try {
      const key = `u/mo/bugs/${id}.${SHOT_MIMES[mime]}`;
      const bin = atob(data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await env.LIBRARY.put(key, bytes, { httpMetadata: { contentType: mime } });
      return { shot_key: key, shot_mime: mime, shot_data: null };
    } catch (e) { console.error('bug screenshot not put in the bucket, kept in D1', e && e.message); }
  }
  return { shot_key: null, shot_mime: mime, shot_data: data };
}

/** Pins the named traces to the report: saved ones by bug_id, unsaved ones from this isolate's ring. Never throws. */
export async function pinTraces(env, bugId, ids) {
  if (!ids.length) return 0;
  try {
    const db = rawDb(env.DB);
    await db.prepare(`UPDATE debug_traces SET bug_id = ?1 WHERE user_id = 'mo' AND id IN (SELECT value FROM json_each(?2))`).bind(bugId, JSON.stringify(ids)).run();
    const have = new Set(((await db.prepare(`SELECT id FROM debug_traces WHERE user_id = 'mo' AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all()).results || []).map(r => r.id));
    let added = 0;
    for (const id of ids) {
      if (have.has(id)) continue;
      const t = fromRing(id);
      if (t && (await persistTrace(db, t, 'report', { bugId }))) added++;
    }
    return have.size + added;
  } catch (e) {
    if (!noTable(e)) console.error('bug traces not pinned', e && e.message);
    return 0;
  }
}

/** Stores one report (idempotent on its id) and notes its Recent activity line. */
export async function saveReport(env, user, body, { now = Date.now() } = {}) {
  const { row, bundle, shot } = reportOf(body, env, now);
  const db = rawDb(env.DB);
  const had = await db.prepare('SELECT id FROM bug_reports WHERE user_id = ?1 AND id = ?2').bind(user, row.id).first();
  if (had) return { id: row.id, duplicate: true };
  if (bundle.state && bundle.state.topic_id) bundle.topic = await topicContext(env, user, String(bundle.state.topic_id));
  const ids = traceIdsOf(bundle);
  const s = shot ? await putShot(env, row.id, shot) : { shot_key: null, shot_mime: null, shot_data: null };
  const res = await db.prepare(`INSERT INTO bug_reports (id, user_id, at, source, page, note, state, bundle_json, trace_ids, shot_key, shot_mime, shot_data)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?11) ON CONFLICT (user_id, id) DO NOTHING`)
    .bind(row.id, user, row.at, row.source, row.page, row.note, JSON.stringify(bundle), JSON.stringify(ids), s.shot_key, s.shot_mime, s.shot_data).run();
  if (!(res && res.meta && Number(res.meta.changes))) return { id: row.id, duplicate: true };
  const traces = await pinTraces(env, row.id, ids);
  await noteJob(env, { job: 'bug', key: `report:${row.id}`, ref: row.id, state: 'ok', at: row.at, user,
    counts: { source: row.source, shot: !!shot, traces }, detail: row.note || 'a screenshot, no words' });
  return { id: row.id, duplicate: false, traces };
}

/** The reports, newest first, short: {reports: [{id, at, source, page, note, shot, traces, state, fix}], open}. */
export async function bugList(env, user, { state = 'open', limit = BUG.listMax } = {}) {
  const st = ['open', 'fixed', 'dropped', 'all'].includes(state) ? state : 'open';
  const db = rawDb(env.DB);
  const rows = (await db.prepare(`SELECT id, at, source, page, note, state, fix, trace_ids, shot_key IS NOT NULL OR shot_data IS NOT NULL AS shot
    FROM bug_reports WHERE user_id = ?1 AND (?2 = 'all' OR state = ?2) ORDER BY at DESC LIMIT ?3`).bind(user, st, Math.min(Math.max(1, Number(limit) || BUG.listMax), 100)).all()).results || [];
  const open = await db.prepare(`SELECT count(*) AS n FROM bug_reports WHERE user_id = ?1 AND state = 'open'`).bind(user).first('n');
  return { open: Number(open) || 0, reports: rows.map(r => ({ id: r.id, at: new Date(r.at).toISOString(), source: r.source, page: r.page, note: String(r.note || '').slice(0, 160),
    shot: !!r.shot, traces: safeLen(r.trace_ids), state: r.state, ...(r.fix ? { fix: r.fix } : {}) })) };
}
const safeLen = t => { try { return JSON.parse(t || '[]').length; } catch { return 0; } };

/** One report in full: its bundle, the traces pinned to it (each with its route and handler file when known), shot_url. */
export async function bugGet(env, user, id, { origin = null } = {}) {
  const db = rawDb(env.DB);
  const r = await db.prepare('SELECT * FROM bug_reports WHERE user_id = ?1 AND id = ?2').bind(user, String(id || '')).first();
  if (!r) throw new HttpError(404, 'There is no report with that id.');
  let bundle = {};
  try { bundle = JSON.parse(r.bundle_json || '{}'); } catch { bundle = {}; }
  const traces = ((await db.prepare(`SELECT id, at, kind, route, status, ms, why, error, trace_json FROM debug_traces WHERE user_id = ?3 AND (bug_id = ?1
      OR id IN (SELECT value FROM json_each(?2))) ORDER BY at`).bind(r.id, r.trace_ids || '[]', user).all().catch(() => ({ results: [] }))).results || [])
    .map(t => { let j = null; try { j = JSON.parse(t.trace_json); } catch { j = null; } return { id: t.id, at: new Date(t.at).toISOString(), kind: t.kind, route: t.route, status: t.status, ms: t.ms, why: t.why, error: t.error, trace: j }; });
  const hasShot = !!(r.shot_key || r.shot_data);
  return { id: r.id, at: new Date(r.at).toISOString(), source: r.source, page: r.page, note: r.note, state: r.state, fix: r.fix || null,
    closed_at: r.closed_at ? new Date(r.closed_at).toISOString() : null, bundle, traces,
    missing_traces: (() => { try { const want = JSON.parse(r.trace_ids || '[]'); return want.filter(x => !traces.some(t => t.id === x)); } catch { return []; } })(),
    shot: hasShot ? { mime: r.shot_mime, url: `${origin || ''}/api/bugs/${encodeURIComponent(r.id)}/shot` } : null };
}

/** The screenshot's bytes and type, or null. */
export async function shotOf(env, user, id) {
  const db = rawDb(env.DB);
  const r = await db.prepare('SELECT shot_key, shot_mime, shot_data FROM bug_reports WHERE user_id = ?1 AND id = ?2').bind(user, String(id || '')).first();
  if (!r) return null;
  if (r.shot_key && env.LIBRARY && typeof env.LIBRARY.get === 'function') {
    const obj = await env.LIBRARY.get(r.shot_key);
    if (obj) return { mime: r.shot_mime || 'image/jpeg', bytes: new Uint8Array(await obj.arrayBuffer()) };
  }
  if (r.shot_data) {
    const bin = atob(r.shot_data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: r.shot_mime || 'image/jpeg', bytes };
  }
  return null;
}

/** Marks a report fixed (or dropped) with the commit or PR that fixed it, and notes the Recent activity line. */
export async function bugClose(env, user, id, { fix = '', state = 'fixed', now = Date.now() } = {}) {
  const st = state === 'dropped' ? 'dropped' : 'fixed';
  const f = String(fix || '').trim().slice(0, 300);
  if (st === 'fixed' && !f) throw new HttpError(400, 'Say what fixed it: the commit or the pull request.');
  const db = rawDb(env.DB);
  const r = await db.prepare('SELECT id, note, state FROM bug_reports WHERE user_id = ?1 AND id = ?2').bind(user, String(id || '')).first();
  if (!r) throw new HttpError(404, 'There is no report with that id.');
  await db.prepare('UPDATE bug_reports SET state = ?1, fix = ?2, closed_at = ?3 WHERE user_id = ?4 AND id = ?5').bind(st, f || null, now, user, r.id).run();
  const short = (f.match(/pull\/(\d+)/) || [])[1] || (f.match(/\b[0-9a-f]{7,40}\b/i) || [])[0] || '';
  await noteJob(env, { job: 'bug', key: `closed:${r.id}`, ref: r.id, state: 'ok', at: now, user,
    counts: { closed: st, ...(short ? { fix: short.slice(0, 40) } : {}) }, detail: r.note || 'a screenshot, no words' });
  return { id: r.id, state: st, fix: f || null, was: r.state };
}

// ---------------------------------------------------------------- routes

export async function report(request, env, ctx, params, url) {
  const body = await readJson(request, BUG.shotMax + BUG.bundleMax * 2 + 20_000);
  try {
    return json(await saveReport(env, 'mo', body, { now: Date.now() }));
  } catch (e) {
    if (noTable(e)) throw new HttpError(503, 'Problem reports need the hub\'s database update (migration 0072).');
    throw e;
  }
}
export async function listRoute(request, env, ctx, params, url) {
  return json(await bugList(env, 'mo', { state: url.searchParams.get('state') || 'open', limit: url.searchParams.get('limit') }));
}
export async function getRoute(request, env, ctx, params, url) {
  return json(await bugGet(env, 'mo', params.id, { origin: url.origin }));
}
export async function shotRoute(request, env, ctx, params) {
  const s = await shotOf(env, 'mo', params.id);
  if (!s) throw new HttpError(404, 'That report has no screenshot.');
  return new Response(s.bytes, { headers: { 'Content-Type': s.mime, 'Cache-Control': 'private, no-store' } });
}
export async function closeRoute(request, env, ctx, params) {
  const body = await readJson(request);
  return json(await bugClose(env, 'mo', params.id, { fix: body.fix, state: body.state }));
}

