import { semanticLayout } from './semantic.js';

export const LAYOUT_VERSION = 7;
/** The first layout version on the donut: its seating is what Tidy starts from, and it is never re-packed upright. */
export const DONUT_FROM = 5;

export const FORCES = Object.freeze({
  catPack: 0.55, catGrow: 1.15, catPad: 40,          // R_c = sqrt(Σ(r+3)² / 0.55) · 1.15 (a category's first-guess disc)
  catLink: 0.06,                                     // category links: strength ∝ log(1 + cross links), scaled
  linkDistance: 30, linkStrength: 0.05,              // topic links within a category (a galaxy's own threads)
  charge: -9, chargeTheta: 0.9, chargeMax: 60,
  centre: 0.14, unitPull: 0.08, unitEvery: 10,       // pull towards the topic's unit centre
  ring: 0.42,                                        // the units' ring, as a share of the galaxy's packed radius
  collidePad: 6,                                     // world units between two stars
  tilt: 0.76,                                        // a galaxy's short axis, as a share of its long one
  titleRoom: 64, titleWidth: 230, boxGap: 40,        // each galaxy's box: room above it for its title, never narrower than one, and sky round it
  oval: [0.02, 0.034],                               // packing gravity (x, y): wider than tall, like a screen
  galaxyTicks: 300, settleTicks: 40, packTicks: 360,
  alphaDecay: 0.03, alphaMin: 0.002,
  chunk: 4,                                          // ticks per animation frame while galaxies settle
});

/** FNV-1a 32-bit (the Worker's positions.js has the same). */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** A small deterministic random source for d3 (a 32-bit LCG, as d3-force uses by default). */
export function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Category discs: [{c, R, n}] for every category with topics (index -1 gathers topics with none). */
export function categoryBodies(model) {
  const sums = new Map();
  for (let i = 0; i < model.n; i++) {
    const c = model.cat[i];
    const s = sums.get(c) || { c, area: 0, n: 0 };
    s.area += (model.r[i] + 3) ** 2;
    s.n++;
    sums.set(c, s);
  }
  return [...sums.values()].sort((a, b) => a.c - b.c).map(s => ({ c: s.c, n: s.n, R: Math.sqrt(s.area / FORCES.catPack) * FORCES.catGrow }));
}

/** Where each category starts: on one circle in category order, big enough for every disc side by side. */
export function seedCategories(bodies) {
  const total = bodies.reduce((a, b) => a + 2 * (b.R + FORCES.catPad), 0);
  const R = Math.max(150, total / (2 * Math.PI));
  return bodies.map((b, k) => {
    const th = (2 * Math.PI * k) / Math.max(1, bodies.length) - Math.PI / 2;
    return { ...b, x: R * Math.cos(th), y: R * Math.sin(th) };
  });
}

/** Where each topic starts: a sunflower spiral round its category's centre, in id-hash order. */
export function seedTopics(model, centres) {
  const by = new Map();
  for (let i = 0; i < model.n; i++) {
    const c = model.cat[i];
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(i);
  }
  const out = new Float64Array(model.n * 2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (const [c, list] of by) {
    const centre = centres.get(c) || { x: 0, y: 0 };
    list.sort((a, b) => fnv1a(model.id[a]) - fnv1a(model.id[b]) || (model.id[a] < model.id[b] ? -1 : 1));
    list.forEach((i, k) => {
      const rr = 9 * Math.sqrt(k + 0.5);
      const th = k * golden + (fnv1a(model.id[i]) % 360) * Math.PI / 180 * 0.01;
      out[2 * i] = centre.x + rr * Math.cos(th);
      out[2 * i + 1] = centre.y + rr * Math.sin(th);
    });
  }
  return out;
}

const round1 = v => Math.round(v * 10) / 10;

// The next chunk: on the next animation frame while the page shows, so the overlay stays smooth; through a
// message channel while it is hidden (animation frames stop in a background tab, and the layout runs once).
let channel = null;
const queued = [];
function nextChunk(fn) {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden && typeof requestAnimationFrame === 'function') { requestAnimationFrame(fn); return; }
  if (typeof MessageChannel !== 'function') { setTimeout(fn, 0); return; }
  if (!channel) { channel = new MessageChannel(); channel.port1.onmessage = () => { const f = queued.shift(); if (f) f(); }; }
  queued.push(fn);
  channel.port2.postMessage(0);
}

