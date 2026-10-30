// When stored scores are recomputed (plan §6.1, §7.3). weakness.js (WEA) owns the formula; this file owns when
// it runs and the bookkeeping around it:
//   - applyEvidenceOps (pure): a change's evidence ops applied in memory to the rows they touch;
//   - planEvidence: one read batch (the touched evidence rows and the topics' ev_rev), then the evidence
//     statements and, for undoable changes, one evidence.* event per added or removed row (so undo can put
//     them back);
//   - scoreStatements: for 20 topics or fewer, weakness's recomputeTopics in the change's own batch, guarded by
//     compare-and-set on topic_scores.ev_rev (a lost race sends the topic to topic_dirty); more topics, or no
//     scorer, go straight to topic_dirty;
//   - drainDirty: up to 20 dirty topics per call (the feed and the minute cron);
//   - hourlyRefresh: the hourly hook into weakness's refreshScores.
import { chunks, ident, sqlValue, summaryOf, rand, eventRow, eventStatements, notifyLive } from './events.js';

export const SAME_BATCH_MAX = 20;   // topics recomputed inside the change's own batch
export const DRAIN_DEFAULT = 20;
// Set by the first source of an observation and never replaced (plan §5.3).
export const FIRST_CREATOR = ['source', 'source_ref', 'created_by', 'created_at'];
const EV_KEY = ['user_id', 'obs_key', 'slot'];
const REQUIRED = ['obs_key', 'kind', 'at', 'day', 'source'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = (e, t) => new RegExp(`no such table:?\\s*(main\\.)?${t ? t : ''}`, 'i').test(String(e && e.message));
export const evKey = r => `${r.obs_key}#${Number(r.slot) || 0}`;
const live = r => !!r && Number(r.held) !== 1;

// weakness.js, loaded when first used (tests swap it with _setWeakness). Until WEA's file lands, every change
// still writes; its topics simply wait in topic_dirty.
let weakness;
export function _setWeakness(mod) { const prev = weakness; weakness = mod; return () => { weakness = prev; }; }
async function loadWeakness() {
  if (weakness !== undefined) return weakness;
  try { weakness = await import('./weakness.js'); } catch (e) { console.error('weakness.js not loaded', e && e.message); weakness = null; }
  return weakness;
}

// ------------------------------------------------------------------ evidence ops

// The ops in one shape: upsert [row], remove [{obs_key, slot|null}], repoint [{obs_keys, from_topic, queue_id, to_topic}].
export function normaliseOps(evidence, user) {
  const ops = { upsert: [], remove: [], repoint: [] };
  if (evidence == null) return ops;
  if (!isObj(evidence)) throw new Error('evidence must be {upsert, remove, repoint}');
  for (const r of evidence.upsert || []) {
    if (!isObj(r)) throw new Error('An evidence row must be an object');
    for (const c of REQUIRED) if (r[c] == null || r[c] === '') throw new Error(`An evidence row needs ${c}`);
    if (r.user_id != null && r.user_id !== user) throw new Error('That evidence row belongs to someone else');
    ops.upsert.push({ ...r, slot: Number(r.slot) || 0, user_id: user });
  }
  for (const k of evidence.remove || []) {
    if (typeof k === 'string' && k) ops.remove.push({ obs_key: k, slot: null });
    else if (isObj(k) && typeof k.obs_key === 'string' && k.obs_key) ops.remove.push({ obs_key: k.obs_key, slot: k.slot == null ? null : Number(k.slot) });
    else throw new Error('An evidence remove is an obs_key or {obs_key, slot}');
  }
  for (const p of evidence.repoint || []) {
    if (!isObj(p) || !('to_topic' in p)) throw new Error('A repoint needs to_topic');
    const obs_keys = Array.isArray(p.obs_keys) ? p.obs_keys.map(String) : [];
    if (!obs_keys.length && p.from_topic == null && p.queue_id == null) throw new Error('A repoint needs obs_keys, from_topic or queue_id');
    // slot: only that slot's rows move (a miss's own answer is slot 0; its confused_with rows in 1 and 2 keep their topics).
    ops.repoint.push({ obs_keys, from_topic: p.from_topic ?? null, queue_id: p.queue_id ?? null, to_topic: p.to_topic ?? null,
      slot: p.slot == null ? null : Number(p.slot) });
  }
  return ops;
}

// The columns an upsert row writes on conflict, and which of them only fill an empty value ($fill: true or a list).
function upsertCols(r) {
  const provided = Object.keys(r).filter(c => !c.startsWith('$') && !EV_KEY.includes(c) && c !== 'id' && !FIRST_CREATOR.includes(c) && c !== 'updated_at');
  const fill = r.$fill === true ? provided : Array.isArray(r.$fill) ? provided.filter(c => r.$fill.includes(c)) : [];
  return { provided, fill };
}

function newRow(r, now) {
  const row = { slot: 0, held: 0, detail_json: '{}', gen: 0, created_by: 'code', created_at: now };
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('$') && k !== 'id') row[k] = sqlValue(v);
  row.updated_at = now;
  return row;
}

