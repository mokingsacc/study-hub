import { HttpError, json, londonDay, now as nowMs } from '../util.js';
import { requireModule } from './modules.js';
import { resolveTopic } from './subjects.js';

export const HEADINGS = {
  understand: 'The big idea (why it works)', recognise: 'Key facts and words', test: 'How it comes up in exams',
  distinguish: 'Telling it apart from similar ideas', treat: 'Using it (methods, examples, calculations)', trap: 'Common mistakes',
};
const KEYS = Object.keys(HEADINGS);
const SHORT = { understand: 'Big idea', recognise: 'Key facts', test: 'Exam use', distinguish: 'Tell apart', treat: 'Using it', trap: 'Mistakes' };
export const LIMITS = { words: 6000, points_min: 4, points_max: 15, text: 200, quote: 200, beliefs: 2 };

export const vivaPrompt = name => `${name}: tell me everything you know about it, in your own words. Try to cover: ${KEYS.map(k => HEADINGS[k].toLowerCase()).join('; ')}.`;

export const VIVA_HOW = 'Viva first. Your first message is the prompt above, word for word. They talk or type freely: no hints, no corrections. '
  + 'Then be the examiner: write 6 to 12 key points a good answer at their level and board covers (each under one heading; key: true for the ones exams reward most) '
  + 'and mark each said, wrong or missing from their words (quote them). Call viva_mark {topic, phase: "before", lesson_id, words, points}. '
  + 'Teach only the headings in its plan, in that order. At the end ask the same prompt again and call viva_mark {phase: "after"} with the same points.';

export function vivaBrief(topic, last = null) {
  return { prompt: vivaPrompt(topic.name), headings: KEYS.map(k => HEADINGS[k]), how: VIVA_HOW,
    ...(last ? { last: { day: last.day, said: last.said, of: last.of, missed: last.missed.slice(0, 5) } } : {}) };
}

const cut = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

export function marksOf(points, beliefs = []) {
  if (!Array.isArray(points) || points.length < LIMITS.points_min || points.length > LIMITS.points_max) {
    throw new HttpError(400, `Give ${LIMITS.points_min} to ${LIMITS.points_max} key points, each with its heading and whether it was said.`);
  }
  const rubric = [], marks = [];
  points.forEach((p, i) => {
    const text = cut(p && p.text, LIMITS.text);
    if (!text) throw new HttpError(400, `Key point ${i + 1} has no text.`);
    if (!KEYS.includes(p.heading)) throw new HttpError(400, `Key point ${i + 1}: heading is one of ${KEYS.join(', ')}.`);
    if (!['said', 'wrong', 'missing'].includes(p.status)) throw new HttpError(400, `Key point ${i + 1}: status is said, wrong or missing.`);
    const id = `p${i + 1}`;
    rubric.push({ id, text, step: p.heading, yield: p.key ? 'high' : 'normal' });
    marks.push({ id, status: p.status, quote: p.status === 'missing' ? null : cut(p.quote, LIMITS.quote) });
  });
  const misconceptions = (Array.isArray(beliefs) ? beliefs : []).slice(0, LIMITS.beliefs).map(b => ({ belief: cut(b && b.belief, 200), quote: cut(b && b.quote, LIMITS.quote) })).filter(b => b.belief);
  return { rubric, data: { points: marks, misconceptions, other_topics: [] } };
}

/** The latest marked viva on a topic, shaped for the brief and the page (null when none). */
export async function lastVivaFor(env, user, topicId) {
  const r = await env.DB.prepare(`SELECT id, kind, phase, coverage, said_n, wrong_n, missing_n, result_json, graded_at FROM viva_results
    WHERE user_id = ? AND topic_id = ? AND status = 'graded' ORDER BY graded_at DESC LIMIT 1`).bind(user, topicId).first().catch(() => null);
  if (!r) return null;
  let res = {};
  try { res = JSON.parse(r.result_json || '{}') || {}; } catch { res = {}; }
  const points = Array.isArray(res.points) ? res.points : [];
  return { id: r.id, day: londonDay(r.graded_at), kind: r.kind, phase: r.phase || null, coverage: r.coverage, said: r.said_n, of: points.length, wrong: r.wrong_n,
    headings: Object.fromEntries(Object.entries(res.headings || {}).map(([k, h]) => [SHORT[k] || k, h.result])),
    missed: points.filter(p => p.status !== 'said').map(p => `${p.status}: ${p.text}`) };
}

