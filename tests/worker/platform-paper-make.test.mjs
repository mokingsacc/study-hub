// paper_make (Study Hub v2, WP1): with only a Claude subscription, their Claude writes a practice paper into the hub.
// Checked strictly, sums recomputed by code, listed under Exams as practice, marked onto their own map; never anyone else's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};
const Q = (over = {}) => ({ text: 'Calculate the moles in 4.0 g of NaOH (Mr 40).', marks: 2, scheme: ['4.0 / 40', '= 0.10 mol'], check: { expr: '4/40', answer: 0.1 }, ...over });

async function setup() {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-chemistry/topics', { sections: [{ name: 'Physical chemistry', topics: [{ name: 'Amount of substance' }, { name: 'Kinetics' }] }] });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const blink = new URL((await sam.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  return { d, env, alex, sam, link, blink };
}

test('paper_make: saved with no key, no cost, ready to sit; sums checked; topics matched; listed as practice', async () => {
  const s = await setup();
  const r = await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', title: 'Moles warm-up', minutes: 20, questions: [
    Q({ topic: 'Amount of substance' }), Q({ text: 'Calculate 2.5 x 4.', check: { expr: '2.5*4', answer: 11 } }), Q({ text: 'Explain why rate rises with temperature.', marks: 3, scheme: ['more energy', 'more collisions exceed Ea', 'more frequent successful collisions'], check: undefined, topic: 'Kinetics' })] });
  assert.ok(!r.isError, JSON.stringify(r));
  const p = r.structuredContent;
  assert.deepEqual([p.questions, p.out_of, p.doubtful, p.on_topics], [3, 7, [2], 2]);
  assert.match(p.open, /#papers\//);
  const row = s.d.rows('SELECT provider, usd, status FROM papers WHERE id = ?', p.paper_id)[0];
  assert.deepEqual(row, { provider: 'claude_subscription', usd: 0, status: 'ready' });
  const got = (await s.alex.c.call('GET', `/api/p/papers/${p.paper_id}`)).data.paper;
  assert.equal(got.minutes, 20);
  assert.equal(got.questions[1].doubtful, true);
  assert.equal(got.scheme, undefined, 'the mark scheme stays hidden until marking');
  const ex = (await s.alex.c.call('GET', '/api/p/exams')).data.papers.find(x => x.id === p.paper_id);
  assert.deepEqual([ex.kind, ex.made_by], ['practice', 'claude']);
  // Marked by their Claude onto their map.
  await rpc(s.env, s.link, 'paper_mark', { paper_id: p.paper_id, answers: [{ n: 1, answer: '0.1 mol', confidence: 'sure' }] });
  await rpc(s.env, s.link, 'paper_get', { paper_id: p.paper_id, show_mark_scheme: true });
  const fin = await rpc(s.env, s.link, 'paper_mark', { paper_id: p.paper_id, marks: [{ n: 1, points: [1, 2] }], finish: true });
  assert.equal(fin.structuredContent.on_map, true);
  assert.ok(s.d.rows("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ?", s.alex.id)[0].n >= 1);
  assert.equal(s.d.rows("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ?", s.sam.id)[0].n, 0);
  s.d.close();
});

test('paper_make refuses a bad paper in plain words and drops nothing quietly; replace only before it is started; isolation', async () => {
  const s = await setup();
  for (const [qs, re] of [
    [[Q(), Q()], /3 to 20 questions/],
    [Array.from({ length: 21 }, () => Q()), /3 to 20 questions/],
    [[Q(), Q(), Q({ marks: 13 })], /Question 3 needs its marks/],
    [[Q(), Q({ scheme: [] }), Q()], /Question 2 needs a mark scheme/],
    [[Q({ text: 'x'.repeat(1001) }), Q(), Q()], /Question 1 is too long/],
  ]) {
    const r = await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', questions: qs });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.structuredContent), re);
  }
  assert.equal((await rpc(s.env, s.link, 'paper_make', { subject: 'Latin', questions: [Q(), Q(), Q()] })).isError, true);
  const made = (await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', questions: [Q(), Q(), Q()] })).structuredContent;
  const again = await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', title: 'Fixed', replace: made.paper_id, questions: [Q(), Q(), Q(), Q()] });
  assert.equal(again.structuredContent.paper_id, made.paper_id);
  assert.equal(again.structuredContent.questions, 4);
  await s.alex.c.call('PUT', `/api/p/papers/${made.paper_id}/answers`, { answers: [{ n: 1, answer: 'x' }] });
  assert.equal((await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', replace: made.paper_id, questions: [Q(), Q(), Q()] })).isError, true, 'started: not replaced');
  assert.equal((await rpc(s.env, s.blink, 'paper_make', { subject: 'Maths', replace: made.paper_id, questions: [Q(), Q(), Q()] })).isError, true, "Sam cannot replace Alex's paper");
  assert.equal((await s.sam.c.call('GET', `/api/p/papers/${made.paper_id}`)).status, 404);
  // With exams and papers off, the tool is hidden and refused.
  await s.alex.c.call('PATCH', '/api/p/me', { modules: { exams: false } });
  assert.equal((await rpc(s.env, s.link, 'paper_make', { subject: 'Chemistry', questions: [Q(), Q(), Q()] })).isError, true);
  s.d.close();
});