/** How many ticks a run takes from alpha 1 to alphaMin. */
export const totalTicks = (f = FORCES) => Math.ceil(Math.log(f.alphaMin) / Math.log(1 - f.alphaDecay));

/** The units of one category's topics, in a fixed order: [unit index, ...], -1 (no unit) last. */
function unitsOf(model, list) {
  const seen = new Map();
  for (const i of list) { const u = model.unit[i]; if (!seen.has(u)) seen.set(u, seen.size); }
  return [...seen.keys()].sort((a, b) => (a < 0) - (b < 0) || a - b);
}

/**
 * One galaxy, in its own coordinates round (0, 0): units on a ring, topics settled round their unit, then tilted
 * into an ellipse and settled once more so nothing overlaps. Returns {list, x, y, R} (R: the galaxy's radius,
 * stars included). Runs `step(ticks)` chunks through `tick`, so the caller can spread it over frames.
 */
function galaxySim(model, d3, list, c, f) {
  const units = unitsOf(model, list);
  const n = list.length, k = Math.max(1, units.length);
  const area = list.reduce((a, i) => a + (model.r[i] + f.collidePad) ** 2, 0);
  const ringR = units.length > 1 ? Math.max(14, f.ring * Math.sqrt(area / 0.6)) : 0;
  const rot = ((fnv1a(model.cats[c] ? model.cats[c].id : String(c)) % 360) * Math.PI) / 180;
  const uc = new Map(units.map((u, j) => [u, u < 0 && units.length > 1 ? [0, 0] : [Math.cos(rot + (j / k) * 2 * Math.PI) * ringR, Math.sin(rot + (j / k) * 2 * Math.PI) * ringR]]));
  const ordered = [...list].sort((a, b) => fnv1a(model.id[a]) - fnv1a(model.id[b]) || (model.id[a] < model.id[b] ? -1 : 1));
  const nodes = ordered.map((i, j) => { const [ux, uy] = uc.get(model.unit[i]); return { i, x: ux + Math.cos(j * 2.4) * 9, y: uy + Math.sin(j * 2.4) * 9, r: model.r[i], u: model.unit[i] }; });
  const at = new Map(nodes.map((nd, j) => [nd.i, j]));
  const links = [];
  for (const l of model.links) if (at.has(l[0]) && at.has(l[1])) links.push({ source: at.get(l[0]), target: at.get(l[1]) });
  const sim = d3.forceSimulation(nodes).randomSource(lcg(11 + c)).stop()
    .alphaDecay(f.alphaDecay).alphaMin(f.alphaMin)
    .force('ux', d3.forceX(nd => uc.get(nd.u)[0]).strength(f.centre))
    .force('uy', d3.forceY(nd => uc.get(nd.u)[1]).strength(f.centre))
    .force('charge', d3.forceManyBody().strength(f.charge).theta(f.chargeTheta).distanceMax(f.chargeMax))
    .force('link', d3.forceLink(links).distance(f.linkDistance).strength(f.linkStrength))
    .force('collide', d3.forceCollide(nd => nd.r + f.collidePad).iterations(2));
  return { c, n, nodes, sim, phase: 0, ticks: 0 };
}

// Tilts a settled galaxy into an ellipse (each its own angle) and sets up the short settle that follows.
function tiltGalaxy(g, model, d3, f) {
  const tilt = ((fnv1a(`tilt:${model.cats[g.c] ? model.cats[g.c].id : g.c}`) % 180) * Math.PI) / 180, cos = Math.cos(tilt), sin = Math.sin(tilt);
  let cx = 0, cy = 0;
  for (const nd of g.nodes) { cx += nd.x; cy += nd.y; }
  cx /= g.nodes.length || 1; cy /= g.nodes.length || 1;
  for (const nd of g.nodes) {
    const x = nd.x - cx, y = nd.y - cy, u = x * cos + y * sin, v = (-x * sin + y * cos) * f.tilt;
    nd.x = u * cos - v * sin; nd.y = u * sin + v * cos; nd.vx = 0; nd.vy = 0;
  }
  g.sim = d3.forceSimulation(g.nodes).randomSource(lcg(23 + g.c)).stop()
    .alphaDecay(f.alphaDecay).alphaMin(f.alphaMin)
    .force('collide', d3.forceCollide(nd => nd.r + f.collidePad).iterations(2));
}

