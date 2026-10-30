// The Library's HTTP API (behind the hub key, like every /api route). The contract the Library page wires to is
// docs/map-research/requests/LIBRARY.md. Handlers take (request, env, ctx, params, url, user) like every registry route.
import { json, readJson, HttpError, londonDay } from '../util.js';
import * as store from './store.js';
import { searchLibrary, topicCoverage, DEFAULT_K, MAX_K } from './search.js';
import { libraryRun, libraryJob, OCR_DAILY } from './jobs.js';
import { vectorizeOn, EMBED_MODEL, RERANK_MODEL } from './vectors.js';
import { objectivesFor, isQid, MAX_IDS } from './objectives.js';

const wait = (ctx, p) => {
  const safe = Promise.resolve(p).catch(e => console.error('library background step failed', (e && e.stack) || e));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
  return safe;
};
const intParam = (s, name, min, max) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} is a whole number from ${min} to ${max}.`);
  return n;
};
const notReady = e => {
  if (store.noTable(e)) throw new HttpError(503, 'The Library arrives with the next hub update (migration 0018).');
  throw e;
};

// GET /api/library -> {docs, totals, vectors, models}
export async function listRoute(request, env, ctx, params, url, user) {
  try {
    const docs = await store.listDocs(env, user);
    const totals = docs.reduce((t, d) => ({ docs: t.docs + 1, ready: t.ready + (d.status === 'ready'), pages: t.pages + (d.page_count || 0),
      passages: t.passages + (d.n_passages || 0), embedded: t.embedded + (d.n_embedded || 0), bytes: t.bytes + (d.bytes || 0), unread: t.unread + (d.pages_unread || 0) }),
    { docs: 0, ready: 0, pages: 0, passages: 0, embedded: 0, bytes: 0, unread: 0 });
    return json({ docs: docs.map(store.docOut), totals, vectors: vectorizeOn(env) ? 'vectorize' : 'd1', models: { embed: EMBED_MODEL, rerank: RERANK_MODEL },
      limits: { part_size: store.PART_SIZE, max_file_bytes: store.MAX_FILE_BYTES, pages_per_call: store.PAGES_PER_CALL } });
  } catch (e) { return notReady(e); }
}

// POST /api/library/docs {file_name, bytes, sha256?, title?, collection?, source?} -> {doc, upload: {part_size, parts}} | {duplicate, doc}
export async function createRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  try {
    const r = await store.createDoc(env, user, body);
    return json({ ...r, doc: store.docOut(r.doc) }, r.duplicate ? 200 : 201);
  } catch (e) { return notReady(e); }
}

// PUT /api/library/docs/:id/parts/:n (the bytes) -> {part, etag}
export async function partRoute(request, env, ctx, params, url, user) {
  const n = intParam(params.n, 'part', 1, 10_000);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > store.PART_SIZE + 1024) throw new HttpError(413, `A part is at most ${store.PART_SIZE} bytes.`);
  const data = await request.arrayBuffer();
  return json(await store.putPart(env, user, params.id, n, data));
}

// POST /api/library/docs/:id/complete -> {doc}
export async function completeRoute(request, env, ctx, params, url, user) {
  return json({ doc: store.docOut(await store.completeUpload(env, user, params.id)) });
}

// POST /api/library/docs/:id/pages {page_count, pages: [{n, lines|text, images?, image?}], extractor?}
//   -> {pages_in, page_count, complete, status} | {refused: true, reason} (422)
export async function pagesRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 12_000_000);
  const r = await store.savePages(env, user, params.id, body);
  if (r.refused) return json({ refused: true, reason: r.reason }, 422);
  if (r.complete) {
    // All pages are in: index, then embed and link for as long as the request may run on (the minute job
    // indexes it instead if this never finishes).
    const indexed = store.indexDocument(env, user, params.id);
    wait(ctx, indexed.then(ix => (ix.refused ? null : libraryRun(env, user, { ms: 22_000, cover: false }))));
    if (url.searchParams.get('wait') === '1') {
      const ix = await indexed;
      if (ix.refused) return json({ refused: true, reason: ix.reason }, 422);
      return json({ ...r, status: (await store.getDoc(env, user, params.id)).status, index: ix });
    }
  }
  const d = await store.getDoc(env, user, params.id);
  return json({ ...r, status: d.status });
}

// POST /api/library/docs/:id/extract: the server path for a PDF the browser could not read (Workers AI toMarkdown).
export async function extractRoute(request, env, ctx, params, url, user) {
  const d = await store.mustDoc(env, user, params.id, { all: true });
  if (!['uploaded', 'extracting', 'failed'].includes(d.status)) throw new HttpError(409, 'That document is already indexed; re-index it instead.');
  if (!env.AI || typeof env.AI.toMarkdown !== 'function') throw new HttpError(503, 'The server-side reader (Workers AI toMarkdown) is not available here; upload from the Library page instead.');
  const obj = await store.bucket(env).get(d.r2_key);
  if (!obj) throw new HttpError(404, 'The file is not in the store.');
  const blob = new Blob([await obj.arrayBuffer()], { type: 'application/pdf' });
  const out = await env.AI.toMarkdown([{ name: d.file_name || 'file.pdf', blob }]);
  const md = String((Array.isArray(out) ? out[0] : out)?.data || '');
  // toMarkdown has no page breaks it promises: a form feed or "Page N" marker splits pages when present, else the
  // text is cut into page-sized parts (citations then say "part", as page_count is unknown).
  let parts = md.split(/\f|\n(?=#{0,3}\s*Page\s+\d+\b)/i).filter(s => s.trim());
  if (parts.length <= 1) { parts = []; for (let k = 0; k < md.length; k += 3500) parts.push(md.slice(k, k + 3500)); }
  const pages = parts.slice(0, store.MAX_PAGES).map((text, i) => ({ n: i + 1, text }));
  for (let k = 0; k < pages.length; k += store.PAGES_PER_CALL) {
    const r = await store.savePages(env, user, d.id, { page_count: pages.length, pages: pages.slice(k, k + store.PAGES_PER_CALL), extractor: 'tomarkdown' });
    if (r.refused) return json({ refused: true, reason: r.reason }, 422);
  }
  wait(ctx, (async () => { await store.indexDocument(env, user, d.id); await libraryRun(env, user, { ms: 20_000, cover: false }); })());
  return json({ ok: true, pages: pages.length, status: 'indexing' }, 202);
}

// POST /api/library/docs/:id/reindex: re-chunk from the stored pages, then embed and link again.
export async function reindexRoute(request, env, ctx, params, url, user) {
  const d = await store.mustDoc(env, user, params.id);
  if (d.status === 'refused') throw new HttpError(409, 'That document was refused as question-bank material.');
  if (d.status === 'uploading') throw new HttpError(409, 'That document has not finished uploading.');
  const ix = await store.indexDocument(env, user, d.id);
  if (ix.refused) return json({ refused: true, reason: ix.reason }, 422);
  wait(ctx, libraryRun(env, user, { ms: 22_000, cover: false }));
  return json({ ok: true, ...ix, doc: store.docOut(await store.getDoc(env, user, d.id)) });
}

// DELETE /api/library/docs/:id -> {deleted: true, passages}
export async function deleteRoute(request, env, ctx, params, url, user) {
  return json(await store.deleteDoc(env, user, params.id));
}

// GET /api/library/docs/:id -> {doc, pages: [{n, kind, chars, ocr_state}]}
export async function docRoute(request, env, ctx, params, url, user) {
  const d = await store.mustDoc(env, user, params.id);
  const pages = (await env.DB.prepare(`SELECT n, kind, chars, ocr_state FROM library_pages WHERE user_id = ?1 AND doc_id = ?2 ORDER BY n`).bind(user, d.id).all()).results || [];
  return json({ doc: store.docOut(d), pages });
}

// GET /api/library/docs/:id/file: the PDF itself (Range supported) for the viewer's pdf.js.
export async function fileRoute(request, env, ctx, params, url, user) {
  const d = await store.mustDoc(env, user, params.id, { all: true });
  if (!d.r2_key || d.status === 'uploading') throw new HttpError(404, 'That file is not in the store.');
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
  const opts = range ? { range: { offset: Number(range[1]), ...(range[2] ? { length: Number(range[2]) - Number(range[1]) + 1 } : {}) } } : {};
  const obj = await store.bucket(env).get(d.r2_key, opts);
  if (!obj) throw new HttpError(404, 'That file is not in the store.');
  const headers = { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${String(d.file_name || 'document.pdf').replace(/[^\w .()-]/g, '_')}"` };
  if (range && obj.range) {
    const off = obj.range.offset ?? Number(range[1]);
    const len = obj.range.length ?? (obj.size - off);
    return new Response(obj.body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${off}-${off + len - 1}/${obj.size}`, 'Content-Length': String(len) } });
  }
  return new Response(obj.body, { status: 200, headers: { ...headers, 'Content-Length': String(obj.size) } });
}

// GET /api/library/doc/:id/page/:n?passage=<id>&q= -> {doc, page: {n, text, kind}, passages, highlight, prev, next}
export async function pageRoute(request, env, ctx, params, url, user) {
  const d = await store.mustDoc(env, user, params.id);
  const n = intParam(params.n, 'page', 1, store.MAX_PAGES);
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [pg, ps] = await env.DB.batch([
    P(`SELECT n, text, kind, chars, ocr_state FROM library_pages WHERE user_id = ?1 AND doc_id = ?2 AND n = ?3`, user, d.id, n),
    P(`SELECT pid, page, page_to, heading, kind, char_start, char_end, tokens FROM library_passages WHERE user_id = ?1 AND doc_id = ?2 AND page <= ?3 AND page_to >= ?3 ORDER BY seq`, user, d.id, n),
  ]);
  const page = (pg.results || [])[0];
  if (!page) throw new HttpError(404, `Page ${n} is not in that document's index.`);
  const len = page.text.length;
  const passages = (ps.results || []).map(p => ({ id: p.pid, heading: p.heading, kind: p.kind, tokens: p.tokens, page: p.page, page_to: p.page_to,
    start: p.page === n ? p.char_start : 0, end: p.page_to === n ? Math.min(len, p.char_end) : len }));
  const want = url.searchParams.get('passage');
  let highlight = null;
  if (want) {
    const p = passages.find(x => String(x.id) === want);
    if (p) highlight = { passage: p.id, start: p.start, end: p.end };
  }
  // Query words to mark inside the page (the viewer underlines them): exact character ranges, at most 60.
  const marks = [];
  const qs = url.searchParams.get('q');
  if (qs) {
    const words = [...new Set(qs.toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
    const lower = page.text.toLowerCase();
    for (const w of words) {
      let i = lower.indexOf(w);
      while (i >= 0 && marks.length < 60) { marks.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
    }
    marks.sort((a, b) => a[0] - b[0]);
  }
  return json({ doc: { id: d.id, title: d.title, page_count: d.page_count }, page: { n, text: page.text, kind: page.kind, ocr_state: page.ocr_state },
    passages, highlight, marks, prev: n > 1 ? n - 1 : null, next: d.page_count && n < d.page_count ? n + 1 : null });
}

// GET /api/library/status -> {docs: {status: n}, pending: {embed, link, ocr, ocr_waiting, index}, unread, vectors, job}
//   pending.ocr counts pages the job can read now; ocr_waiting those waiting for a retry after a failed read or for
//   tomorrow's OCR budget; unread the pages that could not be read (failed after every try, or skipped).
export async function statusRoute(request, env, ctx, params, url, user) {
  try {
    const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
    const now = Date.now();
    const [byStatus, pend, ocr, job, spent] = await env.DB.batch([
      P(`SELECT status, count(*) AS n FROM library_docs WHERE user_id = ?1 GROUP BY status`, user),
      P(`SELECT sum(vec_state = 0) AS embed, sum(linked = 0) AS link, sum(vec_state = 1) AS vectorize, count(*) AS passages FROM library_passages WHERE user_id = ?1`, user),
      P(`SELECT coalesce(sum(p.ocr_state = 'pending' AND coalesce(s.next_at, 0) <= ?3), 0) AS due, coalesce(sum(p.ocr_state = 'pending' AND s.next_at > ?3), 0) AS waiting,
          coalesce(sum(p.ocr_state IN ('failed', 'skipped')), 0) AS unread
        FROM library_pages p LEFT JOIN sync_state s ON s.user_id = p.user_id AND s.source = ?2 || p.doc_id || ':' || p.n
        WHERE p.user_id = ?1 AND p.ocr_state IN ('pending', 'failed', 'skipped')`, user, store.OCR_PAGE_SOURCE, now),
      P(`SELECT last_ok_at, next_at, fails, last_error FROM sync_state WHERE user_id = ?1 AND source = 'library'`, user),
      P(`SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = 'library.ocr'`, user),
    ]);
    const p = (pend.results || [])[0] || {};
    const o = (ocr.results || [])[0] || {};
    const [d0, n0] = String((((spent.results || [])[0] || {}).cursor) || '').split(':');
    const budgetOut = d0 === londonDay(now) && Number(n0) >= OCR_DAILY;
    return json({ docs: Object.fromEntries((byStatus.results || []).map(r => [r.status, r.n])),
      pending: { embed: p.embed || 0, link: p.link || 0, vectorize: vectorizeOn(env) ? p.vectorize || 0 : 0, ocr: budgetOut ? 0 : o.due || 0,
        ocr_waiting: (o.waiting || 0) + (budgetOut ? o.due || 0 : 0) },
      unread: o.unread || 0, passages: p.passages || 0, vectors: vectorizeOn(env) ? 'vectorize' : 'd1', job: (job.results || [])[0] || null });
  } catch (e) { return notReady(e); }
}

// GET /api/library/search?q=&topic_id=&k=&rerank=0|1&full=1 -> searchLibrary's answer
export async function searchRoute(request, env, ctx, params, url, user) {
  const q = (url.searchParams.get('q') || '').trim();
  const topicId = (url.searchParams.get('topic_id') || '').trim() || null;
  if (!q && !topicId) throw new HttpError(400, 'Give q (the words to find) or topic_id.');
  if (q.length > 200) throw new HttpError(400, 'q is at most 200 characters.');
  const k = url.searchParams.get('k') ? intParam(url.searchParams.get('k'), 'k', 1, MAX_K) : DEFAULT_K;
  try {
    const r = await searchLibrary(env, user, { q: q || null, topicId, k, rerank: url.searchParams.get('rerank') !== '0', expand: url.searchParams.get('expand') !== '0',
      full: url.searchParams.get('full') === '1' });
    return json(r);
  } catch (e) { return notReady(e); }
}

// GET /api/library/topic/:id[?build=0] -> topicCoverage (every passage above the threshold, by document and page)
export async function topicRoute(request, env, ctx, params, url, user) {
  try {
    const full = url.searchParams.get('full') === '1';
    return json(await topicCoverage(env, user, params.id, { build: url.searchParams.get('build') !== '0', force: url.searchParams.get('rebuild') === '1', ...(full ? { textMax: 4000 } : {}) }));
  } catch (e) { return notReady(e); }
}

// POST /api/library/run {ms?} -> one burst of the background work now (the release backfill and the import script)
export async function runRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000);
  const ms = Number.isInteger(body.ms) ? Math.max(500, Math.min(25_000, body.ms)) : 15_000;
  try {
    if (body.once) return json(await libraryJob(env, user, { cover: body.cover !== false }));
    return json(await libraryRun(env, user, { ms, cover: body.cover !== false }));
  } catch (e) { return notReady(e); }
}


export async function objectivesRoute(request, env, ctx, params, url, user) {
  const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length || ids.some(id => !isQid(id))) throw new HttpError(400, 'ids is a comma-separated list of UWorld question IDs.');
  if (ids.length > MAX_IDS) throw new HttpError(400, `At most ${MAX_IDS} ids at a time.`);
  try { return json({ objectives: await objectivesFor(env, user, ids) }); } catch (e) { return notReady(e); }
}
