// The topics on the canvas (plan §9 Node encoding): size is yield, fill is weakness's t through scale.js (one
// fill() per colour bucket), a hollow grey ring is "not seen yet", a glow of the node's own colour is certainty
// (never fading), and small neutral shapes are the marks. Size is the Master Checklist tier (data.js tierRadius),
// and a checklist dot big enough on screen carries its tier's letter (C, B, A, A+), batched by font and colour. Colour is never the only signal. The draw functions
// are dumb: they read the model's arrays and a view, and never compute a score.
//
// view: {k (camera scale), list (indices to draw, culled), dim (Uint8Array or null: filtered out), tOf(i) (shown
//        t, tweened), grow(i) (radius factor), glows (bool), hiddenSet (Set of nodes the hover layer redraws)}
import { bucketOf, BUCKETS, ALPHA_LEVELS, glowOf, isPale, CORE, SKY_GLOW, CASING } from './colour.js';
import { MARK_GEOM, marksOf } from './marks.js';
import { TIER } from './data.js';

export const MIN_PX = 1.5;           // a node is never drawn under 1.5 screen px
export const MARK_MIN_PX = 5;        // marks only on nodes at least 5 px across
export const DIM_ALPHA = 0.08;       // filtered-out topics: dimmed, never moved or hidden
const TAU = Math.PI * 2;

/** The drawn world radius of node i at scale k: yield size times grow (the zoom's dot scale, any hover growth or
 *  a new topic's entrance), never under 1.5 screen px. */
export function drawnRadius(model, i, k, grow = 1) {
  return Math.max(model.r[i] * grow, MIN_PX / k);
}

// Visible, undimmed nodes grouped by colour bucket ([] per bucket), thin ones (pale, wave 2 C.4) in their own buckets,
// unseen ones apart. The pale lists are filled only when a thin node is seen, so a map with none costs nothing more.
function groups(model, view) {
  const by = Array.from({ length: BUCKETS }, () => []);
  let pale = null;
  const unseen = [], dimmed = [];
  for (const i of view.list) {
    if (view.skip && view.skip.has(i)) continue;
    const t = view.tOf(i);
    if (view.dim && view.dim[i]) { dimmed.push(i); continue; }
    if (t < 0) unseen.push(i);
    else if (isPale(model, i)) (pale || (pale = Array.from({ length: BUCKETS }, () => [])))[bucketOf(t)].push(i);
    else by[bucketOf(t)].push(i);
  }
  return { by, pale, unseen, dimmed };
}

// A thin star on the night sky (wave 2 C.4): its pale fill inside an outline in the full colour, and no hot core, so a
// colour that rests on one answer never reads as a bright star. One path: the outline stroke, then the fill.
export const PALE_EDGE_PX = 1.3;
function paleEdge(ctx, colour, k, fill) {
  ctx.strokeStyle = colour; ctx.lineWidth = (2 * PALE_EDGE_PX) / k; ctx.stroke();
  fill();
}

export const LETTER = Object.freeze({ minPx: 8, fullPx: 12, share: 1.0, shareTwo: 0.78, minFont: 8, maxFont: 20,
  fill: '#ffffff', outline: 'rgba(5,8,26,0.85)', outlinePx: 2, font: '700 {px}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif' });
const fontOf = px => LETTER.font.replace('{px}', px);

/** The letter for node i at screen radius R px: {text, px (font, screen), alpha} or null when too small. Pure. */
export function letterOf(tier, R) {
  const text = TIER.letters[tier] || '';
  if (!text || !(R >= LETTER.minPx)) return null;
  const a = Math.min(1, (R - LETTER.minPx) / (LETTER.fullPx - LETTER.minPx));
  const alpha = Math.max(0.25, Math.round(a * 4) / 4);
  const px = Math.max(LETTER.minFont, Math.min(LETTER.maxFont, Math.round(R * (text.length > 1 ? LETTER.shareTwo : LETTER.share))));
  return { text, px, alpha };
}

/**
 * The tier letters of these nodes (undimmed, drawn), batched: one group per font size, alpha step and colour.
 * unseenColour: the hollow ring's colour. Returns how many letters it drew.
 */
