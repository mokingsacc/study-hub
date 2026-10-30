import { HttpError, json, readJson, now } from './util.js';
import { ankiCall, ankiCallFull, AnkiError } from './anki.js';

export const RATINGS = ['again', 'hard', 'good', 'easy'];   // ease 1..4, as Anki numbers them
export const DEFAULT_DECK = 'Step 2 — My Cards';
const KEEP_KEYS_MS = 30 * 86_400_000;
const FAST_MS = 15_000, IMAGES_MS = 25_000;
const KEY_RE = /^[\w:.-]{8,120}$/;

function ankiHttp(e) {
  if (!(e instanceof AnkiError)) return e;
  if (/not connected/.test(e.message)) return new HttpError(503, e.message);
  return new HttpError(e.ambiguous ? 504 : 502, e.message);
}
async function anki(env, name, args = {}, timeoutMs = FAST_MS) {
  try { return await ankiCall(env, name, args, { timeoutMs }); } catch (e) { throw ankiHttp(e); }
}

// Anki's queue of the card on screen (card.queue: 0 new, 1 learning, 2 review, 3 learning across days), as a word.
const QUEUE = { 0: 'new', 1: 'learning', 2: 'review', 3: 'learning', new: 'new', learning: 'learning', learn: 'learning', review: 'review' };

/** The card as the page needs it: the server's fields only, nothing added. done: nothing is due. queue, when the
 * server says it, lets the page underline that count as Anki does. */
export function shapeCard(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.done) return { done: true, remaining: c.remaining || null };
  const queue = c.queue != null ? QUEUE[String(c.queue).toLowerCase()] : null;
  return { done: false, card_id: Number(c.card_id), question: String(c.question || ''), answer: String(c.answer || ''),
    notes: String(c.notes || ''), deck: c.deck ? String(c.deck) : null, remaining: c.remaining || null, image_count: Number(c.image_count) || 0,
    ...(queue ? { queue } : {}) };
}

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const sameDeck = (current, wanted) => !wanted || norm(current) === norm(wanted) || (norm(current).startsWith(norm(wanted)) && String(current || '').includes('::'));

const shapeDecks = list => (Array.isArray(list) ? list : []).map(d => ({ name: String(d.name), due: Number(d.due) || 0,
  new: Number(d.new) || 0, learning: Number(d.learning) || 0, review: Number(d.review) || 0 }));

const cardId = params => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'That is not an Anki card id.');
  return id;
};

// GET /api/cards/open?deck=NAME: the card on top of Anki's queue and the decks, in one call. When Anki is reviewing
// another deck it is switched first (set_deck, which the server also remembers for Anki Voice).
export async function open(request, env, ctx, params, url) {
  const wanted = String(url.searchParams.get('deck') || '').slice(0, 120);
  const t0 = Date.now();
  let [card, decks] = await Promise.all([anki(env, 'get_next_card'), anki(env, 'list_decks').catch(() => null)]);
  let current = decks && decks.current ? String(decks.current) : null;
  if (wanted && decks && !sameDeck(current, wanted)) {
    const set = await anki(env, 'set_deck', { name: wanted });
    current = (set && set.deck && set.deck.name) || wanted;
    card = await anki(env, 'get_next_card');
  }
  return json({ card: shapeCard(card), deck: current, decks: decks ? shapeDecks(decks.decks) : null, ms: Date.now() - t0 });
}

// GET /api/cards/decks
export async function decks(request, env) {
  const r = await anki(env, 'list_decks');
  return json({ decks: shapeDecks(r && r.decks), current: r && r.current ? String(r.current) : null });
}

// POST /api/cards/deck {name}: review another deck from now on; answers its first card.
export async function deck(request, env) {
  const b = await readJson(request, 2000);
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  if (!name) throw new HttpError(400, 'Choose a deck.');
  const set = await anki(env, 'set_deck', { name });
  const card = await anki(env, 'get_next_card');
  return json({ deck: (set && set.deck && set.deck.name) || name, due: (set && set.due) || null, card: shapeCard(card) });
}

