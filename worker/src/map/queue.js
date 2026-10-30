// Items code cannot place (plan §6.6). topic_queue is the one store for them: ingestion adds an item (or bumps
// its refs) for every row resolveTopic could not place at 0.85, and the row keeps the item's id in queue_id.
// Claude settles items in the conversation (map_queue, map_resolve -> taxonomy's queue.resolve), which calls
// placeRows here for the rows; taxonomy's requeueOpen re-tries open items after any alias or topic write, so
// one new alias places every row with that label. Nothing is ever dropped.
import { now as nowMs } from '../util.js';
import { userKey, rawKey, normLabel } from './ingest/map-fields.js';

export const QUEUE_KINDS = ['label', 'gap', 'card', 'lookalike', 'unit', 'versus', 'review_row'];
const FIELD_MAX = 400, CONTEXT_MAX = 2000;

export function capContext(ctx) {
  const out = {};
  let total = 2;
  for (const [k, v] of Object.entries(ctx || {})) {
    if (v == null || v === '') continue;
    const val = typeof v === 'string' ? v.slice(0, FIELD_MAX) : v;
    const size = JSON.stringify(val).length + k.length + 4;
    if (size > FIELD_MAX + 20 || total + size > CONTEXT_MAX) continue;
    out[k] = val;
    total += size;
  }
  return out;
}

const QCOLS = ['id', 'user_id', 'kind', 'label_norm', 'label_raw', 'context_json', 'candidates_json', 'refs', 'first_seen_at', 'last_seen_at', 'status'];
/**
 * Upserts for queue items [{id (raw key), kind, label_norm, label_raw, context?, candidates?}], as statements
 * for the caller's batch. The same id twice adds its refs; an item seen again is bumped, and a resolved one
 * that is needed again reopens (a rejected one stays rejected).
 */
export function queueStatements(env, user, items, t = nowMs()) {
  const byId = new Map();
  for (const q of items || []) {
    if (!q || !q.id || !QUEUE_KINDS.includes(q.kind)) continue;
    const id = userKey(user, q.id);
    const prev = byId.get(id);
    if (prev) { prev.refs += 1; continue; }
    byId.set(id, {
      id, user_id: user, kind: q.kind, label_norm: String(q.label_norm || normLabel(q.label_raw)).slice(0, 200) || q.id,
      label_raw: String(q.label_raw || q.label_norm || q.id).slice(0, 200), context_json: JSON.stringify(capContext(q.context)),
      candidates_json: JSON.stringify((q.candidates || []).slice(0, 5).map(c => ({ id: c.id, name: c.name, score: c.score }))),
      refs: 1, first_seen_at: t, last_seen_at: t, status: 'open',
    });
  }
  if (!byId.size) return [];
  return [env.DB.prepare(`INSERT INTO topic_queue (${QCOLS.join(', ')})
    SELECT ${QCOLS.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?) WHERE 1
    ON CONFLICT(id) DO UPDATE SET refs = topic_queue.refs + excluded.refs, last_seen_at = excluded.last_seen_at,
      candidates_json = CASE WHEN excluded.candidates_json != '[]' THEN excluded.candidates_json ELSE topic_queue.candidates_json END,
      status = CASE WHEN topic_queue.status = 'resolved' THEN 'open' ELSE topic_queue.status END
    WHERE topic_queue.user_id = excluded.user_id`).bind(JSON.stringify([...byId.values()]))];
}

/** Write queue items on their own (one batch). */
export async function upsertQueue(env, user, items) {
  const st = queueStatements(env, user, items);
  if (st.length) await env.DB.batch(st);
  return st.length ? items.length : 0;
}

const json = v => JSON.stringify([...new Set(v)]);

