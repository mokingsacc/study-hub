// Due cards by subject (I33 §6): Anki's schedule for the cards the hub can place, kept in card_due, and which
// specialties each card counts in, kept in card_subjects. Bookkeeping like card_cache, written directly.
//
//   cards.due (sync.js, minute % 10 === 7, DUE_ORBS on): the card_stats change feed (changed_since, then the server's
//     cursor; 500 a page, at most 4 pages a run), then a backfill by id of placed cards with no row or a row older than
//     24 h, and of the deck's new cards with no new position yet (2 calls of 500 at most each), then card_subjects from
//     strong card_topics, then list_decks (Anki's own new + learning + review per deck, the Cards page's numbers), then
//     each card's one home (home.js): code links first, then for today's cards still without one, embeddings, and in
//     the cron only, the card labeller for the leftovers.
//   Today's queue (todayQueue): learning and review cards due today and the deck's new cards in Anki's order (new
//     position), each kind up to Anki's own count from list_decks, so the beads add up to the Cards page's total.
//   orbits.daily (sync.js, the 04:29 hourly slot): reconcile, the cards due today re-read by id (a card the server no
//     longer returns was deleted, and its rows go).
//   After a rating through the hub: refreshDue re-reads that one card (cards.js, in waitUntil).
// Fails soft like ingest/anki-reviews.js: a server without card_stats answers "Unknown tool" and the job waits an hour.
import { ankiCall, AnkiError } from '../anki.js';
import { HttpError, json } from '../util.js';
import { chunks } from '../map/events.js';
import { needDue } from './common.js';
import { RULES } from './tag-rules.js';
import { getSetting, defaultSettings } from '../db.js';
import { codeHomeStatements, assignHomes, labelLeftovers, provisionalHomes, pruneSearchLinks, HOME_MAX } from './home.js';

const PAGE = 500, MAX_PAGES = 4, BACKFILL_CALLS = 2, STALE_ROW_MS = 86_400_000, STALE_MS = 6 * 3_600_000, LEARN_AHEAD_MS = 20 * 60_000;
const CALL_MS = 25_000, UNKNOWN_WAIT_MS = 3_600_000, REFRESH_EVERY_MS = 60_000;
const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Anki's day: the London date of (now minus the rollover hour, 4 by default). */
export const ankiDay = (ms, rollover = 4) => LONDON.format(new Date(ms - rollover * 3_600_000));
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const missingTool = e => e instanceof AnkiError && /unknown tool/i.test(e.message);
const TYPES = new Set(['new', 'learning', 'review', 'relearning']);

async function rolloverOf(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'anki_rollover_hour'").first().catch(() => null);
  const h = r ? Number(r.value) : 4;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 4;
}

/** A card_stats card as a card_due row (pure). */
export function dueRow(c, now, rollover = 4) {
  const id = Number(c && c.card_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const ctype = TYPES.has(c.type) ? c.type : null;
  const at = c.due_at ? Date.parse(c.due_at) : NaN;
  const last = Number(c.last_review);
  return { card_id: id, note_id: Number(c.note_id) || null, deck: c.deck ? String(c.deck).slice(0, 200) : null, ctype,
    due_day: typeof c.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : null, due_at: Number.isFinite(at) ? at : null,
    ivl: Number(c.interval_days) || 0, r: c.fsrs && Number.isFinite(Number(c.fsrs.retrievability)) ? Number(c.fsrs.retrievability) : null,
    suspended: c.suspended ? 1 : 0, buried: c.buried ? 1 : 0, last_review_day: Number.isFinite(last) && last > 0 ? ankiDay(last, rollover) : null, checked_at: now,
    new_pos: ctype === 'new' && Number.isSafeInteger(Number(c.new_position)) && c.new_position !== null ? Number(c.new_position) : null };
}

export function tagSubjects(leaves, rules = RULES) {
  const out = [];
  for (const leaf of Array.isArray(leaves) ? leaves : []) {
    const words = String(leaf).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) continue;
    const hit = rules.find(([ws]) => ws.every(w => words.some(x => x.startsWith(w))));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
    if (out.length >= 2) break;
  }
  return out;
}

