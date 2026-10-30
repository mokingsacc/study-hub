// The galaxies (plan §9 Halos and labels, drawn as concept 8a): each category's geometry from its topics' positions
// (centre, radius, top and bottom for its title), its tint from the category's own weakness (weakness's
// categorySummary, from the payload) at alpha 0.05 + 0.15·coverage, and its title's counts line, "6 weak · 14 not
// seen yet". The sky below paints the haze, nebulae and dust from them.
import { BANDS } from './scale.js';
import { DONUT } from './donut.js';

export const HALO_GROW = 1.15, HALO_PAD = 30;
export const UNSEEN_ALPHA = 0.05;

/** The 90th-percentile value of a list (0 for an empty one). */
export function p90(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * (s.length - 1)))];
}

/** "6 weak · 14 not seen yet" (nothing when there is nothing to say). */
export function countsLine(cat) {
  const parts = [];
  if (cat.weak) parts.push(`${cat.weak} weak`);
  if (cat.unseen) parts.push(`${cat.unseen} not seen yet`);
  if (!parts.length && cat.n) parts.push(`${cat.n} topic${cat.n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export const MAP_TITLES = Object.freeze({
  cardiology: 'Cardio', respiratory: 'Resp', 'gi-and-hepatology': 'GI', 'renal-urinary-and-electrolytes': 'Renal', 'endocrine-and-diabetes': 'Endo',
  haematology: 'Haem', 'infectious-disease': 'ID', 'rheumatology-and-msk': 'Rheum', dermatology: 'Derm', neurology: 'Neuro', ophthalmology: 'Eye',
  ent: 'ENT', psychiatry: 'Psych', obstetrics: 'Obs', 'gynaecology-and-breast': 'Gyn', 'male-reproductive-and-urology': 'Uro',
  'neonates-genetics-and-child-development': 'Paeds', 'immunology-and-allergy': 'Immuno', 'emergency-toxicology-and-environment': 'EM',
  'surgery-trauma-and-perioperative': 'Surgery', 'biostatistics-and-epidemiology': 'Biostats', 'ethics-and-communication': 'Ethics', 'prevention-and-geriatrics': 'Prevention',
  // release 1's sections
  paediatrics: 'Paeds', 'gynaecology-and-mens-health': 'Gyn', endocrine: 'Endo', 'renal-and-acid-base': 'Renal', 'haematology-and-oncology': 'Haem',
  'neurology-eye-and-ent': 'Neuro', 'emergency-and-toxicology': 'EM', surgery: 'Surgery', 'prevention-nutrition-and-geriatrics': 'Prevention',
  'ethics-safety-and-biostatistics': 'Ethics',
});
/** A galaxy's name on the map: its short name in Title Case (an unknown system: its own short name, at most 10 letters). */
export function mapTitle(cat) {
  if (!cat) return '';
  if (MAP_TITLES[cat.id]) return MAP_TITLES[cat.id];
  const s = String(cat.short || cat.name || '').trim().split(/[\s-]+/)[0] || '';
  return (s === s.toUpperCase() ? s : s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 10);
}
/**
 * Halo geometry for every category with placed topics: [{c, cx, cy, R, colour, alpha, name, short, line2, n}].
 * colourOf(t1000) and unseenHex come from the palette, so the halo uses the same scale as the nodes.
 */
export function buildHalos(model, { colourOf, unseenHex }) {
  const members = new Map();
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i] || model.cat[i] < 0) continue;
    const c = model.cat[i];
    if (!members.has(c)) members.set(c, []);
    members.get(c).push(i);
  }
  const out = [];
  for (const [c, list] of members) {
    const cat = model.cats[c];
    if (!cat) continue;
    let sx = 0, sy = 0, top = Infinity, bottom = -Infinity;
    for (const i of list) { sx += model.x[i]; sy += model.y[i]; top = Math.min(top, model.y[i] - model.r[i]); bottom = Math.max(bottom, model.y[i] + model.r[i]); }
    const cx = sx / list.length, cy = sy / list.length;
    const R = HALO_GROW * p90(list.map(i => Math.hypot(model.x[i] - cx, model.y[i] - cy) + model.r[i])) + HALO_PAD;
    const seen = cat.t1000 != null;
    out.push({
      c, cx, cy, R, top, bottom, n: list.length, name: cat.name, short: cat.short, line2: countsLine(cat), title: mapTitle(cat),
      colour: seen ? colourOf(cat.t1000) : unseenHex,
      alpha: seen ? 0.05 + 0.15 * Math.max(0, Math.min(1, cat.coverage)) : UNSEEN_ALPHA,
    });
  }
  return out;
}


const lcgOf = seed => { let s = seed >>> 0; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; }; };
const hashOf = str => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
export const rgbOfHex = hex => { const h = String(hex).replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
const mixRgb = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
const GREY = [150, 156, 166];
const WHITE = [255, 255, 255];
const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = c => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

// How faint the glow is: its peak alpha, from a galaxy barely seen to one fully seen (night: light added to the
// sky; by day: a wash over the pale ground), and the whisper for a galaxy with nothing seen.
export const GLOW_MIX = Object.freeze({ night: Object.freeze([0.04, 0.08]), light: Object.freeze([0.02, 0.035]), none: Object.freeze({ night: 0.02, light: 0.012 }) });
// The five weakness families (scale.js BANDS, strong to very weak), each drawn in the colour of its band's middle.
const BAND_TOP = BANDS.map(b => b.to);
export const BAND_MIDS = Object.freeze(BANDS.map(b => Math.round((b.from + b.to) / 2)));
export const bandIndex = t => { for (let k = 0; k < BAND_TOP.length; k++) if (t <= BAND_TOP[k]) return k; return BAND_TOP.length - 1; };

/**
 * A galaxy's glow colour: its seen topics (t1000 >= 0) counted by band, the band colours mixed by count in linear
 * light. Returns {rgb, counts, seen}; rgb is null when nothing is seen. colourOf(t1000) gives a band's hex.
 */
export function weaknessMix(list, tOf, colourOf) {
  const counts = new Array(BANDS.length).fill(0);
  let seen = 0;
  for (const i of list) { const t = tOf(i); if (t == null || t < 0) continue; counts[bandIndex(t)]++; seen++; }
  if (!seen) return { rgb: null, counts, seen };
  const acc = [0, 0, 0];
  counts.forEach((n, k) => { if (n) rgbOfHex(colourOf(BAND_MIDS[k])).forEach((v, c) => { acc[c] += (n / seen) * lin(v); }); });
  return { rgb: acc.map(gam), counts, seen };
}

export const FOOTPRINT_MARGIN = Math.floor(DONUT.gap * 0.4);
export function footprintOf(model, list, margin = FOOTPRINT_MARGIN) {
  if (!list || !list.length) return null;
  let cx = 0, cy = 0;
  for (const i of list) { cx += model.x[i]; cy += model.y[i]; }
  cx /= list.length; cy /= list.length;
  let r = 0;
  for (const i of list) r = Math.max(r, Math.hypot(model.x[i] - cx, model.y[i] - cy) + (model.r[i] || 0));
  r += margin;
  return { cx, cy, r, x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
}

function makeBuffer(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}

/**
 * Each galaxy's haze blobs and dust, made from its own id so they never change between loads, and its glow colour
 * (weaknessMix of its stars; neutral, [r, g, b], when none is seen: colour.js skyNeutral). Everything stays inside
 * the galaxy's footprint (footprintOf): fp, and the glow's ellipse rx, ry round its centre, fit in it; each blob
 * fades out before the footprint's edge, and a speck of dust that would fall outside is drawn back towards its star.
 */
export function skyParts(model, halos, { colourOf, neutral = GREY }) {
  const byCat = new Map();
  for (let i = 0; i < model.n; i++) if (model.placed[i] && model.cat[i] >= 0) { const c = model.cat[i]; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(i); }
  return halos.map(h => {
    const cat = model.cats[h.c];
    const rnd = lcgOf(hashOf(`sky:${cat ? cat.id : h.c}`));
    const list = byCat.get(h.c) || [];
    const R = h.R;
    const fp = footprintOf(model, list) || { cx: h.cx, cy: h.cy, r: R, x0: h.cx - R, y0: h.cy - R, x1: h.cx + R, y1: h.cy + R };
    // the glow's ellipse round the halo's centre, inside the footprint's circle
    const off = Math.hypot(h.cx - fp.cx, h.cy - fp.cy);
    const rx = Math.max(8, Math.min(R * 1.75, fp.r - off)), ry = rx;
    const room = (x, y) => Math.max(0, fp.r - Math.hypot(x - fp.cx, y - fp.cy));
    const inside = (x, y) => Math.hypot(x - fp.cx, y - fp.cy) <= fp.r;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const blobs = [1, 0.62, 0.5].map(a => {
      const x = clamp(h.cx + (rnd() - 0.5) * R * 0.7, h.cx - 0.35 * rx, h.cx + 0.35 * rx), y = clamp(h.cy + (rnd() - 0.5) * R * 0.5, h.cy - 0.25 * ry, h.cy + 0.25 * ry);
      return { x, y, r: Math.min(R * (1.15 + rnd() * 0.45), room(x, y)), a };
    });
    const g3 = () => (rnd() + rnd() + rnd() - 1.5) * 1.2;
    const spread = Math.max(14, R * 0.3);
    const count = Math.min(220, Math.round(40 + 2.5 * list.length));
    const dust = new Float32Array(count * 4);
    for (let k = 0; k < count && list.length; k++) {
      const i = list[Math.floor(rnd() * list.length)];
      let dx = g3() * spread, dy = g3() * spread;
      for (let q = 0; q < 4 && !inside(model.x[i] + dx, model.y[i] + dy); q++) { dx *= 0.5; dy *= 0.5; }
      dust[4 * k] = model.x[i] + dx; dust[4 * k + 1] = model.y[i] + dy;
      dust[4 * k + 2] = 0.3 + rnd() ** 2 * 0.8; dust[4 * k + 3] = 0.05 + rnd() * 0.2;
    }
    const mix = weaknessMix(list, i => model.t[i], colourOf);
    const share = list.length ? mix.seen / list.length : 0;
    const rgb = mix.rgb || neutral;
    return { c: h.c, cx: h.cx, cy: h.cy, R, fp, rx, ry, blobs, dust, rgb, counts: mix.counts, seen: mix.seen, share, list,
      dustRgb: mixRgb(mix.rgb || neutral, WHITE, 0.55) };
  });
}

/** A galaxy's glow: its peak alpha (GLOW_MIX), by how much of it is seen; scale: the sky's brightness on the haze. */
export function glowAlpha(part, night = true, scale = 1) {
  const theme = night ? 'night' : 'light';
  if (!part.seen) return GLOW_MIX.none[theme] * scale;
  const [lo, hi] = GLOW_MIX[theme];
  return (lo + (hi - lo) * Math.max(0, Math.min(1, part.share))) * scale;
}

// A radial wash of one colour: [stop, alpha] pairs, from the middle out; ry (default r) squashes it into an ellipse.
function wash(ctx, x, y, r, rgb, stops, ry = r) {
  if (!(r > 0) || !(ry > 0)) return;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  for (const [at, a] of stops) g.addColorStop(at, `rgba(${rgb},${Math.max(0, a).toFixed(4)})`);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / r);
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, 2 * r, 2 * r);
  ctx.restore();
}

// The warm nebulae's strength against the old nebula sky's (0.3): kept well under the galaxy's own faint glow budget.
export const WARM_NEBULA = 0.1;

/**
 * Paints the glow and nebulae into a world-sized buffer: {canvas, x0, y0, w, h} (w, h in world units). Each
 * galaxy's paint stays inside its footprint (skyParts' fp), fading to nothing at its edge.
 * glowSprite(t1000) is a radial sprite of that weakness colour (colour.js); night: light added to the night sky,
 * else a light map's soft wash. glowScale: the sky's brightness on the haze (0.8 to 1.2).
 */
export function buildHaze(model, parts, { glowSprite = null, night = true, maxPx = 2048, loudOf = () => 0, glowScale = 1 }) {
  if (!parts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    for (const b of p.blobs) { x0 = Math.min(x0, b.x - b.r); y0 = Math.min(y0, b.y - b.r); x1 = Math.max(x1, b.x + b.r); y1 = Math.max(y1, b.y + b.r); }
    x0 = Math.min(x0, p.fp.x0); y0 = Math.min(y0, p.fp.y0); x1 = Math.max(x1, p.fp.x1); y1 = Math.max(y1, p.fp.y1);
  }
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
  const scale = Math.min(1.5, maxPx / Math.max(W, H));
  const cw = Math.max(1, Math.round(W * scale)), ch = Math.max(1, Math.round(H * scale));
  const canvas = makeBuffer(cw, ch);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  ctx.globalCompositeOperation = night ? 'lighter' : 'source-over';
  const soft = night ? 1 : 0.55;
  const blobSum = 1 + 0.62 + 0.5;
  for (const p of parts) {
    // Everything of this galaxy is clipped to its footprint's circle, so no glow ever crosses into a neighbour's.
    ctx.save();
    if (typeof ctx.clip === 'function' && typeof ctx.arc === 'function') { ctx.beginPath(); ctx.arc(p.fp.cx, p.fp.cy, p.fp.r, 0, 2 * Math.PI); ctx.clip(); }
    // The glow, in its mix of weakness colours: a faint halo filling the footprint's circle and the body (its three
    // clouds), together about the galaxy's peak alpha where they meet.
    const A = glowAlpha(p, night, glowScale);
    wash(ctx, p.cx, p.cy, p.rx, p.rgb, [[0, A * 0.35], [0.55, A * 0.14], [1, 0]], p.ry);
    for (const b of p.blobs) { const a = (A * 0.65 * b.a) / blobSum * 1.6; wash(ctx, b.x, b.y, b.r, p.rgb, [[0, a], [0.5, a * 0.4], [1, 0]]); }
    // by day the middle (where the name sits) stays lit white
    if (!night) wash(ctx, p.cx, p.cy, Math.min(p.R * 0.55, p.rx), WHITE, [[0, 0.35], [1, 0]], Math.min(p.R * 0.55, p.ry));
    // Faint warm nebulae where weak topics gather, wider for higher yield; a crowded galaxy's are fainter each.
    if (glowSprite) {
      const crowd = Math.min(1, Math.sqrt(16 / Math.max(16, p.list.length)));
      for (const i of p.list) {
        const tt = model.t[i];
        if (tt < 450) continue;
        const u = loudOf(i), w = (tt / 1000 - 0.45) / 0.55, c = model.cert[i] / 100;
        const x = model.x[i], y = model.y[i];
        const r = Math.min(p.R * (0.26 + 0.7 * u) * 0.9, Math.max(0, p.fp.r - Math.hypot(x - p.fp.cx, y - p.fp.cy)));
        const a = WARM_NEBULA * w ** 1.1 * (0.3 + 0.7 * u) * (0.55 + 0.45 * c) * crowd * soft * glowScale;
        if (a < 0.003 || !(r > 0)) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(glowSprite(tt), x - r, y - r, 2 * r, 2 * r);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  return { canvas, x0, y0, w: W, h: H };
}

/** Draws the haze buffer in world space (the camera transform already set). */
export function drawHaze(ctx, haze, alpha = 1) {
  if (!haze || !haze.canvas) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(haze.canvas, haze.x0, haze.y0, haze.w, haze.h);
  ctx.restore();
}

/** The dust's specks split by brightness level (0, 1, 2), each [x, y, r] in their original order. Pure. */
export function dustLevels(dust) {
  const out = [[], [], []];
  for (let q = 0; q < dust.length; q += 4) {
    const a = dust[q + 3], level = a < 0.11 ? 0 : a < 0.18 ? 1 : 2;
    out[level].push(dust[q], dust[q + 1], dust[q + 2]);
  }
  return out.map(l => Float32Array.from(l));
}

/** The dust: tiny specks at their world places, drawn crisp at screen size (screen transform set). */
export function drawDust(ctx, parts, { k, tx, ty, w, h, alpha = 1 }) {
  for (const p of parts) {
    const sx = tx + k * p.cx, sy = ty + k * p.cy, sr = k * p.R * 1.6 + 20;
    if (sx + sr < 0 || sx - sr > w || sy + sr < 0 || sy - sr > h) continue;
    // the specks sorted by brightness once (job 9: three passes over all of them every frame were among the
    // heaviest work of a pan); the same rects in the same order as before
    const byLevel = p.dustLevels || (p.dustLevels = dustLevels(p.dust));
    for (const lv of [0, 1, 2]) {
      const d = byLevel[lv];
      if (!d.length) continue;
      ctx.fillStyle = `rgba(${p.dustRgb},${((0.08 + lv * 0.07) * alpha).toFixed(3)})`;
      ctx.beginPath();
      for (let q = 0; q < d.length; q += 3) {
        const x = tx + k * d[q], y = ty + k * d[q + 1], r = d[q + 2];
        if (x < -2 || y < -2 || x > w + 2 || y > h + 2) continue;
        ctx.rect(x - r, y - r, 2 * r, 2 * r);
      }
      ctx.fill();
    }
  }
}

/** Frees the haze buffer (the map is leaving, or a new one replaces it). */
export function releaseHaze(haze) {
  if (haze && haze.canvas) { try { haze.canvas.width = 0; haze.canvas.height = 0; } catch (e) { /* detached */ } haze.canvas = null; }
}
