import { londonDay, now as nowMs } from '../../util.js';
import { buildLeakIndex } from '../../checks.js';
import { confFor } from '../../../../public/js/conf-words.js';
import {
  fromAnalysis, fromUworld, questionEvidence, missUpsert, rowHash, MISS_INGEST_COLS, STICKY_METHODS, releasable, userKey, rawKey,
  hubKey, uwKey, uwbKey, labelQueueKey, normLabel, dayDiff, sameEvidence, EVIDENCE_COLS, wordsChanged, GAP_SOURCE_LABEL, CODE_PLACED, nextRetestDay, confidenceWinner,
} from './map-fields.js';
import { queueStatements } from '../queue.js';
import { gapSafe } from '../guard.js';

// ---------------------------------------------------------------- other areas, loaded when first used
// Literal paths, so each module is in the bundle; a module that has not landed yet would sit in DEP (a variable
// specifier, so the Worker still bundles without it) until tests/worker/ingest-deps.test.mjs says it exists.
const DEP = {};
export const LOADERS = {
  events: () => import('../events.js'),
  resolve: () => import('../resolve.js'),
  recompute: () => import('../recompute.js'),
  rebuild: () => import('../rebuild.js'),
  weakness: () => import('../weakness.js'),
  topics: () => import('../topics.js'),
  links: () => import('../links-store.js'),
  linksIngest: () => import('../links-ingest.js'),
  teach: () => import('../teach-save.js'),
  sources: () => import('../sources.js'),
};
// The calls other areas answer (tests swap them with _setIo). Each throws when its module is missing.
const call = (mod, fn) => async (...a) => {
  const m = await LOADERS[mod]();
  if (typeof m[fn] !== 'function') throw new Error(`${fn} is not in ${mod}`);
  return m[fn](...a);
};
export const io = {
  writeBatch: call('events', 'writeBatch'),
  resolveTopic: call('resolve', 'resolveTopic'),
  releaseLinks: call('links', 'releaseLinks'),
  staleSupport: call('links', 'staleSupport'),
};

/**
 * Link support the given misses no longer give (deleted, or moved off a topic), as rows and events for the same
 * commit (links-store staleSupport; B3-8). Fails soft: a link that cannot be recomputed never stops the miss's own write.
 */
export async function staleSupportParts(env, user, misses) {
  const list = (misses || []).filter(m => m && m.id);
  if (!list.length) return { rows: [], events: [] };
  try { return await io.staleSupport(env, user, list, { now: nowMs() }); } catch (e) {
    if (!noTable(e)) console.error('stale link support failed', e && e.message);
    return { rows: [], events: [] };
  }
}
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

export const ACCEPT = 0.85;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** Run one map hook after the hub's own write: never throws, logs real failures (not a missing 0010). */
export async function hook(name, fn) {
  try {
    return await raceRetry(fn);
  } catch (e) {
    if (!noTable(e)) console.error(`map hook ${name} failed`, (e && e.stack) || e);
    return null;
  }
}

/**
 * Run fn, and once more after a short pause when its batch lost a race on a unique key (B3-7): two writers that
 * planned the same new link (or queue item) from one read, the second batch refused whole. fn reads again, so the
 * second try plans on top of the first writer's rows instead of dropping its own.
 */
export const isRace = e => /UNIQUE constraint failed/i.test(String(e && e.message));
export async function raceRetry(fn, { tries = 2, pauseMs = () => 120 + Math.floor(Math.random() * 280) } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isRace(e)) throw e;
      await new Promise(r => setTimeout(r, pauseMs()));
    }
  }
}

/** One ingestion write through realtime's writeBatch, or nothing when there is nothing to write. */
export async function commit(env, user, { via, surface = 'hook', statements = [], rows = [], evidence = {}, events = [], recompute = [] }) {
  const ev = {
    upsert: evidence.upsert || [], remove: evidence.remove || [], repoint: evidence.repoint || [],
  };
  if (!statements.length && !rows.length && !ev.upsert.length && !ev.remove.length && !ev.repoint.length && !events.length) return null;
  return io.writeBatch(env, user, {
    actor: 'code', surface, via, statements, rows, evidence: ev, events: events.map(e => ({ undoable: false, ...e })),
    recompute: [...new Set(recompute.filter(Boolean))], undoable: false,
  });
}

const EV_SET = EVIDENCE_COLS.filter(c => !['user_id', 'obs_key', 'slot', 'created_by', 'created_at'].includes(c));
/**
 * Evidence rows written as plain statements (held rows, which must not move a score until release): one
 * INSERT ... SELECT FROM json_each per 150 rows; on conflict every given column is replaced.
 */
export function evidenceStatements(env, user, rows, now = nowMs()) {
  const out = [];
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150).map(r => ({ ...r, user_id: user, slot: r.slot || 0, created_at: now, updated_at: now, created_by: 'code' }));
    out.push(env.DB.prepare(`INSERT INTO evidence (${EVIDENCE_COLS.join(', ')})
      SELECT ${EVIDENCE_COLS.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?) WHERE 1
      ON CONFLICT(user_id, obs_key, slot) DO UPDATE SET ${EV_SET.map(c => `${c} = excluded.${c}`).join(', ')}`)
      .bind(JSON.stringify(chunk.map(r => Object.fromEntries(EVIDENCE_COLS.map(c => [c, r[c] ?? null]))))));
  }
  return out;
}

// ---------------------------------------------------------------- topics
/**
 * taxonomy's resolveTopic, failing soft: {topic_id, confidence, via} placed at ACCEPT or above, otherwise
 * {topic_id: null, queue} with a label queue item built here when taxonomy gives none.
 */