/**
 * The whole layout (v3). Resolves to {topics: [[id, x, y]], categories: [[id, x, y]]} for PUT /api/map/positions.
 * sim: the embedding neighbours by topic index ([[i, j, s100]], similarity.js simByIndex of GET
 * /api/map/layout-input); none is fine (links and units alone). onProgress(0..1) after each chunk; frame(fn)
 * schedules the next chunk (requestAnimationFrame by default; each chunk stays within a few milliseconds), so the
 * page stays responsive. signal.aborted stops it (the page was left). d3 is not needed (kept for v2's signature).
 */
export async function fullLayout(model, d3, { onProgress = null, frame = null, signal = null, forces = FORCES, sim = [], v3 = undefined, current = null } = {}) {
  const stop = () => { if (signal && signal.aborted) throw Object.assign(new Error('Layout stopped.'), { aborted: true }); };
  const res = await semanticLayout(model, { sim, f: forces, ...(v3 ? { v3 } : {}), onProgress, next: frame || nextChunk, stop, current });
  return { topics: res.topics, categories: res.categories, kept: !!(res.seating && res.seating.kept) };
}

/**
 * Where each system is now, for Tidy (semantic.js seats it again only when that is clearly better): Map(category id
 * -> [x, y]), the middle of its placed stars, or null before the donut (an older layout is arranged afresh).
 */
export function currentCentres(model) {
  if (!model || !(model.layoutVersion >= DONUT_FROM)) return null;
  const sums = new Map();
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    const cat = model.cats[model.cat[i]], id = cat ? cat.id : null;
    const s = sums.get(id) || [0, 0, 0];
    s[0] += model.x[i]; s[1] += model.y[i]; s[2]++;
    sums.set(id, s);
  }
  return new Map([...sums].map(([id, s]) => [id, [s[0] / s[2], s[1] / s[2]]]));
}

