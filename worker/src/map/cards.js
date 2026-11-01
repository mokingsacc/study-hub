import { cardDayMass, verdictRank, detailOf } from './weights.js';

export const MATURE_DAYS = 21;
export const MAX_TOPICS_PER_CARD = 3;   // one row per slot 0-2 under the same observation key
const WORDS = { once: 1, twice: 2, thrice: 3 };

/**
 * The schedule strings check_deck returns: 'new', 'learning', 'due today', 'due tomorrow', 'due in 62 days',
 * 'due in 13 days, forgotten 1 time', 'forgotten 3 times', 'suspended'. Anything unreadable gives state null.
 */
export function parseSchedule(s) {
  const text = String(s ?? '').trim().toLowerCase();
  const out = { state: null, due_in_days: null, lapses: 0 };
  if (!text) return out;
  const lapse = /forgotten\s+(\d+|once|twice|thrice)(?:\s+times?)?/.exec(text);
  if (lapse) out.lapses = WORDS[lapse[1]] ?? Number(lapse[1]);
  if (/\bsuspended\b/.test(text)) out.state = 'suspended';
  else if (/^new\b/.test(text) || /\bnew card\b/.test(text)) out.state = 'new';
  else if (/\b(re)?learning\b/.test(text)) out.state = 'learning';
  let m;
  if (/\bdue today\b|\bdue now\b/.test(text)) out.due_in_days = 0;
  else if (/\bdue tomorrow\b/.test(text)) out.due_in_days = 1;
  else if ((m = /\bdue in\s+(\d+)\s+days?\b/.exec(text))) out.due_in_days = Number(m[1]);
  else if ((m = /\boverdue(?: by)?\s+(\d+)\s+days?\b/.exec(text)) || (m = /\bdue\s+(\d+)\s+days? ago\b/.exec(text))) out.due_in_days = -Number(m[1]);
  if (!out.state && (out.due_in_days != null || lapse)) out.state = 'review';
  return out;
}

/**
 * The state kind for a parsed schedule. A review card due in 21 days or more is mature (its interval is at least
 * that long, and a lapse in the last 30 days would have reset it); anything else under review is young.
 */
export function cardStateKind(parsed) {
  const p = parsed || {};
  if (p.state === 'new') return 'card_new';
  if (p.state === 'learning') return 'card_young';
  if (p.state === 'suspended') return 'card_suspended';
  if (p.state === 'review') return p.due_in_days != null && p.due_in_days >= MATURE_DAYS ? 'card_mature' : 'card_young';
  return null;
}

const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The cards (card_cache rows) due on `today` (YYYY-MM-DD, London), for the reviews that close a lesson: learning
 * cards, and review cards whose due day (the day the schedule was read, by dayOf(fetched_at), plus its days) is
 * today or earlier. New and suspended cards never count. The Anki server checks again when one is rated.
 */
export function dueOn(rows, today, dayOf) {
  return (rows || []).filter(c => {
    const p = parseSchedule(c.schedule);
    if (p.state === 'learning') return true;
    if (p.state !== 'review' || p.due_in_days == null) return false;
    const read = c.fetched_at ? dayOf(Number(c.fetched_at)) : today;
    return addDays(read, p.due_in_days) <= today;
  });
}

const lapsesOf = c => {
  if (!c) return 0;
  if (c.lapses != null && Number.isFinite(Number(c.lapses))) return Math.max(0, Number(c.lapses));
  return parseSchedule(c.schedule).lapses;
};

/**
 * The evidence rows for a card seen now. prev: what the hub last knew ({schedule, lapses}) or null the first time
 * it sees the card; next: {card_id, note_id?, schedule, lapses?}. ctx: {topic_ids (strong links only, at most 3),
 * at, day, source}. Rows carry facts only; realtime upserts them on (obs_key, slot), merging a dated lapse into
 * the card's day row with mergeCardDay.
 */
