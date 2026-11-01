import { seatCategories, placeSeats, DONUT, familySectors } from './donut.js';
import { labelPlace, nameLines, LABEL_PX, RING_NAME_PX, arcRadiusPx, moonPx, orbPx } from './families.js';
import { FOUNDATION_IDS, isFoundationCategory, ringCentre, RING_GAP } from '../shared/concept.js';

export const FOUNDATIONS = Object.freeze({ id: 'foundations', name: 'Foundations', members: Object.freeze([...FOUNDATION_IDS]) });
// Room between the donut's outer edge and the ring's galaxies, in world units (the gap between two families and more,
// so the ring reads as its own layer).
export const RING = Object.freeze({ gap: RING_GAP });

const TAU = 2 * Math.PI;
const START = -Math.PI / 2;
const order = id => { const i = FOUNDATION_IDS.indexOf(id); return i < 0 ? FOUNDATION_IDS.length : i; };

/** The clinical systems and the foundation systems, by index into ids (the ring's in discipline order). */
export function splitRing(ids) {
  const inner = [], outer = [];
  ids.forEach((id, k) => (isFoundationCategory(id) ? outer : inner).push(k));
  outer.sort((a, b) => order(ids[a]) - order(ids[b]) || a - b);
  return { inner, outer };
}

/**
 * The seating with the ring set apart: with no foundation systems (or nothing else), donut.js seatCategories as it was;
 * otherwise seatCategories over the clinical systems alone, with inner (its index -> k) and outer (the ring's k).
 */
export function seatWithRing(ids, S, opts = {}) {
  const { inner, outer } = splitRing(ids);
  if (!outer.length || !inner.length) return { ...seatCategories(ids, S, opts), inner: null, outer: [] };
  const K = ids.length, Ki = inner.length;
  const Si = new Float64Array(Ki * Ki);
  for (let a = 0; a < Ki; a++) for (let b = 0; b < Ki; b++) Si[a * Ki + b] = S[inner[a] * K + inner[b]];
  return { ...seatCategories(inner.map(k => ids[k]), Si, opts), inner, outer, K };
}

/**
 * Every system's place: the clinical donut by placeSeats (over its own systems), then the ring: each foundation galaxy
 * (radius R[k]) on one circle RING.gap clear of the donut's outer edge, wide enough for them all, gap apart, spread
 * evenly round from the top. opts: placeSeats' (gap, familyGap, holeBand, fam over every system).
 */
export function placeWithRing(seating, R, opts = {}) {
  if (!seating.inner) return placeSeats(seating.seats, seating.seatOf, R, opts);
  const { inner, outer, K } = seating;
  const gap = opts.gap ?? DONUT.gap;
  const P = placeSeats(seating.seats, seating.seatOf, inner.map(k => R[k]), { ...opts, fam: opts.fam ? inner.map(k => opts.fam[k]) : null });
  const x = new Float64Array(K), y = new Float64Array(K);
  let reach = 0;
  inner.forEach((k, j) => { x[k] = P.x[j]; y[k] = P.y[j]; reach = Math.max(reach, Math.hypot(P.x[j], P.y[j]) + R[k]); });
  const Ro = outer.map(k => R[k]);
  const maxR = Math.max(...Ro);
  // the ring: clear of the donut, and long enough for every galaxy across plus a gap between each two
  const need = Ro.reduce((t, r) => t + 2 * r + gap, 0);
  const rho = Math.max(reach + RING.gap + maxR, need / TAU);
  // each galaxy takes its share of the ring, the slack shared equally, the first centred at the top
  const slack = (TAU * rho - need) / outer.length;
  let a = START - (2 * Ro[0] + gap + slack) / (2 * rho);
  const ang = [];
  outer.forEach((k, j) => {
    const w = (2 * Ro[j] + gap + slack) / rho;
    a += w / 2; ang.push(a);
    x[k] = rho * Math.cos(a); y[k] = rho * Math.sin(a);
    a += w / 2;
  });
  const half = Math.asin(Math.min(1, maxR / rho));
  return { x, y, rho: [...P.rho, rho], hole: P.hole, turn: P.turn,
    wedges: [...P.wedges.map(w => ({ ...w, members: w.members.map(j => inner[j]) })), { key: FOUNDATIONS.id, a0: ang[0] - half, a1: ang[ang.length - 1] + half, members: [...outer], ring: true }] };
}

