import { HttpError, json, readJson, safeParse } from '../util.js';
import { requireModule, modulesFor, LEARNER } from './modules.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { meterFixed } from './ai.js';
import { bump, lockedFor } from './auth.js';
import * as lib from '../library/routes.js';
import * as store from '../library/store.js';
import { searchLibrary } from '../library/search.js';
import { libraryJob } from '../library/jobs.js';
import { cut } from '../library/text.js';

export const MAX_FILE = 50 * 1024 * 1024;
export const MAX_TOTAL = 300 * 1024 * 1024;     // all of one person's files
export const MAX_DOCS = 300;
export const READ_MAX = 12_000;                 // characters library_read returns in one call
export const SEARCH_TOP = 8;                    // results library_search returns
export const SNIPPET_MAX = 600;                 // characters of one passage in library_search
export const UPLOAD_RATE = { limit: 60, windowMs: 3_600_000, lockMs: 15 * 60_000 };
export const RUN_RATE = { limit: 40, windowMs: 3_600_000, lockMs: 10 * 60_000 };
export const SEARCH_RATE = { limit: 300, windowMs: 3_600_000, lockMs: 5 * 60_000 };   // each search embeds and reranks on Workers AI
export const STALE_UPLOAD_MS = 2 * 86_400_000;  // an upload that never finished is cleared after this
const EXTRACT_USD = 0.01;                       // estimated Workers AI cost of the server-side reader, per file

// ------------------------------------------------------------------ routes

const gate = fn => (request, env, ctx, params, url, user, session) => {
  requireModule(session, 'library', env);
  return fn(request, env, ctx, params, url, user, session);
};

// What a document is, kept in 2.5's collection column: the Exams screen lists exam papers and mark schemes.
export const KIND_COLLECTION = { exam_paper: 'exam-paper', mark_scheme: 'mark-scheme', notes: 'notes', other: null };
const COLLECTIONS = new Set(Object.values(KIND_COLLECTION).filter(Boolean));
// One more file added through an upload link (exams.js makes the links).
const countUpload = (env, link) => env.DB.prepare('UPDATE upload_links SET files = files + 1 WHERE user_id = ?1 AND id = ?2').bind(link.user_id, link.id).run();

// A copy of the request with a new body (readJson / arrayBuffer consume the original).
const withBody = (request, body) => new Request(request.url, { method: request.method, headers: request.headers, body });

async function rateLimit(env, user, bucket, cfg, what) {
  const t = Date.now();
  if (await lockedFor(env, user, bucket, t) || !(await bump(env, user, bucket, cfg, t))) {
    throw new HttpError(429, `That is a lot of ${what} in one hour. Please wait a few minutes and try again.`);
  }
}

const usage = async (env, user) => await env.DB.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(bytes), 0) AS bytes FROM library_docs WHERE user_id = ?1').bind(user).first()
  || { docs: 0, bytes: 0 };

// GET /api/p/library -> 2.5's {docs, totals, vectors, models, limits} plus quota and, per document, ocr_pending
// (pictures still waiting to be read).
async function listRoute(request, env, ctx, params, url, user) {
  const res = await lib.listRoute(request, env, ctx, params, url, user);
  if (res.status !== 200) return res;
  const body = await res.json();
  const [u, ocr] = await Promise.all([
    usage(env, user),
    env.DB.prepare("SELECT doc_id, COUNT(*) AS n FROM library_pages WHERE user_id = ?1 AND ocr_state = 'pending' GROUP BY doc_id").bind(user).all(),
  ]);
  const pending = new Map((ocr.results || []).map(r => [r.doc_id, r.n]));
  const folders = new Map(((await env.DB.prepare('SELECT id, folder FROM library_docs WHERE user_id = ? AND folder IS NOT NULL').bind(user).all()).results || []).map(r => [r.id, r.folder]));
  return json({ ...body, docs: (body.docs || []).map(d => ({ ...d, ocr_pending: pending.get(d.id) || 0, folder: folders.get(d.id) || null })),
    folders: [...new Set(folders.values())].sort((a, b) => a.localeCompare(b)),
    limits: { ...(body.limits || {}), max_file_bytes: MAX_FILE },
    quota: { docs: u.docs, bytes: u.bytes, max_docs: MAX_DOCS, max_bytes: MAX_TOTAL } });
}

