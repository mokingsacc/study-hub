import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { londonDay } from '../../worker/src/util.js';
import { PROFILES } from '../../worker/src/profiles.js';
import { writeBatch } from '../../worker/src/map/events.js';
import { phaseOf, phaseFor, daysLeft, PHASES } from '../../worker/src/map/teach-priority.js';
import { topReason, contrastReason } from '../../worker/src/map/morning.js';
import { SCHOOL_METHOD_TEXT, markFinal, toMoSave, forStudent, TOOLS, ROUTES, schoolBrief, schoolLibrary, SCHOOL_LIBRARY_USE } from '../../worker/src/platform/teach.js';
import { spreadAcrossBooks, BRIEF_USE } from '../../worker/src/library/search.js';
import { platformRoutes } from '../../worker/src/platform/routes.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const DAY = 86_400_000;

async function connector(env, c) {
  const made = await c.call('POST', '/api/p/connector', { label: 'phone' });
  assert.equal(made.status, 201);
  const path = new URL(made.data.url).pathname;
  let n = 0;
  const rpc = async (method, params) => (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) }), env, { waitUntil() {} })).json();
  return {
    status: async () => (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env, { waitUntil() {} })).status,
    list: async () => (await rpc('tools/list')).result.tools,
    call: async (name, args = {}) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { error: !!r.isError, data: r.structuredContent, text: r.content[0].text }; },
  };
}

// A student with maths topics and a connector. Returns {c, id, mcp, sid, topics: {name: id}}.
async function student(env, name, profile = 'gcse', topics = ['Pythagoras theorem', 'Circle theorems', 'Vectors']) {
  const p = await signedIn(env, name, { profile });
  const subs = (await p.c.call('GET', '/api/p/subjects')).data.subjects;
  const sid = subs[0].id;
  const add = await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Geometry', topics: topics.map(t => ({ name: t })) }] });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const detail = (await p.c.call('GET', `/api/p/subjects/${sid}`)).data;
  const ids = Object.fromEntries(detail.sections.flatMap(s => s.topics).map(t => [t.name, t.id]));
  return { ...p, sid, topics: ids, mcp: await connector(env, p.c) };
}

// Wrong answers on a topic (through the map engine, as results do), so it is seen and weak.
async function misses(env, user, topicId, subjectId, n = 3) {
  await writeBatch(env, user, { actor: 'code', surface: 'code', via: 'test', events: [], evidence: { upsert: Array.from({ length: n }, (_, i) => ({
    obs_key: `test:${topicId}:${i}`, kind: 'question', at: Date.now() - i * 1000, day: londonDay(), source: 'past_paper', topic_id: topicId, category_id: subjectId,
    result: 'wrong', detail_json: JSON.stringify({ label: `Paper 1 Q${i + 1}` }) })) } });
}

const FINAL = {
  command_word: 'calculate', marks: 4, confidence: 'think_so',
  points: [{ point: 'squares the two shorter sides', got: true }, { point: 'adds the squares', got: true }, { point: 'square roots the total', got: true },
    { point: 'gives the answer with units', got: false, lost_reason: 'calculation' }],
};
const SAVE = lessonId => ({
  lesson_id: lessonId, final_question: FINAL,
  teach_back: { judgement: 'complete', text: 'The square on the longest side equals the two smaller squares added together.' },
  rating: 7, rating_why: 'I can do it now', what_clicked: 'The picture of squares on each side', tactics_used: ['picture'], content_type: 'method',
  card: { action: 'added', front: 'Pythagoras: how do you find the longest side?', back: 'Square the two short sides, add them, then square root.' },
  summary: 'Pythagoras with a picture of the squares.',
});
const MO_WORDS = /\bMo\b|Mehlman|USMLE|Step 2|AnKing|\bAnki\b|anking_hint|NBME|UWorld|Lane [ABC]/;

// ------------------------------------------------------------------ teach_next and lesson_save