const DUE_COLS = ['card_id', 'note_id', 'deck', 'ctype', 'due_day', 'due_at', 'ivl', 'r', 'suspended', 'buried', 'last_review_day', 'checked_at', 'new_pos'];
/** Statements writing one page of card_stats cards: one upsert into card_due, the tag rows replaced. */
export function writeCards(env, user, cards, now, rollover = 4) {
  const rows = cards.map(c => dueRow(c, now, rollover)).filter(Boolean);
  if (!rows.length) return [];
  const tags = [];
  for (const c of cards) for (const cat of tagSubjects(c.tag_leaves)) tags.push({ card_id: Number(c.card_id), category_id: cat });
  const withLeaves = cards.filter(c => Array.isArray(c.tag_leaves)).map(c => Number(c.card_id));
  const sel = DUE_COLS.map(c => `json_extract(value, '$.${c}')`).join(', ');
  const st = chunks(rows, 500).map(part => env.DB.prepare(`INSERT INTO card_due (user_id, ${DUE_COLS.join(', ')}) SELECT ?1, ${sel} FROM json_each(?2) WHERE true
      ON CONFLICT (user_id, card_id) DO UPDATE SET ${DUE_COLS.filter(c => c !== 'card_id').map(c => `${c} = excluded.${c}`).join(', ')}`).bind(user, JSON.stringify(part)));
  if (withLeaves.length) {
    st.push(env.DB.prepare("DELETE FROM card_subjects WHERE user_id = ?1 AND via = 'tag' AND card_id IN (SELECT value FROM json_each(?2))").bind(user, JSON.stringify(withLeaves)));
    if (tags.length) st.push(env.DB.prepare(`INSERT OR IGNORE INTO card_subjects (user_id, card_id, category_id, via)
      SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.category_id'), 'tag' FROM json_each(?2)
      WHERE NOT EXISTS (SELECT 1 FROM card_subjects s WHERE s.user_id = ?1 AND s.card_id = json_extract(value, '$.card_id') AND s.via = 'topic')`).bind(user, JSON.stringify(tags)));
  }
  return st;
}

/** card_subjects via 'topic' from strong card_topics (merged topics follow merged_into; retired ones count for nothing). */
export function subjectStatements(env, user) {
  return [
    env.DB.prepare("DELETE FROM card_subjects WHERE user_id = ? AND via = 'topic'").bind(user),
    env.DB.prepare(`INSERT OR IGNORE INTO card_subjects (user_id, card_id, category_id, via)
      SELECT DISTINCT ct.user_id, ct.card_id, CASE WHEN t.status = 'merged' THEN t2.category_id ELSE t.category_id END, 'topic'
      FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
      LEFT JOIN topics t2 ON t2.user_id = t.user_id AND t2.id = t.merged_into
      WHERE ct.user_id = ?1 AND ct.removed_at IS NULL AND ct.strong = 1 AND t.status <> 'retired'
        AND (t.status <> 'merged' OR (t2.id IS NOT NULL AND t2.status <> 'retired'))
        AND CASE WHEN t.status = 'merged' THEN t2.category_id ELSE t.category_id END IS NOT NULL`).bind(user),
    env.DB.prepare("DELETE FROM card_subjects WHERE user_id = ?1 AND via = 'tag' AND card_id IN (SELECT card_id FROM card_subjects WHERE user_id = ?1 AND via = 'topic')").bind(user),
  ];
}

