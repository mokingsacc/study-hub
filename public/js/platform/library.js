import { get, post, del, ApiError, DEMO, uploadHeaders } from './api.js';
import { h, icon, btn, linkBtn, sheet, confirmSheet, toast, field, input, pageHead, loading, errorState, state, busy, bytes, plural } from './kit.js';

const API = '/api/p/library';
const POLL_MS = 4000;
const NUDGE_AFTER_MS = 45_000;
const PARALLEL_PARTS = 3;
const PAGES_PER_CALL = 40;
const SEND_MAX_CHARS = 6_000_000;      // characters of JSON per pages call (the route takes 12 MB)
const SCAN_TEXT = 40;                  // a page with fewer letters than this and pictures goes to the hub's OCR
const MAX_PHOTOS = 30;
const SEARCH_K = 20;
const BUSY = new Set(['uploading', 'uploaded', 'extracting', 'indexing']);

export const fileHref = id => `${API}/docs/${encodeURIComponent(id)}/file`;
const docPath = id => `${API}/docs/${encodeURIComponent(id)}`;

// ------------------------------------------------------------------ pure helpers

/** "...water moves by osmosis from..." with the query's words as <mark> nodes (never HTML): a window around the first match. */
export function markNodes(text, q, max = 190) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const words = [...new Set(String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
  const lower = t.toLowerCase();
  let at = -1;
  for (const w of words) { const i = lower.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  let start = t.length > max && at > 40 ? Math.min(t.length - max, at - 40) : 0;   // the match near the start: the list shows three lines
  start = Math.max(0, start);
  if (start > 0) { const sp = t.indexOf(' ', start); if (sp > 0 && sp - start < 20) start = sp + 1; }
  let part = t.slice(start, start + max);
  if (start + max < t.length) { const sp = part.lastIndexOf(' '); if (sp > max * 0.7) part = part.slice(0, sp); }
  const out = [];
  if (start > 0) out.push(document.createTextNode('…'));
  if (words.length) {
    const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    part.split(re).forEach((piece, i) => {
      if (!piece) return;
      if (i % 2) { const m = document.createElement('mark'); m.textContent = piece; out.push(m); } else out.push(document.createTextNode(piece));
    });
  } else out.push(document.createTextNode(part));
  if (start + part.length < t.length) out.push(document.createTextNode('…'));
  return out;
}

/** A page's text as nodes: the found passage [start, end) tinted, the query's words in <mark>. Returns {nodes, first}. */
export function pageNodes(text, highlight, marks = []) {
  const t = String(text || '');
  const hl = highlight && Number.isInteger(highlight.start) ? [Math.max(0, highlight.start), Math.min(t.length, highlight.end)] : null;
  const ms = (marks || []).filter(m => Array.isArray(m) && m[0] >= 0 && m[1] <= t.length && m[1] > m[0]);
  const cuts = new Set([0, t.length]);
  if (hl) { cuts.add(hl[0]); cuts.add(hl[1]); }
  for (const [a, b] of ms) { cuts.add(a); cuts.add(b); }
  const pts = [...cuts].sort((a, b) => a - b);
  const nodes = [];
  let first = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    let node = document.createTextNode(t.slice(a, b));
    if (ms.some(m => m[0] <= a && m[1] >= b)) { const m = document.createElement('mark'); m.append(node); node = m; first = first || m; }
    if (hl && hl[0] <= a && hl[1] >= b) {
      const s = h('span', { class: 'hl', style: 'background:var(--accent-soft);border-radius:3px' }, node);
      node = s; first = a === hl[0] ? s : first;
    }
    nodes.push(node);
  }
  return { nodes, first };
}

/** The status of a document in words: {text, kind: ok|info|warn|bad, f: 0..1 or null}. job: this page's own upload of it. */
export function statusOf(d, job = null) {
  if (job) return { text: job.word, kind: 'info', f: job.f };
  if (d.status === 'ready') return d.ocr_pending ? { text: 'Reading pictures', kind: 'info', f: 0.5 } : { text: 'Ready', kind: 'ok', f: null };
  if (d.status === 'indexing') { const pct = d.progress ? d.progress.pct : 0; return { text: `Indexing ${pct}%`, kind: 'info', f: Math.max(0.03, pct / 100) }; }
  if (d.status === 'uploaded' || d.status === 'extracting') {
    return { text: d.page_count ? `Reading ${d.pages_in || 0}/${d.page_count}` : 'Reading', kind: 'info', f: d.page_count ? Math.max(0.03, (d.pages_in || 0) / d.page_count) : 0.03 };
  }
  if (d.status === 'uploading') return { text: 'Upload stopped', kind: 'warn', f: null };
  if (d.status === 'refused') return { text: 'Not added', kind: 'bad', f: null };
  if (d.status === 'failed') return { text: 'Could not read', kind: 'bad', f: null };
  return { text: String(d.status || ''), kind: 'na', f: null };
}

const firstSentence = s => { const m = /^(.+?[.!?])(\s|$)/.exec(String(s || '').trim()); return m ? m[1] : String(s || '').trim(); };
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function sha256Hex(buf) {
  if (!globalThis.crypto || !crypto.subtle) return null;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** One PDF from JPEG photos, a page each: images [{jpeg: Uint8Array, w, h}] -> Uint8Array (a plain PDF with an xref table). */
export function photosPdf(images) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, head, stream) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${head}\n`);
    if (stream != null) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${images.length} >>`);
  images.forEach((im, i) => {
    const p = 3 + 3 * i;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${im.w} ${im.h}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`);
    obj(p + 1, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`, im.jpeg);
    const draw = `q ${im.w} 0 0 ${im.h} 0 0 cm /Im0 Do Q`;
    obj(p + 2, `<< /Length ${draw.length} >>`, draw);
  });
  const total = 3 + 3 * images.length, xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${x}trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