test('connector: teach_next and lesson_save are listed for the student, in school shapes (no Step 2 fields)', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const tools = await a.mcp.list();
  const next = tools.find(t => t.name === 'teach_next'), save = tools.find(t => t.name === 'lesson_save');
  assert.ok(next && save);
  assert.ok(save.inputSchema.properties.final_question && save.inputSchema.properties.rating && save.inputSchema.properties.card);
  for (const k of ['final_case', 'mo_rating', 'five_step', 'items', 'new_topic', 'media_shown']) assert.ok(!(k in save.inputSchema.properties), k);
  assert.ok(!('from_miss' in next.inputSchema.properties) && !('pair' in next.inputSchema.properties));
  assert.doesNotMatch(JSON.stringify([next, save]), /\bMo\b|Mehlman|USMLE|Step 2/);
  d.close();
});

test('teach_next -> lesson_save round trip: the school brief, the final marked point by point, the card on their yes, "What you know"', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const pyth = a.topics['Pythagoras theorem'];
  const r = await a.mcp.call('teach_next', { topic: 'pythagoras theorem' });
  assert.equal(r.error, false, r.text);
  const b = r.data;
  assert.match(b.lesson_id, /^L\w+/);
  assert.equal(b.topic.id, pyth);
  assert.equal(b.served_by, 'named');
  assert.deepEqual([b.topic.subject.id, b.topic.subject.name, b.topic.section], [a.sid, 'Maths', 'Geometry']);
  assert.equal(b.method.style, 'school');
  assert.equal(b.final.style, 'exam_question');
  assert.ok(b.final.command_words.includes('evaluate'));
  assert.ok(['how_it_works', 'method', 'recall'].includes(b.tactics.content_type));
  assert.equal(b.card_ok, true);
  for (const k of ['mehlman', 'anking_hint', 'pictures', 'misses', 'phase', 'goal_hint']) assert.ok(!(k in b), `no ${k}`);
  assert.doesNotMatch(JSON.stringify(b), MO_WORDS);
  assert.ok(JSON.stringify(b).length <= 14_000);
  // The lesson row is the student's own.
  const row = d.db.prepare('SELECT user_id, status, topic_id FROM lessons WHERE id = ?').get(b.lesson_id);
  assert.deepEqual({ ...row }, { user_id: a.id, status: 'in_progress', topic_id: pyth });

  const s = await a.mcp.call('lesson_save', SAVE(b.lesson_id));
  assert.equal(s.error, false, s.text);
  assert.equal(s.data.saved, true);
  assert.deepEqual(s.data.final, { command_word: 'calculate', marks: 4, scored: 3, result: 'partial', confidence: 'think_so', lost: [{ point: 'gives the answer with units', reason: 'calculation' }] });
  assert.equal(s.data.outcome, 'partial', '3 of 4 is a partial final: never landed');
  assert.deepEqual(s.data.views.student, { rating: 7, why: 'I can do it now', clicked: 'The picture of squares on each side' });
  assert.equal(s.data.tactics.content_type, 'method');
  assert.equal(s.data.card.added, true);
  assert.doesNotMatch(JSON.stringify(s.data), MO_WORDS);
  const saved = d.db.prepare('SELECT status, mo_rating, what_clicked, teach_back_text, final_result, final_conf, card_id, card_action, content_type, final_explain_json FROM lessons WHERE id = ?').get(b.lesson_id);
  assert.deepEqual([saved.status, saved.mo_rating, saved.final_result, saved.final_conf, saved.card_action, saved.content_type], ['done', 7, 'partial', 'lean', 'added', 'management']);
  assert.equal(saved.card_id, s.data.card.id);
  assert.deepEqual(JSON.parse(saved.final_explain_json), { verdict: 'partial', missing: ['gives the answer with units'] });
  // The card is in their own FSRS deck, on the topic.
  const cards = await a.c.call('GET', `/api/p/cards?topic_id=${encodeURIComponent(pyth)}`);
  assert.deepEqual(cards.data.cards.map(c => c.id), [s.data.card.id]);
  // The topic is now seen on their map (lesson evidence).
  assert.ok(s.data.topic.t1000_after != null);

  const k = await a.c.call('GET', `/api/p/topics/${encodeURIComponent(pyth)}/knowledge`);
  assert.equal(k.status, 200);
  for (const key of ['topic', 'summary', 'in_his_words', 'clicked', 'misconceptions', 'cards', 'mehlman', 'lessons', 'related', 'as_of_seq']) assert.ok(key in k.data, key);
  assert.equal(k.data.summary.lessons, 1);
  assert.equal(k.data.in_his_words[0].text, SAVE().teach_back.text);
  assert.equal(k.data.clicked[0].text, 'The picture of squares on each side');
  assert.equal(k.data.lessons[0].mo_rating, 7);
  assert.deepEqual(k.data.cards.map(c => [c.card_id, c.front, c.lesson_id]), [[s.data.card.id, SAVE().card.front, b.lesson_id]]);
  assert.deepEqual(k.data.lost_marks[0].points, ['gives the answer with units']);
  assert.equal(k.data.topic.subject.name, 'Maths');
  assert.equal(k.data.topic.lane, null);
  // topic_detail carries the summary.
  const td = await a.mcp.call('topic_detail', { topic: pyth });
  assert.equal(td.data.knowledge.lessons, 1);
  assert.ok(td.data.knowledge.his_words.length && td.data.knowledge.lost_marks.length);
  // The next teach_next sees the lesson: past_lessons with their rating, the card for dedupe, the lost marks. A peek writes nothing.
  const n = d.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?').get(a.id).n;
  const again = (await a.mcp.call('teach_next', { topic: pyth, peek: true })).data;
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?').get(a.id).n, n);
  assert.equal(again.lesson_id, null);
  assert.equal(again.past_lessons[0].rating, 7);
  assert.ok(!('mo_rating' in again.past_lessons[0]));
  assert.equal(again.cards[0].id, s.data.card.id);
  assert.deepEqual(again.lost_marks[0].points, ['gives the answer with units']);
  const u = await a.c.call('POST', '/api/p/undo', { batch_id: s.data.undo.batch_id });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.deepEqual({ ...d.db.prepare('SELECT status, abandon_reason FROM lessons WHERE id = ?').get(b.lesson_id) }, { status: 'abandoned', abandon_reason: 'undone' });
  assert.equal((await a.c.call('GET', `/api/p/topics/${encodeURIComponent(pyth)}/knowledge`)).data.summary.lessons, 0);
  d.close();
});