// ringCentre lives beside the ids (shared/concept.js), so the Worker's positions.js reads it without the donut.
export { ringCentre };

export const RING_SCREEN = Object.freeze({
  margin: 12,        // clear sky between a family name (or the arcs) and a foundation orb, in screen px
  orbPad: 6,         // an orb's glow beyond its outermost dot, in screen px
  band: 4,           // and a little more past the names' anchor radius, so the ring reads as the next layer out
  turn: 0.22,        // the ring may turn this far (radians, either way) so no orb lands on a family name's line
  turnStep: 0.01,
  worth: 8,          // a turn is taken only when it brings the ring at least this many px closer
  maxGap: 80,        // the most px between the names and the ring (the test holds the rule to it; 60 before the orbs were spaced out)
  charPx: 7.6, charPxNarrow: 7.3,   // a name's width per letter, a little over (13 px bold; 12 px on a phone)
  rowGap: 16,        // upright: px between two names in a row
});
const SLOT = TAU / FOUNDATION_IDS.length;
/** A foundation system's direction from the donut's middle (radians, screen: clockwise from +x). */
export const slotAngle = (slot, { turn = 0 } = {}) => START + slot * SLOT + turn;
// Upright (a phone), the names at the sides already reach the screen's edges, so an orb beyond them would shrink the
// whole map to a coin: the seven sit in a row just above the family names (Anatomy, Physiology, Pathology) and a row
// just below them (Biochem, Immunology, Micro, Pharm), in the ring's clockwise order, each name over or under its orb.
export const UPRIGHT_ROWS = Object.freeze([Object.freeze([6, 0, 1]), Object.freeze([5, 4, 3, 2])]);

/** The family names' boxes in screen px round the donut's centre at zoom k, as families.js places them. Pure. */
export function familyLabelBoxes(sec, k, { narrow = false } = {}) {
  if (!sec) return [];
  const lh = 15;
  return sec.sectors.map(s => {
    const rl = arcRadiusPx(sec, k, narrow) + LABEL_PX;
    const mid = (s.a0 + s.a1) / 2, L = labelPlace(mid), lines = nameLines(s.name, narrow), n = lines.length;
    const w = Math.max(...lines.map(l => l.length)) * (narrow ? RING_SCREEN.charPxNarrow : RING_SCREEN.charPx);
    const x = rl * Math.cos(mid), y = rl * Math.sin(mid);
    const first = L.baseline === 'alphabetic' ? -(n - 1) * lh : L.baseline === 'middle' ? -((n - 1) * lh) / 2 : 0;
    const bx = L.anchor === 'start' ? x : L.anchor === 'end' ? x - w : x - w / 2;
    const top = y + first - (L.baseline === 'alphabetic' ? 12 : L.baseline === 'middle' ? 7 : 0);
    return { id: s.id, x: bx, y: top, w, h: (n - 1) * lh + 15 };
  });
}
const hits = (b, cx, cy, r) => Math.hypot(cx - Math.max(b.x, Math.min(cx, b.x + b.w)), cy - Math.max(b.y, Math.min(cy, b.y + b.h))) < r;

