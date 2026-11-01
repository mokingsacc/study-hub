import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange } from '../../worker/src/map/change.js';
import { platformEnv, signedIn } from './platform-helpers.mjs';

async function setup(env, d, name) {
  const p = await signedIn(env, name, { profile: 'gcse' });
  const sid = (await p.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Cells', topics: [{ name: 'Osmosis' }] }] });
  const topic = (await p.c.call('GET', `/api/p/subjects/${sid}`)).data.sections.flatMap(s => s.topics).find(t => t.name === 'Osmosis').id;
  const add = await applyChange(env, p.id, { actor: 'claude', surface: 'chat', via: 'test', op: 'misconception.add', args: { topic: `Osmosis (map: ${topic})`, belief: 'Water moves from concentrated to dilute' } });
  assert.ok(add.ok, JSON.stringify(add));
  const gap = await p.c.call('POST', '/api/p/gaps', { topic: topic, gap: 'Does not know what partially permeable means' });
  assert.ok(gap.status < 300, JSON.stringify(gap.data));
  return { ...p, topic, misc: d.db.prepare('SELECT id FROM misconceptions WHERE user_id = ?').get(p.id).id };
}

test('a mix-up: not mine closes it as theirs; the words can be fixed; undo', async () => {
  const { d, env } = platformEnv();
  const a = await setup(env, d, 'Ana');
  const r = await a.c.call('POST', '/api/p/correct', { kind: 'misconception', id: a.misc, action: 'not_mine' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...d.db.prepare('SELECT status, closed_by FROM misconceptions WHERE id = ?').get(a.misc) }, { status: 'closed', closed_by: 'mo' });
  await a.c.call('POST', '/api/p/undo', { batch_id: r.data.batch_id });
  assert.notEqual(d.db.prepare('SELECT status FROM misconceptions WHERE id = ?').get(a.misc).status, 'closed');
  const w = await a.c.call('POST', '/api/p/correct', { kind: 'misconception', id: a.misc, action: 'words', words: 'I mix up which way water moves' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(d.db.prepare('SELECT belief FROM misconceptions WHERE id = ?').get(a.misc).belief, 'I mix up which way water moves');
  d.close();
});

test('a gap note: removed with undo, or reworded; the topic page lists it with its id; nobody else\'s', async () => {
  const { d, env } = platformEnv();
  const a = await setup(env, d, 'Ben');
  const detail = (await a.c.call('GET', `/api/p/topics/${encodeURIComponent(a.topic)}`)).data;
  const g = detail.gaps[0];
  assert.ok(g.id);
  const w = await a.c.call('POST', '/api/p/correct', { kind: 'gap', id: g.id, action: 'words', words: 'Partially permeable: I was not sure of the word' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(d.db.prepare('SELECT gap FROM gaps WHERE id = ?').get(g.id).gap, 'Partially permeable: I was not sure of the word');
  const r = await a.c.call('POST', '/api/p/correct', { kind: 'gap', id: g.id, action: 'not_mine' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM gaps WHERE id = ?').get(g.id).n, 0);
  assert.equal((await a.c.call('POST', '/api/p/undo', { batch_id: r.data.batch_id })).status, 200);
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM gaps WHERE id = ?').get(g.id).n, 1, 'undo puts it back');
  const b = await signedIn(env, 'Cy', { profile: 'gcse' });
  assert.equal((await b.c.call('POST', '/api/p/correct', { kind: 'gap', id: g.id, action: 'not_mine' })).status, 404);
  assert.equal((await b.c.call('POST', '/api/p/correct', { kind: 'misconception', id: a.misc, action: 'not_mine' })).status, 404);
  assert.equal((await a.c.call('POST', '/api/p/correct', { kind: 'gap', id: g.id, action: 'words', words: '' })).status, 400);
  d.close();
});
