import { ankiCall } from '../anki.js';
import { chunks } from '../map/events.js';
import { embedTexts } from '../map/embed.js';
import { EMBED_MODEL, dequantise, normalise } from '../../../public/js/shared/similarity.js';
import { namedIn } from '../../../public/js/shared/names.js';

export const HOME_MAX = 300, HOME_Z = 3, CANDIDATES = 8, VOTES = 5, TEXT_MAX = 480;
export const LABEL_BATCH = 25, LABEL_DAY_USD = 1, LABEL_RESERVE_USD = 0.3, LABEL_SOURCE = 'cards.home.label';
const CALL_MS = 25_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const LIVE = "('proposed', 'confirmed')";

const LINK_OK = `ct.removed_at IS NULL AND (ct.strong = 1 OR ct.created_by <> 'auto') AND t.status <> 'retired'
  AND (t.status <> 'merged' OR (t2.id IS NOT NULL AND t2.status NOT IN ('retired', 'merged')))
  AND CASE WHEN t.status = 'merged' THEN t2.category_id ELSE t.category_id END IS NOT NULL`;
const LINK_FROM = `card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
  LEFT JOIN topics t2 ON t2.user_id = t.user_id AND t2.id = t.merged_into`;

const RESOLVED = "CASE WHEN t.status = 'merged' THEN t2.id ELSE t.id END";
const RESOLVED_CAT = "CASE WHEN t.status = 'merged' THEN t2.category_id ELSE t.category_id END";
const MATCH_ORDER = "CASE ct.match WHEN 'miss' THEN 0 WHEN 'claude' THEN 1 WHEN 'gap' THEN 2 ELSE 3 END, ct.created_at, ct.topic_id";

/**
 * Statements for step 1, in order: auto and weak homes whose link went, strong homes with no strong link left, the
 * best strong link of every card, then a provisional weak home (score NULL) for a card with only weak links and no home.
 */
export function codeHomeStatements(env, user, now) {
  return [
    env.DB.prepare(`DELETE FROM card_home WHERE user_id = ?1 AND (
        (via IN ('embed', 'label') AND NOT EXISTS (SELECT 1 FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
          WHERE ct.user_id = ?1 AND ct.card_id = card_home.card_id AND ct.topic_id = card_home.topic_id AND ct.removed_at IS NULL AND t.status IN ${LIVE}))
        OR (via = 'nearest' AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.user_id = ?1 AND t.id = card_home.topic_id AND t.status IN ${LIVE}))
        OR (via = 'weak' AND NOT EXISTS (SELECT 1 FROM ${LINK_FROM} WHERE ct.user_id = ?1 AND ct.card_id = card_home.card_id AND ${LINK_OK}
          AND ${RESOLVED} = card_home.topic_id))
        OR (via = 'strong' AND NOT EXISTS (SELECT 1 FROM ${LINK_FROM} WHERE ct.user_id = ?1 AND ct.card_id = card_home.card_id AND ct.strong = 1 AND ${LINK_OK})))`).bind(user),
    env.DB.prepare(`WITH best AS (SELECT ct.card_id, ${RESOLVED} AS topic_id, ${RESOLVED_CAT} AS category_id,
        ROW_NUMBER() OVER (PARTITION BY ct.card_id ORDER BY ${MATCH_ORDER}) AS rn
      FROM ${LINK_FROM} WHERE ct.user_id = ?1 AND ct.strong = 1 AND ${LINK_OK})
      INSERT INTO card_home (user_id, card_id, category_id, topic_id, via, checked_at) SELECT ?1, card_id, category_id, topic_id, 'strong', ?2 FROM best WHERE rn = 1
      ON CONFLICT (user_id, card_id) DO UPDATE SET category_id = excluded.category_id, topic_id = excluded.topic_id, via = excluded.via, score = NULL,
        candidates = NULL, label_at = NULL, checked_at = excluded.checked_at
      WHERE card_home.via <> excluded.via OR card_home.topic_id IS NOT excluded.topic_id OR card_home.category_id <> excluded.category_id`).bind(user, now),
    env.DB.prepare(`WITH best AS (SELECT ct.card_id, ${RESOLVED} AS topic_id, ${RESOLVED_CAT} AS category_id,
        ROW_NUMBER() OVER (PARTITION BY ct.card_id ORDER BY ${MATCH_ORDER}) AS rn
      FROM ${LINK_FROM} WHERE ct.user_id = ?1 AND ct.strong = 0 AND ${LINK_OK})
      INSERT INTO card_home (user_id, card_id, category_id, topic_id, via, checked_at) SELECT ?1, card_id, category_id, topic_id, 'weak', ?2 FROM best WHERE rn = 1
      ON CONFLICT (user_id, card_id) DO NOTHING`).bind(user, now),
  ];
}