/** pdf.js text items to the Library's lines [{t, s, b, x, y}] (as the hub's own reader): items on one baseline are a line, far gaps a tab. */
export function itemsToLines(items, pageHeight, boldOf = () => false) {
  const rows = [];
  let cur = null;
  for (const it of items) {
    const str = String(it.str || '');
    if (!str.trim()) { if (it.hasEOL && cur) cur.eol = true; continue; }
    const [a, b, c, d, e, f] = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 0;
    const x = e, x1 = e + (Number(it.width) || 0);
    const bold = !!boldOf(it.fontName);
    const same = cur && !cur.eol && Math.abs(cur.base - f) <= Math.max(1.5, size * 0.3) && x >= cur.x1 - Math.max(2, size);
    if (same) {
      const gap = x - cur.x1;
      if (gap > Math.max(18, 2.2 * size)) cur.t += '\t';
      else if (gap > size * 0.12 && !/\s$/.test(cur.t) && !/^\s/.test(str)) cur.t += ' ';
      cur.t += str;
      cur.x1 = Math.max(cur.x1, x1);
      if (str.trim().length > cur.main) { cur.main = str.trim().length; cur.s = size; }
      cur.b = cur.b && bold;
    } else {
      cur = { t: str, s: size, b: bold, x, base: f, top: pageHeight - f - size, x1, main: str.trim().length, eol: false };
      rows.push(cur);
    }
    if (it.hasEOL) cur.eol = true;
  }
  const r1 = v => Math.round(v * 10) / 10;
  return rows.map(r => ({ t: r.t.replace(/ /g, ' ').replace(/[ ]{2,}/g, ' ').trim(), s: r1(r.s), b: r.b ? 1 : 0, x: r1(r.x), y: r1(Math.max(0, r.top)) })).filter(l => l.t);
}

