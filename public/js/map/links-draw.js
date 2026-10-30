import { LINK_TYPES, TYPE_NAMES, FLAGS, MIXED_UP, A, B, TYPE, STRENGTH, CONFUSION, FLAG, isMixedRow } from '../shared/link-rank.js';

export const TOKENS = { link: '--map-link', hi: '--map-link-hi', ground: '--map-ground', helps: '--map-link-helps', harms: '--map-link-harms', causes: '--map-link-causes' };
// Night defaults (look's tokens), used when the page has not resolved them yet.
export const FALLBACK = { link: '#9cb0c5', hi: '#eef3f8', ground: '#111923', helps: '#22d3ee', harms: '#f472b6', causes: '#a78bfa' };
// Each topic-link type's hue when lit (link-kinds.js KINDS: treats helps, side effect harms, causes causes).
export const LINK_HUES = Object.freeze({ versus: null, treated_by: 'helps', adverse_effect: 'harms', causes: 'causes' });
/** A lit line's colour token key for a type name: 'hi' (a look-alike's neutral) or its hue. */
export const litInk = name => LINK_HUES[name] || 'hi';

// ------------------------------------------------------------------ the formulas

/** Hairline alpha by strength (0..1): 0.10 to 0.22; a suggested link at half. */
export const baseAlpha = (strength, proposed = false) => (0.10 + 0.12 * Math.max(0, Math.min(1, strength))) * (proposed ? 0.5 : 1);
/** A mixed-up pair's width in px: 1.2 + 1.3·min(1, (c − 0.5)/1.5). */
export const mixedWidth = c => 1.2 + 1.3 * Math.min(1, Math.max(0, (c - MIXED_UP) / 1.5));
/** A mixed-up pair's alpha: 0.75 + 0.2·min(1, c/2). */
export const mixedAlpha = c => 0.75 + 0.2 * Math.min(1, Math.max(0, c) / 2);
const OWN = new WeakMap();
export function ownLinks(m, i) {
  if (!m || i < 0) return [];
  let by = OWN.get(m);
  if (!by) OWN.set(m, (by = new Map()));
  if (!by.has(i)) by.set(i, m.links.map((l, k) => (l[A] === i || l[B] === i ? k : -1)).filter(k => k >= 0));
  return by.get(i);
}
/** Which links the map draws now: the open topic's own, else the density's choice. */
export const shownLinks = S => (S.selected >= 0 ? ownLinks(S.model, S.selected) : S.linkSel);

export const HAIRLINE = 0.6, HOVER_WIDTH = 1.25, HOVER_ALPHA = 0.85, CASING = 2, DIAMOND = 3.5, ARROW = 6;
// a lit look-alike: thin and fainter than the other lit types (the key's "faint thin neutral line")
export const LOOK_WIDTH = 1, LOOK_ALPHA = 0.55;
/** A lit plain (not mixed-up) line's look by type name: {ink: token key, width, alpha (before a proposed one's half)}. */
export const litLook = name => (name === 'versus' ? { ink: 'hi', width: LOOK_WIDTH, alpha: LOOK_ALPHA } : { ink: litInk(name), width: HOVER_WIDTH, alpha: HOVER_ALPHA });

// Hairline alphas rounded to steps of 0.02, so a frame needs only a handful of paths.
const step = a => Math.round(a * 50) / 50;

/** Resolves the three tokens from computed style (getComputedStyle(el)), with the night values as fallback. */
export function readTokens(style) {
  const get = name => (style && typeof style.getPropertyValue === 'function' ? String(style.getPropertyValue(name) || '').trim() : '');
  return Object.fromEntries(Object.keys(TOKENS).map(k => [k, get(TOKENS[k]) || FALLBACK[k]]));
}

// ------------------------------------------------------------------ paths

const newPath = () => (typeof Path2D === 'function' ? new Path2D() : null);

// A path builder that works with Path2D, or straight on the context where there is none.
function pathOn(ctx) {
  const p = newPath();
  const t = p || ctx;
  if (!p) ctx.beginPath();
  return {
    move: (x, y) => t.moveTo(x, y),
    line: (x, y) => t.lineTo(x, y),
    quad: (cx, cy, x, y) => t.quadraticCurveTo(cx, cy, x, y),
    close: () => t.closePath(),
    stroke: () => (p ? ctx.stroke(p) : ctx.stroke()),
    fill: () => (p ? ctx.fill(p) : ctx.fill()),
  };
}

const ends = (row, x, y) => [x[row[A]], y[row[A]], x[row[B]], y[row[B]]];
const finite = (...v) => v.every(Number.isFinite);

/**
 * Each thread's control point (concept 8a): a gentle bow within a galaxy, a wider one between galaxies, bowed
 * away from the middle of the map so the threads between systems do not all cross the centre. links: payload
 * rows; x, y: world positions; cat: each topic's category; centre: [x, y] of the map. Returns {qx, qy}
 * (Float32Array, by link index), worked out once per layout.
 */
