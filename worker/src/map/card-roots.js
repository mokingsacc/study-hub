import { json, readJson } from '../util.js';
import { writeBatch, summaryOf } from './events.js';
import { noteJob } from '../job-log.js';
import { isFoundationCategory, FOUNDATION_PREFIX } from '../../../public/js/shared/concept.js';
import { namedIn } from '../../../public/js/shared/names.js';
import { MAX_TOPICS_PER_CARD } from './cards.js';

export const ROOT_LIKE = `${FOUNDATION_PREFIX}%`;
/** SQL: the topic aliased `a` is a root-cause topic (a foundation concept). */
export const ROOT_SQL = (a = 't') => `coalesce(${a}.category_id, '') LIKE '${ROOT_LIKE}'`;
/** SQL: the topic aliased `a` is not a root-cause topic. */
export const CLINICAL_SQL = (a = 't') => `coalesce(${a}.category_id, '') NOT LIKE '${ROOT_LIKE}'`;
/** SQL for an INSERT INTO card_topics ... SELECT's WHERE: the topic (an SQL expression) is not a root-cause topic. */
export const notRootTopic = (userExpr, topicExpr) =>
  `NOT EXISTS (SELECT 1 FROM topics rt WHERE rt.user_id = ${userExpr} AND rt.id = ${topicExpr} AND ${ROOT_SQL('rt')})`;
/** Is this topic row a root-cause topic? (pure) */
export const isRootCause = t => !!t && isFoundationCategory(t.category_id);

// The card evidence kinds and keys (sources.js, cards.js, card-reviews.js, gaps.js): the rows a card link puts on a topic.
export const CARD_KEYS = ['cardstate:', 'cardlapses:', 'cardrev:', 'card:'];
const isCardRow = e => !!e && /^card_/.test(String(e.kind || '')) && CARD_KEYS.some(p => String(e.obs_key || '').startsWith(p));

/**
 * What a card's diagnosis line names (pure): the bold words of its answer's first line ("This is **MSA**"), else that
 * line's first clause without "This is" ("This is painless thyroiditis, a variant of ..." gives "painless thyroiditis").
 */
export function answerTerms(answer) {
  const line = String(answer || '').split('\n')[0] || '';
  const bold = [...line.matchAll(/\*\*(.+?)\*\*/g)].map(m => m[1].trim()).filter(Boolean);
  if (bold.length) return bold.slice(0, 3);
  const first = (line.replace(/\*\*/g, '').split(/[.!?;:,](?:\s|$)|\s[–—-]\s/)[0] || '').trim()
    .replace(/^(this|it|that)\s+(is|was|looks like|points to)\s+/i, '').replace(/^(the\s+)?(diagnosis|differential|answer|cause)\s+is\s+/i, '').replace(/^(an?|the)\s+/i, '');
  return first && first.split(/\s+/).length <= 6 ? [first] : [];
}

/**
 * The clinical topics a root-cause concept underlies that the card's case or answer names (pure; never its notes, which
 * name look-alikes). card {question, answer}; underlies [{id, names}] (names as namedIn takes them). At most 3 ids.
 */
export function clinicalTargets(card, underlies) {
  const text = `${(card && card.question) || ''}\n${(card && card.answer) || ''}`;
  if (!text.trim()) return [];
  return (underlies || []).filter(u => u && u.id && namedIn(text, u.names || [])).map(u => u.id).slice(0, MAX_TOPICS_PER_CARD);
}

// ---------------------------------------------------------------- the repair

const ids = list => JSON.stringify([...new Set(list)]);
const EV_DROP = ['id', 'user_id', 'created_at', 'updated_at'];

