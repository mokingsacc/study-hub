import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_KEY, platformEnv, client, signedIn } from './platform-helpers.mjs';
import { connectorToken } from '../../worker/src/mcp.js';
import { currentUser, activeUsers } from '../../worker/src/users.js';
import { platformJobs, runPlatformCron, housekeeping } from '../../worker/src/platform/cron.js';

const assets = { fetch: async req => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'Content-Type': new URL(req.url).pathname.endsWith('.html') ? 'text/html' : 'text/plain' } }) };

test("HUB_OFF: the platform's page, scripts and API only; Mo's routes, pages and connector are 404", async () => {
  const { d, env } = platformEnv({ HUB_OFF: '1', ASSETS: assets });
  const c = client(env);
  const home = await c.call('GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.data, 'asset /platform.html');
  assert.ok(home.headers.get('content-security-policy'), 'the page gets the CSP');
  assert.equal((await c.call('GET', '/js/platform/main.js')).status, 200);
  assert.equal((await c.call('GET', '/js/map/scale.js')).status, 200);
  assert.equal((await c.call('GET', '/api/health')).status, 200);
  for (const p of ['/index.html', '/exam.html', '/js/api.js', '/js/hub/main.js', '/css/hub.css', '/js/platform/../api.js']) {
    assert.equal((await c.call('GET', p)).status, 404, `${p} must not be served on the platform`);
  }
  for (const p of ['/api/state', '/api/map', '/api/export', '/live/map']) {
    assert.equal((await c.call('GET', p, undefined, { hubKey: true })).status, 404, `${p} must not exist on the platform, even with the admin key`);
  }
  const mo = await c.call('POST', `/mcp/${await connectorToken(HUB_KEY)}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(mo.status, 404, "Mo's connector does not exist on the platform");
  // The platform itself works.
  const { c: adam } = await signedIn(env, 'Adam');
  assert.equal((await adam.call('GET', '/api/p/ai')).status, 200);
  d.close();
});

test('HUB_OFF: currentUser fails closed; activeUsers lists the active platform accounts, never Mo', async () => {
  const { d, env } = platformEnv({ HUB_OFF: '1' });
  await assert.rejects(currentUser(env, new Request('https://x/')), e => e.status === 401);
  assert.equal(await currentUser({}, new Request('https://x/')), 'mo', "Mo's hub is unchanged");
  assert.deepEqual(await activeUsers(env), []);
  const a = await signedIn(env, 'Adam');
  const b = await signedIn(env, 'Sara');
  await client(env).call('PATCH', `/api/admin/accounts/${b.id}`, { status: 'paused' }, { hubKey: true });
  assert.deepEqual(await activeUsers(env), [a.id]);
  assert.deepEqual(await activeUsers({ DB: env.DB }), ['mo'], "Mo's Worker still has only Mo");
  d.close();
});

test('platform cron: map jobs every minute, housekeeping hourly; old sessions and codes cleared', async () => {
  assert.deepEqual(platformJobs(Date.UTC(2026, 9, 25, 10, 6)), ['map']);
  assert.deepEqual(platformJobs(Date.UTC(2026, 9, 25, 10, 7)), ['map', 'housekeeping', 'purge', 'library']);
  const started = [];
  const names = runPlatformCron({ scheduledTime: Date.UTC(2026, 9, 25, 10, 7) }, {}, { waitUntil: p => started.push(p) },
    { map: async () => 1, housekeeping: async () => 1, purge: async () => { throw new Error('boom'); }, library: async () => 1 });
  assert.equal(names.length, 4);
  await Promise.all(started);   // a failing job is caught, never thrown
  const { d, env } = platformEnv({ HUB_OFF: '1' });
  const a = await signedIn(env, 'Adam');
  d.run('UPDATE sessions SET expires_at = 1');
  await housekeeping(env, Date.now());
  assert.equal(d.rows('SELECT * FROM sessions WHERE user_id = ?', a.id).length, 0);
  d.close();
});
