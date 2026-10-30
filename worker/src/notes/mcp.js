// Notes (I30): what the Notes connector's tools do (their schemas and words are in mcp/notes-registry.js).
// Reads see a page in 2D: blocks with their boxes and plain text, ink grouped into clusters of strokes that touch or
// nearly touch, and a picture (png.js). notes_write turns Claude's ops into one note.save batch (undo by batch).
import { tree, readPage, search, blockText, NoteError } from './store.js';
import { decodePoints, encodePoints } from '../../../public/js/notes/geom.js';
import { plainText, textToHtml } from '../../../public/js/notes/html.js';
import { renderPage } from './png.js';
import * as one from './onenote-map.js';
import { applyChange } from '../map/change.js';
import { changeReply, londonStamp } from '../mcp/reply.js';

export const TEXT_CAP = 1500;
const CLUSTER_GAP = 24;
const r0 = v => Math.round(v);

/** A block's height when it has none stored: text by its lines at the page's sizes (a heading style is larger). */
const LINE = { h1: [36, 15], h2: [30, 11.5], h3: [25, 9.5] };
export const heightOf = b => {
  if (b.h != null) return b.h;
  if (b.type === 'image' && b.img_w) return (b.w * b.img_h) / b.img_w;
  if (b.type === 'table') return (safeCells(b).length || 1) * 30 + 8;
  const [lh, cw] = LINE[b.style] || [23, 8];
  const lines = plainText(b.html).split('\n').reduce((a, l) => a + Math.max(1, Math.ceil((l.length * cw) / Math.max(40, b.w - 12))), 0);
  return lines * lh + (String(b.html || '').match(/<h[1-3]>/g) || []).length * 10 + 10;
};
const safeCells = b => { try { return JSON.parse(b.cells_json || '[]'); } catch (e) { return []; } };

