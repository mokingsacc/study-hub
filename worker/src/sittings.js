// Sittings: one attempt at an exam (hub) or an outside test (external, score only).
import { HttpError, json, rawJson, readJson, rowJson, str, int, uuid, now } from './util.js';
import { all, first, run, getSettings, getSitting } from './db.js';
import { MO } from './users.js';
import { releaseSitting, forgetSitting, hook } from './map/ingest/hub.js';

export const VOICE_MODES = ['quick', 'full', 'silent'];
const STATUSES = ['scheduled', 'in_progress', 'done'];
// What kind of exam it is, for the predictor (migration 0004). NULL = not said (older rows).
export const EXAM_TYPES = ['nbme', 'uwsa', 'free120', 'uworld_avg', 'hub', 'other'];
export const TIMINGS = ['strict', 'loose'];
// Same as public/js/exam/plan.js. Exam day (from 7 May 2026): 16 blocks of up to 20, 30 min each,
// 55 min break pool for the whole sitting (break_minutes).
const PRESETS = {
  exam_day: { block_size: 20, block_minutes: 30, break_minutes: 55 },
  nbme: { block_size: 50, block_minutes: 75, break_minutes: 15 },
  free120: { block_size: 20, block_minutes: 30, break_minutes: 25 },
  custom: { block_size: 20, block_minutes: 30, break_minutes: 10 },
};

export function presetKey(preset) {
  const p = String(preset || '').toLowerCase();
  if (/free.?120/.test(p)) return 'free120';
  if (/exam.?day|step.?2/.test(p)) return 'exam_day';
  if (/nbme/.test(p)) return 'nbme';
  return 'custom';
}

function checkDate(v) {
  const s = str(v, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Dates must look like 2027-06-30.');
  return s;
}

// Validates the editable columns present in body; returns {column: value}.
function columns(body, partial) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  if (has('name') || !partial) {
    out.name = str(body.name, 200);
    if (!out.name) throw new HttpError(400, 'Please give the sitting a name.');
  }
  if (has('kind') || !partial) {
    out.kind = body.kind || 'hub';
    if (!['hub', 'external'].includes(out.kind)) throw new HttpError(400, "kind must be 'hub' or 'external'.");
  }
  if (has('exam_id')) out.exam_id = str(body.exam_id, 100);
  if (has('external_label')) out.external_label = str(body.external_label, 200);
  if (has('scheduled_date')) out.scheduled_date = checkDate(body.scheduled_date);
  if (has('preset')) out.preset = body.preset == null || body.preset === '' ? null : presetKey(body.preset);
  if (has('block_size')) out.block_size = int(body.block_size, 'Block size', { min: 1, max: 400 });
  // 0 = untimed (plan.js shows Block Time Elapsed instead of a countdown).
  if (has('block_minutes')) out.block_minutes = int(body.block_minutes, 'Block minutes', { min: 0, max: 600 });
  if (has('break_minutes')) out.break_minutes = int(body.break_minutes, 'Break minutes', { min: 0, max: 600 });
  if (has('voice_mode')) {
    out.voice_mode = body.voice_mode || 'quick';
    if (!VOICE_MODES.includes(out.voice_mode)) throw new HttpError(400, 'Voice mode must be quick, full or silent.');
  }
  if (has('status')) {
    out.status = body.status;
    if (!STATUSES.includes(out.status)) throw new HttpError(400, 'Status must be scheduled, in_progress or done.');
  }
  if (has('score_pct')) {
    out.score_pct = body.score_pct == null || body.score_pct === '' ? null : Number(body.score_pct);
    if (out.score_pct != null && !(out.score_pct >= 0 && out.score_pct <= 100)) throw new HttpError(400, 'Score must be a percentage from 0 to 100.');
  }
  if (has('official_score')) out.official_score = int(body.official_score, 'Official score', { min: 1, max: 300 });
  if (has('exam_type')) {
    out.exam_type = body.exam_type == null || body.exam_type === '' ? null : String(body.exam_type);
    if (out.exam_type != null && !EXAM_TYPES.includes(out.exam_type)) throw new HttpError(400, 'Exam type must be nbme, uwsa, free120, uworld_avg, hub or other.');
  }
  if (has('timing')) {
    out.timing = body.timing == null || body.timing === '' ? 'strict' : String(body.timing);
    if (!TIMINGS.includes(out.timing)) throw new HttpError(400, 'Timing must be strict or loose.');
  }
  if (has('notes')) out.notes = str(body.notes, 5000);
  if (has('finished_at')) out.finished_at = int(body.finished_at, 'finished_at', { min: 0 });
  return out;
}

