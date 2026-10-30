import { writeBatch, summaryOf } from '../map/events.js';
import { CHANGED_AGAIN, CANNOT } from '../map/undo.js';
import { sanitizeHtml, plainText, HTML_MAX } from '../../../public/js/notes/html.js';
import { decodePoints, encodePoints, bbox, radiusAt, TOOLS, MAX_POINTS } from '../../../public/js/notes/geom.js';

export const COLS = {
  note_books: ['id', 'name', 'region', 'show_both', 'sort', 'onenote_id', 'created_at', 'updated_at', 'deleted_at'],
  note_sections: ['id', 'book_id', 'name', 'sort', 'onenote_id', 'created_at', 'updated_at', 'deleted_at'],
  note_pages: ['id', 'section_id', 'title', 'sort', 'rev', 'onenote_id', 'onenote_sha', 'created_at', 'updated_at', 'deleted_at'],
  note_blocks: ['id', 'page_id', 'type', 'x', 'y', 'w', 'h', 'z', 'style', 'html', 'cells_json', 'r2_key', 'img_w', 'img_h', 'onenote_ref', 'rev',
    'created_by', 'created_at', 'updated_at', 'deleted_at'],
  note_strokes: ['id', 'page_id', 'tool', 'colour', 'width', 'points', 'x0', 'y0', 'x1', 'y1', 'z', 'rev', 'created_by', 'created_at', 'updated_at', 'deleted_at'],
};
export const TABLES = Object.keys(COLS);
export const REGIONS = ['us', 'uk'];
export const STYLES = ['h1', 'h2', 'h3'];
export const BATCH_BYTES = 1_500_000;          // one batch's rows, as JSON (D1 rows top out at 2 MB)
const PARAM_BYTES = 800_000;                   // one JSON parameter
const COORD = 10_000_000;
const BOOKKEEPING = new Set(['updated_at', 'rev', 'created_at', 'user_id']);

export class NoteError extends Error {}
const bad = msg => { throw new NoteError(msg); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const strip = row => { if (!row) return null; const o = {}; for (const [k, v] of Object.entries(row)) if (k !== 'user_id') o[k] = v; return o; };
const num = (v, name, lo = -COORD, hi = COORD) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) bad(`${name} must be a number from ${lo} to ${hi}.`);
  return Math.round(n * 10) / 10;
};
const str = (v, name, max, min = 0) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < min) bad(`${name} is missing.`);
  if (s.length > max) bad(`${name} is over ${max} characters.`);
  return s;
};

// ------------------------------------------------------------------ reads

const regionWhere = "(b.region = ?2 OR b.show_both = 1)";
export const regionOf = v => (REGIONS.includes(v) ? v : 'us');