// POST /api/p/library/docs: the person's limits first, then 2.5's createDoc. Always an upload (never an import).
async function createRoute(request, env, ctx, params, url, user, session) {
  const body = await readJson(request, 10_000);
  // A one-time upload link from their Claude (exams.js) decides what the files are; the page may say for itself.
  const link = session && session.upload;
  if (link) {
    body.collection = KIND_COLLECTION[link.kind];
    if (link.title && (!body.title || /^(photos?|img|image)[\s_-]/i.test(String(body.title)))) body.title = link.title;
  } else if (body.collection != null && !COLLECTIONS.has(body.collection)) delete body.collection;
  const bytes = Number(body.bytes);
  if (Number.isInteger(bytes) && bytes > MAX_FILE) throw new HttpError(413, `That file is too big (${Math.round(MAX_FILE / 1048576)} MB at most).`);
  const u = await usage(env, user);
  if (u.docs >= MAX_DOCS) throw new HttpError(409, `Your library is full (${MAX_DOCS} files). Delete something first.`);
  if (Number.isInteger(bytes) && u.bytes + bytes > MAX_TOTAL) throw new HttpError(409, `Your library would go over ${Math.round(MAX_TOTAL / 1048576)} MB. Delete something first.`);
  await rateLimit(env, user, 'upload', UPLOAD_RATE, 'uploads');
  delete body.source;
  const res = await lib.createRoute(withBody(request, JSON.stringify(body)), env, ctx, params, url, user);
  if (link && res.status === 201) await countUpload(env, link);
  return res;
}

/**
 * A PDF the server already holds (exams.js library_add_link): the same limits as an upload, stored through 2.5's
 * multipart path, then read by the server reader (Workers AI toMarkdown, metered). Returns the document
 * ({duplicate: true} when the same file is already there). If the reader is unavailable the document waits as
 * 'uploaded' and the Library page reads it in the browser.
 */
export async function addPdf(env, user, { bytes, file_name, title, kind = 'other' }, ctx) {
  if (bytes.byteLength > MAX_FILE) throw new HttpError(413, `That file is too big (${Math.round(MAX_FILE / 1048576)} MB at most).`);
  const u = await usage(env, user);
  if (u.docs >= MAX_DOCS) throw new HttpError(409, `The library is full (${MAX_DOCS} files). Delete something first.`);
  if (u.bytes + bytes.byteLength > MAX_TOTAL) throw new HttpError(409, `The library would go over ${Math.round(MAX_TOTAL / 1048576)} MB. Delete something first.`);
  await rateLimit(env, user, 'upload', UPLOAD_RATE, 'uploads');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const r = await store.createDoc(env, user, { file_name, bytes: bytes.byteLength, sha256: sha, title, collection: KIND_COLLECTION[kind] || null });
  if (r.duplicate) return { ...store.docOut(r.doc), duplicate: true };
  const id = r.doc.id;
  for (let at = 0, n = 1; at < bytes.byteLength; at += store.PART_SIZE, n++) await store.putPart(env, user, id, n, bytes.slice(at, at + store.PART_SIZE).buffer);
  await store.completeUpload(env, user, id);
  if (env.AI && typeof env.AI.toMarkdown === 'function') {
    try {
      await meterFixed(env, user, { task: 'library_extract', usd: EXTRACT_USD });
      await lib.extractRoute(new Request('https://study-hub.invalid/extract', { method: 'POST' }), env, ctx, { id }, new URL('https://study-hub.invalid/'), user);
    } catch (e) { console.error('addPdf extract', e && e.message); }
  }
  return { ...store.docOut(await store.getDoc(env, user, id)), duplicate: false };
}

// PUT /api/p/library/docs/:id/parts/:n: the first part must open like a PDF (the browser makes one even for photos).
async function partRoute(request, env, ctx, params, url, user) {
  if (params.n !== '1') return lib.partRoute(request, env, ctx, params, url, user);
  const buf = await request.arrayBuffer();
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) {
    await store.deleteDoc(env, user, params.id).catch(() => {});
    throw new HttpError(400, 'That file is not a PDF. Photos are added with Add photos.');
  }
  return lib.partRoute(withBody(request, buf), env, ctx, params, url, user);
}

