import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { weakGroups } from '../../worker/src/platform/teach.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

async function mcp(env, c) {
  const path = new URL((await c.call('POST', '/api/p/connector', { label: 'x' })).data.url).pathname;
  return async (name, args) => (await (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} })).json()).result;
}

test('teach_next {group}: one lesson on the first, the members and how; weak sections found; bad groups refused', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Ana', { profile: 'gcse' });
  const sid = (await a.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await a.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Transport', topics: [{ name: 'Osmosis' }, { name: 'Diffusion' }, { name: 'Active transport' }] }] });
  const call = await mcp(env, a.c);
  const r = (await call('teach_next', { group: ['Osmosis', 'Diffusion', 'Active transport'] })).structuredContent;
  assert.ok(r.lesson_id);
  assert.equal(r.topic.name, 'Osmosis');
  assert.deepEqual(r.group.members.map(m => m.name), ['Osmosis', 'Diffusion', 'Active transport']);
  assert.match(r.group.how, /forest/);
  assert.match(r.viva.prompt, /^Osmosis, Diffusion, Active transport: tell me what you know about each/);
  assert.equal((await call('teach_next', { group: ['Osmosis'] })).isError, true, 'one topic is not a group');
  assert.equal((await call('teach_next', { group: ['Osmosis', 'Diffusion'], topic: 'Osmosis' })).isError, true);
  // weak sections: two weak topics in one section
  const ids = d.db.prepare("SELECT id FROM topics WHERE user_id = ? AND name IN ('Osmosis', 'Diffusion')").all(a.id).map(r => r.id);
  const t = Date.now();
  for (const id of ids) d.db.prepare('INSERT OR REPLACE INTO topic_scores (user_id, topic_id, seen, t, band, prior_mastery, ref_at, computed_at, refreshed_at) VALUES (?, ?, 1, 0.8, ?, 0.6, ?, ?, ?)').run(a.id, id, 'very_weak', t, t, t);
  const g = await weakGroups(env, a.id);
  assert.equal(g.length, 1);
  assert.equal(g[0].section, 'Transport');
  assert.deepEqual(g[0].topics.map(t => t.name).sort(), ['Diffusion', 'Osmosis']);
  d.close();
});