// ------------------------------------------------------------------ pdf.js, only when someone uploads (the same pinned file, with SRI, as the hub)
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDFJS_SRI = 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==';
const PDFJS_WORKER_SRI = 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==';
const PDF_OPTIONS = Object.freeze({ isEvalSupported: false });
let pdfReady = null;
async function workerUrl() {
  const res = await fetch(PDFJS_WORKER, { integrity: PDFJS_WORKER_SRI, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`the PDF reader's worker answered ${res.status}`);
  return URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
}
export function loadPdfJs() {
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions.workerSrc) return Promise.resolve(window.pdfjsLib);
  if (!pdfReady) pdfReady = new Promise((resolve, reject) => {
    const fail = () => { pdfReady = null; reject(new Error('The PDF reader could not be downloaded')); };
    const s = document.createElement('script');
    s.src = PDFJS; s.integrity = PDFJS_SRI; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { fail(); return; }
      workerUrl().then(u => { lib.GlobalWorkerOptions.workerSrc = u; resolve(lib); }, fail);
    };
    s.onerror = () => { s.remove(); fail(); };
    document.head.append(s);
  });
  return pdfReady;
}

// ------------------------------------------------------------------ uploads (they carry on if you leave the screen)
const JOBS = new Map();
let queue = Promise.resolve();
let onChange = () => {};
let tokenP = null;
let leaving = false;

function say(job, word, f) { job.word = word; if (f != null) job.f = f; onChange(); }

// A part of the file as raw bytes: api.js sends JSON or forms, so this one request is made here, with the same cookie and CSRF token.
async function putBytes(path, data) {
  const up = uploadHeaders();
  if (up) {
    const r = await fetch(path, { method: 'PUT', headers: { ...up, 'Content-Type': 'application/octet-stream' }, body: data, cache: 'no-store', credentials: 'omit' }).catch(() => null);
    if (!r) throw new ApiError(0, 'Cannot reach Study Hub. Check your connection and try again.');
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, (body && body.error) || 'The upload did not go through. Please try again.', body);
    return body;
  }
  tokenP = tokenP || get('/api/auth/me').then(m => m.csrf).catch(e => { tokenP = null; throw e; });
  const token = await tokenP;
  let r;
  try { r = await fetch(path, { method: 'PUT', headers: { 'X-CSRF-Token': token || '', 'Content-Type': 'application/octet-stream' }, body: data, credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new ApiError(0, 'Cannot reach Study Hub. Check your connection and try again.'); }
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 403) tokenP = null;
    throw new ApiError(r.status, (body && body.error) || (r.status === 401 ? 'Please sign in again.' : 'The upload did not go through. Please try again.'), body);
  }
  return body;
}

// Create the document, send its bytes in parts, complete it. Returns false when the same file is already there.
async function sendFile(job, fileName, buf, title) {
  say(job, 'Preparing', 0.03);
  const sha = buf.byteLength <= 200 * 1048576 ? await sha256Hex(buf).catch(() => null) : null;
  const made = await post(`${API}/docs`, { file_name: fileName, bytes: buf.byteLength, ...(sha ? { sha256: sha } : {}), title, ...(job.collection ? { collection: job.collection } : {}) });
  job.id = made.doc.id;
  if (made.duplicate) {
    if (!['uploaded', 'extracting'].includes(made.doc.status)) { toast(`${made.doc.title} is already in your library.`); return false; }
    return true;
  }
  const size = made.upload.part_size, parts = made.upload.parts;
  let next = 1, sent = 0;
  const one = async () => {
    while (next <= parts) {
      const n = next++;
      const data = buf.slice((n - 1) * size, Math.min(buf.byteLength, n * size));
      for (let t = 0; ; t++) {
        try { await putBytes(`${docPath(job.id)}/parts/${n}`, data); break; }
        catch (e) { if (t >= 2 || (e.status && e.status < 500)) throw e; await wait(1500 * (t + 1)); }
      }
      sent += data.byteLength;
      say(job, `Uploading ${Math.round((100 * sent) / buf.byteLength)}%`, 0.05 + 0.45 * (sent / buf.byteLength));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, parts) }, one));
  await post(`${docPath(job.id)}/complete`, {});
  return true;
}