/** The cards whose home is still provisional (a weak link by age), for assignHomes to place by relevance. */
export async function provisionalHomes(env, user, limit = HOME_MAX) {
  if (limit <= 0) return [];
  return ((await env.DB.prepare(`SELECT card_id FROM card_home WHERE user_id = ?1 AND via = 'weak' AND score IS NULL ORDER BY card_id LIMIT ?2`)
    .bind(user, limit).all()).results || []).map(r => Number(r.card_id));
}

// The answer's first sentence, the card's diagnosis line ("This is pronator drift, ... points to multiple sclerosis.").
export function firstSentence(answer) {
  return String(answer || '').replace(/\*\*/g, '').split(/\n|[.!?](?:\s|$)/)[0].trim();
}
// The case and the answer, for the weak-link embedding (never the notes: they name look-alikes).
const qaText = (q, a) => { const t = `${q || ''}\n${a || ''}`.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t; };

/** What a card is embedded from (pure): the bold answer words first (what the card names), the first field, the tag leaves. */
export function cardText(c) {
  const terms = Array.isArray(c && c.answer_terms) ? c.answer_terms.map(String).filter(Boolean) : [];
  const leaves = Array.isArray(c && c.tag_leaves) ? c.tag_leaves.map(String).filter(Boolean).slice(0, 4) : [];
  const first = String((c && c.first_field) || '').replace(/\s+/g, ' ').trim();
  const text = [terms.join('; '), first, leaves.join('; ')].filter(Boolean).join('. ');
  return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * Steps 2 and 3 for a few cards (pure). cards: [{card_id, vec, exclude?: Set of topic ids, cats?: tag subjects}];
 * topics: [{id, category_id, vec}] (unit vectors). A card with tag subjects looks only at topics in them (when any
 * exist). Returns one row a card: {card_id, category_id, topic_id, via: 'embed'|'nearest', score (z), candidates}.
 */
export function pickHomes(cards, topics, { minZ = HOME_Z } = {}) {
  const out = [];
  for (const c of cards) {
    if (!c || !c.vec) continue;
    let pool = topics.filter(t => t.vec && t.category_id && !(c.exclude && c.exclude.has(t.id)));
    const cats = new Set(c.cats || []);
    if (cats.size && pool.some(t => cats.has(t.category_id))) pool = pool.filter(t => cats.has(t.category_id));
    if (!pool.length) continue;
    const sims = pool.map(t => dot(c.vec, t.vec));
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const sd = sims.length > 1 ? Math.sqrt(Math.max(1e-12, sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length)) : 1;
    const order = sims.map((s, i) => i).sort((a, b) => sims[b] - sims[a] || (pool[a].id < pool[b].id ? -1 : 1));
    const best = order[0], z = (sims[best] - mean) / sd;
    const candidates = order.slice(0, CANDIDATES).map(i => pool[i].id);
    if (z >= minZ) { out.push({ card_id: c.card_id, category_id: pool[best].category_id, topic_id: pool[best].id, via: 'embed', score: round2(z), candidates }); continue; }
    // the closest subject: the best topics vote by how far each stands above the card's mean
    const votes = new Map();
    for (const i of order.slice(0, VOTES)) votes.set(pool[i].category_id, (votes.get(pool[i].category_id) || 0) + Math.max(1e-6, sims[i] - mean));
    const cat = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const top = order.find(i => pool[i].category_id === cat);
    out.push({ card_id: c.card_id, category_id: cat, topic_id: pool[top].id, via: 'nearest', score: round2(z), candidates });
  }
  return out;
}
const round2 = x => Math.round(x * 100) / 100;
const round3 = x => Math.round(x * 1000) / 1000;

/**
 * Step 1b for one card with only weak links (pure). card: {card_id, vec?, named?: the linked topic ids its diagnosis
 * line names, exclude?, cats?}; links: [{topic_id, category_id}] in link order; topics as pickHomes. A named topic
 * wins (score 1; two named: the closer by embedding); else the closest weak topic by embedding (score: its cosine,
 * below 1), unless the best embedding match overall is a clear winner (pickHomes' embed) closer than every weak
 * topic, which is then an embed home. With nothing to go on (no name, no vector): null, or with settle (the
 * embeddings ran but this card has no text) its first link (score 0), so it is not asked about again.
 */
export function pickWeakHome(card, links, topics, { minZ = HOME_Z, settle = false } = {}) {
  const live = (links || []).filter(l => l && l.topic_id && l.category_id);
  if (!card || !live.length) return null;
  const ids = live.map(l => l.topic_id);
  const vecOf = new Map((topics || []).filter(t => t && t.vec).map(t => [t.id, t.vec]));
  const sim = id => (card.vec && vecOf.has(id) ? dot(card.vec, vecOf.get(id)) : null);
  const closest = list => list.map(l => [l, sim(l.topic_id)]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1])[0] || null;
  const row = (l, score) => ({ card_id: card.card_id, category_id: l.category_id, topic_id: l.topic_id, via: 'weak', score, candidates: ids });
  const named = live.filter(l => (card.named || []).includes(l.topic_id));
  if (named.length) return row((named.length > 1 && closest(named) || [named[0]])[0], 1);
  if (!card.vec) return settle ? row(live[0], 0) : null;
  const best = closest(live);
  const [e] = pickHomes([card], topics || [], { minZ });
  if (e && e.via === 'embed' && !ids.includes(e.topic_id) && (!best || sim(e.topic_id) > best[1])) return { ...e, candidates: [...new Set([...ids, ...e.candidates])] };
  return best ? row(best[0], round3(Math.min(0.999, best[1]))) : row(live[0], 0);
}