// Matches a repoint against one stored row (as SQL does: obs_keys, or the from topic, or unplaced rows of a queue item).
const repointHits = (p, b) => (p.slot == null || Number(b.slot) === p.slot) && (p.obs_keys.includes(b.obs_key) || (p.from_topic != null && b.topic_id === p.from_topic)
  || (p.queue_id != null && b.topic_id == null && b.queue_id === p.queue_id));

/**
 * Applies ops to the stored rows they touch, in the order the SQL runs them: repoint, upsert, remove.
 * existing: evidence rows as read. Returns {final: Map(evKey -> row | null), changes: [{key, before, after, how}]}.
 */
export function applyEvidenceOps(existing, ops, { now = Date.now() } = {}) {
  const start = new Map((existing || []).map(r => [evKey(r), { ...r }]));
  const cur = new Map(start);
  const how = new Map();
  for (const p of ops.repoint) {
    for (const [k, b] of cur) {
      if (!b || !start.has(k) || !repointHits(p, start.get(k))) continue;
      if (b.topic_id === p.to_topic) continue;
      cur.set(k, { ...b, topic_id: p.to_topic, updated_at: now });
      how.set(k, 'repoint');
    }
  }
  for (const r of ops.upsert) {
    const k = evKey(r);
    const b = cur.get(k);
    if (!b) { cur.set(k, newRow(r, now)); how.set(k, 'upsert'); continue; }
    const { provided, fill } = upsertCols(r);
    const a = { ...b };
    for (const c of provided) a[c] = fill.includes(c) ? (b[c] ?? sqlValue(r[c])) : sqlValue(r[c]);
    a.updated_at = now;
    cur.set(k, a);
    how.set(k, 'upsert');
  }
  for (const d of ops.remove) {
    for (const [k, b] of cur) {
      if (!b || b.obs_key !== d.obs_key || (d.slot != null && Number(b.slot) !== d.slot)) continue;
      cur.set(k, null);
      how.set(k, 'remove');
    }
  }
  const changes = [];
  for (const [k, h] of how) {
    const before = start.get(k) || null, after = cur.get(k) || null;
    if (!before && !after) continue;
    changes.push({ key: k, before, after, how: h });
  }
  return { final: cur, changes };
}

// Topics whose stored score a set of changes moves: both sides of each change, live rows only.
export function touchedTopics(changes, extra = []) {
  const out = new Set();
  for (const t of extra || []) if (t != null && t !== '') out.add(String(t));
  for (const c of changes) {
    if (live(c.before) && c.before.topic_id != null) out.add(c.before.topic_id);
    if (live(c.after) && c.after.topic_id != null) out.add(c.after.topic_id);
  }
  return out;
}

// What weakness's recomputeTopics needs: every changed observation key as removed, then every live row now under
// those keys as pending (so a moved or replaced row lands under its new topic whichever way the scorer merges).
export function scorerInput(final, changes) {
  const keys = new Set(changes.map(c => (c.after || c.before).obs_key));
  const pending = [];
  for (const r of final.values()) if (live(r) && keys.has(r.obs_key)) pending.push(r);
  return { pending, removed: [...keys] };
}

// ------------------------------------------------------------------ reads