export function buildCurves(links, x, y, cat, centre = [0, 0]) {
  const n = links ? links.length : 0;
  const qx = new Float32Array(n), qy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = links[i];
    const ax = x[r[A]], ay = y[r[A]], bx = x[r[B]], by = y[r[B]];
    const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
    const cross = cat && cat[r[A]] !== cat[r[B]];
    const bend = cross ? 0.17 : 0.07;
    let px = mx - dy * bend, py = my + dx * bend;
    if (cross) {
      const ox = mx + dy * bend, oy = my - dx * bend;
      if (Math.hypot(ox - centre[0], oy - centre[1]) > Math.hypot(px - centre[0], py - centre[1])) { px = ox; py = oy; }
    }
    qx[i] = px; qy[i] = py;
  }
  return { qx, qy };
}

/** A point on thread i at t (0 at a, 1 at b), straight when it has no bend. */
export function threadPoint(t, x1, y1, x2, y2, cx = null, cy = null) {
  if (cx == null) return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  const u = 1 - t;
  return [u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2];
}

function withStyle(ctx, { stroke, fill, width, alpha, dash = [], cap = 'butt' }, k, draw) {
  ctx.save();
  if (stroke) ctx.strokeStyle = stroke;
  if (fill) ctx.fillStyle = fill;
  if (width != null) ctx.lineWidth = width / k;
  ctx.globalAlpha = alpha;
  ctx.lineCap = cap;
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(dash.map(d => d / k));
  draw();
  ctx.restore();
}

function diamondAt(path, mx, my, s) {
  path.move(mx, my - s); path.line(mx + s, my); path.line(mx, my + s); path.line(mx - s, my); path.close();
}

// The arrowhead at b, set back by b's radius so it touches the node's edge.
function arrowAt(path, x1, y1, x2, y2, back, size) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!(len > back + size)) return;
  const ux = dx / len, uy = dy / len;
  const tx = x2 - ux * back, ty = y2 - uy * back;
  const bx = tx - ux * size, by = ty - uy * size;
  path.move(tx, ty); path.line(bx - uy * size * 0.5, by + ux * size * 0.5); path.line(bx + uy * size * 0.5, by - ux * size * 0.5); path.close();
}

/**
 * Draws the chosen links in one layer. 'base' is the constellation: hairlines by strength, then the mixed-up
 * pairs on top (casing, line, diamond). 'hover' and 'focus' draw each type in its own style with arrowheads.
 * Returns how many rows it drew (rows whose ends have no position are skipped).
 */
export function drawLinks(ctx, { links, indices, x, y, layer = 'base', tokens = FALLBACK, k = 1, radius = null, qx = null, qy = null, pairFade = 1 }) {
  if (!ctx || !links || !indices || !indices.length) return 0;
  const tk = { ...FALLBACK, ...(tokens || {}) };
  const s = 1 / (k || 1);
  const rows = [];
  const curved = !!(qx && qy);
  for (const i of indices) {
    const r = links[i];
    if (!r) continue;
    const e = ends(r, x, y);
    if (finite(...e)) rows.push([r, curved ? [...e, qx[i], qy[i]] : e]);
  }
  // A thread: a bow through its control point when the renderer gives one, else a straight line.
  const to = (p, e) => (e.length > 4 ? p.quad(e[4], e[5], e[2], e[3]) : p.line(e[2], e[3]));
  const mixed = rows.filter(([r]) => isMixedRow(r));
  const plain = rows.filter(([r]) => !isMixedRow(r));

  if (layer === 'base') {
    // Hairlines, one path per alpha step.
    const groups = new Map();
    for (const [r, e] of plain) {
      const a = step(baseAlpha(r[STRENGTH] / 100, !!(r[FLAG] & FLAGS.proposed)));
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(e);
    }
    for (const [alpha, list] of [...groups].sort((p, q) => p[0] - q[0])) {
      withStyle(ctx, { stroke: tk.link, width: HAIRLINE, alpha, cap: 'round' }, k, () => {
        const p = pathOn(ctx);
        for (const e of list) { p.move(e[0], e[1]); to(p, e); }
        p.stroke();
      });
    }
  } else {
    // Hover and focus: each type in its hue (a look-alike thin and neutral), arrowheads at b for directed types.
    for (const name of TYPE_NAMES) {
      const spec = LINK_TYPES[name], look = litLook(name), ink = tk[look.ink] || tk.hi;
      for (const proposed of [false, true]) {
        const list = plain.filter(([r]) => TYPE_NAMES[r[TYPE]] === name && !!(r[FLAG] & FLAGS.proposed) === proposed);
        if (!list.length) continue;
        const alpha = look.alpha * (proposed ? 0.5 : 1);
        withStyle(ctx, { stroke: ink, width: look.width, alpha, dash: spec.dash, cap: 'round' }, k, () => {
          const p = pathOn(ctx);
          for (const [, e] of list) { p.move(e[0], e[1]); to(p, e); }
          p.stroke();
        });
        if (spec.arrow) {
          withStyle(ctx, { fill: ink, alpha }, k, () => {
            const p = pathOn(ctx);
            // the arrow points along the thread's last stretch (from its control point when it bows)
            for (const [r, e] of list) arrowAt(p, e.length > 4 ? e[4] : e[0], e.length > 4 ? e[5] : e[1], e[2], e[3], (radius ? radius(r[B]) : 6) * s, ARROW * s);
            p.fill();
          });
        }
      }
    }
  }

  // Mixed-up pairs, on top in every layer: casing, then the line, then the diamond at the thread's middle.
  for (const [r, e] of mixed) {
    const [x1, y1, x2, y2] = e;
    const c = r[CONFUSION] / 100;
    const proposed = !!(r[FLAG] & FLAGS.proposed);
    const w = mixedWidth(c);
    const alpha = mixedAlpha(c) * (proposed ? 0.5 : 1) * pairFade;
    withStyle(ctx, { stroke: tk.ground, width: w + CASING, alpha: 0.9 * (proposed ? 0.5 : 1) * pairFade }, k, () => {
      const p = pathOn(ctx); p.move(x1, y1); to(p, e); p.stroke();
    });
    withStyle(ctx, { stroke: tk.hi, width: w, alpha }, k, () => {
      const p = pathOn(ctx); p.move(x1, y1); to(p, e); p.stroke();
    });
    if (!proposed) {
      const [mx, my] = threadPoint(0.5, x1, y1, x2, y2, e.length > 4 ? e[4] : null, e.length > 4 ? e[5] : null);
      withStyle(ctx, { fill: tk.hi, stroke: tk.ground, width: 1, alpha: pairFade }, k, () => {
        const p = pathOn(ctx);
        diamondAt(p, mx, my, DIAMOND * s);
        p.fill();
        p.stroke();
      });
    }
  }
  return rows.length;
}

