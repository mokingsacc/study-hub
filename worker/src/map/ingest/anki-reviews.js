import { now as nowMs, londonDay } from '../../util.js';
import { ankiCall } from '../../anki.js';
import { norm } from '../../../../public/js/shared/names.js';
import { fetchAliases, plan, decide, ACCEPT } from '../resolve.js';
import { reviewEvidence, mergeReviewRow, reviewChanged, MAX_TOPICS_PER_CARD } from '../cards.js';
import { ankiWeights } from '../fsrs.js';
import { commit } from './hub.js';
import { jobBudget } from './anki.js';
import { countingEnv } from '../d1-count.js';
import { closeFromReviews } from '../retests.js';
import { noteJob } from '../../job-log.js';

export const SOURCE = 'anki.reviews', FSRS_SOURCE = 'anki.fsrs';
export const DAY_MS = 86_400_000;
export const PAGE = 500, PAGES_PER_RUN = 4, BACKFILL_DAYS = 60, CALL_MS = 10_000, RUN_MS = 25_000, PAGE_QUERIES = 12;
export const STATS_PER_CALL = 200, STATS_CALL_MS = 10_000;
// A server without the tools (before its release) is asked again hourly, so the reviews start within the hour it ships.
export const MISSING_RETRY_MS = 3600_000, FSRS_EVERY_MS = 24 * 3600_000;
export const COUNTED_TYPES = ['review', 'relearn', 'filtered'];
// At most this many topics a card is linked to by its own words (its answer's bold words, its tag leaves), and at most
// this many of its tag leaves are tried (the server sends every tag's last segment first, the most specific words).
export const WORD_TOPICS_MAX = 2, LEAVES_TRIED = 40;
// Tag leaves that name a subject, a resource or a deck's housekeeping, never a topic.
export const LEAF_STOP = new Set(['pathology', 'pharmacology', 'physiology', 'microbiology', 'immunology', 'anatomy', 'biochemistry',
  'genetics', 'embryology', 'histology', 'clinical', 'general', 'basics', 'extra', 'other', 'high yield', 'highyield', 'step 1', 'step 2',
  'only step 2', 'only step2', 'only step 1', 'no dupe', 'shelf', 'uworld', 'amboss', 'nbme', 'first aid', 'firstaid', 'boards and beyond',
  'ak other', 'ak step2 v12', 'ak step1 v12', 'surgery', 'medicine', 'pediatric', 'psychiatry', 'neurology', 'cardiology', 'obgyn',
  'obstetric', 'gynecology', 'internal medicine', 'family medicine', 'emergency medicine', 'diagnosis', 'treatment', 'management']);

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const missingTool = e => /unknown tool/i.test(String(e && e.message));
const json = v => JSON.stringify([...new Set(v)]);
const parse = s => { try { const o = typeof s === 'string' ? JSON.parse(s) : s; return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

export function countedReviews(list) {
  const out = [];
  for (const r of list || []) {
    const ease = Number(r && r.ease), at = Number(r && r.review_id), card = Number(r && r.card_id);
    if (!(ease >= 1 && ease <= 4) || !Number.isSafeInteger(at) || !Number.isSafeInteger(card) || card <= 0) continue;
    if (!COUNTED_TYPES.includes(String(r.type))) continue;
    out.push({ review_id: at, card_id: card, note_id: Number.isSafeInteger(Number(r.note_id)) ? Number(r.note_id) : null, ease, at,
      day: londonDay(at), type: String(r.type), ms: Number.isFinite(Number(r.time_ms)) ? Number(r.time_ms) : null,
      by: r.source === 'voice' ? 'voice' : null, parts: Array.isArray(r.parts) && r.parts.length ? r.parts.slice(0, 8) : null,
      source: r.source === 'voice' ? 'anki_voice' : 'anki' });
  }
  return out;
}

/** One review per card and day (pure): the lowest ease, the earliest time; the rest of its facts from that review. */
export function cardDays(reviews) {
  const by = new Map();
  for (const r of reviews) {
    const k = `${r.card_id}|${r.day}`;
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...r }); continue; }
    const worse = r.ease < prev.ease ? r : prev;
    by.set(k, { ...worse, at: Math.min(prev.at, r.at), note_id: prev.note_id ?? r.note_id });
  }
  return [...by.values()];
}