async function readState(env, user, source) {
  const r = await env.DB.prepare('SELECT cursor, last_ok_at, next_at, fails, last_error FROM sync_state WHERE user_id = ? AND source = ?').bind(user, source).first().catch(() => null);
  let c = {};
  try { c = r && r.cursor ? JSON.parse(r.cursor) : {}; } catch { c = {}; }
  return { ...(r || {}), c };
}
const saveState = (env, user, source, c, { ok = null, next = null, error = null } = {}) => env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, next_at, fails, last_error)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (user_id, source) DO UPDATE SET cursor = ?3, last_ok_at = COALESCE(?4, sync_state.last_ok_at),
    next_at = ?5, fails = CASE WHEN ?7 IS NULL THEN 0 ELSE sync_state.fails + 1 END, last_error = ?7`)
  .bind(user, source, JSON.stringify(c), ok, next, error ? 1 : 0, error);

/** The deck counts list_decks gives (Anki's own, a parent's including its subdecks), as kept in sync_state 'cards.due.decks'. */
export const shapeDeckCounts = list => (Array.isArray(list) ? list : []).map(x => ({ name: String(x.name), new: Number(x.new) || 0, learning: Number(x.learning) || 0,
  review: Number(x.review) || 0, due: Number(x.due) || (Number(x.new) || 0) + (Number(x.learning) || 0) + (Number(x.review) || 0) }));
const saveDecks = (env, user, decks, now) => saveState(env, user, 'cards.due.decks', { decks: shapeDeckCounts(decks), at: now }, { ok: now });
const normDeck = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** One deck's counts from a list_decks snapshot (pure): that deck's own entry (it already counts its subdecks). */
export function deckCounts(snap, deck) {
  const list = snap && Array.isArray(snap.decks) ? snap.decks : [];
  const d = list.find(x => x.name === deck) || list.find(x => normDeck(x.name) === normDeck(deck));
  if (!d) return null;
  const n = { new: Number(d.new) || 0, learning: Number(d.learning) || 0, review: Number(d.review) || 0 };
  return { ...n, total: n.new + n.learning + n.review, at: snap.at || null };
}

/** One run of cards.due. Bounded: a few Anki calls and a few D1 batches. label: false skips the card labeller (the page's refresh). */
export async function dueJob(env, user, { now = Date.now(), maxPages = MAX_PAGES, label = true } = {}) {
  const st = await readState(env, user, 'cards.due');
  if (st.c.wait_until && st.c.wait_until > now) return { waiting: true };
  const rollover = await rolloverOf(env);
  const out = { pages: 0, cards: 0, backfilled: 0 };
  let cursor = st.c.c || null, feedOk = st.c.feed !== false;
  // 1. the change feed
  if (feedOk) {
    try {
      let more = true;
      while (more && out.pages < maxPages) {
        const args = cursor ? { cursor, limit: PAGE, tags: 'leaves' } : { changed_since: String(st.c.since || 0), limit: PAGE, tags: 'leaves' };
        const r = await ankiCall(env, 'card_stats', args, { timeoutMs: CALL_MS });
        const cards = (r && r.cards) || [];
        const w = writeCards(env, user, cards, now, rollover);
        if (w.length) await env.DB.batch(w);
        out.pages++; out.cards += cards.length;
        more = !!(r && r.more);
        if (r && r.cursor) cursor = r.cursor;
        else if (!more) break;
      }
    } catch (e) {
      if (missingTool(e)) { await saveState(env, user, 'cards.due', { ...st.c, wait_until: now + UNKNOWN_WAIT_MS }, { next: now + UNKNOWN_WAIT_MS }).run(); return { skipped: 'card_stats is not on the Anki server yet' }; }
      if (e instanceof AnkiError && !e.ambiguous && /changed_since|cursor/i.test(e.message)) feedOk = false;   // no feed: backfill only
      else { await saveState(env, user, 'cards.due', st.c, { error: String(e.message || e).slice(0, 200) }).run(); throw e; }
    }
  }
  // 2. backfill: placed cards with no row, or one older than a day; then the deck's new cards with no new position yet
  //    (rows from before 0034; a card the server sends without one takes its id, which is Anki's order of adding)
  const deck = await pillDeck(env);
  const [need, fresh] = await env.DB.batch([
    env.DB.prepare(`SELECT DISTINCT ct.card_id FROM card_topics ct LEFT JOIN card_due d ON d.user_id = ct.user_id AND d.card_id = ct.card_id
      WHERE ct.user_id = ?1 AND ct.removed_at IS NULL AND ct.strong = 1 AND (d.card_id IS NULL OR d.checked_at < ?2) LIMIT ?3`).bind(user, now - STALE_ROW_MS, PAGE * BACKFILL_CALLS),
    env.DB.prepare(`SELECT d.card_id FROM card_due d WHERE d.user_id = ?1 AND d.ctype = 'new' AND d.new_pos IS NULL AND d.suspended = 0 AND ${inDeck(2)}
      ORDER BY d.card_id LIMIT ?3`).bind(user, deck, PAGE * BACKFILL_CALLS),
  ]);
  for (const [rows, positions] of [[need.results || [], false], [fresh.results || [], true]]) {
    for (const part of chunks(rows.map(r => r.card_id), PAGE)) {
      const r = await ankiCall(env, 'card_stats', { card_ids: part, limit: PAGE, tags: 'leaves' }, { timeoutMs: CALL_MS });
      const got = (r && r.cards) || [];
      const w = writeCards(env, user, got, now, rollover);
      // a card the server no longer has: stamped so it is not asked for again until tomorrow
      const back = new Set(got.map(c => Number(c.card_id)));
      const gone = part.filter(id => !back.has(Number(id)));
      if (gone.length) w.push(env.DB.prepare(`INSERT INTO card_due (user_id, card_id, suspended, checked_at) SELECT ?1, value, 1, ?2 FROM json_each(?3) WHERE true
        ON CONFLICT (user_id, card_id) DO UPDATE SET suspended = 1, checked_at = ?2`).bind(user, now, JSON.stringify(gone)));
      if (positions) w.push(env.DB.prepare(`UPDATE card_due SET new_pos = card_id WHERE user_id = ?1 AND ctype = 'new' AND new_pos IS NULL
        AND card_id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(part)));
      if (w.length) await env.DB.batch(w);
      out.backfilled += got.length;
    }
  }
  // 3. subjects from topics, and each card's home from its links (home.js step 1), once the old keyword links that
  //    the stricter rule would not make are off (a page a run, until done)
  try { out.pruned = await pruneSearchLinks(env, user, { now }); } catch (e) { if (!noTable(e)) console.error('cards.due: prune', e && e.message); }
  await env.DB.batch([...subjectStatements(env, user), ...codeHomeStatements(env, user, now)]);
  // 4. Anki's own counts per deck (the Cards page's new + learning + review)
  try {
    const d = await ankiCall(env, 'list_decks', {}, { timeoutMs: CALL_MS });
    await saveDecks(env, user, d && d.decks, now).run();
  } catch (e) { if (!missingTool(e)) console.error('cards.due: list_decks', e && e.message); }
  // 5. a home for each of today's cards still without one (embeddings), then the leftovers (the card labeller, cron only)
  try {
    const q = await todayQueue(env, user, now, { deck, rollover });
    // today's cards first (no home, a tag one or a provisional weak one), then other provisional weak homes
    const ids = q.rows.filter(r => !r.category_id || r.via === 'tag' || (r.via === 'weak' && r.score == null)).map(r => r.card_id).slice(0, HOME_MAX);
    const home = await assignHomes(env, user, [...ids, ...await provisionalHomes(env, user, HOME_MAX - ids.length)], { now });
    out.homes = home;
    if (label) {
      const left = q.rows.filter(r => r.via === 'nearest' || !r.category_id).map(r => r.card_id);
      out.labelled = await labelLeftovers(env, user, left, { now });
    }
  } catch (e) { if (!noTable(e)) console.error('cards.due: homes', e && e.message); out.homes = { error: String((e && e.message) || e).slice(0, 200) }; }
  await saveState(env, user, 'cards.due', { c: cursor, since: st.c.since || 0, feed: feedOk }, { ok: now }).run();
  return out;
}