// The stored rows the ops touch and the ev_rev of every topic they or `topics` name: one read batch.
async function readTouched(env, user, ops, topics) {
  const keys = new Set([...ops.upsert.map(r => r.obs_key), ...ops.remove.map(r => r.obs_key)]);
  for (const p of ops.repoint) for (const k of p.obs_keys) keys.add(k);
  const fromTopics = ops.repoint.map(p => p.from_topic).filter(t => t != null);
  const queues = ops.repoint.map(p => p.queue_id).filter(q => q != null);
  const anyEvidence = !!(keys.size || fromTopics.length || queues.length);
  const evArgs = [user, JSON.stringify([...keys]), JSON.stringify(fromTopics), JSON.stringify(queues)];
  const evRead = () => env.DB.prepare(`SELECT * FROM evidence WHERE user_id = ?1 AND (obs_key IN (SELECT value FROM json_each(?2))
      OR topic_id IN (SELECT value FROM json_each(?3)) OR (topic_id IS NULL AND queue_id IN (SELECT value FROM json_each(?4))))`).bind(...evArgs);
  const toTopics = ops.repoint.map(p => p.to_topic).filter(t => t != null);
  const named = [...topics, ...toTopics, ...ops.upsert.map(r => r.topic_id).filter(t => t != null)];
  const revRead = env.DB.prepare(`SELECT topic_id, ev_rev FROM topic_scores WHERE user_id = ?1 AND (topic_id IN (SELECT value FROM json_each(?5))
      OR topic_id IN (SELECT value FROM json_each(?3)) OR topic_id IN (SELECT e.topic_id FROM evidence e WHERE e.user_id = ?1
        AND (e.obs_key IN (SELECT value FROM json_each(?2)) OR (e.topic_id IS NULL AND e.queue_id IN (SELECT value FROM json_each(?4))))))`)
    .bind(...evArgs, JSON.stringify(named));
  try {
    const res = await env.DB.batch(anyEvidence ? [evRead(), revRead] : [revRead]);
    return { rows: anyEvidence ? res[0].results || [] : [], revs: revMap(res[res.length - 1].results) };
  } catch (e) {
    if (!noTable(e, 'topic_scores')) throw e;
    // Before weakness's table exists: the rows still come, and the topics go to topic_dirty.
    return { rows: anyEvidence ? (await evRead().all()).results || [] : [], revs: null };
  }
}
const revMap = rows => new Map((rows || []).map(r => [r.topic_id, Number(r.ev_rev) || 0]));

// ------------------------------------------------------------------ statements

// Upserts in their given order; runs of rows with the same columns share a JSON parameter.
function upsertStatements(DB, rows, now) {
  const groups = [];
  for (const r of rows) {
    const full = newRow(r, now);
    const { provided, fill } = upsertCols(r);
    const cols = Object.keys(full).sort();
    const gk = `${cols.join(',')}|${provided.join(',')}|${fill.join(',')}`;
    const last = groups[groups.length - 1];
    if (last && last.gk === gk) last.rows.push(full);
    else groups.push({ gk, cols, provided, fill, rows: [full] });
  }
  const out = [];
  for (const g of groups) {
    const set = g.provided.map(c => (g.fill.includes(c) ? `${ident(c)} = coalesce(evidence.${c}, excluded.${c})` : `${ident(c)} = excluded.${c}`));
    set.push('updated_at = excluded.updated_at');
    const sel = g.cols.map(c => `json_extract(value, '$."${ident(c)}"')`).join(', ');
    for (const part of chunks(g.rows)) {
      out.push(DB.prepare(`INSERT INTO evidence (${g.cols.join(', ')}) SELECT ${sel} FROM json_each(?) WHERE true
        ON CONFLICT (user_id, obs_key, slot) DO UPDATE SET ${set.join(', ')}`).bind(JSON.stringify(part)));
    }
  }
  return out;
}

function evidenceStatements(DB, user, ops, now) {
  // A repointed row takes its new topic's category (category priors group by it; B3-5), else keeps its own.
  const out = ops.repoint.map(p => DB.prepare(`UPDATE evidence SET topic_id = ?2, updated_at = ?3,
      category_id = coalesce((SELECT t.category_id FROM topics t WHERE t.user_id = ?1 AND t.id = ?2), category_id) WHERE user_id = ?1 AND topic_id IS NOT ?2
      AND (?7 IS NULL OR slot = ?7) AND (obs_key IN (SELECT value FROM json_each(?4)) OR topic_id = ?5 OR (topic_id IS NULL AND queue_id = ?6))`)
    .bind(user, p.to_topic, now, JSON.stringify(p.obs_keys), p.from_topic, p.queue_id, p.slot ?? null));
  out.push(...upsertStatements(DB, ops.upsert, now));
  for (const part of chunks(ops.remove)) {
    out.push(DB.prepare(`DELETE FROM evidence WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM json_each(?2) j
        WHERE json_extract(j.value, '$.k') = evidence.obs_key AND (json_extract(j.value, '$.s') IS NULL OR json_extract(j.value, '$.s') = evidence.slot))`)
      .bind(user, JSON.stringify(part.map(d => ({ k: d.obs_key, s: d.slot })))));
  }
  return out;
}

// Topics into topic_dirty (one statement), keeping the newest reason.
export function dirtyStatement(DB, user, topics, reason, now = Date.now()) {
  return DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at) SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true
      ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(user, reason, now, JSON.stringify([...topics]));
}

