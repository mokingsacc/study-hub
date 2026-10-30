import { objectivesFor, isQid } from '../library/objectives.js';

const UW_LABEL = /\bUW\s*(\d{3,6})\b/;

export function outcomeOf(row) {
  const r = String(row.result || '').toLowerCase(), v = String(row.verdict || '').toLowerCase(), c = String(row.confidence || '').toLowerCase();
  if (r === 'wrong' || r === 'omitted' || v === 'wrong') return 'missed';
  if (v === 'right_flawed' || row.flaw_kind || c === 'guess' || c === 'lean') return 'shaky';
  if (r === 'right' || v === 'sound') return 'held';
  return null;
}

export function qidOf(row) {
  let label = '';
  try { label = String((JSON.parse(row.detail_json || '{}') || {}).label || ''); } catch (e) { /* not JSON */ }
  const m = UW_LABEL.exec(label);
  return m && isQid(m[1]) ? m[1] : null;
}

export async function topicObjectives(env, user, topicId, { limit = 8 } = {}) {
  if (!topicId) return [];
  const rows = (await env.DB.prepare(`SELECT day, at, result, verdict, confidence, flaw_kind, detail_json FROM evidence
    WHERE user_id = ? AND topic_id = ? AND slot = 0 AND kind = 'question' AND detail_json LIKE '%UW %' ORDER BY at DESC LIMIT 60`)
    .bind(user, topicId).all()).results || [];
  const seen = new Map();
  for (const r of rows) {
    const qid = qidOf(r), outcome = outcomeOf(r);
    if (qid && outcome && !seen.has(qid)) seen.set(qid, { qid, day: r.day, outcome });
  }
  if (!seen.size) return [];
  const objs = await objectivesFor(env, user, [...seen.keys()]).catch(() => ({}));
  const rank = { missed: 0, shaky: 1, held: 2 };
  return [...seen.values()].map(x => ({ ...x, objective: (objs[x.qid] && objs[x.qid].text) || null }))
    .sort((a, b) => rank[a.outcome] - rank[b.outcome] || String(b.day).localeCompare(String(a.day)))
    .slice(0, limit);
}