/** The cards due today re-read by id; rows of cards the server no longer has go (orbits.daily). */
export async function reconcile(env, user, { now = Date.now() } = {}) {
  const rollover = await rolloverOf(env);
  const day = ankiDay(now, rollover);
  const ids = ((await env.DB.prepare("SELECT card_id FROM card_due WHERE user_id = ? AND suspended = 0 AND ctype <> 'new' AND (due_day <= ? OR due_at IS NOT NULL) LIMIT 2000")
    .bind(user, day).all()).results || []).map(r => r.card_id);
  let gone = 0, read = 0;
  for (const part of chunks(ids, PAGE)) {
    const r = await ankiCall(env, 'card_stats', { card_ids: part, limit: PAGE, tags: 'leaves' }, { timeoutMs: CALL_MS });
    const got = (r && r.cards) || [];
    read += got.length;
    const back = new Set(got.map(c => Number(c.card_id)));
    const missing = part.filter(id => !back.has(Number(id)));
    gone += missing.length;
    const w = writeCards(env, user, got, now, rollover);
    if (missing.length) {
      w.push(env.DB.prepare('DELETE FROM card_due WHERE user_id = ?1 AND card_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(missing)));
      w.push(env.DB.prepare('DELETE FROM card_subjects WHERE user_id = ?1 AND card_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(missing)));
    }
    if (w.length) await env.DB.batch(w);
  }
  return { read, gone };
}

/** Re-read a few cards now (after a rating, bury or suspend through the hub), and Anki's deck counts with them. Never throws. */
export async function refreshDue(env, user, ids, now = Date.now()) {
  try {
    const list = (ids || []).map(Number).filter(Number.isSafeInteger).slice(0, 100);
    if (!list.length) return;
    const [r, d] = await Promise.all([ankiCall(env, 'card_stats', { card_ids: list, limit: list.length, tags: 'leaves' }, { timeoutMs: 15_000 }),
      ankiCall(env, 'list_decks', {}, { timeoutMs: 15_000 }).catch(() => null)]);
    const w = writeCards(env, user, (r && r.cards) || [], now, await rolloverOf(env));
    if (d && Array.isArray(d.decks)) w.push(saveDecks(env, user, d.decks, now));
    if (w.length) await env.DB.batch(w);
  } catch (e) { console.error('orbits: refreshDue', e && e.message); }
}

// ---------------------------------------------------------------- counts (§6.3, §6.4)
export async function pillDeck(env) {
  const v = await getSetting(env, 'deck').catch(() => null);
  return typeof v === 'string' && v.trim() ? v.trim() : defaultSettings().deck;
}
/** SQL: card_due row d is in the deck bound at ?n, or one of its subdecks. */
export const inDeck = n => `(d.deck = ?${n} OR d.deck LIKE ?${n} || '::%')`;

const DUE_SQL = `d.suspended = 0 AND d.buried = 0 AND d.ctype IS NOT NULL AND d.ctype <> 'new'
  AND ((d.due_at IS NOT NULL AND d.due_at <= ?2) OR (d.due_at IS NULL AND d.due_day IS NOT NULL AND d.due_day <= ?3))`;
export { DUE_SQL };

const BIG = 1_000_000;
/**
 * Today's queue as Anki has it, in Anki's order, each kind up to Anki's own count (binds ?1 user, ?2 now + learn-ahead,
 * ?3 Anki's day, ?4 deck, ?5 new, ?6 learning, ?7 review): learning soonest first, reviews most overdue first then
 * the lowest recall, new cards by new position (Anki's order of adding when there is none).
 */
export const QUEUE_SQL = `WITH q AS (SELECT d.card_id, d.deck, d.ctype, d.due_day, d.due_at, d.r, d.new_pos,
      CASE d.ctype WHEN 'new' THEN 'new' WHEN 'review' THEN 'review' ELSE 'learning' END AS k
    FROM card_due d WHERE d.user_id = ?1 AND d.suspended = 0 AND d.buried = 0 AND d.ctype IS NOT NULL AND ${inDeck(4)}
      AND (d.ctype = 'new' OR (d.due_at IS NOT NULL AND d.due_at <= ?2) OR (d.due_at IS NULL AND d.due_day IS NOT NULL AND d.due_day <= ?3))),
  ranked AS (SELECT q.*, ROW_NUMBER() OVER (PARTITION BY k ORDER BY CASE k WHEN 'new' THEN coalesce(new_pos, card_id) WHEN 'learning' THEN coalesce(due_at, 0) ELSE 0 END,
      CASE k WHEN 'review' THEN due_day END, r, card_id) AS rn FROM q)
  SELECT x.card_id, x.deck, x.ctype, x.k, x.due_day, x.due_at, x.r, h.category_id, h.topic_id, h.via, h.score
  FROM ranked x LEFT JOIN card_home h ON h.user_id = ?1 AND h.card_id = x.card_id
  WHERE x.rn <= CASE x.k WHEN 'new' THEN ?5 WHEN 'learning' THEN ?6 ELSE ?7 END ORDER BY x.k, x.rn LIMIT 5000`;

/**
 * Today's queue for one deck (default the pills' deck): {day, deck, anki (Anki's own counts from the last list_decks,
 * or null), rows: [{card_id, deck, ctype, k, due_day, due_at, r, category_id, topic_id, via, score}]}. Without Anki's counts
 * yet there are no new cards and no caps.
 */
export async function todayQueue(env, user, now = Date.now(), { deck = null, rollover = null } = {}) {
  const roll = rollover ?? await rolloverOf(env);
  const day = ankiDay(now, roll);
  const name = deck || await pillDeck(env);
  const snap = await readState(env, user, 'cards.due.decks');
  const anki = deckCounts(snap.c, name);
  const rows = (await env.DB.prepare(QUEUE_SQL).bind(user, now + LEARN_AHEAD_MS, day, name, anki ? anki.new : 0, anki ? anki.learning : BIG, anki ? anki.review : BIG).all()).results || [];
  return { day, deck: name, anki, rows, rollover: roll };
}

/**
 * The per-subject counts (pure): each card of today's queue in its one home, so the subjects add up to the queue;
 * a card with no home is in unplaced (0 once the homes are made). extra: per subject {done, later, fresh}.
 */
export function tally(rows, extra = []) {
  const by = {};
  const of = c => by[c] || (by[c] = { due: 0, new: 0, learning: 0, review: 0, later: 0, done_today: 0, new_available: 0, decks: {} });
  let unplaced = 0;
  for (const r of rows) {
    if (!r.category_id) { unplaced++; continue; }
    const o = of(r.category_id);
    o.due++; o[r.k]++;
    o.decks[r.deck || 'Anki'] = (o.decks[r.deck || 'Anki'] || 0) + 1;
  }
  for (const e of extra) {
    if (!e.c) continue;
    const o = of(e.c);
    o.done_today += Number(e.done) || 0; o.later += Number(e.later) || 0;
    o.new_available = Math.max(0, (Number(e.fresh) || 0) - o.new);
  }
  const total = rows.length;
  return { by_category: by, total_due: total, placed_due: total - unplaced, unplaced_due: unplaced };
}

export async function countsFor(env, user, now = Date.now()) {
  const q = await todayQueue(env, user, now);
  const dayEnd = Date.parse(`${q.day}T00:00:00Z`) + 86_400_000 + q.rollover * 3_600_000 + 3_600_000;   // generous: London is UTC or UTC+1
  const [extra, st] = await env.DB.batch([
    env.DB.prepare(`SELECT h.category_id AS c,
        SUM(CASE WHEN d.last_review_day = ?3 THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN d.suspended = 0 AND d.buried = 0 AND d.ctype IN ('learning','relearning') AND d.due_at > ?2 AND d.due_at < ?5 THEN 1 ELSE 0 END) AS later,
        SUM(CASE WHEN d.ctype = 'new' AND d.suspended = 0 AND d.buried = 0 THEN 1 ELSE 0 END) AS fresh
      FROM card_home h JOIN card_due d ON d.user_id = h.user_id AND d.card_id = h.card_id
      WHERE h.user_id = ?1 AND ${inDeck(4)} GROUP BY h.category_id`).bind(user, now + LEARN_AHEAD_MS, q.day, q.deck, dayEnd),
    env.DB.prepare("SELECT last_ok_at, last_error, fails FROM sync_state WHERE user_id = ? AND source = 'cards.due'").bind(user),
  ]);
  const s = (st.results || [])[0] || null;
  const checked = s ? s.last_ok_at || null : null;
  return { day: q.day, now, deck: q.deck, checked_at: checked, stale: !checked || now - checked > STALE_MS || !!(s && s.fails > 0),
    anki: q.anki, ...tally(q.rows, extra.results || []) };
}

// GET /api/orbits/due
export async function dueRoute(request, env, ctx, params, url, user) {
  needDue(env);
  return json(await countsFor(env, user));
}

// POST /api/orbits/due/refresh: one bounded pass now (at most once a minute), then the counts.
export async function refreshRoute(request, env, ctx, params, url, user) {
  needDue(env);
  const now = Date.now();
  const st = await readState(env, user, 'cards.due.refresh');
  if (st.c.at && now - st.c.at < REFRESH_EVERY_MS) {
    const res = json({ ...(await countsFor(env, user, now)), refreshed: false, retry_in_s: Math.ceil((REFRESH_EVERY_MS - (now - st.c.at)) / 1000) }, 429);
    return res;
  }
  await saveState(env, user, 'cards.due.refresh', { at: now }, { ok: now }).run();
  let ran = null;
  if (env.ANKI_MCP_URL) {
    try { ran = await dueJob(env, user, { now, maxPages: 1, label: false }); } catch (e) { ran = { error: e.message }; }
  }
  return json({ ...(await countsFor(env, user, Date.now())), refreshed: true, ran });
}

export { HttpError };