export function wordPlans(card, cache = new Map()) {
  const out = [];
  const planOf = (text, exact) => {
    const k = `${exact ? 1 : 0}|${text}`;
    if (!cache.has(k)) cache.set(k, plan([text], { exact }));
    return cache.get(k);
  };
  for (const t of (card.answer_terms || []).slice(0, 3)) if (norm(t).length >= 3) out.push({ plan: planOf(t, false), exact: false });
  for (const l of (card.tag_leaves || []).slice(0, LEAVES_TRIED)) {
    const k = norm(l);
    if (k.length >= 3 && !LEAF_STOP.has(k)) out.push({ plan: planOf(l, true), exact: true });
  }
  return out;
}

/**
 * The topics a card names in its own words (pure): each word decided as the resolver decides a miss's (exact name 1.0,
 * a part 0.9, a span 0.85), placed at ACCEPT or above, in the order wordPlans gives; a word whose parts point at two
 * topics names none. data: fetchAliases' {byKey, prefix}. At most WORD_TOPICS_MAX.
 */
export function wordTopics(card, data, cache = new Map()) {
  const topics = [];
  for (const w of wordPlans(card, cache)) {
    const d = decide(w.plan, data, null, { exact: w.exact });
    if (!d || !d.topic_id || (d.confidence != null && d.confidence < ACCEPT) || topics.includes(d.topic_id)) continue;
    topics.push(d.topic_id);
    if (topics.length >= WORD_TOPICS_MAX) break;
  }
  return topics;
}

// ---------------------------------------------------------------- the job

/**
 * anki.reviews: one run (cursor: the stored sync_state cursor). Returns {reviews, counted, rows, linked, unplaced,
 * pages, cursor, more} or {skipped, cursor, next_at} when the server has no card_reviews yet.
 */
export async function ankiReviews(env, user, cursorText, { now = nowMs() } = {}) {
  const st = parse(cursorText);
  const budget = jobBudget(env);
  const { env: cenv, counter } = countingEnv(env);
  const out = { reviews: 0, counted: 0, rows: 0, linked: 0, unplaced: 0, pages: 0 };
  let cursor = st.c || null, epoch = st.epoch || null, more = false;
  // Caught up: the first pass (the 60-day backfill) is done. From then on a card placed for the first time brings its own
  // last 60 days (ingestReviews' history), which the backfill already read for everything else.
  const caughtUp = Number(st.caught_up) === 1;
  const start = nowMs();
  for (let i = 0; i < PAGES_PER_RUN; i++) {
    const args = cursor ? { cursor, limit: PAGE } : { after_review_id: now - BACKFILL_DAYS * DAY_MS, limit: PAGE };
    let page;
    try {
      page = await ankiCall(env, 'card_reviews', args, { timeoutMs: CALL_MS });
    } catch (e) {
      if (missingTool(e)) return { skipped: 'the Anki server has no card_reviews yet', cursor: cursorText ?? null, next_at: now + MISSING_RETRY_MS };
      if (out.pages) break;   // what this run already mirrored stays; the cursor below is the last page done
      throw e;
    }
    if (page.epoch && epoch && page.epoch !== epoch) {
      // The collection was replaced (a full sync renumbers its log): start again from 60 days back. Every review keeps
      // its key, so nothing counts twice.
      console.log(JSON.stringify({ anki_reviews_restart: { user, from: epoch, to: page.epoch } }));
      return { ...out, restarted: true, cursor: JSON.stringify({ epoch: page.epoch, more: 1 }), more: true };
    }
    epoch = page.epoch || epoch;
    if (i === 0 && page.hub_gaps) await noteVoiceGaps(env, user, page.hub_gaps, now);
    const list = [...(page.reviews || []), ...(page.more ? [] : page.unsynced || [])];
    let r;
    try {
      r = await ingestReviews(cenv, user, list, { now, history: caughtUp });
    } catch (e) {
      if (out.pages) break;   // the pages before stay done; this one is read again next run
      throw e;
    }
    for (const k of Object.keys(r)) out[k] = (out[k] || 0) + r[k];
    out.reviews += list.length;
    out.pages++;
    cursor = page.cursor || cursor;
    more = !!page.more;
    if (!more || nowMs() - start > RUN_MS || (budget != null && counter.n + PAGE_QUERIES > budget)) break;
  }
  return { ...out, cursor: JSON.stringify({ c: cursor, epoch, more: more ? 1 : 0, caught_up: caughtUp || !more ? 1 : 0 }), more };
}

