// The exam paper itself on screen (Exams): every page of the PDF in their library, drawn by pdf.js (the library's
// own copy, pinned with SRI) as it scrolls into view, so a long paper opens at once on a phone or iPad. Also one page,
// cropped, for a topic's pictures (pictures.js).
import { h } from './kit.js';
import { loadPdfJs } from './library.js';

const fileUrl = id => `/api/p/library/docs/${encodeURIComponent(id)}/file`;

/** {el, goTo(page)}: a scrolling column of pages. */
export function pdfPane(docId) {
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
    } catch { slot.done = false; }
  };

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
    const ratio = (() => { const v = first.getViewport({ scale: 1 }); return v.height / v.width; })();
    pagesBox.replaceChildren();
    for (let n = 1; n <= doc.numPages; n++) {
      const s = { n, done: false, el: h('div', { class: 'pdf-page', dataset: { page: String(n) } }) };
      s.el.style.minHeight = `${Math.round((pagesBox.clientWidth || 600) * ratio)}px`;
      slots.push(s);
      pagesBox.append(s.el);
    }
    io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) draw(slots[Number(e.target.dataset.page) - 1]); }, { root: el, rootMargin: '600px 0px' });
    for (const s of slots) io.observe(s.el);
  })();

  return {
    el,
    goTo(n) {
      const s = slots[Math.max(1, Math.min(slots.length, Number(n) || 1)) - 1];
      if (!s) return;
      draw(s);
      el.scrollTo({ top: s.el.offsetTop - 8, behavior: 'smooth' });
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
