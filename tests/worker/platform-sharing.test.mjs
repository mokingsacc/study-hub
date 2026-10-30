import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformEnv, signedIn } from './platform-helpers.mjs';
import { ROUTES, sharedSummary, sharedSummaryIfOn, isSharing } from '../../worker/src/platform/sharing.js';
import { norm } from '../../public/js/shared/names.js';

const NOW = Date.parse('2026-10-25T10:00:00Z');
const handler = (method, pattern) => ROUTES.find(r => r[0] === method && r[1] === pattern)[2];

async function call(env, who, method, body) {
  const req = new Request('https://hub.test/api/p/sharing', { method, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const res = await handler(method, '/api/p/sharing')(req, env, {}, {}, new URL(req.url), who, { user: who });
    return { status: res.status, data: await res.json() };
  } catch (e) {
    return { status: e.status || 500, data: { error: e.message } };
  }
}

const SECRETS = ['SECRET-GAP-TEXT', 'SECRET-NOTE-TITLE', 'SECRET-CARD-FRONT', 'SECRET-RESULT-LABEL', 'SECRET-PAPER-ANSWER'];

// Biology and Chemistry with topics, results (the map scores them), cards, a library item, a gap, a labelled result and a paper.
async function seed(d, env, a) {
  const user = a.id;
  for (const [sid, sname, topics] of [['gcse-biology', 'Biology', [['t-cells', 'Cells'], ['t-enzymes', 'Enzymes'], ['t-photo', 'Photosynthesis']]], ['gcse-chemistry', 'Chemistry', [['t-rates', 'Rates of reaction'], ['t-bonding', 'Bonding'], ['t-acids', 'Acids and alkalis']]]]) {
    d.run("INSERT INTO subjects (user_id, id, track, subject, name, board, status, sort, created_at, updated_at) VALUES (?, ?, 'gcse', ?, ?, 'aqa', 'active', 0, ?, ?)", user, sid, sid.split('-')[1], sname, NOW, NOW);
    d.run("INSERT INTO categories (user_id, id, name, short_name, sort, exam_profile, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'gcse', ?, ?)", user, sid, sname, sname, NOW, NOW);
    for (const [tid, tname] of topics) {
      d.run("INSERT INTO topics (user_id, id, name, kind, status, category_id, source, created_by, created_at, updated_at) VALUES (?, ?, ?, 'concept', 'confirmed', ?, 'seed', 'seed', ?, ?)", user, tid, tname, sid, NOW, NOW);
      d.run("INSERT INTO topic_aliases (user_id, alias_key, topic_id, alias, kind, source, created_by, created_at) VALUES (?, ?, ?, ?, 'name', 'seed', 'seed', ?)", user, norm(tname), tid, tname, NOW);
    }
  }
  const rows = [['Cells', 3, 3], ['Enzymes', 0, 4], ['Photosynthesis', 1, 4], ['Quantum chromodynamics', 1, 2]].map(([topic, marks, out_of], i) => ({ q: String(i + 1), marks, out_of, topic }));
  for (let i = 0; i < 7; i++) {
    const r = await a.c.call('POST', '/api/p/results', { bank: 'past_paper', subject_id: 'gcse-biology', day: `2026-10-${String(10 + i).padStart(2, '0')}`, how: 'typed', label: `SECRET-RESULT-LABEL ${i}`, rows });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  for (let i = 0; i < 3; i++) assert.equal((await a.c.call('POST', '/api/p/cards', { front: `SECRET-CARD-FRONT ${i}`, back: 'back' })).status, 201);
  const due = (await a.c.call('GET', '/api/p/cards/due')).data.cards[0];
  assert.equal((await a.c.call('POST', `/api/p/cards/${due.id}/review`, { rating: 3 })).status, 200);
  assert.equal((await a.c.call('POST', '/api/p/gaps', { gap: 'SECRET-GAP-TEXT I never understood osmosis', topic: 'Enzymes' })).status, 201);
  d.run("INSERT INTO library_docs (user_id, id, title, status, created_at, updated_at) VALUES (?, 'doc1', 'SECRET-NOTE-TITLE', 'ready', ?, ?)", user, NOW, NOW);
  d.run("INSERT INTO papers (user_id, id, subject_id, title, paper_json, marks_json, status, created_at, updated_at) VALUES (?, 'p1', 'gcse-biology', 'A paper', '{}', ?, 'marked', ?, ?)", user, JSON.stringify({ attempt: { answers: { 1: { answer: 'SECRET-PAPER-ANSWER' } } } }), NOW, NOW);
}

test('sharing is off by default and only a true or false switches it', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Adam', { profile: 'gcse' });
  const first = await call(env, a.id, 'GET');
  assert.equal(first.status, 200);
  assert.equal(first.data.share, false);
  assert.ok(first.data.shows.length >= 4 && /never shared/.test(first.data.never));
  assert.equal(await isSharing(env, a.id), false);
  for (const bad of [{}, { share: 'yes' }, { share: 1 }, { share: null }]) assert.equal((await call(env, a.id, 'PUT', bad)).status, 400, JSON.stringify(bad));
  assert.equal(await isSharing(env, a.id), false);
  const on = await call(env, a.id, 'PUT', { share: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.share, true);
  assert.equal((await call(env, a.id, 'GET')).data.share, true);
  assert.equal(await isSharing(env, a.id), true);
  const ev = d.rows("SELECT kind, summary FROM map_events WHERE user_id = ? AND kind = 'pref.changed'", a.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /switched on/);
  assert.equal((await call(env, a.id, 'PUT', { share: true })).status, 200);
  assert.equal(d.rows("SELECT 1 FROM map_events WHERE user_id = ? AND kind = 'pref.changed'", a.id).length, 1, 'no change, no event');
  assert.equal((await call(env, a.id, 'PUT', { share: false })).data.share, false);
  assert.equal(await isSharing(env, a.id), false);
  // The other settings in prefs_json are left alone.
  assert.equal((await a.c.call('PATCH', '/api/p/me', { modules: { papers: true } })).status, 200);
  await call(env, a.id, 'PUT', { share: true });
  assert.equal(JSON.parse(d.row('SELECT prefs_json FROM users WHERE id = ?', a.id).prefs_json).modules.papers, true);
  d.close();
});

test('the summary holds rings, the weakest five, cards due, the last five scores and the streak, and nothing private', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Adam', { profile: 'gcse' });
  await seed(d, env, a);
  const sum = await sharedSummary(env, a.id);
  assert.deepEqual(Object.keys(sum).sort(), ['cards_due', 'last_results', 'rings', 'streak_days', 'weakest']);
  const ring = name => sum.rings.find(r => r.subject === name);
  assert.ok(ring('Biology') && ring('Chemistry'), 'a ring for each subject');
  assert.ok(ring('Biology').ring > 0 && ring('Biology').ring <= 1);
  assert.equal(ring('Chemistry').ring, 0);
  assert.equal(ring('Biology').topics, 3);
  assert.deepEqual(Object.keys(ring('Biology')).sort(), ['ring', 'seen', 'subject', 'topics', 'weak']);
  assert.ok(sum.weakest.length >= 1 && sum.weakest.length <= 5);
  assert.deepEqual(Object.keys(sum.weakest[0]).sort(), ['band', 'subject', 'topic']);
  assert.equal(sum.weakest[0].topic, 'Enzymes', 'the weakest topic comes first');
  assert.equal(sum.cards_due, 2, 'three cards, one reviewed');
  assert.equal(sum.streak_days, 1);
  assert.equal(sum.last_results.length, 5);
  assert.deepEqual(Object.keys(sum.last_results[0]).sort(), ['day', 'marks', 'out_of', 'percent', 'right_n', 'source', 'subject', 'total_n']);
  assert.equal(sum.last_results[0].day, '2026-10-16', 'newest first');
  assert.deepEqual([sum.last_results[0].subject, sum.last_results[0].source, sum.last_results[0].marks, sum.last_results[0].out_of, sum.last_results[0].percent], ['Biology', 'Past paper', 5, 13, 38]);
  const text = JSON.stringify(sum);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} must not be shared`);
  assert.ok(!/osmosis|gap|library|answer|front|label/i.test(text), 'no private field names or words');
  assert.ok(!/"id"|user_id/.test(text), 'no ids');
  d.close();
});

test('the page shows the person exactly what would be shared, and the summary only when switched on via sharedSummaryIfOn', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Adam', { profile: 'gcse' });
  await seed(d, env, a);
  const got = await call(env, a.id, 'GET');
  assert.deepEqual(got.data.preview, await sharedSummary(env, a.id));
  for (const secret of SECRETS) assert.ok(!JSON.stringify(got.data).includes(secret));
  assert.equal(await sharedSummaryIfOn(env, a.id), null, 'off: nothing for Mo');
  await call(env, a.id, 'PUT', { share: true });
  assert.deepEqual(await sharedSummaryIfOn(env, a.id), await sharedSummary(env, a.id));
  await call(env, a.id, 'PUT', { share: false });
  assert.equal(await sharedSummaryIfOn(env, a.id), null, 'switching off takes effect at once');
  d.close();
});

test('an empty account has an empty summary, not an error', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Adam', { profile: 'gcse' });
  const sum = await sharedSummary(env, a.id);
  assert.deepEqual([sum.weakest, sum.last_results, sum.cards_due, sum.streak_days], [[], [], 0, 0]);
  assert.ok(Array.isArray(sum.rings));
  d.close();
});

test('ISOLATION: one person switching on shares nothing of the other, and each summary is only their own', async () => {
  const { d, env } = platformEnv();
  const a = await signedIn(env, 'Adam', { profile: 'gcse' });
  const b = await signedIn(env, 'Beth', { profile: 'gcse' });
  await seed(d, env, a);
  await call(env, a.id, 'PUT', { share: true });
  assert.equal((await call(env, b.id, 'GET')).data.share, false);
  assert.equal(await isSharing(env, b.id), false);
  assert.equal(await sharedSummaryIfOn(env, b.id), null);
  const forB = await sharedSummary(env, b.id);
  assert.deepEqual([forB.weakest, forB.last_results, forB.cards_due, forB.streak_days], [[], [], 0, 0]);
  assert.ok(!JSON.stringify(forB).match(/Biology|Enzymes|Past paper/), "none of Adam's data in Beth's summary");
  assert.ok(forB.rings.every(r => r.ring === 0 && !/Biology|Chemistry/.test(r.subject)), "only Beth's own starter subjects, all empty");
  // Beth switching on or off never touches Adam.
  await call(env, b.id, 'PUT', { share: true });
  await call(env, b.id, 'PUT', { share: false });
  assert.equal(await isSharing(env, a.id), true);
  assert.ok((await sharedSummary(env, a.id)).last_results.length > 0);
  d.close();
});
