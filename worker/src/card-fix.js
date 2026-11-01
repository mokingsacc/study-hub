import { HttpError, json, readJson, londonDay } from './util.js';
import { ankiCall, AnkiError } from './anki.js';
import { noteJob } from './job-log.js';
import { userKey } from '../../public/js/shared/names.js';

export const SKIP_REASONS = [
  { key: 'badly_worded', word: 'Badly worded' }, { key: 'low_yield', word: 'Low yield' }, { key: 'wrong', word: 'Wrong' },
  { key: 'duplicate', word: 'Duplicate' }, { key: 'not_now', word: 'Just not now' },
];
export const REASON_KEYS = SKIP_REASONS.map(r => r.key);
export const SOURCES = ['skip', 'leech', 'slow'];
export const OUTCOMES = ['rewritten', 'suspended', 'kept'];
export const LEECH = Object.freeze({ lapses: 8, recent_lapses: 4, recent_days: 30 });
export const SLOW = Object.freeze({ min_reviews: 3, percentile: 90, window_days: 90 });
export const RECHECK_DAYS = 30, NOT_NOW_DAYS = 7;
export const FIX_DECKS = ['Step 2 — My Cards', 'Step 2 — Re-tests'];
// The night's window in London time, [hour, minute] inclusive; the nightly Claude session starts at 00:43.
export const NIGHT_FROM = [23, 30], NIGHT_TO = [0, 35];
export const NIGHT_SOURCE = 'card_fix.night';
const DAY_MS = 86_400_000, NOTE_MAX = 200, RATINGS_MAX = 400, SKIP_ID_RE = /^[\w:.-]{6,120}$/;
const ANKI_MS = 25_000;

const noTable = e => /no such table|no such column|CHECK constraint/i.test(String(e && e.message));
const parse = (s, d = {}) => { try { const o = typeof s === 'string' ? JSON.parse(s) : s; return o && typeof o === 'object' ? o : d; } catch { return d; } };
const posInt = v => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
export const fixId = (user, cardId) => userKey(user, `card_fix:${cardId}`);
const reasonWord = k => (SKIP_REASONS.find(r => r.key === k) || {}).word || null;

/** The queue item's label, in plain words (what map_queue shows first). */
export function fixLabel(ctx) {
  const c = ctx || {};
  if (c.source === 'leech') return `Leech: forgotten ${Number(c.lapses) || 0} times${Number(c.lapses_30d) ? `, ${Number(c.lapses_30d)} in the last 30 days` : ''}`;
  if (c.source === 'slow') return `Slow card: ${Number(c.median_s) || 0} seconds a review, your usual slowest is ${Number(c.p90_s) || 0}`;
  const why = reasonWord(c.reason);
  return why && c.reason !== 'not_now' ? `Skipped by you: ${why.toLowerCase()}` : 'Skipped by you';
}

