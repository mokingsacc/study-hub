import { json, readJson, londonDay } from '../util.js';
import { applyChange, changeResponse } from './change.js';
import { noteJob } from '../job-log.js';
import { summaryOf } from './events.js';

export const LEVELS = Object.freeze({
  guess: { grade: 'again', word: 'Guess', means: "I'd be guessing: I don't know it" },
  lean: { grade: 'hard', word: 'Lean', means: "I'd have to think: shaky" },
  sure: { grade: 'good', word: 'Sure', means: "I'd get a question on this right" },
});
export const LEVEL_KEYS = Object.keys(LEVELS);
const GRADE_LEVEL = { again: 'guess', hard: 'lean', good: 'sure', easy: 'sure' };
export const PARTS = ['diagnose', 'manage'];
export const PART_WORD = { diagnose: 'Diagnose', manage: 'Manage' };
// The step a part's rating is tagged with (facets.js STEP_FACET puts it back in its part).
export const RATE_STEP = Object.freeze({ diagnose: 'recognise', manage: 'treat' });
// A pair's rating by link type: telling look-alikes apart, or the management a treated-by or side-effect link names.
export const PAIR_ASPECT = Object.freeze({ versus: { step: 'distinguish', aspect: 'apart', words: 'telling them apart' },
  treated_by: { step: 'treat', aspect: 'manage', words: 'the management' }, adverse_effect: { step: 'treat', aspect: 'manage', words: 'the management' } });
// Rated after Show answers: half its weight (the amount fsrs.js, weights.js and facets.js multiply by).
export const AFTER_REVEAL = 0.5;
export const KEY_PREFIX = 'self:';
export const KEEP_DAYS = 14;   // what topicDetail shows back (the latest per part and pair in this many days)

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** A row's level ('guess' | 'lean' | 'sure') from its stored grade, or null. */
export const levelOf = row => GRADE_LEVEL[String((row && row.rating) || '').toLowerCase()] || null;
export const keyOf = (topicId, what, day) => `${KEY_PREFIX}${topicId}:${what}:${day}`;

// ---------------------------------------------------------------- op self.rate

/**
 * Planner for op self.rate {topic_id, part | other, level, shown?}: one self_rating row (replacing today's for the same
 * part or pair), or its removal when level is null or the level already chosen today. Refuses a pair that is not a
 * look-alike, treated-by or side-effect link of the topic.
 */
export async function planSelfRate(env, user, args, ctx) {
  const a = isObj(args) ? args : {};
  const bad = Object.keys(a).find(k => !['topic_id', 'part', 'other', 'level', 'shown'].includes(k));
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  if (typeof a.topic_id !== 'string' || !ID.test(a.topic_id)) return { refuse: 'topic_id is the map id of the topic rated.', field: 'topic_id' };
  if ((a.part == null) === (a.other == null)) return { refuse: 'Rate one part (diagnose or manage) or one pair (other).', field: 'part' };
  if (a.part != null && !PARTS.includes(a.part)) return { refuse: 'part is diagnose or manage.', field: 'part' };
  if (a.other != null && (typeof a.other !== 'string' || !ID.test(a.other) || a.other === a.topic_id)) return { refuse: 'other is the map id of the linked topic.', field: 'other' };
  if (a.level != null && !LEVEL_KEYS.includes(a.level)) return { refuse: 'level is guess, lean or sure (or null to take it off).', field: 'level' };
  const now = ctx.now || Date.now();
  const day = londonDay(now);
  const t = await env.DB.prepare(`SELECT id, name, category_id, status FROM topics WHERE user_id = ? AND id = ?`).bind(user, a.topic_id).first();
  if (!t || t.status === 'merged' || t.status === 'retired') return { refuse: 'That topic is not on the map.', field: 'topic_id' };
  let pair = null;
  if (a.other != null) {
    const l = await env.DB.prepare(`SELECT k.type, o.name FROM links k JOIN topics o ON o.user_id = k.user_id AND o.id = ?3
      WHERE k.user_id = ?1 AND k.status IN ('active','proposed') AND ((k.from_id = ?2 AND k.to_id = ?3) OR (k.from_id = ?3 AND k.to_id = ?2))
      ORDER BY k.type = 'versus' DESC LIMIT 1`).bind(user, a.topic_id, a.other).first();
    const spec = l && PAIR_ASPECT[l.type];
    if (!spec) return { refuse: 'Only a look-alike, a treatment or a side effect of this topic can be rated as a pair.', field: 'other' };
    pair = { id: a.other, name: l.name, type: l.type, ...spec };
  }
  const what = pair ? pair.id : a.part;
  const obs_key = keyOf(t.id, what, day);
  const prev = await env.DB.prepare(`SELECT rating, detail_json FROM evidence WHERE user_id = ? AND obs_key = ? AND slot = 0`).bind(user, obs_key).first();
  const prevLevel = prev ? levelOf(prev) : null;
  const label = pair ? `${t.name} and ${pair.name}, ${pair.words}` : `${t.name} · ${PART_WORD[a.part]}`;
  // The change's own line (its summary names the batch); the evidence row's events carry what Undo puts back.
  const event = summary => ({ target_type: 'topic', target_id: t.id, topic_id: t.id, summary: summaryOf(summary), undoable: false });
  // Off: null, or a tap on the level already chosen today ("tap again" takes it back), before or after the answers.
  if (a.level == null || prevLevel === a.level) {
    if (!prev) return { noop: true, summary: 'Nothing rated there today.' };
    const summary = `Rating taken off: ${label}`;
    return { rows: [], events: [event(summary)], evidence: { remove: [{ obs_key, slot: 0 }] }, touched_topics: [t.id], count: 1, summary,
      reply: { rating: null, key: obs_key } };
  }
  const L = LEVELS[a.level];
  const shown = a.shown === true;
  const step = pair ? pair.step : RATE_STEP[a.part];
  const detail = { label: 'self-rating', step, level: a.level, ...(pair ? { other: pair.id, other_name: pair.name, aspect: pair.aspect } : { part: a.part }),
    ...(shown ? { shown: true } : {}) };
  const row = { obs_key, slot: 0, topic_id: t.id, category_id: t.category_id || null, kind: 'self_rating', rating: L.grade, amount: shown ? AFTER_REVEAL : 1,
    at: now, day, source: 'self', source_ref: what, created_by: ctx.actor, detail_json: JSON.stringify(detail) };
  const summary = `You rated ${label}: ${L.word}${shown ? ' (after seeing the answers)' : ''}`;
  return { rows: [], events: [event(summary)], evidence: { upsert: [row] }, touched_topics: [t.id], count: 1, summary,
    reply: { rating: { key: obs_key, level: a.level, word: L.word, shown, ...(pair ? { other: pair.id, aspect: pair.aspect } : { part: a.part }) }, replaced: !!prev } };
}