/** Everything the repair reads, in two batches. */
async function readRepair(env, user) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [bad, ev, misses, gaps] = await env.DB.batch([
    q(`SELECT ct.card_id, ct.topic_id, ct.match, ct.strong, ct.created_by, ct.created_at, t.name FROM card_topics ct
       JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id WHERE ct.user_id = ?1 AND ct.removed_at IS NULL AND ${ROOT_SQL('t')}
       ORDER BY ct.card_id, ct.topic_id`, user),
    q(`SELECT e.* FROM evidence e JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id
       WHERE e.user_id = ?1 AND e.kind LIKE 'card%' AND ${ROOT_SQL('t')} ORDER BY e.obs_key, e.slot`, user),
    q(`SELECT count(*) AS n FROM misses m JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND ${ROOT_SQL('t')}`, user),
    q(`SELECT count(*) AS n FROM gaps g JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id WHERE g.user_id = ?1 AND ${ROOT_SQL('t')}`, user),
  ]);
  const badRows = bad.results || [];
  const evRows = (ev.results || []).filter(isCardRow);
  const cards = [...new Set([...badRows.map(r => Number(r.card_id)), ...evRows.map(r => Number(r.card_id)).filter(Boolean)])];
  const concepts = [...new Set([...badRows.map(r => r.topic_id), ...evRows.map(r => r.topic_id)])];
  const out = { bad: badRows, ev: evRows, cards, concepts, misses: Number(((misses.results || [])[0] || {}).n) || 0, gaps: Number(((gaps.results || [])[0] || {}).n) || 0,
    links: [], cache: new Map(), underlies: new Map(), held: [] };
  if (!cards.length) return out;
  const [links, cache, und, held] = await env.DB.batch([
    q(`SELECT ct.card_id, ct.topic_id, ct.strong, ct.removed_at FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
       WHERE ct.user_id = ?1 AND ct.card_id IN (SELECT value FROM json_each(?2)) AND ${CLINICAL_SQL('t')}`, user, ids(cards)),
    q(`SELECT card_id, question, answer FROM card_cache WHERE user_id = ?1 AND card_id IN (SELECT value FROM json_each(?2))`, user, ids(cards)),
    // Each concept's "underlies" lines to live clinical topics, with their names.
    q(`SELECT l.from_id AS concept, t.id, t.name, t.short_name, t.category_id,
         (SELECT json_group_array(json_object('alias', a.alias, 'kind', a.kind)) FROM topic_aliases a WHERE a.user_id = t.user_id AND a.topic_id = t.id
           AND a.status = 'active' AND a.kind NOT IN ('typo', 'truncated')) AS aliases
       FROM links l JOIN topics t ON t.user_id = l.user_id AND t.id = l.to_id AND t.status IN ('proposed', 'confirmed')
       WHERE l.user_id = ?1 AND l.type = 'causes' AND l.how = 'underlies' AND l.status IN ('active', 'proposed')
         AND l.from_id IN (SELECT value FROM json_each(?2)) AND ${CLINICAL_SQL('t')} ORDER BY l.from_id, l.support_n DESC, t.id`, user, ids(concepts)),
    // Every card row under the cards' keys, so a moved row keeps its slot only where the new topic has none.
    q(`SELECT obs_key, slot, topic_id FROM evidence WHERE user_id = ?1 AND card_id IN (SELECT value FROM json_each(?2))`, user, ids(cards)),
  ]);
  out.links = links.results || [];
  out.cache = new Map((cache.results || []).map(r => [Number(r.card_id), r]));
  for (const r of und.results || []) {
    let al = [];
    try { al = JSON.parse(r.aliases || '[]') || []; } catch { al = []; }
    if (!out.underlies.has(r.concept)) out.underlies.set(r.concept, []);
    out.underlies.get(r.concept).push({ id: r.id, names: [r.name, r.short_name ? { alias: r.short_name, kind: 'abbrev' } : null, ...al].filter(Boolean) });
  }
  out.held = held.results || [];
  return out;
}

/**
 * The repair, pure from what readRepair read. words: Map card_id -> [clinical topic ids its own words name] (the
 * resolver, clinical names only). Returns {rows, events, evidence: {upsert, remove}, touched, moved, unplaced, cards}.
 */
export function planRootRepair(read, words = new Map(), now = Date.now()) {
  const rows = [], events = [], upsert = [], remove = [];
  const touched = new Set();
  const live = new Map(), off = new Set();
  for (const l of read.links || []) {
    const k = Number(l.card_id);
    if (l.removed_at != null) { off.add(`${k}|${l.topic_id}`); continue; }
    if (!live.has(k)) live.set(k, []);
    live.get(k).push(l);
  }
  const badBy = new Map();
  for (const b of read.bad || []) { const k = Number(b.card_id); if (!badBy.has(k)) badBy.set(k, []); badBy.get(k).push(b); }
  const target = new Map();   // card -> the clinical topic its rows move to (its first new or strong clinical link)
  let moved = 0, unplaced = 0;
  for (const [card, links] of badBy) {
    const c = read.cache.get(card) || {};
    const mine = live.get(card) || [];
    for (const b of links) {
      rows.push({ table: 'card_topics', op: 'delete', key: { card_id: card, topic_id: b.topic_id },
        before: { match: b.match, strong: Number(b.strong) || 0, created_by: b.created_by, created_at: b.created_at, removed_at: null, removed_by: null }, after: null });
      events.push({ kind: 'data.cleaned', target_type: 'card_topic', target_id: `${card}:${b.topic_id}`, topic_id: b.topic_id, undoable: true,
        summary: summaryOf(`Card ${card} taken off the root cause ${b.name || b.topic_id}`) });
      touched.add(b.topic_id);
    }
    const strongNow = mine.filter(l => Number(l.strong)).map(l => l.topic_id);
    if (strongNow.length) { target.set(card, strongNow[0]); moved++; continue; }   // already on its clinical topic
    const und = links.flatMap(b => read.underlies.get(b.topic_id) || []);
    let place = clinicalTargets(c, und);
    if (!place.length) place = (words.get(card) || []).slice(0, MAX_TOPICS_PER_CARD);
    place = place.filter(t => !off.has(`${card}|${t}`));
    if (!place.length) { unplaced++; continue; }
    moved++;
    target.set(card, place[0]);
    for (const t of place) {
      const weak = mine.find(l => l.topic_id === t);
      if (weak) rows.push({ table: 'card_topics', op: 'update', key: { card_id: card, topic_id: t }, before: { strong: 0 }, after: { strong: 1 } });
      else rows.push({ table: 'card_topics', op: 'insert', key: { card_id: card, topic_id: t }, after: { match: 'search', strong: 1, created_by: 'code', created_at: now } });
      events.push({ kind: 'data.cleaned', target_type: 'card_topic', target_id: `${card}:${t}`, topic_id: t, undoable: true,
        summary: summaryOf(`Card ${card} placed on its clinical topic ${t}`) });
      touched.add(t);
    }
  }
  // The card rows on root-cause topics: moved to the card's clinical topic in place (same key and slot) when that topic
  // has no row under the key yet, otherwise dropped. Undo puts each back (evidence events carry the row before).
  const heldBy = new Map();
  for (const h of read.held || []) { if (!heldBy.has(h.obs_key)) heldBy.set(h.obs_key, new Set()); heldBy.get(h.obs_key).add(h.topic_id); }
  for (const e of read.ev || []) {
    const card = Number(e.card_id);
    const to = target.get(card);
    touched.add(e.topic_id);
    if (to && !(heldBy.get(e.obs_key) || new Set()).has(to)) {
      const row = Object.fromEntries(Object.entries(e).filter(([c, v]) => !EV_DROP.includes(c) && v !== undefined));
      upsert.push({ ...row, topic_id: to });
      if (!heldBy.has(e.obs_key)) heldBy.set(e.obs_key, new Set());
      heldBy.get(e.obs_key).add(to);
      touched.add(to);
    } else remove.push({ obs_key: e.obs_key, slot: Number(e.slot) || 0 });
  }
  return { rows, events, evidence: { upsert, remove }, touched: [...touched], moved, unplaced, cards: badBy.size, rows_moved: upsert.length, rows_dropped: remove.length };
}

