// Chat notes (their Claude saves as it goes, or they paste) and the daily tracker (a beat a minute, a year's grid).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { streaks } from '../../worker/src/platform/activity.js';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  const r = (await res.json()).result;
  return { error: !!r.isError, data: r.structuredContent, text: r.content[0].text };
};

test('chat notes: one chat_key adds to one note; a paste; topic_detail and chat_notes read them; undo; nobody else sees them', async () => {
  const { env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Cells', topics: [{ name: 'Osmosis' }] }] });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  let r = await rpc(env, link, 'chat_save', { summary: 'Understood water potential.', topics: ['Osmosis'], chat_key: 'c1', title: 'Osmosis' });
  assert.equal(r.error, false, r.text);
  r = await rpc(env, link, 'chat_save', { summary: 'Mixed up hypotonic once; next time plasmolysis.', topics: ['Osmosis', 'Nonsense topic'], chat_key: 'c1' });
  assert.equal(r.data.added_to, true);
  assert.deepEqual(r.data.topics_not_found, ['Nonsense topic']);
  const p = await alex.c.call('POST', '/api/p/chats', { text: 'A whole pasted chat about enzymes.' });
  assert.equal(p.status, 201);
  const list = (await alex.c.call('GET', '/api/p/chats')).data.notes;
  assert.equal(list.length, 2);
  const osm = list.find(n => n.title === 'Osmosis');
  assert.equal(osm.saves, 2);
  const full = (await alex.c.call('GET', `/api/p/chats/${osm.id}`)).data.note;
  assert.match(full.body, /water potential[\s\S]*plasmolysis/);
  const td = await rpc(env, link, 'topic_detail', { topic: 'Osmosis' });
  assert.equal(td.data.chats[0].title, 'Osmosis', 'a lesson starts from it');
  assert.equal((await rpc(env, link, 'chat_notes', { topic: 'Osmosis' })).data.notes.length, 1);
  assert.equal((await sam.c.call('GET', '/api/p/chats')).data.notes.length, 0);
  assert.equal((await sam.c.call('GET', `/api/p/chats/${osm.id}`)).status, 404);
  const del = (await alex.c.call('DELETE', `/api/p/chats/${osm.id}`)).data;
  assert.equal((await alex.c.call('GET', '/api/p/chats')).data.notes.length, 1);
  await alex.c.call('POST', '/api/p/undo', { batch_id: del.batch_id });
  assert.equal((await alex.c.call('GET', '/api/p/chats')).data.notes.length, 2);
  assert.ok((await alex.c.call('GET', '/api/p/recent')).data.items.some(i => i.who === 'Your Claude' && /Osmosis/.test(i.what)));
});

test('the daily tracker: beats add minutes to today, capped; things done count; streaks; only their own', async () => {
  const { env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  for (let i = 0; i < 3; i++) await alex.c.call('POST', '/api/p/activity', { seconds: 60 });
  await alex.c.call('POST', '/api/p/activity', { seconds: 99999 });
  const a = (await alex.c.call('GET', '/api/p/activity')).data;
  assert.equal(a.days.length, 1);
  assert.equal(a.days[0].minutes, 5, '3 minutes and one capped at 2');
  assert.equal(a.stats.current, 1);
  assert.equal(a.stats.days_pct, 100);
  assert.equal((await sam.c.call('GET', '/api/p/activity')).data.days.length, 0);
  assert.deepEqual(streaks(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-29'], '2026-10-30'), { longest: 3, current: 1 });
  assert.deepEqual(streaks(['2026-10-27'], '2026-10-30'), { longest: 1, current: 0 });
});
