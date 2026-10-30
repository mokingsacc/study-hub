import { HttpError, json, readJson, now } from './util.js';
import { all, first, run, reserveSpend, spendCap, getSetting, setSetting } from './db.js';
import { callJson } from './claude.js';
import { GAP_STEPS, GAP_CONFIDENCE, TOPIC_MAX, hasSignalCols } from './gaps.js';
import { reviewMessage, FIVE_STEPS, CONFIDENCES } from './uworld-review.js';
import { mergeQuestions } from './uworld.js';
import { objectivesFor } from './library/objectives.js';
import { MO } from './users.js';
import { CONFIDENCE_RULE } from '../../public/js/conf-words.js';
import { noteJob } from './job-log.js';

export const KEY = 'backfill_signals';
export const BACKFILL_MAX_USD = 15;
const DAYS = 120, BATCH = 50, RESERVE_USD = 1, MIN_CUE_WORDS = 5;

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const fit = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);

export const GAPS_SYSTEM = `You tag Mo's logged knowledge gaps for his USMLE Step 2 CK study map (US guidelines). Each gap is one line saying what he did not hold, sometimes with his own words (transcribed, so expect misheard medical words) and the topic. You never see the card or question.
For each gap give:
- mixed_with: the one look-alike the line says he confused it with or could not tell it from, named as an AMBOSS article would name it (singular, no "vs"), only when the line or his words name one ("cannot tell Campylobacter from E. coli O157" gives Enterohemorrhagic Escherichia coli infection; "put exposure therapy, the mainstay for specific phobia, in its place" gives Specific phobia); else null. Never the topic itself.
- step: the one step that broke: recognise (did not know what it is from its findings, or its name), distinguish (could not tell it from a look-alike), test (wrong or missing workup or next test), treat (wrong or missing management), trap (a classic exception, threshold or contraindication). null only when the line says nothing about it ("I don't get it").
- ${CONFIDENCE_RULE}`;

const GAPS_SCHEMA = {
  type: 'object', properties: { gaps: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, mixed_with: nul({ type: 'string' }), step: nul({ type: 'string', enum: GAP_STEPS }), confidence: nul({ type: 'string', enum: GAP_CONFIDENCE }),
  }, required: ['id', 'mixed_with', 'step', 'confidence'], additionalProperties: false } } },
  required: ['gaps'], additionalProperties: false,
};

export const BLOCK_SYSTEM = `You read one UWorld block that Mo (a learner preparing for USMLE Step 2 CK) recorded himself thinking aloud through, transcribed by Whisper (expect misheard medical words). You get one row per question from UWorld's results screen (right or wrong is UWorld's), the check already saved for it, and his words with times. You never see the questions. Find his words for each question in order (a new patient, "next question", or a named letter marks a boundary), then give for each question:
- step, for questions marked wrong or right_flawed only: the one step that broke. recognise: did not know what it is from the findings. distinguish: narrowed to it and a look-alike and could not tell them apart. test: knew what it is but chose the wrong workup or next test. treat: knew what it is but chose the wrong management. trap: fell for a classic exception, threshold, contraindication or the wrong question asked. null for the others.
- For every question he spoke on: ${CONFIDENCE_RULE}`;

const BLOCK_SCHEMA = {
  type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: {
    q: { type: 'integer' }, step: nul({ type: 'string', enum: FIVE_STEPS }), confidence: nul({ type: 'string', enum: CONFIDENCES }),
  }, required: ['q', 'step', 'confidence'], additionalProperties: false } } },
  required: ['questions'], additionalProperties: false,
};

const fresh = () => ({ status: 'on', started_at: now(), gaps_after: null, gaps_tagged: 0, gaps_done: false, blocks_done: [], blocks_left: null, usd: 0, error: null, finished_at: null });
async function state(env) { const s = await getSetting(env, KEY); return s && typeof s === 'object' ? s : null; }

