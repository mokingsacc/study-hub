import { now as nowMs, londonDay, json as jsonResponse, readJson, HttpError } from '../../util.js';
import { ankiCall } from '../../anki.js';
import { norm, userKey } from '../../../../public/js/shared/names.js';
import { fetchAliases, withoutRoots, plan, decide, ACCEPT } from '../resolve.js';
import { CLINICAL_SQL, notRootTopic } from '../card-roots.js';
import { reviewEvidence, mergeReviewRow, reviewChanged, unionReviews, MAX_TOPICS_PER_CARD } from '../cards.js';
import { ankiWeights } from '../fsrs.js';
import { commit } from './hub.js';
import { jobBudget } from './anki.js';
import { countingEnv } from '../d1-count.js';
import { closeFromReviews } from '../retests.js';
import { queueStatements } from '../queue.js';
import { noteJob } from '../../job-log.js';
import { deferUpdates, flushUpdates } from '../instant.js';

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
// New cards sent to the tray a run (a card already there only gets its rows), and the Cards page ratings read again a day.
export const QUEUE_PER_RUN = 25, SWEEP_DAYS = 14, SWEEP_CARDS = 100;
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

/**
 * One row per card and day (pure): named by the lowest ease at the earliest time, the rest of its facts from that
 * review, and every rating of the day in time order (reviews: [[at, ease], ...]), which FSRS hears one by one.
 */
export function cardDays(reviews) {
  const by = new Map();
  const own = r => (Array.isArray(r.reviews) && r.reviews.length ? r.reviews : [[r.at, r.ease]]);
  for (const r of reviews) {
    const k = `${r.card_id}|${r.day}`;
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...r, reviews: unionReviews([], own(r)) }); continue; }
    const worse = r.ease < prev.ease ? r : prev;
    by.set(k, { ...worse, at: Math.min(prev.at, r.at), note_id: prev.note_id ?? r.note_id, reviews: unionReviews(prev.reviews, own(r)) });
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
  // How many voice ratings the server sent straight here today (its hub_gaps status), kept in the cursor (no extra write).
  let pushed = st.pushed_day ? { n: Number(st.pushed) || 0, day: st.pushed_day } : null;
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
    if (i === 0 && page.hub_gaps && Number.isFinite(Number(page.hub_gaps.pushed_today))) pushed = { n: Number(page.hub_gaps.pushed_today), day: page.hub_gaps.pushed_day || londonDay(now) };
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
  // Once a London day, with the log caught up: the Cards page ratings still missing from the map are read again.
  const today = londonDay(now);
  let swept = st.swept || null;
  if (!more && caughtUp && swept !== today && (budget == null || counter.n + PAGE_QUERIES <= budget)) {
    try {
      const sw = await sweepMissingRatings(cenv, user, { now });
      if (sw) { out.swept = sw; swept = today; }
    } catch (e) {
      console.error(JSON.stringify({ anki_missing_ratings_failed: { error: (e && e.message) || String(e) } }));
      await noteJob(env, { job: 'card_tray', user, key: `${today}:failed`, ref: 'sweep', at: now, state: 'failed', detail: e });
    }
  }
  // Recent activity: one line a day for card ratings sent to the tray (and Cards page ratings found again).
  const queued = (out.queued || 0) + (out.swept ? out.swept.queued : 0), found = out.swept && out.swept.found ? out.swept.cards : 0;   // cards read again
  if (queued || found) await noteJob(env, { job: 'card_tray', user, key: today, at: now, state: 'ok', add: true, counts: { queued, found } });
  return { ...out, cursor: JSON.stringify({ c: cursor, epoch, more: more ? 1 : 0, caught_up: caughtUp || !more ? 1 : 0, ...(swept ? { swept } : {}),
    ...(pushed ? { pushed: pushed.n, pushed_day: pushed.day } : {}) }), more };
}

// ---------------------------------------------------------------- the push (1 Nov 2026)

const MO = 'mo';
export const PUSH_MAX = 20;
const PUSH_PARTS = ['correct', 'nudged', 'wrong'];
const id = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

/**
 * One push body into card_reviews rows (pure): {reviews: [{review_id, card_id, note_id?, ease, type, time_ms?, source?,
 * parts?}]}, at most PUSH_MAX. Returns {reviews, problems}: a row that is not a review is a problem, never guessed at.
 */