/** The card text card_stats gives, by id (500 a call). */
async function cardTexts(env, ids) {
  const out = new Map();
  for (const part of chunks(ids, 500)) {
    const r = await ankiCall(env, 'card_stats', { card_ids: part, limit: part.length, tags: 'leaves' }, { timeoutMs: CALL_MS });
    for (const c of (r && r.cards) || []) out.set(Number(c.card_id), c);
  }
  return out;
}

function homeUpsert(env, user, rows, now) {
  return chunks(rows, 100).map(part => env.DB.prepare(`INSERT INTO card_home (user_id, card_id, category_id, topic_id, via, score, candidates, label_at, checked_at)
      SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.category_id'), json_extract(value, '$.topic_id'), json_extract(value, '$.via'),
        json_extract(value, '$.score'), json_extract(value, '$.candidates'), json_extract(value, '$.label_at'), ?2 FROM json_each(?3) WHERE true
      ON CONFLICT (user_id, card_id) DO UPDATE SET category_id = excluded.category_id, topic_id = excluded.topic_id, via = excluded.via, score = excluded.score,
        candidates = excluded.candidates, label_at = excluded.label_at, checked_at = excluded.checked_at`)
    .bind(user, now, JSON.stringify(part.map(r => ({ ...r, candidates: r.candidates ? JSON.stringify(r.candidates) : null, label_at: r.label_at ?? null })))));
}
const autoLinks = (env, user, rows, now) => chunks(rows, 200).map(part => env.DB.prepare(`INSERT INTO card_topics (user_id, card_id, topic_id, match, strong, created_by, created_at)
    SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.topic_id'), 'search', 0, 'auto', ?2 FROM json_each(?3) WHERE true
    ON CONFLICT (user_id, card_id, topic_id) DO NOTHING`).bind(user, now, JSON.stringify(part.map(r => ({ card_id: r.card_id, topic_id: r.topic_id })))));

