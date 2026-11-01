import { norm } from '../../../public/js/shared/names.js';
import {
  FOUNDATION_CATEGORIES, foundationCategoryId, isFoundationCategory, conceptWeight, tidyConcept, atRiskWords, WEAK_BANDS, TEACH_MIN_MISSES, NOT_CONCEPTUAL,
} from '../../../public/js/shared/concept.js';
import { CONCEPT_RIGHT_WEIGHT, HEARD_MULT } from './weights.js';
import { noteJob } from '../job-log.js';
import { londonDay } from '../util.js';
import { stemSafe, questionSafe } from './guard.js';

export const CONCEPTS = { apply_max: 60, per_batch: 8, miss_wait_days: 3, link_w: 0.4, unlocks_max: 6, root_max: 3 };
export const SOURCES = ['nbme_judge', 'uworld_judge', 'review_talk', 'misconception', 'backfill'];
const DAY_MS = 86_400_000;
const LIVE = "('proposed', 'confirmed')";

// Other areas' code, behind one object so tests can swap it (_setDeps).
const deps = {
  writeBatch: async (...a) => (await import('./events.js')).writeBatch(...a),
  planLinks: async (...a) => (await import('./links-store.js')).planLinks(...a),
  queueStatements: async (...a) => (await import('./queue.js')).queueStatements(...a),
  namesToMap: async (...a) => (await import('./name-map.js')).namesToMap(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const num = v => Number(v) || 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- the foundation systems

/** The seven foundation categories for a user, added once (INSERT OR IGNORE), so Claude can place a concept there. */
export async function ensureFoundations(env, user, now = Date.now()) {
  await env.DB.prepare(`INSERT OR IGNORE INTO categories (user_id, id, name, short_name, sort, exam_profile, status, source, created_by, created_at, updated_at)
      SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.short_name'), json_extract(value, '$.sort'),
        'step2', 'active', 'foundations', 'code', ?2, ?2 FROM json_each(?3) WHERE true`)
    .bind(user, now, JSON.stringify(FOUNDATION_CATEGORIES.map(c => ({ id: c.id, name: c.name, short_name: c.short_name, sort: c.sort })))).run();
}

// ---------------------------------------------------------------- 1. the judges' way in

const TAG_COLS = ['source', 'block_id', 'q_index', 'uworld_block_id', 'uworld_q', 'misconception_id', 'miss_id', 'clinical_topic_id', 'clinical_name', 'ref',
  'concept', 'concept_key', 'discipline', 'quote', 'cause', 'confidence', 'weight', 'status', 'reason', 'words_hash', 'run_key', 'at', 'judged_at', 'updated_at', 'polarity'];
export const RIGHT_WAIT_DAYS = 14;
const rightTag = t => t && t.polarity === 'right';

export function tagRow(t, now = Date.now()) {
  if (!t || typeof t.id !== 'string' || !t.id || !SOURCES.includes(t.source)) return null;
  const right = t.polarity === 'right';
  const c = tidyConcept(t, right ? null : t.cause || null);
  if (!c.concept) return null;
  const key = norm(c.concept);
  if (!key) return null;
  const quote = c.concept_quote ? stemSafe(questionSafe(c.concept_quote)) : null;
  return {
    id: t.id.slice(0, 160), source: t.source, block_id: t.block_id ?? null, q_index: t.q_index ?? null, uworld_block_id: t.uworld_block_id ?? null,
    uworld_q: t.uworld_q ?? null, misconception_id: t.misconception_id ?? null, miss_id: t.miss_id ?? null, clinical_topic_id: t.clinical_topic_id ?? null,
    clinical_name: cut(t.clinical_name, 120), ref: cut(t.ref, 60), concept: c.concept, concept_key: key, discipline: c.concept_discipline,
    quote: quote || null, cause: right ? null : t.cause || null, confidence: t.confidence || null,
    weight: right ? Math.round(CONCEPT_RIGHT_WEIGHT * (HEARD_MULT[t.heard] ?? 1) * 1000) / 1000 : conceptWeight(t.cause || null, t.confidence || null, { belief: !!t.belief }),
    polarity: right ? 'right' : 'miss',
    status: 'pending', reason: null, words_hash: t.words_hash ?? null, run_key: t.run_key ?? null, at: Number(t.at) || now, judged_at: now, updated_at: now,
  };
}

/** One upsert for stored rows (an applied row keeps its place: the first naming wins once it is on the map). */
export function upsertStatement(env, user, rows) {
  return env.DB.prepare(`INSERT INTO concept_tags (user_id, id, ${TAG_COLS.join(', ')})
      SELECT ?1, json_extract(value, '$.id'), ${TAG_COLS.map(c => (c === 'polarity' ? `coalesce(json_extract(value, '$.polarity'), 'miss')` : `json_extract(value, '$.${c}')`)).join(', ')} FROM json_each(?2) WHERE true
      ON CONFLICT (user_id, id) DO UPDATE SET ${TAG_COLS.filter(c => c !== 'judged_at').map(c => `${c} = CASE WHEN concept_tags.status IN ('applied', 'undone') THEN concept_tags.${c} ELSE excluded.${c} END`).join(', ')}`)
    .bind(user, JSON.stringify(rows));
}

export async function noteConcepts(env, user, tags, { now = Date.now() } = {}) {
  try {
    const rows = (tags || []).map(t => tagRow(t, now)).filter(Boolean);
    if (!rows.length || !env || !env.DB) return 0;
    await upsertStatement(env, user, rows).run();
    return rows.length;
  } catch (e) {
    if (!noTable(e)) console.error('concept tags not noted', e && e.message);
    return 0;
  }
}

// ---------------------------------------------------------------- 2. the hourly step

const MISS_COLS = 'm.id, m.label, m.at, m.day, m.topic_id, m.result, m.held, m.confidence, m.cause, m.deleted_at, m.block_id, m.q_index, m.uworld_block_id, m.uworld_q, t.name AS topic_name, t.category_id AS topic_category';

// Each tag's miss (by id, or by the question it is about), its misconception, and the concept topics that carry its
// name, in one read batch.
async function readFor(env, user, tags) {
  const ids = tags.map(t => t.miss_id).filter(Boolean);
  const loc = tags.filter(t => !t.miss_id && (t.uworld_block_id || t.block_id)).map(t => t.uworld_block_id ? `u|${t.uworld_block_id}|${t.uworld_q}` : `h|${t.block_id}|${t.q_index}`);
  const miscs = tags.map(t => t.misconception_id).filter(Boolean);
  const keys = [...new Set(tags.map(t => t.concept_key).filter(Boolean))];
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [byId, byLoc, misc, alias] = await env.DB.batch([
    q(`SELECT ${MISS_COLS} FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id WHERE m.user_id = ?1 AND m.id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(ids)),
    q(`SELECT ${MISS_COLS} FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id WHERE m.user_id = ?1 AND m.deleted_at IS NULL
        AND m.result IN ('wrong', 'flawed') AND (CASE WHEN m.uworld_block_id IS NOT NULL THEN 'u|' || m.uworld_block_id || '|' || m.uworld_q
          WHEN m.block_id IS NOT NULL THEN 'h|' || m.block_id || '|' || m.q_index END) IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(loc)),
    q(`SELECT c.id, c.topic_id, c.topic_name, c.ref, c.first_seen, t.name AS topic_name2, t.category_id AS topic_category FROM misconceptions c
        LEFT JOIN topics t ON t.user_id = c.user_id AND t.id = c.topic_id WHERE c.user_id = ?1 AND c.id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(miscs)),
    // The concept topics by name: foundation systems only (a merged topic followed one hop).
    q(`SELECT a.alias_key AS key, coalesce(m.id, t.id) AS id, coalesce(m.name, t.name) AS name, coalesce(m.category_id, t.category_id) AS category_id
        FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id
        LEFT JOIN topics m ON t.status = 'merged' AND m.user_id = t.user_id AND m.id = t.merged_into
        WHERE a.user_id = ?1 AND a.status = 'active' AND a.alias_key IN (SELECT value FROM json_each(?2)) AND t.status IN ('proposed', 'confirmed', 'merged')
          AND coalesce(m.category_id, t.category_id) LIKE 'foundation-%'`, user, JSON.stringify(keys)),
  ]);
  const misses = new Map((byId.results || []).map(m => [m.id, m]));
  const located = new Map((byLoc.results || []).map(m => [m.uworld_block_id ? `u|${m.uworld_block_id}|${m.uworld_q}` : `h|${m.block_id}|${m.q_index}`, m]));
  // Misses already carrying an applied concept row (one per miss, whoever named it; an undone one stays counted, so undo sticks).
  const found = [...misses.keys(), ...[...located.values()].map(m => m.id)];
  const applied = found.length ? (await q(`SELECT DISTINCT miss_id FROM concept_tags WHERE user_id = ?1 AND status IN ('applied', 'undone')
      AND miss_id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(found)).all()).results || [] : [];
  const hubBlocks = [...new Set(tags.filter(t => rightTag(t) && t.block_id).map(t => t.block_id))];
  const ended = hubBlocks.length ? (await q(`SELECT b.id FROM blocks b JOIN sittings s ON s.id = b.sitting_id WHERE s.status = 'done' AND b.id IN (SELECT value FROM json_each(?1))`,
    JSON.stringify(hubBlocks)).all()).results || [] : [];
  return { misses, located, miscs: new Map((misc.results || []).map(r => [r.id, r])), concepts: new Map((alias.results || []).map(r => [r.key, r])),
    tagged: new Set(applied.map(r => r.miss_id)), ended: new Set(ended.map(r => r.id)) };
}

// The queue items of queued tags: Map(queue id -> {status, resolved_topic_id, category_id}).
async function queueState(env, user, qids) {
  if (!qids.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT q.id, q.status, q.resolved_topic_id, coalesce(m.id, t.id) AS topic_id, coalesce(m.category_id, t.category_id) AS category_id,
      coalesce(m.name, t.name) AS name FROM topic_queue q LEFT JOIN topics t ON t.user_id = q.user_id AND t.id = q.resolved_topic_id
      LEFT JOIN topics m ON t.status = 'merged' AND m.user_id = t.user_id AND m.id = t.merged_into
      WHERE q.user_id = ?1 AND q.id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify([...new Set(qids)])).all()).results || [];
  return new Map(rows.map(r => [r.id, r]));
}

const queueIdOf = (user, key) => (user === 'mo' ? `concept:${key}` : `${user}.concept:${key}`);

/**
 * What happens to each tag this run (pure): {apply: [{tag, miss, misc, concept}], queue: [tag], skip: [{tag, reason}],
 * wait: [tag]}. A tag waits while its miss is not on the map yet (a hub sitting still held, ingest not run), and is
 * skipped after CONCEPTS.miss_wait_days without one; a miss already carrying a concept row is never counted again.
 */
export function decide(tags, read, qstate, { now = Date.now(), user = 'mo' } = {}) {
  const out = { apply: [], queue: [], skip: [], wait: [] };
  const taken = new Set(read.tagged);
  for (const tag of tags) {
    let miss = null, misc = null;
    if (rightTag(tag)) {
      if (tag.block_id && !(read.ended || new Set()).has(tag.block_id)) {
        if (now - num(tag.judged_at) > RIGHT_WAIT_DAYS * DAY_MS) out.skip.push({ tag, reason: 'sitting never ended' }); else out.wait.push(tag);
        continue;
      }
    } else if (tag.miss_id || tag.uworld_block_id || tag.block_id) {
      miss = tag.miss_id ? read.misses.get(tag.miss_id) : read.located.get(tag.uworld_block_id ? `u|${tag.uworld_block_id}|${tag.uworld_q}` : `h|${tag.block_id}|${tag.q_index}`);
      if (miss && miss.deleted_at) { out.skip.push({ tag, reason: 'miss gone' }); continue; }
      if (!miss || Number(miss.held) === 1 || !miss.topic_id) {
        if (!(miss && Number(miss.held) === 1) && now - num(tag.judged_at) > CONCEPTS.miss_wait_days * DAY_MS) out.skip.push({ tag, reason: miss ? 'miss not placed' : 'no miss' });
        else out.wait.push(tag);
        continue;
      }
      if (isFoundationCategory(miss.topic_category)) { out.skip.push({ tag, reason: 'miss on a concept topic' }); continue; }
      // Its cause as the miss holds it now (re-judged or corrected since): a slip or a guess rests on no concept.
      if (NOT_CONCEPTUAL.includes(miss.cause)) { out.skip.push({ tag, reason: 'slip or guess' }); continue; }
      if (taken.has(miss.id)) { out.skip.push({ tag, reason: 'same miss' }); continue; }
    } else if (tag.misconception_id) {
      misc = read.miscs.get(tag.misconception_id);
      if (!misc) { out.skip.push({ tag, reason: 'misconception gone' }); continue; }
    } else { out.skip.push({ tag, reason: 'nothing to count' }); continue; }
    let concept = read.concepts.get(tag.concept_key) || null;
    if (!concept && read.clinical && read.clinical.has(tag.concept_key)) { out.skip.push({ tag, reason: 'names a clinical topic' }); continue; }
    if (!concept && tag.queue_id) {
      const q = qstate.get(tag.queue_id);
      if (q && q.status === 'resolved' && q.topic_id) {
        if (!isFoundationCategory(q.category_id)) { out.skip.push({ tag, reason: 'placed on a clinical topic' }); continue; }
        concept = { id: q.topic_id, name: q.name, category_id: q.category_id };
      } else if (q && q.status === 'rejected') { out.skip.push({ tag, reason: 'rejected' }); continue; }
      else { out.wait.push(tag); continue; }
    }
    if (!concept) { out.queue.push(tag); continue; }
    if (rightTag(tag)) { out.apply.push({ tag, miss: null, misc: null, concept, right: true }); continue; }
    const clinical = miss ? miss.topic_id : misc.topic_id || null;
    if (clinical && clinical === concept.id) { out.skip.push({ tag, reason: 'same topic' }); continue; }
    if (miss) taken.add(miss.id);
    out.apply.push({ tag, miss, misc, concept });
  }
  // A belief on the same question as a miss already counted on the same concept is that miss again.
  const byRef = new Set(out.apply.filter(a => a.miss).map(a => `${a.concept.id}|${String(a.miss.label || '').toLowerCase()}`));
  out.apply = out.apply.filter(a => {
    if (a.miss || !a.misc || !a.misc.ref) return true;
    if (byRef.has(`${a.concept.id}|${String(a.misc.ref).toLowerCase()}`)) { out.skip.push({ tag: a.tag, reason: 'same question' }); return false; }
    return true;
  });
  return out;
}

/** The concept row of one tag (pure): on the concept topic, at the miss's time, weighing tag.weight. */
export function conceptEvidence(a, user = 'mo') {
  const { tag, miss, misc, concept } = a;
  if (a.right) {
    // A right answer that showed the concept understood: a light Good on the concept topic, at its answer's time.
    const at = Number(tag.at) || Date.now();
    return {
      obs_key: `concept:right:${tag.id}`.slice(0, 160), slot: 0, kind: 'concept_right', topic_id: concept.id, category_id: concept.category_id,
      at, day: londonDay(at), source: 'concept', source_ref: tag.id.slice(0, 120), result: 'right', confidence: tag.confidence || null,
      amount: Number(tag.weight) || CONCEPT_RIGHT_WEIGHT, held: 0,
      detail_json: JSON.stringify({ label: cut(tag.ref, 24), from: cut(tag.clinical_name, 80), concept: tag.concept, right: 1 }),
    };
  }
  const at = miss ? Number(miss.at) : Number(tag.at) || (misc && Number(misc.first_seen)) || Date.now();
  const clinical = miss ? { id: miss.topic_id, name: miss.topic_name } : { id: misc.topic_id || null, name: misc.topic_name2 || misc.topic_name || tag.clinical_name };
  const label = miss ? miss.label : misc.ref || null;
  return {
    obs_key: miss ? `concept:${miss.id}` : `concept:${tag.id}`, slot: 0, kind: 'concept_miss', topic_id: concept.id, category_id: concept.category_id,
    // The miss is named in obs_key and detail (miss), never in miss_id: the row belongs to the concept, so moving, merging
    // or re-placing the clinical miss (which follow evidence.miss_id) never carries it onto a clinical topic.
    at, day: (miss && miss.day) || londonDay(at), source: 'concept', source_ref: tag.id.slice(0, 120),
    // Half the miss's own cause weight, from its cause now (the tag's when the miss has none yet).
    result: 'wrong', confidence: miss ? miss.confidence || null : null,
    amount: miss ? conceptWeight(miss.cause || tag.cause || null, miss.confidence || null) : Number(tag.weight) || 0, held: 0,
    detail_json: JSON.stringify({ label: cut(label, 24), from_topic: clinical.id, from: cut(clinical.name, 80), cause: tag.cause || null, concept: tag.concept,
      miss: miss ? miss.id : undefined, belief: miss ? undefined : 1 }),
  };
}

export const FRAME_WORDS = ['effect', 'finding', 'profile', 'classification', 'pathophysiology', 'pathogenesis', 'mechanism', 'pharmacology', 'principle', 'basic', 'overview', 'concept'];
const SMALL_WORDS = ['of', 'in', 'and', 'the', 'during', 'versus', 'vs', 'on', 'for', 'to', 'a', 'an', 'with', 'by'];
/** A concept key's loose form (pure): framing and small words out, each word stemmed ("trans" off a long word), sorted. */
export function looseKey(key) {
  const words = String(key || '').split(' ').filter(w => w && !SMALL_WORDS.includes(w) && !FRAME_WORDS.includes(w))
    .map(w => w.replace(/^trans(?=[a-z]{5})/, '').replace(/(?:ical|ic|ia|al|ous|es|s)$/, ''));
  return [...new Set(words.filter(Boolean))].sort().join(' ') || String(key || '');
}

async function namedConcepts(env, user, tags) {
  const byKey = new Map();
  for (const t of tags) if (t.concept && !byKey.has(t.concept_key)) byKey.set(t.concept_key, t.concept);
  const out = new Map();
  if (!byKey.size) return out;
  try {
    const keys = [...byKey.keys()];
    const named = await deps.namesToMap(env, user, keys.map(k => ({ name: byKey.get(k) })));
    const ids = [...new Set(named.map(n => n && n.topic_id).filter(Boolean))];
    if (!ids.length) return out;
    const rows = (await env.DB.prepare(`SELECT id, name, category_id FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND status IN ${LIVE}`)
      .bind(user, JSON.stringify(ids)).all()).results || [];
    const topics = new Map(rows.map(r => [r.id, r]));
    keys.forEach((k, i) => { const t = named[i] && topics.get(named[i].topic_id); if (t) out.set(k, { id: t.id, name: t.name, category_id: t.category_id }); });
  } catch (e) { if (!noTable(e)) console.error('concept naming failed', e && e.message); }
  return out;
}

/** The queue item for a concept no topic carries yet (pure): Claude places it on a concept topic or a new one. */
export function queueItem(tag, user = 'mo', clinicalName = null) {
  const cat = foundationCategoryId(tag.discipline || 'physiology');
  return {
    id: `concept:${tag.concept_key}`, kind: 'label', label_norm: tag.concept_key, label_raw: tag.concept,
    context: { category_hint: cat, source: 'concept',
      label: cut(`A foundation concept${clinicalName ? ` behind ${rightTag(tag) ? 'a right answer' : 'a miss'} on ${clinicalName}` : ''}: an existing concept topic, else new_topic {kind: concept, category_id: ${cat}}`, 300),
      ...(tag.quote ? { said: tag.quote } : {}) },
  };
}

/**
 * The hourly step (sync.js hourly): up to `limit` pending and queued tags, decided, then applied in undoable batches
 * of CONCEPTS.per_batch (code, actor code: each batch one change; undo puts its rows and links back). only: tag ids to
 * work on (the back-fill's own run). Returns {applied, queued, skipped, waiting, links, batches: [{batch_id, tags}]}.
 */
export async function applyConcepts(env, user, { now = Date.now(), limit = CONCEPTS.apply_max, only = null, note = true, via = 'cron:concepts' } = {}) {
  const out = { applied: 0, queued: 0, skipped: 0, waiting: 0, links: 0, batches: [] };
  let tags;
  try {
    tags = only
      ? (await env.DB.prepare(`SELECT * FROM concept_tags WHERE user_id = ?1 AND status IN ('pending', 'queued') AND id IN (SELECT value FROM json_each(?2)) ORDER BY at`)
        .bind(user, JSON.stringify(only)).all()).results || []
      : (await env.DB.prepare(`SELECT * FROM concept_tags WHERE user_id = ?1 AND status IN ('pending', 'queued') ORDER BY status = 'queued', updated_at LIMIT ?2`)
        .bind(user, Math.max(1, Math.min(200, Number(limit) || CONCEPTS.apply_max))).all()).results || [];
  } catch (e) { if (noTable(e)) return { ...out, ready: false }; throw e; }
  if (!tags.length) return out;
  try {
    const read = await readFor(env, user, tags);
    const qstate = await queueState(env, user, tags.map(t => t.queue_id).filter(Boolean));
    let plan = decide(tags, read, qstate, { now, user });
    const stmts = [];
    const openItem = t => t.queue_id && ['open', 'claimed'].includes((qstate.get(t.queue_id) || {}).status);
    const unplaced = [...plan.queue, ...plan.wait.filter(openItem)];
    if (unplaced.length) {
      const named = await namedConcepts(env, user, unplaced);
      if (named.size) {
        read.clinical = new Map();
        for (const [k, c] of named) { if (isFoundationCategory(c.category_id)) read.concepts.set(k, c); else read.clinical.set(k, c); }
        plan = decide(tags, read, qstate, { now, user });
      }
    }
    // A tag still waiting on an open item whose concept is now named (a concept topic made since, or a clinical name): the
    // item is closed by code onto that topic, as Claude's map_resolve would.
    const done = new Map();
    for (const a of plan.apply) if (openItem(a.tag)) done.set(a.tag.queue_id, a.concept.id);
    for (const x of plan.skip) if (openItem(x.tag) && read.clinical && read.clinical.has(x.tag.concept_key)) done.set(x.tag.queue_id, read.clinical.get(x.tag.concept_key).id);
    if (done.size) {
      stmts.push(env.DB.prepare(`UPDATE topic_queue SET status = 'resolved', resolved_by = 'code',
          resolved_topic_id = (SELECT json_extract(value, '$.t') FROM json_each(?2) WHERE json_extract(value, '$.id') = topic_queue.id)
        WHERE user_id = ?1 AND status IN ('open', 'claimed') AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`)
        .bind(user, JSON.stringify([...done].map(([id, t]) => ({ id, t })))));
      out.named = done.size;
    }
    const mark = (tag, set) => stmts.push(env.DB.prepare(`UPDATE concept_tags SET ${Object.keys(set).map((k, i) => `${k} = ?${i + 3}`).join(', ')}, updated_at = ?${Object.keys(set).length + 3}
        WHERE user_id = ?1 AND id = ?2`).bind(user, tag.id, ...Object.values(set), now));
    for (const s of plan.skip) mark(s.tag, { status: 'skipped', reason: s.reason });
    // Concepts no topic carries yet: one queue item each (refs add up), the foundation systems made first.
    if (plan.queue.length) {
      await ensureFoundations(env, user, now);
      // One item a concept: a name that differs from an open item (or another in this run) only in framing words, small
      // words, word order or a plural joins that item (looseKey), its refs adding up.
      const open = (await env.DB.prepare(`SELECT label_norm FROM topic_queue WHERE user_id = ?1 AND kind = 'label' AND status IN ('open', 'claimed') AND substr(id, 1, ?3) = ?2`)
        .bind(user, queueIdOf(user, ''), queueIdOf(user, '').length).all()).results || [];
      const loose = new Map(open.map(r => [looseKey(r.label_norm), r.label_norm]));
      const keyOf = t => { const lk = looseKey(t.concept_key); if (!loose.has(lk)) loose.set(lk, t.concept_key); return loose.get(lk); };
      const items = plan.queue.map(t => queueItem({ ...t, concept_key: keyOf(t) }, user, t.clinical_name || (read.misses.get(t.miss_id) || {}).topic_name || null));
      stmts.push(...await deps.queueStatements(env, user, items, now));
      for (const t of plan.queue) mark(t, { status: 'queued', queue_id: queueIdOf(user, keyOf(t)) });
    }
    if (stmts.length) await env.DB.batch(stmts);
    out.skipped = plan.skip.length; out.queued = plan.queue.length; out.waiting = plan.wait.length;
    for (const part of chunk(plan.apply, CONCEPTS.per_batch)) {
      const b = await applyPart(env, user, part, now, via);
      out.batches.push(b);
      out.applied += part.length;
      out.links += b.links;
    }
    if (note) await noteRun(env, user, out, now);
    return out;
  } catch (e) {
    if (note) await noteRun(env, user, out, now, (e && e.message) || 'failed');   // a failure posts too
    throw e;
  }
}

/** One undoable batch: each tag's concept row on its concept topic and its proposed link to the clinical topic. */
async function applyPart(env, user, part, now, via) {
  const rows = part.map(a => conceptEvidence(a, user));
  const proposals = part.map((a, i) => {
    if (a.right) return null;   // a right answer makes no "underlies" line: nothing rests on it
    const clinical = a.miss ? a.miss.topic_id : a.misc.topic_id;
    if (!clinical || clinical === a.concept.id) return null;
    return { type: 'causes', from: a.concept.id, to: clinical, how: 'underlies', status: 'proposed', by: 'code', source: 'derived', label: cut(a.tag.concept, 40),
      support: { obs_key: rows[i].obs_key, src: 'derived', role: 'named', w: CONCEPTS.link_w, cw: 0, miss_id: a.miss ? a.miss.id : null, at: rows[i].at } };
  }).filter(Boolean);
  const lk = proposals.length ? await deps.planLinks(env, user, proposals, { now, undoable: true }) : { rows: [], events: [] };
  const w = await deps.writeBatch(env, user, {
    actor: 'code', surface: 'code', via, undoable: true,
    rows: lk.rows, events: lk.events.map(e => ({ ...e, undoable: true })),
    evidence: { upsert: rows }, recompute: [...new Set(rows.map(r => r.topic_id))],
  });
  const ids = part.map(a => a.tag.id);
  const st = part.map(a => env.DB.prepare(`UPDATE concept_tags SET status = 'applied', concept_topic_id = ?3, miss_id = coalesce(?4, miss_id),
      clinical_topic_id = coalesce(?5, clinical_topic_id), batch_id = ?6, applied_at = ?7, updated_at = ?7 WHERE user_id = ?1 AND id = ?2`)
    .bind(user, a.tag.id, a.concept.id, a.miss ? a.miss.id : null, a.miss ? a.miss.topic_id : a.misc ? a.misc.topic_id || null : null, w.batch_id, now));
  if (st.length) await env.DB.batch(st);
  return { batch_id: w.batch_id, tags: ids, links: lk.events.filter(e => e.kind === 'link.added').length };
}

// Recent activity: the hourly runs of a day add up into one line; a failure posts its own.
function noteRun(env, user, out, now, error = null) {
  if (!error && !out.applied && !out.queued && !out.skipped && !out.named) return Promise.resolve(false);
  return noteJob(env, { job: 'concepts', key: `apply:${londonDay(now)}${error ? ':failed' : ''}`, ref: 'apply', user, add: true, at: now, state: error ? 'failed' : 'ok', detail: error,
    counts: { applied: num(out.applied), queued: num(out.queued), skipped: num(out.skipped), links: num(out.links), batches: (out.batches || []).length,
      ...(out.named ? { named: num(out.named) } : {}) } });
}

/** sync.js hourly: the day's tags applied. Never throws (its error is the run's own Recent activity line). */
export async function conceptsJob(env, user, { now = Date.now() } = {}) {
  try { return await applyConcepts(env, user, { now }); } catch (e) { return { error: (e && e.message) || String(e) }; }
}

// ---------------------------------------------------------------- 3. reads for the panel, map_overview and teach_next

// Every live concept link touching a topic, with the other end's name, system and colour.
const LINKS_SQL = `SELECT l.id, l.from_id, l.to_id, l.status, o.id AS other_id, o.name AS other_name, o.category_id AS other_category, s.band AS other_band, s.seen AS other_seen,
    s.weakness_raw AS other_weakness
  FROM links l JOIN topics o ON o.user_id = l.user_id AND o.id = CASE WHEN l.from_id = ?2 THEN l.to_id ELSE l.from_id END AND o.status IN ${LIVE}
  LEFT JOIN topic_scores s ON s.user_id = l.user_id AND s.topic_id = o.id
  WHERE l.user_id = ?1 AND l.type = 'causes' AND l.how = 'underlies' AND l.status IN ('active', 'proposed') AND (l.from_id = ?2 OR l.to_id = ?2)`;
// The concept rows behind each concept topic (undone ones are gone from evidence, so they never count).
const COUNTS_SQL = `SELECT topic_id, count(*) AS misses, count(DISTINCT json_extract(detail_json, '$.from_topic')) AS topics,
    json_group_array(json_extract(detail_json, '$.from_topic')) AS froms, max(at) AS last_at
  FROM evidence WHERE user_id = ?1 AND kind = 'concept_miss' AND held = 0 AND topic_id IS NOT NULL`;

const isWeak = (band, seen = 1) => !!Number(seen) && WEAK_BANDS.includes(band);
const BAND_WORD = { very_weak: 'very weak', weak: 'weak', shaky: 'shaky' };

/**
 * The foundations field of a topic (topic.js, panel and map_topic): a clinical topic {at_risk: [{id, name, band}],
 * concepts: [...], line} (at_risk only for weak concepts: a flag, never a colour); a concept topic {unlocks: [{id, name,
 * misses}], misses, topics, line}. null when it has no concept links.
 */
export async function foundationsFor(env, user, topicId) {
  let t, links, counts;
  try {
    [t, links, counts] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, category_id FROM topics WHERE user_id = ?1 AND id = ?2').bind(user, topicId),
      env.DB.prepare(LINKS_SQL).bind(user, topicId),
      env.DB.prepare(`${COUNTS_SQL} AND topic_id = ?2 GROUP BY topic_id`).bind(user, topicId),
    ]);
  } catch (e) { if (noTable(e)) return null; throw e; }
  const topic = (t.results || [])[0];
  if (!topic) return null;
  const rows = links.results || [];
  if (isFoundationCategory(topic.category_id)) {
    const c = (counts.results || [])[0];
    const froms = c ? JSON.parse(c.froms || '[]') : [];
    const unlocks = rows.filter(r => r.from_id === topicId).map(r => ({ id: r.other_id, name: r.other_name, misses: froms.filter(f => f === r.other_id).length }))
      .sort((a, b) => b.misses - a.misses || a.name.localeCompare(b.name)).slice(0, CONCEPTS.unlocks_max);
    if (!unlocks.length && !c) return null;
    return { kind: 'concept', misses: c ? num(c.misses) : 0, topics: c ? num(c.topics) : 0, unlocks,
      line: unlocks.length ? cut(`Underlies ${unlocks.map(u => u.name).join(', ')}`, 200) : null };
  }
  const concepts = rows.filter(r => r.to_id === topicId && isFoundationCategory(r.other_category))
    .map(r => ({ id: r.other_id, name: r.other_name, band: r.other_seen ? r.other_band : 'unseen', weak: isWeak(r.other_band, r.other_seen) }));
  if (!concepts.length) return null;
  const at_risk = concepts.filter(c => c.weak).map(({ id, name, band }) => ({ id, name, band, band_words: BAND_WORD[band] || band }));
  return { kind: 'clinical', concepts: concepts.map(({ id, name, band }) => ({ id, name, band })), at_risk,
    line: at_risk.length ? atRiskWords(at_risk.map(c => c.name).slice(0, 2).join(' and ')) : null };
}