// POST /api/backfill/spoken-signals {force?}: start (or restart) the catch-up. GET: how far it is.
export async function startRoute(request, env) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  if (!(await hasSignalCols(env))) throw new HttpError(409, 'Apply migration 0035_spoken_signals.sql first.');
  const cur = await state(env);
  if (cur && cur.status === 'on' && !(body && body.force)) return json({ started: false, already: 'running', ...cur });
  if (cur && cur.status === 'done' && !(body && body.force)) return json({ started: false, already: 'done', ...cur });
  const s = fresh();
  await setSetting(env, KEY, s);
  return json({ started: true, ...s });
}
export async function statusRoute(request, env) {
  return json((await state(env)) || { status: 'not started' });
}

// One paid call (call: a function making the Claude call) under the day's cap; returns {data, usd}. Throws HttpError 429 at the cap
// (the next run tries again).
async function paid(env, s, call) {
  if (s.usd >= BACKFILL_MAX_USD) throw new HttpError(429, `The catch-up's own limit ($${BACKFILL_MAX_USD}) is reached.`);
  const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
  let usd = 0;
  try {
    const r = await call();
    usd = r.usd || 0;
    return r;
  } catch (e) {
    usd = Number(e && e.usd) || 0;
    throw e;
  } finally {
    await release(0);
    s.usd = Math.round((s.usd + usd) * 10000) / 10000;
  }
}

/** The gaps still to tag, oldest first after the cursor: {rows, worth} (worth: the ones with words enough to read). */
export async function gapsToTag(env, after, t = now()) {
  const [at, id] = after ? [after.at, after.id] : [0, ''];
  const rows = await all(env, `SELECT id, at, source, topic, gap, said, error_type, verdict, mixed_with FROM gaps
    WHERE held = 0 AND step IS NULL AND at >= ? AND (at > ? OR (at = ? AND id > ?)) ORDER BY at, id LIMIT ?`, t - DAYS * 86_400_000, at, at, id, BATCH);
  const worth = rows.filter(r => r.source !== 'spoken_cue' || String(r.gap || '').split(/\s+/).length >= MIN_CUE_WORDS);
  return { rows, worth };
}

export function gapsMessage(rows) {
  return `${rows.length} gaps:\n\n${rows.map(r => [`id ${r.id}`, r.topic && `topic: ${r.topic}`, `gap: ${r.gap}`, r.said && `his words: "${r.said}"`,
    r.error_type && `error type: ${r.error_type}`, `verdict: ${r.verdict || 'gap'}`].filter(Boolean).join('\n')).join('\n\n')}`;
}

/** The tags as statements: only where a row has none yet, and the row goes back to the map. */
export function gapTagStatements(env, rows, data) {
  const byId = new Map((data && Array.isArray(data.gaps) ? data.gaps : []).filter(g => g && g.id).map(g => [g.id, g]));
  const out = [];
  for (const r of rows) {
    const g = byId.get(r.id);
    if (!g) continue;
    let mixed = fit(g.mixed_with, TOPIC_MAX);
    if (mixed && r.topic && mixed.toLowerCase() === String(r.topic).toLowerCase()) mixed = null;
    const step = GAP_STEPS.includes(g.step) ? g.step : null, confidence = GAP_CONFIDENCE.includes(g.confidence) ? g.confidence : null;
    if (!mixed && !step && !confidence) continue;
    out.push(env.DB.prepare(`UPDATE gaps SET mixed_with = COALESCE(mixed_with, ?), step = COALESCE(step, ?), confidence = COALESCE(confidence, ?),
      map_state = NULL WHERE id = ?`).bind(mixed, step, confidence, r.id));
  }
  return out;
}

async function gapsUnit(env, s) {
  const { rows, worth } = await gapsToTag(env, s.gaps_after);
  if (!rows.length) { s.gaps_done = true; return 'gaps done'; }
  if (worth.length) {
    const { data } = await paid(env, s, () => callJson(env, { role: 'checker', system: GAPS_SYSTEM, schema: GAPS_SCHEMA, effort: 'high', maxTokens: 16000,
      messages: [{ role: 'user', content: gapsMessage(worth) }] }));
    const st = gapTagStatements(env, worth, data);
    if (st.length) await env.DB.batch(st);
    s.gaps_tagged += st.length;
  }
  const last = rows[rows.length - 1];
  s.gaps_after = { at: last.at, id: last.id };
  return `gaps ${rows.length}`;
}

