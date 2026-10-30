import { planEvidence, scoreStatements } from './recompute.js';

export const ACTORS = ['mo', 'claude', 'code', 'anki', 'extractor', 'cron'];
export const SURFACES = ['chat', 'voice', 'code', 'web', 'cron', 'anki', 'hook', 'routine', 'anki_desktop', 'ankimobile', 'anki_voice', 'lesson'];
export const SUMMARY_MAX = 160;
export const JSON_ROWS = 150;   // rows per JSON parameter

// Every kind a map_events row may carry (plan §6.9). Adding one is a request to RTC; tests pin the list.
export const EVENT_KINDS = [
  // misses, evidence and scores
  'miss.added', 'miss.updated', 'miss.deleted', 'miss.reviewed', 'miss.placed', 'evidence.added', 'evidence.removed',
  'score.changed', 'scores.refreshed', 'gap.added', 'sitting.released',
  // topics and queue
  'topic.added', 'topic.updated', 'topic.confirmed', 'topic.retired', 'topic.merged', 'topic.dupe_suspected', 'topic.sources_refreshed',
  'alias.added', 'alias.removed', 'unit.updated', 'queue.resolved',
  // links
  'link.added', 'link.updated', 'link.removed',
  // lessons
  'lesson.requested', 'lesson.started', 'lesson.saved', 'teach_memory.saved', 'misconception.saved',
  // hub and housekeeping
  'checklist.ticked', 'card.unlinked', 'setting.changed', 'pref.changed', 'positions.changed', 'onenote.imported', 'import.started',
  'sync.status', 'map.resync', 'undo',
  // v1.5
  'request.added', 'request.updated',
  // v2
  'screen.shown', 'screen.cleared', 'media.found', 'media.verdict', 'media.added', 'media.imported', 'note.added', 'note.updated',
  'extraction.proposed', 'extraction.undone',
  'note.removed', // Notes (I30)
  // UK hub (uk.import): an entry added, changed or removed
  'uk.added', 'uk.updated', 'uk.removed',
  // topic photos (I28)
  'media.removed',
  // mnemonics (I35)
  'mnemonic.added', 'mnemonic.updated', 'mnemonic.removed', 'mnemonic.reviewed',
  // the history search's index (history/sweep.js): built, failing, working again, items updated (Recent activity)
  'search.indexed',
  // the pattern review (patterns.js, 29 Oct 2026): a run's line in Recent activity, a failed or held run, the profile refreshed
  'pattern.reviewed', 'pattern.failed', 'profile.refreshed',
  // the multi-user platform (docs/platform/plan.md)
  'subject.added', 'subject.updated', 'subject.removed', 'results.logged', 'card.reviewed',
  // the platform's own galaxies (0103)
  'galaxy.added', 'galaxy.updated', 'galaxy.removed', 'picture.added', 'picture.removed',
  // the platform's chat notes (0105)
  'chat.saved',
];
const KIND_SET = new Set(EVENT_KINDS);

// Each writable table's primary key (or the unique key upserts and undo use), from plan §5.2 and 0001-0009.
// Tables marked * have no user_id column: every other table is always scoped by user_id.
export const PK = {
  settings: ['key'], users: ['id'], outbox: ['id'],
  topics: ['user_id', 'id'], topic_aliases: ['user_id', 'alias_key', 'topic_id'], categories: ['user_id', 'id'],
  uk_img_findings: ['user_id', 'id'], uk_img_media: ['user_id', 'id'],   // UK labs (I34)
  category_aliases: ['user_id', 'vocab', 'alias_key'], units: ['user_id', 'id'], unit_topics: ['user_id', 'unit_id', 'topic_id'],
  links: ['id'], link_support: ['user_id', 'link_id', 'obs_key'], topic_notes: ['user_id', 'id'], misses: ['id'], gaps: ['id'],
  orbit_links: ['user_id', 'id'],
  topic_queue: ['id'], checklist_progress: ['user_id', 'unit_id', 'step'], card_topics: ['user_id', 'card_id', 'topic_id'],
  resources: ['user_id', 'id'], resource_links: ['id'], topic_positions: ['user_id', 'kind', 'ref_id'], lessons: ['id'],
  teach_memory: ['id'], evidence: ['user_id', 'obs_key', 'slot'], topic_dirty: ['user_id', 'topic_id'], sync_state: ['user_id', 'source'],
  misconceptions: ['user_id', 'id'], tactic_scores: ['user_id', 'content_type', 'tactic'], onenote_pages: ['user_id', 'page_id'],
  // Notes (I30): notebooks, sections, pages, blocks and ink.
  note_books: ['user_id', 'id'], note_sections: ['user_id', 'id'], note_pages: ['user_id', 'id'], note_blocks: ['user_id', 'id'], note_strokes: ['user_id', 'id'],
  uk_entries: ['user_id', 'id'],
  topic_photos: ['user_id', 'id'], topic_pictures: ['user_id', 'topic_id', 'source', 'ref'],
  mnemonics: ['user_id', 'id'], mnemonic_reviews: ['user_id', 'mnemonic_id', 'dir'],   // mnemonics (I35)
  retests: ['user_id', 'id'],   // re-tests (0036): lesson_save closes and books them in its own batch
  // The platform's study tables (0101).
  subjects: ['user_id', 'id'], result_logs: ['user_id', 'id'], papers: ['user_id', 'id'],
  galaxies: ['user_id', 'id'], galaxy_topics: ['user_id', 'topic_id'], study_pictures: ['user_id', 'id'], chat_notes: ['user_id', 'id'],
};
export const UNKEYED = new Set(['settings', 'users', 'outbox']);