/** v2's layout (the one before v3), kept so the two can be compared on the same map (quality.js). Needs d3. */
export async function fullLayoutV2(model, d3, { onProgress = null, frame = null, signal = null, forces = FORCES } = {}) {
  const f = forces;
  const next = frame || nextChunk;
  const stop = () => { if (signal && signal.aborted) throw Object.assign(new Error('Layout stopped.'), { aborted: true }); };

  // 1. Every category as its own galaxy.
  const members = new Map();
  for (let i = 0; i < model.n; i++) { const c = model.cat[i]; if (!members.has(c)) members.set(c, []); members.get(c).push(i); }
  const gals = [...members.keys()].sort((a, b) => a - b).map(c => galaxySim(model, d3, members.get(c), c, f));
  const perGalaxy = f.galaxyTicks + f.settleTicks;
  const total = gals.length * perGalaxy + f.packTicks;
  let done = 0;
  await new Promise((resolve, reject) => {
    let g = 0;
    const step = () => {
      try { stop(); } catch (e) { reject(e); return; }
      const gal = gals[g];
      if (!gal) { resolve(); return; }
      const budget = Math.max(f.chunk, 24);   // ticks per chunk; one small galaxy is a few milliseconds
      for (let k = 0; k < budget && gal.phase < 2; k++) {
        gal.sim.tick(); gal.ticks++; done++;
        if (gal.phase === 0 && gal.ticks >= f.galaxyTicks) { tiltGalaxy(gal, model, d3, f); gal.phase = 1; gal.ticks = 0; }
        else if (gal.phase === 1 && gal.ticks >= f.settleTicks) gal.phase = 2;
      }
      if (gal.phase === 2) { done = (g + 1) * perGalaxy; g++; }
      if (onProgress) onProgress(Math.min(0.99, done / total));
      next(step);
    };
    next(step);
  });

  // Each galaxy's centre and radius (stars included).
  for (const g of gals) {
    let cx = 0, cy = 0;
    for (const nd of g.nodes) { cx += nd.x; cy += nd.y; }
    cx /= g.nodes.length || 1; cy /= g.nodes.length || 1;
    for (const nd of g.nodes) { nd.x -= cx; nd.y -= cy; }
    g.R = g.nodes.reduce((m, nd) => Math.max(m, Math.hypot(nd.x, nd.y) + nd.r), 12);
    g.top = g.nodes.reduce((m, nd) => Math.min(m, nd.y - nd.r), 0);
  }

  // 2. Pack the galaxies as boxes, each with room above it for its title: biggest in the middle, drawn together on
  // a wide oval and pushed apart until no two boxes touch, so every galaxy has clear sky round it and its title
  // never sits on a neighbour.
  stop();
  const bodies = gals.map(g => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const nd of g.nodes) { x0 = Math.min(x0, nd.x - nd.r); x1 = Math.max(x1, nd.x + nd.r); y0 = Math.min(y0, nd.y - nd.r); y1 = Math.max(y1, nd.y + nd.r); }
    if (!Number.isFinite(x0)) { x0 = y0 = -10; x1 = y1 = 10; }
    const gw = x1 - x0, gh = y1 - y0;
    const w = Math.max(gw, f.titleWidth) + f.boxGap, h = gh + f.titleRoom + f.boxGap;
    // the box's centre sits above the galaxy's centre by half the title room
    return { c: g.c, g, w, h, ox: (x0 + x1) / 2, oy: (y0 + y1) / 2 - f.titleRoom / 2, area: w * h, x: 0, y: 0 };
  });
  const byIndex = new Map(bodies.map(b => [b.c, b]));
  const order = [...bodies].sort((a, b) => b.area - a.area || a.c - b.c);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const unit = Math.sqrt(order.reduce((a, b) => a + b.area, 0) / Math.max(1, order.length));
  order.forEach((b, j) => { const rr = 0.62 * unit * Math.sqrt(j); b.x = rr * Math.cos(j * golden) * 1.25; b.y = rr * Math.sin(j * golden) * 0.8; });
  // Categories that share many threads lean towards each other a little.
  const cross = new Map();
  for (const l of model.links) {
    const a = model.cat[l[0]], b = model.cat[l[1]];
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    cross.set(key, (cross.get(key) || 0) + 1);
  }
  const pulls = [...cross].map(([key, n]) => { const [a, b] = key.split('|').map(Number); return [byIndex.get(a), byIndex.get(b), n]; }).filter(p => p[0] && p[1]);
  const maxN = Math.max(1, ...pulls.map(p => p[2]));
  for (let it = 0; it < f.packTicks; it++) {
    const cool = 1 - it / f.packTicks;
    for (const b of bodies) { b.x -= b.x * f.oval[0] * cool; b.y -= b.y * f.oval[1] * cool; }
    for (const [a, b, n] of pulls) {
      const dx = b.x - a.x, dy = b.y - a.y, s = f.catLink * 0.02 * (n / maxN) * cool;
      a.x += dx * s; a.y += dy * s; b.x -= dx * s; b.y -= dy * s;
    }
    for (let p = 0; p < 2; p++) for (let a = 0; a < bodies.length; a++) for (let q = a + 1; q < bodies.length; q++) {
      const A = bodies[a], B = bodies[q], dx = B.x - A.x, dy = B.y - A.y;
      const ox = (A.w + B.w) / 2 - Math.abs(dx), oy = (A.h + B.h) / 2 - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      if (ox / (A.w + B.w) < oy / (A.h + B.h)) { const m = (ox / 2 + 0.01) * (dx < 0 ? -1 : 1); A.x -= m; B.x += m; }
      else { const m = (oy / 2 + 0.01) * (dy < 0 ? -1 : 1); A.y -= m; B.y += m; }
    }
    done++;
    if (it % 60 === 59) { if (onProgress) onProgress(Math.min(0.99, done / total)); await new Promise(res => next(res)); stop(); }
  }
  // A last pass with no gravity: nothing may still touch.
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let a = 0; a < bodies.length; a++) for (let q = a + 1; q < bodies.length; q++) {
      const A = bodies[a], B = bodies[q], dx = B.x - A.x, dy = B.y - A.y;
      const ox = (A.w + B.w) / 2 - Math.abs(dx), oy = (A.h + B.h) / 2 - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      moved = true;
      if (ox / (A.w + B.w) < oy / (A.h + B.h)) { const m = (ox / 2 + 0.01) * (dx < 0 ? -1 : 1); A.x -= m; B.x += m; }
      else { const m = (oy / 2 + 0.01) * (dy < 0 ? -1 : 1); A.y -= m; B.y += m; }
    }
    if (!moved) break;
  }
  if (onProgress) onProgress(1);

  // 3. Topics at their galaxy's place; category centres where the eye sees the cluster.
  const topics = [], categories = [];
  for (const g of gals) {
    const body = byIndex.get(g.c);
    // the galaxy's own centre goes to its box's centre, less the title room's offset
    const gx = body.x - body.ox, gy = body.y - body.oy;
    for (const nd of g.nodes) topics.push([model.id[nd.i], round1(gx + nd.x), round1(gy + nd.y)]);
    if (g.c >= 0 && model.cats[g.c]) categories.push([model.cats[g.c].id, round1(gx), round1(gy)]);
  }
  topics.sort((p, q) => (model.index.get(p[0]) ?? 0) - (model.index.get(q[0]) ?? 0));
  return { topics, categories };
}