/** Every concept topic with its rows (counts from evidence), colour and newest lesson (binds ?1 user). teach-priority.js
 *  rankTopicsFor reads it in its own batch, so teach_next's pick costs no query of its own. */
export const CONCEPT_ROWS_SQL = `WITH c AS (${COUNTS_SQL} GROUP BY topic_id)
  SELECT c.topic_id, c.misses, c.topics, c.last_at, t.name, t.category_id, s.band, s.seen, s.weakness_raw,
    (SELECT max(coalesce(l.ended_at, l.started_at)) FROM lessons l WHERE l.user_id = ?1 AND l.topic_id = c.topic_id AND l.status IN ('done', 'in_progress')) AS lesson_at
  FROM c JOIN topics t ON t.user_id = ?1 AND t.id = c.topic_id AND t.status IN ${LIVE} AND t.category_id LIKE 'foundation-%'
  LEFT JOIN topic_scores s ON s.user_id = ?1 AND s.topic_id = c.topic_id`;
export const conceptRowsOf = rows => (rows || []).map(r => ({ ...r, misses: num(r.misses), topics: num(r.topics) }));
async function conceptRows(env, user) {
  return conceptRowsOf((await env.DB.prepare(CONCEPT_ROWS_SQL).bind(user).all()).results);
}