// What soft_delete sets when the planner gives no fields of its own; a table not listed is really deleted.
export const SOFT = {
  topics: { status: 'retired' }, topic_aliases: { status: 'removed' }, categories: { status: 'retired' },
  links: { status: 'removed', removed_at: '$now' }, topic_notes: { status: 'deleted' }, card_topics: { removed_at: '$now' },
  resource_links: { status: 'hidden' }, teach_memory: { status: 'retired' },
  uk_entries: { deleted_at: '$now' },
  topic_photos: { deleted_at: '$now' }, topic_pictures: { hidden_at: '$now' },
  mnemonics: { deleted_at: '$now' },
  subjects: { status: 'removed' }, result_logs: { deleted_at: '$now' },
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const rand = () => crypto.randomUUID().replace(/-/g, '');

export function ident(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`Not a column or table name: ${String(name).slice(0, 40)}`);
  return name;
}

// A value as D1 stores it: objects and lists become JSON text, booleans 1 and 0, undefined null.
export function sqlValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
const sqlRow = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sqlValue(v)]));
const pick = c => `json_extract(value, '$."${ident(c)}"')`;

// Split a list into chunks of n.
export function chunks(list, n = JSON_ROWS) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// INSERT for many rows with the same columns, one JSON parameter per chunk. conflict: an ON CONFLICT clause.
export function jsonInsert(DB, table, cols, rows, conflict = '') {
  ident(table);
  const list = cols.map(ident).join(', ');
  const sel = cols.map(pick).join(', ');
  return chunks(rows).map(part => DB.prepare(`INSERT INTO ${table} (${list}) SELECT ${sel} FROM json_each(?) WHERE true ${conflict}`)
    .bind(JSON.stringify(part.map(r => Object.fromEntries(cols.map(c => [c, sqlValue(r[c])]))))));
}

// WHERE for a key object: every key column bound from one JSON parameter (?n), plus user_id where the table has it.
export function keyWhere(table, key, user, n = 2) {
  const k = { ...key };
  if (!UNKEYED.has(table)) k.user_id = user;
  const cols = Object.keys(k).map(ident);
  if (!cols.length) throw new Error(`A ${table} row needs its key`);
  return { sql: cols.map(c => `${c} = json_extract(?${n}, '$."${c}"')`).join(' AND '), param: JSON.stringify(sqlRow(k)) };
}

// What a row diff writes: update's after; soft_delete's own fields or its table's SOFT state; null for a row that
// is really deleted (delete, or soft_delete on a table with no soft state).
function setOf(r, now) {
  const own = isObj(r.after) && Object.keys(r.after).length > 0;
  if (r.op === 'update') return { ...(r.after || {}) };
  if (r.op === 'soft_delete') return own ? { ...r.after } : SOFT[r.table] ? softFields(r.table, now) : null;
  return null;
}

