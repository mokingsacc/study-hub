// What to do now, Guess / Lean / Sure on a topic (worker/src/platform/now.js) and picture covers (pictures.js), 31 Oct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCovers } from '../../worker/src/platform/pictures.js';
import { platformEnv, signedIn } from './platform-helpers.mjs';

async function student(env, name) {
  const p = await signedIn(env, name, { profile: 'gcse' });
  const sid = (await p.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Transport', topics: [{ name: 'Osmosis' }, { name: 'Diffusion' }] }] });
  const ids = Object.fromEntries((await p.c.call('GET', `/api/p/subjects/${sid}`)).data.sections.flatMap(s => s.topics).map(t => [t.name, t.id]));
  return { ...p, ids };
}

test('What to do now: cards due first, then the big picture of a weak section, at most three; empty when nothing to do', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Ana');
  assert.deepEqual((await a.c.call('GET', '/api/p/next')).data.steps, []);
  await a.c.call('POST', '/api/p/cards', { front: 'Q', back: 'A', topic_id: a.ids.Osmosis });
  const t = Date.now();
  for (const id of Object.values(a.ids)) d.db.prepare('INSERT OR REPLACE INTO topic_scores (user_id, topic_id, seen, t, band, prior_mastery, ref_at, computed_at, refreshed_at) VALUES (?, ?, 1, 0.85, ?, 0.6, ?, ?, ?)').run(a.id, id, 'very_weak', t, t, t);
  const steps = (await a.c.call('GET', '/api/p/next')).data.steps;
  assert.deepEqual(steps.map(s => s.kind), ['cards', 'group']);
  assert.equal(steps[0].href, '#cards/review');
  assert.match(steps[1].prompt, /^Teach me the big picture of Transport: /);
  d.close();
});

test('Guess / Lean / Sure on a topic: one row a day, replaced, taken off by tapping again; not on someone else\'s topic', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Ben');
  const url = `/api/p/topics/${encodeURIComponent(a.ids.Osmosis)}/sure`;
  assert.equal((await a.c.call('POST', url, { level: 'lean' })).data.level, 'lean');
  assert.equal((await a.c.call('POST', url, { level: 'sure' })).data.level, 'sure');
  const rows = d.db.prepare("SELECT rating FROM evidence WHERE user_id = ? AND kind = 'self_rating'").all(a.id);
  assert.deepEqual(rows.map(r => r.rating), ['good']);
  assert.equal((await a.c.call('GET', url)).data.level, 'sure');
  assert.equal((await a.c.call('POST', url, { level: 'sure' })).data.level, null, 'the same level again takes it off');
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND kind = 'self_rating'").get(a.id).n, 0);
  assert.equal((await a.c.call('POST', url, { level: 'maybe' })).status, 400);
  const b = await signedIn(env, 'Cy', { profile: 'gcse' });
  assert.equal((await b.c.call('POST', url, { level: 'sure' })).status, 404);
  d.close();
});

test('cleanCovers: boxes kept inside the picture, too many or too small refused', () => {
  assert.deepEqual(cleanCovers([{ x: 0.9, y: 0.1, w: 0.5, h: 0.1 }]), [{ x: 0.9, y: 0.1, w: 0.1, h: 0.1 }]);
  assert.throws(() => cleanCovers(Array(31).fill({ x: 0, y: 0, w: 0.1, h: 0.1 })), /Up to 30/);
  assert.throws(() => cleanCovers([{ x: 0.1, y: 0.1, w: 0.001, h: 0.1 }]), /too small/);
  assert.throws(() => cleanCovers([{ x: 'a' }]), /x, y, w and h/);
});