export function drawLetters(ctx, model, view, list, unseenColour) {
  const tier = model.tier;
  if (!tier || tier.length !== model.n || !list.length) return 0;
  const k = view.k;
  const groupsBy = new Map();
  for (const i of list) {
    if (!tier[i]) continue;
    const L = letterOf(tier[i], drawnRadius(model, i, k, view.grow(i)) * k);
    if (!L) continue;
    const hollow = view.tOf(i) < 0;
    const key = `${L.px}|${L.alpha}|${hollow ? 1 : 0}`;
    let g = groupsBy.get(key);
    if (!g) { g = { px: L.px, alpha: L.alpha, hollow, items: [] }; groupsBy.set(key, g); }
    g.items.push(i, L.text);
  }
  if (!groupsBy.size) return 0;
  let n = 0;
  const base = typeof ctx.globalAlpha === 'number' ? ctx.globalAlpha : 1;   // a hover veil's alpha carries through
  ctx.save();
  // Letters are set in screen px (crisp at any zoom): from the world transform (dpr·k, offset) to dpr alone. A
  // context without getTransform (a test's recorder) stays in world units, the font scaled by 1/k.
  const T = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const screen = !!(T && Number.isFinite(T.a) && T.a > 0);
  const dpr = screen ? T.a / k : 1, unit = screen ? 1 : 1 / k;
  const sx = screen ? x => (T.a * x + T.e) / dpr : x => x, sy = screen ? y => (T.d * y + T.f) / dpr : y => y;
  if (screen) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const g of groupsBy.values()) {
    ctx.font = fontOf(+(g.px * unit).toFixed(3));
    ctx.globalAlpha = base * g.alpha;
    const dy = g.px * 0.06 * unit;   // optical centre: capitals sit a hair high on 'middle'
    if (g.hollow) {
      ctx.fillStyle = unseenColour;
      for (let j = 0; j < g.items.length; j += 2) ctx.fillText(g.items[j + 1], sx(model.x[g.items[j]]), sy(model.y[g.items[j]]) + dy);
    } else {
      ctx.strokeStyle = LETTER.outline;
      ctx.lineWidth = LETTER.outlinePx * unit;
      ctx.fillStyle = LETTER.fill;
      for (let j = 0; j < g.items.length; j += 2) {
        const i = g.items[j], x = sx(model.x[i]), y = sy(model.y[i]) + dy;
        ctx.strokeText(g.items[j + 1], x, y);
        ctx.fillText(g.items[j + 1], x, y);
      }
    }
    n += g.items.length / 2;
  }
  ctx.restore();
  return n;
}

/**
 * Glows, grouped by alpha level and bucket so the context changes as little as possible. On the night sky they
 * add light ('lighter'), a little wider and brighter than the plan's certainty glow (concept 8a); on a light map
 * they are plain and soft.
 */
export function drawGlows(ctx, model, view, pal) {
  if (!view.glows || !pal.glows[0]) return 0;
  const night = pal.theme !== 'light';
  const levels = Array.from({ length: ALPHA_LEVELS }, () => Array.from({ length: BUCKETS }, () => []));
  let n = 0;
  for (const i of view.list) {
    if ((view.dim && view.dim[i]) || (view.skip && view.skip.has(i))) continue;
    const t = view.tOf(i);
    if (t < 0 || isPale(model, i)) continue;   // a thin topic has no glow: a guess must not look like knowledge
    const g = glowOf(model.cert[i]);
    if (!g) continue;
    levels[g.level][bucketOf(t)].push(i);
    n++;
  }
  if (!n) return 0;
  ctx.save();
  if (night) ctx.globalCompositeOperation = 'lighter';
  const wide = night ? SKY_GLOW.radius : 1;
  levels.forEach((buckets, level) => {
    const a = 0.1 + (0.3 * level) / (ALPHA_LEVELS - 1);
    ctx.globalAlpha = night ? Math.min(SKY_GLOW.maxAlpha, a * SKY_GLOW.alpha) : a * 0.6;
    buckets.forEach((list, b) => {
      const img = pal.glows[b];
      for (const i of list) {
        const r = drawnRadius(model, i, view.k, view.grow(i)) * (glowOf(model.cert[i]).scale) * wide;
        ctx.drawImage(img, model.x[i] - r, model.y[i] - r, 2 * r, 2 * r);
      }
    });
  });
  ctx.restore();
  return n;
}

