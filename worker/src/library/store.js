// The Library's storage: documents, their R2 objects, pages, passages, the FTS index and the harvested terms.
// Every query is scoped by user_id and every R2 key starts with u/<user>/, so one user's files are never seen by
// another (tests/worker/library.test.mjs checks both). The original PDF is kept as uploaded (R2 multipart, parts of
// PART_SIZE); the extracted pages are kept beside it as JSON (raw/<first>.json), so a re-index never needs the
// browser again.
import { HttpError } from '../util.js';
import { chunkDocument, questionBankVerdict, CHUNKER_VERSION, cut } from './text.js';
import { vectorizeDelete, EMBED_MODEL } from './vectors.js';

export const PART_SIZE = 8 * 1024 * 1024;          // R2 multipart parts (5 MiB is R2's minimum but for the last)
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const MAX_PAGES = 3000;
export const PAGES_PER_CALL = 40;
export const TITLE_MAX = 160;
export const JSON_CHUNK_CHARS = 180_000;           // characters of JSON per bound parameter (D1 rows stay well inside 2 MB)

export const noTable = e => /no such table|no such column|no such module/i.test(String(e && e.message));
export const keyFor = (user, docId, part = 'file.pdf') => `u/${user}/${docId}/${part}`;
export const newDocId = () => 'd' + crypto.randomUUID().replace(/-/g, '').slice(0, 15);
// A page whose OCR failed keeps its tries in sync_state (fails = tries so far, next_at = the next try, last_error),
// one row per page under this prefix; clearIndex drops them, so "Index again" starts every page afresh.
export const OCR_PAGE_SOURCE = 'library.ocrpage:';
export const ocrPageSource = (docId, n) => `${OCR_PAGE_SOURCE}${docId}:${n}`;

export function bucket(env) {
  if (!env.LIBRARY || typeof env.LIBRARY.put !== 'function') throw new HttpError(503, 'The Library\'s file store (R2 bucket practice-hub-library) is not set up on this hub yet.');
  return env.LIBRARY;
}

const DOC_COLS = `id, title, file_name, collection, source, sha256, bytes, page_count, status, status_note, extractor, pages_in, n_pages_text, n_ocr,
  n_passages, n_embedded, n_linked, chunker_version, embed_model, created_at, updated_at, indexed_at,
  (SELECT count(*) FROM library_pages g WHERE g.user_id = library_docs.user_id AND g.doc_id = library_docs.id AND g.ocr_state IN ('failed', 'skipped')) AS pages_unread`;

/** The document row the API shows (never the R2 key or upload id). */
export function docOut(d) {
  if (!d) return null;
  const { r2_key, upload_id, parts_json, user_id, ...rest } = d;
  const ready = rest.status === 'ready';
  return { ...rest, progress: rest.status === 'indexing' || ready ? { passages: rest.n_passages, embedded: rest.n_embedded, linked: rest.n_linked,
    pct: rest.n_passages ? Math.round((100 * (rest.n_embedded + rest.n_linked)) / (2 * rest.n_passages)) : 0 } : null };
}

export async function getDoc(env, user, id, { all = false } = {}) {
  return env.DB.prepare(`SELECT ${all ? '*' : DOC_COLS} FROM library_docs WHERE user_id = ?1 AND id = ?2`).bind(user, id).first();
}
export async function mustDoc(env, user, id, opts) {
  const d = await getDoc(env, user, id, opts);
  if (!d) throw new HttpError(404, 'That document is not in your library.');
  return d;
}

export async function listDocs(env, user) {
  return (await env.DB.prepare(`SELECT ${DOC_COLS} FROM library_docs WHERE user_id = ?1 ORDER BY collection IS NULL, collection, title`).bind(user).all()).results || [];
}

const cleanTitle = s => String(s || '').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

/**
 * A new document and its R2 multipart upload. body: {file_name, title?, bytes, sha256?, collection?, source?}.
 * The same sha256 again answers the existing document ({duplicate: true}).
 */