export async function placeTopic(env, user, { texts, system = null, card_id = null, note_id = null, ref = null, topic_id = null, gap_id = null, source, source_ref, label = null }) {
  const clean = (texts || []).filter(t => typeof t === 'string' && t.trim());
  let r = null;
  if (clean.length || card_id || note_id || ref || topic_id) {
    try {
      r = await io.resolveTopic(env, user, { texts: clean, system, card_id, note_id, ref, topic_id, gap_id, source, source_ref });
    } catch (e) {
      if (!noTable(e)) console.error('resolveTopic failed', e && e.message);
    }
  }
  const hold = r && r.held ? { held: true, sitting_id: r.sitting_id || null } : {};
  if (r && r.topic_id && (r.confidence == null || r.confidence >= ACCEPT)) {
    // A cut-off label placed by prefix comes back as `learn`: written as an alias, the same label matches exactly next time.
    const learn = (Array.isArray(r.learn) ? r.learn : []).filter(l => l && typeof l.alias === 'string' && l.alias.trim())
      .map(l => ({ alias: l.alias.trim().slice(0, 200), kind: l.kind || 'truncated', topic_id: r.topic_id, source: source || 'code', source_ref: source_ref || null }));
    return { topic_id: r.topic_id, via: r.via || 'resolve', ...(learn.length ? { learn } : {}), ...hold };
  }
  // taxonomy's queue item carries a user-keyed id; ingestion keeps raw keys until it writes.
  let queue = r && r.queue && r.queue.id ? { ...r.queue, id: rawKey(user, r.queue.id) } : null;
  const raw = clean[0] || null;
  if (!queue && raw) {
    const norm = normLabel(raw);
    if (norm) queue = { id: labelQueueKey(norm), kind: 'label', label_raw: raw.slice(0, 200), label_norm: norm, context: { system, source } };
  }
  // No topic words at all (an Anki record logged without a topic): its own label ('UW 4647') waits in the queue so
  // Claude can place it, and is never learned as a topic's alias (B3-6).
  if (!queue && !raw && typeof label === 'string' && normLabel(label)) {
    const norm = normLabel(label);
    queue = { id: labelQueueKey(norm), kind: 'label', label_raw: label.slice(0, 200), label_norm: norm, context: { system, source, no_alias: true } };
  }
  if (queue && !queue.candidates && r && Array.isArray(r.candidates)) queue = { ...queue, candidates: r.candidates.slice(0, 5) };
  return { topic_id: null, queue, ...hold };
}

export function learnStatements(env, user, places, t = nowMs()) {
  const rows = [], seen = new Set();
  for (const p of places || []) {
    if (!p || p.held || !Array.isArray(p.learn)) continue;
    for (const l of p.learn) {
      const key = normLabel(l.alias);
      if (!key || seen.has(`${key}|${l.topic_id}`)) continue;
      seen.add(`${key}|${l.topic_id}`);
      rows.push({ alias_key: key, topic_id: l.topic_id, alias: l.alias, kind: 'truncated', source: l.source, source_ref: l.source_ref });
    }
  }
  if (!rows.length) return [];
  return [env.DB.prepare(`INSERT INTO topic_aliases (user_id, alias_key, topic_id, alias, kind, status, source, source_ref, created_by, created_at)
    SELECT ?1, json_extract(value, '$.alias_key'), json_extract(value, '$.topic_id'), json_extract(value, '$.alias'), json_extract(value, '$.kind'), 'active',
      json_extract(value, '$.source'), json_extract(value, '$.source_ref'), 'code', ?2
    FROM json_each(?3) WHERE EXISTS (SELECT 1 FROM topics t WHERE t.user_id = ?1 AND t.id = json_extract(value, '$.topic_id') AND t.status IN ('proposed', 'confirmed'))
    ON CONFLICT (user_id, alias_key, topic_id) DO NOTHING`).bind(user, t, JSON.stringify(rows))];
}

/** How many full resolveTopic calls one invocation may make (about three queries each): env.D1_QUERY_BUDGET / 3. */
export const resolveBudget = env => Math.max(4, Math.floor((Number(env && env.D1_QUERY_BUDGET) || 45) / 3));
const textsOf = r => (r.texts || []).filter(t => typeof t === 'string' && t.trim());

export async function placeTopics(env, user, reqs) {
  const out = new Array(reqs.length).fill(null);
  let R = null;
  try { R = await LOADERS.resolve(); } catch { R = null; }
  const plain = R && typeof R.decide === 'function' && typeof R.fetchAliases === 'function'
    ? reqs.map((r, i) => (!r.card_id && !r.note_id && !r.ref && !r.topic_id && textsOf(r).length ? i : -1)).filter(i => i >= 0) : [];
  if (plain.length) {
    const plans = new Map(plain.map(i => [i, R.plan(textsOf(reqs[i]))]));
    const all = [...plans.values()];
    let data = null;
    try {
      data = await R.fetchAliases(env, user, [...new Set(all.flatMap(p => p.keys))], [...new Set(all.flatMap(p => p.cutKeys))]);
    } catch (e) {
      if (!noTable(e)) console.error('alias read failed', e && e.message);
    }
    if (data) {
      for (const [i, pl] of plans) {
        const d = R.decide(pl, data, R.hintSystems ? R.hintSystems(null, reqs[i].system || null) : R.resolveCategory ? R.resolveCategory(reqs[i].system || null) : null);
        if (d && d.topic_id && (d.confidence == null || d.confidence >= ACCEPT)) {
          const learn = (Array.isArray(d.learn) ? d.learn : []).filter(l => l && typeof l.alias === 'string' && l.alias.trim())
            .map(l => ({ alias: l.alias.trim().slice(0, 200), kind: 'truncated', topic_id: d.topic_id, source: reqs[i].source || 'code', source_ref: reqs[i].source_ref || null }));
          out[i] = { topic_id: d.topic_id, via: d.via || 'alias', ...(learn.length ? { learn } : {}) };
        }
      }
    }
  }
  let budget = resolveBudget(env);
  for (let i = 0; i < reqs.length; i++) {
    if (out[i]) continue;
    if (budget-- > 0) { out[i] = await placeTopic(env, user, reqs[i]); continue; }
    const raw = textsOf(reqs[i])[0];
    const norm = raw ? normLabel(raw) : '';
    out[i] = { topic_id: null, queue: norm ? { id: labelQueueKey(norm), kind: 'label', label_raw: raw.slice(0, 200), label_norm: norm,
      context: { system: reqs[i].system || null, source: reqs[i].source || null } } : null };
  }
  return out;
}

