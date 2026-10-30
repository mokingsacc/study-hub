// Blocks: autosaved exam state per block; End Block re-scores from the key on the server.
import { HttpError, json, readJson, int, uuid, now } from './util.js';
import { all, first, run, getSitting, getBlock } from './db.js';
import { MO } from './users.js';
import { releaseSitting, hook } from './map/ingest/hub.js';

const MAX_STATE = 2_000_000;

function checkState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new HttpError(400, 'The block state is missing.');
  const text = JSON.stringify(state);
  if (text.length > MAX_STATE) throw new HttpError(413, 'The block state is too large to save.');
  return text;
}

export async function upsert(request, env) {
  const body = await readJson(request, MAX_STATE + 10_000);
  const sittingId = String(body.sitting_id || '');
  if (!sittingId) throw new HttpError(400, 'Please give the sitting for this block.');
  const sitting = await getSitting(env, sittingId);
  const idx = int(body.idx, 'Block number', { min: 0, max: 100, optional: false });
  const qFrom = int(body.q_from, 'First question', { min: 0, optional: false });
  const qTo = int(body.q_to, 'Last question', { min: 0, optional: false });
  if (qTo < qFrom) throw new HttpError(400, 'The last question comes before the first one.');
  if (sitting.exam_id) {
    const exam = await first(env, 'SELECT question_count FROM exams WHERE id = ?', sitting.exam_id);
    if (exam && qTo >= exam.question_count) throw new HttpError(400, 'That block runs past the end of the exam.');
  }
  const startedAt = int(body.started_at, 'started_at', { min: 0 });
  const state = checkState(body.state);
  // A block that has ended is final: a late autosave must not reopen or change it.
  const ended = await first(env, 'SELECT id FROM blocks WHERE sitting_id = ? AND idx = ? AND ended_at IS NOT NULL', sittingId, idx);
  if (ended) return json({ id: ended.id, ended: true });
  const row = await first(env,
    `INSERT INTO blocks (id, sitting_id, idx, q_from, q_to, state_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sitting_id, idx) DO UPDATE SET q_from = excluded.q_from, q_to = excluded.q_to, state_json = excluded.state_json,
       started_at = COALESCE(blocks.started_at, excluded.started_at)
       WHERE blocks.ended_at IS NULL
     RETURNING id`,
    uuid(), sittingId, idx, qFrom, qTo, state, startedAt ?? now());
  if (!row) { // ended between the check and the write
    const b = await first(env, 'SELECT id FROM blocks WHERE sitting_id = ? AND idx = ?', sittingId, idx);
    return json({ id: b && b.id, ended: true });
  }
  if (sitting.status === 'scheduled') await run(env, "UPDATE sittings SET status = 'in_progress' WHERE id = ? AND status = 'scheduled'", sittingId);
  return json({ id: row.id });
}

// Score q_from..q_to (inclusive) against the key. D1 walks the questions JSON; the Worker only sees letters.
export async function scoreBlock(env, examId, block, ans) {
  const rows = await all(env,
    `SELECT CAST(j.key AS INTEGER) AS k, json_extract(j.value, '$.answer') AS answer FROM exams e, json_each(e.questions_json) j
     WHERE e.id = ? AND CAST(j.key AS INTEGER) BETWEEN ? AND ?`, examId, block.q_from, block.q_to);
  let correct = 0, scored = 0;
  for (const r of rows) {
    if (!r.answer) continue;
    scored++;
    const picked = ans[r.k] ?? ans[String(r.k)];
    if (picked && String(picked).toUpperCase() === String(r.answer).toUpperCase()) correct++;
  }
  return { correct, scored };
}

export async function end(request, env, ctx, { id }) {
  const block = await getBlock(env, id);
  const body = await readJson(request, MAX_STATE + 10_000);
  // Ending twice (a retry after a lost reply, or a second tab) returns the stored result and changes nothing.
  if (block.ended_at != null) return json({ correct: block.correct, scored: block.scored, ended: true });
  const state = body.state && typeof body.state === 'object' ? body.state : null;
  const stateText = state ? checkState(state) : block.state_json;
  const ans = (state || JSON.parse(block.state_json || '{}')).ans || {};
  const sitting = await getSitting(env, block.sitting_id);
  if (!sitting.exam_id) throw new HttpError(400, 'This sitting has no questions in the hub to score.');
  const { correct, scored } = await scoreBlock(env, sitting.exam_id, block, ans);
  const t = now();
  const done = await run(env, 'UPDATE blocks SET state_json = ?, ended_at = ?, correct = ?, scored = ? WHERE id = ? AND ended_at IS NULL', stateText, t, correct, scored, id);
  if (!done.meta || !done.meta.changes) { // ended by another request in the meantime
    const b = await getBlock(env, id);
    return json({ correct: b.correct, scored: b.scored, ended: true });
  }

  // Running score for the sitting; the block holding the last question ends the sitting.
  const [tot, exam] = await Promise.all([
    first(env, 'SELECT sum(correct) AS c, sum(scored) AS s FROM blocks WHERE sitting_id = ? AND ended_at IS NOT NULL', sitting.id),
    first(env, 'SELECT question_count FROM exams WHERE id = ?', sitting.exam_id),
  ]);
  const pct = tot && tot.s ? Math.round((tot.c / tot.s) * 1000) / 10 : null;
  const last = exam && block.q_to >= exam.question_count - 1;
  if (last) {
    await run(env, "UPDATE sittings SET score_pct = ?, status = 'done', finished_at = COALESCE(finished_at, ?) WHERE id = ?", pct, t, sitting.id);
    // The sitting has ended: its held results go on the map.
    if (sitting.status !== 'done') await hook('release', () => releaseSitting(env, MO, sitting.id));
  } else {
    await run(env, "UPDATE sittings SET score_pct = ?, status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END WHERE id = ?", pct, sitting.id);
  }
  return json({ correct, scored });
}