/** The foundation galaxies now: [{c, id, slot, x, y, R, list}] (centre of their placed dots, reach). */
function ringGalaxies(model) {
  const by = new Map();
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    const cat = model.cats[model.cat[i]];
    if (!cat || !isFoundationCategory(cat.id)) continue;
    if (!by.has(model.cat[i])) by.set(model.cat[i], { c: model.cat[i], id: cat.id, name: cat.short || cat.name || cat.id, slot: Math.max(0, FOUNDATION_IDS.indexOf(cat.id)), list: [] });
    by.get(model.cat[i]).list.push(i);
  }
  return [...by.values()].map(g => {
    const x = g.list.reduce((t, i) => t + model.x[i], 0) / g.list.length, y = g.list.reduce((t, i) => t + model.y[i], 0) / g.list.length;
    let R = 0;
    for (const i of g.list) R = Math.max(R, Math.hypot(model.x[i] - x, model.y[i] - y) + (model.r[i] || 0));
    return { ...g, x, y, R };
  });
}
export const COLLIDE_PAD = 6;
const sunflower = (n, c) => Array.from({ length: n }, (_, q) => { const d = q ? c * Math.sqrt(q) : 0, a = q * 2.39996; return [d * Math.cos(a), d * Math.sin(a)]; });
/** The sunflower's step for n dots of radius r: the least that keeps every two dots 2 r + 2 x COLLIDE_PAD apart. Pure. */
export function packStep(n, r) {
  const want = 2 * r + 2 * COLLIDE_PAD;
  let c = want / 2;
  for (let it = 0; it < 200; it++) {
    const p = sunflower(n, c);
    let min = Infinity;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) min = Math.min(min, Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]));
    if (min >= want - 1e-9) return c;
    c *= 1.03;
  }
  return c;
}
const packed = (model, list) => { const r = Math.max(...list.map(i => model.r[i] || 2.25)); return sunflower(list.length, packStep(list.length, r)); };
const packedR = (model, list) => { const r = Math.max(...list.map(i => model.r[i] || 2.25)); return packStep(list.length, r) * Math.sqrt(Math.max(0, list.length - 1)) + r; };

/**
 * Where the ring goes on screen at zoom k (screen = world x k): {rho (world, the farthest orb's centre), turn, labelR (world,
 * the family names' anchor), boxes, gals: [{c, slot, x, y, R, rho, offsets}]}, or null with no family arcs or no
 * foundation galaxy. Each galaxy keeps its seventh of the circle (discipline order from the top, clockwise), turned
 * at most RING_SCREEN.turn when that brings the orbs closer; each sits just past the names' band, further out only
 * where a family name would touch the orb or its own name. Pure.
 */
export function ringOnScreen(model, { k, narrow = false, portrait = false } = {}) {
  const sec = familySectors(model);
  const gals = ringGalaxies(model);
  if (!sec || !gals.length || !(k > 0)) return null;
  const S = RING_SCREEN;
  for (const g of gals) {
    // each orb packed round its middle by the clinical spacing rule (packed above)
    // always packed by the clinical spacing rule: the saved places were laid for smaller dots (data.js FOUNDATION_TIER)
    g.offsets = packed(model, g.list); g.R = packedR(model, g.list);
  }
  const boxes = familyLabelBoxes(sec, k, { narrow });
  const grown = boxes.map(b => ({ x: b.x - S.margin, y: b.y - S.margin, w: b.w + 2 * S.margin, h: b.h + 2 * S.margin }));
  const labelPx = arcRadiusPx(sec, k, narrow) + LABEL_PX;
  const cw = narrow ? S.charPxNarrow : S.charPx;
  if (portrait) {
    // two rows: just past the names (and the arcs) above and below, each orb as wide as its name, a gap between
    const rim = arcRadiusPx(sec, k, narrow);
    const top = Math.min(-rim, ...boxes.map(b => b.y)) - S.margin, bottom = Math.max(rim, ...boxes.map(b => b.y + b.h)) + S.margin;
    UPRIGHT_ROWS.forEach((row, q) => {
      const list = row.map(slot => gals.find(g => g.slot === slot)).filter(Boolean);
      const wid = list.map(g => Math.max(g.name.length * cw, 2 * (orbPx(g.R, k, true) + S.orbPad)));
      let x = -(wid.reduce((t, v) => t + v, 0) + S.rowGap * (list.length - 1)) / 2;
      list.forEach((g, j) => {
        const rp = orbPx(g.R, k, true) + S.orbPad;
        g.px = [x + wid[j] / 2, q === 0 ? top - rp : bottom + rp];
        x += wid[j] + S.rowGap;
      });
    });
    for (const g of gals) { g.rho = Math.hypot(g.px[0], g.px[1]) / k; g.at = [g.px[0] / k, g.px[1] / k]; }
    return { rho: Math.max(...gals.map(g => g.rho)), turn: 0, portrait: true, labelR: labelPx / k, k, boxes, sec, gals };
  }
  // Every family's arc is on one circle (families.js arcRadiusPx), inside the names' band, so an orb past the band
  // clears every arc.
  // each orb's least radius (px, its centre) with the ring turned by t: past the names' band, then out until neither
  // the orb nor its own name (the room the ring keeps for a name beside it) touches a family name or arc
  const radii = t => gals.map(g => {
    // (the orb's dots clear the names by the margin; its disc, a little wider, may reach into that margin)
    const a = slotAngle(g.slot, { turn: t }), rp = g.R * k + S.orbPad, c = Math.cos(a), sn = Math.sin(a);
    const L = labelPlace(a), w = g.name.length * cw, off = orbPx(g.R, k) + RING_NAME_PX;
    const clear = d => {
      if (grown.some(b => hits(b, d * c, d * sn, rp))) return false;
      const nx = (d + off) * c, ny = (d + off) * sn;
      const bx = L.anchor === 'start' ? nx : L.anchor === 'end' ? nx - w : nx - w / 2;
      const by = ny - (L.baseline === 'alphabetic' ? 12 : L.baseline === 'middle' ? 7 : 0);
      return !boxes.some(b => bx < b.x + b.w + S.margin && bx + w > b.x - S.margin && by < b.y + b.h + S.margin && by + 15 > b.y - S.margin);
    };
    let d = labelPx + S.band + S.margin + rp;
    for (let it = 0; it < 600 && !clear(d); it++) d += 1;
    return d;
  });
  const cost = list => Math.max(...list) * 100 + list.reduce((t, d) => t + d, 0) / list.length;
  let turn = 0, best = radii(0), bestCost = cost(best);
  const plain = bestCost;
  for (let t = S.turnStep; t <= S.turn + 1e-9; t += S.turnStep) for (const tt of [t, -t]) {
    const v = radii(tt), cv = cost(v);
    if (cv < bestCost - 0.5 && plain - cv >= S.worth * 100) { best = v; bestCost = cv; turn = tt; }
  }
  const one = Math.max(...best);
  gals.forEach(g => { g.rho = one / k; });
  return { rho: one / k, turn, portrait, labelR: labelPx / k, k, boxes, sec, gals };
}