const noteVoiceGaps = (env, user, st, now) => {
  const err = st.last_error;
  if (st.on === false) return noteJob(env, { job: 'anki_voice_gaps', user, key: `${londonDay(now)}:off`, ref: 'off', state: 'held', at: now });
  const stuck = err && Number(st.pending) > 0 && !(Number(st.last_ok_at) > Number(err.at));
  return stuck ? noteJob(env, { job: 'anki_voice_gaps', user, key: `${londonDay(now)}:failed`, ref: 'failed', state: 'failed', at: now,
    counts: { pending: Number(st.pending) || 0, kind: String(err.kind || 'down').slice(0, 12), status: String(err.status ?? '') } }) : null;
};

/**
 * Reviews (card_reviews rows) onto the map, in one commit. history: a card linked here for the first time also brings
 * its own reviews of the last 60 days (card_reviews {card_ids}), which went by while it had no topic. Returns {counted,
 * rows, linked, unplaced, history}.
 */
export async function ingestReviews(env, user, list, { now = nowMs(), history = false } = {}) {
  const rt = await closeFromReviews(env, user, list, { now });
  let counted = cardDays(countedReviews(rt.cards.size ? list.filter(r => !rt.cards.has(Number(r && r.card_id))) : list));
  const res = { counted: 0, rows: 0, linked: 0, unplaced: 0, ...(rt.closed ? { retests: rt.closed } : {}) };
  if (!counted.length) return res;
  res.counted = counted.length;
  const cards = [...new Set(counted.map(r => r.card_id))];
  const notes = [...new Set(counted.map(r => r.note_id).filter(Boolean))];
  const keys = [...new Set(counted.map(r => `cardrev:${r.card_id}:${r.day}`))];
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let links, removed, byMiss, byLesson, stored;
  try {
    [links, removed, byMiss, byLesson, stored] = await env.DB.batch([
      q(`SELECT ct.card_id, ct.topic_id FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id AND t.status IN ('proposed', 'confirmed')
         WHERE ct.user_id = ?1 AND ct.strong = 1 AND ct.removed_at IS NULL AND ct.card_id IN (SELECT value FROM json_each(?2))
         ORDER BY ct.card_id, ct.created_at, ct.topic_id`, user, json(cards)),
      q(`SELECT card_id, topic_id FROM card_topics WHERE user_id = ?1 AND removed_at IS NOT NULL AND card_id IN (SELECT value FROM json_each(?2))`, user, json(cards)),
      q(`SELECT DISTINCT CAST(j.value AS INTEGER) AS note_id, m.topic_id FROM misses m, json_each(m.anki_note_ids_json) j
         WHERE m.user_id = ?1 AND m.topic_id IS NOT NULL AND m.deleted_at IS NULL AND m.held = 0
           AND CAST(j.value AS INTEGER) IN (SELECT value FROM json_each(?2)) ORDER BY m.topic_id`, user, json(notes)),
      q(`SELECT card_id, card_note_id, topic_id FROM lessons WHERE user_id = ?1 AND topic_id IS NOT NULL
         AND (card_id IN (SELECT value FROM json_each(?2)) OR card_note_id IN (SELECT value FROM json_each(?3)))`, user, json(cards), json(notes)),
      q(`SELECT * FROM evidence WHERE user_id = ?1 AND obs_key IN (SELECT value FROM json_each(?2))`, user, json(keys)),
    ]);
  } catch (e) {
    if (noTable(e)) return { ...res, skipped: 1 };
    throw e;
  }
  const topicsOf = new Map();
  const push = (card, topic) => { if (!topicsOf.has(card)) topicsOf.set(card, []); const l = topicsOf.get(card); if (!l.includes(topic)) l.push(topic); };
  for (const r of links.results || []) push(Number(r.card_id), r.topic_id);
  const off = new Set((removed.results || []).map(r => `${r.card_id}|${r.topic_id}`));
  const noteOf = new Map(counted.filter(r => r.note_id).map(r => [r.card_id, r.note_id]));
  const missTopics = new Map(), lessonTopics = new Map();
  for (const r of byMiss.results || []) { const k = Number(r.note_id); if (!missTopics.has(k)) missTopics.set(k, []); missTopics.get(k).push(r.topic_id); }
  for (const r of byLesson.results || []) for (const k of [Number(r.card_id), Number(r.card_note_id)]) if (k) { if (!lessonTopics.has(k)) lessonTopics.set(k, []); lessonTopics.get(k).push(r.topic_id); }

  // Cards with no strong link yet: their miss's or lesson's topic, else the topics their own words name.
  const newLinks = [];
  const link = (card, topic, match) => {
    if (off.has(`${card}|${topic}`) || (topicsOf.get(card) || []).includes(topic)) return;
    push(card, topic);
    newLinks.push({ card_id: card, topic_id: topic, match, strong: 1, created_at: now });
  };
  const unlinked = cards.filter(c => !(topicsOf.get(c) || []).length);
  const stillOpen = [];
  for (const c of unlinked) {
    const note = noteOf.get(c);
    const fromMiss = [...new Set(missTopics.get(note) || [])];
    const fromLesson = [...new Set([...(lessonTopics.get(c) || []), ...(lessonTopics.get(note) || [])])];
    for (const t of fromMiss.slice(0, MAX_TOPICS_PER_CARD)) link(c, t, 'miss');
    for (const t of fromLesson.slice(0, MAX_TOPICS_PER_CARD)) link(c, t, 'claude');
    if (!(topicsOf.get(c) || []).length) stillOpen.push(c);
  }
  if (stillOpen.length) {
    stillOpen.sort((a, b) => a - b);
    const words = await cardWords(env, stillOpen);
    if (words.size) {
      // Every word's keys in one read, as placeTopics reads a page of misses (no prefix reads: a card's words are whole).
      const plans = new Map();
      const keys = [...new Set([...words.values()].flatMap(w => wordPlans(w, plans).flatMap(x => x.plan.keys)))];
      const data = keys.length ? await fetchAliases(env, user, keys) : { byKey: new Map(), prefix: new Map() };
      for (const c of stillOpen) for (const t of wordTopics(words.get(c) || {}, data, plans)) link(c, t, 'search');
    }
  }
  res.linked = newLinks.length;
  const storedBy = new Map((stored.results || []).map(r => [`${r.obs_key}#${Number(r.slot) || 0}`, r]));
  if (history && newLinks.length) {
    const past = await cardHistory(env, [...new Set(newLinks.map(l => l.card_id))], now);
    if (past.length) {
      counted = cardDays([...counted, ...countedReviews(past)]);
      res.history = past.length;
      const extra = [...new Set(counted.map(r => `cardrev:${r.card_id}:${r.day}`))].filter(k => !keys.includes(k));
      if (extra.length) {
        const more = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ?1 AND obs_key IN (SELECT value FROM json_each(?2))')
          .bind(user, json(extra)).all()).results || [];
        for (const r of more) storedBy.set(`${r.obs_key}#${Number(r.slot) || 0}`, r);
      }
    }
  }

  // The evidence: one row per card, day and topic slot, merged with what is stored (the add-on's row, or an earlier run).
  const upsert = [], recompute = [];
  for (const r of counted) {
    const topics = (topicsOf.get(r.card_id) || []).slice(0, MAX_TOPICS_PER_CARD);
    if (!topics.length) { res.unplaced++; continue; }
    topics.forEach((topic_id, slot) => {
      const next = reviewEvidence(r, { topic_id, slot });
      if (!next) return;
      const prev = storedBy.get(`${next.obs_key}#${slot}`) || null;
      const merged = mergeReviewRow(prev, next);
      if (!reviewChanged(prev, merged)) return;
      upsert.push(merged);
      recompute.push(topic_id);
      if (prev && prev.topic_id && prev.topic_id !== topic_id) recompute.push(prev.topic_id);
    });
  }
  res.rows = upsert.length;
  const statements = newLinks.length ? [linkStatement(env, user, newLinks)] : [];
  if (statements.length || upsert.length) {
    await commit(env, user, { via: 'cron:anki.reviews', surface: 'cron', statements, evidence: { upsert }, recompute });
  }
  return res;
}

