import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sureGrade, sureReviewRow, FIX } from '../../worker/src/platform/cards.js';
import { platformEnv, signedIn } from './platform-helpers.mjs';

async function withCards(env, name) {
  const p = await signedIn(env, name, { profile: 'gcse' });
  const sid = (await p.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Cells', topics: [{ name: 'Osmosis' }] }] });
  const topic = (await p.c.call('GET', `/api/p/subjects/${sid}`)).data.sections.flatMap(s => s.topics).find(t => t.name === 'Osmosis').id;
  const ids = [];
  for (const f of ['What is osmosis?', 'What is diffusion?', 'What is active transport?']) ids.push((await p.c.call('POST', '/api/p/cards', { front: f, back: 'An answer.', topic_id: topic })).data.card.id);
  return { ...p, topic, ids };
}

test('sureGrade: a guess that came out right counts as Hard; otherwise the rating', () => {
  assert.equal(sureGrade(3, 'guess'), 'hard');
  assert.equal(sureGrade(4, 'guess'), 'hard');
  assert.equal(sureGrade(1, 'guess'), 'again');
  assert.equal(sureGrade(3, 'sure'), 'good');
  const r = sureReviewRow({ id: 7, topic_id: 't', subject_id: 's' }, 1, 'sure', Date.UTC(2026, 9, 31));
  assert.equal(r.kind, 'card_review');
  assert.equal(r.confidence, 'sure');
  assert.equal(JSON.parse(r.detail_json).sure_wrong, true);
});

test('review with Guess writes a card_review row graded Hard; without it no extra row; a bad word is refused', async () => {
  const { d, env } = platformEnv();
  const a = await withCards(env, 'Ana');
  assert.equal((await a.c.call('POST', `/api/p/cards/${a.ids[0]}/review`, { rating: 3, confidence: 'guess' })).status, 200);
  const row = d.db.prepare("SELECT rating, confidence FROM evidence WHERE user_id = ? AND kind = 'card_review'").get(a.id);
  assert.deepEqual({ ...row }, { rating: 'hard', confidence: 'guess' });
  await a.c.call('POST', `/api/p/cards/${a.ids[1]}/review`, { rating: 3 });
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND kind = 'card_review'").get(a.id).n, 1);
  assert.equal((await a.c.call('POST', `/api/p/cards/${a.ids[2]}/review`, { rating: 3, confidence: 'maybe' })).status, 400);
  d.close();
});

test('Skip: until tomorrow; with a reason it waits for their Claude; undo; card_edit lists, fixes and keeps; leeches too', async () => {
  const { d, env } = platformEnv();
  const a = await withCards(env, 'Ben');
  const plain = await a.c.call('POST', `/api/p/cards/${a.ids[0]}/skip`, {});
  assert.equal(plain.data.queued, false);
  assert.ok(d.db.prepare('SELECT due_at FROM cards WHERE id = ?').get(a.ids[0]).due_at > Date.now() + 3_600_000);
  const why = await a.c.call('POST', `/api/p/cards/${a.ids[1]}/skip`, { reason: 'badly_worded' });
  assert.equal(why.data.queued, true);
  assert.equal((await a.c.call('POST', `/api/p/cards/${a.ids[1]}/skip`, { reason: 'boring' })).status, 400);
  let list = (await a.c.call('GET', '/api/p/cards/to-fix')).data.cards;
  assert.deepEqual(list.map(c => [c.id, c.why]), [[a.ids[1], 'they skipped it: badly worded']]);
  // undo puts the due time and the flag back
  await a.c.call('POST', `/api/p/cards/${a.ids[1]}/skip`, { undo: why.data.before });
  assert.deepEqual({ ...d.db.prepare('SELECT fix_reason FROM cards WHERE id = ?').get(a.ids[1]) }, { fix_reason: null });
  // a leech is found; keep takes it off for a month
  d.db.prepare('UPDATE cards SET lapses = ? WHERE id = ?').run(FIX.leech_lapses, a.ids[2]);
  await a.c.call('POST', `/api/p/cards/${a.ids[0]}/skip`, { reason: 'wrong' });
  list = (await a.c.call('GET', '/api/p/cards/to-fix')).data.cards;
  assert.deepEqual(list.map(c => c.id), [a.ids[0], a.ids[2]], 'skipped ones first, then leeches');
  await a.c.call('PATCH', `/api/p/cards/${a.ids[2]}`, { keep: true });
  await a.c.call('PATCH', `/api/p/cards/${a.ids[0]}`, { front: 'What is osmosis, in one sentence?' });
  assert.deepEqual((await a.c.call('GET', '/api/p/cards/to-fix')).data.cards, []);
  // another person's card is not theirs
  const b = await withCards(env, 'Cy');
  assert.equal((await b.c.call('POST', `/api/p/cards/${a.ids[0]}/skip`, { reason: 'wrong' })).status, 404);
  d.close();
});