export function cardEvidence(prev, next, { topic_ids = [], at = Date.now(), day, source = 'card' } = {}) {
  if (!next || next.card_id == null || !day) return [];
  const topics = [...new Set((topic_ids || []).filter(t => t != null && t !== '').map(String))].slice(0, MAX_TOPICS_PER_CARD);
  if (!topics.length) return [];
  const kindNow = cardStateKind(parseSchedule(next.schedule));
  const kindBefore = prev ? cardStateKind(parseSchedule(prev.schedule)) : null;
  const lapsesNow = lapsesOf(next), lapsesBefore = lapsesOf(prev);
  const base = (topic_id, slot) => ({
    slot, topic_id, at, day, source, card_id: Number(next.card_id), note_id: next.note_id != null ? Number(next.note_id) : null,
    held: 0, created_by: 'code',
  });
  const rows = [];
  topics.forEach((topic_id, slot) => {
    if (kindNow && (!prev || kindNow !== kindBefore)) {
      rows.push({ ...base(topic_id, slot), obs_key: `cardstate:${next.card_id}`, kind: kindNow, detail_json: JSON.stringify({ state: kindNow }) });
    }
    if (!prev && lapsesNow > 0) {
      rows.push({ ...base(topic_id, slot), obs_key: `cardlapses:${next.card_id}`, kind: 'card_lapse', amount: lapsesNow,
        detail_json: JSON.stringify({ first_sight: 1, lapses: lapsesNow }) });
    }
    if (prev && lapsesNow > lapsesBefore) {
      rows.push({ ...base(topic_id, slot), obs_key: `card:${next.card_id}:${day}`, kind: 'card_lapse',
        detail_json: JSON.stringify({ lapsed: 1, lapses: lapsesNow }) });
    }
  });
  return rows;
}

/**
 * Two reports of the same card on the same day as one row (plan §5.3: the worst fact wins). a is the stored row
 * (or null), b the new report. Facts kept: a lapse, the worst check verdict (gap over shaky over sound), the most
 * parts missed. The kind becomes the worst fact's kind, so the why line names it.
 */
export function mergeCardDay(a, b) {
  if (!a) return b ? withKind({ ...b }) : b;
  if (!b) return withKind({ ...a });
  const da = detailOf(a), db = detailOf(b);
  const parts = (r, d) => Number(d.missed_parts ?? (r.kind === 'card_weak_part' ? r.amount : 0)) || 0;
  const lapsed = a.kind === 'card_lapse' || b.kind === 'card_lapse' || Number(da.lapsed) > 0 || Number(db.lapsed) > 0;
  const va = a.verdict ?? (a.kind === 'card_check' ? 'gap' : null), vb = b.verdict ?? (b.kind === 'card_check' ? 'gap' : null);
  const verdict = verdictRank(vb) > verdictRank(va) ? vb : va;
  const missed = Math.max(parts(a, da), parts(b, db));
  const detail = { ...da, ...db };
  delete detail.lapsed; delete detail.missed_parts;
  if (lapsed) detail.lapsed = 1;
  if (missed > 0) detail.missed_parts = missed;
  const merged = { ...a, ...b, verdict: verdict ?? null, amount: missed > 0 ? missed : null, detail_json: JSON.stringify(detail),
    at: Math.min(Number(a.at) || Infinity, Number(b.at) || Infinity), gap_id: b.gap_id ?? a.gap_id ?? null };
  if (!Number.isFinite(merged.at)) merged.at = a.at ?? b.at;
  return withKind(merged);
}

// The kind of a card-day row is its worst fact's kind (a check with no worse fact stays a check).
function withKind(row) {
  const kind = cardDayMass(row).worst;
  return kind ? { ...row, kind } : row;
}

export const REVIEW_RATING = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
export const reviewKey = (cardId, day) => `cardrev:${cardId}:${day}`;
const REVIEW_DETAIL = ['type', 'ms', 'by', 'parts'];

/**
 * The evidence row for one card's review on one day, on one topic slot (pure). review: {card_id, note_id?, ease 1..4,
 * at, day, source, type?, ms?, by?, parts?, reviews?: [[at, ease], ...] (each rating that day)}. Null for an ease
 * outside 1..4.
 */
