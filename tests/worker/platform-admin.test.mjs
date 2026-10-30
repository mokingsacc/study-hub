import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, client } from './platform-helpers.mjs';

async function rpc(env, path, method, params = {}) {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env, { waitUntil() {} });
  if (res.status !== 200) return { status: res.status };
  const j = await res.json();
  return { status: 200, ...j.result };
}
const tool = async (env, path, name, args) => (await rpc(env, path, 'tools/call', { name, arguments: args })).structuredContent;

test("admin connector: Mo's Claude invites people and manages them, without passwords", async () => {
  const { d, env } = platformEnv();
  const admin = client(env);
  assert.equal((await admin.call('GET', '/api/admin/connector')).status, 401);
  const conn = await admin.call('GET', '/api/admin/connector', undefined, { hubKey: true });
  const path = new URL(conn.data.url).pathname;
  assert.match(path, /^\/mcp\/admin\/[0-9a-f]{40}$/);
  assert.equal((await rpc(env, '/mcp/admin/' + '0'.repeat(40), 'ping')).status, 404);
  assert.equal((await rpc({ ...env, HUB_KEY: 'another-key-entirely-000000' }, path, 'ping')).status, 404, 'rotating the admin key retires the address');

  const init = await rpc(env, path, 'initialize');
  assert.equal(init.serverInfo.name, 'study-hub-admin');
  assert.match(init.instructions, /Never ask for, guess or show a password/);
  const names = (await rpc(env, path, 'tools/list')).tools.map(t => t.name);
  assert.deepEqual(names, ['people_list', 'person_invite', 'person_new_link', 'person_pause', 'person_progress', 'person_ai_ceiling']);

  const inv = await tool(env, path, 'person_invite', { name: 'Adam', track: 'gcse', ai_ceiling_usd: 15 });
  assert.match(inv.invite_link, /^https:\/\/hub\.test\/#invite=[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(inv).match(/password"\s*:/), 'no password field');
  // The person uses the link.
  const c = client(env);
  assert.equal((await c.call('POST', '/api/auth/invite', { token: inv.invite_link.split('#invite=')[1], password: 'adams-own-password' })).status, 200);
  let list = (await tool(env, path, 'people_list', {})).people;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Adam');
  assert.equal(list[0].track, 'GCSE');
  assert.equal(list[0].ai.ceiling_usd, 15);
  // New link by first name; pause and resume; ceiling.
  const fresh = await tool(env, path, 'person_new_link', { person: 'adam' });
  assert.match(fresh.invite_link, /#invite=/);
  assert.equal((await tool(env, path, 'person_pause', { person: 'Adam', paused: true })).status, 'paused');
  assert.equal((await c.call('GET', '/api/p/ai')).status, 401, 'paused: signed out at once');
  assert.equal((await tool(env, path, 'person_pause', { person: 'Adam', paused: false })).status, 'active');
  assert.equal((await tool(env, path, 'person_ai_ceiling', { person: 'Adam', usd: 5 })).ai.ceiling_usd, 5);
  // Progress only when they share it themselves.
  assert.equal((await tool(env, path, 'person_progress', { person: 'Adam' })).shared, false);
  assert.equal((await c.call('POST', '/api/auth/login', { username: inv.login, password: 'adams-own-password' })).status, 200, 'signed back in after the pause');
  assert.equal((await c.call('PUT', '/api/p/sharing', { share: true })).status, 200);
  const shared = await tool(env, path, 'person_progress', { person: 'Adam' });
  assert.ok(shared.progress && Array.isArray(shared.progress.rings), JSON.stringify(shared));
  const missing = await rpc(env, path, 'tools/call', { name: 'person_pause', arguments: { person: 'Zed', paused: true } });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.reason, /Nobody called Zed/);
  const badTrack = await rpc(env, path, 'tools/call', { name: 'person_invite', arguments: { name: 'X', track: 'step2' } });
  assert.equal(badTrack.isError, true, "Mo's own Step 2 track is never offered");
  d.close();
});
