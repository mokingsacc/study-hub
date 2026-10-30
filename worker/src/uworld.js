import { HttpError, json, readJson, now, londonDayStart } from './util.js';
import { all, first, run, reserveSpend, spendCap } from './db.js';
import { callJson } from './claude.js';
import { timeline, sentenceSegments, splitByStarts } from '../../public/js/uworld/split.js';
import { ERROR_TYPES } from './checks.js';
import { saveCues, scrubStems } from './gaps.js';
import { MO } from './users.js';
import { ingestUworldQuestions, hook } from './map/ingest/hub.js';
import { pullForUworld } from './map/sync.js';
import { trackHook } from './uworld-track.js';
import { PACE } from './map/weights.js';
import { normSystem } from './uworld-systems.js';

export const MODES = ['timed', 'tutor'];
const MAX_SEGMENTS = 4000, MAX_TEXT = 2000, MAX_MANUAL = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanSegments(list) {
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS) throw new HttpError(400, 'The transcript is not in the right shape.');
  return list.map(s => {
    const start = num(s && s.start), end = num(s && s.end);
    if (start == null || end == null || typeof s.text !== 'string') throw new HttpError(400, 'The transcript is not in the right shape.');
    return { start: Math.round(start), end: Math.round(end), text: s.text.slice(0, MAX_TEXT) };
  });
}

function cleanResults(r) {
  if (r == null) return {};
  if (typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'The marks are not in the right shape.');
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || n > 60 || !v || typeof v !== 'object') continue;
    const letter = x => (typeof x === 'string' && /^[A-Z]$/.test(x) ? x : undefined);
    out[n] = { right: v.right === true ? true : v.right === false ? false : null, picked: letter(v.picked), answer: letter(v.answer),
      id: typeof v.id === 'string' && /^[\w-]{1,12}$/.test(v.id) ? v.id : undefined };
  }
  return out;
}

export async function put(request, env) {
  const b = await readJson(request, 2_000_000);
  if (typeof b.id !== 'string' || !/^[\w-]{1,40}$/.test(b.id)) throw new HttpError(400, 'The block needs an id.');
  if (typeof b.date !== 'string' || !DAY.test(b.date)) throw new HttpError(400, 'The block needs a date.');
  const mode = MODES.includes(b.mode) ? b.mode : 'timed';
  const segments = cleanSegments(b.segments);
  const manual = Array.isArray(b.manual) ? b.manual.slice(0, MAX_MANUAL).map(m => ({ t: Math.round(num(m && m.t) || 0) })) : [];
  const results = cleanResults(b.results);
  const minutes = Number.isInteger(b.minutes) && b.minutes >= 0 ? Math.min(b.minutes, 600) : null;
  const count = Number.isInteger(b.count) && b.count >= 1 ? Math.min(b.count, 60) : null;
  const words = segments.reduce((n, s) => n + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0);
  const t = now();
  await run(env, `INSERT INTO uworld_blocks (id, day, mode, minutes, count, segments_json, manual_json, results_json, words, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET day = excluded.day, mode = excluded.mode, minutes = excluded.minutes, count = excluded.count,
      segments_json = excluded.segments_json, manual_json = excluded.manual_json, results_json = excluded.results_json,
      words = excluded.words, updated_at = excluded.updated_at`,
  b.id, b.date, mode, minutes, count, JSON.stringify(scrubStems(segments)), JSON.stringify(manual), JSON.stringify(results), words, t, t);
  const cues = await saveCues(env, sentenceSegments(segments), `uw:${b.id}`, cueClock(b, t));
  await trackHook(env);
  const total = await first(env, 'SELECT count(*) AS n FROM uworld_blocks');
  return json({ saved: true, id: b.id, words, blocks_saved: total ? total.n : 1, cues });
}

