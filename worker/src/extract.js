// Picking questions out of uploaded PDFs (Library "Upload PDFs"). The browser renders each page with
// pdf.js and sends a batch of pages (label, text layer and picture as Claude content blocks); Claude copies
// out the questions, answers and explanations. Nothing is stored here: the browser merges the batches and
// saves the exam as usual. A web page (a link or a pasted page, &kind=web) comes the same way: its text in
// parts instead of pages, and its pictures as numbered picture pages (&pics=) that hold no question.
//
// The Worker has little CPU time (error 1102 on 20 Oct 2026), so the pictures are never re-encoded: the
// body is parsed once to check its shape and then passed on to Claude as the text it arrived in.
import { HttpError, json, str } from './util.js';
import { reserveSpend, spendCap } from './db.js';
import { callJsonRaw } from './claude.js';
import { EXTRACT_SYSTEM, EXTRACT_SCHEMA, extractIntro } from './prompts.js';

const MAX_BODY = 16_000_000;
export const MAX_PAGES = 10; // pages per call, context pages included
const MAX_IMAGE = 3_000_000; // base64 characters of one page's JPEG
const MAX_TEXT = 40_000;
const MIMES = ['image/jpeg', 'image/png'];
// Room kept under the daily cap for one batch (four pages on Opus 5.5 at high effort is about $0.15 to $0.40).
export const EXTRACT_RESERVE_USD = 1.5;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const pageList = (v, name) => {
  const raw = String(v || '').trim();
  if (!raw) return [];
  const out = raw.split(',').map(Number);
  if (out.some(n => !Number.isInteger(n) || n < 1 || n > 5000)) throw new HttpError(400, `The ${name} page numbers are not page numbers.`);
  return out;
};

/**
 * The query's page numbers as [{n, context, pic}]: own = pages (or web page parts) whose questions to copy,
 * ctx = context pages, pics = a web page's pictures (no question starts on one; a figure may be on one).
 */
export function checkBatch(own, ctx, pics = []) {
  if (!own.length) throw new HttpError(400, 'Send at least one page.');
  const n = own.length + ctx.length + pics.length;
  if (n > MAX_PAGES) throw new HttpError(400, `Send at most ${MAX_PAGES} pages at a time.`);
  if (new Set([...own, ...ctx, ...pics]).size !== n) throw new HttpError(400, 'A page was sent twice.');
  return [...own.map(n => ({ n, context: false })), ...ctx.map(n => ({ n, context: true })), ...pics.map(n => ({ n, context: true, pic: true }))];
}

/** The body: a JSON array of text blocks and base64 picture blocks only, at most one picture a page. */
export function checkContent(text, pageCount) {
  let blocks;
  try { blocks = JSON.parse(text); } catch { throw new HttpError(400, 'That request was not valid JSON.'); }
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > pageCount * 3) throw new HttpError(400, 'Send each page as its text and its picture.');
  let images = 0;
  for (const b of blocks) {
    const keys = b && typeof b === 'object' ? Object.keys(b) : [];
    if (b && b.type === 'text' && keys.length === 2 && typeof b.text === 'string' && b.text.length <= MAX_TEXT + 200) continue;
    const src = b && b.source;
    const ok = b && b.type === 'image' && keys.length === 2 && src && typeof src === 'object' && Object.keys(src).length === 3 &&
      src.type === 'base64' && MIMES.includes(src.media_type) && typeof src.data === 'string' && src.data.length > 0 && src.data.length <= MAX_IMAGE;
    if (!ok) throw new HttpError(400, 'A page has a picture the hub cannot read.');
    images += 1;
  }
  if (images > pageCount) throw new HttpError(400, 'More pictures than pages were sent.');
  return blocks.length;
}

// Picture boxes in thousandths of the page (0 to 1000), on a page of this batch, at least 2% each way.
export function tidyFigures(list, pageSet) {
  const out = [];
  const c = v => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)));
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || !pageSet.has(f.page)) continue;
    const x0 = c(Math.min(f.x0, f.x1)), x1 = c(Math.max(f.x0, f.x1)), y0 = c(Math.min(f.y0, f.y1)), y1 = c(Math.max(f.y0, f.y1));
    if (x1 - x0 < 20 || y1 - y0 < 20) continue;
    out.push({ label: String(f.label || '').trim().slice(0, 60) || 'Picture', where: f.where === 'explanation' ? 'explanation' : 'question', page: f.page, x0, y0, x1, y1 });
    if (out.length >= 8) break;
  }
  return out;
}