test('lesson_save: full marks lands; "done" before the final is stopped early; school argument checks', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const l1 = (await a.mcp.call('teach_next', { topic: 'Circle theorems' })).data.lesson_id;
  const full = { ...FINAL, confidence: 'sure', points: FINAL.points.map(p => ({ point: p.point, got: true })) };
  const s1 = await a.mcp.call('lesson_save', { lesson_id: l1, final_question: full, teach_back: { judgement: 'complete' }, rating: 9, what_clicked: 'Drawing it', card: { action: 'declined' } });
  assert.equal(s1.data.outcome, 'landed', s1.text);
  assert.equal(s1.data.final.result, 'right');
  const l2 = (await a.mcp.call('teach_next', { topic: 'Vectors' })).data.lesson_id;
  const s2 = await a.mcp.call('lesson_save', { lesson_id: l2, status: 'done', steps: [{ title: 'What a vector is', check: 'right' }] });
  assert.equal(s2.data.stopped_early, true);
  const bad = [
    [{ lesson_id: l2, mo_rating: 5 }, /Use rating/],
    [{ lesson_id: l2, final_case: { result: 'right' } }, /Use final_question/],
    [{ lesson_id: l2, outcome: 'landed' }, /works it out/],
    [{ lesson_id: l2, five_step: ['treat'] }, /Unknown argument five_step/],
    [{ lesson_id: l2, final_question: { marks: 2, points: [{ point: 'x', got: false, lost_reason: 'bad' }] } }, /lost_reason/],
    [{ lesson_id: l2, final_question: { marks: 0, points: [] } }, /marks/],
    [{ lesson_id: l2, content_type: 'physiology' }, /content_type/],
    [{ lesson_id: 'Lnope' }, /No lesson has that id/],
    [{ lesson_id: l2, card: { action: 'added' } }, /front and back/],
  ];
  for (const [args, re] of bad) {
    const r = await a.mcp.call('lesson_save', args);
    assert.equal(r.error, true, JSON.stringify(args));
    assert.match(r.data.reason, re);
  }
  d.close();
});