/** "30 Oct again 42 s; 28 Oct good 25 s" from card_reviews rows (newest first), at most 400 characters. */
export function ratingsLine(reviews) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out = [];
  for (const r of (Array.isArray(reviews) ? reviews : []).slice(0, 10)) {
    const at = typeof r.at === 'string' ? Date.parse(r.at) : Number(r.at ?? r.review_id);   // card_reviews: at, and review_id (epoch ms)
    const word = r.rating || ({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' })[Number(r.ease)];
    if (!Number.isFinite(at) || !word) continue;
    const d = londonDay(at);
    out.push(`${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${word}${Number(r.time_ms) > 0 ? ` ${Math.round(Number(r.time_ms) / 1000)} s` : ''}`);
  }
  let s = out.join('; ');
  while (s.length > RATINGS_MAX) s = s.slice(0, s.lastIndexOf(';'));
  return s || null;
}

// Only the fields map_queue shows (topics.js CONTEXT_KEYS), each short; skip_id and prev_status are bookkeeping.
const CTX_KEYS = ['card_id', 'note_id', 'deck', 'source', 'reason', 'why', 'ratings', 'lapses', 'lapses_30d', 'median_s', 'p90_s', 'skip_id', 'prev_status', 'prev_source', 'set_aside_at'];
function cleanCtx(c) {
  const out = {};
  for (const k of CTX_KEYS) {
    const v = c[k];
    if (v == null || v === '') continue;
    out[k] = typeof v === 'string' ? v.slice(0, k === 'ratings' ? RATINGS_MAX : 120) : v;
  }
  return out;
}

/**
 * The card_fix row after one action (pure). prev: the stored row ({status, context_json, refs, first_seen_at, ...}) or
 * null. action: 'queue' (a skip, leech or slow card), 'reason' (a chip) or 'undo' (Undo after a skip). input: {card_id,
 * skip_id?, source?, reason?, note_id?, deck?, ratings?, why?, lapses?, ...}. Returns {row} (the whole row to write),
 * {remove: true} (an undone skip that had made the row) or {same: true} (nothing to change).
 *   - The same skip twice (a resend, or the chip that arrived before the bury) only fills fields still missing.
 *   - A skip of a card Claude already settled opens it again and remembers the old status, so Undo puts it back.
 *   - Just not now sets the item aside (rejected) or puts back the status it had before the skip.
 */
export function nextFixRow(prev, action, input, now = Date.now()) {
  const card = posInt(input.card_id);
  if (!card) return { same: true };
  const pc = prev ? parse(prev.context_json) : {};
  const fresh = (status, ctx, extra = {}) => {
    const c = cleanCtx({ card_id: card, ...ctx });
    return { row: { kind: 'card_fix', label_norm: `card_fix:${card}`, label_raw: fixLabel(c), context_json: JSON.stringify(c), candidates_json: '[]',
      refs: (prev ? Number(prev.refs) || 0 : 0) + (extra.bump === false ? 0 : 1), first_seen_at: prev ? prev.first_seen_at : now, last_seen_at: now, status,
      ...(extra.result_json !== undefined ? { result_json: extra.result_json } : {}) } };
  };
  const sameSkip = !!(input.skip_id && pc.skip_id && pc.skip_id === input.skip_id);
  const open = prev && (prev.status === 'open' || prev.status === 'claimed');
  const fill = { note_id: input.note_id, deck: input.deck, ratings: input.ratings };
  if (action === 'queue') {
    const src = SOURCES.includes(input.source) ? input.source : 'skip';
    // The night's leech or slow card: a card already waiting stays as it is.
    if (src !== 'skip') return open ? { same: true } : fresh('open', { ...input, source: src, card_id: card, prev_status: prev ? prev.status : null });
    if (sameSkip) {
      const add = Object.fromEntries(Object.entries(fill).filter(([k, v]) => v != null && v !== '' && pc[k] == null));
      return Object.keys(add).length ? fresh(prev.status, { ...pc, ...add }, { bump: false }) : { same: true };
    }
    // A skip of a card already waiting (a leech, or an earlier skip): it stays open, and Undo leaves it waiting.
    if (open) {
      const given = Object.fromEntries(Object.entries({ ...fill, reason: input.reason }).filter(([, v]) => v != null && v !== ''));
      return fresh(prev.status, { ...pc, ...given, skip_id: input.skip_id, source: 'skip', prev_status: prev.status, prev_source: pc.source || null });
    }
    return fresh('open', { ...input, source: 'skip', card_id: card, prev_status: prev ? prev.status : null });
  }
  if (action === 'reason') {
    if (!REASON_KEYS.includes(input.reason)) return { same: true };
    const notNow = input.reason === 'not_now';
    if (!prev || (!sameSkip && !open)) {
      return fresh(notNow ? 'rejected' : 'open', { ...fill, skip_id: input.skip_id, reason: input.reason, source: 'skip', prev_status: prev ? prev.status : null,
        ...(notNow ? { set_aside_at: now } : {}) }, notNow ? { result_json: JSON.stringify({ reject: 'Just not now', at: now }) } : {});
    }
    if (!notNow) return fresh(prev.status === 'rejected' ? 'open' : prev.status, { ...pc, reason: input.reason }, { bump: false });
    // Just not now: back to what it was before this skip (Claude's earlier verdict), else set aside.
    const back = pc.prev_status === 'resolved' || pc.prev_status === 'rejected' ? pc.prev_status : 'rejected';
    return fresh(back, { ...pc, reason: 'not_now', set_aside_at: now }, { bump: false, ...(back === 'rejected' && pc.prev_status !== 'rejected' ? { result_json: JSON.stringify({ reject: 'Just not now', at: now }) } : {}) });
  }
  if (action === 'undo') {
    if (!prev || !sameSkip) return { same: true };
    if (!pc.prev_status) return { remove: true };
    const { skip_id, reason, prev_status, prev_source, set_aside_at, ...rest } = pc;
    return fresh(prev_status, prev_source ? { ...rest, source: prev_source } : rest, { bump: false });
  }
  return { same: true };
}

const QCOLS = ['kind', 'label_norm', 'label_raw', 'context_json', 'candidates_json', 'refs', 'first_seen_at', 'last_seen_at', 'status'];
/** The statement that writes one nextFixRow answer (null for {same}). */
function writeStatement(env, user, id, prev, out) {
  if (out.same) return null;
  if (out.remove) return env.DB.prepare('DELETE FROM topic_queue WHERE user_id = ? AND id = ?').bind(user, id);
  const r = out.row;
  if (!prev) {
    return env.DB.prepare(`INSERT INTO topic_queue (id, user_id, ${QCOLS.join(', ')}${r.result_json !== undefined ? ', result_json' : ''})
      VALUES (?, ?, ${QCOLS.map(() => '?').join(', ')}${r.result_json !== undefined ? ', ?' : ''})
      ON CONFLICT(id) DO NOTHING`).bind(id, user, ...QCOLS.map(c => r[c]), ...(r.result_json !== undefined ? [r.result_json] : []));
  }
  return env.DB.prepare(`UPDATE topic_queue SET ${QCOLS.map(c => `${c} = ?`).join(', ')}${r.result_json !== undefined ? ', result_json = ?' : ''}
    WHERE user_id = ? AND id = ?`).bind(...QCOLS.map(c => r[c]), ...(r.result_json !== undefined ? [r.result_json] : []), user, id);
}

async function readRows(env, user, ids) {
  if (!ids.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT id, kind, status, context_json, result_json, refs, first_seen_at, last_seen_at FROM topic_queue
      WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || [];
  return new Map(rows.map(r => [r.id, r]));
}

/**
 * One action on one card's queue item: {card_id, action, skip_id?, reason?, source?, note_id?, deck?, ratings?}. Returns
 * {ok, card_id, queued (open now), status, reason}. A table without the card_fix kind yet (before 0077) answers
 * {ok: false, waiting: true}.
 */
export async function queueFix(env, user, action, input, now = Date.now()) {
  const card = posInt(input.card_id);
  if (!card) throw new HttpError(400, 'That is not an Anki card id.');
  const id = fixId(user, card);
  try {
    const prev = (await readRows(env, user, [id])).get(id) || null;
    const out = nextFixRow(prev, action, { ...input, card_id: card }, now);
    const st = writeStatement(env, user, id, prev, out);
    if (st) await st.run();
    const row = out.row || (out.remove ? null : prev);
    const ctx = row ? parse(row.context_json) : {};
    return { ok: true, card_id: card, queued: !!row && (row.status === 'open' || row.status === 'claimed'), status: row ? row.status : null, reason: ctx.reason || null };
  } catch (e) {
    if (noTable(e)) return { ok: false, card_id: card, waiting: true };
    throw e;
  }
}

function noteSkip(env, action, input, r) {
  if (!r || !r.ok) return null;
  if (action === 'queue' && (input.source || 'skip') === 'skip' && r.queued) return noteJob(env, { job: 'card_fix', key: `skip:${londonDay()}`, ref: 'skip', add: true, counts: { skipped: 1 } });
  if (action === 'reason' && input.reason === 'not_now') return noteJob(env, { job: 'card_fix', key: `skip:${londonDay()}`, ref: 'skip', add: true, counts: { not_now: 1 } });
  if (action === 'undo') return noteJob(env, { job: 'card_fix', key: `skip:${londonDay()}`, ref: 'skip', add: true, counts: { undone: 1 } });
  return null;
}

/**
 * Queue one skipped card from a hub page (cards.js bury, once Anki has the bury), its recent ratings read from Anki in
 * the background. Never throws: a queue that cannot be written is a Recent activity line, the bury already stands.
 */
export async function queueSkip(env, user, input, ctx = null) {
  try {
    const r = await queueFix(env, user, 'queue', { ...input, source: 'skip' });
    await noteSkip(env, 'queue', { source: 'skip' }, r);
    if (r.ok && !input.ratings) {
      const more = recentRatings(env, r.card_id).then(ratings => ratings && queueFix(env, user, 'queue', { card_id: r.card_id, skip_id: input.skip_id, ratings, source: 'skip' }))
        .catch(() => null);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(more); else await more;
    }
    if (!r.ok) await noteJob(env, { job: 'card_fix', key: `skip:${londonDay()}`, ref: 'skip', state: 'held', add: true, counts: { waiting: 1 }, detail: 'The hub needs migration 0077 before skipped cards can wait for Claude' });
    return r;
  } catch (e) {
    console.error('card_fix: skip not queued', e && e.message);
    await noteJob(env, { job: 'card_fix', key: `skip:${londonDay()}`, ref: 'skip', state: 'failed', add: true, counts: { failed: 1 }, detail: e });
    return { ok: false, error: true };
  }
}

/** Undo after a Skip on a hub page (cards.js undo, once Anki has un-buried it): the card stops waiting for Claude. Never throws. */
export async function unqueueSkip(env, user, input) {
  try {
    const r = await queueFix(env, user, 'undo', input);
    await noteSkip(env, 'undo', input, r);
    return r;
  } catch (e) { console.error('card_fix: skip undo not applied', e && e.message); return { ok: false }; }
}

/** The card's last few ratings from Anki's review log (card_reviews), as ratingsLine words; null when Anki cannot say. */
export async function recentRatings(env, cardId) {
  try {
    const r = await ankiCall(env, 'card_reviews', { card_ids: [cardId], after_review_id: Date.now() - 120 * DAY_MS, limit: 200 }, { timeoutMs: 10_000 });
    const list = (Array.isArray(r && r.reviews) ? r.reviews : []).filter(x => [1, 2, 3, 4].includes(Number(x.ease)));
    return ratingsLine(list.reverse());
  } catch { return null; }
}

/**
 * POST /api/cards/:id/skip {action, skip_id, reason?, source?, note_id?, deck?, ratings?}: the queue side of a skip.
 *   queue   from Anki Voice's outbox (a skip by voice or on its page): the card waits for Claude.
 *   reason  a chip tapped after Skip (Badly worded, Low yield, Wrong, Duplicate, Just not now).
 *   undo    Undo after Skip: the queueing is taken back (the hub page's Undo un-buries through /api/cards/undo).
 */
export async function skipRoute(request, env, ctx, params, url, user) {
  const card = posInt(params.id);
  if (!card) throw new HttpError(400, 'That is not an Anki card id.');
  const b = await readJson(request, 4000);
  const action = b.action || (b.reason ? 'reason' : 'queue');
  if (!['queue', 'reason', 'undo'].includes(action)) throw new HttpError(400, 'action is queue, reason or undo.');
  const skipId = b.skip_id == null ? null : String(b.skip_id);
  if (skipId != null && !SKIP_ID_RE.test(skipId)) throw new HttpError(400, 'skip_id is the skip\'s own id.');
  if (action !== 'queue' && !skipId) throw new HttpError(400, 'A reason or an undo names its skip (skip_id).');
  if (action === 'reason' && !REASON_KEYS.includes(b.reason)) throw new HttpError(400, `reason is one of ${REASON_KEYS.join(', ')}.`);
  if (b.source != null && !SOURCES.includes(b.source)) throw new HttpError(400, `source is one of ${SOURCES.join(', ')}.`);
  const input = { card_id: card, skip_id: skipId, reason: REASON_KEYS.includes(b.reason) ? b.reason : null, source: b.source || 'skip',
    note_id: posInt(b.note_id), deck: typeof b.deck === 'string' ? b.deck.slice(0, 120) : null,
    ratings: typeof b.ratings === 'string' ? b.ratings.slice(0, RATINGS_MAX) : null };
  const r = await queueFix(env, user, action, input);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.resolve(noteSkip(env, action, input, r)));
  else await noteSkip(env, action, input, r);
  return json(r);
}

// ---------------------------------------------------------------- the night's leeches and slow cards

/** London's hour and minute at ms. */
export function londonClock(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = t => Number((parts.find(p => p.type === t) || {}).value);
  return [get('hour'), get('minute')];
}
/** Whether ms falls in the night's window (23:30 to 00:35 London), and the night it belongs to (the London day it ends on). */
export function nightOf(ms) {
  const [h, m] = londonClock(ms);
  const mins = h * 60 + m, from = NIGHT_FROM[0] * 60 + NIGHT_FROM[1], to = NIGHT_TO[0] * 60 + NIGHT_TO[1];
  return { open: mins >= from || mins <= to, night: londonDay(ms + 3 * 3600_000) };
}

/**
 * Which of the night's candidates to queue (pure). candidates: deck_health {mode: 'fix'}'s cards [{card_id, note_id, deck,
 * why: leech | slow, lapses, lapses_30d, median_s, p90_s, reviews, ratings}]; rows: Map id -> stored card_fix row. Leaves
 * out a card already waiting, one Claude settled in the last 30 days, and one set aside with Just not now in the last 7.
 * Returns {queue: [{id, input, prev}], skipped: {waiting, recent, not_now}}.
 */
export function pickFixes(user, candidates, rows, now = Date.now()) {
  const queue = [], skipped = { waiting: 0, recent: 0, not_now: 0 }, seen = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const card = posInt(c && c.card_id);
    if (!card || seen.has(card)) continue;
    seen.add(card);
    const id = fixId(user, card), prev = rows.get(id) || null;
    if (prev) {
      const pc = parse(prev.context_json), res = parse(prev.result_json);
      if (prev.status === 'open' || prev.status === 'claimed') { skipped.waiting++; continue; }
      const at = Number(res.at) || Number(prev.last_seen_at) || 0;
      if (prev.status === 'resolved' && now - at < RECHECK_DAYS * DAY_MS) { skipped.recent++; continue; }
      if (prev.status === 'rejected' && now - (Number(pc.set_aside_at) || at) < NOT_NOW_DAYS * DAY_MS) { skipped.not_now++; continue; }
    }
    const source = c.why === 'slow' ? 'slow' : 'leech';
    const why = source === 'leech'
      ? `Forgotten ${Number(c.lapses) || 0} times${Number(c.lapses_30d) ? `, ${Number(c.lapses_30d)} in the last 30 days` : ''}`
      : `Median ${Number(c.median_s) || 0} s over ${Number(c.reviews) || 0} reviews; your 90th percentile is ${Number(c.p90_s) || 0} s`;
    queue.push({ id, prev, input: { card_id: card, note_id: posInt(c.note_id), deck: typeof c.deck === 'string' ? c.deck : null, source, why,
      lapses: Number(c.lapses) || 0, lapses_30d: Number(c.lapses_30d) || 0, median_s: Number(c.median_s) || null, p90_s: Number(c.p90_s) || null,
      ratings: typeof c.ratings === 'string' ? c.ratings : null } });
  }
  return { queue, skipped };
}