export async function create(request, env) {
  const body = await readJson(request);
  const c = columns(body, false);
  if (c.kind === 'hub') {
    if (!c.exam_id) throw new HttpError(400, 'Please choose the exam for this sitting.');
    const exam = await first(env, 'SELECT question_count FROM exams WHERE id = ?', c.exam_id);
    if (!exam) throw new HttpError(404, 'That exam was not found.');
  }
  if (c.kind === 'hub' && !c.preset) c.preset = 'custom';
  if (c.kind === 'hub' && !('exam_type' in c)) c.exam_type = 'hub';
  const preset = PRESETS[c.preset];
  if (preset) for (const k of Object.keys(preset)) if (c[k] == null) c[k] = preset[k];
  if (!c.voice_mode) c.voice_mode = (await getSettings(env)).default_voice_mode || 'quick';
  c.id = uuid();
  c.created_at = now();
  if (!c.status) c.status = 'scheduled';
  const keys = Object.keys(c);
  await run(env, `INSERT INTO sittings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => c[k]));
  return json({ id: c.id });
}

export async function patch(request, env, ctx, { id }) {
  const was = await getSitting(env, id);
  const body = await readJson(request);
  const c = columns(body, true);
  if (c.exam_id && !(await first(env, 'SELECT id FROM exams WHERE id = ?', c.exam_id))) throw new HttpError(404, 'That exam was not found.');
  if (c.kind === 'hub' && was.kind !== 'hub') {
    const key = c.preset || was.preset || presetKey(c.exam_type ?? was.exam_type);
    if (!c.preset && !was.preset) c.preset = key;
    for (const [k, v] of Object.entries(PRESETS[key])) if (c[k] == null && was[k] == null) c[k] = v;
  }
  if (c.status === 'done' && !('finished_at' in c)) c.finished_at = now();
  const keys = Object.keys(c);
  if (!keys.length) throw new HttpError(400, 'Nothing to change.');
  await run(env, `UPDATE sittings SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => c[k]), id);
  // Finished (Finish on a sitting stopped early): its held results go on the map.
  if (c.status === 'done' && was.status !== 'done') await hook('release', () => releaseSitting(env, MO, id));
  return json({ sitting: await first(env, 'SELECT * FROM sittings WHERE id = ?', id) });
}

export async function remove(request, env, ctx, { id }) {
  await getSitting(env, id);
  const sub = 'SELECT id FROM blocks WHERE sitting_id = ?';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM analyses WHERE block_id IN (${sub})`).bind(id),
    env.DB.prepare(`DELETE FROM transcripts WHERE block_id IN (${sub})`).bind(id),
    env.DB.prepare('DELETE FROM blocks WHERE sitting_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sittings WHERE id = ?').bind(id),
  ]);
  await hook('forget', () => forgetSitting(env, MO, id));
  return json({ ok: true });
}

// No question text here: the client gets questions from /api/exams/:id. Block state and transcript
// segments are spliced in raw (parsed for the client, never parsed here); analyses stay column-faithful
// (card_json etc. as JSON text).
export async function get(request, env, ctx, { id }) {
  const sitting = await getSitting(env, id);
  const [exam, blocks, analyses, transcripts] = await Promise.all([
    sitting.exam_id ? first(env, 'SELECT id, name, question_count, created_at FROM exams WHERE id = ?', sitting.exam_id) : null,
    all(env, 'SELECT * FROM blocks WHERE sitting_id = ? ORDER BY idx', id),
    all(env, 'SELECT a.* FROM analyses a JOIN blocks b ON b.id = a.block_id WHERE b.sitting_id = ? ORDER BY b.idx, a.q_index', id),
    all(env, 'SELECT t.* FROM transcripts t JOIN blocks b ON b.id = t.block_id WHERE b.sitting_id = ? ORDER BY b.idx, t.q_index', id),
  ]);
  const text = '{"sitting":' + JSON.stringify(sitting) +
    ',"exam_meta":' + JSON.stringify(exam || null) +
    ',"blocks":[' + blocks.map(b => rowJson(b, { state_json: 'state' })).join(',') + ']' +
    ',"analyses":[' + analyses.map(a => JSON.stringify(a)).join(',') + ']' +
    ',"transcripts":[' + transcripts.map(t => rowJson(t, { segments_json: 'segments', flags_json: 'flags' })).join(',') + ']}';
  return rawJson(text);
}