export async function markViva(env, user, a = {}, { at = nowMs() } = {}) {
  const words = cut(a.words, LIMITS.words);
  if (!words) throw new HttpError(400, 'Pass their words (what they said or typed) as words.');
  const ref = await resolveTopic(env, user, String(a.topic || ''));
  if (ref.ambiguous) return ref;
  const topic = await env.DB.prepare('SELECT id, name FROM topics WHERE user_id = ? AND id = ?').bind(user, ref.id).first();
  const { rubric, data } = marksOf(a.points, a.beliefs);
  const phase = a.phase === 'before' || a.phase === 'after' ? a.phase : null;
  let lessonId = null;
  if (a.lesson_id) {
    const l = await env.DB.prepare('SELECT id FROM lessons WHERE user_id = ? AND id = ?').bind(user, String(a.lesson_id)).first();
    if (!l) throw new HttpError(404, 'That lesson is not theirs.');
    lessonId = l.id;
  }
  const { predictionFor } = await import('../map/viva.js');
  const pred = await predictionFor(env, user, topic.id, at).catch(() => ({ p: null, band: null, basis: null }));
  const id = `V${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const prev = await env.DB.prepare('SELECT version FROM viva_rubrics WHERE user_id = ? AND topic_id = ?').bind(user, topic.id).first();
  const version = (Number(prev && prev.version) || 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO viva_rubrics (user_id, topic_id, version, status, topic_kind, sources_hash, points_json, built_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'ready', 'concept', 'f2:claude', ?4, ?5, ?5, ?5)
      ON CONFLICT (user_id, topic_id) DO UPDATE SET version = ?3, status = 'ready', sources_hash = 'f2:claude', points_json = ?4, built_at = ?5, updated_at = ?5`)
      .bind(user, topic.id, version, JSON.stringify(rubric), at),
    env.DB.prepare(`INSERT INTO viva_results (user_id, id, kind, topic_id, topic_name, lesson_id, surface, status, prompt, transcript, said_at, pred_p, pred_band, pred_json,
      created_at, updated_at, phase) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'chat', 'pending', ?7, ?8, ?9, ?10, ?11, ?12, ?9, ?9, ?13)`)
      .bind(user, id, lessonId ? 'lesson' : 'audit', topic.id, topic.name, lessonId, vivaPrompt(topic.name), words, at, pred.p, pred.band, JSON.stringify(pred.basis), phase),
  ]);
  const { gradeViva } = await import('../map/viva-job.js');
  const v = await env.DB.prepare('SELECT * FROM viva_results WHERE user_id = ? AND id = ?').bind(user, id).first();
  const out = await gradeViva(env, user, v, { version, points: rubric }, { now: at, call: async () => ({ data, usd: 0 }) });
  const last = await lastVivaFor(env, user, topic.id);
  return { viva_id: id, topic: { id: topic.id, name: topic.name }, said: out.said, wrong: out.wrong, missing: out.missing, of: rubric.length,
    coverage: last && last.coverage, headings: last && last.headings,
    plan: last ? Object.entries(last.headings).filter(([, r]) => r !== 'held').map(([h]) => h) : [],
    note: phase === 'after' ? 'Closing viva marked. Tell them what moved, in a line.' : 'Marked. Teach the headings in plan, in that order; skip the rest.' };
}

export const TOOLS = [{
  name: 'viva_mark', module: 'map',
  description: '"Tell me what you know": mark the student\'s free recall on one topic. You are the examiner: write 6 to 12 key points a good answer at their level covers, '
    + 'each under one heading (understand: the big idea; recognise: key facts and words; test: how it comes up in exams; distinguish: telling it apart; treat: using it; trap: common mistakes), '
    + 'key: true for what exams reward most, and mark each said, wrong or missing from their words (quote them). phase: "before" at the start of a lesson, "after" at its end, none for a quick check. '
    + 'The hub scores it, updates their map, and returns the headings to teach.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['topic', 'words', 'points'], properties: {
    topic: { type: 'string' }, words: { type: 'string', maxLength: LIMITS.words }, phase: { type: 'string', enum: ['before', 'after'] }, lesson_id: { type: 'string' },
    points: { type: 'array', minItems: LIMITS.points_min, maxItems: LIMITS.points_max, items: { type: 'object', additionalProperties: false, required: ['text', 'heading', 'status'], properties: {
      text: { type: 'string', maxLength: LIMITS.text }, heading: { type: 'string', enum: KEYS }, status: { type: 'string', enum: ['said', 'wrong', 'missing'] },
      quote: { type: 'string', maxLength: LIMITS.quote }, key: { type: 'boolean' } } } },
    beliefs: { type: 'array', maxItems: LIMITS.beliefs, items: { type: 'object', additionalProperties: false, required: ['belief'], properties: { belief: { type: 'string' }, quote: { type: 'string' } } } },
  } },
  run: (env, user, a) => markViva(env, user, a),
}];

export const ROUTES = [
  ['GET', '/api/p/topics/:id/viva', async (rq, env, ctx, params, url, user, session) => {
    requireModule(session, 'map', env);
    const t = await env.DB.prepare('SELECT id, name FROM topics WHERE user_id = ? AND id = ?').bind(user, params.id).first();
    if (!t) throw new HttpError(404, 'That topic is not on your map.');
    return json({ last: await lastVivaFor(env, user, t.id), prompt: vivaPrompt(t.name) });
  }],
];
