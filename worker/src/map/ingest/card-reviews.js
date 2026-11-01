import { londonDay, now as nowMs } from '../../util.js';
import { MO } from '../../users.js';
import { commit } from './hub.js';
import { MAX_TOPICS_PER_CARD, mergeReviewRow, reviewChanged, unionReviews } from '../cards.js';
import { CLINICAL_SQL } from '../card-roots.js';

export const SOURCE = 'card_reviews', PAGE = 200;
const RATING = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/**
 * Evidence rows for reviewed cards (pure). reviews: [{card_id, note_id?, ease, at}]; topicsOf: Map card_id ->
 * [topic_id] (strong links, at most 3 used). One row per card, day and topic slot; the day's lowest ease wins.
 */
export function cardReviewRows(reviews, topicsOf) {
  const byKey = new Map();
  for (const r of reviews || []) {
    const ease = Number(r && r.ease), at = Number(r && r.at);
    if (!(ease >= 1 && ease <= 4) || !Number.isFinite(at) || r.card_id == null) continue;
    const day = londonDay(at);
    const k = `${r.card_id}:${day}`;
    const prev = byKey.get(k);
    const reviews = unionReviews(prev ? prev.reviews : [], [[at, ease]]);
    if (!prev || ease < prev.ease || (ease === prev.ease && at < prev.at)) byKey.set(k, { card_id: Number(r.card_id), note_id: r.note_id ?? null, ease, at: prev ? Math.min(prev.at, at) : at, day, reviews });
    else prev.reviews = reviews;
  }
  const rows = [];
  for (const v of byKey.values()) {
    const topics = [...new Set(topicsOf.get(v.card_id) || topicsOf.get(String(v.card_id)) || [])].slice(0, MAX_TOPICS_PER_CARD);
    topics.forEach((topic_id, slot) => rows.push({
      obs_key: `cardrev:${v.card_id}:${v.day}`, slot, topic_id, kind: 'card_review', at: v.at, day: v.day, source: 'anki_mac',
      card_id: v.card_id, note_id: v.note_id != null ? Number(v.note_id) : null, rating: RATING[v.ease], amount: v.ease,
      detail_json: JSON.stringify({ ease: v.ease, reviews: v.reviews }), held: 0,
    }));
  }
  return rows;
}

// Reviews are read from the cursor on only for cards strongly linked at that moment, and card_topics fills lazily
// (a topic's sources refresh, a gap, a lesson), so a card linked later would never feed its earlier reviews to FSRS
// (release-2 review BUG-3). Each run therefore also back-fills up to BACKFILL strongly linked cards that have
// reviews before the cursor and no card_review row yet.
export const BACKFILL = 20;
// An Anki Voice session's ratings (spoken.js device 'voice') are already in Anki's review log, which reaches the map
// through anki-reviews.js with their review ids (so an undo there takes them off): they never count again from here.
const REVIEWED = `c.ease BETWEEN 1 AND 4 AND c.session_id NOT IN (SELECT id FROM anki_sessions WHERE device = 'voice')`;
const AT = 'coalesce(c.answered_at, c.revealed_at, c.shown_at)';
// Never a root-cause topic (a foundation concept): cards sit on clinical topics only (card-roots.js).
const TOPICS_OF = `SELECT ct.card_id, ct.topic_id FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
    AND t.status IN ('proposed', 'confirmed') AND ${CLINICAL_SQL('t')} WHERE ct.user_id = ?1 AND ct.strong = 1 AND ct.removed_at IS NULL`;

/**
 * The minute job: reviews answered since the cursor, a page at a time, onto the map through one code commit, plus
 * the earlier reviews of cards linked since. Returns {reviews, rows, after, backfilled?} or {skipped}.
 */
