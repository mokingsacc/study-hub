// Undo by batch (plan §6.8). One change is one batch, so "undo that" reverses every undoable event in it, newest
// first, in one new batch written through writeBatch: the restored rows, the restored evidence, 'undo' events
// carrying undo_of, undone_by on the originals, and the recomputed scores. Undoing an undo redoes the change.
//
//   undoBatch(env, user, batchId, {actor, surface, via?, mo_said?}) -> {batch_id, seq} | {conflict: true, reason}
//
// Each event is reversed by UNDO[kind] or UNDO['target:<target_type>'] from the area registries (undoMerge,
// undoLesson, unplace, undoImport, links' handler), else by restoreRow: the target must still equal the event's
// after_json ("changed again since" otherwise), and is put back to before_json. A handler is called as
// handler(env, user, event, ctx) and answers {rows?, evidence?, statements?, recompute?} or {conflict: reason}.
import { undoHandlers } from './registry/index.js';
import { writeBatch, PK, UNKEYED, SOFT, softFields, keyWhere, summaryOf, rand } from './events.js';

export const CHANGED_AGAIN = 'That was changed again since; undo the later change first.';
export const ALREADY = 'That change was already undone.';
export const FROM_LOG = 'That change came from a log, so it is fixed at its source, not undone here.';
export const NOT_FOUND = 'No change has that id.';
export const CANNOT = "That change can't be undone automatically.";

// target_type -> table, for the targets events use. A table's own name works too.
export const TABLES = {
  setting: 'settings', user: 'users', topic: 'topics', alias: 'topic_aliases', category: 'categories', category_alias: 'category_aliases',
  unit: 'units', unit_topic: 'unit_topics', link: 'links', note: 'topic_notes', miss: 'misses', gap: 'gaps', queue: 'topic_queue',
  checklist: 'checklist_progress', card_topic: 'card_topics', resource: 'resources', resource_link: 'resource_links',
  position: 'topic_positions', lesson: 'lessons', teach_memory: 'teach_memory', evidence: 'evidence',
  misconception: 'misconceptions', tactic_score: 'tactic_scores', onenote_page: 'onenote_pages',
};
export const tableOf = type => TABLES[type] || (PK[type] ? type : null);

// Columns a conflict check ignores: bookkeeping that code moves on its own.
const IGNORE = new Set(['updated_at', 'created_at', 'user_id', 'id']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } };

// Loose equality for stored values: numbers and numeric text, JSON text and parsed JSON, null and undefined.
export function same(a, b) {
  const norm = v => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^[[{]/.test(t)) { try { return JSON.stringify(JSON.parse(t)); } catch (e) { return v; } }
      if (t !== '' && Number.isFinite(Number(t)) && String(Number(t)) === t) return Number(t);
      return v;
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  };
  return norm(a) === norm(b);
}

// The row's key, from the event's copy of it (after_json or before_json carry the key columns).
function keyOf(table, row) {
  const key = {};
  for (const c of PK[table] || []) {
    if (c === 'user_id') continue;
    if (!row || row[c] === undefined) return null;
    key[c] = row[c];
  }
  return Object.keys(key).length ? key : null;
}
const rowId = (table, key) => `${table}|${JSON.stringify(key)}`;

// Does the stored row (or its absence) still match what the event left?
export function matches(current, after) {
  if (after == null) return current == null;
  if (current == null) return false;
  for (const [c, v] of Object.entries(after)) {
    if (IGNORE.has(c)) continue;
    if (!same(current[c], v)) return false;
  }
  return true;
}

/**
 * The default reversal of one event on one plain row: a diff for writeBatch and the 'undo' event to go with it.
 * current: the row as it is now (null if absent). Pure. Returns {row?, evidence?, event?} or {conflict}.
 */
export function restoreRow(table, key, before, after, current, now = Date.now()) {
  if (!matches(current, after)) return { conflict: CHANGED_AGAIN };
  if (table === 'evidence') {
    const ev = before ? { upsert: [Object.fromEntries(Object.entries(before).filter(([c]) => c !== 'id'))] } : { remove: [{ obs_key: key.obs_key, slot: Number(key.slot) || 0 }] };
    return { evidence: ev, next: before };
  }
  const strip = o => Object.fromEntries(Object.entries(o).filter(([c]) => !(PK[table] || []).includes(c) && c !== 'user_id'));
  if (before == null) {
    if (SOFT[table]) {
      const set = softFields(table, now);
      const was = Object.fromEntries(Object.keys(set).map(c => [c, current[c] ?? null]));
      return { row: { table, op: 'update', key, before: was, after: set }, next: { ...current, ...set } };
    }
    return { row: { table, op: 'delete', key, before: strip(current), after: null }, next: null };
  }
  if (after == null) return { row: { table, op: 'insert', key, before: null, after: strip(before) }, next: { ...before } };
  const set = {};
  for (const c of Object.keys(strip(after))) {
    if (IGNORE.has(c)) continue;
    set[c] = before[c] === undefined ? null : before[c];
  }
  if ('updated_at' in after && current && 'updated_at' in current) set.updated_at = now;
  const was = Object.fromEntries(Object.keys(set).map(c => [c, current[c] ?? null]));
  return { row: { table, op: 'update', key, before: was, after: set }, next: { ...current, ...set } };
}