/**
 * Steps 1b to 4 for these cards (today's cards with no home, a tag home or a provisional weak one, then other
 * provisional ones). Bounded: HOME_MAX cards, one card_stats call, HOME_MAX / 50 Workers AI calls, five D1 reads and
 * one write. Returns {cards, weak, embed, nearest, tag}.
 */
export async function assignHomes(env, user, ids, { now = Date.now(), ai = env.AI } = {}) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))].slice(0, HOME_MAX);
  const res = { cards: list.length, weak: 0, embed: 0, nearest: 0, tag: 0 };
  if (!list.length) return res;
  const idsJson = JSON.stringify(list);
  const [removed, tags, weakRows, cacheRows] = await env.DB.batch([
    env.DB.prepare('SELECT card_id, topic_id FROM card_topics WHERE user_id = ?1 AND removed_at IS NOT NULL AND card_id IN (SELECT value FROM json_each(?2))').bind(user, idsJson),
    env.DB.prepare("SELECT card_id, category_id FROM card_subjects WHERE user_id = ?1 AND via = 'tag' AND card_id IN (SELECT value FROM json_each(?2)) ORDER BY card_id, category_id").bind(user, idsJson),
    // the weak links, in link order (a card with a strong link has its strong home and is not asked about)
    env.DB.prepare(`SELECT ct.card_id, ${RESOLVED} AS topic_id, ${RESOLVED_CAT} AS category_id FROM ${LINK_FROM}
      WHERE ct.user_id = ?1 AND ct.strong = 0 AND ${LINK_OK} AND ct.card_id IN (SELECT value FROM json_each(?2))
      ORDER BY ct.card_id, ${MATCH_ORDER}`).bind(user, idsJson),
    env.DB.prepare('SELECT card_id, question, answer FROM card_cache WHERE user_id = ?1 AND card_id IN (SELECT value FROM json_each(?2))').bind(user, idsJson),
  ]);
  const exclude = new Map(), cats = new Map(), weak = new Map();
  for (const r of removed.results || []) { const k = Number(r.card_id); if (!exclude.has(k)) exclude.set(k, new Set()); exclude.get(k).add(r.topic_id); }
  for (const r of tags.results || []) { const k = Number(r.card_id); if (!cats.has(k)) cats.set(k, []); cats.get(k).push(r.category_id); }
  for (const r of weakRows.results || []) {
    const k = Number(r.card_id);
    if (!weak.has(k)) weak.set(k, []);
    if (!weak.get(k).some(l => l.topic_id === r.topic_id)) weak.get(k).push({ topic_id: r.topic_id, category_id: r.category_id });
  }
  const cache = new Map((cacheRows.results || []).map(r => [Number(r.card_id), r]));
  const names = await topicNames(env, user, [...new Set([...weak.values()].flat().map(l => l.topic_id))]);
  let topics = [];
  if (ai && typeof ai.run === 'function') {
    try {
      topics = ((await env.DB.prepare(`SELECT e.topic_id AS id, t.category_id, e.vec, e.scale FROM topic_embeddings e
          JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id AND t.status IN ${LIVE}
          WHERE e.user_id = ?1 AND e.model = ?2 AND t.category_id IS NOT NULL ORDER BY e.topic_id`).bind(user, EMBED_MODEL).all()).results || [])
        .map(r => ({ id: r.id, category_id: r.category_id, vec: dequantise(r.vec, r.scale) })).filter(t => t.vec);
    } catch (e) { if (!noTable(e)) throw e; }
  }
  const got = topics.length ? await cardTexts(env, list) : new Map();
  // the weak topics each card's diagnosis line names (the cached answer's first sentence, else its bold answer words)
  const named = new Map();
  for (const [id, links] of weak) {
    const c = cache.get(id), s = got.get(id);
    const line = firstSentence(c && c.answer) || (s && Array.isArray(s.answer_terms) ? s.answer_terms.join('; ') : '');
    named.set(id, links.filter(l => namedIn(line, names.get(l.topic_id) || [])).map(l => l.topic_id));
  }
  const vec = new Map();
  let embedded = false;
  if (topics.length) {
    const cards = list.map(id => {
      const c = cache.get(id);
      const text = (weak.has(id) && c && qaText(c.question, c.answer)) || (got.has(id) ? cardText(got.get(id)) : '');
      return { id, text };
    }).filter(c => c.text);
    let vecs = [];
    try { vecs = cards.length ? await embedTexts(ai, cards.map(c => c.text)) : []; } catch (e) { console.error('orbits: card embeddings', e && e.message); vecs = []; }
    if (vecs.length === cards.length) { cards.forEach((c, i) => vec.set(c.id, normalise(vecs[i]))); embedded = true; }
  }
  const rows = [];
  for (const id of list) {
    const card = { card_id: id, vec: vec.get(id) || null, exclude: exclude.get(id), cats: cats.get(id), named: named.get(id) };
    const r = weak.has(id) ? pickWeakHome(card, weak.get(id), topics, { settle: embedded }) : card.vec ? pickHomes([card], topics)[0] : null;
    if (r) rows.push(r);
  }
  // without embeddings: the tag subject, when the card has one (a weak card keeps its provisional home)
  const placed = new Set(rows.map(r => r.card_id));
  for (const id of list) if (!placed.has(id) && !weak.has(id) && cats.has(id)) rows.push({ card_id: id, category_id: cats.get(id)[0], topic_id: null, via: 'tag', score: null, candidates: null });
  for (const r of rows) res[r.via]++;
  if (rows.length) await env.DB.batch([...homeUpsert(env, user, rows, now), ...autoLinks(env, user, rows.filter(r => r.via === 'embed'), now)]);
  return res;
}