/** Moves each foundation galaxy's dots to its place in plan (ringOnScreen). In place; returns the model. */
export function applyRing(model, plan) {
  if (!plan) return model;
  for (const g of plan.gals) {
    const a = slotAngle(g.slot, plan), cx = g.at ? g.at[0] : g.rho * Math.cos(a), cy = g.at ? g.at[1] : g.rho * Math.sin(a);
    g.list.forEach((i, q) => { model.x[i] = cx + g.offsets[q][0]; model.y[i] = cy + g.offsets[q][1]; });
  }
  return model;
}

/**
 * The ring placed for the screen: the zoom the whole map will be fitted at (kOf(), read again after each move,
 * since the ring itself widens the map) and the ring settle together in a few rounds. Display only. Returns the
 * last plan (null when there is no ring to place).
 */
export function placeRing(model, { kOf, narrow = false, portrait = false, rounds = 8 } = {}) {
  let k = kOf(), plan = null;
  for (let q = 0; q < rounds && k > 0; q++) {
    plan = ringOnScreen(model, { k, narrow, portrait });
    if (!plan) return null;
    applyRing(model, plan);
    const k2 = kOf();
    if (Math.abs(k2 - k) <= 0.002 * k) break;
    k = k2;
  }
  return plan;
}

/**
 * The whole-map zoom a sideways screen of view {w, h} gets (main.js mapBounds, then the camera's fit), from the
 * placed dots: an estimate for Home's tile and the tests; the map page passes its own. Pure.
 */
export function fitK(model, view = { w: 1440, h: 900 }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    const r = model.r[i] || 0;
    x0 = Math.min(x0, model.x[i] - r); y0 = Math.min(y0, model.y[i] - r); x1 = Math.max(x1, model.x[i] + r); y1 = Math.max(y1, model.y[i] + r);
  }
  if (!Number.isFinite(x0)) return 0;
  const { w, h } = view, bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const k0 = Math.max(1e-3, Math.min((w - 96) / bw, (h - 140) / bh));
  const mx = (w < 640 ? Math.min(100, w * 0.24) : Math.min(150, w * 0.12)) / k0, my = (w < 640 ? 46 : 34) / k0;
  const pad = w < 640 ? 24 : 48;
  return Math.max(1e-4, Math.min((w - 2 * pad) / (bw + 2 * mx), (h - 2 * pad) / (bh + 2 * my + 46 / k0)));
}