// Per-choice explanations [{l, t}] as {A: text, ...}: one entry a letter (two copies of one letter joined),
// letters that are not choices of the question dropped (any A to Z when the question's choices are not known).
export function tidyOexpl(list, letters) {
  const out = {};
  for (const o of Array.isArray(list) ? list : []) {
    const l = typeof (o && o.l) === 'string' ? o.l.trim().toUpperCase() : '';
    const t = typeof (o && o.t) === 'string' ? o.t.trim() : '';
    if (!t || l.length !== 1 || !LETTERS.includes(l) || (letters && !letters.includes(l))) continue;
    out[l] = out[l] && out[l] !== t ? `${out[l]}\n\n${t}` : t;
  }
  return Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
}

// Code checks on Claude's copy: options lettered A, B, C... in order; an answer must be one of them.
// oexpl ({A: why A is right or wrong, ...}) and obj (the educational objective) are copied text too; when
// the choices had to be relettered, the letters Claude gave cannot be trusted, so oexpl is dropped.
export function tidyExtract(data, pages) {
  const own = new Set(pages.filter(p => !p.context).map(p => p.n));
  const firstOwn = Math.min(...own);
  const all = new Set(pages.map(p => p.n));
  const s = v => (typeof v === 'string' ? v.trim() : '');
  const sec = v => (Number.isInteger(v) && v > 0 ? v : null);
  const questions = [];
  for (const q of (data && Array.isArray(data.questions) ? data.questions : [])) {
    if (!q || !Number.isInteger(q.num) || q.num < 1 || !s(q.stem)) continue;
    const opts = (Array.isArray(q.options) ? q.options : [])
      .map(o => ({ l: s(o && o.l).toUpperCase(), t: s(o && o.t) }))
      .filter(o => o.t);
    const ordered = opts.every((o, i) => o.l === LETTERS[i]);
    const fixed = ordered ? opts : opts.slice(0, LETTERS.length).map((o, i) => ({ l: LETTERS[i], t: o.t }));
    const answer = ordered && fixed.some(o => o.l === s(q.answer).toUpperCase()) ? s(q.answer).toUpperCase() : null;
    const page = own.has(q.page) ? q.page : firstOwn;
    const oexpl = ordered ? tidyOexpl(q.option_explanations, fixed.length ? fixed.map(o => o.l) : null) : {};
    questions.push({ num: q.num, section: sec(q.section), stem: s(q.stem), lead: s(q.lead), options: fixed, answer,
      explanation: s(q.explanation), oexpl, obj: s(q.objective), figures: tidyFigures(q.figures, all), page });
  }
  const key = [];
  for (const k of (data && Array.isArray(data.key) ? data.key : [])) {
    const a = s(k && k.answer).toUpperCase();
    if (!k || !Number.isInteger(k.num) || k.num < 1 || !LETTERS.includes(a) || a.length !== 1) continue;
    key.push({ num: k.num, section: sec(k.section), answer: a, explanation: s(k.explanation), oexpl: tidyOexpl(k.option_explanations, null), obj: s(k.objective) });
  }
  return { questions, key, notes: s(data && data.notes).slice(0, 300) };
}

// The Library's proofreading note (what code found odd on a first read), kept to plain words and 300 characters.
export const cleanHint = h => String(h || '').replace(/[^\p{L}\p{N} ,.;:'()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

// POST /api/exams/extract?file=<name>&own=1,2,3,4&ctx=5[&hint=...] with the content blocks as the body.
// A web page: ?kind=web&file=<page>&own=<part>&ctx=<next part>&pics=<picture numbers>.
export async function extract(request, env) {
  const q = new URL(request.url).searchParams;
  const web = q.get('kind') === 'web';
  const file = str(q.get('file'), 200) || (web ? 'the web page' : 'the PDF');
  const own = pageList(q.get('own'), 'own'), ctx = pageList(q.get('ctx'), 'context'), pics = web ? pageList(q.get('pics'), 'picture') : [];
  const pages = checkBatch(own, ctx, pics);
  const tooBig = new HttpError(413, `That is too large for the hub (limit ${Math.round(MAX_BODY / 1e6)} MB).`);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw tooBig;
  const text = (await request.text()).trim();
  if (text.length > MAX_BODY) throw tooBig;
  checkContent(text, pages.length);
  const intro = JSON.stringify({ type: 'text', text: extractIntro(file, own, ctx, cleanHint(q.get('hint')), { web, pics }) });
  const release = await reserveSpend(env, EXTRACT_RESERVE_USD, await spendCap(env));
  try {
    const { data, usd } = await callJsonRaw(env, {
      role: 'reader', system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, effort: 'high', maxTokens: 64000,
      contentJson: `[${intro},${text.slice(1)}`,
    });
    return json({ ...tidyExtract(data, pages), usd: Math.round(usd * 1e4) / 1e4 });
  } finally {
    await release(0); // the call added its real cost
  }
}
