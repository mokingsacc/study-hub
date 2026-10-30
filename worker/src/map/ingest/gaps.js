import { now as nowMs, londonDay } from '../../util.js';
import { gapOrigin, parseRef, releasable, cardDayKey, GAP_SOURCE_LABEL, userKey } from './map-fields.js';
import { gapEvidence } from '../weights.js';
import { mergeCardDay } from '../cards.js';
import { placeTopics, lookups, commit, evidenceStatements, gapQueueItem, hook, learnStatements } from './hub.js';
import { queueStatements } from '../queue.js';
import { gapSafe, GAP_LEFT_OUT } from '../guard.js';
import { gapPair } from '../links.js';

const cap = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The sitting a gap's ref ties it to, from one batch of reads: Map(gapId -> {sitting_id, status}). */
async function sittingsFor(env, gaps) {
  const blockIds = [], names = [];
  for (const g of gaps) {
    const r = parseRef(g.ref);
    if (r && r.kind === 'block') blockIds.push(r.block_id);
    if (r && r.kind === 'sitting') names.push(r.name.toLowerCase());
  }
  const out = new Map();
  if (!blockIds.length && !names.length) return out;
  const [b, s] = await env.DB.batch([
    env.DB.prepare(`SELECT b.id, b.sitting_id, s.status FROM blocks b JOIN sittings s ON s.id = b.sitting_id WHERE b.id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify([...new Set(blockIds)])),
    env.DB.prepare(`SELECT id, lower(name) AS lname, status FROM sittings WHERE kind = 'hub' AND lower(name) IN (SELECT value FROM json_each(?))
      ORDER BY created_at DESC`).bind(JSON.stringify([...new Set(names)])),
  ]);
  const byBlock = new Map(b.results.map(r => [r.id, r]));
  const byName = new Map();
  for (const r of s.results) if (!byName.has(r.lname)) byName.set(r.lname, r);
  for (const g of gaps) {
    const r = parseRef(g.ref);
    const hit = r && r.kind === 'block' ? byBlock.get(r.block_id) : r && r.kind === 'sitting' ? byName.get(r.name.toLowerCase()) : null;
    if (hit) out.set(g.id, { sitting_id: hit.sitting_id || hit.id, status: hit.status });
  }
  return out;
}

/**
 * Map gaps rows ({id, at, day, source, card_id, note_id, ref, topic, gap, said, error_type, verdict, origin?})
 * in one write. Returns {placed, queued, held, batch}.
 */
export async function ingestGaps(env, user, gaps) {
  // Text that reads like question text (a stem read aloud in a recording) never names a queue item or a topic.
  const list = (gaps || []).filter(g => g && g.id && g.gap).map(g => ({ ...gapSafe(g), day: g.day || londonDay(g.at || nowMs()), at: g.at || nowMs() }));
  if (!list.length) return { placed: 0, queued: 0, held: 0 };
  const sittings = await sittingsFor(env, list);
  const cardKeys = list.filter(g => g.card_id != null).map(g => cardDayKey(g.card_id, g.day));
  const existing = new Map();
  if (cardKeys.length) {
    const r = await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))')
      .bind(user, JSON.stringify([...new Set(cardKeys)])).all();
    for (const row of r.results || []) existing.set(row.obs_key, row);
  }
  // The topic Claude named; a gap with none (a spoken cue) is tried by its own words (taxonomy's spans).
  const places = await placeTopics(env, user, list.map(g => ({ texts: [g.topic || (g.gap === GAP_LEFT_OUT ? '' : g.gap)], card_id: g.card_id ?? null, note_id: g.note_id ?? null,
    ref: g.ref || null, gap_id: g.id, source: 'gap', source_ref: g.id })));
  const placed = list.map((g, i) => {
    const s = sittings.get(g.id) || null, place = places[i];
    const held = (s && !releasable(s)) || place.held ? 1 : 0;
    return { g, s: s || (place.sitting_id ? { sitting_id: place.sitting_id } : null), held, place, origin: gapOrigin(g) };
  });
  const look = await lookups(env, user, { topicIds: placed.map(p => p.place.topic_id) });
  const noted = new Map();
  try {
    const r = await env.DB.prepare(`SELECT target_id, topic_id FROM map_events WHERE user_id = ? AND target_type = 'gap' AND kind = 'gap.added' AND undone_by IS NULL
      AND target_id IN (SELECT value FROM json_each(?)) ORDER BY seq`).bind(user, JSON.stringify(list.map(g => g.id))).all();
    for (const e of r.results || []) noted.set(e.target_id, e.topic_id || null);
  } catch (e) { /* no map_events yet: every gap is new */ }
  const t = nowMs();
  const statements = [], upsert = [], heldRows = [], events = [], recompute = [], queue = [], cardLinks = [], stale = [];
  let nPlaced = 0, nQueued = 0, nHeld = 0;
  for (const { g, s, held, place, origin } of placed) {
    const topicId = place.topic_id || null;
    // Its own item, labelled by Claude's topic words or by where and when it was said, never by the gap's words (LS4-1).
    const own = topicId ? null : gapQueueItem(g);
    const item = topicId ? null : place.queue && place.queue.kind === 'gap'
      ? { ...place.queue, label_raw: own.label_raw, label_norm: own.label_norm, context: { ...(place.queue.context || {}), ...own.context } } : own;
    let ev = gapEvidence({ ...g, origin }, {
      topic_id: topicId, queue_id: item ? userKey(user, item.id) : null, label_norm: item ? item.label_norm : null,
      category_id: topicId ? (look.topics.get(topicId) || {}).category_id || null : null, sitting_id: s ? s.sitting_id : null, held,
    });
    // A card's day is one row: a lapse, weak parts and checks merge, and the worst fact names it.
    if (ev.obs_key.startsWith('card:')) {
      const had = existing.get(ev.obs_key) || null;
      ev = mergeCardDay(had, ev);
      // A gap that could not be placed (a spoken cue on a card with two topics) never takes the day's row off the topic
      // another gap of that card already placed it on; the cue waits in the queue by itself.
      if (!topicId && had && had.topic_id) Object.assign(ev, { topic_id: had.topic_id, category_id: had.category_id ?? null, queue_id: had.queue_id ?? null, label_norm: had.label_norm ?? null });
      existing.set(ev.obs_key, ev);
      if (g.source === 'spoken_cue') stale.push(`gap:${g.id}`);
    }
    (held ? heldRows : upsert).push(ev);
    statements.push(env.DB.prepare(`UPDATE gaps SET topic_id = ?, map_state = ?, mapped_at = ?, held = ?, sitting_id = ?, origin = ? WHERE user_id = ? AND id = ?`)
      .bind(topicId, topicId ? 'placed' : 'queued', t, held, s ? s.sitting_id : null, origin, user, g.id));
    if (held) { nHeld++; continue; }
    if (topicId) {
      nPlaced++;
      recompute.push(topicId);
      if (g.card_id != null) cardLinks.push([g.card_id, topicId, checkedOnCard(g, origin) ? 1 : 0]);
    } else {
      nQueued++;
      if (item) queue.push(item);
    }
    const name = topicId ? (look.topics.get(topicId) || {}).name || topicId : null;
    const label = GAP_SOURCE_LABEL[g.source] || g.source;
    if (noted.has(g.id) && noted.get(g.id) === topicId) continue;
    events.push({ kind: 'gap.added', target_type: 'gap', target_id: g.id, topic_id: topicId,
      summary: cap(name ? `Gap noted on ${name} (${label})` : `Gap noted (${label}), not on the map yet`),
      before: null, after: { topic_id: topicId, origin, verdict: g.verdict || 'gap' } });
  }
  // Two gaps on one card the same day are one row: keep the last (worst) version of each key.
  const last = rows => [...new Map(rows.map(r => [r.obs_key, r])).values()];
  statements.push(...evidenceStatements(env, user, last(heldRows), t), ...queueStatements(env, user, queue, t),
    ...learnStatements(env, user, placed.filter(p => !p.held).map(p => p.place), t));
  const w = await commit(env, user, { via: 'hook:gaps', statements, evidence: { upsert: last(upsert), ...(stale.length ? { remove: stale } : {}) }, events, recompute });
  // A placed gap on a card teaches the card its topic (panel's card_topics), so the card's next gap places itself.
  if (cardLinks.length) await hook('card_topics', () => linkCards(env, user, cardLinks, t));
  if (cardLinks.length) await hook('card cues', () => placeCardCues(env, user, placed.filter(p => !p.held && p.place.topic_id && p.g.card_id != null)));
  // A gap that names its look-alike (mixed_with, or "can't tell X from Y") marks that pair mixed up: a versus link.
  const pairs = placed.filter(p => !p.held && p.place.topic_id && (p.g.mixed_with || gapPair(p.g.gap)));
  if (pairs.length) await hook('gap links', () => gapLinks(env, user, pairs));
  return { placed: nPlaced, queued: nQueued, held: nHeld, batch: w && w.batch_id };
}

/** Each placed gap's look-alike as a versus link (links-ingest fromGap), one small code batch per gap. Returns the count. */
export async function gapLinks(env, user, placedGaps) {
  const L = await import('../links-ingest.js');
  let n = 0;
  for (const { g, place, origin } of placedGaps) {
    const part = await L.linkStatements(env, user, { gap: { ...g, topic_id: place.topic_id, origin, held: 0 }, ctx: { now: nowMs() } });
    if (!part || !(part.rows || []).length) continue;
    await commit(env, user, { via: 'hook:gap-links', rows: part.rows, events: part.events || [] });
    n++;
  }
  return n;
}

/**
 * A gap placed on a card's topic places the other gaps of that card and day still waiting in the queue (a spoken
 * "Gap, ..." during the review, saved before the check named the card's topic), so the tray never shows a gap the
 * check has already placed. One queue.resolve as actor code (undoable like any placement). Returns the count placed.
 */
export async function placeCardCues(env, user, placedGaps) {
  const want = new Map();
  for (const p of placedGaps || []) want.set(`${Number(p.g.card_id)}|${p.g.day}`, p.place.topic_id);
  if (!want.size) return 0;
  const cards = [...new Set([...want.keys()].map(k => Number(k.split('|')[0])))];
  const ids = (placedGaps || []).map(p => p.g.id);
  // Each gap waits on its own item, gap:<id>; it is found from the gap itself, since a cue's evidence may already sit
  // in its card's day row, which the check placed.
  const rows = (await env.DB.prepare(`SELECT g.id, g.card_id, g.day, q.id AS queue_id FROM gaps g
      JOIN topic_queue q ON q.user_id = g.user_id AND q.id = ? || g.id AND q.status = 'open'
      WHERE g.user_id = ? AND g.held = 0 AND g.topic_id IS NULL AND g.card_id IN (SELECT value FROM json_each(?))
        AND g.id NOT IN (SELECT value FROM json_each(?))`).bind(userKey(user, 'gap:'), user, JSON.stringify(cards), JSON.stringify(ids)).all()).results || [];
  const items = [];
  for (const r of rows) {
    const topicId = want.get(`${Number(r.card_id)}|${r.day}`);
    if (topicId && !items.some(i => i.queue_id === r.queue_id)) items.push({ queue_id: r.queue_id, topic_id: topicId });
  }
  if (!items.length) return 0;
  const { applyChange } = await import('../change.js');
  const res = await applyChange(env, user, { actor: 'code', surface: 'code', op: 'queue.resolve', args: { items }, via: 'hook:card-cues' });
  return res && res.ok ? items.length : 0;
}

const checkedOnCard = (g, origin) => origin === 'review' && g.source !== 'spoken_cue';

async function linkCards(env, user, pairs, t) {
  const sql = `INSERT INTO card_topics (user_id, card_id, topic_id, match, strong, created_by, created_at)
    SELECT ?1, ?2, ?3, 'gap', CASE WHEN ?4 = 1 AND NOT EXISTS (SELECT 1 FROM card_topics o WHERE o.user_id = ?1 AND o.card_id = ?2 AND o.topic_id <> ?3
      AND o.strong = 1 AND o.removed_at IS NULL) THEN 1 ELSE 0 END, 'code', ?5 WHERE true
    ON CONFLICT(user_id, card_id, topic_id) DO UPDATE SET strong = 1 WHERE excluded.strong = 1 AND card_topics.removed_at IS NULL`;
  const seen = new Set(), stmts = [];
  for (const [card, topic, strong] of pairs) {
    if (seen.has(`${card}|${topic}`)) continue;
    seen.add(`${card}|${topic}`);
    stmts.push(env.DB.prepare(sql).bind(user, Number(card), topic, strong ? 1 : 0, t));
  }
  return stmts.length ? env.DB.batch(stmts) : null;
}

/** One gap (the addGap hook). */
export async function ingestGap(env, user, row) {
  return ingestGaps(env, user, [row]);
}

/** Minute cron: gaps whose hook did not run (or failed), oldest first; at most `limit` a run. */
export async function sweepGaps(env, user, limit = 10) {
  const rows = (await env.DB.prepare(`SELECT id, at, day, source, card_id, note_id, ref, topic, gap, said, error_type, verdict, origin, mixed_with FROM gaps
    WHERE user_id = ? AND map_state IS NULL AND created_at < ? ORDER BY at LIMIT ?`).bind(user, nowMs() - 30_000, limit).all()).results || [];
  if (!rows.length) return { swept: 0 };
  const r = await ingestGaps(env, user, rows);
  return { swept: rows.length, ...r };
}

