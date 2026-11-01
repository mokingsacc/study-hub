// The exam paper itself on screen (Exams): every page of the PDF in their library, drawn by pdf.js (the library's
// own copy, pinned with SRI) as it scrolls into view, so a long paper opens at once on a phone or iPad. Also one page,
// cropped, for a topic's pictures (pictures.js).
import { h } from './kit.js';
import { loadPdfJs } from './library.js';

const fileUrl = id => `/api/p/library/docs/${encodeURIComponent(id)}/file`;

// A blank lined page (an extra page to write on, past the paper's last page), drawn like a page of the paper.
function blankPage(w, ratio, k) {
  const c = h('canvas', { class: 'pdf-canvas', width: Math.round(w), height: Math.round(w * ratio), 'aria-label': `Extra page ${k}` });
  c.style.aspectRatio = `${c.width} / ${c.height}`;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c9d3e0'; g.lineWidth = Math.max(1, c.width / 700);
  const gap = c.height / 34;
  for (let y = gap * 3; y < c.height - gap; y += gap) { g.beginPath(); g.moveTo(c.width * 0.07, y); g.lineTo(c.width * 0.93, y); g.stroke(); }
  g.fillStyle = '#667085'; g.font = `${Math.round(c.width / 45)}px system-ui, sans-serif`;
  g.fillText(`Extra page ${k}. Write the question number first.`, c.width * 0.07, gap * 1.8);
  return c;
}

/**
 * {el, goTo(page), addBlank(), close()}: a scrolling column of pages. opts.onPage(n, pageEl, canvas) runs when a page is
 * drawn (the pencil's ink layer, ink.js); opts.extra blank pages follow the paper's own.
 */
export function pdfPane(docId, opts = {}) {
  const pagesBox = h('div', { class: 'pdf-pages' }, h('p', { class: 'foot', style: 'padding:16px' }, 'Opening the paper…'));
  const el = h('div', { class: 'exam-pdf', role: 'region', 'aria-label': 'The exam paper' }, pagesBox);
  const slots = [];
  let doc = null, io = null, alive = true;

  const draw = async slot => {
    if (slot.done || !doc || !alive) return;
    slot.done = true;
    try {
      const page = await doc.getPage(slot.n);
      const w = Math.max(280, pagesBox.clientWidth - 2);
      const base = page.getViewport({ scale: 1 });
      const scale = (w / base.width) * Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale });
      const c = h('canvas', { class: 'pdf-canvas', width: Math.round(vp.width), height: Math.round(vp.height), 'aria-label': `Page ${slot.n}` });
      c.style.aspectRatio = `${vp.width} / ${vp.height}`;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      slot.el.replaceChildren(c, h('span', { class: 'pdf-num' }, `Page ${slot.n}`));
      slot.el.style.minHeight = '';
      page.cleanup();
      if (opts.onPage) opts.onPage(slot.n, slot.el, c);
    } catch { slot.done = false; }
  };
  const drawBlank = slot => {
    if (slot.done || !alive) return;
    slot.done = true;
    const w = Math.max(280, pagesBox.clientWidth - 2) * Math.min(2, window.devicePixelRatio || 1);
    const c = blankPage(w, ratio, slot.k);
    slot.el.replaceChildren(c, h('span', { class: 'pdf-num' }, `Extra page ${slot.k}`));
    slot.el.style.minHeight = '';
    if (opts.onPage) opts.onPage(slot.n, slot.el, c);
  };
  let ratio = 1.414;
  const addSlot = (n, k = 0) => {
    const s = { n, k, done: false, el: h('div', { class: 'pdf-page', dataset: { page: String(n) } }) };
    s.el.style.minHeight = `${Math.round((pagesBox.clientWidth || 600) * ratio)}px`;
    slots.push(s);
    pagesBox.append(s.el);
    if (io) io.observe(s.el);
    return s;
  };
  const show = s => (s.k ? drawBlank(s) : draw(s));

  (async () => {
    try {
      const lib = await loadPdfJs();
      doc = await lib.getDocument({ url: fileUrl(docId), withCredentials: true, isEvalSupported: false }).promise;
    } catch {
      pagesBox.replaceChildren(h('p', { class: 'foot', style: 'padding:16px' }, 'The paper could not be shown here. It may still be uploading; try again in a minute, or open it from your Library.'));
      return;
    }
    if (!alive) { doc.destroy(); return; }
    const first = await doc.getPage(1);
    ratio = (() => { const v = first.getViewport({ scale: 1 }); return v.height / v.width; })();
    pagesBox.replaceChildren();
    for (let n = 1; n <= doc.numPages; n++) addSlot(n);
    for (let k = 1; k <= (opts.extra || 0); k++) addSlot(doc.numPages + k, k);
    io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) show(slots[Number(e.target.dataset.page) - 1]); }, { root: el, rootMargin: '600px 0px' });
    for (const s of slots) io.observe(s.el);
    if (opts.onReady) opts.onReady(doc.numPages);
  })();

  return {
    el,
    goTo(n) {
      const s = slots[Math.max(1, Math.min(slots.length, Number(n) || 1)) - 1];
      if (!s) return;
      show(s);
      el.scrollTo({ top: s.el.offsetTop - 8, behavior: 'smooth' });
    },
    /** One more blank page at the end (at most 10): its page number, or null. */
    addBlank() {
      if (!doc) return null;
      const k = slots.filter(s => s.k).length + 1;
      if (k > 10) return null;
      const s = addSlot(doc.numPages + k, k);
      show(s);
      el.scrollTo({ top: s.el.offsetTop - 8, behavior: 'smooth' });
      return s.n;
    },
    close() { alive = false; if (io) io.disconnect(); if (doc) doc.destroy(); },
  };
}

// One page of a library PDF ({doc_id, page, crop?}) into a canvas `width` css px wide, cropped to the box (fractions of
// the page) when there is one. Each document is opened once a page view.
const opened = new Map();
export async function drawPage(p, width) {
  if (!opened.has(p.doc_id)) opened.set(p.doc_id, loadPdfJs().then(lib => lib.getDocument({ url: fileUrl(p.doc_id), withCredentials: true, isEvalSupported: false }).promise));
  const doc = await opened.get(p.doc_id);
  const page = await doc.getPage(p.page);
  const crop = p.crop || { x: 0, y: 0, w: 1, h: 1 };
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (width / (base.width * crop.w)) * Math.min(2, window.devicePixelRatio || 1) });
  const c = h('canvas', { width: Math.round(vp.width * crop.w), height: Math.round(vp.height * crop.h), 'aria-label': `Page ${p.page}` });
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.translate(-vp.width * crop.x, -vp.height * crop.y);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  page.cleanup();
  return c;
}