/** Each topic's names for namedIn: its name, its short name (as an abbreviation) and its active aliases. */
async function topicNames(env, user, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const j = JSON.stringify(ids);
  const [t, a] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, short_name FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(user, j),
    env.DB.prepare(`SELECT topic_id, alias, kind FROM topic_aliases WHERE user_id = ?1 AND status = 'active' AND kind NOT IN ('typo', 'truncated')
      AND topic_id IN (SELECT value FROM json_each(?2))`).bind(user, j),
  ]);
  for (const r of t.results || []) out.set(r.id, [r.name, r.short_name ? { alias: r.short_name, kind: 'abbrev' } : null].filter(Boolean));
  for (const r of a.results || []) if (out.has(r.topic_id)) out.get(r.topic_id).push({ alias: r.alias, kind: r.kind });
  return out;
}

// ---------------------------------------------------------------- the stricter keyword rule, for links made before it

export const PRUNE_SOURCE = 'cards.home.prune', PRUNE_V = 1, PRUNE_PAGE = 2000;
export async function pruneSearchLinks(env, user, { now = Date.now(), page = PRUNE_PAGE } = {}) {
  const st = await env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ? AND source = ?').bind(user, PRUNE_SOURCE).first();
  let cur = {};
  try { cur = JSON.parse((st && st.cursor) || '{}') || {}; } catch { cur = {}; }
  if (cur.v !== PRUNE_V) cur = { v: PRUNE_V, card: 0, topic: '', removed: 0, no_text: 0 };
  if (cur.done) return { skipped: 'done' };
  const rows = (await env.DB.prepare(`SELECT ct.card_id, ct.topic_id, c.question, c.answer FROM card_topics ct
      LEFT JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
      WHERE ct.user_id = ?1 AND ct.match = 'search' AND ct.strong = 0 AND ct.created_by = 'code' AND ct.removed_at IS NULL
        AND (ct.card_id > ?2 OR (ct.card_id = ?2 AND ct.topic_id > ?3))
      ORDER BY ct.card_id, ct.topic_id LIMIT ?4`).bind(user, cur.card, cur.topic, page).all()).results || [];
  const names = await topicNames(env, user, [...new Set(rows.map(r => r.topic_id))]);
  const drop = [];
  let noText = 0;
  for (const r of rows) {
    if (!r.question && !r.answer) { noText++; continue; }
    if (!namedIn(`${r.question || ''}\n${r.answer || ''}`, names.get(r.topic_id) || [])) drop.push(`${r.card_id}|${r.topic_id}`);
  }
  const last = rows[rows.length - 1];
  const next = { v: PRUNE_V, card: last ? Number(last.card_id) : cur.card, topic: last ? last.topic_id : cur.topic,
    removed: (cur.removed || 0) + drop.length, no_text: (cur.no_text || 0) + noText, done: rows.length < page ? 1 : 0 };
  const w = [];
  for (const part of chunks(drop, 400)) w.push(env.DB.prepare(`UPDATE card_topics SET removed_at = ?2, removed_by = 'code' WHERE user_id = ?1 AND removed_at IS NULL
      AND strong = 0 AND created_by = 'code' AND (card_id || '|' || topic_id) IN (SELECT value FROM json_each(?3))`).bind(user, now, JSON.stringify(part)));
  w.push(env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, PRUNE_SOURCE, JSON.stringify(next), now));
  await env.DB.batch(w);
  if (drop.length || next.done) console.log(JSON.stringify({ card_links_pruned: { user, removed: drop.length, total: next.removed, no_text: next.no_text, done: !!next.done } }));
  return { checked: rows.length, removed: drop.length, no_text: noText, done: !!next.done };
}

