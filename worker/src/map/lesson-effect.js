import { detailOf } from './weights.js';

export const EFFECT = { next: 5, rows_max: 600 };
const RATING = { again: 'not', '1': 'not', hard: 'shaky', '2': 'shaky', good: 'stuck', '3': 'stuck', easy: 'stuck', '4': 'stuck' };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const lower = v => String(v ?? '').toLowerCase();
const pct = x => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A card review row's word (pure): stuck, shaky or not, or null when it has no rating. */
export function ratingWord(row) {
  if (!row) return null;
  const d = detailOf(row);
  return RATING[lower(row.rating)] || RATING[String(row.amount ?? '')] || RATING[lower(d.rating)] || null;
}

/**
 * One lesson's effectiveness (pure). lesson: its row (ended_at, viva_before, viva_after, viva_json); rows: evidence rows
 * on its topic (card_review and question; any order, any time: those after the lesson are taken, the first EFFECT.next
 * of each). Returns {viva?: {before, after, change, headings}, cards?: {stuck, shaky, not, n}, answers?: {right, n},
 * line} or null when there is nothing to say yet.
 */
export function effectOf(lesson, rows = []) {
  if (!lesson) return null;
  const end = Number(lesson.ended_at) || 0;
  const out = {};
  const vj = parse(lesson.viva_json, null) || {};
  if (lesson.viva_before != null || lesson.viva_after != null || vj.before || vj.after) {
    out.viva = { before: pct(lesson.viva_before), after: pct(lesson.viva_after), ...(vj.change ? { change: vj.change } : {}),
      ...(vj.before || vj.after ? { headings: { ...(vj.before ? { before: vj.before } : {}), ...(vj.after ? { after: vj.after } : {}) } } : {}) };
  }
  if (end) {
    const later = (rows || []).filter(r => r && Number(r.at) > end && Number(r.held || 0) !== 1 && Number(r.slot || 0) === 0).sort((a, b) => Number(a.at) - Number(b.at));
    const reviews = later.filter(r => r.kind === 'card_review').map(ratingWord).filter(Boolean).slice(0, EFFECT.next);
    if (reviews.length) out.cards = { stuck: reviews.filter(w => w === 'stuck').length, shaky: reviews.filter(w => w === 'shaky').length, not: reviews.filter(w => w === 'not').length, n: reviews.length };
    const answers = later.filter(r => r.kind === 'question' && ['right', 'wrong', 'flawed', 'omitted'].includes(lower(r.result))).slice(0, EFFECT.next);
    if (answers.length) out.answers = { right: answers.filter(r => lower(r.result) === 'right').length, n: answers.length };
  }
  if (!out.viva && !out.cards && !out.answers) return null;
  out.line = effectLine(out);
  return out;
}

/** The effect in one plain line (pure): "Viva 35% to 80% (Manage: missing to held). Cards since: 3 of 4 stuck. Questions since: 2 of 2 right." */
export function effectLine(e) {
  const bits = [];
  if (e.viva) {
    const v = e.viva;
    if (v.before != null && v.after != null) bits.push(`Viva ${v.before}% to ${v.after}%${v.change ? ` (${v.change})` : ''}.`);
    else if (v.after != null) bits.push(`Closing viva ${v.after}%.`);
    else if (v.before != null) bits.push(`Opening viva ${v.before}%, no closing viva.`);
  }
  if (e.cards) bits.push(`Cards since: ${e.cards.stuck} of ${e.cards.n} stuck${e.cards.not ? `, ${e.cards.not} again` : ''}.`);
  if (e.answers) bits.push(`Questions since: ${e.answers.right} of ${plural(e.answers.n, 'question')} right.`);
  return bits.join(' ') || null;
}

/**
 * The effects of a list of lessons (one statement for all their topics' card reviews and question answers since the
 * oldest of them). Returns Map(lesson id -> effect | null). Never throws: a read that fails leaves the viva part only.
 */
export async function lessonEffects(env, user, lessons) {
  const list = (lessons || []).filter(l => l && l.id);
  const out = new Map();
  const topics = [...new Set(list.map(l => l.topic_id).filter(Boolean))];
  const since = Math.min(...list.map(l => Number(l.ended_at) || Infinity));
  let rows = [];
  if (topics.length && Number.isFinite(since)) {
    try {
      rows = (await env.DB.prepare(`SELECT topic_id, kind, result, rating, amount, detail_json, at, slot, held FROM evidence_live WHERE user_id = ?1
          AND topic_id IN (SELECT value FROM json_each(?2)) AND kind IN ('card_review', 'question') AND at > ?3 ORDER BY at LIMIT ${EFFECT.rows_max}`)
        .bind(user, JSON.stringify(topics), since).all()).results || [];
    } catch (e) {
      if (!/no such (table|column)/i.test(String(e && e.message))) console.error('lesson effects not read', e && e.message);
    }
  }
  for (const l of list) out.set(l.id, effectOf(l, rows.filter(r => r.topic_id === l.topic_id)));
  return out;
}