export async function createDoc(env, user, body, now = Date.now()) {
  const file = String(body.file_name || '').trim();
  if (!file || file.length > 200) throw new HttpError(400, 'file_name is the PDF\'s name (at most 200 characters).');
  if (!/\.pdf$/i.test(file)) throw new HttpError(400, 'The Library takes PDF files.');
  const bytes = Number(body.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) throw new HttpError(400, 'bytes is the file size.');
  if (bytes > MAX_FILE_BYTES) throw new HttpError(413, `That file is larger than ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`);
  const sha = body.sha256 == null ? null : String(body.sha256).toLowerCase();
  if (sha != null && !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'sha256 is the file\'s SHA-256 in hex.');
  const collection = body.collection == null ? null : String(body.collection).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || null;
  if (sha) {
    const dup = await env.DB.prepare(`SELECT ${DOC_COLS} FROM library_docs WHERE user_id = ?1 AND sha256 = ?2`).bind(user, sha).first();
    if (dup && dup.status !== 'failed' && dup.status !== 'uploading') return { duplicate: true, doc: dup };
    if (dup) await deleteDoc(env, user, dup.id);
  }
  const id = newDocId();
  const r2 = bucket(env);
  const key = keyFor(user, id);
  const mp = await r2.createMultipartUpload(key, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { user, doc: id } });
  const title = cleanTitle(body.title || file);
  await env.DB.prepare(`INSERT INTO library_docs (user_id, id, title, file_name, collection, source, sha256, bytes, r2_key, upload_id, parts_json, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 'uploading', ?11, ?11)`)
    .bind(user, id, title, file.slice(0, 200), collection, body.source === 'import' ? 'import' : 'upload', sha, bytes, key, mp.uploadId, now).run();
  return { duplicate: false, doc: await getDoc(env, user, id), upload: { part_size: PART_SIZE, parts: Math.max(1, Math.ceil(bytes / PART_SIZE)) } };
}

/** One part of the upload (1-based). Returns {part, etag}. */
export async function putPart(env, user, id, n, data) {
  const d = await mustDoc(env, user, id, { all: true });
  if (d.status !== 'uploading' || !d.upload_id) throw new HttpError(409, 'That document is not waiting for its file.');
  const parts = Math.max(1, Math.ceil(d.bytes / PART_SIZE));
  if (!Number.isInteger(n) || n < 1 || n > parts) throw new HttpError(400, `part is 1 to ${parts}.`);
  const want = n < parts ? PART_SIZE : d.bytes - PART_SIZE * (parts - 1);
  if (data.byteLength !== want) throw new HttpError(400, `Part ${n} should be ${want} bytes, not ${data.byteLength}.`);
  const up = bucket(env).resumeMultipartUpload(d.r2_key, d.upload_id);
  const p = await up.uploadPart(n, data);
  // Parts can arrive side by side: the list is merged in SQLite, one part at a time.
  await env.DB.prepare(`UPDATE library_docs SET parts_json = (SELECT json_group_array(json(v)) FROM (
      SELECT value AS v FROM json_each(library_docs.parts_json) WHERE json_extract(value, '$.n') != ?3 UNION ALL SELECT ?4)), updated_at = ?5
    WHERE user_id = ?1 AND id = ?2`).bind(user, id, n, JSON.stringify({ n, etag: p.etag }), Date.now()).run();
  return { part: n, etag: p.etag };
}