function discs(ctx, model, view, list) {
  ctx.beginPath();
  for (const i of list) {
    const r = drawnRadius(model, i, view.k, view.grow(i));
    ctx.moveTo(model.x[i] + r, model.y[i]);
    ctx.arc(model.x[i], model.y[i], r, 0, TAU);
  }
}

function rings(ctx, model, view, list, scale) {
  ctx.beginPath();
  for (const i of list) {
    const r = drawnRadius(model, i, view.k, view.grow(i)) * scale;
    ctx.moveTo(model.x[i] + r, model.y[i]);
    ctx.arc(model.x[i], model.y[i], r, 0, TAU);
  }
}

// The hot cores of these dots, as one path (white over each dot's middle).
function cores(ctx, model, view, list) {
  ctx.beginPath();
  for (const i of list) {
    const r = drawnRadius(model, i, view.k, view.grow(i)) * CORE.radius;
    ctx.moveTo(model.x[i] + r, model.y[i]);
    ctx.arc(model.x[i], model.y[i], r, 0, TAU);
  }
}

function lightEdge(ctx, edge, k, fill) {
  ctx.strokeStyle = edge; ctx.globalAlpha = 0.55; ctx.lineWidth = 3.2 / k; ctx.stroke();
  ctx.globalAlpha = 1;
  fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4 / k; ctx.stroke();
}

// A dot on the night sky: a thin dark casing (colour.js CASING) round the fill, so a star reads crisp against a bright
// nebula or a neighbour's glow. One path: the casing stroke, then the fill over its inner half.
function nightEdge(ctx, k, fill) {
  ctx.strokeStyle = CASING.colour; ctx.lineWidth = (2 * CASING.px) / k; ctx.stroke();
  fill();
}

/**
 * Clean dots (concept 8a): one solid fill per colour bucket, no outline on the night sky (a 1 px edge on a light
 * map, where the light middle is under 3:1), then every hot core in one pass, unseen rings, and the dimmed pass.
 * Returns how many nodes it drew.
 */
export function drawNodes(ctx, model, view, pal) {
  const { by, pale, unseen, dimmed } = groups(model, view);
  const k = view.k;
  ctx.save();
  const lit = [], paleLit = [];
  by.forEach((list, b) => {
    if (!list.length) return;
    ctx.fillStyle = pal.fills[b];
    discs(ctx, model, view, list);
    if (pal.theme === 'light') lightEdge(ctx, pal.edges[b], k, () => ctx.fill()); else nightEdge(ctx, k, () => ctx.fill());
    for (const i of list) lit.push(i);
  });
  if (pale) pale.forEach((list, b) => {
    if (!list.length) return;
    ctx.fillStyle = (pal.pales || pal.fills)[b];
    discs(ctx, model, view, list);
    if (pal.theme === 'light') lightEdge(ctx, pal.edges[b], k, () => ctx.fill()); else paleEdge(ctx, pal.fills[b], k, () => ctx.fill());
    for (const i of list) paleLit.push(i);
  });
  if (lit.length && pal.theme !== 'light') {
    ctx.fillStyle = `rgba(255,255,255,${CORE.alpha})`;
    cores(ctx, model, view, lit);
    ctx.fill();
  }
  if (paleLit.length) for (const i of paleLit) lit.push(i);
  if (unseen.length) {
    ctx.strokeStyle = pal.unseen;
    ctx.lineWidth = pal.unseenWidth / k;
    rings(ctx, model, view, unseen, pal.unseenScale);
    ctx.stroke();
  }
  if (lit.length || unseen.length) drawLetters(ctx, model, view, unseen.length ? lit.concat(unseen) : lit, pal.unseen);
  if (dimmed.length) {
    ctx.globalAlpha = DIM_ALPHA;
    for (const i of dimmed) {
      const t = view.tOf(i);
      const r = drawnRadius(model, i, k, 1);
      ctx.beginPath();
      ctx.arc(model.x[i], model.y[i], t < 0 ? r * pal.unseenScale : r, 0, TAU);
      if (t < 0) { ctx.strokeStyle = pal.unseen; ctx.lineWidth = pal.unseenWidth / k; ctx.stroke(); } else { ctx.fillStyle = pal.colourOf(t); ctx.fill(); }
    }
  }
  ctx.restore();
  return view.list.length;
}