/** Strokes grouped into clusters: boxes within CLUSTER_GAP units of each other join. Ids are "ink_<first stroke id>". */
export function clusters(strokes) {
  const n = strokes.length, parent = Array.from({ length: n }, (_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sorted = strokes.map((s, i) => i).sort((a, b) => strokes[a].x0 - strokes[b].x0);
  for (let a = 0; a < n; a++) {
    const A = strokes[sorted[a]];
    for (let b = a + 1; b < n; b++) {
      const B = strokes[sorted[b]];
      if (B.x0 > A.x1 + CLUSTER_GAP) break;
      if (B.y0 <= A.y1 + CLUSTER_GAP && A.y0 <= B.y1 + CLUSTER_GAP) parent[find(sorted[a])] = find(sorted[b]);
    }
  }
  const groups = new Map();
  strokes.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
  return [...groups.values()].map(list => {
    list.sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : 1));
    const x0 = Math.min(...list.map(s => s.x0)), y0 = Math.min(...list.map(s => s.y0)), x1 = Math.max(...list.map(s => s.x1)), y1 = Math.max(...list.map(s => s.y1));
    const tools = [...new Set(list.map(s => s.tool))], colours = [...new Set(list.map(s => s.colour))];
    return { id: `ink_${list[0].id}`, stroke_ids: list.map(s => s.id), x: r0(x0), y: r0(y0), w: r0(x1 - x0), h: r0(y1 - y0),
      tool: tools.length === 1 ? tools[0] : 'mixed', colour: colours.length === 1 ? colours[0] : 'mixed' };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

const blockOut = (b, i) => {
  const text = blockText(b);
  return { n: i + 1, id: b.id, type: b.type, x: r0(b.x), y: r0(b.y), w: r0(b.w), h: r0(heightOf(b)), z: b.z, ...(b.style ? { style: b.style } : {}),
    ...(b.type === 'image' ? { picture: `${b.img_w}x${b.img_h}` } : { text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text }),
    ...(b.onenote_ref ? { from_onenote: true } : {}) };
};
const boundsOf = (blocks, ink) => {
  const all = blocks.map(b => [b.x, b.y, b.x + b.w, b.y + b.h]).concat(ink.map(c => [c.x, c.y, c.x + c.w, c.y + c.h]));
  if (!all.length) return null;
  return { x: Math.min(...all.map(a => a[0])), y: Math.min(...all.map(a => a[1])), w: Math.max(...all.map(a => a[2])) - Math.min(...all.map(a => a[0])),
    h: Math.max(...all.map(a => a[3])) - Math.min(...all.map(a => a[1])) };
};

export async function notesList(env, user, args) {
  if (args.query) return { hits: await search(env, user, args.query, args.region, 20) };
  const t = await tree(env, user, args.region);
  return {
    region: t.region,
    notebooks: t.books.map(b => ({ id: b.id, name: b.name, region: b.region, show_both: !!b.show_both,
      sections: t.sections.filter(s => s.book_id === b.id).map(s => ({ id: s.id, name: s.name,
        pages: t.pages.filter(p => p.section_id === s.id).map(p => ({ id: p.id, title: p.title || 'Untitled page', updated: londonStamp(p.updated_at) })) })) })),
  };
}

async function mustPage(env, user, id) {
  const p = await readPage(env, user, String(id || ''));
  if (!p) throw new NoteError('No page has that id. notes_list shows the pages.');
  return p;
}

export async function notesRead(env, user, args) {
  const p = await mustPage(env, user, args.page_id);
  const blocks = p.blocks.map(blockOut);
  const ink = clusters(p.strokes);
  return { page: { id: p.page.id, title: p.page.title, section: p.page.section_name, notebook: p.page.book_name, region: p.page.region, rev: p.rev },
    units: '1 unit = 1 CSS px at zoom 1; x right, y down; h of text is estimated', bounds: boundsOf(blocks, ink), blocks, ink };
}

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** The page (or a region) as a PNG, plus up to 3 picture blocks in it as their own images, and a legend. */
export async function notesSee(env, user, args) {
  const p = await mustPage(env, user, args.page_id);
  const blocks = p.blocks.map(blockOut);
  const all = boundsOf(blocks, clusters(p.strokes)) || { x: 0, y: 0, w: 800, h: 600 };
  const pad = 30;
  const region = args.w != null && args.h != null ? { x: args.x ?? all.x, y: args.y ?? all.y, w: args.w, h: args.h }
    : { x: (args.x ?? all.x) - pad, y: (args.y ?? all.y) - pad, w: all.w + pad * 2, h: all.h + pad * 2 };
  const inside = b => b.x < region.x + region.w && b.x + b.w > region.x && b.y < region.y + region.h && b.y + b.h > region.y;
  const shown = blocks.filter(inside);
  const r = await renderPage(region, shown, p.strokes);
  const content = [{ type: 'image', data: b64(r.png), mimeType: 'image/png' }];
  const pics = [];
  for (const b of shown.filter(x => x.type === 'image').slice(0, 3)) {
    const row = p.blocks.find(x => x.id === b.id);
    const obj = env.LIBRARY && row.r2_key ? await env.LIBRARY.get(row.r2_key) : null;
    if (!obj || obj.size > 1_500_000) continue;
    content.push({ type: 'image', data: b64(new Uint8Array(await obj.arrayBuffer())), mimeType: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png' });
    pics.push(b.n);
  }
  const legend = { page_id: p.page.id, region: { x: r0(region.x), y: r0(region.y), w: r0(region.w), h: r0(region.h) }, scale: Math.round(r.scale * 1000) / 1000,
    boxes: shown.map(b => ({ n: b.n, id: b.id, type: b.type })), pictures_after_page: pics,
    note: 'Numbered boxes are blocks (their text is in notes_read); ink is drawn as written. Pixel = (unit - region.x) * scale.' };
  content.push({ type: 'text', text: JSON.stringify(legend) });
  return { content, structuredContent: legend, isError: false };
}

// ---------------------------------------------------------------- notes_write
async function stableId(seed) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return 'c' + [...new Uint8Array(d)].slice(0, 9).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Claude's ops as note.save changes: {changes, made: [id per op]}. Ids of new rows are fixed by the call and the page's rev,
 * so a confirmed retry of the same call makes the same rows. */
export async function opsToChanges(env, user, args) {
  const ops = args.ops;
  let pageId = args.page_id || null;
  let page = pageId ? await mustPage(env, user, pageId) : null;
  const seed = `${JSON.stringify(ops)}|${pageId}|${page ? page.rev : ''}`;
  const changes = [], made = [];
  const blockOf = id => page && page.blocks.find(b => b.id === id);
  // ids may name blocks, strokes or ink clusters (ink_<stroke id>), all on the call's page.
  const resolve = ids => {
    if (!page) throw new NoteError('Say which page: page_id.');
    const cl = clusters(page.strokes), out = [];
    for (const id of ids) {
      const c = cl.find(x => x.id === id);
      if (c) { out.push(...c.stroke_ids.map(s => ({ table: 'strokes', row: page.strokes.find(x => x.id === s) }))); continue; }
      const s = page.strokes.find(x => x.id === id);
      if (s) { out.push({ table: 'strokes', row: s }); continue; }
      const b = blockOf(id);
      if (b) { out.push({ table: 'blocks', row: b }); continue; }
      throw new NoteError(`No block or ink ${id} on this page. notes_read lists them.`);
    }
    return out;
  };
  const moveStroke = (s, f) => ({ points: encodePoints(decodePoints(s.points).map(([x, y, p]) => [...f(x, y), p])), tool: s.tool, colour: s.colour, width: s.width });
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const id = await stableId(`${seed}|${i}`);
    if (o.op === 'create_book') { changes.push({ table: 'books', id, set: { name: o.name, region: o.region || 'us' } }); made.push(id); continue; }
    if (o.op === 'create_section') { changes.push({ table: 'sections', id, set: { book_id: o.book_id, name: o.name } }); made.push(id); continue; }
    if (o.op === 'create_page') {
      changes.push({ table: 'pages', id, set: { section_id: o.section_id, title: o.title || '' } });
      pageId = id; page = { page: { id }, rev: 0, blocks: [], strokes: [] };
      made.push(id); continue;
    }
    if (o.op === 'add') {
      if (!pageId) throw new NoteError('add needs page_id (or a create_page before it).');
      const type = o.type === 'table' ? 'table' : 'text';
      const set = { page_id: pageId, type, x: o.x, y: o.y, w: o.w || (type === 'table' ? 420 : 360), z: Math.max(0, ...page.blocks.map(b => b.z || 0)) + 1 + i };
      if (type === 'table') set.cells = o.cells; else { set.html = textToHtml(o.text || ''); set.style = o.style || null; }
      changes.push({ table: 'blocks', id, set }); made.push(id); continue;
    }
    if (o.op === 'edit') {
      const b = blockOf(o.id);
      if (!b) throw new NoteError(`No block ${o.id} on this page.`);
      const set = {};
      if (o.text != null) set.html = textToHtml(o.text);
      if (o.style !== undefined) set.style = o.style || null;
      if (o.cells) set.cells = o.cells;
      changes.push({ table: 'blocks', id: b.id, set }); made.push(b.id); continue;
    }
    if (o.op === 'move' || o.op === 'place' || o.op === 'delete') {
      const items = resolve(o.op === 'place' ? [o.id] : o.ids || []);
      if (o.op === 'delete') { for (const it of items) changes.push({ table: it.table, id: it.row.id, delete: true }); made.push(o.ids); continue; }
      let f;
      if (o.op === 'move') f = (x, y) => [x + (o.dx || 0), y + (o.dy || 0)];
      else {
        // place: the item's box goes to x, y (and to w, h when given, scaling ink; a block takes w and h as they are).
        const box = items.reduce((a, it) => { const r = it.row, h = it.table === 'blocks' ? heightOf(r) : r.y1 - r.y0, x0 = it.table === 'blocks' ? r.x : r.x0, y0 = it.table === 'blocks' ? r.y : r.y0;
          return { x0: Math.min(a.x0, x0), y0: Math.min(a.y0, y0), x1: Math.max(a.x1, x0 + (it.table === 'blocks' ? r.w : r.x1 - r.x0)), y1: Math.max(a.y1, y0 + h) }; },
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
        const sx = o.w ? o.w / Math.max(1, box.x1 - box.x0) : 1, sy = o.h ? o.h / Math.max(1, box.y1 - box.y0) : (o.w ? sx : 1);
        const nx = o.x ?? box.x0, ny = o.y ?? box.y0;
        f = (x, y) => [nx + (x - box.x0) * sx, ny + (y - box.y0) * sy];
        if (items.length === 1 && items[0].table === 'blocks') {
          const b = items[0].row, set = { x: nx, y: ny };
          if (o.w) set.w = o.w;
          if (o.h && b.type !== 'image') set.h = o.h;
          changes.push({ table: 'blocks', id: b.id, set }); made.push(b.id); continue;
        }
      }
      for (const it of items) {
        if (it.table === 'strokes') changes.push({ table: 'strokes', id: it.row.id, set: moveStroke(it.row, f) });
        else { const [x, y] = f(it.row.x, it.row.y); changes.push({ table: 'blocks', id: it.row.id, set: { x, y } }); }
      }
      made.push(o.op === 'place' ? o.id : o.ids); continue;
    }
    throw new NoteError(`Unknown op ${o.op}.`);
  }
  return { changes, made, page_id: pageId };
}

export async function notesWrite(env, user, args, ctx) {
  const bad = (args.ops || []).filter(o => o.op === 'undo');
  if (bad.length) {
    if (args.ops.length > 1) return { problems: ['undo is an op of its own: send it alone.'] };
    return changeReply(await applyChange(env, user, { actor: 'claude', surface: ctx.surface || 'chat', op: 'undo', args: { batch_id: bad[0].batch_id },
      confirm_token: args.confirm_token || null, via: ctx.via, request_id: ctx.request_id }));
  }
  let plan;
  try { plan = await opsToChanges(env, user, args); } catch (e) { if (e instanceof NoteError) return { refused: true, reason: e.message }; throw e; }
  const r = await applyChange(env, user, { actor: 'claude', surface: ctx.surface || 'chat', op: 'note.save', args: { changes: plan.changes },
    mo_said: args.mo_said || null, confirm_token: args.confirm_token || null, via: ctx.via, request_id: ctx.request_id });
  const out = changeReply(r, { page_id: plan.page_id, made: plan.made });
  delete out.ids; delete out.pages;
  return out;
}

// ---------------------------------------------------------------- notes_import
export const IMPORT_PAGES = 10, IMPORT_PICS = 12;
export async function notesImport(env, user, args, ctx) {
  const b = await one.browse(env);
  const q = String(args.onenote || '').trim().toLowerCase();
  const all = b.sections.flatMap(s => s.pages.map(p => ({ ...p, section: s.name })));
  let pick = all.filter(p => p.page_id.toLowerCase() === q);
  if (!pick.length && (q === 'step 2' || q === 'notebook' || q === 'all')) pick = all;
  if (!pick.length) pick = all.filter(p => p.section.toLowerCase() === q);
  if (!pick.length) pick = all.filter(p => p.title.toLowerCase() === q);
  if (!pick.length) pick = all.filter(p => p.section.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
  if (!pick.length) return { refused: true, reason: `Nothing in OneNote matches "${args.onenote}". Sections: ${b.sections.map(s => s.name).join(', ')}.` };
  const done = [], left = pick.slice(IMPORT_PAGES).map(p => p.title);
  let picsLeft = IMPORT_PICS, picsOwed = 0;
  for (const p of pick.slice(0, IMPORT_PAGES)) {
    const r = await one.importPage(env, user, p.page_id, { region: args.region === 'uk' ? 'uk' : 'us', actor: 'claude', via: ctx.via, request_id: ctx.request_id });
    if (r.refused || r.needs_confirm) return { ...r, imported: done };
    const want = r.unchanged ? [] : r.pictures;
    const now = want.slice(0, picsLeft);
    for (let i = 0; i < now.length; i += one.PICS_PER_CALL) await one.storePictures(env, user, p.page_id, now.slice(i, i + one.PICS_PER_CALL));
    picsLeft -= now.length;
    picsOwed += want.length - now.length;
    done.push({ page_id: r.page_id, title: r.title, ...(r.unchanged ? { unchanged: true } : { blocks: r.blocks, updated: r.updated }), ...(r.batch_id ? { batch_id: r.batch_id } : {}) });
  }
  return { imported: done, ...(left.length ? { left, next_step: 'Call notes_import again with the same onenote to bring the rest.' } : {}),
    ...(picsOwed ? { pictures_waiting: picsOwed, say: 'Some pictures are still to come: Import from OneNote on the Notes page fetches them.' } : {}) };
}