// GET /api/p/library/docs/:id/file: the person's own PDF, never run as a page.
async function fileRoute(request, env, ctx, params, url, user) {
  const res = await lib.fileRoute(request, env, ctx, params, url, user);
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return r;
}

// POST /api/p/library/docs/:id/extract: the server-side reader costs Workers AI time, so it is metered like the rest.
async function extractRoute(request, env, ctx, params, url, user) {
  await store.mustDoc(env, user, params.id);
  await meterFixed(env, user, { task: 'library_extract', usd: EXTRACT_USD });
  return lib.extractRoute(request, env, ctx, params, url, user);
}

// POST /api/p/library/run {ms?}: one burst of the background work (the page asks when a document seems stuck).
async function runRoute(request, env, ctx, params, url, user) {
  await rateLimit(env, user, 'library_run', RUN_RATE, 'requests to speed up indexing');
  return lib.runRoute(request, env, ctx, params, url, user);
}

// GET /api/p/library/search?q=&k=&full=1: 2.5's search, limited per hour (it embeds the question and reranks the answers).
async function searchRoute(request, env, ctx, params, url, user) {
  if (url.searchParams.get('q')) await rateLimit(env, user, 'library_search', SEARCH_RATE, 'searches');
  return lib.searchRoute(request, env, ctx, params, url, user);
}

// ------------------------------------------------------------------ folders (0108)
// Their own folders: a name on each document (none is "Not in a folder"). Moving and renaming are one undoable batch,
// from the Library page or their Claude (library_folders).
const FOLDER_MAX = 60;
const folderName = v => { const t = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FOLDER_MAX); return t || null; };
export async function fileDocs(env, user, b = {}, { actor = LEARNER, surface = 'web' } = {}) {
  let rows, target;
  if (b.rename) {
    const from = folderName(b.rename.from);
    target = folderName(b.rename.to);
    if (!from || !target) throw new HttpError(400, 'Say the folder and its new name.');
    rows = (await env.DB.prepare('SELECT id, title, folder FROM library_docs WHERE user_id = ? AND folder = ?').bind(user, from).all()).results || [];
    if (!rows.length) throw new HttpError(404, `There is no folder called ${from}.`);
  } else {
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(x => String(x || '').slice(0, 80)).filter(Boolean))];
    if (!ids.length || ids.length > 200) throw new HttpError(400, 'Say which documents to move (up to 200).');
    target = folderName(b.folder);
    rows = (await env.DB.prepare('SELECT id, title, folder FROM library_docs WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(ids)).all()).results || [];
    if (rows.length !== ids.length) throw new HttpError(404, 'Some of those are not in your library. library_read with no doc_id lists them.');
  }
  const moving = rows.filter(r => (r.folder || null) !== target);
  if (!moving.length) return { moved: 0, folder: target };
  // One row and one event per document (undo puts each row back from its own event).
  const w = await writeBatch(env, user, { actor, surface, via: 'platform:folders', undoable: true,
    rows: moving.map(r => ({ table: 'library_docs', op: 'update', key: { id: r.id }, before: { folder: r.folder || null }, after: { folder: target } })),
    events: moving.map(r => ({ kind: 'library.filed', target_type: 'library_docs', target_id: r.id, summary: summaryOf(`${r.title} moved to ${target || 'no folder'}`) })) });
  return { moved: moving.length, folder: target, batch_id: w.batch_id };
}

export const ROUTES = [
  ['POST', '/api/p/library/folders', gate(async (request, env, ctx, params, url, user) => json(await fileDocs(env, user, await readJson(request, 20_000))))],
  ['GET', '/api/p/library', gate(listRoute)],
  ['GET', '/api/p/library/status', gate(lib.statusRoute)],
  ['GET', '/api/p/library/search', gate(searchRoute)],
  ['POST', '/api/p/library/run', gate(runRoute)],
  ['POST', '/api/p/library/docs', gate(createRoute)],
  ['GET', '/api/p/library/docs/:id', gate(lib.docRoute)],
  ['DELETE', '/api/p/library/docs/:id', gate(lib.deleteRoute)],
  ['PUT', '/api/p/library/docs/:id/parts/:n', gate(partRoute)],
  ['POST', '/api/p/library/docs/:id/complete', gate(lib.completeRoute)],
  ['POST', '/api/p/library/docs/:id/pages', gate(lib.pagesRoute)],
  ['POST', '/api/p/library/docs/:id/extract', gate(extractRoute)],
  ['POST', '/api/p/library/docs/:id/reindex', gate(lib.reindexRoute)],
  ['GET', '/api/p/library/docs/:id/file', gate(fileRoute)],
  ['GET', '/api/p/library/doc/:id/page/:n', gate(lib.pageRoute)],
  ['GET', '/api/p/library/topic/:id', gate(lib.topicRoute)],
];