/** One node drawn alone (the hover layer above the veil), with its own colour or unseen ring. */
export function drawOne(ctx, model, i, view, pal, grow = 1) {
  const t = view.tOf(i);
  const r = drawnRadius(model, i, view.k, grow);
  ctx.beginPath();
  if (t < 0) {
    ctx.arc(model.x[i], model.y[i], r * pal.unseenScale, 0, TAU);
    ctx.strokeStyle = pal.unseen;
    ctx.lineWidth = (pal.unseenWidth * (grow > 1 ? 1.3 : 1)) / view.k;
    ctx.stroke();
  } else if (isPale(model, i)) {
    // a thin topic alone: pale, with its outline in the full colour (a light map: the usual edge)
    const b = bucketOf(t);
    ctx.arc(model.x[i], model.y[i], r, 0, TAU);
    ctx.fillStyle = (pal.pales || pal.fills)[b];
    if (pal.theme === 'light') lightEdge(ctx, pal.edges[b], view.k, () => ctx.fill()); else paleEdge(ctx, pal.fills[b], view.k, () => ctx.fill());
  } else {
    ctx.arc(model.x[i], model.y[i], r, 0, TAU);
    ctx.fillStyle = pal.colourOf(t);
    if (pal.theme === 'light') lightEdge(ctx, pal.edges[bucketOf(t)], view.k, () => ctx.fill());
    else {
      nightEdge(ctx, view.k, () => ctx.fill());
      ctx.beginPath();
      ctx.arc(model.x[i], model.y[i], r * CORE.radius, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${CORE.alpha})`;
      ctx.fill();
    }
  }
  if (model.tier && model.tier[i]) drawLetters(ctx, model, { ...view, grow: () => grow }, [i], pal.unseen);
  return r;
}

/** A ring round node i: the selection (2 px, white on the sky), the hover ring, or a mark ring. */
export function ring(ctx, model, i, view, { colour, width = 2, gap = 2, dash = null, alpha = 1, grow = 1 }) {
  const r = drawnRadius(model, i, view.k, grow) + (gap + width / 2) / view.k;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width / view.k;
  if (dash) ctx.setLineDash(dash.map(d => d / view.k));
  ctx.beginPath();
  ctx.arc(model.x[i], model.y[i], r, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * The three marks (marks.js MAP_MARKS), in --map-mark, only on nodes big enough to carry them (at least 5 px across):
 * Learn next a ring, High-priority teaching a small triangle above, Re-test due a dot at the upper right. teach: {next,
 * high} Sets of topic indices (main.js, from GET /api/map/teach-marks), or null.
 */
export function drawMarks(ctx, model, view, colour, teach = null) {
  const k = view.k, G = MARK_GEOM;
  let n = 0;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  for (const i of view.list) {
    if ((view.dim && view.dim[i]) || (view.skip && view.skip.has(i))) continue;
    const mk = marksOf(model.flags[i], i, teach);
    if (!mk.next && !mk.high && !mk.retest) continue;
    const r = drawnRadius(model, i, k, view.grow(i));
    if (2 * r * k < MARK_MIN_PX) continue;
    const x = model.x[i], y = model.y[i];
    if (mk.next) {
      ctx.globalAlpha = 1; ctx.lineWidth = G.ring.width / k;
      ctx.beginPath(); ctx.arc(x, y, r + G.ring.gap / k, 0, TAU); ctx.stroke();
    }
    if (mk.high) {
      const top = y - r - G.tri.gap / k, s = G.tri.half / k, t = G.tri.tall / k;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x - s, top - t); ctx.lineTo(x + s, top - t); ctx.closePath(); ctx.fill();
    }
    if (mk.retest) {
      const a = -Math.PI / 4, d = r + G.dot.gap / k + (mk.next ? G.ring.width / k : 0);
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x + d * Math.cos(a), y + d * Math.sin(a), G.dot.r / k, 0, TAU); ctx.fill();
    }
    n++;
  }
  ctx.restore();
  return n;
}