test('cards: misreads get no card; with flashcards switched off the card comes back as a suggestion; an existing card id must be theirs', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const misread = { ...FINAL, points: [...FINAL.points.slice(0, 3), { point: 'gives the answer with units', got: false, lost_reason: 'misread' }] };
  const l1 = (await a.mcp.call('teach_next', { topic: 'Circle theorems' })).data.lesson_id;
  const s1 = await a.mcp.call('lesson_save', { ...SAVE(l1), final_question: misread });
  assert.equal(s1.data.saved, true);
  assert.equal(s1.data.card.added, false);
  assert.match(s1.data.card.reason, /misread/);
  assert.equal((await a.c.call('GET', '/api/p/cards')).data.cards.length, 0);
  // An existing card id: theirs only.
  const mine = await a.c.call('POST', '/api/p/cards', { front: 'Vectors: what is a column vector?', back: 'Movement across over up.', topic_id: a.topics.Vectors });
  const l2 = (await a.mcp.call('teach_next', { topic: 'Vectors' })).data.lesson_id;
  assert.equal((await a.mcp.call('lesson_save', { lesson_id: l2, final_question: FINAL, card: { action: 'added', card_id: 999999 } })).error, true);
  const ok = await a.mcp.call('lesson_save', { lesson_id: l2, final_question: FINAL, card: { action: 'added', card_id: mine.data.card.id } });
  assert.equal(ok.data.card.id, mine.data.card.id);
  // Flashcards off: nothing is made; the card is handed back.
  assert.equal((await a.c.call('PATCH', '/api/p/me', { modules: { cards: false } })).status, 200);
  const l3 = (await a.mcp.call('teach_next', { topic: 'Pythagoras theorem' })).data;
  assert.equal(l3.card_ok, false);
  const s3 = await a.mcp.call('lesson_save', SAVE(l3.lesson_id));
  assert.equal(s3.data.card.added, false);
  assert.deepEqual(s3.data.card.card_suggestion.front, SAVE().card.front);
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE user_id = ?').get(a.id).n, 1);
  d.close();
});

test('teach_next: a name that is not theirs writes nothing and offers their nearest topics; skip notes a pass', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const before = d.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
  const r = await a.mcp.call('teach_next', { topic: 'theorems about circles' });
  assert.equal(r.data.not_found, true);
  assert.equal(r.data.lesson_id, null);
  assert.equal(r.data.choices[0].name, 'Circle theorems');
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, before);
  const sk = await a.mcp.call('teach_next', { skip: [a.topics.Vectors] });
  assert.equal(sk.error, false, sk.text);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM teach_skips WHERE user_id = ? AND topic_id = ?').get(a.id, a.topics.Vectors).n, 1);
  d.close();
});

// ------------------------------------------------------------------ the morning choice

