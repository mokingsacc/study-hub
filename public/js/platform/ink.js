// Writing on the exam with a pencil (Exams; the server side is worker/src/platform/ink.js). An ink layer over each PDF
// page: the Apple Pencil (or a mouse) writes, a finger scrolls, so a resting hand leaves no marks; "Finger writes" lets a
// finger write instead. Pen, eraser (a touched stroke goes), undo. Each page saves itself a moment after the pencil
// lifts, with a picture of the page and its writing for their Claude to mark; leaving the page or the iPad sleeping saves
// at once. Strokes are kept in fractions of the page width, so a turned iPad or another screen draws them the same.
import { h, btn, toast } from './kit.js';
import { put, get } from './api.js';
import { drawStroke, strokesNear } from './ink-core.js';

const PEN = { c: '#111111', w: 0.0021 };
const SAVE_MS = 1500;
const PICTURE_WIDTH = 1400;

/**
 * The ink for one paper or library document (base: its ink address, ending in /): attach(n, pageEl, pdfCanvas) from
 * pdfPane's onPage; tools (the bar); flush(); close().
 * written: the pages already written on (only those are fetched); readOnly: no tools, the writing only.
 */
export function inkBoard(base, { written = [], readOnly = false } = {}) {
  const pages = new Map();
  const has = new Set(written.map(Number));
  const history = [];
  let tool = 'pen', finger = false, alive = true, locked = false;
  const status = h('span', { class: 'foot ink-status', 'aria-live': 'polite' }, has.size ? '' : 'Write with your pencil. A finger scrolls.');

  const paint = pg => { if (!pg.g) return; pg.g.clearRect(0, 0, pg.cv.width, pg.cv.height); for (const s of pg.strokes) drawStroke(pg.g, s, pg.cv.width); };
  const anyDirty = () => [...pages.values()].some(pg => pg.dirty || pg.saving);

  async function picture(pg) {
    const k = Math.min(1, PICTURE_WIDTH / pg.pdf.width);
    const c = h('canvas', { width: Math.round(pg.pdf.width * k), height: Math.round(pg.pdf.height * k) });
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(pg.pdf, 0, 0, c.width, c.height);
    for (const s of pg.strokes) drawStroke(g, s, c.width);
    return new Promise(res => c.toBlob(res, 'image/jpeg', 0.75));
  }

  async function save(pg) {
    clearTimeout(pg.timer);
    if (!pg.dirty || locked) return;
    if (pg.saving) { await pg.saving; return save(pg); }
    pg.dirty = false;
    status.textContent = 'Saving…';
    pg.saving = (async () => {
      const fd = new FormData();
      fd.append('strokes', JSON.stringify(pg.strokes));
      if (pg.strokes.length && pg.pdf) { const b = await picture(pg); if (b) fd.append('image', b, `page-${pg.n}.jpg`); }
      await put(base + pg.n, fd);
    })();
    try { await pg.saving; if (!anyDirty()) status.textContent = 'Saved'; }
    catch (e) {
      if (/locked/i.test(e.message)) { locked = true; status.textContent = 'Marking has started, so the writing is locked.'; toast(e.message); }
      else { pg.dirty = true; status.textContent = 'Not saved yet. Trying again…'; pg.timer = setTimeout(() => save(pg), 5000); }
    } finally { pg.saving = null; }
  }
  const changed = pg => { pg.dirty = true; status.textContent = 'Saving…'; clearTimeout(pg.timer); pg.timer = setTimeout(() => save(pg), SAVE_MS); };
  const remember = (pg, before) => { history.push({ n: pg.n, before }); if (history.length > 300) history.shift(); changed(pg); };

  function wire(pg) {
    const cv = pg.cv;
    // A finger scrolls the paper; the pencil's touches are kept from scrolling so they write (iPad Safari: touchType).
    const keep = e => { if (finger || [...e.touches].some(t => t.touchType === 'stylus')) e.preventDefault(); };
    cv.addEventListener('touchstart', keep, { passive: false });
    cv.addEventListener('touchmove', keep, { passive: false });
    const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width]; };
    const allowed = e => e.pointerType === 'pen' || e.pointerType === 'mouse' || (finger && e.pointerType === 'touch');
    let cur = null, before = null, erased = false;
    const eraseAt = ([x, y]) => {
      const hit = strokesNear(pg.strokes, x, y);
      if (!hit.length) return false;
      pg.strokes = pg.strokes.filter((_, i) => !hit.includes(i));
      paint(pg);
      return true;
    };
    cv.addEventListener('pointerdown', e => {
      if (!allowed(e) || !pg.loaded || locked || e.button > 0) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* old browser */ }
      before = pg.strokes.slice();
      const pt = at(e);
      if (tool === 'erase') { cur = { erase: true }; erased = eraseAt(pt); return; }
      cur = { c: PEN.c, w: PEN.w, p: pt };
      pg.strokes.push(cur);
      drawStroke(pg.g, { ...cur, p: [...pt, ...pt] }, cv.width);
    });
    cv.addEventListener('pointermove', e => {
      if (!cur) return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      for (const ev of (list.length ? list : [e])) {
        const pt = at(ev);
        if (cur.erase) { erased = eraseAt(pt) || erased; continue; }
        const n = cur.p.length;
        if (Math.hypot(pt[0] - cur.p[n - 2], pt[1] - cur.p[n - 1]) < 0.0007) continue;
        const g = pg.g, W = cv.width;
        g.strokeStyle = cur.c; g.lineWidth = Math.max(1, cur.w * W); g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(cur.p[n - 2] * W, cur.p[n - 1] * W); g.lineTo(pt[0] * W, pt[1] * W); g.stroke();
        cur.p.push(pt[0], pt[1]);
      }
    });
    const end = () => {
      if (!cur) return;
      if (cur.erase) { if (erased) remember(pg, before); }
      else { if (cur.p.length === 2) cur.p.push(cur.p[0], cur.p[1]); paint(pg); remember(pg, before); }
      cur = null; erased = false;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
  }

  function attach(n, el, pdfCanvas) {
    if (!alive) return;
    let pg = pages.get(n);
    if (!pg) {
      pg = { n, strokes: [], loaded: !has.has(n), dirty: false };
      pages.set(n, pg);
      if (!pg.loaded) get(base + n).then(r => { pg.strokes = r.strokes || []; pg.loaded = true; paint(pg); })
        .catch(() => { status.textContent = `Page ${n}'s writing could not be loaded. Reload to try again.`; });
    }
    pg.pdf = pdfCanvas;
    pg.cv = h('canvas', { class: 'ink-canvas', width: pdfCanvas.width, height: pdfCanvas.height, 'aria-hidden': 'true' });
    if (readOnly) pg.cv.style.pointerEvents = 'none';
    pg.cv.style.touchAction = finger ? 'none' : '';
    pg.g = pg.cv.getContext('2d');
    el.append(pg.cv);
    if (pg.loaded) paint(pg);
    if (!readOnly) wire(pg);
  }

  const flush = () => Promise.all([...pages.values()].map(pg => (pg.dirty ? save(pg) : pg.saving)).filter(Boolean));
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', flush);

  const seg = (label, iconName, on, onclick) => {
    const b = btn(label, onclick, on ? 'tinted' : 'gray', iconName, { cls: 'btn-sm' });
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  const toolsBox = h('div', { class: 'ink-tools', role: 'toolbar', 'aria-label': 'Writing tools' });
  const drawTools = () => toolsBox.replaceChildren(
    seg('Pen', 'pencil', tool === 'pen', () => { tool = 'pen'; drawTools(); }),
    seg('Eraser', 'close', tool === 'erase', () => { tool = 'erase'; drawTools(); }),
    btn('Undo', () => {
      const last = history.pop();
      if (!last) { toast('Nothing to undo.'); return; }
      const pg = pages.get(last.n);
      if (!pg) return;
      pg.strokes = last.before; paint(pg); changed(pg);
    }, 'gray', 'undo', { cls: 'btn-sm' }),
    seg('Finger writes', 'type', finger, () => { finger = !finger; for (const pg of pages.values()) if (pg.cv) pg.cv.style.touchAction = finger ? 'none' : ''; drawTools(); }),
    status);
  if (!readOnly) drawTools();

  return {
    attach, flush,
    tools: readOnly ? null : toolsBox,
    written: () => [...pages.values()].filter(pg => pg.strokes.length).map(pg => pg.n).concat([...has].filter(n => !pages.has(n))).sort((a, b) => a - b),
    close() { alive = false; flush(); document.removeEventListener('visibilitychange', onHide); removeEventListener('pagehide', flush); for (const pg of pages.values()) clearTimeout(pg.timer); },
  };
}