// The rows the batch's plain events target, as they are now: one read batch.
async function readTargets(env, user, targets) {
  const list = [...targets.values()];
  if (!list.length) return new Map();
  const res = await env.DB.batch(list.map(t => {
    const w = keyWhere(t.table, t.key, user, 1);
    return env.DB.prepare(`SELECT * FROM ${t.table} WHERE ${w.sql}`).bind(w.param);
  }));
  const out = new Map();
  list.forEach((t, i) => out.set(t.id, (res[i].results || [])[0] || null));
  return out;
}

export async function undoBatch(env, user, batchId, { actor = 'mo', surface = null, via = null, mo_said = null } = {}) {
  if (typeof batchId !== 'string' || !batchId) return { conflict: true, reason: NOT_FOUND };
  const all = (await env.DB.prepare('SELECT * FROM map_events WHERE user_id = ? AND batch_id = ? ORDER BY seq DESC').bind(user, batchId).all()).results || [];
  if (!all.length) return { conflict: true, reason: NOT_FOUND };
  if (all.some(e => e.undone_by)) return { conflict: true, reason: ALREADY };
  const events = all.filter(e => e.undoable);
  if (!events.length) return { conflict: true, reason: FROM_LOG };

  const handlers = undoHandlers();
  const now = Date.now();
  const undoId = `u_${rand()}`;
  // Plain targets first, so their current rows come in one read.
  const plan = events.map(e => {
    const fn = handlers[e.kind] || handlers[`target:${e.target_type}`];
    if (typeof fn === 'function') return { e, fn };
    const table = tableOf(e.target_type);
    const before = parse(e.before_json), after = parse(e.after_json);
    const key = table && keyOf(table, after || before);
    if (!table || !key) return { e, cannot: true };
    return { e, table, key, before, after, id: rowId(table, key) };
  });
  if (plan.some(p => p.cannot)) return { conflict: true, reason: CANNOT };
  const targets = new Map();
  for (const p of plan) if (p.id && !targets.has(p.id)) targets.set(p.id, { id: p.id, table: p.table, key: p.key });
  const current = await readTargets(env, user, targets);

  const rows = [], outEvents = [], statements = [], recompute = new Set();
  const evidence = { upsert: [], remove: [] };
  const ctx = { actor, surface, via, now, batch_id: batchId, undo_batch_id: undoId };
  for (const p of plan) {
    const summary = summaryOf(`Undid: ${p.e.summary}`);
    if (p.e.topic_id) recompute.add(p.e.topic_id);
    if (p.fn) {
      const r = await p.fn(env, user, p.e, ctx);
      if (!r || r.conflict) return { conflict: true, reason: (r && typeof r.conflict === 'string' && r.conflict) || (r && r.reason) || CHANGED_AGAIN };
      for (const row of r.rows || []) {
        rows.push(row);
        const type = tableOf(p.e.target_type) === row.table ? p.e.target_type : row.table;
        outEvents.push({ kind: 'undo', target_type: type, target_id: p.e.target_id, topic_id: p.e.topic_id, summary, undoable: true });
      }
      if (r.evidence) { evidence.upsert.push(...(r.evidence.upsert || [])); evidence.remove.push(...(r.evidence.remove || [])); }
      statements.push(...(r.statements || []));
      for (const t of r.recompute || []) recompute.add(t);
      continue;
    }
    const r = restoreRow(p.table, p.key, p.before, p.after, current.get(p.id), now);
    if (r.conflict) return { conflict: true, reason: r.conflict };
    current.set(p.id, r.next);   // an earlier event on the same row checks against this
    if (r.evidence) { evidence.upsert.push(...(r.evidence.upsert || [])); evidence.remove.push(...(r.evidence.remove || [])); continue; }
    rows.push(r.row);
    outEvents.push({ kind: 'undo', target_type: p.e.target_type, target_id: p.e.target_id, topic_id: p.e.topic_id, summary, undoable: true });
  }

  statements.push(env.DB.prepare('UPDATE map_events SET undone_by = ?1 WHERE user_id = ?2 AND batch_id = ?3').bind(undoId, user, batchId));
  // Redoing (undoing an undo): the change it undid counts as live again, so "undo that" can reach it once more.
  const undid = all.find(e => e.undo_of);
  if (undid) {
    statements.push(env.DB.prepare('UPDATE map_events SET undone_by = NULL WHERE user_id = ?1 AND batch_id = ?2 AND undone_by = ?3')
      .bind(user, undid.undo_of, batchId));
  }
  const w = await writeBatch(env, user, {
    actor, surface, via, mo_said, batch_id: undoId, undo_of: batchId, undoable: true,
    statements, rows, events: outEvents, recompute: [...recompute],
    evidence: evidence.upsert.length || evidence.remove.length ? evidence : undefined,
  });
  return { batch_id: w.batch_id, seq: w.seq, undid: batchId, scores: w.scores };
}

export { UNKEYED };
