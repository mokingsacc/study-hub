import { readScore, stateOf, summarise } from './weakness.js';
import { BUCKET_NAMES } from './weights.js';

export const STATE_COLS = Object.freeze(['seen', 'ref_at', 'prior_mastery', 'formula_version', ...BUCKET_NAMES, 'strong_fails_json',
  'fsrs_s', 'fsrs_d', 'fsrs_at', 'fsrs_n']);
/** The state columns as a SELECT list for a topic_scores alias (no AS: the names are topic_scores' own). */
export const stateSelect = (a = 's') => STATE_COLS.map(c => `${a}.${c}`).join(', ');

// How far (on the 0-1000 scale) a row may read back from its stored t at its own ref_at (rounding of the stored state).
export const SELF_TOLERANCE = 2;
const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
/** Whether a row carries what liveScore needs (a reader that selected only t and band gets its stored values back). */
export const hasState = row => !!row && row.ref_at != null && Object.prototype.hasOwnProperty.call(row, 'q_pass')
  && Object.prototype.hasOwnProperty.call(row, 'fsrs_s');

/**
 * The faded score of one stored topic_scores row at `now` (pure): {t, t1000, band, mastery, weakness, weakness_raw,
 * certainty, cert100, certainty_level, recall}, or null for an unseen row (it does not fade: 1 - m0 stays), a row
 * without its state columns, or a row without a usable prior.
 */
export function liveScore(row, now = Date.now()) {
  if (!row || !Number(row.seen) || !hasState(row)) return null;
  const m0 = Number(row.prior_mastery);
  if (row.prior_mastery == null || !Number.isFinite(m0)) return null;
  const st = stateOf(row), ref = Number(row.ref_at) || 0;
  // A row that does not read back as itself at its own ref_at (written under older weights, waiting for repair, or made
  // by hand) keeps its stored values: the fade is only applied to a state that is known to give the stored colour.
  if (row.t != null) {
    const back = readScore(st, ref, m0);
    if (back.t1000 == null || Math.abs(back.t1000 - Math.round(Number(row.t) * 1000)) > SELF_TOLERANCE) return null;
  }
  const r = readScore(st, Math.max(Number(now), ref), m0);
  if (!r.seen) return null;
  return { t: r.t1000 == null ? null : r.t1000 / 1000, t1000: r.t1000, band: r.band, mastery: r.mastery, weakness: r.weakness,
    weakness_raw: r.weakness_raw, certainty: r.certainty, cert100: r.cert100, certainty_level: r.certainty_level, recall: r.recall ?? null };
}

/** The row with its score columns as of now (a copy), or the row itself when liveScore has nothing to say. */
export function withLive(row, now = Date.now()) {
  const l = liveScore(row, now);
  if (!l) return row;
  const { t1000, cert100, ...cols } = l;
  return { ...row, ...cols, stored_t: row.t ?? null, faded: row.t != null && Math.round(Number(row.t) * 1000) !== t1000 };
}

/** t1000 of a row's t (stored or live). */
export const t1000Of = row => (row && row.t != null && Number(row.seen) ? Math.round(Number(row.t) * 1000) : null);

// The user's seen topics' rows with their state, optionally some ids only.
const LIVE_SQL = `SELECT s.topic_id, s.category_id, s.t, s.band, s.mastery, s.weakness, s.weakness_raw, s.certainty, s.certainty_level, ${stateSelect('s')}
  FROM topic_scores s WHERE s.user_id = ?1 AND s.seen = 1`;
export const liveSql = ids => (ids ? `${LIVE_SQL} AND s.topic_id IN (SELECT value FROM json_each(?2))` : LIVE_SQL);
/** The statement for loadLive (to ride in a caller's own batch): ids null for every seen topic. */
export function liveStatement(env, user, ids = null) {
  const list = ids == null ? null : JSON.stringify([...new Set(ids.filter(x => x != null && x !== '').map(String))]);
  return list == null ? env.DB.prepare(liveSql(false)).bind(user) : env.DB.prepare(liveSql(true)).bind(user, list);
}
/** Rows read by liveStatement into Map(topic_id -> row as of now). */
export const liveMap = (rows, now = Date.now()) => new Map((rows || []).map(r => [r.topic_id, withLive(r, now)]));

/**
 * Map(topic_id -> live row) for the user's seen topics (ids: only those). One query; a database before the score
 * table answers an empty Map.
 */
export async function loadLive(env, user, { ids = null, now = Date.now() } = {}) {
  if (ids != null && !ids.length) return new Map();
  try {
    return liveMap((await liveStatement(env, user, ids).all()).results || [], now);
  } catch (e) {
    if (/no such table|no such column/i.test(String(e && e.message))) return new Map();
    throw e;
  }
}

/**
 * Overlay live scores on rows that carry topic ids (pure): each row with a live entry gets that entry's columns
 * (`cols`, default t, band, mastery, weakness, weakness_raw, certainty, certainty_level). idOf: the row's topic id.
 */
export function overlay(rows, live, { idOf = r => r.topic_id, cols = ['t', 'band', 'mastery', 'weakness', 'weakness_raw', 'certainty', 'certainty_level'] } = {}) {
  return (rows || []).map(r => {
    const l = live.get(idOf(r));
    if (!l || !Number(r.seen ?? l.seen)) return r;
    const out = { ...r };
    for (const c of cols) if (c in l) out[c] = l[c];
    return out;
  });
}

/**
 * Yield-weighted summaries of topics grouped by key (pure; weakness.js summarise, the same maths as
 * CATEGORY_SUMMARY_SQL): topics [{topic_id, yield, ...}], live Map, keysOf(topic) -> [keys]. Returns Map(key -> summary).
 */
export function liveSummaries(topics, live, keysOf) {
  const groups = new Map();
  for (const t of topics || []) {
    const l = live.get(t.topic_id ?? t.id);
    const row = { yield: t.yield, seen: l ? 1 : 0, mastery: l ? l.mastery : null, t: l ? l.t : null, band: l ? l.band : 'unseen', certainty: l ? l.certainty : 0 };
    for (const k of keysOf(t) || []) {
      if (k == null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
  }
  return new Map([...groups].map(([k, rows]) => [k, summarise(rows)]));
}

/** The weakest systems by their seen topics' mean t (at least two seen): [{category_id, t, n}], as the SQL did with avg(s.t). */
export function weakestCategories(live, { max = 3 } = {}) {
  const by = new Map();
  for (const r of live.values()) {
    if (!Number(r.seen) || r.t == null || r.category_id == null) continue;
    const g = by.get(r.category_id) || { category_id: r.category_id, sum: 0, n: 0 };
    g.sum += Number(r.t); g.n++;
    by.set(r.category_id, g);
  }
  return [...by.values()].filter(g => g.n >= 2).map(g => ({ category_id: g.category_id, t: round(g.sum / g.n, 6), n: g.n }))
    .sort((a, b) => b.t - a.t || String(a.category_id).localeCompare(String(b.category_id))).slice(0, max);
}