export async function ingestCardReviews(env, user, { now = nowMs(), limit = PAGE } = {}) {
  if (user !== MO) return null;
  let cur, res, after = 0, back = { reviews: [], topics: [] };
  try {
    cur = await env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ? AND source = ?').bind(user, SOURCE).first();
    after = (() => { try { return Number(JSON.parse((cur && cur.cursor) || '{}').after) || 0; } catch { return 0; } })();
    const reads = [
      env.DB.prepare(`SELECT c.card_id, c.note_id, c.ease, ${AT} AS at FROM anki_cards c
          WHERE ${REVIEWED} AND ${AT} > ?1
            AND EXISTS (SELECT 1 FROM card_topics ct WHERE ct.user_id = ?2 AND ct.card_id = c.card_id AND ct.strong = 1 AND ct.removed_at IS NULL)
          ORDER BY at, c.card_id LIMIT ?3`).bind(after, user, Math.max(1, Math.min(500, limit | 0 || PAGE))),
      env.DB.prepare(`${TOPICS_OF}
            AND ct.card_id IN (SELECT c.card_id FROM anki_cards c WHERE ${REVIEWED} AND ${AT} > ?2)
          ORDER BY ct.card_id, ct.created_at, ct.topic_id`).bind(user, after),
    ];
    if (after > 0) {
      reads.push(env.DB.prepare(`SELECT DISTINCT ct.card_id FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
            AND t.status IN ('proposed', 'confirmed')
          WHERE ct.user_id = ?1 AND ct.strong = 1 AND ct.removed_at IS NULL
            AND EXISTS (SELECT 1 FROM anki_cards c WHERE c.card_id = ct.card_id AND ${REVIEWED} AND ${AT} <= ?2)
            AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.card_id = ct.card_id AND e.kind = 'card_review')
          ORDER BY ct.card_id LIMIT ?3`).bind(user, after, BACKFILL));
    }
    res = await env.DB.batch(reads);
    const cards = after > 0 ? (res[2].results || []).map(r => Number(r.card_id)) : [];
    if (cards.length) {
      const ids = JSON.stringify(cards);
      const [rv, tp] = await env.DB.batch([
        env.DB.prepare(`SELECT c.card_id, c.note_id, c.ease, ${AT} AS at FROM anki_cards c
            WHERE c.card_id IN (SELECT value FROM json_each(?1)) AND ${REVIEWED} AND ${AT} <= ?2 ORDER BY at, c.card_id`).bind(ids, after),
        env.DB.prepare(`${TOPICS_OF} AND ct.card_id IN (SELECT value FROM json_each(?2)) ORDER BY ct.card_id, ct.created_at, ct.topic_id`).bind(user, ids),
      ]);
      back = { reviews: rv.results || [], topics: tp.results || [] };
    }
  } catch (e) { if (noTable(e)) return { skipped: 'not ready' }; throw e; }
  const reviews = res[0].results || [];
  if (!reviews.length && !back.reviews.length) return { reviews: 0, rows: 0 };
  const topicsOf = new Map();
  for (const r of [...(res[1].results || []), ...back.topics]) {
    const k = Number(r.card_id);
    if (!topicsOf.has(k)) topicsOf.set(k, []);
    if (!topicsOf.get(k).includes(r.topic_id)) topicsOf.get(k).push(r.topic_id);
  }
  const rows = await mergeStored(env, user, cardReviewRows([...reviews, ...back.reviews], topicsOf));
  const last = reviews.length ? Math.max(...reviews.map(r => Number(r.at) || 0)) : after;
  const statements = [env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, SOURCE, JSON.stringify({ after: last }), now)];
  if (rows.length) await commit(env, user, { via: 'cron:cardReviews', surface: 'cron', statements, evidence: { upsert: rows } });
  else await env.DB.batch(statements);
  const out = { reviews: reviews.length, rows: rows.length, after: last };
  if (back.reviews.length) out.backfilled = new Set(back.reviews.map(r => Number(r.card_id))).size;
  return out;
}

/**
 * Anki's own review log (anki-reviews.js, ANKI-S4) writes the same keys: each row is merged with the stored one, so the
 * day's lowest ease stays whichever source reported it first, and an unchanged row is not written again.
 */
export async function mergeStored(env, user, rows) {
  if (!rows.length) return rows;
  const keys = [...new Set(rows.map(r => r.obs_key))];
  const stored = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND obs_key IN (SELECT value FROM json_each(?))')
    .bind(user, JSON.stringify(keys)).all()).results || [];
  const byKey = new Map(stored.map(r => [`${r.obs_key}#${Number(r.slot) || 0}`, r]));
  return rows.map(r => {
    const prev = byKey.get(`${r.obs_key}#${Number(r.slot) || 0}`) || null;
    const merged = mergeReviewRow(prev, r);
    return reviewChanged(prev, merged) ? merged : null;
  }).filter(Boolean);
}