/** The sidebar: notebooks for the region (and those shown in both), their sections and pages. One batch. */
export async function tree(env, user, region = 'us') {
  const r = regionOf(region);
  const [books, sections, pages] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, region, show_both, sort, updated_at FROM note_books b WHERE user_id = ?1 AND deleted_at IS NULL AND ${regionWhere}
      ORDER BY sort, created_at`).bind(user, r),
    env.DB.prepare(`SELECT s.id, s.book_id, s.name, s.sort, s.updated_at FROM note_sections s JOIN note_books b ON b.user_id = s.user_id AND b.id = s.book_id
      WHERE s.user_id = ?1 AND s.deleted_at IS NULL AND b.deleted_at IS NULL AND ${regionWhere} ORDER BY s.sort, s.created_at`).bind(user, r),
    env.DB.prepare(`SELECT p.id, p.section_id, p.title, p.sort, p.rev, p.updated_at, p.onenote_id IS NOT NULL AS imported FROM note_pages p
      JOIN note_sections s ON s.user_id = p.user_id AND s.id = p.section_id JOIN note_books b ON b.user_id = s.user_id AND b.id = s.book_id
      WHERE p.user_id = ?1 AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND b.deleted_at IS NULL AND ${regionWhere} ORDER BY p.sort, p.created_at`).bind(user, r),
  ]);
  return { region: r, books: books.results || [], sections: sections.results || [], pages: pages.results || [] };
}

/**
 * One page: {page, blocks, strokes, rev}. since: only rows written after that rev, deleted ones too (an open page merges
 * them); without it, the live rows only. One batch.
 */
export async function readPage(env, user, id, since = null) {
  const after = Number.isInteger(since) && since >= 0 ? since : null;
  const live = after == null ? 'AND deleted_at IS NULL' : 'AND rev > ?3';
  const bind = q => (after == null ? q.bind(user, id) : q.bind(user, id, after));
  const [page, blocks, strokes] = await env.DB.batch([
    env.DB.prepare(`SELECT p.*, s.name AS section_name, s.book_id, b.name AS book_name, b.region, b.show_both FROM note_pages p
      LEFT JOIN note_sections s ON s.user_id = p.user_id AND s.id = p.section_id LEFT JOIN note_books b ON b.user_id = s.user_id AND b.id = s.book_id
      WHERE p.user_id = ?1 AND p.id = ?2`).bind(user, id),
    bind(env.DB.prepare(`SELECT ${COLS.note_blocks.join(', ')} FROM note_blocks WHERE user_id = ?1 AND page_id = ?2 ${live} ORDER BY z, created_at`)),
    bind(env.DB.prepare(`SELECT ${COLS.note_strokes.join(', ')} FROM note_strokes WHERE user_id = ?1 AND page_id = ?2 ${live} ORDER BY z, created_at`)),
  ]);
  const p = (page.results || [])[0];
  if (!p || p.deleted_at) return null;
  return { page: strip(p), rev: p.rev, since: after, blocks: blocks.results || [], strokes: strokes.results || [] };
}

/** Search over page titles and block text: [{page_id, block_id, title, where, snippet}] for the region. */
export async function search(env, user, q, region = 'us', limit = 30) {
  const terms = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return [];
  const match = terms.slice(0, 8).map(t => `"${t}"*`).join(' ');
  const rows = (await env.DB.prepare(`SELECT f.page_id, f.block_id, snippet(note_fts, 3, '[', ']', '…', 12) AS snippet, p.title, s.name AS section, b.name AS book
    FROM note_fts f JOIN note_pages p ON p.user_id = f.user_id AND p.id = f.page_id AND p.deleted_at IS NULL
    JOIN note_sections s ON s.user_id = p.user_id AND s.id = p.section_id AND s.deleted_at IS NULL
    JOIN note_books b ON b.user_id = s.user_id AND b.id = s.book_id AND b.deleted_at IS NULL AND (b.region = ?3 OR b.show_both = 1)
    WHERE note_fts MATCH ?2 AND f.user_id = ?1 ORDER BY rank LIMIT ?4`).bind(user, match, regionOf(region), limit).all()).results || [];
  return rows.map(r => ({ page_id: r.page_id, block_id: r.block_id || null, title: r.title, where: `${r.book} › ${r.section}`, snippet: r.snippet }));
}

// ------------------------------------------------------------------ checking one row

/** A stroke's fields from what was sent: points cleaned and re-encoded, the box worked out here. */
export function strokeFields(s) {
  const tool = TOOLS.includes(s.tool) ? s.tool : 'pen';
  const width = num(s.width ?? 2.5, 'width', 0.5, 64);
  const pts = Array.isArray(s.points) ? s.points : decodePoints(s.points);
  if (!pts.length) bad('A stroke needs its points.');
  if (pts.length > MAX_POINTS) bad(`A stroke has at most ${MAX_POINTS} points.`);
  for (const p of pts) if (!p.slice(0, 2).every(v => Number.isFinite(v) && Math.abs(v) < COORD)) bad('A stroke point is out of range.');
  const pad = radiusAt(tool, width, 1);
  return { tool, colour: colourOf(s.colour), width, points: encodePoints(pts), ...bbox(pts, pad) };
}
const colourOf = c => (c === 'ink' || /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : 'ink');

export function cellsOf(cells) {
  if (!Array.isArray(cells) || !cells.length || !cells.every(Array.isArray)) bad('A table is a list of rows, each a list of cells.');
  if (cells.length > 60 || cells.some(r => r.length > 20)) bad('A table has at most 60 rows and 20 columns.');
  const cols = Math.max(...cells.map(r => r.length));
  return JSON.stringify(cells.map(r => Array.from({ length: cols }, (_, i) => String(r[i] ?? '').slice(0, 2000))));
}

// A block's or stroke's fields, checked; only the fields given (an update) unless full.
function checkContent(t, set, user) {
  const o = {};
  if ('x' in set) o.x = num(set.x, 'x');
  if ('y' in set) o.y = num(set.y, 'y');
  if ('z' in set) o.z = Math.round(num(set.z, 'z', -1e9, 1e9));
  if (t === 'note_blocks') {
    if ('type' in set) { if (!['text', 'image', 'table'].includes(set.type)) bad('A block is text, image or table.'); o.type = set.type; }
    if ('w' in set) o.w = num(set.w, 'w', 8, 20000);
    if ('h' in set) o.h = set.h == null ? null : num(set.h, 'h', 8, 50000);
    if ('style' in set) { if (set.style != null && !STYLES.includes(set.style)) bad('style is h1, h2, h3 or empty.'); o.style = set.style || null; }
    if ('html' in set) { if (String(set.html || '').length > HTML_MAX * 2) bad('That text block is too long.'); o.html = sanitizeHtml(set.html); }
    if ('cells' in set) o.cells_json = cellsOf(set.cells);
    if ('r2_key' in set) { if (!new RegExp(`^u/${user}/notes/[a-z0-9]+\\.(png|jpe?g|webp|gif)$`).test(String(set.r2_key || ''))) bad('That image is not one of the hub\'s.'); o.r2_key = set.r2_key; }
    for (const k of ['img_w', 'img_h']) if (k in set) o[k] = set[k] == null ? null : Math.round(num(set[k], k, 1, 20000));
    if ('onenote_ref' in set) o.onenote_ref = set.onenote_ref == null ? null : str(set.onenote_ref, 'onenote_ref', 200);
  } else if (t === 'note_strokes') {
    if ('points' in set) Object.assign(o, strokeFields(set));
  }
  return o;
}

// ------------------------------------------------------------------ planning a batch

/**
 * changes: [{t: table, id, set: {...fields} | null (delete)}]. Reads every row once, checks each change, bumps the rev of
 * every page touched and returns {writes: [{t, before, after}], pages: {page_id: rev}, counts} for apply().
 * opts: {now, actor, keepDeleted}
 */
export async function planRows(env, user, changes, { now = Date.now(), actor = 'mo' } = {}) {
  if (!Array.isArray(changes) || !changes.length) return { writes: [], pages: {}, counts: {} };
  const ids = {};
  for (const c of changes) {
    if (!TABLES.includes(c.t)) bad('Unknown notes table.');
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(c.id)) bad('A notes id is up to 40 letters, digits, - or _.');
    (ids[c.t] ||= new Set()).add(c.id);
  }
  const cur = await readRows(env, user, ids);
  // The pages these rows sit on (new rows name theirs), read with the rest when not already here.
  const pageOf = c => (c.t === 'note_pages' ? c.id : c.t === 'note_blocks' || c.t === 'note_strokes'
    ? ((c.set && c.set.page_id) || (cur.get(`${c.t}|${c.id}`) || {}).page_id) : null);
  const need = new Set(changes.map(pageOf).filter(p => p && !cur.has(`note_pages|${p}`)));
  if (need.size) for (const [k, v] of await readRows(env, user, { note_pages: need })) cur.set(k, v);

  const pages = {};
  const pageRev = pid => {
    const p = cur.get(`note_pages|${pid}`);
    if (!p || p.deleted_at) bad('That page does not exist (or was deleted).');
    return (pages[pid] ??= (p.rev || 0) + 1);
  };
  const writes = [], seen = new Set();
  const counts = { added: 0, changed: 0, removed: 0 };
  // Parents first, so a page made in this batch can take its blocks in the same batch.
  const order = c => TABLES.indexOf(c.t);
  for (const c of [...changes].sort((a, b) => order(a) - order(b))) {
    const key = `${c.t}|${c.id}`;
    if (seen.has(key)) bad('A row is named twice in one change.');
    seen.add(key);
    const before = strip(cur.get(key)) || null;
    let after;
    if (c.set === null) {
      if (!before || before.deleted_at) continue;
      after = { ...before, deleted_at: now, updated_at: now };
      counts.removed++;
    } else {
      if (!isObj(c.set)) bad('Each change carries its fields.');
      after = before && !before.deleted_at ? { ...before } : fresh(c.t, c.id, now, actor);
      if (before && before.deleted_at && !c.set.restore) bad('That was deleted; undo the delete to bring it back.');
      Object.assign(after, await checkTree(env, user, c.t, c.set, before, cur), checkContent(c.t, c.set, user), { updated_at: now, deleted_at: null });
      required(c.t, after);
      if (before && !before.deleted_at) counts.changed++; else counts.added++;
    }
    const pid = pageOf({ t: c.t, id: c.id, set: after });
    if (pid && c.t !== 'note_pages') after.rev = pageRev(pid);
    writes.push({ t: c.t, before, after });
    cur.set(key, { ...after });
  }
  // The pages touched move to their new rev (a page row already in the batch carries it).
  for (const [pid, rev] of Object.entries(pages)) {
    const w = writes.find(x => x.t === 'note_pages' && x.after.id === pid);
    if (w) { w.after.rev = rev; continue; }
    const p = strip(cur.get(`note_pages|${pid}`));
    writes.push({ t: 'note_pages', before: p, after: { ...p, rev, updated_at: now }, bump: true });
  }
  for (const w of writes) if (w.t === 'note_pages' && !w.bump && w.after.rev === (w.before && w.before.rev)) {
    w.after.rev = (w.before ? w.before.rev || 0 : 0) + 1;
    pages[w.after.id] = w.after.rev;
  }
  const size = JSON.stringify(writes).length;
  if (size > BATCH_BYTES) bad('That is too much to save at once; save it in parts.');
  return { writes, pages, counts };
}

function fresh(t, id, now, actor) {
  const base = { id, created_at: now, updated_at: now, deleted_at: null };
  if (t === 'note_books') return { ...base, name: '', region: 'us', show_both: 0, sort: now, onenote_id: null };
  if (t === 'note_sections') return { ...base, book_id: null, name: '', sort: now, onenote_id: null };
  if (t === 'note_pages') return { ...base, section_id: null, title: '', sort: now, rev: 0, onenote_id: null, onenote_sha: null };
  if (t === 'note_blocks') return { ...base, page_id: null, type: 'text', x: 0, y: 0, w: 320, h: null, z: 0, style: null, html: '', cells_json: null, r2_key: null,
    img_w: null, img_h: null, onenote_ref: null, rev: 0, created_by: actor };
  return { ...base, page_id: null, tool: 'pen', colour: 'ink', width: 2.5, points: '', x0: 0, y0: 0, x1: 0, y1: 0, z: 0, rev: 0, created_by: actor };
}

function required(t, a) {
  if (t === 'note_books' && !a.name) bad('A notebook needs a name.');
  if (t === 'note_sections' && (!a.name || !a.book_id)) bad('A section needs a name and its notebook.');
  if (t === 'note_pages' && !a.section_id) bad('A page needs its section.');
  if ((t === 'note_blocks' || t === 'note_strokes') && !a.page_id) bad('That needs its page.');
  if (t === 'note_blocks' && a.type === 'image' && !a.r2_key) bad('An image block needs its picture.');
  if (t === 'note_blocks' && a.type === 'table' && !a.cells_json) bad('A table block needs its cells.');
  if (t === 'note_strokes' && !a.points) bad('A stroke needs its points.');
}

// Names, order, region and parents: the sidebar's fields, with the parent checked to exist.
async function checkTree(env, user, t, set, before, cur) {
  const o = {};
  if ('name' in set && (t === 'note_books' || t === 'note_sections')) o.name = str(set.name, 'The name', 120, 1);
  if ('title' in set && t === 'note_pages') o.title = str(set.title, 'The title', 200);
  if ('sort' in set) o.sort = num(set.sort, 'sort', -1e15, 1e15);
  if (t === 'note_books') {
    if ('region' in set) { if (!REGIONS.includes(set.region)) bad('region is us or uk.'); o.region = set.region; }
    if ('show_both' in set) o.show_both = set.show_both ? 1 : 0;
  }
  if ('onenote_id' in set && ['note_books', 'note_sections', 'note_pages'].includes(t)) o.onenote_id = set.onenote_id == null ? null : str(set.onenote_id, 'onenote_id', 300);
  if ('onenote_sha' in set && t === 'note_pages') o.onenote_sha = set.onenote_sha == null ? null : str(set.onenote_sha, 'onenote_sha', 80);
  const parent = { note_sections: ['book_id', 'note_books'], note_pages: ['section_id', 'note_sections'], note_blocks: ['page_id', 'note_pages'], note_strokes: ['page_id', 'note_pages'] }[t];
  if (parent && parent[0] in set && (!before || before[parent[0]] !== set[parent[0]])) {
    const pid = String(set[parent[0]] || '');
    let row = cur.get(`${parent[1]}|${pid}`);
    if (row === undefined) row = (await readRows(env, user, { [parent[1]]: new Set([pid]) })).get(`${parent[1]}|${pid}`);
    if (!row || row.deleted_at) bad(`That ${parent[1].replace('note_', '').replace(/s$/, '')} does not exist.`);
    if (cur.get(`${parent[1]}|${pid}`) === undefined) cur.set(`${parent[1]}|${pid}`, row);
    o[parent[0]] = pid;
  }
  return o;
}

/** Rows by table and id, one batch: Map of "table|id" -> row. */
export async function readRows(env, user, ids) {
  const tables = Object.keys(ids).filter(t => ids[t] && ids[t].size);
  if (!tables.length) return new Map();
  const res = await env.DB.batch(tables.map(t => env.DB.prepare(`SELECT * FROM ${t} WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
    .bind(user, JSON.stringify([...ids[t]]))));
  const out = new Map();
  tables.forEach((t, i) => { for (const r of res[i].results || []) out.set(`${t}|${r.id}`, r); });
  return out;
}

