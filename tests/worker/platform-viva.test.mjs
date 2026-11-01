import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { marksOf, vivaBrief, HEADINGS } from '../../worker/src/platform/viva.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

async function connector(env, c) {
  const made = await c.call('POST', '/api/p/connector', { label: 'phone' });
  const path = new URL(made.data.url).pathname;
  let n = 0;
  return { call: async (name, args = {}) => {
    const r = (await (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} })).json()).result;
    return { error: !!r.isError, data: r.structuredContent, text: r.content[0].text };
  } };
}

async function student(env, name) {
  const p = await signedIn(env, name, { profile: 'gcse' });
  const sid = (await p.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Cells', topics: [{ name: 'Osmosis' }, { name: 'Diffusion' }] }] });
  const detail = (await p.c.call('GET', `/api/p/subjects/${sid}`)).data;
  const ids = Object.fromEntries(detail.sections.flatMap(s => s.topics).map(t => [t.name, t.id]));
  return { ...p, sid, ids, mcp: await connector(env, p.c) };
}

const POINTS = [
  { text: 'Osmosis is the movement of water across a partially permeable membrane', heading: 'understand', status: 'said', quote: 'water moves across a membrane', key: true },
  { text: 'Water moves from a dilute solution to a more concentrated one', heading: 'recognise', status: 'wrong', quote: 'from concentrated to dilute' },
  { text: 'Required practical: potato cylinders in sugar solutions, percentage change in mass', heading: 'test', status: 'missing', key: true },
  { text: 'Unlike diffusion, only water moves', heading: 'distinguish', status: 'missing' },
  { text: 'Plot percentage change in mass against concentration; where it crosses zero is the cell concentration', heading: 'treat', status: 'said', quote: 'where the line crosses zero' },
  { text: 'Say water potential or concentration of solute, not "concentration of water"', heading: 'trap', status: 'missing' },
];

test('marksOf: their points become Mo\'s rubric and grade data; bad input is refused in plain words', () => {
  const { rubric, data } = marksOf(POINTS, [{ belief: 'Water moves from concentrated to dilute', quote: 'from concentrated to dilute' }]);
  assert.deepEqual(rubric.map(p => [p.id, p.step, p.yield]), [['p1', 'understand', 'high'], ['p2', 'recognise', 'normal'], ['p3', 'test', 'high'], ['p4', 'distinguish', 'normal'], ['p5', 'treat', 'normal'], ['p6', 'trap', 'normal']]);
  assert.deepEqual(data.points.map(p => p.status), ['said', 'wrong', 'missing', 'missing', 'said', 'missing']);
  assert.equal(data.points[2].quote, null, 'a missing point has no quote');
  assert.equal(data.misconceptions.length, 1);
  assert.throws(() => marksOf(POINTS.slice(0, 2)), /4 to 15 key points/);
  assert.throws(() => marksOf([...POINTS.slice(0, 3), { text: 'x', heading: 'nonsense', status: 'said' }]), /heading is one of/);
  assert.throws(() => marksOf([...POINTS.slice(0, 3), { text: 'x', heading: 'trap', status: 'maybe' }]), /said, wrong or missing/);
  assert.equal(Object.keys(HEADINGS).length, 6);
  assert.match(vivaBrief({ name: 'Osmosis' }).prompt, /^Osmosis: tell me everything you know/);
});

test('viva_mark: scored with Mo\'s rules, written to their map, the plan of headings back; the topic page reads it', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Ana');
  const r = await a.mcp.call('viva_mark', { topic: 'Osmosis', words: 'Osmosis is when water moves across a membrane, from concentrated to dilute. You plot it and see where the line crosses zero.', points: POINTS,
    beliefs: [{ belief: 'Water moves from concentrated to dilute', quote: 'from concentrated to dilute' }] });
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.said, 2);
  assert.equal(r.data.wrong, 1);
  assert.equal(r.data.of, 6);
  assert.ok(r.data.coverage > 0 && r.data.coverage < 0.5);
  assert.ok(r.data.plan.includes('Exam use') && !r.data.plan.includes('Big idea'), JSON.stringify(r.data.plan));
  // Written to their map: graded row, recall_audit evidence on the topic, and the wrong belief opened.
  const v = d.db.prepare("SELECT status, kind, coverage FROM viva_results WHERE user_id = ?").get(a.id);
  assert.deepEqual({ ...v, coverage: v.coverage > 0 }, { status: 'graded', kind: 'audit', coverage: true });
  assert.ok(d.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND topic_id = ? AND kind = 'recall_audit'").get(a.id, a.ids.Osmosis).n >= 1);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM misconceptions WHERE user_id = ? AND status = 'open'").get(a.id).n, 1);
  const page = await a.c.call('GET', `/api/p/topics/${encodeURIComponent(a.ids.Osmosis)}/viva`);
  assert.equal(page.status, 200);
  assert.equal(page.data.last.said, 2);
  assert.ok(page.data.last.missed.some(m => /potato/.test(m)));
  // Somebody else's topic is not theirs.
  const b = await student(env, 'Ben');
  assert.equal((await b.c.call('GET', `/api/p/topics/${encodeURIComponent(a.ids.Osmosis)}/viva`)).status, 404);
  const other = await b.mcp.call('viva_mark', { topic: a.ids.Osmosis, words: 'x', points: POINTS });
  assert.equal(other.error, true);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM viva_results WHERE user_id = ?").get(b.id).n, 0);
  d.close();
});

test('a lesson opens with the viva: teach_next carries it, viva_mark before and after land on the lesson', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Cara');
  const brief = (await a.mcp.call('teach_next', { topic: 'Diffusion' })).data;
  assert.ok(brief.lesson_id, JSON.stringify(brief).slice(0, 300));
  assert.match(brief.viva.prompt, /^Diffusion: tell me everything you know/);
  assert.match(brief.method.text, /Viva first/);
  const before = await a.mcp.call('viva_mark', { topic: 'Diffusion', phase: 'before', lesson_id: brief.lesson_id, words: 'Particles spread out.', points: POINTS.map((p, i) => ({ ...p, status: i ? 'missing' : 'said', quote: i ? undefined : 'Particles spread out' })) });
  assert.equal(before.error, false, before.text);
  const after = await a.mcp.call('viva_mark', { topic: 'Diffusion', phase: 'after', lesson_id: brief.lesson_id, words: 'Particles spread from high to low concentration...', points: POINTS.map(p => ({ ...p, status: 'said', quote: 'high to low' })) });
  assert.equal(after.error, false, after.text);
  const l = d.db.prepare('SELECT viva_before, viva_after FROM lessons WHERE user_id = ? AND id = ?').get(a.id, brief.lesson_id);
  assert.ok(l.viva_before < l.viva_after && l.viva_after === 1, JSON.stringify(l));
  // The next brief on the topic carries the last viva.
  const peek = (await a.mcp.call('teach_next', { topic: 'Diffusion', peek: true })).data;
  assert.ok(!peek.viva, 'a peek starts no viva');
  d.close();
});