/**
 * A screen taller than wide (a phone, an iPad held upright): the saved layout's wide oval would use a third of it,
 * with dots of one or two pixels (DES3-03). For display only, the galaxies are re-packed in rows to the screen's
 * shape, each moved whole (its own stars keep their places, so nothing inside a galaxy changes), and nothing is
 * saved. x, y: the saved (canonical) positions by topic index. aspect: the canvas's width / height. The number of
 * columns is the one that draws the map largest on that screen. Returns Map(category index -> [dx, dy]).
 */
export function screenShifts(model, x, y, { aspect = 0.5, f = FORCES, maxCols = 5 } = {}) {
  const boxes = new Map();
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    const c = model.cat[i], r = model.r[i] || 0;
    let b = boxes.get(c);
    if (!b) { b = { c, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; boxes.set(c, b); }
    b.x0 = Math.min(b.x0, x[i] - r); b.x1 = Math.max(b.x1, x[i] + r);
    b.y0 = Math.min(b.y0, y[i] - r); b.y1 = Math.max(b.y1, y[i] + r);
  }
  // Each galaxy's box as the layout packs it: room above for its title, never narrower than one, sky round it.
  const list = [...boxes.values()].map(b => ({ c: b.c, w: Math.max(b.x1 - b.x0, f.titleWidth) + f.boxGap, h: b.y1 - b.y0 + f.titleRoom + f.boxGap,
    cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 - f.titleRoom / 2 }));
  if (!list.length) return new Map();
  // Top to bottom as on the oval, left to right within a row.
  list.sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.c - b.c);
  const rowsFor = cols => {
    const rows = [];
    for (let k = 0; k < list.length; k += cols) rows.push(list.slice(k, k + cols).sort((a, b) => a.cx - b.cx || a.c - b.c));
    return rows;
  };
  let best = null;
  for (let cols = 1; cols <= Math.min(maxCols, list.length); cols++) {
    const rows = rowsFor(cols);
    const gw = Math.max(...rows.map(r => r.reduce((s, b) => s + b.w, 0)));
    const gh = rows.reduce((s, r) => s + Math.max(...r.map(b => b.h)), 0);
    const scale = Math.min(aspect / gw, 1 / gh);   // how large the grid draws on a screen of this shape
    if (!best || scale > best.scale + 1e-12) best = { cols, rows, gh, scale };
  }
  const out = new Map();
  let top = -best.gh / 2;
  for (const row of best.rows) {
    const rh = Math.max(...row.map(b => b.h));
    let left = -row.reduce((s, b) => s + b.w, 0) / 2;
    for (const b of row) {
      out.set(b.c, [left + b.w / 2 - b.cx, top + rh / 2 - b.cy]);
      left += b.w;
    }
    top += rh;
  }
  return out;
}

/** Writes a finished layout into the model (positions only), so the page shows it before the PUT returns. */
export function applyLayout(model, result) {
  for (const [id, x, y] of result.topics) {
    const i = model.index.get(id);
    if (i == null) continue;
    model.x[i] = x; model.y[i] = y; model.placed[i] = 1;
  }
  return model;
}
