import { HttpError, json, now } from '../util.js';
import { requireModule } from './modules.js';
import { loadPaper, mutatePaper, parsePaper, PARTS } from './papers.js';
import * as store from '../library/store.js';

export const MAX_EXTRA = 10;
const MAX_STROKES_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 2_500_000;
export const MAX_PAGES_TO_CLAUDE = 4;
const keyOf = (user, paperId, page, ext) => `u/${user}/ink/${paperId}/${page}.${ext}`;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The ink index of a paper's marks: {pages: {page: {at, n}}, extra, sent_at?}. */
export const inkOf = marks => (isObj(marks.ink) ? marks.ink : { pages: {}, extra: 0 });
/** The pages written on, in order. */
export const writtenPages = marks => Object.keys(inkOf(marks).pages || {}).map(Number).filter(n => inkOf(marks).pages[n].n > 0).sort((a, b) => a - b);

/** Strokes checked and rounded: [{c, w, p}] or a 400 in plain words. */
export function cleanStrokes(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Send the writing as a list of strokes.');
  if (list.length > 20_000) throw new HttpError(400, 'That page has too much writing to save.');
  return list.map(s => {
    if (!isObj(s) || !Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2) throw new HttpError(400, 'A stroke of the writing is broken.');
    const p = s.p.map(v => Math.round(Number(v) * 10000) / 10000);
    if (p.some(v => !Number.isFinite(v) || v < -0.05 || v > 3)) throw new HttpError(400, 'A stroke of the writing is off the page.');
    const w = Math.min(0.05, Math.max(0.0005, Number(s.w) || 0.002));
    const c = /^#[0-9a-f]{6}$/i.test(String(s.c || '')) ? String(s.c).toLowerCase() : '#111111';
    return { c, w: Math.round(w * 100000) / 100000, p };
  });
}

async function pageLimit(env, user, paper) {
  const doc = paper.source && paper.source.doc_id ? await store.getDoc(env, user, paper.source.doc_id) : null;
  return (doc && doc.page_count) || 0;
}

const pageNumber = (raw, pages) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > pages + MAX_EXTRA) throw new HttpError(400, `There is no page ${String(raw).slice(0, 6)} on this paper.`);
  return n;
};

async function getInk(request, env, ctx, params, url, user, session) {
  requireModule(session, PARTS, env);
  const row = await loadPaper(env, user, params.id);
  const { paper } = parsePaper(row);
  if (!paper.source) throw new HttpError(400, 'Only an exam from a PDF can be written on.');
  const n = pageNumber(params.page, await pageLimit(env, user, paper) || 400);
  const obj = await store.bucket(env).get(keyOf(user, row.id, n, 'json'));
  return json({ page: n, strokes: obj ? JSON.parse(await obj.text()) : [] });
}

/** A page as the browser sends it: {strokes, jpeg} checked (the picture only when there is writing). */
async function readPage(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_STROKES_BYTES + MAX_IMAGE_BYTES + 50_000) throw new HttpError(413, 'That page is too big to save.');
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Send the page as a form.'); }
  const raw = String(form.get('strokes') || '[]');
  if (raw.length > MAX_STROKES_BYTES) throw new HttpError(413, 'That page has too much writing to save.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'The writing could not be read.'); }
  const strokes = cleanStrokes(parsed);
  const image = form.get('image');
  let jpeg = null;
  if (strokes.length && image && typeof image.arrayBuffer === 'function') {
    jpeg = new Uint8Array(await image.arrayBuffer());
    if (jpeg.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'The picture of that page is too big.');
    if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff)) throw new HttpError(400, 'The picture of the page should be a JPEG.');
  }
  return { strokes, jpeg };
}
async function storePage(env, base, n, { strokes, jpeg }) {
  const r2 = store.bucket(env);
  if (strokes.length) {
    await r2.put(`${base}${n}.json`, JSON.stringify(strokes), { httpMetadata: { contentType: 'application/json' } });
    if (jpeg) await r2.put(`${base}${n}.jpg`, jpeg, { httpMetadata: { contentType: 'image/jpeg' } });
  } else await r2.delete([`${base}${n}.json`, `${base}${n}.jpg`]);
}

async function putInk(request, env, ctx, params, url, user, session) {
  requireModule(session, PARTS, env);
  const { strokes, jpeg } = await readPage(request);
  const row0 = await loadPaper(env, user, params.id);
  const { paper } = parsePaper(row0);
  if (!paper.source) throw new HttpError(400, 'Only an exam from a PDF can be written on.');
  if (row0.status !== 'ready') throw new HttpError(400, 'This paper is already being marked, so the writing is locked.');
  const pages = await pageLimit(env, user, paper);
  const n = pageNumber(params.page, pages || 400);
  await storePage(env, `u/${user}/ink/${row0.id}/`, n, { strokes, jpeg });
  const at = now();
  await mutatePaper(env, user, row0.id, ({ row, marks }) => {
    if (row.status !== 'ready') throw new HttpError(400, 'This paper is already being marked, so the writing is locked.');
    const ink = isObj(marks.ink) ? marks.ink : (marks.ink = { pages: {}, extra: 0 });
    if (!isObj(ink.pages)) ink.pages = {};
    if (strokes.length) ink.pages[n] = { at, n: strokes.length, ...(jpeg ? { img: 1 } : {}) };
    else delete ink.pages[n];
    if (pages && n > pages) ink.extra = Math.max(ink.extra || 0, n - pages);
  });
  return json({ ok: true, page: n, strokes: strokes.length, at });
}