test('morning choice: two options with plain reasons, avoidance said honestly, choose makes the requested lesson teach_next serves; refresh', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam', 'gcse', ['Pythagoras theorem', 'Circle theorems', 'Vectors', 'Probability']);
  await misses(env, a.id, a.topics['Pythagoras theorem'], a.sid, 3);
  // Probability was offered on three earlier days and passed over each time.
  const now = Date.now();
  for (const k of [3, 5, 9]) {
    d.db.prepare(`INSERT INTO teach_offers (user_id, day, slot, topic_id, topic_name, category_id, pick, reason, why_json, state, offered_at, created_by, created_at, updated_at)
      VALUES (?, ?, 'b', ?, 'Probability', ?, 'contrast', 'never seen', '{}', 'declined', ?, 'code', ?, ?)`).run(a.id, londonDay(now - k * DAY), a.topics.Probability, a.sid, now - k * DAY, now - k * DAY, now - k * DAY);
  }
  const c = await a.c.call('GET', '/api/p/today/choice');
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.state, 'open');
  assert.equal(c.data.options.length, 2);
  const [top, other] = c.data.options;
  assert.equal(top.topic.id, a.topics['Pythagoras theorem'], 'the weakest seen topic is the top pick');
  assert.equal(other.topic.id, a.topics.Probability, 'the avoided topic is the contrast');
  assert.equal(other.avoidance.line, "You've passed on Probability three times.");
  assert.deepEqual(other.avoidance.rules, [{ rule: 'passed', n: 3 }]);
  // Three wrong answers and no lesson yet is avoidance too, said plainly; the page shows the first line.
  assert.equal(top.avoidance.line, '3 misses on Pythagoras theorem in 30 days, and no lesson on it yet.');
  assert.equal(c.data.line, top.avoidance.line);
  for (const o of c.data.options) {
    assert.doesNotMatch(o.reason, /Lane|yield|Mehlman|Off list/);
    assert.equal(o.topic.subject_name, 'Maths');
    assert.equal(o.prompt, `Teach me ${o.topic.name} (map: ${o.topic.id})`);
    assert.equal(o.claude_url, `https://claude.ai/new?q=${encodeURIComponent(o.prompt)}`);
  }
  assert.match(top.reason, /weakness \d+/);
  // Today carries the same choice, read inside its own batch (no extra round trips once the day's offer exists).
  d.stats.reset();
  const t = await a.c.call('GET', '/api/p/today');
  assert.ok(d.stats.queries <= 6, `Today used ${d.stats.queries} queries`);
  assert.deepEqual(t.data.choice.options.map(o => o.topic.id), c.data.options.map(o => o.topic.id));
  assert.deepEqual(t.data.choice.options.map(o => [o.reason, o.topic.subject_name, o.claude_url, o.avoidance && o.avoidance.line]),
    c.data.options.map(o => [o.reason, o.topic.subject_name, o.claude_url, o.avoidance && o.avoidance.line]));
  assert.equal(t.data.choice.line, c.data.line);
  // A plain "teach me" while it is open answers with both.
  const offer = (await a.mcp.call('teach_next', {})).data;
  assert.equal(offer.lesson_id, null);
  assert.deepEqual(offer.offer.options.map(o => o.topic.id), c.data.options.map(o => o.topic.id));
  assert.doesNotMatch(JSON.stringify(offer), MO_WORDS);
  // Choose the avoided one: a requested lesson, served first by teach_next.
  const ch = await a.c.call('POST', '/api/p/today/choice/choose', { topic_id: a.topics.Probability });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.match(ch.data.prompt, /^Teach me Probability \(map: /);
  assert.equal(ch.data.claude_url, `https://claude.ai/new?q=${encodeURIComponent(ch.data.prompt)}`);
  assert.equal(ch.data.today.state, 'chosen');
  assert.deepEqual(ch.data.today.options.map(o => o.state).sort(), ['chosen', 'declined']);
  const served = (await a.mcp.call('teach_next', {})).data;
  assert.equal(served.topic.id, a.topics.Probability);
  assert.equal(served.served_by, 'request');
  assert.equal(served.lesson_id, ch.data.lesson_id);
  assert.equal((await a.c.call('POST', '/api/p/today/choice/choose', { topic_id: a.topics.Vectors })).status, 404, 'not one of today\'s two');
  {
    const b = await student(env, 'Bea', 'gcse', ['Pythagoras theorem', 'Circle theorems', 'Vectors', 'Probability']);
    const first = (await b.c.call('GET', '/api/p/today/choice')).data.options.map(o => o.topic.id);
    const again = (await b.c.call('POST', '/api/p/today/choice/refresh')).data;
    assert.ok(again.options.length >= 1);
    assert.ok(again.options.every(o => !first.includes(o.topic.id)), 'two different topics');
  }
  d.close();
});