// Pages go 40 a call (and under 6 MB of JSON); the hub checks each call for question-bank material.
function pageSender(job, total, extractor) {
  let batch = [], chars = 0;
  const flush = async () => {
    if (!batch.length) return;
    const pages = batch;
    batch = []; chars = 0;
    try { await post(`${docPath(job.id)}/pages`, { page_count: total, pages, extractor }); }
    catch (e) {
      if (e.status === 422) throw new Error(firstSentence((e.data && e.data.reason) || 'It looks like question-bank material, which the Library does not take.'));
      throw e;
    }
  };
  return {
    async add(p) {
      const sz = JSON.stringify(p).length;
      if (batch.length && (batch.length >= PAGES_PER_CALL || chars + sz > SEND_MAX_CHARS)) await flush();
      batch.push(p); chars += sz;
    },
    end: flush,
  };
}

async function pdfPage(page, n) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const boldOf = fn => {
    const st = tc.styles && tc.styles[fn];
    if (st && /bold|black|heavy|semibold/i.test(st.fontFamily || '')) return true;
    try { if (page.commonObjs.has(fn)) { const f = page.commonObjs.get(fn); return !!(f && (f.bold || /bold|black|heavy/i.test(f.name || ''))); } } catch { /* not loaded */ }
    return false;
  };
  const lines = itemsToLines(tc.items, vp.height, boldOf);
  const out = { n, lines, images: 0 };
  if (lines.reduce((t, l) => t + l.t.replace(/\s/g, '').length, 0) < SCAN_TEXT) {
    // A scanned page: a JPEG at about 110 dpi for the hub's OCR (a blank page sends nothing).
    try {
      const v = page.getViewport({ scale: 110 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.round(v.width); c.height = Math.round(v.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: v }).promise;
      const data = c.toDataURL('image/jpeg', 0.7).split(',')[1];
      c.width = c.height = 0;
      if (data.length < 1_900_000 && data.length > 6000) { out.image = data; out.images = 1; }
    } catch { /* the page stays text only */ }
  }
  return out;
}

async function sendPdfPages(job, buf) {
  let doc;
  try {
    const lib = await loadPdfJs();
    doc = await lib.getDocument({ ...PDF_OPTIONS, data: new Uint8Array(buf) }).promise;
  } catch {
    // A PDF this page's reader cannot open: the hub reads it itself.
    say(job, 'Reading on the server', 0.6);
    await post(`${docPath(job.id)}/extract`, {});
    return;
  }
  try {
    const total = doc.numPages;
    const send = pageSender(job, total, 'pdfjs');
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      await send.add(await pdfPage(page, n));
      page.cleanup();
      if (n % 5 === 0 || n === total) say(job, `Reading ${n}/${total}`, 0.5 + 0.48 * (n / total));
    }
    await send.end();
  } finally { doc.destroy(); }
}

async function photoJpeg(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`${file.name || 'That file'} could not be opened as a picture.`)); };
      img.src = url;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  // Small enough for the hub (about 1.4 MB a page) yet sharp enough to read writing.
  for (const [side, q] of [[1600, 0.82], [1400, 0.7], [1100, 0.6], [900, 0.5]]) {
    const k = Math.min(1, side / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), hh = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh);
    g.drawImage(bmp, 0, 0, w, hh);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', q));
    c.width = c.height = 0;
    if (blob && blob.size <= 1_400_000) { if (bmp.close) bmp.close(); return { jpeg: new Uint8Array(await blob.arrayBuffer()), w, h: hh }; }
  }
  throw new Error(`${file.name || 'That picture'} is too large to read. Try a smaller photo.`);
}

function queueJob(job, fn) {
  JOBS.set(job.key, job);
  onChange();
  queue = queue.then(async () => {
    try { await fn(job); }
    catch (e) { toast(`${job.title}: ${(e && e.message) || 'could not be added.'}`); }
    finally { JOBS.delete(job.key); onChange(true); }
  });
}