// One row diff (update, soft_delete or delete) as a prepared statement. Inserts are grouped by rowStatements.
export function rowStatement(DB, user, r, now = Date.now()) {
  const table = ident(r.table);
  if (!isObj(r.key)) throw new Error(`A ${table} row needs its key`);
  if (!['update', 'soft_delete', 'delete'].includes(r.op)) throw new Error(`Unknown row op ${r.op} on ${table}`);
  const set = setOf(r, now);
  if (set) {
    for (const c of Object.keys(r.key)) delete set[c];
    const cols = Object.keys(set).map(ident);
    if (!cols.length) return null;
    const where = keyWhere(table, r.key, user, 2);
    return DB.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = json_extract(?1, '$."${c}"')`).join(', ')} WHERE ${where.sql}`)
      .bind(JSON.stringify(sqlRow(set)), where.param);
  }
  const where = keyWhere(table, r.key, user, 1);
  return DB.prepare(`DELETE FROM ${table} WHERE ${where.sql}`).bind(where.param);
}

export function softFields(table, now = Date.now()) {
  return Object.fromEntries(Object.entries(SOFT[table] || {}).map(([k, v]) => [k, v === '$now' ? now : v]));
}

// The full insert row (key, after, and user_id where the table has it).
function insertRow(user, r) {
  const row = { ...(r.after || {}), ...r.key };
  if (!UNKEYED.has(r.table)) row.user_id = user;
  return row;
}

// Statements for every row diff, in order; runs of inserts or upserts into one table with the same columns
// share a JSON parameter.
export function rowStatements(DB, user, rows, now = Date.now()) {
  const items = [];
  for (const r of rows || []) {
    if (!r || typeof r.table !== 'string') throw new Error('A row diff needs its table');
    if (r.op === 'insert' || r.op === 'upsert') {
      const row = insertRow(user, r);
      const cols = Object.keys(row).sort();
      const update = r.op === 'upsert' ? (r.update || cols.filter(c => !(PK[r.table] || []).includes(c) && !['created_at', 'created_by'].includes(c))) : null;
      const gk = `${r.table}|${r.op}|${cols.join(',')}|${update ? update.join(',') : ''}`;
      const last = items[items.length - 1];
      if (last && last.gk === gk) last.rows.push(row);
      else items.push({ gk, table: r.table, op: r.op, cols, update, rows: [row] });
      continue;
    }
    const st = rowStatement(DB, user, r, now);
    if (st) items.push({ st });
  }
  const out = [];
  for (const g of items) {
    if (g.st) { out.push(g.st); continue; }
    let conflict = '';
    if (g.op === 'upsert') {
      const pk = PK[g.table];
      if (!pk) throw new Error(`No key is known for ${g.table}, so it cannot be upserted`);
      conflict = g.update.length
        ? `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${g.update.map(c => `${ident(c)} = excluded.${c}`).join(', ')}`
        : `ON CONFLICT (${pk.join(', ')}) DO NOTHING`;
    }
    out.push(...jsonInsert(DB, g.table, g.cols, g.rows, conflict));
  }
  return out;
}

// ------------------------------------------------------------------ events

// One event checked and filled from its row; throws on a broken event (a bug in the caller, caught by tests).
export function eventRow(e, r, o) {
  if (!isObj(e)) throw new Error('An event must be an object');
  if (!KIND_SET.has(e.kind)) throw new Error(`Unknown event kind ${e.kind}`);
  if (typeof e.target_type !== 'string' || !e.target_type) throw new Error(`Event ${e.kind} needs a target_type`);
  const summary = typeof e.summary === 'string' ? e.summary.trim() : '';
  if (!summary) throw new Error(`Event ${e.kind} needs a summary`);
  if (summary.length > SUMMARY_MAX) throw new Error(`Event ${e.kind}: the summary is over ${SUMMARY_MAX} characters`);
  const before = e.before !== undefined ? e.before : r ? (r.before == null ? null : { ...r.key, ...r.before }) : null;
  let after = e.after !== undefined ? e.after : null;
  if (e.after === undefined && r) {
    const set = r.op === 'insert' || r.op === 'upsert' ? r.after || {} : setOf(r, o.at);
    after = set ? { ...r.key, ...set } : null;
  }
  if ((isObj(after) && Number(after.held) === 1) || (r && isObj(r.after) && Number(r.after.held) === 1)) {
    throw new Error(`Event ${e.kind}: a held row never emits an event (results stay hidden until the sitting ends)`);
  }
  const undoable = e.undoable == null ? !!o.undoable : !!e.undoable;
  return {
    user_id: o.user, at: o.at, actor: o.actor, surface: o.surface, via: o.via ?? null, kind: e.kind, target_type: e.target_type,
    target_id: e.target_id == null ? null : String(e.target_id), topic_id: e.topic_id ?? null, summary,
    before_json: before == null ? null : JSON.stringify(before), after_json: after == null ? null : JSON.stringify(after),
    batch_id: o.batch_id, source: e.source ?? null, source_ref: e.source_ref == null ? null : String(e.source_ref),
    undoable: undoable ? 1 : 0, undo_of: e.undo_of ?? o.undo_of ?? null, mo_said: o.mo_said ?? null, request_id: o.request_id ?? null,
  };
}