// One evidence.added / evidence.removed event per added, replaced or removed row (undoable changes only), so
// undo can put each back. Repoints are reversed by their own op's undo (unplace, undoMerge), never here.
function evidenceEvents(changes) {
  const out = [];
  for (const c of changes) {
    if (c.how === 'repoint') continue;
    const row = c.after || c.before;
    if (!live(c.after) && !live(c.before)) continue;
    const kind = c.after ? 'evidence.added' : 'evidence.removed';
    const words = String(row.kind || 'evidence').replace(/_/g, ' ');
    out.push({ kind, target_type: 'evidence', target_id: c.key, topic_id: (c.after || c.before).topic_id ?? null, undoable: true,
      summary: summaryOf(`${c.after ? 'Added' : 'Removed'} ${words}${row.topic_id ? ` on ${row.topic_id}` : ''}`),
      before: c.before, after: c.after });
  }
  return out;
}

/**
 * Plans the evidence part of one writeBatch: reads what the ops touch (one read batch, also used for ev_rev),
 * applies them in memory and returns {statements, events, topics, revs, pending, removed}.
 */
export async function planEvidence(env, user, evidence, { now = Date.now(), undoable = false, recompute = [] } = {}) {
  const ops = normaliseOps(evidence, user);
  const extra = (recompute || []).filter(t => t != null && t !== '').map(String);
  const any = ops.upsert.length || ops.remove.length || ops.repoint.length;
  if (!any && !extra.length) return { statements: [], events: [], topics: new Set(), revs: new Map(), pending: [], removed: [] };
  const read = await readTouched(env, user, ops, extra);
  const { final, changes } = applyEvidenceOps(read.rows, ops, { now });
  const topics = touchedTopics(changes, extra);
  const { pending, removed } = scorerInput(final, changes);
  return {
    statements: any ? evidenceStatements(env.DB, user, ops, now) : [],
    events: undoable ? evidenceEvents(changes) : [],
    topics, revs: read.revs, pending, removed, changes,
  };
}

/**
 * The score part of one writeBatch: weakness's statements guarded by compare-and-set on ev_rev, or topic_dirty.
 * plan: planEvidence's answer. Returns {statements, events, scores, dirty}.
 */
export async function scoreStatements(env, user, plan, { now = Date.now(), actor = 'code', batch_id = null } = {}) {
  const topics = [...plan.topics];
  const none = { statements: [], events: [], scores: {}, dirty: [] };
  if (!topics.length) return none;
  const toDirty = reason => ({ ...none, statements: [dirtyStatement(env.DB, user, topics, reason, now)], dirty: topics });
  if (topics.length > SAME_BATCH_MAX) return toDirty('bulk');
  if (!plan.revs) return toDirty('no_scores');
  const w = await loadWeakness();
  if (!w || typeof w.recomputeTopics !== 'function') return toDirty('no_scorer');
  let r;
  try {
    r = await w.recomputeTopics(env, user, topics, { pending: plan.pending || [], removed: plan.removed || [], now, actor, batch_id });
  } catch (e) {
    console.error('recomputeTopics failed; the topics wait in topic_dirty', e && e.message);
    return toDirty('scorer_error');
  }
  if (!r || !Array.isArray(r.statements)) return toDirty('scorer_error');
  return {
    statements: [casStatement(env.DB, user, topics, plan.revs, now), ...r.statements, bumpStatement(env.DB, user, topics)],
    events: Array.isArray(r.events) ? r.events : [],
    scores: r.scores || scoresFrom(r.events),
    dirty: [],
  };
}

// Compare-and-set, part 1 (runs before the score writes): a topic whose ev_rev moved since it was read lost a race
// with another change, so it goes to topic_dirty and is recomputed from the stored rows.
function casStatement(DB, user, topics, revs, now) {
  const expected = topics.map(t => [t, revs.has(t) ? revs.get(t) : -1]);
  return DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at)
      SELECT ?1, json_extract(j.value, '$[0]'), 'race', ?2 FROM json_each(?3) j
      WHERE coalesce((SELECT s.ev_rev FROM topic_scores s WHERE s.user_id = ?1 AND s.topic_id = json_extract(j.value, '$[0]')), -1) != json_extract(j.value, '$[1]')
      ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(user, now, JSON.stringify(expected));
}
// Part 2 (runs after them): every recomputed topic's ev_rev moves on, so a racing change sees it.
function bumpStatement(DB, user, topics) {
  return DB.prepare('UPDATE topic_scores SET ev_rev = ev_rev + 1 WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))')
    .bind(user, JSON.stringify(topics));
}

function scoresFrom(events) {
  const out = {};
  for (const e of events || []) if (e && e.kind === 'score.changed' && e.topic_id) out[e.topic_id] = e.after || {};
  return out;
}