// ------------------------------------------------------------------ background work

/**
 * For platform/cron.js (hourly, minute 7). 2.5's minute dispatcher already runs libraryJob every fifth minute for
 * every active person (map/sync.js; users.js activeUsers lists the platform accounts when HUB_OFF), so this only
 * clears uploads that never finished and, when a document is waiting, runs one more step (no topic coverage).
 */
export async function retryExtraction(env, user) {
  let stale = 0;
  try {
    const old = (await env.DB.prepare("SELECT id FROM library_docs WHERE user_id = ?1 AND status = 'uploading' AND updated_at < ?2 LIMIT 20").bind(user, Date.now() - STALE_UPLOAD_MS).all()).results || [];
    for (const d of old) { await store.deleteDoc(env, user, d.id).catch(() => {}); stale++; }
    const waiting = await env.DB.prepare(`SELECT 1 AS x FROM library_docs WHERE user_id = ?1 AND status IN ('uploaded', 'extracting', 'indexing') LIMIT 1`).bind(user).first();
    if (!waiting) return stale ? { cleared: stale } : { skipped: 'nothing is waiting' };
  } catch (e) {
    if (store.noTable(e)) return { skipped: 'no library yet' };
    throw e;
  }
  return { cleared: stale, step: await libraryJob(env, user, { cover: false }) };
}

// ------------------------------------------------------------------ connector tools

const num = (v, d, min, max) => (Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : d);

/** library_search: 2.5's hybrid search, top SEARCH_TOP, each cited by title and page, text capped. */
export async function searchTool(env, user, args) {
  const q = String(args.query || '').trim();
  if (!q) throw new HttpError(400, 'Give a few words to look for.');
  await rateLimit(env, user, 'library_search', SEARCH_RATE, 'searches');
  const r = await searchLibrary(env, user, { q: q.slice(0, 200), k: SEARCH_TOP });
  const results = (r.results || []).slice(0, SEARCH_TOP).map(x => ({ doc_id: x.doc_id, title: x.title, page: x.page, page_to: x.page_to, cite: x.cite,
    heading: x.heading, text: cut(x.text, SNIPPET_MAX), score: x.score }));
  return { query: q, results, note: results.length
    ? 'Cite the title and page. Use library_read with doc_id and page to read on.'
    : 'Nothing in the library matches. Try other words, or the library may be empty or still being read.' };
}

/**
 * library_read: pages of one document from `page` (default 1), at most READ_MAX characters, with `next` ({page,
 * offset}) to carry on. Without doc_id: the list of documents.
 */
