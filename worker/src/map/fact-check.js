import { rules } from './rules.js';
import { parseCorrection } from './teach-memory.js';

export const WINDOW_MS = 24 * 3600_000, LESSONS_MAX = 8, CARDS_MAX = 20, CORRECTIONS_MAX = 10, REPLY_MAX = 7600, READ_MAX = 100;

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t || null; };
const all = async (env, sql, ...b) => { try { return (await env.DB.prepare(sql).bind(...b).all()).results || []; } catch (e) { if (noTable(e)) return []; throw e; } };

/** What the last 24 hours added for the fact check. */
export async function factCheckToday(env, user, { now = Date.now() } = {}) {
  const since = now - WINDOW_MS;
  const [lessons, corr, misses] = await Promise.all([
    all(env, `SELECT id, topic_id, topic_name, kind, status, goal, weak_spot, steps_json, card_id, card_note_id, card_action, ended_at FROM lessons
      WHERE user_id = ?1 AND status IN ('done','abandoned') AND ended_at >= ?2 ORDER BY ended_at DESC LIMIT ?3`, user, since, READ_MAX),
    all(env, `SELECT id, scope, scope_ref, note, evidence_json, source_ref, created_at FROM teach_memory
      WHERE user_id = ?1 AND tactic = 'other' AND note LIKE 'Correction:%' AND status != 'retired' AND created_at >= ?2 ORDER BY created_at DESC LIMIT ?3`, user, since, READ_MAX),
    // A card made for a miss in the last day: Anki note ids are their creation time in milliseconds.
    all(env, `SELECT id, label, topic_id, anki_note_ids_json FROM misses WHERE user_id = ?1 AND coalesce(held, 0) = 0 AND coalesce(anki_note_ids_json, '[]') NOT IN ('[]', '')
      AND EXISTS (SELECT 1 FROM json_each(misses.anki_note_ids_json) j WHERE CAST(j.value AS INTEGER) >= ?2) LIMIT ?3`, user, since, READ_MAX),
  ]);
  const more = { lessons: Math.max(0, lessons.length - LESSONS_MAX), corrections: Math.max(0, corr.length - CORRECTIONS_MAX) };
  lessons.splice(LESSONS_MAX);
  corr.splice(CORRECTIONS_MAX);
  const summaries = new Map(lessons.length ? (await all(env, `SELECT id, body FROM topic_notes WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    user, JSON.stringify(lessons.map(l => `ls_${l.id}`)))).map(r => [r.id.slice(3), r.body]) : []);
  const topicIds = [...new Set([...corr.map(c => c.scope_ref), ...misses.map(m => m.topic_id)].filter(Boolean))];
  const names = new Map(topicIds.length ? (await all(env, `SELECT id, name FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(topicIds))).map(t => [t.id, t.name]) : []);
  for (const l of lessons) if (l.topic_id && l.topic_name) names.set(l.topic_id, l.topic_name);

  const cards = [];
  const seen = new Set();
  const addCard = (c) => {
    const key = c.card_id ? `c${c.card_id}` : `n${c.note_id}`;
    if (seen.has(key) || (!c.card_id && !c.note_id)) return;
    seen.add(key);
    cards.push(c);
  };
  const corrections = corr.map(c => {
    const p = parseCorrection(c.note);
    const ev = parse(c.evidence_json, []).find(e => e && (e.card_id || e.note_id)) || null;
    const lessonId = /^lesson:/.test(c.source_ref || '') ? c.source_ref.slice(7) : null;
    return { id: c.id, topic_id: c.scope === 'topic' ? c.scope_ref : null, topic: names.get(c.scope_ref) || null, right: p.right, wrong: p.wrong, source: p.source,
      ...(lessonId ? { lesson_id: lessonId } : {}), ...(ev ? { card_id: ev.card_id || null, note_id: ev.note_id || null } : {}) };
  });
  // Cards a correction touched come first, with the reason.
  for (const c of corrections) if (c.card_id || c.note_id) addCard({ card_id: c.card_id || null, note_id: c.note_id || null, topic: c.topic, why: `A correction was logged in its lesson: ${cap(c.right, 120)}` });
  for (const l of lessons) if ((l.card_id || l.card_note_id) && ['added', 'edited_existing'].includes(l.card_action)) {
    addCard({ card_id: l.card_id || null, note_id: l.card_note_id || null, topic: l.topic_name || null, why: `${l.card_action === 'added' ? 'Made' : 'Edited'} in the lesson on ${l.topic_name || 'a topic'}` });
  }
  for (const m of misses) for (const n of parse(m.anki_note_ids_json, [])) if (Number(n) >= since) addCard({ card_id: null, note_id: Number(n), topic: names.get(m.topic_id) || null, why: `Made for the miss ${m.label || m.id}` });

  const out = {
    since: 'the last 24 hours',
    lessons: lessons.map(l => ({ id: l.id, topic_id: l.topic_id || null, topic: l.topic_name || null, kind: l.kind, goal: cap(l.goal, 200), weak_spot: cap(l.weak_spot, 200),
      summary: cap(summaries.get(l.id), 500), steps: parse(l.steps_json, []).map(s => s && s.title).filter(Boolean).slice(0, 6) })),
    cards: cards.slice(0, CARDS_MAX), corrections,
  };
  more.cards = Math.max(0, cards.length - CARDS_MAX);
  withMore(out, more);
  if (!out.lessons.length && !out.cards.length && !out.corrections.length) return { ...out, nothing: true, say: 'Nothing was taught, carded or corrected in the last 24 hours: skip the fact check and say so in the morning line.' };
  return out;
}

const plural = (n, w) => `${n} more ${n === 1 ? w : `${w}s`}`;
/** Sets today.more and its line from the counts left out ({lessons, cards, corrections}); none left out: neither. */
function withMore(today, more) {
  delete today.more; delete today.more_line;
  const parts = [['lessons', 'lesson'], ['cards', 'card'], ['corrections', 'correction']].filter(([k]) => more[k] > 0);
  if (!parts.length) return today;
  today.more = Object.fromEntries(parts.map(([k]) => [k, more[k]]));
  const words = parts.map(([k, w]) => plural(more[k], w));
  today.more_line = `And ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]}: check these first; hub_history {kinds: ["lesson"]} lists every lesson of the day.`;
  return today;
}

/** map_rules {part: 'fact_check'}: the steps and the work list, trimmed to fit (summaries, then lessons, cards, corrections),
 *  each item left out counted in today.more. */
export async function factCheckRules(env, user, { now = Date.now() } = {}) {
  const base = rules('fact_check');
  let today;
  try { today = await factCheckToday(env, user, { now }); } catch (e) { console.error('fact check list failed', e && e.message); today = { error: 'The list could not be read: check the lessons with hub_history {kinds: ["lesson"]} instead.' }; }
  const out = { ...base, today };
  const size = () => JSON.stringify(out).length;
  if (size() > REPLY_MAX && today.lessons) for (const l of today.lessons) l.summary = cap(l.summary, 200);
  // Then one item at a time from the end of a list, counted, until it fits (never cut silently by the tool's cap): cards
  // down to 10, lessons down to 4, then cards, corrections and lessons as far as needed.
  const more = { lessons: 0, cards: 0, corrections: 0, ...(today.more || {}) };
  for (const [k, keep] of [['cards', 10], ['lessons', 4], ['cards', 0], ['corrections', 0], ['lessons', 0]]) {
    while (size() > REPLY_MAX && Array.isArray(today[k]) && today[k].length > keep) { today[k].pop(); more[k]++; withMore(today, more); }
  }
  return out;
}