const newJob = (title, collection = null) => ({ key: `local-${Math.random().toString(36).slice(2, 9)}`, id: null, title, collection, f: 0.02, word: 'Waiting' });

// For the Exams screen and the upload screen (#up/<token>): watch the jobs, and add files as one kind of document.
export const jobsNow = () => [...JOBS.values()].map(j => ({ title: j.title, word: j.word, f: j.f }));
export function watchJobs(fn) { onChange = fn; }
const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function addPdfs(files, name, collection = null) {
  const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (files.length && !pdfs.length) { toast('Choose PDF files here, or use Add photos for pictures.'); return; }
  for (const f of pdfs) {
    const title = (pdfs.length === 1 && name) || f.name.replace(/\.pdf$/i, '');
    queueJob(newJob(title, collection), async job => {
      say(job, 'Preparing', 0.03);
      const buf = await f.arrayBuffer();
      if (await sendFile(job, f.name.replace(/[^\w .()-]/g, '_').slice(0, 180) || 'file.pdf', buf, title)) {
        await sendPdfPages(job, buf);
        toast(`${title} added. Reading it now.`);
      }
    });
  }
}

export function addPhotos(files, name, collection = null) {
  const pics = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)).slice(0, MAX_PHOTOS);
  if (!pics.length) { toast('Choose photos or pictures.'); return; }
  if (files.length > MAX_PHOTOS) toast(`The first ${MAX_PHOTOS} photos are added; add the rest as another document.`);
  const title = name || (pics.length === 1 ? pics[0].name.replace(/\.[a-z0-9]+$/i, '') || `Photo ${today()}` : `Photos ${today()}`);
  queueJob(newJob(title, collection), async job => {
    const images = [];
    for (const [i, f] of pics.entries()) { say(job, `Preparing ${i + 1}/${pics.length}`, 0.03 + 0.1 * (i / pics.length)); images.push(await photoJpeg(f)); }
    const pdf = photosPdf(images);
    if (!(await sendFile(job, `${title.replace(/[^\w .()-]/g, '_').slice(0, 150) || 'photos'}.pdf`, pdf.buffer, title))) return;
    say(job, 'Sending pictures', 0.55);
    const send = pageSender(job, images.length, 'photo');
    for (const [i, im] of images.entries()) await send.add({ n: i + 1, lines: [], images: 1, image: b64(im.jpeg) });
    await send.end();
    toast(`${title} added. The pictures are being read.`);
  });
}

// ------------------------------------------------------------------ the screen