/** map_overview's line: "Root causes: Thyroid uptake (4 misses across 3 topics), ...", or null with none of 2+ misses. */
export function rootCausesWords(rows, max = CONCEPTS.root_max) {
  const list = (rows || []).filter(r => r.misses >= 2).sort((a, b) => isWeak(b.band, b.seen) - isWeak(a.band, a.seen) || b.misses - a.misses || b.topics - a.topics
    || String(a.name).localeCompare(String(b.name))).slice(0, max);
  if (!list.length) return null;
  return cut(`Root causes: ${list.map(r => `${r.name} (${plural(r.misses, 'miss', 'misses')} across ${plural(r.topics, 'topic')})`).join(', ')}`, 300);
}
export async function rootCausesLine(env, user) {
  try { return rootCausesWords(await conceptRows(env, user)); } catch (e) { if (noTable(e)) return null; throw e; }
}

/**
 * teach_next's concept pick (pure on the rows): the weakest concept topic with TEACH_MIN_MISSES or more linked clinical
 * misses that is weak (or not coloured yet), not skipped, and not taught since its newest miss. {topic_id, name, misses,
 * topics, why} or null.
 */
export function pickConcept(rows, { skip = [] } = {}) {
  const ok = (rows || []).filter(r => r.misses >= TEACH_MIN_MISSES && !skip.includes(r.topic_id) && (isWeak(r.band, r.seen) || !Number(r.seen))
    && !(r.lesson_at && Number(r.lesson_at) >= Number(r.last_at)));
  ok.sort((a, b) => num(b.weakness_raw) - num(a.weakness_raw) || b.misses - a.misses || String(a.name).localeCompare(String(b.name)));
  const r = ok[0];
  if (!r) return null;
  return { topic_id: r.topic_id, name: r.name, misses: r.misses, topics: r.topics,
    why: cut(`A root cause: ${plural(r.misses, 'miss', 'misses')} across ${plural(r.topics, 'topic')} rest on ${r.name}, and it is ${BAND_WORD[r.band] || 'not coloured yet'}.`, 200) };
}
export async function conceptPick(env, user, { skip = [] } = {}) {
  try { return pickConcept(await conceptRows(env, user), { skip }); } catch (e) { if (noTable(e)) return null; throw e; }
}

/** The brief's unlocks for a concept lesson: which clinical topics it should fix, with the misses behind each. */
export async function conceptUnlocks(env, user, topicId) {
  const f = await foundationsFor(env, user, topicId);
  if (!f || f.kind !== 'concept') return null;
  return { concept: topicId, misses: f.misses, topics: f.unlocks,
    say: f.unlocks.length ? cut(`Getting this right should also fix ${f.unlocks.map(u => u.name).join(', ')}: end the lesson with a case on one of them.`, 300) : null };
}