test('Teach me tap: a requested lesson and the claude.ai link with the prompt; a second tap reuses it', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const r = await a.c.call('POST', '/api/p/teach/request', { topic_id: a.topics.Vectors, device: 'phone' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.prompt, `Teach me Vectors (map: ${a.topics.Vectors})`);
  assert.equal(r.data.claude_url, `https://claude.ai/new?q=${encodeURIComponent(r.data.prompt)}`);
  assert.match(r.data.claude_app_url, /^claude:\/\/claude\.ai\/new\?q=/);
  assert.equal((await a.c.call('POST', '/api/p/teach/request', { topic_id: a.topics.Vectors })).data.lesson_id, r.data.lesson_id);
  const served = (await a.mcp.call('teach_next', { topic: r.data.prompt })).data;
  assert.equal(served.lesson_id, r.data.lesson_id, 'the tap becomes the lesson');
  assert.equal((await a.c.call('POST', '/api/p/teach/request', { topic_id: 'nope' })).status, 404);
  d.close();
});

test('module gates: with their Claude switched off there is no choice, no tap and no connector; "What you know" stays', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  assert.equal((await a.c.call('PATCH', '/api/p/me', { modules: { connector: false } })).status, 200);
  for (const [m, p, body] of [['GET', '/api/p/today/choice'], ['POST', '/api/p/today/choice/choose', { topic_id: a.topics.Vectors }], ['POST', '/api/p/today/choice/refresh', {}],
    ['POST', '/api/p/teach/request', { topic_id: a.topics.Vectors }]]) {
    const r = await a.c.call(m, p, body);
    assert.equal(r.status, 404, p);
    assert.match(r.data.error, /switched off/);
  }
  assert.equal((await a.c.call('GET', '/api/p/today')).data.choice, null);
  assert.equal(await a.mcp.status(), 404, 'the connector itself is gone');
  assert.equal((await a.c.call('GET', `/api/p/topics/${encodeURIComponent(a.topics.Vectors)}/knowledge`)).status, 200);
  d.close();
});

// ------------------------------------------------------------------ isolation

test('isolation: B never reads or saves A\'s lessons, offers or knowledge; Mo\'s rows never appear', async () => {
  const { d, env } = platformEnv();
  const a = await student(env, 'Adam');
  const b = await student(env, 'Sara', 'alevel', ['Osmosis', 'Pythagoras theorem']);
  const now = Date.now(), today = londonDay(now);
  d.db.prepare(`INSERT INTO topics (user_id, id, name, kind, status, category_id, source, created_by, created_at, updated_at)
    VALUES ('mo', 'mo-ascites', 'Ascites', 'condition', 'confirmed', 'gi', 'seed', 'seed', ?, ?)`).run(now, now);
  d.db.prepare(`INSERT INTO lessons (id, user_id, topic_id, topic_name, kind, status, started_at, day, created_at, updated_at)
    VALUES ('Lmo1', 'mo', 'mo-ascites', 'Ascites', 'lesson', 'in_progress', ?, ?, ?, ?)`).run(now, today, now, now);
  d.db.prepare(`INSERT INTO teach_offers (user_id, day, slot, topic_id, topic_name, category_id, pick, reason, why_json, state, offered_at, created_by, created_at, updated_at)
    VALUES ('mo', ?, 'a', 'mo-ascites', 'Ascites', 'gi', 'top', 'Lane A', '{}', 'open', ?, 'code', ?, ?)`).run(today, now, now, now);

  const lessonA = (await a.mcp.call('teach_next', { topic: 'Pythagoras theorem' })).data;
  assert.equal(lessonA.topic.id, a.topics['Pythagoras theorem']);
  await a.mcp.call('lesson_save', SAVE(lessonA.lesson_id));
  const choiceA = (await a.c.call('GET', '/api/p/today/choice')).data;

  // B's own topic of the same name, never A's.
  const sameName = (await b.mcp.call('teach_next', { topic: 'Pythagoras theorem', peek: true })).data;
  assert.equal(sameName.topic.id, b.topics['Pythagoras theorem']);
  assert.notEqual(sameName.topic.id, a.topics['Pythagoras theorem']);
  // A's topic id, lesson and offer: unknown to B.
  assert.equal((await b.mcp.call('teach_next', { topic: `Pythagoras theorem (map: ${a.topics['Pythagoras theorem']})` })).data.not_found, true);
  for (const lid of [lessonA.lesson_id, 'Lmo1']) {
    const r = await b.mcp.call('teach_next', { lesson_id: lid });
    assert.equal(r.error, true, lid);
    assert.equal(r.data.refused, true, lid);
    const s = await b.mcp.call('lesson_save', SAVE(lid));
    assert.equal(s.error, true, lid);
    assert.match(s.data.reason, /No lesson has that id/);
  }
  assert.equal(d.db.prepare('SELECT status FROM lessons WHERE id = ?').get('Lmo1').status, 'in_progress', "Mo's lesson untouched");
  for (const id of [a.topics['Pythagoras theorem'], 'mo-ascites']) {
    assert.equal((await b.c.call('GET', `/api/p/topics/${encodeURIComponent(id)}/knowledge`)).status, 404);
    assert.equal((await b.c.call('POST', '/api/p/teach/request', { topic_id: id })).status, 404);
    assert.equal((await b.c.call('POST', '/api/p/today/choice/choose', { topic_id: id })).status, 404);
    assert.equal((await b.mcp.call('topic_detail', { topic: id })).error, true);
  }
  assert.equal((await a.c.call('GET', '/api/p/topics/mo-ascites/knowledge')).status, 404);
  assert.equal((await a.mcp.call('teach_next', { topic: 'Ascites' })).data.not_found, true);
  // Choices and knowledge hold only their own rows.
  const choiceB = (await b.c.call('GET', '/api/p/today/choice')).data;
  const bIds = new Set(Object.values(b.topics));
  assert.ok(choiceB.options.length && choiceB.options.every(o => bIds.has(o.topic.id)));
  assert.ok(choiceA.options.every(o => Object.values(a.topics).includes(o.topic.id)));
  const kB = (await b.c.call('GET', `/api/p/topics/${encodeURIComponent(b.topics['Pythagoras theorem'])}/knowledge`)).data;
  assert.equal(kB.summary.lessons, 0);
  assert.deepEqual(kB.cards, []);
  assert.equal(d.db.prepare("SELECT state FROM teach_offers WHERE user_id = 'mo'").get().state, 'open');
  assert.ok(d.db.prepare('SELECT state FROM teach_offers WHERE user_id = ?').all(a.id).every(r => r.state === 'open'));
  // Every lesson row B's calls made is B's.
  assert.ok(d.db.prepare("SELECT user_id FROM lessons WHERE id <> 'Lmo1'").all().every(r => [a.id, b.id].includes(r.user_id)));
  d.close();
});