export async function readTool(env, user, args) {
  const id = String(args.doc_id || '').trim();
  if (!id) {
    const docs = await store.listDocs(env, user);
    const folders = new Map(((await env.DB.prepare('SELECT id, folder FROM library_docs WHERE user_id = ? AND folder IS NOT NULL').bind(user).all()).results || []).map(r => [r.id, r.folder]));
    return { docs: docs.map(d => ({ doc_id: d.id, title: d.title, pages: d.page_count, status: d.status, ...(d.collection ? { kind: d.collection } : {}), ...(folders.get(d.id) ? { folder: folders.get(d.id) } : {}) })), note: 'Give doc_id (and page) to read one. kind exam-paper or mark-scheme: exam_make turns an exam paper into an exam they sit on screen.' };
  }
  const d = await store.getDoc(env, user, id);
  if (!d) throw new HttpError(404, 'That document is not in this library.');
  const page = num(args.page, 1, 1, store.MAX_PAGES);
  const offset = num(args.offset, 0, 0, 1_000_000);
  const head = { doc_id: d.id, title: d.title, status: d.status, page_count: d.page_count };
  if (['uploading', 'uploaded', 'refused'].includes(d.status) || (d.status === 'extracting' && !d.n_pages_text)) {
    return { ...head, text: null, next: null, note: d.status === 'refused' ? d.status_note || 'This file was not added.' : 'This file is still being read. Try again in a few minutes.' };
  }
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [first, rest] = await env.DB.batch([
    P('SELECT n, kind, length(text) AS len, substr(text, ?3, ?4) AS text FROM library_pages WHERE user_id = ?1 AND doc_id = ?2 AND n = ?5', user, d.id, offset + 1, READ_MAX, page),
    P('SELECT n, kind, length(text) AS len, substr(text, 1, ?4) AS text FROM library_pages WHERE user_id = ?1 AND doc_id = ?2 AND n > ?3 ORDER BY n LIMIT 40', user, d.id, page, READ_MAX),
  ]);
  const rows = [...(first.results || []).map(r => ({ ...r, start: offset })), ...(rest.results || []).map(r => ({ ...r, start: 0 }))];
  if (!rows.length) return { ...head, text: null, next: null, note: d.page_count && page > d.page_count ? `The document has ${d.page_count} pages.` : 'There is no text at that page.' };
  let text = '', used = 0, next = null, last = page;
  for (const r of rows) {
    const label = `[page ${r.n}]`;
    const body = r.text && r.text.trim() ? r.text : r.kind === 'image' ? '(a picture; its text has not been read)' : '(no text)';
    const piece = `${text ? '\n\n' : ''}${label}\n${body}`;
    const room = READ_MAX - used;
    if (room < label.length + 8) { next = { page: r.n, offset: r.start }; break; }
    if (piece.length > room) {
      const got = Math.max(0, room - (piece.length - body.length));
      text += piece.slice(0, piece.length - body.length + got);
      next = { page: r.n, offset: r.start + got };
      last = r.n;
      break;
    }
    text += piece; used += piece.length; last = r.n;
    if (r.start + (r.text || '').length < r.len) { next = { page: r.n, offset: r.start + r.text.length }; break; }
  }
  if (!next) {
    const more = (rest.results || []).length >= 40 || (d.page_count && last < d.page_count);
    if (more) next = { page: last + 1, offset: 0 };
  }
  return { ...head, from: { page, offset }, text, next, note: next ? 'Call library_read again with page and offset from next to carry on.' : 'End of the document.' };
}

