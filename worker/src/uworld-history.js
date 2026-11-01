import { all } from './db.js';
import { trapLabel } from './map/habits.js';
import { MO } from './users.js';

const PER_TOPIC = 3, RULE_MAX = 140, DAY_MS = 86_400_000, BACK_DAYS = 120;
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const soft = p => p.catch(e => { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; });

/** {byQ: Map(q -> {topic, misses: [..], beliefs: [..]}), habits: [labels]} for the questions to judge. */
export async function historyFor(env, questions, { before = Date.now(), user = MO } = {}) {
  const labels = [...new Set(questions.map(q => String(q.topic || '').trim().toLowerCase()).filter(Boolean))];
  const qids = [...new Set(questions.map(q => q.uworld_id).filter(Boolean).map(String))];
  const out = { byQ: new Map(), habits: [] };
  const habitRows = await soft(all(env, `SELECT trap FROM habits WHERE user_id = ? AND status = 'active' ORDER BY n DESC LIMIT 6`, user));
  out.habits = habitRows.map(r => trapLabel(r.trap)).filter(Boolean);
  if (!labels.length && !qids.length) return out;
  const marks = a => a.map(() => '?').join(', ') || "''";
  const topics = labels.length ? await soft(all(env, `SELECT DISTINCT t.id, t.name, lower(t.name) AS k FROM topics t WHERE t.user_id = ? AND lower(t.name) IN (${marks(labels)})
    UNION SELECT DISTINCT t.id, t.name, lower(a.alias) AS k FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id
      WHERE a.user_id = ? AND a.status = 'active' AND lower(a.alias) IN (${marks(labels)})`, user, ...labels, user, ...labels)) : [];
  const ids = [...new Set(topics.map(t => t.id))];
  const since = before - BACK_DAYS * DAY_MS;
  const misses = ids.length || qids.length ? await soft(all(env, `SELECT topic_id, uw_qid, label, day, error_type, rule FROM misses
    WHERE user_id = ? AND held = 0 AND deleted_at IS NULL AND at < ? AND at >= ?
      AND (topic_id IN (${marks(ids)}) OR uw_qid IN (${marks(qids)})) ORDER BY at DESC LIMIT 200`, user, before, since, ...ids, ...qids)) : [];
  const beliefs = ids.length ? await soft(all(env, `SELECT topic_id, belief FROM misconceptions WHERE user_id = ? AND status IN ('open', 'targeted') AND topic_id IN (${marks(ids)})`, user, ...ids)) : [];
  for (const q of questions) {
    const k = String(q.topic || '').trim().toLowerCase();
    const mine = new Set(topics.filter(t => t.k === k).map(t => t.id));
    const m = misses.filter(x => mine.has(x.topic_id) || (q.uworld_id && String(x.uw_qid || '') === String(q.uworld_id))).slice(0, PER_TOPIC);
    const b = beliefs.filter(x => mine.has(x.topic_id)).map(x => cut(x.belief, 160)).filter(Boolean).slice(0, 2);
    if (m.length || b.length) out.byQ.set(q.q, { topic: q.topic || null, misses: m.map(x => ({ label: x.label, day: x.day, error_type: x.error_type, rule: cut(x.rule, RULE_MAX), same_question: !!(q.uworld_id && String(x.uw_qid || '') === String(q.uworld_id)) })), beliefs: b });
  }
  return out;
}

/** The history as lines for the judge's message, or [] when there is none. */
export function historyLines(h, questions) {
  if (!h) return [];
  const lines = [];
  for (const q of questions) {
    const x = h.byQ.get(q.q);
    if (!x) continue;
    const bits = x.misses.map(m => `${m.same_question ? 'this same question' : m.label || 'a miss'} on ${m.day}${m.error_type ? ` (${String(m.error_type).replace(/_/g, ' ')})` : ''}${m.rule ? `: ${m.rule}` : ''}`);
    for (const b of x.beliefs) bits.push(`open wrong belief: ${b}`);
    lines.push(`Q${q.q}${x.topic ? ` (${x.topic})` : ''}: ${bits.join('; ')}`);
  }
  if (h.habits.length) lines.push(`His active habits: ${h.habits.join('; ')}.`);
  return lines.length ? ['', 'His history (to spot repeats and name traps the way his map does; never a reason to call a question right or wrong):', ...lines] : [];
}
