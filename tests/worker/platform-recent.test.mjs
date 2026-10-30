// Study Hub v2, WP6: Recent changes. Every change, by them, their Claude or the hub, listed newest first with who made
// it and Undo while it can still be undone; look changes show too (Make it mine has its own Undo). Only their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result.structuredContent;
};

test('GET /api/p/recent: newest first, one row a change, who made it, undo flips undone; look changes show; nobody else\'s', async () => {
  const { env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }, { name: 'Lipids' }] }] });
  const g = await rpc(env, link, 'galaxy_edit', { ops: [{ op: 'create', title: 'Mock 1', topics: ['Enzymes'] }] });
  assert.ok(g.batch_id);
  await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { accent: 'purple' } } });

  let items = (await alex.c.call('GET', '/api/p/recent')).data.items;
  assert.ok(items.length >= 3);
  assert.equal(items[0].who, 'You');
  assert.match(items[0].what, /purple/);
  assert.equal(items[0].undoable, false, 'look changes undo in Make it mine');
  const claude = items.find(i => i.batch_id === g.batch_id);
  assert.equal(claude.who, 'Your Claude');
  assert.match(claude.what, /Mock 1/);
  assert.equal(claude.undoable, true);
  assert.equal(claude.undone, false);
  assert.ok(items.some(i => i.who === 'You' && /Enzymes|topic/i.test(i.what)));
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at, 'newest first');
  assert.equal(new Set(items.map(i => i.batch_id)).size, items.length, 'one row a change');

  assert.equal((await alex.c.call('POST', '/api/p/undo', { batch_id: g.batch_id })).status, 200);
  items = (await alex.c.call('GET', '/api/p/recent')).data.items;
  assert.equal(items.find(i => i.batch_id === g.batch_id).undone, true);

  const b = (await sam.c.call('GET', '/api/p/recent')).data.items;
  assert.ok(!b.some(i => /Mock 1|purple|Enzymes/.test(i.what)), 'Sam sees none of it');
});

test('GET /api/p/map/recent: hours checked, only their own topics', async () => {
  const { env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }] }] });
  const r = (await alex.c.call('GET', '/api/p/map/recent?hours=24')).data;
  assert.equal(r.hours, 24);
  assert.ok(r.topics.length >= 1);
  assert.equal((await alex.c.call('GET', '/api/p/map/recent?hours=99')).data.hours, 24, 'an odd value falls back to 24');
  assert.equal((await sam.c.call('GET', '/api/p/map/recent?hours=168')).data.topics.length, 0);
});