// ------------------------------------------------------------------ picking and words

/** Distance from (px, py) to the segment, in the same units. */
export function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** The drawn link nearest (px, py) in world units, within tolPx screen pixels (6 by default), or -1. */
export function hitLink(px, py, { links, indices, x, y, k = 1, qx = null, qy = null }, tolPx = 6) {
  let best = -1, bestD = tolPx / (k || 1);
  for (const i of indices || []) {
    const r = links[i];
    if (!r) continue;
    const e = ends(r, x, y);
    if (!finite(...e)) continue;
    const d = qx && qy && finite(qx[i], qy[i]) ? curveDistance(px, py, ...e, qx[i], qy[i]) : segmentDistance(px, py, ...e);
    if (d <= bestD) { best = i; bestD = d; }
  }
  return best;
}

// The distance from a point to a drawn thread (the quadratic through its control point), as 16 short segments:
// a tap on a long bowed line lands on the curve, which can be far from the straight line between its ends.
const CURVE_STEPS = 16;
function curveDistance(px, py, x1, y1, x2, y2, cx, cy) {
  let d = Infinity, [ax, ay] = [x1, y1];
  for (let s = 1; s <= CURVE_STEPS; s++) {
    const [bx, by] = threadPoint(s / CURVE_STEPS, x1, y1, x2, y2, cx, cy);
    d = Math.min(d, segmentDistance(px, py, ax, ay, bx, by));
    ax = bx; ay = by;
  }
  return d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = day => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(day || '')); return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : ''; };

/**
 * The hover pill's words: the fact when it is known ('Versus vitamin A deficiency: dry eye …'), else what the
 * link is ('Retinitis pigmentosa and Vitamin A deficiency: mixed up'). a, b: the two topic names.
 */
export function pillText(row, { a = '', b = '', fact = null } = {}) {
  const name = TYPE_NAMES[row[TYPE]] || 'versus';
  const spec = LINK_TYPES[name];
  const tags = [];
  if (isMixedRow(row)) tags.push('mixed up');
  if (row[FLAG] & FLAGS.proposed) tags.push('suggested');
  const head = fact ? String(fact) : name === 'versus' ? `${a} and ${b}: ${spec.label.toLowerCase()}` : `${a}: ${spec.label.toLowerCase()} ${b}`;
  return tags.length ? `${head} (${tags.join(', ')})` : head;
}

/** Line samples for look's legend: one per type as it draws lit, plus the mixed-up pair with its diamond. */
export function legendSamples() {
  return [
    ...TYPE_NAMES.map(t => ({ type: t, label: LINK_TYPES[t].label, dash: LINK_TYPES[t].dash, width: litLook(t).width, alpha: litLook(t).alpha, ink: litLook(t).ink, arrow: !!LINK_TYPES[t].arrow, diamond: false })),
    { type: 'mixed', label: 'Mixed up', dash: [], width: mixedWidth(1.5), alpha: mixedAlpha(1.5), arrow: false, diamond: true },
  ];
}