export function cleanPush(body) {
  const list = body && Array.isArray(body.reviews) ? body.reviews : null;
  if (!list || !list.length) return { reviews: [], problems: ['reviews is needed: a list of review rows.'] };
  if (list.length > PUSH_MAX) return { reviews: [], problems: [`At most ${PUSH_MAX} reviews at a time.`] };
  const reviews = [], problems = [];
  for (const r of list) {
    const review_id = id(r && r.review_id), card_id = id(r && r.card_id), ease = Number(r && r.ease);
    if (!review_id || !card_id || !(ease >= 1 && ease <= 4) || typeof (r && r.type) !== 'string') { problems.push('Each review needs review_id, card_id, ease 1-4 and type.'); continue; }
    const parts = Array.isArray(r.parts) ? r.parts.map(p => String(p).toLowerCase()).filter(p => PUSH_PARTS.includes(p)).slice(0, 8) : [];
    reviews.push({ review_id, card_id, note_id: id(r.note_id), ease, type: String(r.type).slice(0, 20),
      ...(Number.isFinite(Number(r.time_ms)) ? { time_ms: Math.max(0, Math.round(Number(r.time_ms))) } : {}),
      ...(r.source === 'voice' ? { source: 'voice' } : {}), ...(parts.length ? { parts } : {}) });
  }
  return { reviews, problems };
}