export async function placeRows(env, user, placements, { actor = 'claude', now = nowMs(), topics: known = null } = {}) {
  const list = (placements || []).filter(p => p && p.queue_id && p.topic_id);
  const out = { rows: [], events: [], evidence: { repoint: [] }, touched_topics: [], refs: { misses: [], gaps: [] }, count: 0 };
  if (!list.length) return out;
  const qids = list.map(p => String(p.queue_id));
  const gapIds = qids.map(q => rawKey(user, q)).filter(k => k.startsWith('gap:')).map(k => k.slice(4));
  const [m, e, g, t] = await env.DB.batch([
    // Unplaced rows waiting on these items, and rows code placed from other words whose new words wait on one (B4-3).
    env.DB.prepare(`SELECT id, queue_id, topic_id, category_id, match_status, match_method, label, label_norm, condition_raw, topic_raw FROM misses WHERE user_id = ?
      AND queue_id IN (SELECT value FROM json_each(?)) AND (topic_id IS NULL OR match_method IN ('alias','label')) AND held = 0 AND deleted_at IS NULL LIMIT 500`).bind(user, json(qids)),
    env.DB.prepare(`SELECT DISTINCT gap_id, queue_id FROM evidence WHERE user_id = ? AND queue_id IN (SELECT value FROM json_each(?))
      AND gap_id IS NOT NULL AND topic_id IS NULL AND held = 0 LIMIT 500`).bind(user, json(qids)),
    env.DB.prepare(`SELECT id, topic_id, map_state, mapped_at FROM gaps WHERE user_id = ? AND held = 0 AND topic_id IS NULL
      AND (id IN (SELECT value FROM json_each(?)) OR id IN (SELECT gap_id FROM evidence WHERE user_id = ? AND queue_id IN (SELECT value FROM json_each(?))
        AND gap_id IS NOT NULL))`).bind(user, json(gapIds), user, json(qids)),
    env.DB.prepare('SELECT id, name, category_id FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(user, json(list.map(p => p.topic_id))),
  ]);
  const topics = new Map((t.results || []).map(r => [r.id, r]));
  // Topics the same change makes (queue.resolve's new_topic) are not in D1 yet: their category and name come from the plan (B3-5).
  for (const [id, r] of known instanceof Map ? known : []) if (!topics.has(id) && r) topics.set(id, r);
  const to = new Map(list.map(p => [String(p.queue_id), p.topic_id]));
  const name = id => (topics.get(id) || {}).name || id;
  const method = actor === 'mo' ? 'mo' : actor === 'claude' ? 'claude' : 'alias';
  const moved = [];
  for (const r of m.results || []) {
    const topicId = to.get(r.queue_id);
    if (r.topic_id != null) {
      if (r.topic_id === topicId) continue;
      const after = { topic_id: topicId, category_id: (topics.get(topicId) || {}).category_id || r.category_id, match_status: 'matched', match_method: method,
        label_norm: normLabel(r.condition_raw || r.topic_raw) || r.label_norm };
      out.rows.push({ table: 'misses', op: 'update', key: { id: r.id }, before: { topic_id: r.topic_id, category_id: r.category_id, match_status: r.match_status,
        match_method: r.match_method, label_norm: r.label_norm }, after });
      out.events.push({ kind: 'queue.resolved', target_type: 'miss', target_id: r.id, topic_id: topicId, summary: `${r.label} moved to ${name(topicId)}`.slice(0, 160) });
      out.evidence.repoint.push({ obs_keys: [rawKey(user, r.id)], slot: 0, to_topic: topicId });
      moved.push({ id: r.id, topic_id: topicId });
      out.refs.misses.push(r.id);
      continue;
    }
    const after = { topic_id: topicId, category_id: (topics.get(topicId) || {}).category_id || r.category_id, match_status: 'matched', match_method: method };
    out.rows.push({ table: 'misses', op: 'update', key: { id: r.id }, before: { topic_id: null, category_id: r.category_id, match_status: r.match_status, match_method: r.match_method }, after });
    out.events.push({ kind: 'queue.resolved', target_type: 'miss', target_id: r.id, topic_id: topicId, summary: `${r.label} placed on ${name(topicId)}`.slice(0, 160) });
    out.refs.misses.push(r.id);
  }
  // A gap waits on its own item (gap:<id>) or, through its evidence, on a label item.
  const gapQueue = new Map();
  for (const r of e.results || []) gapQueue.set(r.gap_id, r.queue_id);
  for (const id of gapIds) gapQueue.set(id, userKey(user, `gap:${id}`));
  for (const r of g.results || []) {
    const topicId = to.get(gapQueue.get(r.id));
    if (!topicId) continue;
    out.rows.push({ table: 'gaps', op: 'update', key: { id: r.id }, before: { topic_id: null, map_state: r.map_state, mapped_at: r.mapped_at },
      after: { topic_id: topicId, map_state: 'placed', mapped_at: now } });
    out.events.push({ kind: 'queue.resolved', target_type: 'gap', target_id: r.id, topic_id: topicId, summary: `A gap you named placed on ${name(topicId)}`.slice(0, 160) });
    out.refs.gaps.push(r.id);
  }
  out.evidence.repoint.push(...list.map(p => ({ queue_id: String(p.queue_id), to_topic: p.topic_id })));
  out.touched_topics = [...new Set(list.map(p => p.topic_id))];
  // A moved row leaves its old topic's look-alike threads (B3-8); its new ones follow in requeueAfter's look-alike pass.
  if (moved.length) {
    const { staleSupportParts } = await import('./ingest/hub.js');
    const stale = await staleSupportParts(env, user, moved);
    out.rows.push(...stale.rows);
    out.events.push(...stale.events);
  }
  out.count = out.rows.length;
  return out;
}

const parse = v => { if (v == null || typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };

/**
 * UNDO['queue.resolved'] (realtime's undoBatch calls it as fn(env, user, event, ctx)): the miss or gap waits on
 * its queue item again and its evidence points back at no topic. A row moved again since is a conflict.
 * Returns {rows, evidence: {upsert}, recompute} or {conflict}.
 */
export async function unplace(env, user, ev) {
  const table = ev.target_type === 'gap' ? 'gaps' : ev.target_type === 'miss' ? 'misses' : null;
  const before = parse(ev.before_json) || {};
  if (!table || !ev.target_id) return { conflict: 'That placement cannot be undone automatically.' };
  // A miss takes back every row of its queue item (the item's right answers too); a gap takes back its own.
  const [cur, evs] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND id = ?`).bind(user, ev.target_id),
    table === 'misses'
      ? env.DB.prepare(`SELECT * FROM evidence WHERE user_id = ? AND topic_id = ? AND (miss_id = ? OR (gap_id IS NULL AND queue_id IS NOT NULL
          AND queue_id = (SELECT queue_id FROM misses WHERE user_id = ? AND id = ?)))`).bind(user, ev.topic_id, ev.target_id, user, ev.target_id)
      : env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND gap_id = ? AND topic_id = ?').bind(user, ev.target_id, ev.topic_id),
  ]);
  const row = (cur.results || [])[0];
  if (!row) return { conflict: 'That row is no longer there.' };
  if (row.topic_id !== ev.topic_id) return { conflict: 'That was changed again since; undo the later change first.' };
  // A row code had placed elsewhere (B4-3) goes back to that topic; an unplaced one waits on its item again.
  const backTopic = table === 'misses' ? before.topic_id ?? null : null;
  const back = table === 'misses'
    ? { topic_id: backTopic, category_id: before.category_id ?? row.category_id, match_status: before.match_status || 'queued', match_method: before.match_method ?? null,
      ...('label_norm' in before ? { label_norm: before.label_norm } : {}) }
    : { topic_id: null, map_state: before.map_state || 'queued', mapped_at: before.mapped_at ?? null };
  const was = Object.fromEntries(Object.keys(back).map(k => [k, row[k] ?? null]));
  const upsert = (evs.results || []).filter(r => backTopic == null || Number(r.slot) === 0).map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v;
    return { ...o, topic_id: backTopic, category_id: backTopic ? before.category_id ?? o.category_id : o.category_id };
  });
  return { rows: [{ table, op: 'update', key: { id: ev.target_id }, before: was, after: back }], evidence: { upsert }, recompute: [ev.topic_id, backTopic].filter(Boolean) };
}