// ---------------------------------------------------------------- the card labeller (leftovers, cron only)

const LABEL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['labels'],
  properties: { labels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['card_id', 'topic_id'],
    properties: { card_id: { type: 'integer' }, topic_id: { type: 'string' } } } } },
};
const LABEL_SYSTEM = [
  "You place a medical student's own Anki flashcards (USMLE Step 2 CK) on his map of topics.",
  'Each card comes with a short list of candidate topics (id: name). For each card return its card_id and the id of the one candidate the card tests.',
  'Return an empty topic_id when no candidate fits. Never invent an id that is not in that card\'s list.',
].join('\n');

/** The checked picks (pure): only a candidate of that card counts. */
export function checkPicks(data, asked) {
  const out = new Map();
  for (const l of (data && data.labels) || []) {
    const id = Number(l && l.card_id), tid = String((l && l.topic_id) || '').trim();
    const a = asked.get(id);
    if (a && tid && a.includes(tid)) out.set(id, tid);
  }
  return out;
}

/**
 * One labeller call for today's leftovers (via 'nearest', never asked yet), at most LABEL_BATCH cards, within
 * LABEL_DAY_USD a London day and the hub's caps. opts.call stands in for callJson in tests. Returns {skipped} or
 * {asked, labelled, usd}.
 */