export async function pushRoute(request, env) {
  const body = await readJson(request, 50_000);
  const { reviews, problems } = cleanPush(body);
  if (!reviews.length) throw new HttpError(400, problems[0] || 'No review to take.');
  const now = nowMs();
  let history = false;
  try {
    const row = await env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ? AND source = ?').bind(MO, SOURCE).first();
    history = Number(parse(row && row.cursor).caught_up) === 1;
  } catch (e) { if (!noTable(e)) throw e; }
  const denv = deferUpdates(env);
  try {
    const r = await ingestReviews(denv, MO, reviews, { now, history });
    await flushUpdates(denv, MO, { now });
    return jsonResponse({ ok: true, counted: r.counted || 0, rows: r.rows || 0, linked: r.linked || 0, queued: r.queued || 0, ...(r.retests ? { retests: r.retests } : {}) });
  } catch (e) {
    console.error(JSON.stringify({ anki_review_push_failed: { error: (e && e.message) || String(e) } }));
    return jsonResponse({ ok: false, error: 'Not taken now; the next pull of card reviews brings it.' }, 503);
  }
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
  const skipped = r => rt.skip.has(`${Number(r && r.card_id)}|${londonDay(Number(r && r.review_id))}`);
  let counted = cardDays(countedReviews(rt.skip.size ? list.filter(r => !skipped(r)) : list));
  const res = { counted: 0, rows: 0, linked: 0, unplaced: 0, queued: 0, ...(rt.closed ? { retests: rt.closed } : {}) };
  if (!counted.length) return res;
  res.counted = counted.length;
  const cards = [...new Set(counted.map(r => r.card_id))];
  const notes = [...new Set(counted.map(r => r.note_id).filter(Boolean))];
  const keys = [...new Set(counted.map(r => `cardrev:${r.card_id}:${r.day}`))];
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let links, removed, byMiss, byLesson, stored, rated;
  try {
    [links, removed, byMiss, byLesson, stored, rated] = await env.DB.batch([
      // Cards sit on clinical topics only: a root-cause topic's link (a foundation concept) is never read (card-roots.js).
      q(`SELECT ct.card_id, ct.topic_id FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id AND t.status IN ('proposed', 'confirmed')
         WHERE ct.user_id = ?1 AND ct.strong = 1 AND ct.removed_at IS NULL AND ${CLINICAL_SQL('t')} AND ct.card_id IN (SELECT value FROM json_each(?2))
         ORDER BY ct.card_id, ct.created_at, ct.topic_id`, user, json(cards)),
      q(`SELECT card_id, topic_id FROM card_topics WHERE user_id = ?1 AND removed_at IS NOT NULL AND card_id IN (SELECT value FROM json_each(?2))`, user, json(cards)),
      q(`SELECT DISTINCT CAST(j.value AS INTEGER) AS note_id, m.topic_id FROM misses m JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id, json_each(m.anki_note_ids_json) j
         WHERE m.user_id = ?1 AND m.topic_id IS NOT NULL AND m.deleted_at IS NULL AND m.held = 0 AND ${CLINICAL_SQL('t')}
           AND CAST(j.value AS INTEGER) IN (SELECT value FROM json_each(?2)) ORDER BY m.topic_id`, user, json(notes)),
      // A lesson on a root-cause topic (Teach me serves concepts) gives its card no home: the card's own words place it.
      q(`SELECT l.card_id, l.card_note_id, l.topic_id FROM lessons l JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         WHERE l.user_id = ?1 AND l.topic_id IS NOT NULL AND ${CLINICAL_SQL('t')}
         AND (l.card_id IN (SELECT value FROM json_each(?2)) OR l.card_note_id IN (SELECT value FROM json_each(?3)))`, user, json(cards), json(notes)),
      q(`SELECT * FROM evidence WHERE user_id = ?1 AND obs_key IN (SELECT value FROM json_each(?2))`, user, json(keys)),
      q(`SELECT DISTINCT card_id FROM card_rates WHERE user_id = ?1 AND kind = 'rate' AND card_id IN (SELECT value FROM json_each(?2))`, user, json(cards)),
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
    const fromMiss = [...new Set([...(missTopics.get(note) || []), ...(rt.topics.has(c) ? [rt.topics.get(c)] : [])])];
    const fromLesson = [...new Set([...(lessonTopics.get(c) || []), ...(lessonTopics.get(note) || [])])];
    for (const t of fromMiss.slice(0, MAX_TOPICS_PER_CARD)) link(c, t, 'miss');
    for (const t of fromLesson.slice(0, MAX_TOPICS_PER_CARD)) link(c, t, 'claude');
    if (!(topicsOf.get(c) || []).length) stillOpen.push(c);
  }
  let words = new Map();
  if (stillOpen.length) {
    stillOpen.sort((a, b) => a - b);
    words = await cardWords(env, stillOpen);
    if (words.size) {
      // Every word's keys in one read, as placeTopics reads a page of misses (no prefix reads: a card's words are whole).
      const plans = new Map();
      const keys = [...new Set([...words.values()].flatMap(w => wordPlans(w, plans).flatMap(x => x.plan.keys)))];
      // Clinical names only: a card never lands on a root-cause topic by its words (card-roots.js).
      const data = keys.length ? withoutRoots(await fetchAliases(env, user, keys)) : { byKey: new Map(), prefix: new Map() };
      for (const c of stillOpen) for (const t of wordTopics(words.get(c) || {}, data, plans)) link(c, t, 'search');
    }
  }
  res.linked = newLinks.length;
  const storedBy = new Map((stored.results || []).map(r => [`${r.obs_key}#${Number(r.slot) || 0}`, r]));
  if (history && newLinks.length) {
    const past = await cardHistory(env, [...new Set(newLinks.map(l => l.card_id))], now);
    if (past.length) {
      counted = cardDays([...counted, ...countedReviews(rt.skip.size ? past.filter(r => !skipped(r)) : past)]);
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
  const ratedHere = new Set(((rated && rated.results) || []).map(r => Number(r.card_id)));
  const tookOff = new Set([...off].map(k => Number(k.split('|')[0])));
  const tray = new Map();
  for (const r of counted) {
    const topics = (topicsOf.get(r.card_id) || []).slice(0, MAX_TOPICS_PER_CARD);
    if (!topics.length) {
      const why = tookOff.has(r.card_id) ? null : trayWorthy(r, ratedHere);
      if (!why || (!tray.has(r.card_id) && tray.size >= QUEUE_PER_RUN)) { res.unplaced++; continue; }
      const item = tray.get(r.card_id) || trayItem(r, words.get(r.card_id), why);
      const next = trayEvidence(r, item.id);
      const prev = storedBy.get(`${next.obs_key}#0`) || null;
      // A row already on a topic (placed before, or the add-on's) is never pulled back into the tray.
      if (prev && prev.topic_id) { res.unplaced++; continue; }
      tray.set(r.card_id, item);
      const merged = { ...mergeReviewRow(prev, next), topic_id: null, queue_id: item.id };
      if (!prev || prev.queue_id !== item.id || reviewChanged(prev, merged)) upsert.push(merged);
      res.queued++;
      continue;
    }
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
  if (tray.size) statements.push(...queueStatements(env, user, [...tray.values()], now));
  // A card its own words now place leaves the tray: its open item is settled (its waiting rows moved with the history).
  if (newLinks.length) statements.push(trayDoneStatement(env, user, newLinks));
  res.tray = tray.size;
  if (statements.length || upsert.length) {
    await commit(env, user, { via: 'cron:anki.reviews', surface: 'cron', statements, evidence: { upsert }, recompute });
  }
  return res;
}

// Tray items of cards linked by code since (anki-reviews' own words, a miss or a lesson): resolved onto the first link.
function trayDoneStatement(env, user, links) {
  const first = new Map();
  for (const l of links) if (!first.has(l.card_id)) first.set(l.card_id, l.topic_id);
  return env.DB.prepare(`UPDATE topic_queue SET status = 'resolved', resolved_by = 'code',
      resolved_topic_id = (SELECT json_extract(value, '$.t') FROM json_each(?2) WHERE json_extract(value, '$.id') = topic_queue.id)
    WHERE user_id = ?1 AND kind = 'card' AND status IN ('open', 'claimed') AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`)
    .bind(user, JSON.stringify([...first].map(([c, t]) => ({ id: userKey(user, `card:${c}`), t }))));
}

function linkStatement(env, user, rows) {
  return env.DB.prepare(`INSERT INTO card_topics (user_id, card_id, topic_id, match, strong, created_by, created_at)
    SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.topic_id'), json_extract(value, '$.match'), json_extract(value, '$.strong'),
      'code', json_extract(value, '$.created_at') FROM json_each(?2) WHERE ${notRootTopic('?1', "json_extract(value, '$.topic_id')")}
    ON CONFLICT (user_id, card_id, topic_id) DO UPDATE SET strong = max(card_topics.strong, excluded.strong),
      match = CASE WHEN card_topics.match = 'search' THEN excluded.match ELSE card_topics.match END
    WHERE card_topics.removed_at IS NULL`).bind(user, JSON.stringify(rows));
}

export function trayWorthy(r, ratedHere = new Set()) {
  if (ratedHere.has(Number(r.card_id))) return 'cards_page';
  if (r.by === 'voice' || r.source === 'anki_voice') return 'voice';
  const eases = Array.isArray(r.reviews) && r.reviews.length ? r.reviews.map(x => Number(x[1])) : [Number(r.ease)];
  return eases.includes(1) ? 'again' : null;
}

/** The tray item for a card (pure): card:<card_id>, with its answer terms and tag leaves as the words to place it by. */
export function trayItem(r, words = {}, why = null) {
  const w = words || {};
  const terms = (w.answer_terms || []).filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 60)).slice(0, 3);
  const leaves = (w.tag_leaves || []).filter(t => typeof t === 'string' && norm(t).length >= 3 && !LEAF_STOP.has(norm(t))).map(t => t.slice(0, 60)).slice(0, 6);
  const context = { source: 'anki_review', card_id: Number(r.card_id), ...(r.note_id ? { note_id: Number(r.note_id) } : {}),
    ...(terms.length ? { answer_terms: terms.join('; ') } : {}), ...(leaves.length ? { tag_leaves: leaves.join('; ') } : {}), ...(why ? { why } : {}),
    // A card's answer words are not a name of the topic it is placed on: placing it teaches no alias.
    no_alias: true };
  return { id: `card:${r.card_id}`, kind: 'card', label_raw: (terms.length ? `Card ${r.card_id}: ${terms[0]}` : `Card ${r.card_id}`).slice(0, 120),
    label_norm: norm(terms[0] || '') || `card ${r.card_id}`, context };
}

/** The evidence row of an unplaced card's rating (pure): its card review with no topic, waiting on its tray item. */
export function trayEvidence(r, queueId) {
  const row = reviewEvidence(r, { topic_id: '-', slot: 0 });
  return row ? { ...row, topic_id: null, queue_id: queueId } : null;
}

// Cards page ratings with no card review on the map (the integrity check's I8: applied, within 14 days, an hour old).
export const MISSING_RATINGS_SQL = `SELECT DISTINCT r.card_id FROM card_rates r WHERE r.user_id = ?1 AND r.kind = 'rate' AND r.status = 'applied'
    AND r.at BETWEEN ?2 - ${SWEEP_DAYS * DAY_MS} AND ?2 - 3600000
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.card_id = r.card_id AND e.kind = 'card_review' AND e.at BETWEEN r.at - ${DAY_MS} AND r.at + ${DAY_MS})
  ORDER BY r.card_id LIMIT ${SWEEP_CARDS}`;

/**
 * Those ratings read again from Anki's log (card_reviews {card_ids}) and ingested, so the ones skipped before are placed
 * or sent to the tray. Returns {cards, found, queued, rows}, or null before the tables exist.
 */
export async function sweepMissingRatings(env, user, { now = nowMs() } = {}) {
  let cards;
  try { cards = ((await env.DB.prepare(MISSING_RATINGS_SQL).bind(user, now).all()).results || []).map(r => Number(r.card_id)); } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
  if (!cards.length) return { cards: 0, found: 0, queued: 0, rows: 0 };
  const past = await cardHistory(env, cards, now);
  if (!past.length) return { cards: cards.length, found: 0, queued: 0, rows: 0 };
  const r = await ingestReviews(env, user, past, { now });
  return { cards: cards.length, found: past.length, queued: r.queued || 0, rows: r.rows || 0, tray: r.tray || 0 };
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
