import { HttpError } from '../util.js';
import { ankiCall, ankiCallFull, AnkiError } from '../anki.js';
import { joinParts, sha256Hex } from '../map/onenote-parse.js';
import { applyChange } from '../map/change.js';
import { sanitizeHtml, plainText } from '../../../public/js/notes/html.js';

export const BOOK_REF = 'onenote:STEP 2', BOOK_NAME = 'STEP 2 (OneNote)';
export const MAX_PARTS = 12, PICS_PER_CALL = 6;
export const MAP_VERSION = 4;   // 3 (29 Oct): pictures inside outlines and cells no longer leak their tags as text;
// 4 (29 Oct): pictures inside table cells come across, under their row
const TIMEOUT = 45_000;
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
export function safeTags(html) {
  return String(html || '').replace(TAG, (all, close, tag, attrs, self) => {
    const n = { attrs };
    if (tag.toLowerCase() === 'img') {
      if (close) return '';
      const pic = attr(n, 'pic');
      if (!/^\d+$/.test(String(pic || ''))) return '';
      const keep = ['width', 'height', 'style'].map(k => [k, attr(n, k)]).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${String(v).replace(/["<>]/g, '')}"`).join('');
      return `<img pic="${pic}"${keep}>`;
    }
    return `<${close}${tag}${attrs.replace(/"[^"]*"|'[^']*'/g, q => q.replace(/</g, '&lt;').replace(/>/g, '&gt;'))}${self}>`;
  });
}
// Never a tag's insides as text: two or more attribute pairs in a row ('" width="480" height="213" src="https://...').
const FRAGMENT = /"?\s*(?:\b(?:src|width|height|alt|style|pic|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')\s*){2,}\/?>?/gi;
export const noFragments = s => String(s || '').replace(FRAGMENT, ' ');

// ---------------------------------------------------------------- HTML to a small tree (offsets into the source)
export function parseTree(html) {
  const root = { tag: '#root', attrs: '', children: [], start: 0, inner: 0, end: html.length };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [all, close, tag0, attrs, self] = m;
    const tag = tag0.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (let j = stack.length - 1; j >= i; j--) { stack[j].close = m.index; stack[j].end = m.index + all.length; }
        stack.length = i;
        break;
      }
      continue;
    }
    const node = { tag, attrs, children: [], start: m.index, inner: m.index + all.length, close: null, end: null };
    stack[stack.length - 1].children.push(node);
    if (VOID.has(tag) || self) { node.close = node.end = node.inner; } else stack.push(node);
  }
  for (const n of stack.slice(1)) { n.close = n.end = html.length; }
  return root;
}
const attr = (n, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(n.attrs || ''); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
const px = v => { const m = /(-?[\d.]+)\s*(px|pt)?/.exec(String(v || '')); return m ? Number(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1) : null; };
function styleOf(n) {
  const s = {};
  for (const part of String(attr(n, 'style') || '').split(';')) { const i = part.indexOf(':'); if (i > 0) s[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  return s;
}
const isAbs = n => /absolute/i.test(styleOf(n).position || '');
const find = (n, tag) => (n.tag === tag ? [n] : n.children.flatMap(c => find(c, tag)));

// A text block's height as the page draws it, generously (the page also measures and lays imported blocks out again,
// canvas.js reflowImported): 24 px a line at 8.6 px a character, headings taller.
const estHeight = (html, w) => plainText(html).split('\n').reduce((a, l) => a + Math.max(1, Math.ceil((l.length * 8.6) / Math.max(60, w - 14))) * 24, 0)
  + (html.match(/<h[1-3]>/g) || []).length * 14 + 16;

export function mapPage(source) {
  const html = safeTags(source);
  const root = parseTree(html);
  const outs = [];
  const tops = [];
  (function walk(n) { for (const c of n.children) { if (isAbs(c)) tops.push(c); else walk(c); } })(root);
  if (!tops.length && root.children.length) tops.push({ ...root, attrs: 'style="left:20px;top:20px;width:640px"', tag: 'div' });
  tops.forEach((n, k) => {
    const st = styleOf(n);
    const x = px(st.left) ?? 20, y0 = px(st.top) ?? 20, w = Math.max(60, px(st.width) ?? 640);
    const id = attr(n, 'id') || `o${k}`;
    if (n.tag === 'img') { outs.push(picBlock(n, `${id}`, x, y0)); return; }
    if (n.tag === 'table') { outs.push(...tableBlocks(n, `${id}`, x, y0, w).blocks); return; }
    // An outline: runs of text become one text block each, with its tables and pictures between them.
    let y = y0, run = [], i = 0;
    const flush = () => {
      const h = noFragments(sanitizeHtml(run.join('').replace(/<img\b[^>]*>/gi, ''))).trim();
      run = [];
      if (!plainText(h)) return;
      outs.push({ ref: `${id}#t${i++}`, type: 'text', x, y, w, html: h });
      y += estHeight(h, w);
    };
    for (const c of n.children) {
      const tables = c.tag === 'table' ? [c] : [], pics = c.tag === 'img' ? [c] : find(c, 'img');
      if (tables.length || (pics.length && !plainText(html.slice(c.inner, c.close)).trim())) {
        flush();
        for (const t of tables) { const r = tableBlocks(t, `${id}#tbl${i++}`, x, y, w); outs.push(...r.blocks); y = r.end; }
        if (!tables.length) for (const p of pics) { const b = picBlock(p, `${id}#pic`, x, y); outs.push(b); y += (b.w * b.img_h) / b.img_w + 10; }
        continue;
      }
      run.push(html.slice(c.start, c.end));
      for (const p of pics) { flush(); const b = picBlock(p, `${id}#pic`, x, y); outs.push(b); y += (b.w * b.img_h) / b.img_w + 10; }
    }
    flush();
  });
  // Pictures are matched by number on re-import, whatever outline they sit in.
  for (const b of outs) if (b.type === 'image') b.ref = `pic:${b.pic}`;
  return outs.filter(b => b.type !== 'image' || Number.isInteger(b.pic));

  function picBlock(n, ref, x, y) {
    const st = styleOf(n);
    const w = Math.round(px(attr(n, 'width')) ?? px(st.width) ?? 320), h = Math.round(px(attr(n, 'height')) ?? px(st.height) ?? 240);
    const left = isAbs(n) && px(st.left) != null ? px(st.left) : x, top = isAbs(n) && px(st.top) != null ? px(st.top) : y;
    return { ref, type: 'image', x: left, y: top, w: Math.max(20, w), pic: Number(attr(n, 'pic')), img_w: Math.max(1, w), img_h: Math.max(1, h) };
  }
  // A table, split after each row whose cells hold pictures; those pictures sit under their row, side by side, each
  // at most the table's width. Returns its blocks and the y below the last of them.
  function tableBlocks(n, ref, x, y, w) {
    const rows = [], pics = [];
    for (const tr of find(n, 'tr').slice(0, 60)) {
      const tds = tr.children.filter(c => c.tag === 'td' || c.tag === 'th').slice(0, 20);
      if (!tds.length) continue;
      rows.push(tds.map(td => noFragments(plainText(html.slice(td.inner, td.close).replace(/<img\b[^>]*>/gi, ' '))).replace(/[ \t]{2,}/g, ' ').trim().slice(0, 2000)));
      pics.push(tds.flatMap(td => find(td, 'img')).filter(p => Number.isInteger(Number(attr(p, 'pic')))));
    }
    if (!rows.length) { rows.push(['']); pics.push([]); }
    // Each row as tall as its fullest cell (21 px a line, the cell's share of the width), so what follows sits below it.
    const colW = Math.max(40, w / Math.max(1, ...rows.map(r => r.length)) - 14);
    const rowH = r => 12 + 21 * Math.max(1, ...r.map(c => String(c).split('\n').reduce((k, l) => k + Math.max(1, Math.ceil((l.length * 7.8) / colW)), 0)));
    const blocks = [];
    let seg = [], top = y;
    const close = () => {
      if (!seg.length) return;
      const h = seg.reduce((t, r) => t + rowH(r), 0) + 8;
      blocks.push({ ref: blocks.some(b => b.type === 'table') ? `${ref}#s${blocks.length}` : ref, type: 'table', x, y: top, w, cells: seg, h });
      top += h + 10; seg = [];
    };
    rows.forEach((r, i) => {
      seg.push(r);
      if (!pics[i].length) return;
      close();
      let left = x, line = 0;
      for (const p of pics[i]) {
        const b = picBlock(p, `${ref}#pic`, x, top);
        b.w = Math.min(b.w, w);
        const h = (b.w * b.img_h) / b.img_w;
        if (left > x && left + b.w > x + w) { top += line + 10; left = x; line = 0; }
        Object.assign(b, { x: left, y: top });
        blocks.push(b);
        left += b.w + 10; line = Math.max(line, h);
      }
      top += line + 10;
    });
    close();
    return { blocks, end: top };
  }
}

const ankiHttp = e => (e instanceof AnkiError ? Object.assign(new HttpError(502, e.message.replace(/^Anki: /, 'OneNote: ')), { down: !!e.ambiguous }) : e);

export async function browse(env) {
  let r;
  try { r = await ankiCall(env, 'onenote_topics', {}, { timeoutMs: TIMEOUT }); } catch (e) { throw ankiHttp(e); }
  const by = new Map();
  for (const t of (r && r.topics) || []) {
    if (!t || !t.page_id) continue;
    const s = String(t.section || 'Other');
    if (!by.has(s)) by.set(s, []);
    by.get(s).push({ page_id: String(t.page_id), title: String(t.title || 'Untitled page') });
  }
  return { notebook: 'STEP 2', sections: [...by].map(([name, pages]) => ({ name, pages })) };
}

async function pageSource(env, pageId, beat = null) {
  const parts = [];
  let meta = null;
  for (let part = 1; part <= MAX_PARTS; part++) {
    if (beat && part > 1) await beat();
    let r;
    try { r = await ankiCall(env, 'onenote_page_source', { page: pageId, part }, { timeoutMs: TIMEOUT }); } catch (e) { throw ankiHttp(e); }
    if (!r || typeof r.html !== 'string') throw new HttpError(502, 'OneNote sent a page without its HTML.');
    meta = meta || r;
    parts.push(r.html);
    if (!Number.isInteger(r.parts) || part >= r.parts) break;
  }
  return { title: String(meta.title || 'Untitled page').slice(0, 200), section: String(meta.section || 'Other').slice(0, 120), html: joinParts(parts) };
}

export const picKey = async (user, pageId, n) => `u/${user}/notes/${(await sha256Hex(`${pageId}:${n}`)).slice(0, 32)}.jpg`;
export const stableId = async (...parts) => (await sha256Hex(`notes-import|${parts.join('|')}`)).slice(0, 20);

// ---------------------------------------------------------------- one page in
export async function importPage(env, user, onenoteId, { region = 'us', actor = 'mo', via = null, request_id = null, beat = null } = {}) {
  const src = await pageSource(env, onenoteId, beat);
  const sha = (await sha256Hex(`${MAP_VERSION}|${src.html}`)).slice(0, 40);
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const secRef = `section:${src.section}`;
  const [books, secs, pages, ever] = await env.DB.batch([
    P('SELECT id FROM note_books WHERE user_id = ?1 AND onenote_id = ?2 AND deleted_at IS NULL LIMIT 1', user, BOOK_REF),
    P('SELECT s.id, s.book_id FROM note_sections s JOIN note_books b ON b.user_id = s.user_id AND b.id = s.book_id WHERE s.user_id = ?1 AND s.onenote_id = ?2 AND s.deleted_at IS NULL AND b.onenote_id = ?3 AND b.deleted_at IS NULL LIMIT 1',
      user, `section:${src.section}`, BOOK_REF),
    P('SELECT id, onenote_sha, rev FROM note_pages WHERE user_id = ?1 AND onenote_id = ?2 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1', user, onenoteId),
    P(`SELECT (SELECT count(*) FROM note_books WHERE user_id = ?1 AND onenote_id = ?2) AS b, (SELECT count(*) FROM note_sections WHERE user_id = ?1 AND onenote_id = ?3) AS s,
      (SELECT count(*) FROM note_pages WHERE user_id = ?1 AND onenote_id = ?4) AS p`, user, BOOK_REF, secRef, onenoteId),
  ]);
  const book = (books.results || [])[0], sec = (secs.results || [])[0], page = (pages.results || [])[0];
  const n = (ever.results || [])[0] || {};
  const mapped = mapPage(src.html);
  const pics = mapped.filter(b => b.type === 'image').map(b => b.pic);
  if (page && page.onenote_sha === sha) return { page_id: page.id, onenote_id: onenoteId, title: src.title, unchanged: true, blocks: mapped.length, pictures: pics };

  const changes = [];
  const bookId = book ? book.id : await stableId('book', user, BOOK_REF, n.b || 0);
  const secId = sec ? sec.id : await stableId('section', user, bookId, secRef, n.s || 0);
  const pageId = page ? page.id : await stableId('page', user, onenoteId, n.p || 0);
  const rev = page ? page.rev || 0 : 0;
  if (!book) changes.push({ table: 'books', id: bookId, set: { name: BOOK_NAME, region, onenote_id: BOOK_REF } });
  if (!sec) changes.push({ table: 'sections', id: secId, set: { book_id: bookId, name: src.section, onenote_id: secRef } });
  changes.push({ table: 'pages', id: pageId, set: { ...(page ? {} : { section_id: secId }), title: src.title, onenote_id: onenoteId, onenote_sha: sha } });
  const had = page ? ((await P('SELECT id, onenote_ref FROM note_blocks WHERE user_id = ?1 AND page_id = ?2 AND onenote_ref IS NOT NULL AND deleted_at IS NULL', user, pageId).all()).results || []) : [];
  const byRef = new Map(had.map(b => [b.onenote_ref, b.id]));
  const seen = new Set();
  let z = 0;
  for (const b of mapped) {
    if (seen.has(b.ref)) continue;
    seen.add(b.ref);
    const set = { page_id: pageId, type: b.type, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), z: ++z, onenote_ref: b.ref };
    if (b.type === 'text') set.html = b.html;
    if (b.type === 'table') set.cells = b.cells;
    if (b.type === 'image') Object.assign(set, { r2_key: await picKey(user, onenoteId, b.pic), img_w: b.img_w, img_h: b.img_h });
    changes.push({ table: 'blocks', id: byRef.get(b.ref) || await stableId('block', pageId, rev, b.ref), set });
  }
  for (const [ref, id] of byRef) if (!seen.has(ref)) changes.push({ table: 'blocks', id, delete: true });
  if (beat) await beat();
  const r = await applyChange(env, user, { actor: actor === 'mo' ? 'mo' : 'code', surface: actor === 'mo' ? 'web' : 'chat', op: 'note.save', via, request_id,
    args: { changes, label: `Notes: ${page ? 'Updated' : 'Imported'} "${src.title.slice(0, 60)}" from OneNote` } });
  if (r.refused || r.needs_confirm) return { ...r, onenote_id: onenoteId, title: src.title };
  return { ok: true, page_id: pageId, onenote_id: onenoteId, title: src.title, updated: !!page, blocks: seen.size, pictures: pics, batch_id: r.batch_id };
}

/** Up to 6 of a page's pictures into R2, under the keys its image blocks already hold. Returns {stored: [n], missing: [n]}. */
export async function storePictures(env, user, onenoteId, numbers) {
  const ns = [...new Set((numbers || []).map(Number).filter(Number.isInteger))].slice(0, PICS_PER_CALL);
  if (!ns.length) return { stored: [], missing: [] };
  if (!env.LIBRARY) throw new HttpError(503, 'The picture store is not set up.');
  let r;
  try { r = await ankiCallFull(env, 'onenote_page_pictures', { page: onenoteId, pictures: ns }, { timeoutMs: TIMEOUT }); } catch (e) { throw ankiHttp(e); }
  const stored = [], missing = [];
  for (let i = 0; i < ns.length; i++) {
    const img = r.images[i];
    if (!img) { missing.push(ns[i]); continue; }
    const bytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
    await env.LIBRARY.put(await picKey(user, onenoteId, ns[i]), bytes, { httpMetadata: { contentType: img.mimeType || 'image/jpeg' } });
    stored.push(ns[i]);
  }
  return { stored, missing };
}