// ------------------------------------------------------------------ the dirty queue

/**
 * Recomputes up to `limit` dirty topics (oldest first) in one write batch. Topics re-dirtied after the read stay
 * queued. When the queue empties after a rebuild of the scores, one map.resync tells open pages to refetch.
 * Returns {n, left, seq}.
 */
export async function drainDirty(env, user, { limit = DRAIN_DEFAULT, now = Date.now(), actor = 'code', surface = 'cron' } = {}) {
  const n = Math.max(1, Math.min(200, limit | 0 || DRAIN_DEFAULT));
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare('SELECT topic_id, at FROM topic_dirty WHERE user_id = ? ORDER BY at, topic_id LIMIT ?').bind(user, n),
      env.DB.prepare('SELECT count(*) AS n FROM topic_dirty WHERE user_id = ?').bind(user),
      env.DB.prepare("SELECT cursor FROM sync_state WHERE user_id = ? AND source = 'rebuild:scores'").bind(user),
      env.DB.prepare(`SELECT topic_id, ev_rev FROM topic_scores WHERE user_id = ?1 AND topic_id IN
          (SELECT topic_id FROM topic_dirty WHERE user_id = ?1 ORDER BY at, topic_id LIMIT ?2)`).bind(user, n),
    ]);
  } catch (e) {
    if (noTable(e)) return { n: 0, left: 0, seq: null, error: 'not_ready' };
    throw e;
  }
  const picked = res[0].results || [];
  const total = (res[1].results[0] || {}).n || 0;
  const rebuilding = !!(res[2].results || []).length;
  const batch_id = `d_${rand()}`;
  const ctx = { user, at: now, actor, surface, via: 'drain', batch_id, undoable: false };
  const resync = () => [
    env.DB.prepare("DELETE FROM sync_state WHERE user_id = ? AND source = 'rebuild:scores'").bind(user),
    ...eventStatements(env.DB, [eventRow({ kind: 'map.resync', target_type: 'map', summary: 'Scores rebuilt; the map refreshes', after: { reason: 'rebuild:scores' } }, null, ctx)]),
  ];
  if (!picked.length) {
    if (!rebuilding) return { n: 0, left: 0, seq: null };
    const seq = seqOf(await env.DB.batch(resync()));
    if (seq != null) await notifyLive(env, user, seq);
    return { n: 0, left: 0, seq };
  }
  const topics = picked.map(r => r.topic_id);
  const readAt = Math.max(...picked.map(r => r.at));
  const w = await loadWeakness();
  if (!w || typeof w.recomputeTopics !== 'function') return { n: 0, left: total, seq: null, error: 'no_scorer' };
  let r;
  try { r = await w.recomputeTopics(env, user, topics, { pending: [], removed: [], now, actor }); } catch (e) {
    console.error('drainDirty: recomputeTopics failed', e && e.message);
    return { n: 0, left: total, seq: null, error: 'scorer_error' };
  }
  const left = total - topics.length;
  const events = (r.events || []).map(e => eventRow({ undoable: false, ...e }, null, ctx));
  const stmts = [
    env.DB.prepare('DELETE FROM topic_dirty WHERE user_id = ?1 AND at <= ?2 AND topic_id IN (SELECT value FROM json_each(?3))')
      .bind(user, readAt, JSON.stringify(topics)),
    casStatement(env.DB, user, topics, revMap(res[3].results), now),
    ...r.statements,
    bumpStatement(env.DB, user, topics),
  ];
  stmts.push(...eventStatements(env.DB, events));
  if (rebuilding && left <= 0) stmts.push(...resync());
  const seq = seqOf(await env.DB.batch(stmts));
  if (seq != null) await notifyLive(env, user, seq);
  return { n: topics.length, left: Math.max(0, left), seq };
}

// The newest seq a batch's RETURNING clauses gave back, or null.
function seqOf(results) {
  let seq = null;
  for (const x of results || []) for (const row of (x && x.results) || []) if (row && Number.isInteger(row.seq)) seq = Math.max(seq || 0, row.seq);
  return seq;
}

// The hourly hook (the minute dispatcher calls it at the slots in plan §6.3): weakness's refreshScores, failing soft.
export async function hourlyRefresh(env, user, opts = {}) {
  const w = await loadWeakness();
  if (!w || typeof w.refreshScores !== 'function') return { ok: false, error: 'no_scorer' };
  try { return { ok: true, ...(await w.refreshScores(env, user, opts)) }; } catch (e) {
    console.error('refreshScores failed', e && e.message);
    return { ok: false, error: String(e && e.message).slice(0, 200) };
  }
}