export async function deleteBlock(request, env, ctx, { id }) {
  const blockId = String(id || '');
  if (!/^[\w-]{1,40}$/.test(blockId)) throw new HttpError(400, 'That is not a block.');
  const b = await first(env, 'SELECT id, questions_json FROM uworld_blocks WHERE id = ?', blockId);
  if (!b) return json({ deleted: false, gone: true });
  let qs = [];
  try { qs = JSON.parse(b.questions_json || '[]'); } catch (e) { qs = []; }
  if (qs.some(q => q && RESULTS.includes(q.result))) {
    throw new HttpError(409, 'This block has UWorld results on the map, so it is kept. Ask Claude to take its answers back first.');
  }
  const gapIds = (await all(env, 'SELECT id FROM gaps WHERE id >= ? AND id < ?', `cue:uw:${blockId}:`, `cue:uw:${blockId};`)).map(r => r.id);
  // The cues go the way a re-saved recording drops one: their gaps and their map observations.
  const gaps = await saveCues(env, [], `uw:${blockId}`, () => ({}));
  const stmts = [
    env.DB.prepare('DELETE FROM uworld_reviews WHERE block_id = ?').bind(blockId),
    env.DB.prepare('DELETE FROM uworld_judging WHERE block_id = ?').bind(blockId),
    env.DB.prepare('DELETE FROM uworld_blocks WHERE id = ?').bind(blockId),
  ];
  // A cue that was never placed waits in "Not on the map yet": it goes from there too.
  if (gapIds.length) stmts.push(env.DB.prepare(`UPDATE topic_queue SET status = 'rejected' WHERE status IN ('open', 'claimed') AND id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(gapIds.map(g => `gap:${g}`))));
  await env.DB.batch(stmts).catch(async e => {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    for (const s of stmts) await s.run().catch(() => {});
  });
  await trackHook(env);
  return json({ deleted: true, id: blockId, gaps: gapIds.length });
}

/** where() for a block's cues: seg -> {ref, at}, at the real time each cue was said (REG4-1). */
export function cueClock(b, t = now()) {
  const noon = Date.parse(`${b.date}T12:00:00Z`);
  const lo = londonDayStart(noon), hi = Math.max(lo, Math.min(londonDayStart(noon + 86_400_000) - 1, t));
  const plausible = v => Number.isSafeInteger(v) && v > t - 7 * 86_400_000 && v <= t + 60_000;
  const t0 = plausible(Number(b.t0)) ? Number(b.t0) : /^\d{12,14}$/.test(String(b.id)) && plausible(Number(b.id)) ? Number(b.id) : null;
  // Rounded up, so a cue said as a question's first words is never read as the question before (resolve.js takes the
  // last question that starts at or before the ref).
  return seg => ({ ref: `uworld:${b.id}@${mss(Math.ceil(seg.start / 1000))}`,
    at: Math.min(hi, Math.max(lo, t0 == null ? t : t0 + Math.max(0, Number(seg.start) || 0))) });
}

function marksText(count, results) {
  const ns = Object.keys(results).map(Number).sort((a, b) => a - b);
  if (!ns.length) return '';
  return ns.map(n => {
    const r = results[n];
    const res = r.right === true ? 'right' : r.right === false ? 'wrong' : 'not marked';
    return `Q${n}${r.id ? ` (ID ${r.id})` : ''}: ${res}${r.picked ? `, picked ${r.picked}` : ''}${r.answer ? `, answer ${r.answer}` : ''}`;
  }).join('\n');
}

export const RESULTS = ['right', 'wrong', 'omitted'];
export const UW_VERDICTS = ['wrong', 'right_flawed', 'sound', 'no_speech'];
const LABEL = 80, NOTE = 300;
export const PACE_S = PACE.pace_s, SLOW_S = PACE.slow_s;

// "12:05", "1:02:03" or a number of seconds -> ms from the start of the recording; null if unreadable.
export function startMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1000);
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(String(v ?? '').trim());
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
}

/**
 * Check what Claude in Chrome sends for one block's questions. Only short labels and numbers: a label longer
 * than 80 characters, or a note over 300, is refused (question text never belongs here).
 * Returns {questions, problems}.
 */
export function cleanQuestions(list) {
  const problems = [];
  if (!Array.isArray(list) || !list.length || list.length > 60) return { questions: [], problems: ['questions must be a list of 1 to 60 entries.'] };
  const seen = new Set();
  const questions = list.map((q, i) => {
    const at = `Question entry ${i + 1}`;
    const n = q && q.q;
    if (!Number.isInteger(n) || n < 1 || n > 60) problems.push(`${at}: q must be the question number (1 to 60).`);
    else if (seen.has(n)) problems.push(`${at}: Q${n} is listed twice.`);
    seen.add(n);
    const start = startMs(q && q.start);
    if (q && q.start != null && start == null) problems.push(`${at}: start must be a time like "12:05" from the transcript.`);
    const label = k => {
      const v = q && q[k];
      if (v == null || v === '') return null;
      if (typeof v !== 'string' || v.length > LABEL) { problems.push(`${at}: ${k} must be a short label (under ${LABEL} characters), never question text.`); return null; }
      return v.trim();
    };
    const letter = k => {
      const v = q && q[k];
      if (v == null || v === '') return null;
      const L = String(v).trim().toUpperCase();
      if (!/^[A-Z]$/.test(L)) { problems.push(`${at}: ${k} must be one letter.`); return null; }
      return L;
    };
    const int = (k, max) => {
      const v = q && q[k];
      if (v == null) return null;
      if (!Number.isInteger(v) || v < 0 || v > max) { problems.push(`${at}: ${k} must be a whole number from 0 to ${max}.`); return null; }
      return v;
    };
    const pick = (k, allowed) => {
      const v = q && q[k];
      if (v == null || v === '') return null;
      if (!allowed.includes(v)) { problems.push(`${at}: ${k} must be one of ${allowed.join(', ')}.`); return null; }
      return v;
    };
    let note = q && q.note;
    if (note != null && (typeof note !== 'string' || note.length > NOTE)) { problems.push(`${at}: note must be under ${NOTE} characters, in your own words.`); note = null; }
    const id = q && q.uworld_id != null ? String(q.uworld_id).trim() : '';
    if (id && !/^[\w-]{1,12}$/.test(id)) problems.push(`${at}: uworld_id must be the question ID number.`);
    return { q: n, start_ms: start, uworld_id: id && /^[\w-]{1,12}$/.test(id) ? id : null, result: pick('result', RESULTS),
      picked: letter('picked'), answer: letter('answer'), subject: label('subject'), system: normSystem(label('system')), topic: label('topic'),
      time_s: int('time_s', 3600), others_pct: int('others_pct', 100), others_time_s: int('others_time_s', 3600), verdict: pick('verdict', UW_VERDICTS),
      error_type: pick('error_type', ERROR_TYPES), note: note ? note.trim() : null };
  });
  return { questions: questions.sort((a, b) => a.q - b.q), problems };
}

export async function saveQuestions(env, blockId, list, ctx = null) {
  const row = blockId ? await first(env, 'SELECT id FROM uworld_blocks WHERE id = ?', String(blockId)) : null;
  if (!row) return { saved: false, problems: [`No saved UWorld block "${blockId}". Ask Mo to press Copy for Claude again (it saves the block), then try again.`] };
  const { questions, problems } = cleanQuestions(list);
  if (problems.length) return { saved: false, problems };
  const all = await mergeQuestions(env, row.id, questions, ctx);
  return { saved: true, questions: questions.length, saved_in_block: all.length };
}

// Entries add to what is saved (one "log this" at a time, or the results screenshot for the whole block). A
// question saved again is updated field by field: what the new entry gives replaces the old value, and what it
// leaves out is kept, so a "log this" save never wipes the times the screenshot read, nor the other way round.
// Then the block's answers go on the map (ingest/hub.js), and a new miss's Anki copy is pulled at +3, +10 and
// +25 s when ctx allows (Claude logs to Anki and here side by side).
// Two saves at once (the screenshot and a "log this", or Claude's parallel calls) must not lose each other's
// fields: the write only lands if the column is still what was read, and otherwise reads and merges again.
export async function mergeQuestions(env, blockId, questions, ctx = null) {
  let all = null;
  for (let tries = 0; tries < 8 && !all; tries++) {
    const cur = await first(env, 'SELECT questions_json FROM uworld_blocks WHERE id = ?', blockId);
    const old = cur ? cur.questions_json : null;
    const merged = new Map(JSON.parse(old || '[]').map(q => [q.q, q]));
    for (const q of questions) {
      const given = Object.fromEntries(Object.entries(q).filter(([, v]) => v != null));
      merged.set(q.q, { ...(merged.get(q.q) || {}), ...given });
    }
    const next = [...merged.values()].sort((a, b) => a.q - b.q);
    const w = await run(env, 'UPDATE uworld_blocks SET questions_json = ?, updated_at = ? WHERE id = ? AND questions_json IS ?', JSON.stringify(next), now(), blockId, old);
    if (w.meta && w.meta.changes) all = next;
  }
  if (!all) throw new HttpError(503, 'The block was busy saving; please try again.');
  const r = await hook('uworld', () => ingestUworldQuestions(env, MO, blockId, all));
  const fresh = new Set(questions.map(q => q.uworld_id).filter(Boolean));
  await trackHook(env); // more questions on the block can move the day's count
  if (r && r.unseen && ctx) pullForUworld(env, ctx, MO, r.unseen.filter(id => fresh.has(id) && all.some(q => q.uworld_id === id && (q.verdict === 'wrong' || q.verdict === 'right_flawed' || q.result === 'wrong'))));
  return all;
}

/** Time per question over a set of saved questions: average, how many over pace, and the slow ones, slowest first. */
export function timing(questions) {
  const timed = questions.filter(q => Number.isInteger(q.time_s) && q.time_s > 0);
  if (!timed.length) return { timed: 0, pace_s: PACE_S, slow_over_s: SLOW_S, slow: [] };
  const total = timed.reduce((t, q) => t + q.time_s, 0);
  const slow = timed.filter(q => q.time_s > SLOW_S).sort((a, b) => b.time_s - a.time_s)
    .map(q => Object.fromEntries(['q', 'uworld_id', 'result', 'system', 'topic', 'time_s', 'others_time_s', 'others_pct', 'date', 'block']
      .filter(k => q[k] != null).map(k => [k, q[k]])));
  return { timed: timed.length, pace_s: PACE_S, slow_over_s: SLOW_S, average_s: Math.round(total / timed.length), total_s: total,
    over_pace: timed.filter(q => q.time_s > PACE_S).length, slow };
}

const mss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ---------- the results screenshot (CONTRACT I17) ----------
const MAX_SHOTS = 4, MAX_SHOT_CHARS = 5_000_000, SHOT_RESERVE_USD = 1;
export const SHOT_SYSTEM = `You read Mo's UWorld results screen from his screenshots: the table UWorld shows after a block, one row per question. Mo is preparing for USMLE Step 2 CK and wants to know how long he spends on each question.
For each row you can read, return: q (the question's number in the block, the first column), uworld_id (the question ID), result (right, wrong or omitted, from the row's tick, cross or mark), subject, system and topic exactly as the row labels them (short labels only), others_pct (the % of other users who got it right), time_s (Mo's time spent, in seconds: "1 min 35 sec" or "1:35" is 95), and others_time_s only if the screen shows other users' average time.
Leave out anything you cannot read clearly (null) rather than guessing it. Never copy question text; the results table has none. If the screenshots are not a UWorld results table, return no rows and say so in problem.`;
// Nullable fields use anyOf, like the hub's other schemas: the API's structured outputs reject type arrays.
const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'object', properties: {
      q: { type: 'integer' }, uworld_id: nul({ type: 'string' }), result: nul({ type: 'string', enum: RESULTS }),
      subject: nul({ type: 'string' }), system: nul({ type: 'string' }), topic: nul({ type: 'string' }),
      others_pct: nul({ type: 'integer' }), time_s: nul({ type: 'integer' }), others_time_s: nul({ type: 'integer' }),
    }, required: ['q', 'uworld_id', 'result', 'subject', 'system', 'topic', 'others_pct', 'time_s', 'others_time_s'], additionalProperties: false } },
    problem: nul({ type: 'string' }),
  },
  required: ['questions', 'problem'],
  additionalProperties: false,
};

function shotBlock(url) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof url === 'string' ? url : '');
  if (!m) throw new HttpError(400, 'Each screenshot must be a PNG, JPEG or WebP picture.');
  if (m[2].length > MAX_SHOT_CHARS) throw new HttpError(413, 'A screenshot is too large. Try a smaller one.');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

// Claude's reading made safe for cleanQuestions: labels cut to fit, numbers rounded, unreadable values dropped.
export function tidyShot(rows) {
  const lab = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, LABEL - 1) : null);
  const int = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(r => r && Number.isInteger(r.q) && r.q >= 1 && r.q <= 60 && !seen.has(r.q) && seen.add(r.q))
    .map(r => ({ q: r.q, uworld_id: typeof r.uworld_id === 'string' && /^[\w-]{1,12}$/.test(r.uworld_id.trim()) ? r.uworld_id.trim() : null,
      result: RESULTS.includes(r.result) ? r.result : null, subject: lab(r.subject), system: normSystem(lab(r.system)), topic: lab(r.topic),
      others_pct: int(r.others_pct, 100), time_s: int(r.time_s, 3600) || null, others_time_s: int(r.others_time_s, 3600) || null }));
}

export async function resultsShot(request, env, ctx, { id }) {
  const b = await readJson(request, MAX_SHOTS * MAX_SHOT_CHARS + 10_000);
  const images = Array.isArray(b.images) ? b.images : [];
  if (!images.length || images.length > MAX_SHOTS) throw new HttpError(400, `Send 1 to ${MAX_SHOTS} screenshots of the results page.`);
  const content = images.map(shotBlock);
  const row = await first(env, 'SELECT id FROM uworld_blocks WHERE id = ?', String(id));
  if (!row) throw new HttpError(404, 'This block is not saved on the hub yet. Wait for it to save, then try again.');
  content.push({ type: 'text', text: `${images.length === 1 ? 'This is' : `These ${images.length} screenshots are`} Mo's UWorld results screen for one block. Read every question row.` });
  const release = await reserveSpend(env, SHOT_RESERVE_USD, await spendCap(env));
  let data, usd;
  try {
    ({ data, usd } = await callJson(env, { role: 'reader', system: SHOT_SYSTEM, schema: SHOT_SCHEMA, effort: 'high', maxTokens: 16000,
      messages: [{ role: 'user', content }] }));
  } finally {
    await release(0); // the call added its real cost
  }
  const rows = tidyShot(data && data.questions);
  if (!rows.length) throw new HttpError(422, (data && data.problem) || 'No question rows could be read from that screenshot.');
  const { questions, problems } = cleanQuestions(rows);
  if (problems.length) throw new HttpError(422, `The screenshot could not be saved: ${problems[0]}`);
  const all = await mergeQuestions(env, row.id, questions, ctx);
  return json({ saved: true, read: questions.length, saved_in_block: all.length, ...timing(all), usd: Math.round(usd * 1e4) / 1e4 });
}

export async function blockTimes(env, { since, before } = {}) {
  const where = [], args = [];
  if (typeof since === 'string' && DAY.test(since)) { where.push('day >= ?'); args.push(since); }
  if (typeof before === 'string' && DAY.test(before)) { where.push('day < ?'); args.push(before); }
  if (!where.length) where.push("day >= date('now', '-6 days')");
  const rows = await all(env, `SELECT id, day, questions_json FROM uworld_blocks WHERE ${where.join(' AND ')} ORDER BY day, created_at`, ...args);
  const qs = rows.flatMap(r => JSON.parse(r.questions_json || '[]').map(q => ({ ...q, system: normSystem(q.system), date: r.day, block: r.id })));
  const bySystem = {};
  for (const q of qs.filter(x => Number.isInteger(x.time_s) && x.time_s > 0)) {
    const e = bySystem[q.system || 'unknown'] || (bySystem[q.system || 'unknown'] = { n: 0, total_s: 0, slow: 0 });
    e.n++; e.total_s += q.time_s; if (q.time_s > SLOW_S) e.slow++;
  }
  const systems = Object.entries(bySystem).map(([system, e]) => ({ system, questions: e.n, average_s: Math.round(e.total_s / e.n), slow: e.slow }))
    .sort((a, b) => b.average_s - a.average_s);
  return { blocks: rows.length, questions: qs.length, ...timing(qs), by_system: systems };
}

export function timesText(r) {
  if (!r.timed) return r.blocks ? `${r.blocks} saved block(s), but no question times yet (Mo adds the results screenshot on the recorder after a block).` : 'No UWorld blocks saved in that range.';
  const line = q => `${q.date} Q${q.q}${q.uworld_id ? ` (ID ${q.uworld_id})` : ''}: ${mss(q.time_s)}${q.others_time_s ? ` (others ${mss(q.others_time_s)})` : ''}, ${q.result || 'result not read'}, ${[q.system, q.topic].filter(Boolean).join(' / ') || 'no labels'}`;
  return [`${r.timed} timed questions over ${r.blocks} block(s): average ${mss(r.average_s)} a question (pace ${mss(r.pace_s)}); ${r.over_pace} over pace, ${r.slow.length} slow (over ${mss(r.slow_over_s)}).`,
    'By system, slowest first: ' + r.by_system.map(x => `${x.system} ${mss(x.average_s)} (${x.questions} Qs, ${x.slow} slow)`).join('; ') + '.',
    r.slow.length ? 'Slow questions, slowest first (a slow topic is a weak topic, even when right):\n' + r.slow.map(line).join('\n') : 'No slow questions.'].join('\n');
}

export async function blockWords(env, { block, date, question } = {}) {
  const row = block ? await first(env, 'SELECT * FROM uworld_blocks WHERE id = ?', String(block))
    : typeof date === 'string' && DAY.test(date) ? await first(env, 'SELECT * FROM uworld_blocks WHERE day = ? ORDER BY created_at DESC LIMIT 1', date)
      : await first(env, 'SELECT * FROM uworld_blocks ORDER BY day DESC, created_at DESC LIMIT 1');
  if (!row) return { found: false };
  const segs = JSON.parse(row.segments_json || '[]'), manual = JSON.parse(row.manual_json || '[]');
  const questions = JSON.parse(row.questions_json || '[]');
  const head = { found: true, block: row.id, date: row.day, mode: row.mode, minutes: row.minutes, count: row.count,
    saved_questions: questions.map(q => q.q) };
  const saved = Number.isInteger(question) ? questions.find(x => x.q === question) : null;
  if (saved) head.details = questionLine(saved).replace(/:(\nCheck note:[\s\S]*)?$/, '');
  if (saved && saved.time_s) head.time_s = saved.time_s;
  const q = saved && saved.start_ms != null ? saved : null;
  if (q) {
    const part = splitByStarts(segs, questions).groups.get(q.q) || [];
    return { ...head, question: q.q, whole_block: false, transcript: timeline(part, []).join('\n') || '(no speech)' };
  }
  return { ...head, question: Number.isInteger(question) ? question : null, whole_block: true, transcript: timeline(segs, manual).join('\n') || '(nothing was heard)' };
}

function questionLine(q) {
  const bits = [q.uworld_id && `ID ${q.uworld_id}`, q.result, q.picked && `picked ${q.picked}`, q.answer && `answer ${q.answer}`,
    [q.subject, q.system, q.topic].filter(Boolean).join(' / '),
    q.time_s != null && `${q.time_s} s${q.time_s > SLOW_S ? ' (slow)' : ''}`, q.others_time_s != null && `others ${q.others_time_s} s`, q.others_pct != null && `${q.others_pct}% of others right`,
    q.verdict && `check: ${q.verdict}${q.error_type ? `, ${q.error_type}` : ''}`].filter(Boolean);
  return `Q${q.q}${bits.length ? ` (${bits.join(', ')})` : ''}:${q.note ? `\nCheck note: ${q.note}` : ''}`;
}

// The transcript cut at each question's start time, so every line sits under its question.
function byQuestion(segments, manual, questions) {
  const starts = questions.filter(q => q.start_ms != null).sort((a, b) => a.start_ms - b.start_ms);
  if (!starts.length) return null;
  const { before, groups } = splitByStarts(segments, starts);
  const out = [];
  if (before.length) out.push('Before Q' + starts[0].q + ':', ...timeline(before, []));
  for (const q of questions) {
    out.push('', questionLine(q));
    const segs = groups.get(q.q);
    out.push(...(segs ? (segs.length ? timeline(segs, []) : ['(no speech)']) : ['(no start time given)']));
  }
  return out.join('\n').trim();
}

/** Saved blocks for the connector, newest first: {total, total_words, blocks: [{id, date, mode, minutes, count, words, split, marks, transcript}]}. */
export async function listBlocks(env, { since, before, limit } = {}) {
  const n = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 5));
  const where = [], args = [];
  if (typeof since === 'string' && DAY.test(since)) { where.push('day >= ?'); args.push(since); }
  if (typeof before === 'string' && DAY.test(before)) { where.push('day < ?'); args.push(before); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    all(env, `SELECT * FROM uworld_blocks ${w} ORDER BY day DESC, created_at DESC LIMIT ?`, ...args, n),
    first(env, `SELECT count(*) AS n, COALESCE(sum(words), 0) AS words FROM uworld_blocks ${w}`, ...args),
  ]);
  const blocks = rows.map(r => {
    const segs = JSON.parse(r.segments_json || '[]'), manual = JSON.parse(r.manual_json || '[]');
    const questions = JSON.parse(r.questions_json || '[]');
    const split = questions.length ? byQuestion(segs, manual, questions) : null;
    const lines = timeline(segs, manual);
    return { id: r.id, date: r.day, mode: r.mode, minutes: r.minutes, count: r.count, words: r.words,
      split_saved: questions.length > 0, marks: questions.length ? null : marksText(r.count, JSON.parse(r.results_json || '{}')) || null,
      transcript: split || lines.join('\n') || '(nothing was heard)' };
  });
  return { total: total ? total.n : 0, total_words: total ? total.words : 0, blocks };
}
