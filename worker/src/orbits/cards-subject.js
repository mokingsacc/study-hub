// The subject review (I33 §6.5): one specialty's due cards, reviewed in the Cards pop-up by card id. No change to the
// Anki server: the list comes from card_due and card_home, the text from find_cards {card_ids}, the rating from
// the Cards page's own POST /api/cards/:id/rate with list: true.
import { HttpError, json } from '../util.js';
import { ankiCall, AnkiError } from '../anki.js';
import { shapeCard } from '../cards.js';
import { needDue } from './common.js';
import { inDeck, pillDeck, todayQueue } from './due.js';

const MAX_LIST = 400, MAX_NEW = 50;

/**
 * The order (pure). anki: learning first (soonest first), then reviews, the most overdue first, then the lowest
 * recall. weak: the weakest topic first (t, higher is weaker), then as anki. New cards (when asked for) go last.
 */
export function orderCards(rows, order = 'anki') {
  const kind = r => (r.ctype === 'new' ? 2 : r.ctype === 'review' ? 1 : 0);
  const anki = (a, b) => kind(a) - kind(b)
    || (kind(a) === 0 ? (a.due_at ?? 0) - (b.due_at ?? 0) : 0)
    || (kind(a) === 1 ? String(a.due_day || '').localeCompare(String(b.due_day || '')) : 0)
    || (a.r ?? 1) - (b.r ?? 1) || a.card_id - b.card_id;
  const weak = (a, b) => (kind(a) === 2) - (kind(b) === 2) || (b.t ?? -1) - (a.t ?? -1) || anki(a, b);
  return [...rows].sort(order === 'weak' ? weak : anki);
}

// GET /api/cards/subject/:category/list?deck=&order=anki|weak&new=0|1 (deck: default the due pills' deck). The subject's
// cards of today's queue (due.js todayQueue: learning, review and today's new cards, each card in its one home), so the
// list is the bead's number; new=1 adds the subject's other new cards at the end.
export async function listRoute(request, env, ctx, params, url, user) {
  needDue(env);
  const cat = String(params.category || '').slice(0, 80);
  if (!cat) throw new HttpError(400, 'Which subject?');
  const deck = String(url.searchParams.get('deck') || '').slice(0, 200) || await pillDeck(env);   // no deck: the pills' deck
  const order = url.searchParams.get('order') === 'weak' ? 'weak' : 'anki';
  const withNew = url.searchParams.get('new') === '1';
  const q = await todayQueue(env, user, Date.now(), { deck });
  const today = q.rows.filter(r => r.category_id === cat).slice(0, MAX_LIST);
  const ids = today.map(r => r.card_id);
  const [ts, more] = await env.DB.batch([
    env.DB.prepare(`SELECT ct.card_id, MAX(ts.t) AS t FROM card_topics ct JOIN topic_scores ts ON ts.user_id = ct.user_id AND ts.topic_id = ct.topic_id
      WHERE ct.user_id = ?1 AND ct.removed_at IS NULL AND ct.card_id IN (SELECT value FROM json_each(?2)) GROUP BY ct.card_id`).bind(user, JSON.stringify(ids)),
    env.DB.prepare(`SELECT d.card_id, d.ctype, d.due_day, d.due_at, d.r, d.deck, h.topic_id FROM card_home h JOIN card_due d ON d.user_id = h.user_id AND d.card_id = h.card_id
      WHERE h.user_id = ?1 AND h.category_id = ?2 AND ?3 = 1 AND d.ctype = 'new' AND d.suspended = 0 AND d.buried = 0 AND ${inDeck(4)}
        AND d.card_id NOT IN (SELECT value FROM json_each(?5)) ORDER BY coalesce(d.new_pos, d.card_id) LIMIT ${MAX_NEW}`).bind(user, cat, withNew ? 1 : 0, deck, JSON.stringify(ids)),
  ]);
  const t = new Map((ts.results || []).map(r => [Number(r.card_id), r.t]));
  const rows = today.map(r => ({ ...r, t: t.get(r.card_id) ?? null }));
  const extra = (more.results || []);
  const list = [...orderCards(rows, order), ...orderCards(extra, order)];
  const n = k => rows.filter(x => x.k === k).length;
  return json({ category: cat, day: q.day, order, cards: list.map(x => ({ card_id: x.card_id, ctype: x.ctype, due_day: x.due_day || null, deck: x.deck || null, topic_id: x.topic_id || null })),
    remaining: { new: n('new') + extra.length, learning: n('learning'), review: n('review'), total: rows.length + extra.length } });
}

// GET /api/cards/batch?ids=1,2: up to 20 cards' text (find_cards {card_ids}), shaped as the Cards page shapes them.
export async function batchRoute(request, env, ctx, params, url, user) {
  needDue(env);
  const ids = String(url.searchParams.get('ids') || '').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) throw new HttpError(400, 'Which cards?');
  if (ids.length > 20) throw new HttpError(400, 'At most 20 cards at a time.');
  let r;
  try { r = await ankiCall(env, 'find_cards', { card_ids: ids }, { timeoutMs: 15_000 }); } catch (e) {
    if (e instanceof AnkiError) throw new HttpError(/not connected/.test(e.message) ? 503 : e.ambiguous ? 504 : 502, e.message);
    throw e;
  }
  const by = new Map(((r && r.cards) || []).map(c => [Number(c.card_id), c]));
  return json({ cards: ids.map(id => by.get(id)).filter(Boolean).map(c => ({ ...shapeCard(c), note_id: Number(c.note_id) || null })) });
}