// ------------------------------------------------------------------ writing a batch

// Whole-row upserts, grouped by table, each JSON parameter under PARAM_BYTES.
function upserts(DB, user, writes) {
  const out = [];
  for (const t of TABLES) {
    const rows = writes.filter(w => w.t === t).map(w => ({ ...w.after, user_id: user }));
    if (!rows.length) continue;
    const cols = ['user_id', ...COLS[t]];
    const sql = `INSERT INTO ${t} (${cols.join(', ')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?)
      WHERE true ON CONFLICT (user_id, id) DO UPDATE SET ${COLS[t].filter(c => c !== 'id' && c !== 'created_at').map(c => `${c} = excluded.${c}`).join(', ')}`;
    let part = [], bytes = 0;
    const flush = () => { if (part.length) out.push(DB.prepare(sql).bind(JSON.stringify(part))); part = []; bytes = 0; };
    for (const r of rows) {
      const n = JSON.stringify(r).length;
      if (bytes + n > PARAM_BYTES) flush();
      part.push(Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
      bytes += n;
    }
    flush();
  }
  return out;
}

/** The text search keeps for a block: its plain text, or a table's cells. */
export function blockText(b) {
  if (!b || b.deleted_at) return '';
  if (b.type === 'text') return plainText(b.html);
  if (b.type === 'table') { try { return JSON.parse(b.cells_json || '[]').map(r => r.join(' · ')).join('\n'); } catch (e) { return ''; } }
  return '';
}

// The search rows for every block and page title in the batch, rewritten.
function ftsStatements(DB, user, writes) {
  const blocks = writes.filter(w => w.t === 'note_blocks').map(w => w.after);
  const pages = writes.filter(w => w.t === 'note_pages' && !w.bump).map(w => w.after);
  const out = [];
  const rows = [];
  if (blocks.length) {
    out.push(DB.prepare('DELETE FROM note_fts WHERE user_id = ?1 AND block_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(blocks.map(b => b.id))));
    for (const b of blocks) { const text = blockText(b); if (text) rows.push({ page_id: b.page_id, block_id: b.id, text }); }
  }
  if (pages.length) {
    out.push(DB.prepare("DELETE FROM note_fts WHERE user_id = ?1 AND block_id = '' AND page_id IN (SELECT value FROM json_each(?2))").bind(user, JSON.stringify(pages.map(p => p.id))));
    for (const p of pages) if (!p.deleted_at && p.title) rows.push({ page_id: p.id, block_id: '', text: p.title });
  }
  if (rows.length) {
    out.push(DB.prepare(`INSERT INTO note_fts (user_id, page_id, block_id, text) SELECT ?1, json_extract(value, '$.page_id'), json_extract(value, '$.block_id'),
      json_extract(value, '$.text') FROM json_each(?2)`).bind(user, JSON.stringify(rows)));
  }
  return out;
}

const kindOf = c => (c.removed && !c.added && !c.changed ? 'note.removed' : c.added && !c.removed && !c.changed ? 'note.added' : 'note.updated');
const anchorOf = writes => {
  const pg = writes.find(w => w.t === 'note_pages');
  const w = pg || writes[0];
  return { type: w.t, id: w.after.id };
};

/** The one event for a planned batch: snapshots in before_json, {page_id, rev} in after_json. */
export function noteEvent(plan, summary) {
  const a = anchorOf(plan.writes);
  const pid = a.type === 'note_pages' ? a.id : null;
  return {
    kind: kindOf(plan.counts), target_type: a.type, target_id: a.id, summary: summaryOf(summary),
    before: { rows: plan.writes.map(w => ({ t: w.t, row: w.before })), expect: plan.writes.map(w => ({ t: w.t, row: w.after, ...(w.bump ? { bump: 1 } : {}) })) },
    after: { page_id: pid, rev: pid ? plan.pages[pid] ?? null : null, pages: plan.pages },
  };
}

/** applyChange's apply for every note.* op: one writeBatch with the rows, the search rows and the event. */
export async function applyNotes(env, user, plan, ctx) {
  const n = plan.notes;
  if (!n || !n.writes.length) return { ok: true, nothing: true, summary: 'Nothing to change.' };
  const w = await writeBatch(env, user, {
    batch_id: ctx.batch_id, actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said, request_id: ctx.request_id, undoable: true,
    statements: [...upserts(env.DB, user, n.writes), ...ftsStatements(env.DB, user, n.writes)],
    events: [{ kind: plan.events[0].kind, target_type: plan.events[0].target_type, target_id: plan.events[0].target_id, summary: plan.events[0].summary,
      before: plan.events[0].before, after: plan.events[0].after, undoable: true }],
  });
  return { ok: true, batch_id: w.batch_id, seq: w.seq, pages: n.pages, ids: n.writes.filter(x => !x.bump).map(x => x.after.id), ...(plan.reply || {}),
    undo_hint: 'Say "undo that" to reverse it.' };
}

// ------------------------------------------------------------------ undo

const sameContent = (a, b) => {
  if (!a || !b) return !a && !b;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (BOOKKEEPING.has(k)) continue;
    if ((a[k] ?? null) !== (b[k] ?? null) && String(a[k] ?? '') !== String(b[k] ?? '')) return false;
  }
  return true;
};

/**
 * undoBatch's handler for a notes event (target:note_*): rows back as they were, after checking each is still as the
 * batch left it. Returns {statements, rows: [the anchor row]}: the anchor's before carries the snapshots the other way
 * round, so undoing this undo redoes the change.
 */
export async function undoNotes(env, user, e, ctx) {
  let b = null;
  try { b = JSON.parse(e.before_json || 'null'); } catch (err) { b = null; }
  if (!b || !Array.isArray(b.rows) || !Array.isArray(b.expect) || b.rows.length !== b.expect.length || !b.rows.length) return { conflict: CANNOT };
  const ids = {};
  for (const x of b.expect) (ids[x.t] ||= new Set()).add(x.row.id);
  const cur = await readRows(env, user, ids);
  const now = Date.now();
  // Pages whose rev moves: every page row in the batch, and the page under every block and stroke.
  const pageIds = new Set();
  for (const x of b.expect) {
    const c = cur.get(`${x.t}|${x.row.id}`);
    // A page's rev bump is bookkeeping: a rename since does not block undoing the ink under it.
    if (!x.bump && !sameContent(strip(c), x.row)) return { conflict: CHANGED_AGAIN };
    if (x.t === 'note_pages') pageIds.add(x.row.id);
    else if (x.row.page_id) pageIds.add(x.row.page_id);
  }
  const missing = [...pageIds].filter(p => !cur.has(`note_pages|${p}`));
  if (missing.length) for (const [k, v] of await readRows(env, user, { note_pages: new Set(missing) })) cur.set(k, v);
  const revs = {};
  for (const p of pageIds) revs[p] = ((cur.get(`note_pages|${p}`) || {}).rev || 0) + 1;
  const keep = b.rows.map((x, i) => i).filter(i => !b.expect[i].bump);
  const writes = keep.map(i => [b.rows[i], i]).map(([x, i]) => {
    const now_ = strip(cur.get(`${b.expect[i].t}|${b.expect[i].row.id}`));
    const after = x.row ? { ...x.row, updated_at: now } : { ...now_, deleted_at: now, updated_at: now };
    const t = b.expect[i].t;
    if (t === 'note_pages') after.rev = revs[after.id];
    else if (after.page_id && revs[after.page_id]) after.rev = revs[after.page_id];
    return { t, before: now_, after };
  });
  for (const p of pageIds) if (!writes.some(w => w.t === 'note_pages' && w.after.id === p)) {
    const row = strip(cur.get(`note_pages|${p}`));
    if (row) writes.push({ t: 'note_pages', before: row, after: { ...row, rev: revs[p], updated_at: now }, bump: true });
  }
  const anchor = writes.find(w => !w.bump) || writes[0];
  return {
    statements: [...upserts(env.DB, user, writes), ...ftsStatements(env.DB, user, writes)],
    rows: [{ table: anchor.t, op: 'update', key: { id: anchor.after.id },
      before: { rows: writes.filter(w => !w.bump).map(w => ({ t: w.t, row: w.before })), expect: writes.filter(w => !w.bump).map(w => ({ t: w.t, row: w.after })) },
      after: { updated_at: now } }],
  };
}