// POST /api/cards/start: start_session (syncs with AnkiWeb first). Optional: the page opens with /open and never waits on it.
export async function start(request, env) {
  const r = await anki(env, 'start_session', {}, 60_000);
  return json({ deck: r && r.deck ? r.deck.name : null, due: (r && r.due) || null, sync: r && r.sync ? { ok: !r.sync.error } : null });
}

// GET /api/cards/next
export async function next(request, env) {
  return json({ card: shapeCard(await anki(env, 'get_next_card')) });
}

// GET /api/cards/:id/intervals: the next interval of each rating (reveal_answer's next_intervals), asked for in the
// background as soon as a card is on screen, so the rating buttons can say "10m · 1d · 3d · 8d".
export async function intervals(request, env, ctx, params) {
  const r = await anki(env, 'reveal_answer', { card_id: cardId(params) });
  const out = {};
  for (const k of RATINGS) if (r && r.next_intervals && typeof r.next_intervals[k] === 'string') out[k] = r.next_intervals[k].slice(0, 20);
  return json({ intervals: out });
}

// GET /api/cards/:id/images: the card's pictures as data URLs, each with the note field it came from (the page
// shows a field of the front before the answer and the rest after it).
export async function images(request, env, ctx, params) {
  let r;
  try { r = await ankiCallFull(env, 'get_card_images', { card_id: cardId(params), max_images: 6 }, { timeoutMs: IMAGES_MS }); } catch (e) { throw ankiHttp(e); }
  const shown = Array.isArray(r.payload && r.payload.pictures) ? r.payload.pictures : [];
  const pictures = r.images.map((img, i) => ({ field: String((shown[i] && shown[i].field) || ''), src: `data:${img.mimeType};base64,${img.data}` }));
  const res = json({ card_id: cardId(params), pictures, note: (r.payload && (r.payload.note || null)) || null });
  res.headers.set('Cache-Control', 'private, max-age=3600');
  return res;
}

// GET /api/cards/notes?ids=1,2: each card's note id (find_cards by card_ids), for the review's upload.
export async function notes(request, env, ctx, params, url) {
  const ids = String(url.searchParams.get('ids') || '').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 20);
  if (!ids.length) return json({ notes: {} });
  const r = await anki(env, 'find_cards', { card_ids: ids });
  const out = {};
  for (const c of (r && r.cards) || []) if (c && c.card_id && c.note_id) out[c.card_id] = Number(c.note_id);
  return json({ notes: out });
}

export const rate = (request, env, ctx, params) => applyOnce('rate', request, env, ctx, params);
export const bury = (request, env, ctx, params) => applyOnce('bury', request, env, ctx, params);
// POST /api/cards/:id/suspend {review_id, shown_at}: the same exactly-once path (card_rates kind 'suspend'). Anki's
// suspend_card works on any card and never suspends twice, so a newer review elsewhere does not stop it. A server
// without suspend_card yet refuses it as an unknown tool: 409 "Suspending needs the Anki server update", final, so
// the page drops it from its outbox and the card simply comes back.
export const suspend = (request, env, ctx, params) => applyOnce('suspend', request, env, ctx, params);
export const NEEDS_SUSPEND = 'Suspending needs the Anki server update.';
export const NEEDS_UNDO = 'Undo needs the Anki server update.';

const SENT_BUSY_MS = 30_000, FRESH_MS = 5 * 60_000;
const ms = v => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Anki's newer reviews of the card after `after` (epoch ms), or null when the server cannot say (no card_reviews). */
export async function reviewsSince(env, cardId, after) {
  try {
    const r = await ankiCall(env, 'card_reviews', { card_ids: [cardId], after_review_id: after, limit: 5 }, { timeoutMs: FAST_MS });
    return (Array.isArray(r && r.reviews) ? r.reviews : []).filter(x => Number(x.review_id) > after && [1, 2, 3, 4].includes(Number(x.ease)));
  } catch (e) {
    if (e instanceof AnkiError && /unknown tool/i.test(e.message)) return null;
    throw ankiHttp(e);
  }
}