function linkStatement(env, user, rows) {
  return env.DB.prepare(`INSERT INTO card_topics (user_id, card_id, topic_id, match, strong, created_by, created_at)
    SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.topic_id'), json_extract(value, '$.match'), json_extract(value, '$.strong'),
      'code', json_extract(value, '$.created_at') FROM json_each(?2) WHERE true
    ON CONFLICT (user_id, card_id, topic_id) DO UPDATE SET strong = max(card_topics.strong, excluded.strong),
      match = CASE WHEN card_topics.match = 'search' THEN excluded.match ELSE card_topics.match END
    WHERE card_topics.removed_at IS NULL`).bind(user, JSON.stringify(rows));
}

/** These cards' own reviews of the last 60 days (card_reviews {card_ids}); none when the call fails. */
async function cardHistory(env, cards, now) {
  try {
    const r = await ankiCall(env, 'card_reviews', { card_ids: cards.slice(0, 100), after_review_id: now - BACKFILL_DAYS * DAY_MS, limit: 1000 },
      { timeoutMs: CALL_MS });
    return (r && Array.isArray(r.reviews) && Array.isArray(r.card_ids)) ? r.reviews : [];
  } catch (e) {
    console.error(JSON.stringify({ anki_card_history_failed: { cards: cards.length, error: (e && e.message) || String(e) } }));
    return [];
  }
}