/** Finishes the upload: the parts are joined in R2 and the document waits for its pages. */
export async function completeUpload(env, user, id, now = Date.now()) {
  const d = await mustDoc(env, user, id, { all: true });
  if (d.status !== 'uploading') return d;
  const parts = JSON.parse(d.parts_json || '[]').map(p => (typeof p === 'string' ? JSON.parse(p) : p)).sort((a, b) => a.n - b.n);
  const need = Math.max(1, Math.ceil(d.bytes / PART_SIZE));
  const missing = [];
  for (let n = 1; n <= need; n++) if (!parts.some(p => p.n === n)) missing.push(n);
  if (missing.length) throw new HttpError(409, `Parts ${missing.slice(0, 10).join(', ')} have not arrived yet.`);
  await bucket(env).resumeMultipartUpload(d.r2_key, d.upload_id).complete(parts.map(p => ({ partNumber: p.n, etag: p.etag })));
  await env.DB.prepare(`UPDATE library_docs SET status = 'uploaded', upload_id = NULL, parts_json = '[]', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(user, id, now).run();
  return getDoc(env, user, id);
}

// ------------------------------------------------------------------ pages

const PAGE_LINE_KEYS = ['t', 's', 'b', 'x', 'y'];
/** A page from the browser or the import script, checked and trimmed: {n, lines|text, images, image?}. */
export function cleanPage(p, pageCount) {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'Each page is an object.');
  const n = Number(p.n);
  if (!Number.isInteger(n) || n < 1 || n > Math.min(MAX_PAGES, pageCount || MAX_PAGES)) throw new HttpError(400, `Page numbers run from 1 to ${pageCount || MAX_PAGES}.`);
  const out = { n, images: Math.max(0, Math.min(500, Number(p.images) || 0)) };
  if (Array.isArray(p.lines)) {
    if (p.lines.length > 3000) throw new HttpError(400, `Page ${n} has too many lines.`);
    out.lines = p.lines.filter(l => l && typeof l.t === 'string').map(l => Object.fromEntries(PAGE_LINE_KEYS.filter(k => l[k] != null)
      .map(k => [k, k === 't' ? String(l.t).slice(0, 4000) : k === 'b' ? (l.b ? 1 : 0) : Math.round(Number(l[k]) * 10) / 10])));
  } else out.text = String(p.text || '').slice(0, 60_000);
  if (typeof p.image === 'string' && p.image.length) {
    if (p.image.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/.test(p.image.slice(0, 200))) throw new HttpError(400, `Page ${n}'s image is too large or not base64 JPEG.`);
    out.image = p.image;
  }
  return out;
}

/**
 * Pages arrive in calls of up to PAGES_PER_CALL. Each call is checked for question-bank material straight away
 * (a refusal deletes the file), kept in R2 as raw/<first>.json, and counted; page images for OCR go to
 * ocr/<n>.jpg. Returns {pages_in, page_count, complete, refused?, reason?}.
 */
export async function savePages(env, user, id, body, now = Date.now()) {
  const d = await mustDoc(env, user, id, { all: true });
  if (d.status === 'refused') return { refused: true, reason: d.status_note };
  if (!['uploaded', 'extracting', 'ready', 'indexing', 'failed'].includes(d.status)) throw new HttpError(409, 'Upload the file first, then its pages.');
  const pageCount = Number(body.page_count ?? d.page_count);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) throw new HttpError(400, `page_count is 1 to ${MAX_PAGES}.`);
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > PAGES_PER_CALL) throw new HttpError(400, `pages is a list of 1 to ${PAGES_PER_CALL} pages.`);
  const pages = body.pages.map(p => cleanPage(p, pageCount));
  const verdict = questionBankVerdict(pages);
  if (verdict.refuse) { await refuseDoc(env, user, d, verdict.reason, now); return { refused: true, reason: verdict.reason }; }
  const r2 = bucket(env);
  const first = Math.min(...pages.map(p => p.n));
  const images = pages.filter(p => p.image);
  await r2.put(keyFor(user, id, `raw/${String(first).padStart(5, '0')}.json`), JSON.stringify(pages.map(({ image, ...p }) => ({ ...p, has_image: !!image }))),
    { httpMetadata: { contentType: 'application/json' }, customMetadata: { pages: String(pages.length) } });
  for (const p of images) await r2.put(keyFor(user, id, `ocr/${p.n}.jpg`), b64ToBytes(p.image), { httpMetadata: { contentType: 'image/jpeg' } });
  const list = await r2.list({ prefix: keyFor(user, id, 'raw/'), include: ['customMetadata'] });
  const stored = await countRawPages(r2, list.objects || []);
  await env.DB.prepare(`UPDATE library_docs SET page_count = ?3, pages_in = ?4, extractor = coalesce(?5, extractor), status = CASE WHEN status = 'uploaded' THEN 'extracting' ELSE status END,
      updated_at = ?6 WHERE user_id = ?1 AND id = ?2`).bind(user, id, pageCount, stored, body.extractor ? String(body.extractor).slice(0, 30) : null, now).run();
  return { pages_in: stored, page_count: pageCount, complete: stored >= pageCount };
}

// Each raw object carries its page count in its custom metadata (read back only when a store leaves it out).
async function countRawPages(r2, objects) {
  let n = 0;
  for (const o of objects) {
    const meta = o.customMetadata && o.customMetadata.pages;
    if (meta) { n += Number(meta); continue; }
    const body = await r2.get(o.key);
    const pages = body ? JSON.parse(await body.text()) : [];
    n += pages.length;
  }
  return n;
}