export function reviewEvidence(review, { topic_id, slot = 0 }) {
  const ease = Number(review && review.ease);
  if (!(ease >= 1 && ease <= 4) || review.card_id == null || !review.day || topic_id == null) return null;
  const detail = { ease };
  for (const k of REVIEW_DETAIL) if (review[k] != null && review[k] !== '') detail[k] = review[k];
  const own = [[Number(review.at), ease]];
  detail.reviews = unionReviews(own, Array.isArray(review.reviews) ? reviewList({ detail_json: JSON.stringify({ reviews: review.reviews }) }) : []);
  return {
    obs_key: reviewKey(review.card_id, review.day), slot, topic_id, kind: 'card_review', at: Number(review.at), day: review.day,
    source: review.source || 'anki', card_id: Number(review.card_id), note_id: review.note_id != null ? Number(review.note_id) : null,
    rating: REVIEW_RATING[ease], amount: ease, detail_json: JSON.stringify(detail), held: 0,
  };
}

// The Mac add-on and Anki's log report one press at slightly different times (the add-on's click, Anki's review id):
// the same ease within two minutes is one rating.
export const SAME_PRESS_MS = 120_000;
/** Two lists of ratings as one, in time order, each press once (pure). */
export function unionReviews(a, b) {
  const out = [...(a || [])];
  for (const x of b || []) if (!out.some(y => y[1] === x[1] && Math.abs(y[0] - x[0]) <= SAME_PRESS_MS)) out.push(x);
  return out.sort((p, q) => p[0] - q[0]).slice(-REVIEWS_KEPT);
}

/**
 * Two reports of one card's review day as one row (pure): every rating of both, each press once (detail.reviews); the
 * lowest ease names the row (with its details), the earliest time dates it, and the first report's source stays (the
 * stored row's; plan §5.3). prev may be null.
 */
export function mergeReviewRow(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const ep = Number(prev.amount) || gradeOfRating(prev.rating), en = Number(next.amount) || gradeOfRating(next.rating);
  const worse = en && (!ep || en < ep) ? next : prev;
  const dp = detailOf(prev), dn = detailOf(next);
  const detail = worse === next ? { ...dp, ...dn } : { ...dn, ...dp };
  const merged = { ...next, note_id: next.note_id ?? prev.note_id ?? null, rating: worse.rating, amount: worse.amount, detail_json: JSON.stringify(detail),
    at: Math.min(Number(prev.at) || Infinity, Number(next.at) || Infinity), source: prev.source || next.source };
  return rowWithReviews(merged, unionReviews(reviewList(prev), reviewList(next))) || merged;
}
const gradeOfRating = r => ({ again: 1, hard: 2, good: 3, easy: 4 })[String(r || '').toLowerCase()] || 0;

export const REVIEWS_KEPT = 20;
export function reviewList(row) {
  if (!row) return [];
  const d = detailOf(row);
  const list = (Array.isArray(d.reviews) ? d.reviews : [])
    .filter(x => Array.isArray(x) && Number.isFinite(Number(x[0])) && Number(x[1]) >= 1 && Number(x[1]) <= 4)
    .map(x => [Number(x[0]), Number(x[1])]);
  if (list.length) return list.sort((a, b) => a[0] - b[0]);
  const ease = Number(row.amount) || gradeOfRating(row.rating);
  return ease >= 1 && ease <= 4 && Number.isFinite(Number(row.at)) ? [[Number(row.at), ease]] : [];
}

/** A review row carrying `list` as its ratings: the lowest ease names it, the earliest time dates it. Null when empty. */
export function rowWithReviews(row, list) {
  const l = [...list].sort((a, b) => a[0] - b[0]).slice(-REVIEWS_KEPT);
  if (!l.length) return null;
  const ease = Math.min(...l.map(x => x[1]));
  return { ...row, rating: REVIEW_RATING[ease], amount: ease, at: l[0][0], detail_json: JSON.stringify({ ...detailOf(row), ease, reviews: l }) };
}

/**
 * The row without one rating (an undo or a changed rating in Anki Voice, by its review id): null when that was its only
 * rating, the row unchanged when it never had it.
 */
export function dropReview(row, reviewId) {
  const list = reviewList(row);
  const left = list.filter(x => x[0] !== Number(reviewId));
  if (left.length === list.length) return row;
  return rowWithReviews(row, left);
}

/** Whether a stored review row would change by being written as `next` (only its facts are compared). */
export const reviewChanged = (prev, next) => !prev || ['topic_id', 'rating', 'amount', 'at', 'detail_json', 'note_id']
  .some(k => String(prev[k] ?? '') !== String(next[k] ?? ''));