export function render(root, { app }) {
  const S = { docs: [], quota: null, q: '', seq: 0, alive: true, timer: 0, lastMove: new Map(), nudged: 0, ready: false, unsupported: false };
  if (!leaving) { leaving = true; window.addEventListener('beforeunload', e => { if (JOBS.size) { e.preventDefault(); e.returnValue = ''; } }); }

  const addB = btn('Add', () => addSheet(), 'primary', 'plus');
  const search = input({ type: 'search', placeholder: 'Search your files for a word or a question', enterKeyHint: 'search', 'aria-label': 'Search the library', autocomplete: 'off' });
  const listBox = h('div');
  const meter = h('div', { class: 'foot', style: 'margin-top:20px' });
  root.append(pageHead('Library', { actions: [addB], how: 'library' }), h('div', { class: 'search', style: 'margin-bottom:12px' }, icon('search'), search), listBox, meter);
  listBox.append(loading(2));

  const jobFor = d => { for (const j of JOBS.values()) if (j.id === d.id) return j; return null; };
  const localJobs = () => [...JOBS.values()].filter(j => !j.id || !S.docs.some(d => d.id === j.id));

  function row(d, job) {
    const st = statusOf(d, job);
    const meta = d.status === 'refused' || d.status === 'failed' ? firstSentence(d.status_note || '')
      : [d.page_count ? plural(d.page_count, 'page') : null, d.bytes ? bytes(d.bytes) : null].filter(Boolean).join(' · ');
    const prog = st.f != null ? h('div', { class: 'meter', style: 'margin-top:8px', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(st.f * 100)) },
      h('i', { style: `transform:scaleX(${Math.max(0.02, Math.min(1, st.f))})` })) : null;
    const ico = d.extractor === 'photo' ? 'photo' : 'file';
    return h('button', { type: 'button', class: 'li cv', disabled: !!job && !d.status, onclick: () => (d.status ? openDoc(d) : toast('Still uploading. It will appear here when it is in.')) },
      h('span', { class: 'ftype' }, icon(ico)),
      h('span', { class: 'grow' }, h('b', { class: 'clip', style: 'display:block' }, d.title || d.file_name || 'File'), meta ? h('span', { class: 'sub' }, meta) : null, prog),
      h('span', { class: `status ${st.kind}` }, st.text), icon('chevron', 'chev'));
  }

  function draw() {
    if (!S.alive || S.q) return;
    if (S.unsupported) {
      listBox.replaceChildren(state('library', 'The library is on the real Study Hub', 'The demo does not keep uploaded files. Sign in to add your own PDFs and photos.', null, true));
      return;
    }
    const mine = localJobs().map(j => row({ id: j.key, title: j.title, status: '' }, j));
    const docs = S.docs.map(d => row(d, jobFor(d)));
    if (!mine.length && !docs.length) {
      listBox.replaceChildren(state('library', 'Your library is empty',
        'Add your notes, mark schemes and past papers as PDFs, or take photos of them. Study Hub reads them so you and your Claude can search them and cite the page. Only you can see them.',
        btn('Add something', () => addSheet(), 'tinted', 'plus')));
    } else listBox.replaceChildren(h('div', { class: 'list' }, mine, docs));
    const q = S.quota;
    meter.textContent = q ? `${plural(q.docs, 'file')} · ${bytes(q.bytes)} of ${bytes(q.max_bytes)} used` : '';
  }
  onChange = () => { if (S.alive) { draw(); if (!JOBS.size) load({ quiet: true }); } };

  async function load({ quiet = false } = {}) {
    let r;
    try { r = await get(API); }
    catch (e) {
      if (!S.alive) return;
      if (e.status === 401) return;
      if (!quiet || !S.ready) listBox.replaceChildren(errorState(e, () => load()));
      schedule(15000);
      return;
    }
    if (!S.alive) return;
    if (!Array.isArray(r.docs)) { S.unsupported = true; draw(); return; }
    S.docs = r.docs; S.quota = r.quota || null; S.ready = true;
    draw();
    const busyNow = S.docs.some(d => (BUSY.has(d.status) && !(d.status === 'uploading' && !jobFor(d))) || d.ocr_pending);
    if (busyNow) { nudge(); schedule(POLL_MS); }
  }
  function schedule(ms) {
    clearTimeout(S.timer);
    if (S.alive) S.timer = setTimeout(() => { if (S.alive && document.visibilityState !== 'hidden') load({ quiet: true }); else schedule(ms); }, ms);
  }
  // If nothing has moved for a while, ask the hub for one burst of the background work now (limited per hour by the hub).
  function nudge() {
    const now = Date.now();
    let stuck = false;
    for (const d of S.docs.filter(x => x.status === 'indexing' || x.ocr_pending)) {
      const sig = `${d.n_embedded}:${d.n_linked}:${d.ocr_pending}:${d.status}`;
      const was = S.lastMove.get(d.id);
      if (!was || was.sig !== sig) S.lastMove.set(d.id, { sig, at: now });
      else if (now - was.at > NUDGE_AFTER_MS) stuck = true;
    }
    if (stuck && now - S.nudged > 60_000) { S.nudged = now; post(`${API}/run`, { ms: 15000, cover: false }).catch(() => {}); }
  }

  // ---------- search
  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { S.q = search.value.trim(); if (S.q.length >= 2) runSearch(); else { S.q = ''; S.seq++; draw(); } }, 300);
  });
  async function runSearch() {
    const my = ++S.seq, q = S.q;
    listBox.replaceChildren(h('div', { class: 'state inline' }, h('p', null, 'Searching…')));
    try {
      const r = await get(`${API}/search?q=${encodeURIComponent(q.slice(0, 200))}&k=${SEARCH_K}`);
      if (my !== S.seq || !S.alive) return;
      const hits = r.results || [];
      listBox.replaceChildren(hits.length
        ? h('div', { class: 'list', style: 'margin-top:8px' }, hits.map(x => h('button', { type: 'button', class: 'li cv', onclick: () => openPage({ docId: x.doc_id, title: x.title, n: x.page, passage: x.id, q }) },
          h('span', { class: 'ftype' }, icon('search')),
          h('span', { class: 'grow' }, h('b', null, x.title),
            h('span', { class: 'sub' }, [x.page_to && x.page_to !== x.page ? `Pages ${x.page}–${x.page_to}` : `Page ${x.page}`, x.heading ? x.heading.split(' › ').slice(-1)[0] : null].filter(Boolean).join(' · ')),
            h('span', { class: 'snippet' }, markNodes(x.text, q))),
          icon('chevron', 'chev'))))
        : state('search', 'No matches', S.docs.some(d => d.status === 'ready' || d.status === 'indexing')
          ? `Nothing in your library mentions "${q}". Try other words.` : 'Search opens once a file has been read.', null, true));
    } catch (e) { if (my === S.seq && S.alive) listBox.replaceChildren(errorState(e, runSearch)); }
  }

  // ---------- add
  function addSheet() {
    if (DEMO) { toast('Uploads work on the real Study Hub, not in the demo.'); return; }
    const name = input({ placeholder: 'e.g. Biology paper 1, June 2024', maxLength: 120 });
    const pdfIn = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true });
    const picIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const sh = sheet({ title: 'Add to your library', sub: 'Study Hub reads the text, so you can search it and your Claude can cite the page.', body: [
      field('Name', name, 'optional'),
      h('button', { type: 'button', class: 'pick', onclick: () => pdfIn.click() }, icon('upload'), h('b', null, 'Choose PDFs'), h('span', { class: 'foot' }, 'Notes, mark schemes and past papers')),
      h('button', { type: 'button', class: 'pick', onclick: () => picIn.click() }, icon('photo'), h('b', null, 'Add photos'), h('span', { class: 'foot' }, 'Take or choose pictures of paper notes or papers, up to 30 at a time')),
      h('p', { class: 'foot' }, 'Add only what you are allowed to use for your own study, not paid question-bank questions. Only you, your AI and your own Claude can read your library.'),
      pdfIn, picIn] });
    pdfIn.addEventListener('change', () => { const files = [...pdfIn.files]; sh.close(); addPdfs(files, name.value.trim()); });
    picIn.addEventListener('change', () => { const files = [...picIn.files]; sh.close(); addPhotos(files, name.value.trim()); });
  }

  // ---------- one document
  function openDoc(d) {
    const sh = sheet({ title: d.title || 'File', body: loading(1), wide: true });
    const st = statusOf(d);
    const open = ['ready', 'indexing', 'uploaded', 'extracting', 'failed'].includes(d.status) ? linkBtn('Open the original', fileHref(d.id), 'tinted', 'out', true) : null;
    const read = d.status === 'ready' || d.status === 'indexing' ? btn('Read the text', () => { sh.close(); openPage({ docId: d.id, title: d.title, n: 1 }); }, 'primary', 'file') : null;
    const again = ['ready', 'indexing', 'failed'].includes(d.status) ? btn('Read again', e => busy(e.currentTarget, async () => {
      try { await post(`${docPath(d.id)}/reindex`, {}); toast(`Reading ${d.title} again.`); sh.close(); load(); } catch (err) { toast(err.message); }
    }), 'gray', 'refresh') : null;
    const server = ['uploaded', 'extracting', 'failed'].includes(d.status) ? btn('Read it on the server', e => busy(e.currentTarget, async () => {
      try { await post(`${docPath(d.id)}/extract`, {}); toast('The server is reading it.'); sh.close(); load(); } catch (err) { toast(err.message); }
    }), 'gray', 'bolt') : null;
    const remove = btn('Delete', async () => {
      sh.close();
      if (!(await confirmSheet({ title: `Delete ${d.title}?`, sub: 'The file and what Study Hub read from it are removed for good.', ok: 'Delete', danger: true }))) return;
      try { await del(docPath(d.id)); toast('Deleted'); load(); } catch (e) { toast(e.message); }
    }, 'danger', 'trash');
    const facts = [st.text, d.page_count ? plural(d.page_count, 'page') : null, d.n_passages ? plural(d.n_passages, 'passage') : null, d.bytes ? bytes(d.bytes) : null].filter(Boolean).join(' · ');
    sh.setBody(
      h('p', { class: 'foot' }, facts),
      d.status === 'refused' || d.status === 'failed' ? h('p', null, d.status_note || 'No reason was given.') : null,
      d.ocr_pending ? h('p', { class: 'foot' }, `${plural(d.ocr_pending, 'picture')} still being read into text. This takes a few minutes.`) : null,
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, read, open, again, server));
    sh.setActions(remove);
  }

  // ---------- one page of text, with the found passage and words marked
  function openPage({ docId, title, n, passage = null, q = '' }) {
    const body = h('div', { class: 'preview', tabindex: '-1' });
    const where = h('span', { class: 'grow foot' }, `Page ${n}`);
    const prev = btn('Previous', () => go(cur.prev), 'gray', 'back');
    const next = btn('Next', () => go(cur.next), 'gray', 'chevron');
    const link = linkBtn('Open the original', `${fileHref(docId)}#page=${n}`, 'tinted', 'out', true);
    const sh = sheet({ title: title || 'Page', body: [h('div', { class: 'row', style: 'gap:8px;align-items:center' }, prev, where, next), body], actions: [link], wide: true });
    let cur = { prev: null, next: null }, at = n, seq = 0, keep = passage;
    const go = page => { if (page) { at = page; keep = null; fetchPage(); } };
    async function fetchPage() {
      const my = ++seq;
      body.replaceChildren(loading(1));
      prev.disabled = next.disabled = true;
      try {
        const qs = new URLSearchParams();
        if (keep != null) qs.set('passage', String(keep));
        if (q) qs.set('q', q);
        const r = await get(`${API}/doc/${encodeURIComponent(docId)}/page/${at}${qs.toString() ? `?${qs}` : ''}`);
        if (my !== seq || sh.closed) return;
        cur = r;
        where.textContent = r.doc && r.doc.page_count ? `Page ${at} of ${r.doc.page_count}` : `Page ${at}`;
        prev.disabled = !r.prev; next.disabled = !r.next;
        link.href = `${fileHref(docId)}#page=${at}`;
        const t = r.page && r.page.text;
        if (!t || !t.trim()) { body.replaceChildren(h('p', { class: 'foot' }, r.page && r.page.kind === 'image' ? 'This page is a picture and its text has not been read yet.' : 'There is no text on this page. Open the original to see it.')); return; }
        const { nodes, first } = pageNodes(t, r.highlight, r.marks);
        body.replaceChildren(...nodes);
        if (first) requestAnimationFrame(() => first.scrollIntoView({ block: 'center' }));
      } catch (e) { if (my === seq && !sh.closed) body.replaceChildren(errorState(e, fetchPage)); }
    }
    fetchPage();
  }

  load();
  return () => { S.alive = false; clearTimeout(S.timer); clearTimeout(timer); onChange = () => {}; };
}