export async function cardFixNight(env, user = 'mo', { at = Date.now(), force = false } = {}) {
  const now = Number(at) || Date.now();
  const { open, night } = nightOf(now);
  if (!open && !force) return { skipped: 'not the night' };
  let state;
  try { state = await env.DB.prepare('SELECT cursor, next_at FROM sync_state WHERE user_id = ? AND source = ?').bind(user, NIGHT_SOURCE).first(); } catch (e) { if (noTable(e)) return { skipped: 'no table' }; throw e; }
  if (state && state.cursor === night && !force) return { skipped: 'done' };
  if (state && Number(state.next_at) > now && !force) return { skipped: 'waiting' };
  const mark = (cursor, nextAt, error = null) => env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, next_at, fails, last_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = coalesce(excluded.cursor, sync_state.cursor), last_ok_at = coalesce(excluded.last_ok_at, sync_state.last_ok_at),
      next_at = excluded.next_at, fails = CASE WHEN excluded.last_error IS NULL THEN 0 ELSE sync_state.fails + 1 END, last_error = excluded.last_error`)
    .bind(user, NIGHT_SOURCE, cursor, error ? null : now, nextAt, error ? 1 : 0, error).run();
  let r;
  try {
    r = await ankiCall(env, 'deck_health', { mode: 'fix', decks: FIX_DECKS, leech_lapses: LEECH.lapses, recent_lapses: LEECH.recent_lapses, recent_days: LEECH.recent_days,
      slow_min_reviews: SLOW.min_reviews, slow_percentile: SLOW.percentile, slow_days: SLOW.window_days }, { timeoutMs: ANKI_MS });
  } catch (e) {
    const msg = e instanceof AnkiError ? e.message : String(e && e.message || e);
    await mark(null, now + 10 * 60_000, msg.slice(0, 200));
    await noteJob(env, { job: 'card_fix', key: `queue:${night}`, ref: 'queue', state: 'failed', counts: { night }, detail: `Anki Voice could not be asked for leeches and slow cards: ${msg}` });
    return { failed: true, error: msg };
  }
  if (!r || !Array.isArray(r.fix_cards)) {
    await mark(night, null);
    await noteJob(env, { job: 'card_fix', key: `queue:${night}`, ref: 'queue', state: 'held', counts: { night }, detail: 'Anki Voice needs its update before it can list leeches and slow cards' });
    return { held: true };
  }
  const ids = [...new Set(r.fix_cards.map(c => posInt(c && c.card_id)).filter(Boolean))].map(c => fixId(user, c));
  let rows;
  try { rows = await readRows(env, user, ids); } catch (e) { if (noTable(e)) return { skipped: 'no table' }; throw e; }
  const pick = pickFixes(user, r.fix_cards, rows, now);
  const stmts = pick.queue.map(q => writeStatement(env, user, q.id, q.prev, nextFixRow(q.prev, 'queue', q.input, now))).filter(Boolean);
  try {
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  } catch (e) {
    if (noTable(e)) {
      await mark(night, null);
      await noteJob(env, { job: 'card_fix', key: `queue:${night}`, ref: 'queue', state: 'held', counts: { night }, detail: 'The hub needs migration 0077 before cards can wait for Claude' });
      return { held: true };
    }
    throw e;
  }
  let waiting = 0;
  try { waiting = Number((await env.DB.prepare(`SELECT count(*) AS n FROM topic_queue WHERE user_id = ? AND kind = 'card_fix' AND status IN ('open', 'claimed')`).bind(user).first() || {}).n) || 0; } catch { waiting = 0; }
  const leeches = pick.queue.filter(q => q.input.source === 'leech').length, slow = pick.queue.length - leeches;
  await mark(night, null);
  await noteJob(env, { job: 'card_fix', key: `queue:${night}`, ref: 'queue', counts: { night, leeches, slow, waiting, already: pick.skipped.waiting,
    recent: pick.skipped.recent, not_now: pick.skipped.not_now, p90: Number(r.p90_s) || 0 } });
  return { night, leeches, slow, waiting, skipped: pick.skipped };
}

// ---------------------------------------------------------------- Claude's verdicts (map_resolve's card_fix items)

const OUTCOME_WORD = { rewritten: 'rewritten', suspended: 'suspended', kept: 'kept' };
/** What kind of suspension a note says: duplicate when it says so, else low yield (the rules ask it to start with one). */
export const suspendKind = note => (/\bduplicate\b/i.test(String(note || '')) ? 'duplicate' : /\bwrong\b/i.test(String(note || '')) && !/\blow.?yield\b/i.test(String(note || '')) ? 'wrong' : 'low_yield');

/**
 * QUEUE_HANDLERS.card_fix (topics.js planQueueResolve): each item {queue_id, action, note} (action, not outcome: guard.js
 * keeps outcome for code's own verdicts). The item is resolved with {action, note, card_id, source, reason, at} in
 * result_json; its event (card.fixed, quiet on Recent activity: the night's one line counts them) is undone by
 * undoCardFix. Returns a part {rows, events, results (each with fixed: the action), problems}.
 */
export async function cardFixHandler(env, user, entries, ctx) {
  const rows = [], events = [], results = [], problems = [];
  for (const { item, arg } of entries) {
    const why = p => problems.push({ queue_id: item.id, problem: p });
    if (arg.topic_id != null || arg.new_topic != null || arg.reject != null) { why('A card to fix takes action and note, not a topic.'); continue; }
    if (!OUTCOMES.includes(arg.action)) { why('Give action: rewritten, suspended or kept.'); continue; }
    const note = typeof arg.note === 'string' ? arg.note.replace(/\s+/g, ' ').trim() : '';
    if (!note || note.length > NOTE_MAX) { why(`Give note: one line on what was done and why, at most ${NOTE_MAX} characters.`); continue; }
    const c = item.context || parse(item.context_json);
    const card = posInt(c.card_id) || posInt(String(item.id).split('card_fix:')[1]);
    const result = { action: arg.action, note, card_id: card, source: c.source || null, reason: c.reason || null, at: ctx.now,
      ...(arg.action === 'suspended' ? { kind: suspendKind(note) } : {}) };
    rows.push({ table: 'topic_queue', op: 'update', key: { id: item.id },
      before: { status: item.status, resolved_topic_id: item.resolved_topic_id ?? null, resolved_by: item.resolved_by ?? null, result_json: item.result_json ?? null },
      after: { status: 'resolved', resolved_topic_id: null, resolved_by: ctx.actor === 'mo' ? 'mo' : ctx.actor === 'code' ? 'code' : 'claude', result_json: JSON.stringify(result) } });
    events.push({ kind: 'card.fixed', target_type: 'queue', target_id: item.id, topic_id: null, summary: `Card ${card} ${OUTCOME_WORD[arg.action]}: ${note}`.slice(0, 160) });
    results.push({ queue_id: item.id, card_id: card, fixed: arg.action, ...(result.kind ? { kind: result.kind } : {}) });
  }
  return { rows, events, results, problems };
}

/**
 * UNDO['card.fixed'] (undo.js): the card is put back in Anki first (Anki Voice's edit_card {which: 'revert', card_id}: the
 * fields before Claude's rewrite, or unsuspended), then the item waits for Claude again. A kept card needs nothing in
 * Anki. When Anki Voice cannot put it back, nothing is undone and the reason says why. Undoing this undo only closes the
 * item again; it does not redo the edit in Anki.
 */
export async function undoCardFix(env, user, ev) {
  const after = parse(ev.after_json), before = parse(ev.before_json);
  const res = parse(after.result_json);
  const cur = await env.DB.prepare('SELECT status, result_json FROM topic_queue WHERE user_id = ? AND id = ?').bind(user, ev.target_id).first();
  if (!cur) return { conflict: 'That card is no longer in the queue.' };
  if (cur.status !== 'resolved' || String(cur.result_json || '') !== String(after.result_json || '')) return { conflict: 'That card was changed again since; undo the later change first.' };
  if (res.action && res.action !== 'kept' && res.card_id) {
    try {
      await ankiCall(env, 'edit_card', { which: 'revert', card_id: Number(res.card_id) }, { timeoutMs: 20_000 });
    } catch (e) {
      const msg = String(e && e.message || e).replace(/^Anki: /, '');
      if (!/nothing to (put back|revert)|no change by claude/i.test(msg)) return { conflict: `Anki Voice could not put card ${res.card_id} back (${msg.slice(0, 120)}), so nothing was undone.` };
    }
  }
  const set = { status: before.status ?? 'open', resolved_topic_id: before.resolved_topic_id ?? null, resolved_by: before.resolved_by ?? null, result_json: before.result_json ?? null };
  return { rows: [{ table: 'topic_queue', op: 'update', key: { id: ev.target_id }, before: { status: cur.status, resolved_topic_id: null, resolved_by: after.resolved_by ?? null, result_json: cur.result_json }, after: set }] };
}

/**
 * The night's "Cards reviewed by Claude" line (Recent activity, one a London day), added to as each map_resolve settles
 * card_fix items: results are queue.resolve's reply results; those with fixed (the action) count. Never throws.
 */
export async function noteFixed(env, results, at = Date.now()) {
  const fixed = (Array.isArray(results) ? results : []).filter(r => r && OUTCOMES.includes(r.fixed));
  if (!fixed.length) return false;
  const counts = { rewritten: 0, suspended: 0, low_yield: 0, duplicate: 0, wrong: 0, kept: 0 };
  for (const r of fixed) {
    counts[r.fixed]++;
    if (r.fixed === 'suspended') counts[r.kind && counts[r.kind] != null ? r.kind : 'low_yield']++;
  }
  return noteJob(env, { job: 'card_fix', key: `review:${londonDay(at)}`, ref: 'review', add: true, counts, at });
}
