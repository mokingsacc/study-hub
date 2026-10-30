import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { connectorToken } from '../../worker/src/mcp.js';
import { platformRoutes } from '../../worker/src/platform/routes.js';
import { HUB_KEY, BASE, platformEnv, client, signedIn } from './platform-helpers.mjs';

test('switched off: no platform routes, pages or connectors; the hub key gate is unchanged', async () => {
  const { d, env } = platformEnv({ PLATFORM: undefined });
  const c = client(env);
  assert.equal((await c.call('POST', '/api/auth/login', { username: 'x', password: 'y' })).status, 401);
  assert.equal((await c.call('GET', '/api/admin/accounts', undefined, { hubKey: true })).status, 404, 'falls to the hub router, which has no such route');
  assert.equal((await c.call('GET', '/platform.html')).status, 404);
  assert.equal((await c.call('GET', '/js/platform/app.js')).status, 404);
  assert.equal((await c.call('POST', '/mcp/u/pk_' + 'a'.repeat(43), {})).status, 404);
  d.close();
});

test('admin routes need Mo\'s hub key', async () => {
  const { d, env } = platformEnv();
  const c = client(env);
  assert.equal((await c.call('GET', '/api/admin/accounts')).status, 401);
  assert.equal((await c.call('GET', '/api/admin/accounts', undefined, { headers: { 'X-Hub-Key': 'wrong' } })).status, 401);
  assert.equal((await c.call('GET', '/api/admin/accounts', undefined, { hubKey: true })).status, 200);
  d.close();
});

test('invite link: the person picks a password and is signed in; then the API works with CSRF', async () => {
  const { d, env } = platformEnv();
  const admin = client(env);
  const made = (await admin.call('POST', '/api/admin/accounts', { name: 'Sara', cap_usd: 20 }, { hubKey: true })).data;
  assert.match(made.invite_link, /^https:\/\/hub\.test\/#invite=[A-Za-z0-9_-]{32}$/);
  assert.match(made.note, /once/);
  assert.ok(!('password' in made));
  const c = client(env);
  assert.equal((await c.call('GET', '/api/p/ai')).status, 401, 'not signed in yet');
  const r = await c.call('POST', '/api/auth/invite', { token: made.invite_link.split('#invite=')[1], password: 'saras-own-password' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Set-Cookie'), /^__Host-ph_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!('token' in r.data), 'the session token travels only in the HttpOnly cookie');
  const ai = await c.call('GET', '/api/p/ai');
  assert.equal(ai.status, 200);
  assert.equal(ai.data.provider, 'workers_ai');
  assert.equal(ai.data.caps.ceiling_usd, 20);
  // CSRF
  const csrf = c.jar.csrf;
  c.jar.csrf = null;
  assert.equal((await c.call('PUT', '/api/p/ai', { daily_cap_usd: 2 })).status, 403, 'a write without the CSRF token is refused');
  c.jar.csrf = csrf;
  assert.equal((await c.call('PUT', '/api/p/ai', { daily_cap_usd: 2 }, { headers: { Origin: 'https://evil.test' } })).status, 403, 'another site is refused');
  assert.equal((await c.call('PUT', '/api/p/ai', { daily_cap_usd: 2 })).status, 200);
  assert.equal((await c.call('POST', '/api/auth/login', { username: 'x', password: 'y' }, { headers: { Origin: 'https://evil.test' } })).status, 403, 'login CSRF refused');
  // Sign out, sign back in with the chosen password
  assert.equal((await c.call('POST', '/api/auth/logout')).status, 200);
  assert.equal(c.jar.cookie, null);
  assert.equal((await c.call('POST', '/api/auth/login', { username: made.username, password: 'saras-own-password' })).status, 200);
  const again = await admin.call('POST', `/api/admin/accounts/${made.id}/invite`, {}, { hubKey: true });
  assert.match(again.data.invite_link, /#invite=/);
  d.close();
});

test("a platform session never reaches Mo's hub API, and Mo's hub key never acts as a platform user", async () => {
  const { d, env } = platformEnv();
  const { c } = await signedIn(env, 'Adam');
  for (const p of ['/api/state', '/api/map', '/api/export', '/api/settings', '/api/connector']) {
    const r = await c.call('GET', p);
    assert.equal(r.status, 401, `${p} must refuse a platform session`);
  }
  const mo = client(env);
  assert.equal((await mo.call('GET', '/api/p/ai', undefined, { hubKey: true })).status, 401, 'the hub key is not a platform session');
  d.close();
});

test("per-user connector: only that user's tools and data; Mo's own connector unchanged", async () => {
  const { d, env } = platformEnv();
  const { c } = await signedIn(env, 'Adam');
  const made = await c.call('POST', '/api/p/connector', { label: 'iPhone' });
  assert.equal(made.status, 201);
  assert.match(made.data.url, /^https:\/\/hub\.test\/mcp\/u\/pk_/);
  const path = new URL(made.data.url).pathname;
  const rpc = (p, body) => worker.fetch(new Request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  const init = await (await rpc(path, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
  assert.equal(init.result.serverInfo.name, 'study-hub');
  const list = await (await rpc(path, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.ok(Array.isArray(list.result.tools));
  assert.ok(!list.result.tools.some(t => /uworld|nbme|sitting|anki_words/.test(t.name)), "none of Mo's Step 2 tools");
  assert.equal((await rpc('/mcp/u/pk_' + 'z'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
  const moPath = `/mcp/${await connectorToken(HUB_KEY)}`;
  const moInit = await (await rpc(moPath, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
  assert.equal(moInit.result.serverInfo.name, 'step2-practice-hub', "Mo's connector still works");
  const listed = await c.call('GET', '/api/p/connector');
  assert.equal(listed.data.links.length, 1);
  assert.equal((await c.call('DELETE', `/api/p/connector/${listed.data.links[0].id}`)).status, 200);
  assert.equal((await rpc(path, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'revoked at once');
  d.close();
});

test('every platform route is public (sign-in only), signed-in (/api/p, /api/auth) or admin', () => {
  // /api/p/up/:token: what a one-time upload link (made by their own Claude) adds; the token is the key (exams.js).
  // /api/auth/claim: their own copy's first-time setup; the SETUP_CODE is the key, and it shuts once anyone has an account.
  const PUBLIC_OK = new Set(['/api/auth/claim', '/api/auth/login', '/api/auth/invite', '/api/auth/reset', '/api/auth/reset/email', '/api/auth/reset/email/confirm', '/api/p/up/:token']);
  for (const r of platformRoutes()) {
    if (r.who === 'public') assert.ok(PUBLIC_OK.has(r.pattern), `${r.pattern} must not be public`);
    if (r.who === 'session') assert.ok(r.pattern.startsWith('/api/p/') || r.pattern.startsWith('/api/auth/'), r.pattern);
    if (r.who === 'admin') assert.ok(r.pattern.startsWith('/api/admin/'), r.pattern);
  }
});