test('routes and tools: under /api/p/, module map for the tools, one owner per route', () => {
  for (const [, p] of ROUTES) assert.ok(p.startsWith('/api/p/'));
  const all = platformRoutes().map(r => `${r.method} ${r.pattern}`);
  for (const [m, p] of ROUTES) assert.equal(all.filter(x => x === `${m} ${p}`).length, 1, p);
  assert.deepEqual(TOOLS.map(t => [t.name, t.module]), [['teach_next', 'map'], ['lesson_save', 'map']]);
});

test('the school method: plain words, UK school, no Step 2 or exam-board text', () => {
  assert.doesNotMatch(SCHOOL_METHOD_TEXT, /\bMo\b|USMLE|Step 2|Mehlman|Anki|vignette|AQA|Edexcel|OCR/);
  assert.match(SCHOOL_METHOD_TEXT, /mark scheme/);
  assert.match(SCHOOL_METHOD_TEXT, /30 seconds/);
  assert.match(SCHOOL_METHOD_TEXT, /1 to 10/);
  assert.match(SCHOOL_METHOD_TEXT, /only on yes/);
  assert.ok(SCHOOL_METHOD_TEXT.length < 5000);
});

test('markFinal and toMoSave: marks to Mo\'s final case (80% is right), lost points as what was missing', () => {
  const m = markFinal(FINAL);
  assert.deepEqual(m.final_case, { result: 'partial', confidence: 'lean', explanation_judgement: { verdict: 'partial', missing: ['gives the answer with units'] } });
  const five = { marks: 5, points: [1, 2, 3, 4, 5].map(i => ({ point: `point ${i}`, got: i !== 5 })) };
  assert.equal(markFinal(five).final_case.result, 'right');
  assert.equal(markFinal({ marks: 2, points: [{ point: 'a', got: false }, { point: 'b', got: false }] }).final_case.result, 'wrong');
  assert.deepEqual(markFinal({ skipped: true }).final_case, { result: 'skipped' });
  const t = toMoSave({ lesson_id: 'L1', rating: 6, rating_why: 'ok', content_type: 'recall', final_question: FINAL, summary: 'A summary.' });
  assert.equal(t.args.mo_rating, 6);
  assert.equal(t.args.content_type, 'pattern');
  assert.match(t.args.weak_spot, /^Lost: gives the answer with units \(Calculation or unit slip\)$/);
  assert.equal(t.args.summary, 'A summary. Final question (calculate): 3/4.');
  assert.equal(forStudent('Off the checklist: you asked for it, not seen yet.'), 'You asked for it, not seen yet.');
  assert.equal(forStudent('Mo rated it 4'), 'They rated it 4');
});