async function applyOnce(kind, request, env, ctx, params) {
  const id = cardId(params);
  const b = await readJson(request, 4000);
  const ease = kind === 'rate' ? Number(b.ease) : 0;
  if (kind === 'rate' && ![1, 2, 3, 4].includes(ease)) throw new HttpError(400, 'The rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy).');
  const key = String(b.review_id || b.key || '');
  if (!KEY_RE.test(key)) throw new HttpError(400, 'The rating needs its review_id.');
  const shownAt = ms(b.shown_at);
  if (!shownAt) throw new HttpError(400, 'The rating needs the time its card was shown.');
  const t = now();
  const claimOnce = () => env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO card_rates (review_id, card_id, kind, ease, shown_at, status, at) VALUES (?, ?, ?, ?, ?, 'sent', ?)`).bind(key, id, kind, ease, shownAt, t),
    env.DB.prepare('SELECT card_id, kind, ease, status, at FROM card_rates WHERE review_id = ?').bind(key),
    env.DB.prepare('DELETE FROM card_rates WHERE at < ?').bind(t - KEEP_KEYS_MS),
  ]);
  // A rating made just now, on its first send (the usual case), goes straight to rate_card: Anki only hears of a review on
  // another device after AnkiWeb syncs, so a card shown minutes ago cannot have one yet, and rate_card itself never rates
  // a card it no longer has due. Anything older (an offline replay, a resend) reads Anki's log first, beside the claim.
  const fresh = (t - shownAt < FRESH_MS && t >= shownAt) || kind === 'suspend';
  // With the map's due orbs on (I33), the card's due row is re-read after Anki has the change, so the orbs are right
  // within seconds; the module loads only then.
  const dueSoon = () => {
    if (env.DUE_ORBS !== 'on' || !ctx || typeof ctx.waitUntil !== 'function') return;
    ctx.waitUntil(import('./orbits/due.js').then(m => m.refreshDue(env, 'mo', [id])).catch(() => {}));
  };
  const [batch, early] = await Promise.all([claimOnce(), fresh ? null : reviewsSince(env, id, shownAt).catch(e => e)]);
  const claimed = !!(batch[0].meta && batch[0].meta.changes);
  const row = (batch[1].results || [])[0] || null;
  const newer = early || (!claimed && kind !== 'suspend' ? await reviewsSince(env, id, shownAt).catch(e => e) : null);
  const mark = status => {
    const p = env.DB.prepare('UPDATE card_rates SET status = ?, at = ? WHERE review_id = ?').bind(status, now(), key).run().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else return p;
    return null;
  };
  // list: true (the map's subject review, I33): the page holds its own list, so the deck's next card is not asked for.
  const list = b.list === true;
  const top = async extra => { dueSoon(); return json({ ok: true, card_id: id, ...extra, ...(list ? {} : { card: shapeCard(await anki(env, 'get_next_card')) }) }); };
  if (!claimed && row) {
    if (row.status === 'applied') return top({ status: 'applied', already: true, rating: kind === 'rate' ? RATINGS[row.ease - 1] : null });
    if (row.status === 'superseded') return top({ status: 'superseded', superseded: true });
    if (row.status === 'refused') throw new HttpError(409, 'Anki refused this one earlier.');
    if (t - row.at < SENT_BUSY_MS) throw new HttpError(503, 'This rating is being sent right now; trying again shortly.');
  }
  if (newer instanceof Error) throw newer;
  // A retry whose first try did land: Anki's newer review is this server's own (source voice) with this rating.
  if (!claimed && row && newer && newer.some(x => x.source === 'voice' && Number(x.ease) === ease)) {
    await mark('applied');
    return top({ status: 'applied', already: true, rating: RATINGS[ease - 1] });
  }
  if (newer && newer.length) {
    await mark('superseded');
    return top({ status: 'superseded', superseded: true, newer: { ease: Number(newer[0].ease), at: Number(newer[0].review_id) } });
  }
  const t0 = Date.now();
  let r;
  try {
    r = kind === 'rate' ? await rateCard(env, id, RATINGS[ease - 1], b.before_exam === true)
      : await ankiCall(env, kind === 'suspend' ? 'suspend_card' : 'bury_card', { card_id: id }, { timeoutMs: 20_000 });
  } catch (e) {
    if (kind === 'suspend' && e instanceof AnkiError && !e.ambiguous && /unknown tool/i.test(e.message)) { await mark('refused'); throw new HttpError(409, NEEDS_SUSPEND); }
    // A refusal from Anki itself (the card is not due, say) can never apply: final. Anything that may have reached
    // Anki stays 'sent', and the next try reads Anki's log before sending again.
    if (e instanceof AnkiError && !e.ambiguous && /^Anki: /.test(e.message)) { await mark('refused'); throw new HttpError(409, e.message); }
    throw ankiHttp(e);
  }
  const took = Date.now() - t0;
  const by = r && r.already_rated ? r.already_rated.by : null;
  const superseded = !!(by && by !== 'this voice review');
  await mark(superseded ? 'superseded' : 'applied');
  dueSoon();
  return json({ ok: true, card_id: id, status: superseded ? 'superseded' : 'applied', superseded, already: !!by && !superseded,
    rating: kind === 'rate' ? (by ? r.already_rated.rating : r.rating) : null, next_due_in: (r && r.next_due_in) || null,
    remaining: (r && r.remaining) || null, ...(list ? {} : { card: shapeCard(r && r.next_card) }), ms: took,
    ...(r && r.before_exam ? { before_exam: { moved: !!r.before_exam.moved, due: String(r.before_exam.due || '') } } : {}) });
}

async function rateCard(env, id, rating, beforeExam) {
  const args = { card_id: id, rating };
  if (!beforeExam) return ankiCall(env, 'rate_card', args, { timeoutMs: 20_000 });
  try {
    return await ankiCall(env, 'rate_card', { ...args, before_exam: true }, { timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof AnkiError && !e.ambiguous && /before_exam|unexpected|additional|unknown/i.test(e.message)) return ankiCall(env, 'rate_card', args, { timeoutMs: 20_000 });
    throw e;
  }
}

// POST /api/cards/undo {mode: 'last'}: Anki's own undo of the last rating (undo_last), as Cmd-Z does in Anki: the card
// comes back as card (on its front) to be answered and rated again. The page sends it only once its outbox is empty (a
// rating still waiting there never reached Anki, so the page just takes it out). Anki refusing it (the last thing done
// was a bury, say) is a 409 with Anki's reason; a server without undo_last yet is a 409 "Undo needs the Anki server update".
// POST /api/cards/undo {ease}: replace the last rating (change_last_rating: Anki undoes it and rates again).
export async function undo(request, env, ctx) {
  const b = await readJson(request, 2000);
  if (b.mode === 'last') {
    let r;
    try { r = await ankiCall(env, 'undo_last', {}, { timeoutMs: 20_000 }); } catch (e) {
      if (e instanceof AnkiError && !e.ambiguous && /unknown tool/i.test(e.message)) throw new HttpError(409, NEEDS_UNDO);
      if (e instanceof AnkiError && !e.ambiguous && /^Anki: /.test(e.message)) throw new HttpError(409, `${e.message.slice(6)}.`.replace(/\.\.$/, '.'));
      throw ankiHttp(e);
    }
    const u = (r && r.undone) || {};
    // the map's due orbs (I33): the card is due again, so its row is re-read
    if (env.DUE_ORBS === 'on' && Number(u.card_id) && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(import('./orbits/due.js').then(m => m.refreshDue(env, 'mo', [Number(u.card_id)])).catch(() => {}));
    return json({ ok: true, mode: 'last', card_id: Number(u.card_id) || null, undone: RATINGS.includes(u.rating) ? u.rating : null, card: shapeCard(r && r.card) });
  }
  const ease = Number(b.ease);
  if (![1, 2, 3, 4].includes(ease)) throw new HttpError(400, 'Choose the rating it should have been.');
  const r = await anki(env, 'change_last_rating', { rating: RATINGS[ease - 1] });
  return json({ ok: true, card_id: r && r.card_id, rating: r && r.rating, next_due_in: (r && r.next_due_in) || null });
}

// POST /api/cards/end: end_session (pushes the reviews to AnkiWeb).
export async function end(request, env) {
  const r = await anki(env, 'end_session', {}, 60_000);
  return json({ reviewed: (r && r.reviewed) || 0, remaining: (r && r.remaining) || null, sync: r && r.sync ? { ok: !r.sync.error } : null });
}