export const selfRateTier = (args, plan, ctx) => (ctx && ctx.actor === 'mo' ? 'free' : 'refused');

// POST /api/map/topic/:id/rating {part | other, level, shown}: one tap; the day's Recent activity line follows it.
export async function rateRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2000);
  const args = { topic_id: decodeURIComponent(String(params.id || '')) };
  for (const k of ['part', 'other', 'level', 'shown']) if (body[k] !== undefined) args[k] = body[k];
  if (args.level === undefined) args.level = null;
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'self.rate', args, via: 'api:POST /api/map/topic/:id/rating' });
  if (r && r.ok) await noteRatings(env, user, Date.now());
  else if (r && !r.refused && !r.needs_confirm) await noteJob(env, { job: 'self_rating', user, state: 'failed', detail: r.reason || 'not saved' });
  return changeResponse(r);
}

/** The day's ratings as counts: {parts, pairs, topics, after} (rows live now with today's key). */
export async function dayCounts(env, user, now = Date.now()) {
  const day = londonDay(now);
  const r = await env.DB.prepare(`SELECT count(*) AS n, count(DISTINCT topic_id) AS topics,
      sum(CASE WHEN json_extract(detail_json, '$.other') IS NOT NULL THEN 1 ELSE 0 END) AS pairs,
      sum(CASE WHEN json_extract(detail_json, '$.shown') = 1 THEN 1 ELSE 0 END) AS after
    FROM evidence WHERE user_id = ?1 AND kind = 'self_rating' AND obs_key LIKE 'self:%' AND day = ?2 AND held = 0`).bind(user, day).first();
  const n = Number(r && r.n) || 0, pairs = Number(r && r.pairs) || 0;
  return { parts: n - pairs, pairs, topics: Number(r && r.topics) || 0, after: Number(r && r.after) || 0 };
}

/** One Recent activity line a London day ("You rated 6 topic parts today"), its counts read again after every tap. */
export async function noteRatings(env, user, now = Date.now()) {
  try {
    const c = await dayCounts(env, user, now);
    return noteJob(env, { job: 'self_rating', user, key: `day:${londonDay(now)}`, at: now, state: 'ok', counts: c });
  } catch (e) {
    if (noTable(e)) return false;
    return noteJob(env, { job: 'self_rating', user, key: `day:${londonDay(now)}`, at: now, state: 'failed', detail: e });
  }
}

// ---------------------------------------------------------------- reads (topicDetail)

/** The statement topicDetail adds: this topic's ratings of the last KEEP_DAYS days, newest first. */
export const ratingsSql = `SELECT obs_key, day, at, rating, amount, detail_json FROM evidence_live WHERE user_id = ?1 AND topic_id = ?2 AND kind = 'self_rating'
  AND obs_key LIKE 'self:%' AND at >= ?3 ORDER BY at DESC LIMIT 40`;

/**
 * The latest rating per part and per pair (pure): {today, parts: {diagnose?, manage?}, pairs: {other_id: {...}}, levels},
 * each {level, word, day, at, today, shown, step, aspect?, other_name?}. levels: the words and meanings for the buttons.
 */
export function shapeRatings(rows, today) {
  const parts = {}, pairs = {};
  for (const r of rows || []) {
    const d = parse(r.detail_json, {}) || {};
    const level = levelOf(r);
    if (!level) continue;
    const one = { level, word: LEVELS[level].word, day: r.day, at: Number(r.at) || null, today: r.day === today, shown: !!d.shown, step: d.step || null };
    if (d.other) { if (!pairs[d.other]) pairs[d.other] = { ...one, aspect: d.aspect || null, other_name: d.other_name || null }; }
    else if (PARTS.includes(d.part) && !parts[d.part]) parts[d.part] = one;
  }
  return { today, parts, pairs, levels: LEVEL_KEYS.map(k => ({ key: k, word: LEVELS[k].word, means: LEVELS[k].means })) };
}

export function ratingsText(r) {
  if (!r) return null;
  const when = x => `${x.today ? 'today' : x.day}${x.shown ? ', after seeing the answers' : ''}`;
  const bits = PARTS.filter(p => r.parts && r.parts[p]).map(p => `${PART_WORD[p]} ${r.parts[p].word} (${when(r.parts[p])})`);
  for (const p of Object.values(r.pairs || {})) bits.push(`${p.other_name || 'a linked topic'}, ${p.aspect === 'manage' ? 'the management' : 'telling them apart'}: ${p.word} (${when(p)})`);
  return bits.length ? `His self-ratings (Guess / Lean / Sure; a light signal, never a score): ${bits.join('; ')}.` : null;
}
