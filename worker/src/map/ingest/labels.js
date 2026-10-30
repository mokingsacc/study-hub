import { londonDay, now as nowMs } from '../../util.js';
import { hubKey, hubLabel, confFromHub, releasable, SLOW_S } from './map-fields.js';
import { ingestAnalysis, placeTopics, lookups, writeQuestions } from './hub.js';

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
export const APPLY_MAX = 40;   // answers per call (a labelling call covers 20 questions; a form sat twice is 40)

/**
 * Answers on the given questions of one exam, onto the map. Returns {analyses, answers, held}.
 * sweep (labeller.js sweepLabels): every labelled question of the exam, so only answers not yet on the map are
 * done: none with a placed row, and none written since their label (that one was placed or queued by it).
 */
export async function applyLabels(env, user, examId, qIndexes, { sweep = false } = {}) {
  const want = [...new Set((qIndexes || []).map(Number).filter(Number.isInteger))];
  if (!want.length) return { analyses: 0, answers: 0 };
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`SELECT b.id, b.sitting_id, b.idx, b.q_from, b.q_to, b.started_at, b.state_json, s.name, s.status, s.exam_type
          FROM blocks b JOIN sittings s ON s.id = b.sitting_id WHERE s.exam_id = ? ORDER BY b.started_at, b.idx`).bind(examId),
      env.DB.prepare(`SELECT block_id, q_index, topic, status FROM analyses WHERE block_id IN (SELECT b.id FROM blocks b JOIN sittings s ON s.id = b.sitting_id
          WHERE s.exam_id = ?) AND q_index IN (SELECT value FROM json_each(?))`).bind(examId, JSON.stringify(want)),
      env.DB.prepare(`SELECT q_index, topic_raw, system_raw, topic_id, labelled_at FROM exam_topics WHERE user_id = ? AND exam_id = ? AND status = 'labelled'
          AND q_index IN (SELECT value FROM json_each(?))`).bind(user, examId, JSON.stringify(want)),
      env.DB.prepare(`SELECT CAST(j.key AS INTEGER) AS i, json_extract(j.value, '$.answer') AS answer, json_extract(j.value, '$.num') AS num
          FROM exams e, json_each(e.questions_json) j WHERE e.id = ? AND CAST(j.key AS INTEGER) IN (SELECT value FROM json_each(?))`).bind(examId, JSON.stringify(want)),
    ]);
  } catch (e) { if (noTable(e)) return { analyses: 0, answers: 0 }; throw e; }
  const blocks = res[0].results || [];
  const analysed = new Map((res[1].results || []).map(a => [`${a.block_id}:${a.q_index}`, a]));
  const labels = new Map((res[2].results || []).map(l => [Number(l.q_index), l]));
  const key = new Map((res[3].results || []).map(r => [Number(r.i), r]));
  let analyses = 0;
  const items = [], redo = [];
  for (const b of blocks) {
    const st = parse(b.state_json, {});
    const ans = st.ans || {};
    for (const q of want) {
      if (q < Number(b.q_from) || q > Number(b.q_to)) continue;
      const label = labels.get(q);
      if (!label) continue;
      const a = analysed.get(`${b.id}:${q}`);
      if (a) {
        // The judge named a topic: its own ingest placed it already. None: ingest it again, now with the label.
        if (!(typeof a.topic === 'string' && a.topic.trim())) redo.push({ b, q, label, a });
        continue;
      }
      const picked = ans[q] ?? ans[String(q)];
      const k = key.get(q);
      if (!picked || !k || !k.answer) continue;   // not answered, or no key to mark it by
      const secs = Number((st.time_on_q || {})[q]);
      const timeS = Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
      const at = (Number(b.started_at) || nowMs()) + (q - Number(b.q_from)) * 1000;
      items.push({
        b, q, label, at,
        answer: { result: String(picked).toUpperCase() === String(k.answer).toUpperCase() ? 'right' : 'wrong', verdict: null,
          confidence: confFromHub((st.conf || {})[q]), error_type: null, flaw_kind: null, time_s: timeS, others_pct: null,
          label: hubLabel(b.name, k.num ?? q + 1, q, b.idx), topic: label.topic_raw, system: label.system_raw, slow: timeS > SLOW_S ? 1 : 0 },
      });
    }
  }
  if (!items.length && !redo.length) return { analyses, answers: 0 };
  // Answers that already have a placed row are left alone (in a sweep, also one written since its label); the rest
  // are placed by the label (its topic id when the labeller placed it, else its words) and written in one commit.
  const keys = [...items, ...redo].map(it => hubKey(it.b.id, it.q));
  const ev = await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))')
    .bind(user, JSON.stringify(keys)).all();
  const evBy = new Map((ev.results || []).map(x => [x.obs_key, x]));
  const open = it => {
    const e = evBy.get(hubKey(it.b.id, it.q));
    if (!e) return true;
    if (e.topic_id) return false;
    return !sweep || !(Number(e.updated_at) >= Number(it.label.labelled_at));
  };
  // The judge named no topic: ingest it again, now with the label (ingestAnalysis falls back to it).
  for (const it of redo) {
    if (analyses >= APPLY_MAX) break;
    if (sweep && (!open(it) || it.a.status !== 'done')) continue;   // a sweep never retries an analysis still running
    await ingestAnalysis(env, user, it.b.id, it.q);
    analyses++;
  }
  const todo = items.filter(open).slice(0, APPLY_MAX);
  if (!todo.length) return { analyses, answers: 0 };
  const places = await placeTopics(env, user, todo.map(it => ({ texts: [it.label.topic_raw], system: it.label.system_raw, topic_id: it.label.topic_id || null,
    source: 'hub', source_ref: `labeller:${examId}:q${it.q}` })));
  const look = await lookups(env, user, { topicIds: places.map(p => p && p.topic_id), systems: todo.map(it => it.label.system_raw) });
  const rows = todo.map((it, i) => ({
    key: hubKey(it.b.id, it.q), base: null, answer: it.answer, existing: null, place: places[i] || { topic_id: null }, held: !releasable(it.b) ? 1 : 0,
    at: it.at, day: londonDay(it.at), evidence: evBy.get(hubKey(it.b.id, it.q)) || null, source_ref: `block:${it.b.id}:q${it.q}`,
  }));
  // writeQuestions reads the sitting from opts; rows from different sittings are written one sitting at a time.
  const bySitting = new Map();
  for (const r of rows) {
    const sid = todo[rows.indexOf(r)].b.sitting_id;
    if (!bySitting.has(sid)) bySitting.set(sid, []);
    bySitting.get(sid).push(r);
  }
  for (const [sid, list] of bySitting) await writeQuestions(env, user, list, look, { via: 'labeller', source: 'hub', sitting_id: sid }, nowMs());
  return { analyses, answers: rows.length, held: rows.filter(r => r.held).length };
}