/** Their written pages as pictures for their Claude (paper_get pages): at most MAX_PAGES_TO_CLAUDE at a time. */
export async function pagePictures(env, user, row, wanted) {
  const { marks } = parsePaper(row);
  const have = new Set(writtenPages(marks));
  const list = [...new Set((Array.isArray(wanted) ? wanted : []).map(Number))].filter(n => have.has(n)).slice(0, MAX_PAGES_TO_CLAUDE);
  const r2 = store.bucket(env);
  const out = [];
  for (const n of list) {
    const obj = await r2.get(keyOf(user, row.id, n, 'jpg'));
    if (obj) out.push({ page: n, data: new Uint8Array(await obj.arrayBuffer()) });
    else out.push({ page: n, missing: true });
  }
  return out;
}

/** What paper_get tells their Claude about a paper written on: each written page and the questions on it. */
export function handwrittenView(paper, marks, pageCount = 0) {
  const pages = writtenPages(marks);
  if (!pages.length) return null;
  const qs = (paper.questions || []).filter(q => q.page).sort((a, b) => a.page - b.page);
  const on = p => {
    const here = qs.filter(q => q.page === p).map(q => q.label || String(q.n));
    if (here.length) return here;
    const before = qs.filter(q => q.page < p).pop();   // a page with no question starting on it: the one carried on
    return before ? [before.label || String(before.n)] : [];
  };
  return {
    pages: pages.map(p => ({ page: p, ...(pageCount && p > pageCount ? { extra_page: true } : { questions: on(p) }) })),
    note: `They wrote on the paper with a pencil. paper_get with pages (up to ${MAX_PAGES_TO_CLAUDE} at a time) shows those pages with their writing. Write down each answer exactly as written, mistakes included (leave out what they crossed out), with paper_mark answers (their confidence taps are kept). An extra page carries on an answer: they name the question on it. Then show_mark_scheme and mark. No mark scheme saved: find it (library_add_link) and read it, or ask them for it.`,
  };
}

/** Deletes a paper's ink (the paper was deleted). */
export async function deleteInk(env, user, paperId) {
  if (!env.LIBRARY || typeof env.LIBRARY.list !== 'function') return;
  const l = await env.LIBRARY.list({ prefix: `u/${user}/ink/${paperId}/` });
  const keys = (l.objects || []).map(o => o.key);
  if (keys.length) await env.LIBRARY.delete(keys);
}

const docBase = (user, docId) => `u/${user}/${docId}/ink/`;
async function ownDoc(env, user, id) {
  const d = await store.getDoc(env, user, String(id || ''));
  if (!d) throw new HttpError(404, 'That document is not in your library.');
  return d;
}
/** The pages of a document with writing on them, and how many blank extra pages there are. */
export async function docInk(env, user, d) {
  const l = await store.bucket(env).list({ prefix: docBase(user, d.id) });
  const pages = [...new Set((l.objects || []).map(o => /\/(\d+)\.json$/.exec(o.key)).filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);
  return { pages, extra: Math.max(0, ...pages.map(n => n - (d.page_count || 0))) };
}
/** Their Claude's look at a written document: up to MAX_PAGES_TO_CLAUDE written pages from `from`, as JPEG bytes. */
export async function docInkPictures(env, user, d, from = 1) {
  const { pages } = await docInk(env, user, d);
  const r2 = store.bucket(env);
  const out = [];
  for (const n of pages.filter(p => p >= from).slice(0, MAX_PAGES_TO_CLAUDE)) {
    const obj = await r2.get(`${docBase(user, d.id)}${n}.jpg`);
    if (obj) out.push({ page: n, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  return { written: pages, pictures: out };
}
const libGate = (session, env) => requireModule(session, 'library', env);

export const ROUTES = [
  ['GET', '/api/p/papers/:id/ink/:page', getInk],
  ['PUT', '/api/p/papers/:id/ink/:page', putInk],
  ['GET', '/api/p/library/docs/:id/ink', async (rq, env, ctx, params, url, user, session) => { libGate(session, env); return json(await docInk(env, user, await ownDoc(env, user, params.id))); }],
  ['GET', '/api/p/library/docs/:id/ink/:page', async (rq, env, ctx, params, url, user, session) => {
    libGate(session, env);
    const d = await ownDoc(env, user, params.id);
    const n = pageNumber(params.page, d.page_count || 400);
    const obj = await store.bucket(env).get(`${docBase(user, d.id)}${n}.json`);
    return json({ page: n, strokes: obj ? JSON.parse(await obj.text()) : [] });
  }],
  ['PUT', '/api/p/library/docs/:id/ink/:page', async (rq, env, ctx, params, url, user, session) => {
    libGate(session, env);
    const page = await readPage(rq);
    const d = await ownDoc(env, user, params.id);
    if (!d.page_count) throw new HttpError(409, 'That document is still being read in. Try again in a minute.');
    const n = pageNumber(params.page, d.page_count);
    await storePage(env, docBase(user, d.id), n, page);
    return json({ ok: true, page: n, strokes: page.strokes.length });
  }],
];