export async function labelLeftovers(env, user, ids, { now = Date.now(), call = null } = {}) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))];
  if (!list.length) return { skipped: 'nothing to label' };
  if (!call && !env.ANTHROPIC_API_KEY) return { skipped: 'no API key' };
  const { londonDay } = await import('../util.js');
  const day = londonDay(now);
  const [left, st] = await env.DB.batch([
    env.DB.prepare(`SELECT card_id, candidates FROM card_home WHERE user_id = ?1 AND via = 'nearest' AND label_at IS NULL AND candidates IS NOT NULL
      AND card_id IN (SELECT value FROM json_each(?2)) ORDER BY card_id LIMIT ${LABEL_BATCH}`).bind(user, JSON.stringify(list)),
    env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ? AND source = ?').bind(user, LABEL_SOURCE),
  ]);
  const rows = left.results || [];
  if (!rows.length) return { skipped: 'nothing to label' };
  let cur = {};
  try { cur = JSON.parse(((st.results || [])[0] || {}).cursor || '{}') || {}; } catch { cur = {}; }
  const spent = cur.day === day ? Number(cur.usd) || 0 : 0;
  if (spent >= LABEL_DAY_USD) return { skipped: 'daily card labeller limit' };
  const asked = new Map(rows.map(r => { let c = []; try { c = JSON.parse(r.candidates) || []; } catch { c = []; } return [Number(r.card_id), c.map(String)]; }));
  const names = new Map(((await env.DB.prepare(`SELECT id, name, category_id FROM topics WHERE user_id = ?1 AND status IN ${LIVE} AND id IN (SELECT value FROM json_each(?2))`)
    .bind(user, JSON.stringify([...new Set([...asked.values()].flat())])).all()).results || []).map(r => [r.id, r]));
  const texts = await cardTexts(env, [...asked.keys()]);
  const blocks = [];
  for (const [id, cands] of asked) {
    const text = texts.has(id) ? cardText(texts.get(id)) : '';
    const live = cands.filter(t => names.has(t));
    if (!text || !live.length) { asked.set(id, []); continue; }
    asked.set(id, live);
    blocks.push(`Card ${id}\n${text}\nCandidates: ${live.map(t => `${t}: ${names.get(t).name}`).join('; ')}`);
  }
  let data = null, usd = 0;
  if (blocks.length) {
    if (call) ({ data, usd = 0 } = await call({ system: LABEL_SYSTEM, schema: LABEL_SCHEMA, content: blocks.join('\n\n') }));
    else {
      const [{ callJson }, { reserveSpend, spendCap }, { HttpError }] = await Promise.all([import('../claude.js'), import('../db.js'), import('../util.js')]);
      let release;
      try { release = await reserveSpend(env, LABEL_RESERVE_USD, await spendCap(env)); } catch (e) {
        if (e instanceof HttpError && e.status === 429) return { skipped: 'spend cap' };
        throw e;
      }
      try {
        ({ data, usd } = await callJson(env, { role: 'labeller', system: LABEL_SYSTEM, schema: LABEL_SCHEMA, effort: 'high', maxTokens: 8000,
          messages: [{ role: 'user', content: `${blocks.length} cards:\n\n${blocks.join('\n\n')}` }] }));
      } catch (e) {
        await release(0);
        usd = Number(e && e.usd) || 0;
        data = null;
        console.error('orbits: card labeller', e && e.message);
      }
      await release(0);   // the call added its real cost
    }
  }
  const picks = checkPicks(data, asked);
  const labelled = [...picks].map(([card_id, topic_id]) => ({ card_id, topic_id, category_id: names.get(topic_id).category_id, via: 'label', score: null,
    candidates: asked.get(card_id), label_at: now })).filter(r => r.category_id);
  const done = new Set(labelled.map(r => r.card_id));
  await env.DB.batch([
    ...homeUpsert(env, user, labelled, now), ...autoLinks(env, user, labelled, now),
    env.DB.prepare(`UPDATE card_home SET label_at = ?2 WHERE user_id = ?1 AND via = 'nearest' AND card_id IN (SELECT value FROM json_each(?3))`)
      .bind(user, now, JSON.stringify([...asked.keys()].filter(id => !done.has(id)))),
    env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`)
      .bind(user, LABEL_SOURCE, JSON.stringify({ day, usd: spent + (Number(usd) || 0) }), now),
  ]);
  return { asked: asked.size, labelled: labelled.length, usd: Math.round((Number(usd) || 0) * 1e4) / 1e4 };
}