test("Mo's phases are unchanged; a school profile always teaches in build, with its own exam date and no lanes", () => {
  for (const day of ['2026-10-25', '2026-11-30', '2026-12-15', '2026-12-21', '2027-01-10']) {
    const mo = phaseOf(PROFILES.step2, day);
    assert.deepEqual([mo.days_left, mo.phase, mo.laneless], [daysLeft(day), phaseFor(daysLeft(day)), false], day);
    assert.deepEqual(phaseOf(null, day).phase, phaseFor(daysLeft(day)));
    const g = phaseOf(PROFILES.gcse, day);
    assert.deepEqual([g.phase, g.laneless, g.days_left], [PHASES[0], true, null], day);
  }
  assert.equal(phaseOf({ ...PROFILES.alevel, exam_date: '2027-05-11' }, '2027-05-01').days_left, 10);
  assert.equal(phaseOf({ ...PROFILES.alevel, exam_date: '2027-05-11' }, '2027-06-01').days_left, null);
  const row = { lane: 'off', seen: 1, t: 0.8, misses_60d: 2, yield: 0.05, mehlman_rank: null };
  assert.equal(topReason(row), 'Off list · weakness 80 · 2 misses/60 d', "Mo's reason as before");
  assert.equal(topReason(row, 'pick', { lanes: false }), 'weakness 80 · 2 misses/60 d');
  assert.equal(contrastReason({ lane: 'off', never_seen: true, yield: 0.05 }, { lanes: false }), 'never seen');
});

test("Mo's Mehlman-first shortlist does no harm to a student: their own books by score, and a school use line", () => {
  const list = [{ id: 'a1', doc_id: 'A', score: 0.9 }, { id: 'a2', doc_id: 'A', score: 0.8 }, { id: 'a3', doc_id: 'A', score: 0.7 }, { id: 'b1', doc_id: 'B', score: 0.5 }];
  assert.deepEqual(spreadAcrossBooks(list, () => null).map(x => x.id), ['a1', 'b1', 'a2', 'a3']);
  const lib = { status: 'ok', n: 4, passages: [{ cite: 'Notes, p. 2', source: null, passage_id: 'a1', text: 'x' }], candidates: [{ cite: 'Book, p. 9', source: null, passage_id: 'b1', line: 'y' }],
    use: BRIEF_USE, more: 2, next_step: 'More in his library: map_topic {include: ["library"]}.' };
  const s = schoolLibrary(lib);
  assert.equal(s.use, SCHOOL_LIBRARY_USE);
  assert.deepEqual(s.candidates, lib.candidates);
  assert.doesNotMatch(JSON.stringify(s), /Mehlman|map_topic|\bMo\b|\bhis\b/);
  assert.match(s.next_step, /library_search/);
  const b = schoolBrief({ lesson_id: 'L1', mode: 'teach', topic: { id: 't1', name: 'Vectors' }, library: lib }, { profile: PROFILES.gcse, mods: { library: true } });
  assert.equal(b.library.use, SCHOOL_LIBRARY_USE);
  assert.doesNotMatch(JSON.stringify(b.library), /Mehlman/);
  assert.equal(schoolBrief({ lesson_id: 'L1', topic: { id: 't1', name: 'Vectors' }, library: lib }, { profile: PROFILES.alevel, mods: {} }).library, undefined);
});