const EVENT_COLS = ['user_id', 'at', 'actor', 'surface', 'via', 'kind', 'target_type', 'target_id', 'topic_id', 'summary', 'before_json',
  'after_json', 'batch_id', 'source', 'source_ref', 'undoable', 'undo_of', 'mo_said', 'request_id'];
const EVENT_SELECT = EVENT_COLS.map(pick).join(', ');

// Event rows appended in chunks, each statement returning its seqs.
export function eventStatements(DB, rows) {
  return chunks(rows).map(part => DB.prepare(`INSERT INTO map_events (user_id, at, actor, surface, via, kind, target_type, target_id, topic_id,
      summary, before_json, after_json, batch_id, source, source_ref, undoable, undo_of, mo_said, request_id)
    SELECT ${EVENT_SELECT} FROM json_each(?) WHERE true RETURNING seq`).bind(JSON.stringify(part)));
}

// A short summary from parts, cut at a word to fit SUMMARY_MAX (for code-built summaries only).
export function summaryOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), SUMMARY_MAX - 30)).replace(/[\s,;:]+$/, '') + '…';
}

function checkOptions(o) {
  if (!isObj(o)) throw new Error('writeBatch needs its options');
  if (!ACTORS.includes(o.actor)) throw new Error(`Unknown actor ${o.actor}`);
  if (o.statements != null && !Array.isArray(o.statements)) throw new Error('statements must be a list');
  if (o.rows != null && !Array.isArray(o.rows)) throw new Error('rows must be a list');
  if (o.events != null && !Array.isArray(o.events)) throw new Error('events must be a list');
}

// ------------------------------------------------------------------ writeBatch

export async function writeBatch(env, user, o) {
  checkOptions(o);
  const at = Date.now();
  const batch_id = o.batch_id || `b_${rand()}`;
  const surface = o.surface == null ? null : SURFACES.includes(o.surface) ? o.surface : null;
  const ctx = { user, at, actor: o.actor, surface, via: o.via, batch_id, mo_said: o.mo_said, request_id: o.request_id,
    undoable: o.undoable, undo_of: o.undo_of };
  const rows = o.rows || [];
  const events = (o.events || []).map((e, i) => eventRow(e, rows[i], ctx));

  // Evidence ops and the topics whose stored scores move (one read batch when there is anything to read).
  const ev = await planEvidence(env, user, o.evidence, { now: at, undoable: !!o.undoable, recompute: o.recompute || [] });
  for (const e of ev.events) events.push(eventRow(e, null, ctx));
  const score = await scoreStatements(env, user, ev, { now: at, actor: o.actor, batch_id });
  for (const e of score.events) events.push(eventRow({ undoable: false, ...e }, null, ctx));

  const stmts = [
    ...(o.statements || []),
    ...rowStatements(env.DB, user, rows, at),
    ...ev.statements,
    ...score.statements,
    ...eventStatements(env.DB, events),
  ];
  if (!stmts.length) return { batch_id, seq: null, scores: {}, dirty: [] };
  const res = await env.DB.batch(stmts);
  let seq = null;
  for (const r of res) for (const x of (r && r.results) || []) if (x && Number.isInteger(x.seq) && (seq == null || x.seq > seq)) seq = x.seq;
  if (seq != null) await notifyLive(env, user, seq);
  return { batch_id, seq, scores: score.scores, dirty: score.dirty };
}

export async function notifyLive(env, user, seq) {
  const ns = env && env.MAP_LIVE;
  if (!ns || typeof ns.idFromName !== 'function') return false;
  try {
    const stub = ns.get(ns.idFromName(user));
    const send = stub.fetch('https://live/notify', { method: 'POST', body: JSON.stringify({ seq }) });
    await Promise.race([send, new Promise(r => setTimeout(r, 250))]);
    return true;
  } catch (e) {
    console.error('live notify failed', e && e.message);
    return false;
  }
}

// Newest seq for the user (0 with no events yet).
export async function latestSeq(env, user) {
  const r = await env.DB.prepare('SELECT max(seq) AS seq FROM map_events WHERE user_id = ?').bind(user).first();
  return (r && r.seq) || 0;
}