/** Names and categories for topic ids, and categories for systems, in one batch: {topics: Map, systems: Map}. */
export async function lookups(env, user, { topicIds = [], systems = [] } = {}) {
  const topics = new Map(), cats = new Map();
  const tIds = [...new Set(topicIds.filter(Boolean))], sKeys = [...new Set(systems.filter(Boolean).map(normLabel))];
  if (!tIds.length && !sKeys.length) return { topics, systems: cats };
  try {
    const [t, s] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, category_id FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(user, JSON.stringify(tIds)),
      env.DB.prepare(`SELECT alias_key, category_id FROM category_aliases WHERE user_id = ? AND category_id IS NOT NULL
        AND alias_key IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(sKeys)),
    ]);
    for (const r of t.results || []) topics.set(r.id, r);
    for (const r of s.results || []) if (!cats.has(r.alias_key)) cats.set(r.alias_key, r.category_id);
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  return { topics, systems: cats };
}

const cap = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const RESULT_WORD = { wrong: 'wrong', flawed: 'right for a shaky reason' };
/** A miss event's summary, from its label and topic name only (never question or gap text). */
export const missSummary = (m, name) => cap(`${m.label}: ${RESULT_WORD[m.result] || m.result}${name ? ` on ${name}` : ', not on the map yet'}`);

const HASH_COLS = MISS_INGEST_COLS.filter(c => !['src_hash', 'updated_at'].includes(c));
const parseList = s => { try { const v = typeof s === 'string' ? JSON.parse(s) : s; return Array.isArray(v) ? v : []; } catch { return []; } };
const MISS_DEFAULTS = { slow: 0, held: 0, match_status: 'open', look_alike_names_json: '[]', retests_json: '[]', anki_note_ids_json: '[]' };
const TOPIC_FIELDS = ['topic_id', 'category_id', 'queue_id', 'match_status', 'match_method', 'label_norm'];
export function finishMiss(user, key, base, existing, place, look, t) {
  const sticky = existing && STICKY_METHODS.includes(existing.match_method);
  const row = { ...base, id: userKey(user, key), user_id: user };
  const keep = sticky || (existing && !place.unplace && (place.topic_id ? place.topic_id === existing.topic_id : !!(existing.topic_id || existing.queue_id || !place.queue)));
  if (keep) {
    for (const c of TOPIC_FIELDS) row[c] = existing[c];
    if (place.pending && row.topic_id && CODE_PLACED.includes(row.match_method)) row.queue_id = userKey(user, place.pending.id);
  } else {
    const topic = place.topic_id ? look.topics.get(place.topic_id) : null;
    row.topic_id = place.topic_id || null;
    row.category_id = (topic && topic.category_id) || look.systems.get(normLabel(base.system_raw)) || null;
    row.queue_id = place.topic_id ? null : place.queue ? userKey(user, place.queue.id) : null;
    row.label_norm = place.queue ? place.queue.label_norm : normLabel(base.condition_raw || base.topic_raw || base.label);
    row.match_status = place.topic_id ? 'matched' : place.queue ? 'queued' : 'open';
    row.match_method = place.topic_id ? (place.via === 'id' ? 'explicit' : place.via === 'label' ? 'label' : 'alias') : null;
  }
  // Hashed with the table's defaults filled in, so a row read back from D1 hashes like the row first built.
  // next_retest_day is the hub's re-tests' now (map/retests.js, 0036), so ingestion never writes it: it is hashed as the
  // log's own list gives it (as it was stored before), so a re-test booked or answered here never makes a row look changed.
  const hashed = { ...row, next_retest_day: nextRetestDay(parseList(row.retests_json)) };
  delete row.next_retest_day;
  row.src_hash = rowHash({ ...MISS_DEFAULTS, ...Object.fromEntries(Object.entries(hashed).filter(([, v]) => v != null)) }, HASH_COLS);
  row.changed = !existing || existing.src_hash !== row.src_hash || existing.deleted_at != null;
  row.updated_at = t;
  // Insert-only (the upsert never updates them), but SQLite checks NOT NULL before it sees the conflict.
  row.created_by = (existing && existing.created_by) || 'code';
  row.created_at = (existing && existing.created_at) || t;
  return row;
}

export const missStatement = (env, row) => {
  const { changed, ...clean } = row;
  const [sql, args] = missUpsert(clean);
  return env.DB.prepare(sql).bind(...args);
};

const hasLookAlike = m => !!(m.look_alikes || (m.look_alike_names_json && m.look_alike_names_json !== '[]') || /\s(?:vs\.?|versus)\s/i.test(m.topic_raw || ''));

/**
 * The look-alikes of misses a write changed: links' versus links and support (links-ingest.js linkStatements,
 * {rows, events} for the same commit) and weakness's confused_with rows in the miss's slots 1 and 2 (the
 * look-alike's topic, with the miss's facts). Bounded per invocation; returns {rows, events, upsert, held, remove}.
 */
export async function lookAlikeParts(env, user, misses, t) {
  const out = { rows: [], events: [], upsert: [], held: [], remove: [], deferred: [] };
  // Two misses of one batch that name the same look-alike would each plan the same new link or queue item (links
  // and queue rows are planned from what D1 holds now), and the second insert would fail the whole batch. The
  // second miss waits for a follow-up batch (lookAlikeFollowUp), which then sees the first one's rows.
  const taken = new Set();
  const rowKey = r => `${r.table}|${JSON.stringify(Object.keys(r.key || {}).sort().map(k => [k, r.key[k]]))}`;
  const todo = (misses || []).filter(m => m && m.topic_id && m.deleted_at == null && hasLookAlike(m));
  if (!todo.length) return out;
  let L;
  try { L = await LOADERS.linksIngest(); } catch { return out; }
  const max = Math.max(2, Math.floor((Number(env && env.D1_QUERY_BUDGET) || 45) / 6));
  if (todo.length > max) console.log(JSON.stringify({ lookalikes_deferred: todo.length - max }));
  const slice = todo.slice(0, max);
  // weakness's confused_with rows in the miss's slots 1 and 2.
  const cwRows = (m, cands) => {
    const obs = rawKey(user, m.id);
    cands.forEach((c, i) => (m.held ? out.held : out.upsert).push({
      obs_key: obs, slot: i + 1, kind: 'confused_with', topic_id: c.topic_id, at: m.at, day: m.day, source: m.source, source_ref: m.source_ref || null,
      miss_id: m.id, sitting_id: m.sitting_id || null, held: m.held ? 1 : 0, result: m.result, outcome: m.outcome || null, confidence: m.confidence || null,
      error_type: m.error_type || null, flaw_kind: m.flaw_kind || null, detail_json: JSON.stringify({ label: m.label }),
    }));
    for (let slot = cands.length + 1; slot <= 2; slot++) out.remove.push({ obs_key: obs, slot });
  };
  // Released misses in one plan (links-ingest fromMisses): misses naming the same look-alike share one link and
  // one queue item, so nothing is deferred and each miss's look-alikes are resolved once (B2-3).
  const batched = new Set();
  const live = slice.filter(m => !m.held);
  if (live.length && typeof L.fromMisses === 'function') {
    try {
      const part = await L.fromMisses(env, user, live, { now: t });
      for (const r of part.rows) taken.add(rowKey(r));
      out.rows.push(...part.rows);
      out.events.push(...part.events);
      for (const m of live) { cwRows(m, (part.cw.get(m.id) || []).filter(c => c.topic_id && c.topic_id !== m.topic_id).slice(0, 2)); batched.add(m.id); }
    } catch (e) {
      if (!noTable(e)) console.error('look-alikes (batch) failed; one by one', e && e.message);
    }
  }
  for (const m of slice) {
    if (batched.has(m.id)) continue;
    try {
      const part = typeof L.linkStatements === 'function' ? await L.linkStatements(env, user, { miss: m, ctx: { now: t } }) : null;
      const keys = ((part && part.rows) || []).map(rowKey);
      if (keys.some(k => taken.has(k))) { out.deferred.push(m); continue; }
      keys.forEach(k => taken.add(k));
      if (part) { out.rows.push(...(part.rows || [])); out.events.push(...(part.events || [])); }
      if (typeof L.lookAlikeCandidates !== 'function') continue;
      cwRows(m, (await L.lookAlikeCandidates(env, user, m)).filter(c => c.topic_id && c.topic_id !== m.topic_id).slice(0, 2));
    } catch (e) {
      if (!noTable(e)) console.error('look-alikes failed', m.id, e && e.message);
    }
  }
  return out;
}

/**
 * The look-alikes lookAlikeParts deferred (a second miss naming a look-alike an earlier miss of the same batch
 * also named), each round in its own code batch once the batch before it is written. Fails soft: a look-alike
 * that cannot be written never undoes the misses already written.
 */
export async function lookAlikeFollowUp(env, user, misses, via) {
  let todo = misses || [], rounds = 0;
  try {
    while (todo.length && rounds++ < 25) {
      const t = nowMs();
      const la = await lookAlikeParts(env, user, todo, t);
      await commit(env, user, { via, statements: evidenceStatements(env, user, la.held, t), rows: la.rows,
        evidence: { upsert: la.upsert, remove: la.remove }, events: la.events, recompute: la.upsert.map(r => r.topic_id) });
      todo = la.deferred;
    }
    if (todo.length) console.error(JSON.stringify({ lookalike_followup_left: todo.length, misses: todo.slice(0, 10).map(m => m.id) }));
  } catch (e) { console.error('look-alike follow-up failed', e && e.message); }
}

export async function lookAlikesAfter(env, user, batchId) {
  if (!batchId) return { misses: 0 };
  let misses = [];
  try {
    const ids = ((await env.DB.prepare(`SELECT DISTINCT target_id FROM map_events WHERE user_id = ? AND batch_id = ? AND kind = 'queue.resolved'
      AND target_type = 'miss' LIMIT 100`).bind(user, batchId).all()).results || []).map(r => r.target_id);
    if (!ids.length) return { misses: 0 };
    misses = (await env.DB.prepare(`SELECT * FROM misses WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND held = 0 AND deleted_at IS NULL
      AND topic_id IS NOT NULL`).bind(user, JSON.stringify(ids)).all()).results || [];
  } catch (e) { if (noTable(e)) return { misses: 0 }; throw e; }
  if (!misses.length) return { misses: 0 };
  const t = nowMs();
  const la = await lookAlikeParts(env, user, misses, t);
  const w = await commit(env, user, { via: 'hook:placed', statements: evidenceStatements(env, user, la.held, t), rows: la.rows,
    evidence: { upsert: la.upsert, remove: la.remove }, events: la.events, recompute: la.upsert.map(r => r.topic_id) });
  if (la.deferred.length) await lookAlikeFollowUp(env, user, la.deferred, 'hook:placed');
  return { misses: misses.length, batch_id: w && w.batch_id };
}

/**
 * Turn {key, base, answer, existing, place} items into one commit: miss upserts, evidence (held rows as
 * statements), queue items for unplaced live rows, and miss events. opts: {via, held, source, sitting_id}.
 */
export async function writeQuestions(env, user, items, look, opts, t) {
  const statements = [], upsert = [], held = [], events = [], recompute = [], queue = [], changed = [], left = [];
  for (const it of items) {
    const isHeld = it.held ? 1 : 0;
    let missRow = null;
    if (it.base) {
      missRow = finishMiss(user, it.key, { ...it.base, held: isHeld, deleted_at: null }, it.existing, it.place, look, t);
      if (missRow.changed) {
        statements.push(missStatement(env, missRow));
        changed.push(missRow);
        if (it.existing && it.existing.topic_id && missRow.topic_id !== it.existing.topic_id) left.push({ id: missRow.id, topic_id: missRow.topic_id });
        if (!isHeld) {
          const name = missRow.topic_id ? look.topics.get(missRow.topic_id)?.name : null;
          events.push({ kind: it.existing && it.existing.deleted_at == null ? 'miss.updated' : 'miss.added', target_type: 'miss', target_id: missRow.id,
            topic_id: missRow.topic_id, summary: missSummary(missRow, name), before: null, after: { topic_id: missRow.topic_id, label: missRow.label, result: missRow.result, error_type: missRow.error_type } });
        }
      }
    } else if (it.existing && it.existing.deleted_at == null) {
      statements.push(env.DB.prepare('UPDATE misses SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?').bind(t, t, user, it.existing.id));
      left.push({ id: it.existing.id, topic_id: null });
      if (!isHeld) events.push({ kind: 'miss.deleted', target_type: 'miss', target_id: it.existing.id, topic_id: it.existing.topic_id,
        summary: cap(`${it.existing.label}: no longer counted as a miss`), before: null, after: { topic_id: it.existing.topic_id, label: it.existing.label } });
    }
    const topicId = missRow ? missRow.topic_id : it.place.topic_id;
    const queueId = missRow ? missRow.queue_id : it.place.queue ? userKey(user, it.place.queue.id) : null;
    const ev = questionEvidence({ obs_key: it.key, answer: it.answer, at: it.at, day: it.day, source: opts.source, source_ref: it.source_ref,
      miss_id: missRow ? missRow.id : null, sitting_id: opts.sitting_id || null, held: isHeld });
    if (it.evidence && it.existing && it.existing.anki_mistake_id != null && it.existing.block_id == null) {
      const assumed = it.existing.confidence_source === 'assumed' && ev.confidence != null;
      for (const k of ['confidence', 'error_type', 'outcome']) if (it.evidence[k] != null && !(k === 'confidence' && assumed)) ev[k] = it.evidence[k];
    }
    ev.topic_id = topicId || null;
    ev.queue_id = topicId ? null : queueId;
    ev.label_norm = topicId ? null : missRow ? missRow.label_norm : it.place.queue ? it.place.queue.label_norm : null;
    ev.category_id = missRow ? missRow.category_id : (topicId && look.topics.get(topicId)?.category_id) || look.systems.get(normLabel(it.answer.system)) || null;
    if (!sameEvidence(ev, it.evidence)) {
      (isHeld ? held : upsert).push(ev);
      if (!isHeld && topicId) recompute.push(topicId);
      if (!isHeld && it.evidence && it.evidence.topic_id && it.evidence.topic_id !== topicId) recompute.push(it.evidence.topic_id);
    }
    if (!isHeld && !topicId && it.place.queue && (missRow ? missRow.changed : !it.evidence)) queue.push(it.place.queue);
    if (!isHeld && missRow && missRow.changed && it.place.pending && missRow.queue_id === userKey(user, it.place.pending.id)
      && !(it.existing && it.existing.queue_id === missRow.queue_id)) queue.push(it.place.pending);
  }
  // Links and confused_with for the misses that changed (their events carry their own before and after, and go
  // first so none pairs with another's row).
  const la = await lookAlikeParts(env, user, changed, t);
  const stale = await staleSupportParts(env, user, left);
  upsert.push(...la.upsert);
  for (const r of la.upsert) recompute.push(r.topic_id);
  statements.push(...evidenceStatements(env, user, [...held, ...la.held], t), ...queueStatements(env, user, queue, t),
    ...learnStatements(env, user, items.filter(it => !it.held).map(it => it.place), t));
  const w = await commit(env, user, { via: opts.via, statements, rows: [...la.rows, ...stale.rows], evidence: { upsert, remove: la.remove },
    events: [...la.events, ...stale.events, ...events], recompute });
  if (la.deferred.length) await lookAlikeFollowUp(env, user, la.deferred, opts.via);
  return w;
}

/**
 * One analysed hub question into the map: an evidence row for every analysed answer, plus a miss for a wrong
 * or flawed one. Held while its sitting is not releasable. Text fields are leak-checked against the question.
 */
export async function ingestAnalysis(env, user, blockId, qIndex) {
  const key = hubKey(blockId, qIndex);
  const [a, b, q, m, e, tr] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM analyses WHERE block_id = ? AND q_index = ?').bind(blockId, qIndex),
    env.DB.prepare(`SELECT b.id, b.sitting_id, b.idx, b.q_from, b.started_at, b.ended_at, json_extract(b.state_json, ?) AS conf, json_extract(b.state_json, ?) AS secs,
      s.name, s.status, s.exam_id, s.exam_type FROM blocks b JOIN sittings s ON s.id = b.sitting_id WHERE b.id = ?`)
      .bind(`$.conf."${qIndex}"`, `$.time_on_q."${qIndex}"`, blockId),
    env.DB.prepare(`SELECT json_extract(e.questions_json, ?) AS q FROM blocks b JOIN sittings s ON s.id = b.sitting_id JOIN exams e ON e.id = s.exam_id
      WHERE b.id = ?`).bind(`$[${Math.trunc(qIndex)}]`, blockId),
    env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND id = ?').bind(user, userKey(user, key)),
    env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND obs_key = ? AND slot = 0').bind(user, key),
    env.DB.prepare('SELECT segments_json FROM transcripts WHERE block_id = ? AND q_index = ?').bind(blockId, qIndex),
  ]);
  let analysis = a.results[0];
  const block = b.results[0], qRow = q.results[0];
  if (!analysis || !block || !qRow || !qRow.q) return { skipped: true };
  if (!(typeof analysis.topic === 'string' && analysis.topic.trim()) && block.exam_id) {
    const label = await examLabel(env, user, block.exam_id, qIndex);
    if (label) analysis = { ...analysis, topic: label.topic_raw, system: analysis.system || label.system_raw };
  }
  const question = JSON.parse(qRow.q);
  const sitting = { id: block.sitting_id, name: block.name, status: block.status, exam_type: block.exam_type };
  const at = (block.started_at || nowMs()) + (qIndex - block.q_from) * 1000;
  // Confidence as analyze.js and Smart review read it (v16): a tap, else sure, lean or guess said aloud (B3-4).
  const said = confFor(block.conf, { segments_json: (tr.results[0] || {}).segments_json || '[]' });
  const r = fromAnalysis(analysis, { sitting, block, num: question.num ?? qIndex + 1, conf: said.conf, confFrom: said.from, secs: Number(block.secs),
    index: buildLeakIndex(question), day: londonDay(at), at });
  // Not done, or a right with nothing heard and no topic: nothing to place (rows already made stay).
  if (!r) return { skipped: true };
  const existing = m.results[0] || null;
  const evRow = e.results[0] || null;
  const { answer, miss: base } = r;
  const held = !releasable(sitting);
  // A check saved again with another topic (save_check's overwrite) tries the new words on a row code placed (B3-6).
  const moved = wordsChanged(existing, answer.topic);
  const placed = !moved && ((existing && (existing.topic_id || STICKY_METHODS.includes(existing.match_method))) || (evRow && evRow.topic_id));
  let place = placed ? { topic_id: (existing && existing.topic_id) || evRow.topic_id || null }
    : await placeTopic(env, user, { texts: [answer.topic], system: answer.system, source: 'hub', source_ref: key });
  // The new words do not place it: the row stays, and waits on their queue item too (B4-3).
  if (moved && !place.topic_id && place.queue) place = { ...place, pending: place.queue };
  const look = await lookups(env, user, { topicIds: [place.topic_id, existing && existing.topic_id], systems: [answer.system] });
  const w = await writeQuestions(env, user, [{ key, base, answer, existing, place, held, at, day: londonDay(at), evidence: evRow,
    source_ref: `block:${blockId}:q${qIndex}` }], look, { via: 'hook:analysis', source: 'hub', sitting_id: sitting.id }, nowMs());
  return { held, miss: !!base, batch: w && w.batch_id };
}

/** The labeller's topic words for one exam question ({topic_raw, system_raw}), or null (none yet, or before 0013). */
export async function examLabel(env, user, examId, qIndex) {
  try {
    return await env.DB.prepare(`SELECT topic_raw, system_raw FROM exam_topics WHERE user_id = ? AND exam_id = ? AND q_index = ?
        AND status = 'labelled' AND topic_raw IS NOT NULL`).bind(user, examId, qIndex).first();
  } catch (e) { if (noTable(e)) return null; throw e; }
}

export async function ingestUworldQuestions(env, user, blockId, questions) {
  const list = (questions || []).filter(q => q && Number.isInteger(q.q));
  if (!list.length) return { skipped: true };
  const qids = [...new Set(list.map(q => q.uworld_id).filter(Boolean))];
  const [b, mq] = await env.DB.batch([
    env.DB.prepare('SELECT id, day FROM uworld_blocks WHERE id = ?').bind(blockId),
    env.DB.prepare(`SELECT * FROM misses WHERE user_id = ? AND (uw_qid IN (SELECT value FROM json_each(?)) OR uworld_block_id = ?)`)
      .bind(user, JSON.stringify(qids), blockId),
  ]);
  const block = b.results[0];
  if (!block) return { skipped: true };
  const misses = mq.results || [];
  const items = [];
  for (const q of list) {
    const r = fromUworld(q, block);
    if (!r) continue;
    let key = q.uworld_id ? uwKey(q.uworld_id, block.day) : uwbKey(block.id, q.q);
    let existing = misses.find(x => x.id === userKey(user, key)) || null;
    if (!existing && q.uworld_id) {
      const near = misses.filter(x => x.uw_qid === q.uworld_id && x.day && dayDiff(x.day, block.day) <= 2)
        .sort((x, y) => dayDiff(x.day, block.day) - dayDiff(y.day, block.day))[0];
      if (near) { existing = near; key = rawKey(user, near.id); }
    }
    if (!existing) existing = misses.find(x => x.uworld_block_id === block.id && x.uworld_q === q.q && x.deleted_at == null) || null;
    if (existing) key = rawKey(user, existing.id);
    items.push({ key, r, existing, q });
  }
  if (!items.length) return { skipped: true };
  const ev = await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))')
    .bind(user, JSON.stringify(items.map(i => i.key))).all();
  const evBy = new Map((ev.results || []).map(x => [x.obs_key, x]));
  // One resolve per distinct label, and only for rows not already placed.
  const places = new Map();
  const wordsOf = it => (it.r.miss && it.r.miss.condition_raw) || it.r.answer.topic;
  for (const it of items) {
    const relabel = it.existing && it.existing.anki_mistake_id == null && it.r.miss && wordsChanged(it.existing, wordsOf(it));
    const needs = relabel || (!(it.existing && (it.existing.topic_id || STICKY_METHODS.includes(it.existing.match_method))) && !(evBy.get(it.key) || {}).topic_id);
    const k = `${normLabel(wordsOf(it))}|${normLabel(it.r.answer.system)}`;
    if (needs && !places.has(k)) places.set(k, null);
    it.placeKey = needs ? k : null;
  }
  const keys = [...places.keys()];
  const firstOf = k => items.find(x => x.placeKey === k);
  const reqs = keys.map(k => { const it = firstOf(k); return { texts: [wordsOf(it)], system: it.r.answer.system, source: 'uworld', source_ref: `uworld:${blockId}` }; });
  (await placeTopics(env, user, reqs)).forEach((p, i) => places.set(keys[i], p));
  const waiting = keys.filter(k => { const p = places.get(k), it = firstOf(k); return p && !p.topic_id && p.queue && it.r.miss && it.r.miss.condition_raw && it.r.answer.topic; });
  const coarse = waiting.length ? await placeTopics(env, user, waiting.map(k => { const it = firstOf(k); return { texts: [it.r.answer.topic], system: it.r.answer.system, source: 'uworld', source_ref: `uworld:${blockId}` }; })) : [];
  const look = await lookups(env, user, {
    topicIds: [...[...places.values()].map(p => p && p.topic_id), ...coarse.map(p => p && p.topic_id), ...items.map(i => i.existing && i.existing.topic_id), ...items.map(i => (evBy.get(i.key) || {}).topic_id)],
    systems: items.map(i => i.r.answer.system),
  });
  waiting.forEach((k, i) => {
    const id = coarse[i] && coarse[i].topic_id, p = places.get(k);
    if (!id) return;
    const t = look.topics.get(id);
    const rest = (p.queue.candidates || []).filter(c => c && c.id !== id);
    places.set(k, { ...p, queue: { ...p.queue, candidates: [{ id, name: t ? t.name : null, score: ACCEPT }, ...rest].slice(0, 5) } });
  });
  const t = nowMs();
  const rows = items.map(it => {
    const evRow = evBy.get(it.key) || null;
    let place = it.placeKey ? places.get(it.placeKey) : { topic_id: (it.existing && it.existing.topic_id) || (evRow && evRow.topic_id) || null };
    // A relabel whose new words do not place it: the row stays, and waits on their queue item too (B4-3).
    if (place && !place.topic_id && place.queue && it.existing && it.existing.topic_id) place = { ...place, pending: place.queue };
    const base = it.r.miss ? (it.existing ? mergeHubIntoAnki(it.existing, it.r.miss) : it.r.miss) : null;
    const at = it.r.miss ? it.r.miss.at : Date.parse(`${block.day}T12:00:00Z`) + it.q.q * 1000;
    return { key: it.key, base, answer: it.r.answer, existing: it.existing, place, held: 0, at, day: block.day, evidence: evRow, source_ref: `uworld:${blockId}:q${it.q.q}` };
  });
  const w = await writeQuestions(env, user, rows, look, { via: 'hook:uworld', source: 'uworld' }, t);
  return { questions: rows.length, misses: rows.filter(r => r.base).length, batch: w && w.batch_id, unseen: qids.filter(id => !misses.some(m => m.uw_qid === id && m.anki_mistake_id != null)) };
}

const ANKI_KEEPS = ['source', 'source_ref', 'label', 'rule', 'my_reasoning', 'reasoning_source', 'look_alikes', 'look_alike_names_json', 'learning_point',
  'confidence', 'confidence_source', 'error_type', 'outcome', 'condition_raw', 'topic_raw', 'system_raw', 'anki_mistake_id', 'retests_json', 'next_retest_day', 'anki_note_ids_json'];
function mergeHubIntoAnki(existing, hub) {
  const out = {};
  for (const c of MISS_INGEST_COLS) if (existing[c] !== undefined) out[c] = existing[c];
  for (const [k, v] of Object.entries(hub)) {
    if (v == null) continue;
    if (k === 'confidence' || k === 'confidence_source') { if (confidenceWinner(existing, hub, 'uworld') !== false) out[k] = v; continue; }
    if (existing.anki_mistake_id != null && ANKI_KEEPS.includes(k) && existing[k] != null && existing[k] !== '[]') continue;
    out[k] = v;
  }
  delete out.src_hash; delete out.updated_at; delete out.deleted_at; delete out.held;
  for (const c of TOPIC_FIELDS) delete out[c];
  return out;
}

// ---------------------------------------------------------------- sittings
/** guard.js, the MCP tools and teach: may this sitting's results be shown? Unknown or missing ids count as visible. */
export async function sittingVisible(env, user, sittingId) {
  if (!sittingId) return true;
  const s = await env.DB.prepare('SELECT status FROM sittings WHERE id = ?').bind(String(sittingId)).first();
  return !s || releasable(s);
}

const n = (k, v) => `${v} ${k}${v === 1 ? '' : k === 'miss' ? 'es' : 's'}`;

/**
 * A sitting has ended: in one batch its held misses, evidence and gaps go live, their topics are marked dirty
 * (the feed and the minute cron recompute them), unplaced rows get their queue items, and one
 * sitting.released event says what arrived. Links' own held rows follow (releaseLinks).
 */
export async function releaseSitting(env, user, sittingId) {
  const t = nowMs();
  const [c, um, ug] = await env.DB.batch([
    env.DB.prepare(`SELECT s.name,
      (SELECT count(*) FROM misses WHERE user_id = ? AND sitting_id = s.id AND held = 1 AND deleted_at IS NULL) AS misses,
      (SELECT count(*) FROM evidence WHERE user_id = ? AND sitting_id = s.id AND held = 1 AND kind = 'question') AS answers,
      (SELECT count(*) FROM evidence WHERE user_id = ? AND sitting_id = s.id AND held = 1) AS ev_n,
      (SELECT count(*) FROM gaps WHERE user_id = ? AND sitting_id = s.id AND held = 1) AS gaps
      FROM sittings s WHERE s.id = ?`).bind(user, user, user, user, sittingId),
    env.DB.prepare(`SELECT queue_id, label_norm, topic_raw, label, system_raw FROM misses WHERE user_id = ? AND sitting_id = ? AND held = 1
      AND topic_id IS NULL AND queue_id IS NOT NULL AND deleted_at IS NULL LIMIT 300`).bind(user, sittingId),
    env.DB.prepare(`SELECT id, at, day, source, topic, gap, said, ref FROM gaps WHERE user_id = ? AND sitting_id = ? AND held = 1 AND topic_id IS NULL LIMIT 100`).bind(user, sittingId),
  ]);
  const k = c.results[0];
  if (!k || !(k.misses || k.ev_n || k.gaps)) return { released: false };
  const queue = [
    ...um.results.map(m => ({ id: rawKey(user, m.queue_id), kind: 'label', label_norm: m.label_norm || normLabel(m.topic_raw), label_raw: m.topic_raw || m.label,
      context: { system: m.system_raw, source: 'hub' } })),
    ...ug.results.map(g => gapQueueItem(g)),
  ].filter(q => q.label_norm);
  const statements = [
    env.DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at)
      SELECT DISTINCT user_id, topic_id, 'release', ? FROM evidence WHERE user_id = ? AND sitting_id = ? AND held = 1 AND topic_id IS NOT NULL
      ON CONFLICT(user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(t, user, sittingId),
    ...queueStatements(env, user, queue, t),
    env.DB.prepare('UPDATE misses SET held = 0, updated_at = ? WHERE user_id = ? AND sitting_id = ? AND held = 1').bind(t, user, sittingId),
    env.DB.prepare('UPDATE evidence SET held = 0, updated_at = ? WHERE user_id = ? AND sitting_id = ? AND held = 1').bind(t, user, sittingId),
    env.DB.prepare('UPDATE gaps SET held = 0 WHERE user_id = ? AND sitting_id = ? AND held = 1').bind(user, sittingId),
  ];
  // links' held support for this sitting, released in the same batch (its rows pair with its events).
  const links = (await hook('releaseLinks', () => io.releaseLinks(env, user, sittingId, { now: t }))) || {};
  const summary = cap(`${k.name}: ${n('miss', k.misses)}, ${n('answer', k.answers)} and ${n('gap', k.gaps)} are on the map now`);
  const w = await commit(env, user, { via: 'hook:release', statements, rows: links.rows || [], events: [...(links.events || []), { kind: 'sitting.released',
    target_type: 'sitting', target_id: sittingId, summary, before: null, after: { misses_n: k.misses, answers_n: k.answers, gaps_n: k.gaps } }] });
  if (k.misses || k.gaps) await hook('patterns', async () => (await import('../patterns.js')).enqueuePattern(env, user, 'nbme', sittingId));
  return { released: true, misses: k.misses, answers: k.answers, gaps: k.gaps, batch: w && w.batch_id };
}

/**
 * Minute cron: a finished sitting whose rows are still held (its release hook failed, or it was finished before
 * 0010 existed) is released now, one sitting a run. One indexed read when there is nothing to do.
 */
export async function sweepReleases(env, user) {
  const r = await env.DB.prepare(`SELECT s.id FROM sittings s WHERE s.status = 'done' AND s.id IN (
      SELECT sitting_id FROM evidence WHERE held = 1 AND user_id = ? UNION SELECT sitting_id FROM gaps WHERE held = 1 AND user_id = ?) LIMIT 1`)
    .bind(user, user).first();
  return r ? releaseSitting(env, user, r.id) : { released: false };
}

const GAP_WHEN = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
/** Where and when a gap was said, as its queue label when Claude gave no topic: "Gap said aloud while recording, 23 Oct, 12:05". */
export function gapLabel(g) {
  const where = GAP_SOURCE_LABEL[g && g.source] || 'noted';
  const at = Number(g && g.at);
  const when = Number.isFinite(at) && at > 0 ? GAP_WHEN.format(new Date(at)) : (g && g.day) || '';
  return `Gap ${where}${when ? `, ${when}` : ''}`;
}

/**
 * A gap's queue item: always its own ('gap:<id>', plan §6.4), labelled by the topic words Claude gave, else by where
 * and when it was said. A gap's own words never name a queue item or reach a summary (LS4-1: a spoken cue can carry
 * a stem read aloud); they ride in the context, checked again (guard.js gapSafe), for whoever places it.
 */
export function gapQueueItem(g) {
  const safe = gapSafe(g) || {};
  const label = String(g.topic || gapLabel(g)).slice(0, 200);
  return { id: `gap:${g.id}`, kind: 'gap', label_norm: normLabel(label) || 'gap', label_raw: label,
    context: { gap: safe.gap ? String(safe.gap).slice(0, 200) : null, said: safe.said ? String(safe.said).slice(0, 200) : null, ref: g.ref || null, source: 'gap',
      gap_source: g.source || null } };
}

export async function forgetSitting(env, user, sittingId) {
  const t = nowMs();
  const live = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM misses WHERE user_id = ? AND sitting_id = ? AND deleted_at IS NULL) AS misses,
      (SELECT count(*) FROM misses WHERE user_id = ? AND sitting_id = ? AND deleted_at IS NULL AND held = 0) AS live,
      (SELECT count(*) FROM evidence WHERE user_id = ? AND sitting_id = ?) AS ev_n`)
    .bind(user, sittingId, user, sittingId, user, sittingId).first();
  if (!live || !(live.misses || live.ev_n)) {
    await env.DB.prepare('UPDATE gaps SET held = 0, sitting_id = NULL, map_state = NULL WHERE user_id = ? AND sitting_id = ?').bind(user, sittingId).run();
    return { forgotten: false };
  }
  const statements = [
    env.DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at)
      SELECT DISTINCT user_id, topic_id, 'forget', ? FROM evidence WHERE user_id = ? AND sitting_id = ? AND held = 0 AND topic_id IS NOT NULL
      ON CONFLICT(user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(t, user, sittingId),
    env.DB.prepare('DELETE FROM evidence WHERE user_id = ? AND sitting_id = ?').bind(user, sittingId),
    env.DB.prepare('UPDATE misses SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND sitting_id = ? AND deleted_at IS NULL').bind(t, t, user, sittingId),
    env.DB.prepare('UPDATE gaps SET held = 0, sitting_id = NULL, map_state = NULL WHERE user_id = ? AND sitting_id = ?').bind(user, sittingId),
  ];
  const events = live.live ? [{ kind: 'map.resync', target_type: 'map', target_id: null, summary: cap(`A sitting was deleted: ${n('miss', live.live)} left the map`),
    before: null, after: { reason: 'sitting deleted' } }] : [];
  // Its misses' look-alike support goes with them (B3-8).
  const gone = ((await env.DB.prepare('SELECT id FROM misses WHERE user_id = ? AND sitting_id = ? AND deleted_at IS NULL LIMIT 500').bind(user, sittingId).all()).results || [])
    .map(r => ({ id: r.id, topic_id: null }));
  const stale = await staleSupportParts(env, user, gone);
  const w = await commit(env, user, { via: 'hook:forget', statements, rows: stale.rows, events: [...stale.events, ...events] });
  return { forgotten: true, misses: live.misses, batch: w && w.batch_id };
}