/** The questions of a block that need a step or a confidence: spoken on, or wrong or flawed, and with neither yet. */
export function blockTodo(questions) {
  return questions.filter(q => q && Number.isInteger(q.q) && ['right', 'wrong', 'omitted'].includes(q.result) && !q.step && !q.confidence
    && (q.result !== 'right' || q.verdict === 'right_flawed' || q.verdict === 'sound'));
}

export function blockEntries(todo, data) {
  const got = new Map((data && Array.isArray(data.questions) ? data.questions : []).filter(x => x && Number.isInteger(x.q)).map(x => [x.q, x]));
  const out = [];
  for (const q of todo) {
    const x = got.get(q.q);
    if (!x) continue;
    const flawed = q.result !== 'right' || q.verdict === 'right_flawed';
    const e = { q: q.q };
    if (flawed && FIVE_STEPS.includes(x.step)) e.step = x.step;
    if (CONFIDENCES.includes(x.confidence)) e.confidence = x.confidence;
    if (e.step || e.confidence) out.push(e);
  }
  return out;
}

async function blockUnit(env, s, ctx) {
  const done = new Set(s.blocks_done || []);
  const blocks = await all(env, 'SELECT id, day, mode, minutes, segments_json, manual_json, questions_json FROM uworld_blocks ORDER BY day, id');
  const next = blocks.find(b => !done.has(b.id));
  s.blocks_left = blocks.filter(b => !done.has(b.id)).length;
  if (!next) { s.status = 'done'; s.finished_at = now(); return 'done'; }
  const todo = blockTodo(parse(next.questions_json, []));
  if (todo.length) {
    const objectives = await objectivesFor(env, MO, todo.map(q => q.uworld_id).filter(Boolean)).catch(() => ({}));
    const head = reviewMessage(next, todo, parse(next.segments_json, []), parse(next.manual_json, []), objectives);
    const checks = todo.map(q => `Q${q.q}: saved check ${q.verdict || 'none'}${q.error_type ? `, ${q.error_type}` : ''}${q.note ? `: ${q.note}` : ''}`).join('\n');
    const { data } = await paid(env, s, () => callJson(env, { role: 'reviewer', system: BLOCK_SYSTEM, schema: BLOCK_SCHEMA, effort: 'high', maxTokens: 16000,
      messages: [{ role: 'user', content: `${head}\n\nThe checks already saved:\n${checks}` }] }));
    const entries = blockEntries(todo, data);
    if (entries.length) await mergeQuestions(env, next.id, entries, ctx);
  }
  s.blocks_done = [...done, next.id];
  s.blocks_left = Math.max(0, s.blocks_left - 1);
  return `block ${next.id}`;
}

/** The minute cron: one unit of the catch-up when it is on. Never throws (a failed unit is tried again next minute). */
export async function tick(env, ctx = null) {
  const s = await state(env);
  if (!s || s.status !== 'on') return null;
  let did = null;
  try {
    did = s.gaps_done ? await blockUnit(env, s, ctx) : await gapsUnit(env, s);
    s.error = null;
  } catch (e) {
    s.error = String(e && e.message || e).slice(0, 200);
    if (e instanceof HttpError && e.status === 429 && s.usd >= BACKFILL_MAX_USD) { s.status = 'stopped'; s.finished_at = now(); }
  }
  s.updated_at = now();
  await setSetting(env, KEY, s);
  await noteJob(env, { job: 'catchup_signals', key: String(s.started_at), state: s.status === 'stopped' ? 'held' : s.error ? 'failed' : 'ok', detail: s.error,
    counts: { status: s.status, gaps: s.gaps_tagged || 0, blocks: (s.blocks_done || []).length, left: s.blocks_left ?? 0, usd: s.usd || 0, max: BACKFILL_MAX_USD } });
  return did;
}