/**
 * What these cards say about themselves, from the server's card_stats (answer terms and tag leaves only; no card text
 * is kept). A server without card_stats gives none (the cards wait for a later review); a failed call throws, so the
 * run stops before its cursor moves and the next run reads the same reviews again, never losing them.
 */
async function cardWords(env, cards) {
  const out = new Map();
  for (let i = 0; i < cards.length; i += STATS_PER_CALL) {
    let r;
    try {
      r = await ankiCall(env, 'card_stats', { card_ids: cards.slice(i, i + STATS_PER_CALL), limit: STATS_PER_CALL, tags: 'leaves' }, { timeoutMs: STATS_CALL_MS });
    } catch (e) {
      if (missingTool(e)) break;
      console.error(JSON.stringify({ anki_card_stats_failed: { cards: cards.length, error: (e && e.message) || String(e) } }));
      throw e;
    }
    for (const c of (r && r.cards) || []) {
      const id = Number(c && c.card_id);
      if (!Number.isSafeInteger(id)) continue;
      out.set(id, {
        answer_terms: (Array.isArray(c.answer_terms) ? c.answer_terms : []).filter(t => typeof t === 'string').slice(0, 3),
        tag_leaves: (Array.isArray(c.tag_leaves) ? c.tag_leaves : []).filter(t => typeof t === 'string').slice(0, 40),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- FSRS parameters

/**
 * The preset whose parameters the topic model starts from (pure): the main preset (the most reviews in 30 days) when it
 * has its own parameters, else the busiest preset with its own; null when every preset uses Anki's defaults or FSRS is
 * off.
 */
export function choosePreset(reply) {
  if (!reply || !reply.fsrs) return null;
  const presets = (reply.presets || []).filter(p => p && ankiWeights(p.params));
  if (!presets.length) return null;
  return presets.find(p => p.preset_id === reply.main_preset_id) || [...presets].sort((a, b) => (b.reviews_30d || 0) - (a.reviews_30d || 0))[0];
}

/** anki.fsrs: fsrs_params into sync_state 'anki.fsrs'; a change marks every seen topic dirty. */
export async function ankiFsrs(env, user, cursorText, { now = nowMs() } = {}) {
  let reply;
  try {
    reply = await ankiCall(env, 'fsrs_params', {}, { timeoutMs: CALL_MS });
  } catch (e) {
    if (missingTool(e)) return { skipped: 'the Anki server has no fsrs_params yet', cursor: cursorText ?? null, next_at: now + MISSING_RETRY_MS };
    throw e;
  }
  const preset = choosePreset(reply);
  const w = preset ? ankiWeights(preset.params) : null;
  const prev = parse(cursorText);
  const changed = JSON.stringify(prev.w || null) !== JSON.stringify(w ? [...w] : null);
  const next = { w: w ? [...w] : null, fsrs: !!(reply && reply.fsrs), at: now,
    preset: preset ? { id: preset.preset_id, name: String(preset.name || '').slice(0, 80), version: preset.version ?? null,
      desired_retention: preset.desired_retention ?? null, reviews_30d: preset.reviews_30d ?? null } : null };
  if (changed) {
    // Every seen topic recomputes with the new start (the dirty drain, 20 a minute); the stored FSRS states were made
    // with the old one.
    try {
      await env.DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at) SELECT user_id, topic_id, 'fsrs_params', ?2 FROM topic_scores
        WHERE user_id = ?1 AND seen = 1 ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(user, now).run();
    } catch (e) { if (!noTable(e)) throw e; }
  }
  return { cursor: JSON.stringify(next), changed, uses: w ? 'anki' : 'defaults', next_at: now + FSRS_EVERY_MS };
}

export const REVIEW_JOBS = { 'anki.reviews': ankiReviews, 'anki.fsrs': ankiFsrs };