export async function rawPages(env, user, id) {
  const r2 = bucket(env);
  const list = await r2.list({ prefix: keyFor(user, id, 'raw/') });
  const byN = new Map();
  for (const o of (list.objects || []).sort((a, b) => a.key.localeCompare(b.key))) {
    const obj = await r2.get(o.key);
    if (!obj) continue;
    for (const p of JSON.parse(await obj.text())) byN.set(p.n, p);
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deletePrefix(env, user, id) {
  if (!env.LIBRARY || typeof env.LIBRARY.list !== 'function') return;
  const r2 = env.LIBRARY;
  let cursor;
  do {
    const l = await r2.list({ prefix: `u/${user}/${id}/`, cursor });
    const keys = (l.objects || []).map(o => o.key);
    if (keys.length) await r2.delete(keys);
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
}

/** Question-bank material: the file and its pages are deleted at once; only the row and the reason stay. */
export async function refuseDoc(env, user, d, reason, now = Date.now()) {
  if (d.upload_id && env.LIBRARY) { try { await env.LIBRARY.resumeMultipartUpload(d.r2_key, d.upload_id).abort(); } catch { /* none */ } }
  await deletePrefix(env, user, d.id);
  await clearIndex(env, user, d.id);
  await env.DB.prepare(`UPDATE library_docs SET status = 'refused', status_note = ?3, r2_key = NULL, upload_id = NULL, n_passages = 0, n_embedded = 0, n_linked = 0,
      updated_at = ?4 WHERE user_id = ?1 AND id = ?2`).bind(user, d.id, cut(reason, 500), now).run();
}

// ------------------------------------------------------------------ the index

const chunks = (list, maxChars, size = x => JSON.stringify(x).length) => {
  const out = [];
  let cur = [], n = 0;
  for (const x of list) {
    const s = size(x);
    if (cur.length && n + s > maxChars) { out.push(cur); cur = []; n = 0; }
    cur.push(x); n += s;
  }
  if (cur.length) out.push(cur);
  return out;
};

/** Removes a document's passages, FTS rows, links, pages, OCR tries and vectors (not the document row or its files). */
export async function clearIndex(env, user, id) {
  const pids = ((await env.DB.prepare(`SELECT pid FROM library_passages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, id).all()).results || []).map(r => r.pid);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO library_fts (library_fts, rowid, heading, text) SELECT 'delete', pid, heading, text FROM library_passages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, id),
    env.DB.prepare(`DELETE FROM library_links WHERE user_id = ?1 AND pid IN (SELECT pid FROM library_passages WHERE user_id = ?1 AND doc_id = ?2)`).bind(user, id),
    env.DB.prepare(`DELETE FROM library_passages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, id),
    env.DB.prepare(`DELETE FROM library_pages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, id),
    env.DB.prepare(`DELETE FROM sync_state WHERE user_id = ?1 AND substr(source, 1, length(?2)) = ?2`).bind(user, `${OCR_PAGE_SOURCE}${id}:`),
  ]);
  if (pids.length) await vectorizeDelete(env, pids);
  return pids.length;
}

/**
 * Chunks a document whose pages are all in and writes its index: pages, passages, the FTS rows and the terms, in
 * batches. Passages then wait for the minute job (embedding, topic links). Returns {passages, pages, refused?}.
 */
export async function indexDocument(env, user, id, { now = Date.now(), pages: given = null } = {}) {
  const d = await mustDoc(env, user, id);
  if (d.status === 'refused') return { refused: true, reason: d.status_note };
  const pages = given || await rawPages(env, user, id);
  if (!pages.length) throw new HttpError(409, 'No pages have arrived for that document yet.');
  const verdict = questionBankVerdict(pages);
  if (verdict.refuse) { await refuseDoc(env, user, await mustDoc(env, user, id, { all: true }), verdict.reason, now); return { refused: true, reason: verdict.reason }; }
  const { pages: outPages, passages, terms } = chunkDocument(pages);
  await clearIndex(env, user, id);
  const stmts = [];
  const pageRows = outPages.map(p => ({ n: p.n, text: p.text, chars: p.chars, kind: p.kind,
    ocr: p.kind === 'image' && pages.find(x => x.n === p.n && x.has_image) ? 'pending' : 'none' }));
  for (const part of chunks(pageRows, JSON_CHUNK_CHARS)) {
    stmts.push(env.DB.prepare(`INSERT INTO library_pages (user_id, doc_id, n, text, chars, kind, ocr_state)
      SELECT ?1, ?2, json_extract(j.value, '$.n'), json_extract(j.value, '$.text'), json_extract(j.value, '$.chars'), json_extract(j.value, '$.kind'),
        json_extract(j.value, '$.ocr') FROM json_each(?3) j WHERE true
      ON CONFLICT (user_id, doc_id, n) DO UPDATE SET text = excluded.text, chars = excluded.chars, kind = excluded.kind, ocr_state = excluded.ocr_state`)
      .bind(user, id, JSON.stringify(part)));
  }
  for (const part of chunks(passages, JSON_CHUNK_CHARS)) {
    stmts.push(env.DB.prepare(`INSERT INTO library_passages (user_id, doc_id, seq, page, page_to, heading, kind, text, char_start, char_end, tokens, vec_state, linked, created_at)
      SELECT ?1, ?2, json_extract(j.value, '$.seq'), json_extract(j.value, '$.page'), json_extract(j.value, '$.page_to'), json_extract(j.value, '$.heading'),
        json_extract(j.value, '$.kind'), json_extract(j.value, '$.text'), json_extract(j.value, '$.char_start'), json_extract(j.value, '$.char_end'),
        json_extract(j.value, '$.tokens'), 0, 0, ?3 FROM json_each(?4) j WHERE true`).bind(user, id, now, JSON.stringify(part)));
  }
  stmts.push(env.DB.prepare(`INSERT INTO library_fts (rowid, heading, text) SELECT pid, coalesce(heading, ''), text FROM library_passages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, id));
  for (const part of chunks(terms.map(t => ({ k: t.abbr.toLowerCase(), a: t.abbr, l: t.long.slice(0, 120), n: t.n })), JSON_CHUNK_CHARS)) {
    stmts.push(env.DB.prepare(`INSERT INTO library_terms (user_id, abbr_key, abbr, long, n)
      SELECT ?1, json_extract(j.value, '$.k'), json_extract(j.value, '$.a'), json_extract(j.value, '$.l'), json_extract(j.value, '$.n') FROM json_each(?2) j WHERE true
      ON CONFLICT (user_id, abbr_key, long) DO UPDATE SET n = library_terms.n + excluded.n`).bind(user, JSON.stringify(part)));
  }
  const textPages = outPages.filter(p => p.kind === 'text' || p.kind === 'ocr').length;
  stmts.push(env.DB.prepare(`UPDATE library_docs SET status = ?3, status_note = NULL, n_pages_text = ?4, n_ocr = ?5, n_passages = ?6, n_embedded = 0, n_linked = 0,
      chunker_version = ?7, embed_model = ?8, page_count = coalesce(page_count, ?9), indexed_at = ?10, updated_at = ?10 WHERE user_id = ?1 AND id = ?2`)
    // A page still waiting for OCR keeps the document indexing (finishDocs marks it ready once every page is read).
    .bind(user, id, passages.length || pageRows.some(p => p.ocr === 'pending') ? 'indexing' : 'ready', textPages, outPages.filter(p => p.kind === 'ocr').length, passages.length, CHUNKER_VERSION, EMBED_MODEL,
      pages.length, now));
  for (let k = 0; k < stmts.length; k += 25) await env.DB.batch(stmts.slice(k, k + 25));
  return { passages: passages.length, pages: outPages.length, terms: terms.length, empty_pages: outPages.filter(p => p.kind === 'empty' || p.kind === 'image').map(p => p.n) };
}

/** Deletes a document everywhere: its files in R2, its vectors, its index and its row. */
export async function deleteDoc(env, user, id) {
  const d = await mustDoc(env, user, id, { all: true });
  if (d.upload_id && env.LIBRARY) { try { await env.LIBRARY.resumeMultipartUpload(d.r2_key, d.upload_id).abort(); } catch { /* none */ } }
  await deletePrefix(env, user, id);
  const n = await clearIndex(env, user, id);
  await env.DB.prepare(`DELETE FROM library_docs WHERE user_id = ?1 AND id = ?2`).bind(user, id).run();
  return { deleted: true, passages: n };
}
