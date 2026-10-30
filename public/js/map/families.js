import { familySectors } from './donut.js';

const NS = 'http://www.w3.org/2000/svg';
export const RIM_PX = 9, LABEL_PX = 16;   // the arc just outside the outer ring, the name beyond it (screen px)
export const NAMES_UNTIL = 1.6;

/** An arc of radius r from a0 to a1 round (cx, cy). Pure. */
export function arcPath(cx, cy, r, a0, a1) {
  const P = a => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `M${P(a0)}A${r.toFixed(1)},${r.toFixed(1)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${P(a1)}`;
}
/** A family's name as lines: one line, or on a narrow screen a long name split after its "&" ("Infection &", "immunity"). */
export const nameLines = (name, narrow = false) => (narrow && / & /.test(name) ? [name.slice(0, name.indexOf(' & ') + 2), name.slice(name.indexOf(' & ') + 3)] : [name]);
/**
 * Boxes that together cover a circle (the donut's hole) closely, for the name placer, which keeps names out of boxes:
 * a cross of two bars and a square, inside the circle grown by pad. Pure.
 */
export function holeBoxes(hole, pad = 2) {
  if (!hole || !(hole.r > 4)) return [];
  const r = hole.r + pad, a = 0.92 * r, b = 0.39 * r, c = 0.71 * r;
  return [{ x: hole.x - a, y: hole.y - b, w: 2 * a, h: 2 * b }, { x: hole.x - b, y: hole.y - a, w: 2 * b, h: 2 * a }, { x: hole.x - c, y: hole.y - c, w: 2 * c, h: 2 * c }];
}
/** Where a family's name sits for a wedge's middle angle: its anchor and baseline, so it reads clear of the arc. */
export function labelPlace(mid) {
  const c = Math.cos(mid), s = Math.sin(mid);
  return { anchor: c > 0.35 ? 'start' : c < -0.35 ? 'end' : 'middle', baseline: s > 0.3 ? 'hanging' : s < -0.3 ? 'alphabetic' : 'middle' };
}

export function createFamilies(root) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'map-families');
  svg.setAttribute('aria-hidden', 'true');
  const sky = root.querySelector('.map-sky');
  if (sky) sky.after(svg); else root.prepend(svg);
  let key = '', sec = null, secFor = null, els = [], boxes = [], hole = null;

  function build(list) {
    svg.textContent = '';
    els = list.map(s => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `map-fam is-${s.id}`);
      const arc = document.createElementNS(NS, 'path'); arc.setAttribute('class', 'map-fam-arc');
      const text = document.createElementNS(NS, 'text'); text.setAttribute('class', 'map-fam-name');
      g.append(arc, text);
      svg.append(g);
      return { id: s.id, name: s.name, arc, text, lines: '' };
    });
  }

  /**
   * Draws the wedges for the model as the camera shows it: cam {k, x, y} (screen = x + k · world). show: false hides
   * them (an older layout, the first arrange, a spot). moved: the stars moved since the last call (a glide).
   */
  function update(model, cam, { show = true, moved = false, dim = false, view = null, ratio = 1 } = {}) {
    if (!show || !model || !cam) { if (!svg.hidden) svg.setAttribute('hidden', ''); key = ''; boxes = []; hole = null; return; }
    if (moved || secFor !== model) { sec = familySectors(model); secFor = model; key = ''; if (sec) { const ids = sec.sectors.map(s => s.id).join(); if (ids !== svg.dataset.ids) { build(sec.sectors); svg.dataset.ids = ids; } } }
    if (!sec) { svg.setAttribute('hidden', ''); boxes = []; hole = null; return; }
    svg.removeAttribute('hidden');
    svg.classList.toggle('is-dim', !!dim);
    const close = ratio > NAMES_UNTIL;
    svg.classList.toggle('is-close', close);
    const narrow = !!view && view.w < 640;
    const k2 = `${cam.k.toFixed(5)}|${cam.x.toFixed(1)}|${cam.y.toFixed(1)}|${els.length}|${view ? `${view.w}x${view.h}` : ''}|${close ? 1 : 0}`;
    if (k2 === key) return;
    key = k2;
    const cx = cam.x + cam.k * sec.cx, cy = cam.y + cam.k * sec.cy;
    const r1 = sec.r1 * cam.k + 4;
    hole = sec.r0 > 0 ? { x: cx, y: cy, r: sec.r0 * cam.k } : null;
    boxes = [];
    sec.sectors.forEach((s, q) => {
      const e = els[q];
      if (!e) return;
      // exactly over the family's wedge (v7: the hull of its galaxies, so every one of them sits under its own arc)
      e.arc.setAttribute('d', arcPath(cx, cy, r1 + RIM_PX, s.a0, s.a1));
      const mid = (s.a0 + s.a1) / 2, L = labelPlace(mid), rl = r1 + RIM_PX + LABEL_PX;
      // the name's lines (two on a narrow screen when it is long), stacked away from the arc
      const lines = nameLines(e.name, narrow);
      if (lines.join('|') !== e.lines) {
        e.lines = lines.join('|');
        e.text.textContent = '';
        for (const l of lines) { const t = document.createElementNS(NS, 'tspan'); t.textContent = l; e.text.append(t); }
      }
      let x = cx + rl * Math.cos(mid);
      const y = cy + rl * Math.sin(mid), lh = 15, n = lines.length;
      const first = L.baseline === 'alphabetic' ? -(n - 1) * lh : L.baseline === 'middle' ? -((n - 1) * lh) / 2 : 0;
      // kept on the screen: a name near the edge slides in along its line (its width read once per text)
      if (view) {
        if (e.w == null || e.wFor !== e.lines) { e.wFor = e.lines; try { e.w = Math.max(...[...e.text.childNodes].map(t => t.getComputedTextLength())); } catch (err) { e.w = 7 * Math.max(...lines.map(l => l.length)); } }
        const left = L.anchor === 'start' ? x : L.anchor === 'end' ? x - e.w : x - e.w / 2;
        x += Math.max(0, 6 - left) - Math.max(0, left + e.w - (view.w - 6));
      }
      [...e.text.childNodes].forEach((t, q) => { t.setAttribute('x', x.toFixed(1)); t.setAttribute('y', (y + first + q * lh).toFixed(1)); });
      // its box on screen (canvas px), so beads and topic names keep clear of it
      const w = e.w != null ? e.w : 7 * Math.max(...lines.map(l => l.length));
      const bx = L.anchor === 'start' ? x : L.anchor === 'end' ? x - w : x - w / 2;
      const top = y + first - (L.baseline === 'alphabetic' ? 12 : L.baseline === 'middle' ? 7 : 0);
      if (!close) boxes.push({ x: bx - 2, y: top - 2, w: w + 4, h: (n - 1) * lh + 15 + 4 });
      e.text.setAttribute('text-anchor', L.anchor);
      e.text.setAttribute('dominant-baseline', L.baseline);
    });
  }
  return {
    update,
    /** The wedges as last worked out (for local checks): {cx, cy, r0, r1, sectors} in world units, or null. */
    get sectors() { return sec; },
    /** The family names' boxes on screen as last drawn (canvas px): beads and topic names keep clear of them. */
    get boxes() { return boxes; },
    /** The donut's empty middle on screen as last drawn, {x, y, r} in canvas px (null when no donut is shown): no
     *  bead and no topic name goes into it. */
    get hole() { return hole; },
    destroy() { svg.remove(); },
  };
}