// The clinical topics each card's own words name (its diagnosis line through the resolver, clinical names only).
async function wordsOf(env, user, read) {
  const out = new Map();
  const want = [...new Set((read.bad || []).map(b => Number(b.card_id)))].filter(c => read.cache.has(c));
  if (!want.length) return out;
  const [{ fetchAliases, withoutRoots }, { wordPlans, wordTopics }] = await Promise.all([import('./resolve.js'), import('./ingest/anki-reviews.js')]);
  const plans = new Map(), cards = new Map();
  for (const c of want) cards.set(c, { answer_terms: answerTerms(read.cache.get(c).answer) });
  const keys = [...new Set([...cards.values()].flatMap(w => wordPlans(w, plans).flatMap(x => x.plan.keys)))];
  if (!keys.length) return out;
  const data = withoutRoots(await fetchAliases(env, user, keys));
  for (const [c, w] of cards) out.set(c, wordTopics(w, data, plans));
  return out;
}

/**
 * The repair (idempotent: with no card link or card row on a root-cause topic it changes nothing and posts no line).
 * dry_run: counts only. Returns {cards, moved, unplaced, rows_moved, rows_dropped, misses, gaps, batch_id?}.
 */
export async function repairCardRoots(env, user, { dry_run = false, now = Date.now() } = {}) {
  let read;
  try { read = await readRepair(env, user); } catch (e) {
    if (/no such table|no such column/i.test(String(e && e.message))) return { skipped: 'tables not set up yet' };
    throw e;
  }
  const words = await wordsOf(env, user, read);
  const p = planRootRepair(read, words, now);
  const counts = { cards: p.cards, moved: p.moved, unplaced: p.unplaced, rows_moved: p.rows_moved, rows_dropped: p.rows_dropped, misses: read.misses, gaps: read.gaps };
  if (dry_run || (!p.rows.length && !p.evidence.upsert.length && !p.evidence.remove.length)) return { dry_run: !!dry_run, ...counts };
  // A moved row takes its new topic's category (category priors group by it), as a repoint does.
  if (p.evidence.upsert.length) {
    const cats = new Map(((await env.DB.prepare('SELECT id, category_id FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
      .bind(user, ids(p.evidence.upsert.map(r => r.topic_id))).all()).results || []).map(r => [r.id, r.category_id]));
    for (const r of p.evidence.upsert) r.category_id = cats.get(r.topic_id) ?? null;
  }
  try {
    const w = await writeBatch(env, user, {
      actor: 'code', surface: 'code', via: 'repair:card-roots', undoable: true, rows: p.rows, events: p.events,
      evidence: p.evidence.upsert.length || p.evidence.remove.length ? p.evidence : undefined, recompute: p.touched,
    });
    await noteJob(env, { job: 'card_roots', user, key: `card_roots:${w.batch_id}`, ref: w.batch_id, at: now, state: 'ok', counts });
    return { ...counts, batch_id: w.batch_id };
  } catch (e) {
    await noteJob(env, { job: 'card_roots', user, key: `card_roots:failed:${now}`, at: now, state: 'failed', detail: e });
    throw e;
  }
}

// POST /api/map/card-roots/repair {dry_run?}: the deploy script's catch-up (scripts/deploy-hub.sh), safe to run again.
export async function repairRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  return json(await repairCardRoots(env, user, { dry_run: !!(body && body.dry_run) }));
}