export const TOOLS = [
  {
    name: 'library_search',
    module: 'library',
    description: "Searches the user's own library (their uploaded PDFs and photos of notes, mark schemes and past papers) by meaning and by words, "
      + `and returns the best ${SEARCH_TOP} passages, each with the document, page and heading to cite. Use library_read with doc_id and page to read on.`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words or a question to look for.' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: (env, user, args) => searchTool(env, user, args || {}),
  },
  {
    name: 'library_read',
    module: 'library',
    description: "Reads pages of one document in the user's library by page number, at most 12,000 characters a call; the answer says where to carry on (next). "
      + 'Without doc_id it lists the documents.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'The document (from library_search or the list).' },
        page: { type: 'integer', minimum: 1, description: 'The page to start at (default 1).' },
        offset: { type: 'integer', minimum: 0, description: 'Characters to skip on the first page (from next, for a very long page).' },
        ink: { type: 'boolean', description: 'Pictures of the pages they wrote on (from page).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: (env, user, args) => (args && args.ink ? inkTool(env, user, args) : readTool(env, user, args || {})),
  },
  {
    name: 'library_folders',
    module: 'library',
    description: 'Files their library documents into folders: move {ids, folder} (folder null: no folder), or rename {from, to}. library_read without doc_id lists documents with their folders. One undoable change.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      ids: { type: 'array', items: { type: 'string' } }, folder: { type: ['string', 'null'] },
      rename: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (env, user, args) => fileDocs(env, user, args || {}, { actor: 'claude', surface: 'chat' }),
  },
];

const b64 = bytes => { let x = ''; for (let i = 0; i < bytes.length; i += 0x8000) x += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(x); };
/** library_read with ink: the pages they wrote on (a class sheet, notes) as pictures, for their Claude to check. */
async function inkTool(env, user, args) {
  const d = await store.getDoc(env, user, String(args.doc_id || ''));
  if (!d) throw new HttpError(404, 'That document is not in this library.');
  const { docInkPictures } = await import('./ink.js');
  const r = await docInkPictures(env, user, d, num(args.page, 1, 1, store.MAX_PAGES + 10));
  const head = { doc_id: d.id, title: d.title, written_pages: r.written,
    note: r.written.length ? 'Their writing on the page. Check it with them; marks or scores go on their map with log_results.' : 'They have not written on this document yet.' };
  const content = [{ type: 'text', text: JSON.stringify(head) }];
  for (const p of r.pictures) content.push({ type: 'text', text: `Page ${p.page}` }, { type: 'image', data: b64(p.data), mimeType: 'image/jpeg' });
  return { __mcp: { content, structuredContent: head } };
}

// ------------------------------------------------------------------ self-check

const files = n => `${n} library file${n === 1 ? '' : 's'}`;

export const CHECKS = [
  async (env, user) => {
    const u = await env.DB.prepare('SELECT profile, prefs_json FROM users WHERE id = ?').bind(user).first();
    if (!modulesFor(u && u.profile, safeParse(u && u.prefs_json, {}), env).library) return [];
    const out = [];
    if (!env.LIBRARY || typeof env.LIBRARY.put !== 'function') {
      return [{ id: 'library_storage', ok: false, level: 'warn', says: 'Library: file uploads are not set up on this hub yet.', fix: 'Tell Mo.' }];
    }
    const [byStatus, ocr, totals] = await env.DB.batch([
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM library_docs WHERE user_id = ?1 GROUP BY status').bind(user),
      env.DB.prepare("SELECT ocr_state, COUNT(*) AS n FROM library_pages WHERE user_id = ?1 AND ocr_state IN ('pending', 'skipped', 'failed') GROUP BY ocr_state").bind(user),
      env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(page_count), 0) AS pages FROM library_docs WHERE user_id = ?1 AND status IN ('ready', 'indexing')").bind(user),
    ]);
    const c = Object.fromEntries((byStatus.results || []).map(r => [r.status, r.n]));
    const p = Object.fromEntries((ocr.results || []).map(r => [r.ocr_state, r.n]));
    const reading = (c.uploaded || 0) + (c.extracting || 0) + (c.indexing || 0);
    if (c.failed) out.push({ id: 'library_failed', ok: false, level: 'warn', says: `Library: ${files(c.failed)} could not be read, so Claude cannot search ${c.failed === 1 ? 'it' : 'them'}.`,
      fix: 'Open the Library, tap the file and choose Read again, or add it again.' });
    if (c.uploading) out.push({ id: 'library_uploading', ok: true, level: 'info', says: `Library: ${files(c.uploading)} did not finish uploading.`, fix: 'Add the file again.' });
    if (reading) out.push({ id: 'library_indexing', ok: true, level: 'info', says: `Library: ${files(reading)} still being read and indexed.`, fix: 'This takes a few minutes.' });
    // Pages over the day's reading limit wait as pending and are read the next day (2.5's AUD-019), so they are not lost.
    if (p.pending) out.push({ id: 'library_pictures', ok: true, level: 'info', says: `Library: ${p.pending} picture${p.pending === 1 ? '' : 's'} waiting to be read into text.`, fix: 'This takes a few minutes; past the daily limit, the rest are read the next day.' });
    const lost = (p.skipped || 0) + (p.failed || 0);
    if (lost) out.push({ id: 'library_pictures_lost', ok: false, level: 'warn', says: `Library: ${lost} picture${lost === 1 ? '' : 's'} could not be read into text (there is a daily limit).`,
      fix: 'Tap the file and choose Read again tomorrow.' });
    if (c.refused) out.push({ id: 'library_refused', ok: true, level: 'info', says: `Library: ${files(c.refused)} not added because ${c.refused === 1 ? 'it looks' : 'they look'} like question-bank material.` });
    if (!out.length) {
      const t = (totals.results || [])[0] || { n: 0, bytes: 0, pages: 0 };
      out.push({ id: 'library', ok: true, level: 'ok', says: t.n
        ? `Library: ${files(t.n)}, ${t.pages} page${t.pages === 1 ? '' : 's'}, ${(t.bytes / 1048576).toFixed(1)} MB of ${MAX_TOTAL / 1048576} MB used.`
        : 'Library: empty. Add a PDF or photos of your notes and Claude can search them.' });
    }
    return out;
  },
];
