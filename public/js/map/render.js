// The frame (plan §9 Renderer, drawn as concept 8a: the night sky, yield-weighted, clean dots). Three canvases over a
// starfield (scene, names, over), redrawn only when what they show has changed:
//   the scene (static layer): galaxy haze and nebulae, dust, the threads (cut beneath every name), glows, clean
//     dots with their hot cores, unseen rings and marks; the galaxy titles and topic names go on their own canvas
//     just above it (so a hover can dim them with CSS, as in the concept, without a redraw). Both are redrawn when
//     the camera moves, the data changes or a colour tweens, and never while only the pointer moves.
//   the over layer (hover layer): the veil, the hovered topic's threads, its neighbours and their names, the grown
//     topic with its ring and name, and the selection ring. Hovering redraws only this.
// Everything is drawn at devicePixelRatio for the current zoom, every frame the camera moves, so dots, threads and
// text are crisp at every zoom: nothing is ever a scaled-up bitmap except the haze, which is soft by nature.
// The renderer only reads arrays from the scene; it never computes a score.
import { drawLinks, threadPoint, shownLinks } from './links-draw.js';
import { drawHaze, drawDust } from './halos.js';
import { drawGlows, drawNodes, drawMarks, drawOne, drawnRadius } from './nodes.js';
import { placeMapLabels, labelText, revealCap, KO, FADE_MS, SPOTS, spotBox, overlaps, gapTo, overlapArea } from './labels.js';
import { TYPE_NAMES, isMixedRow, A, B, TYPE } from '../shared/link-rank.js';
import { loudOf } from './data.js';
import { SETTLE_MS, marginFor, placement, usable, moveBox, sigOf, sameSig, createPace, lodOverrides } from './motion.js';
import { createSprites } from './sprites.js';

export const DPR_MAX = 2;
const CULL_PX = 40;
export const DOT_GROWTH = 0.65;
export const dotScaleFor = ratio => (ratio > 1 ? ratio ** (DOT_GROWTH - 1) : 1);
const TAU = Math.PI * 2;
export const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
export const titleFont = px => `700 ${px}px ${FONT}`;
export const subFont = px => `500 ${px}px ${FONT}`;

/**
 * The name boxes for this frame (screen px), each at its galaxy's fixed centre: [{c, box, t}], only those showing
 * (alpha above nothing) and on screen. halos: halos.js; titles: clearing.js titleState per halo.
 */
export function titleBoxes(halos, titles, { k, tx, ty, w, h, light = false, measure }) {
  const out = [];
  if (!halos || !titles) return out;
  halos.forEach((hl, q) => {
    const st = titles[q];
    if (!st || st.alpha < 0.02) return;
    const x = tx + k * hl.cx, y = ty + k * hl.cy;
    const sub = st.subAlpha > 0.02 && hl.line2 ? hl.line2 : '';
    const nh = st.font * 1.15, sw = sub ? measure(subFont(st.subFont), sub) : 0;
    const bw = Math.max(st.w, sw) + 4, bh = nh + (sub ? 3 + st.subFont * 1.2 : 0);
    const box = { x: x - bw / 2, y: y - bh / 2, w: bw, h: bh };
    if (box.x + box.w < 0 || box.x > w || box.y + box.h < 0 || box.y > h) return;
    out.push({ c: hl.c, box, t: { name: hl.title, sub, alpha: st.alpha, subAlpha: st.subAlpha, font: titleFont(st.font), sub_font: subFont(st.subFont), nh } });
  });
  return out;
}
export const NAME_FONT = `600 13.5px ${FONT}`, NB_FONT = `500 11.5px ${FONT}`, PILL_FONT = `500 10.5px ${FONT}`, SUB_FONT = `600 9.5px ${FONT}`;
// The search list's active result (25 Oct): its name bold and a size up, in the highlight colour.
export const ACTIVE_PX = 14.5, ACTIVE_FONT = `700 ${ACTIVE_PX}px ${FONT}`;
export const BADGE_H = 14;
export const LEARN_NEXT_WORD = 'LEARN NEXT';
let badgeW = 0;
export const learnNextWidth = ctx => { if (!badgeW) { ctx.save(); ctx.font = SUB_FONT; badgeW = ctx.measureText(LEARN_NEXT_WORD).width + 1.4 * 12 + 2; ctx.restore(); } return badgeW; };

/**
 * Three stacked canvases (scene, names, over) sized to their box at the device's pixel ratio (capped at 2), drawn
 * on request: one animation frame draws whichever layers are dirty. request('scene' | 'over' | 'both'); the
 * names are drawn with the scene.
 */
export function createLayers(sceneCanvas, labelCanvas, overCanvas, { drawScene, drawOver, onResize = () => {} }) {
  const sctx = sceneCanvas.getContext('2d');
  const lctx = labelCanvas.getContext('2d');
  const octx = overCanvas.getContext('2d');
  let raf = 0, w = 1, h = 1, dpr = 1, cap = DPR_MAX, alive = true, dirtyScene = true, dirtyOver = true;
  // The box is read only when it may have changed (the ResizeObserver says so, or resize() is called), never every
  // frame: a getBoundingClientRect per frame forced a layout on every frame of a pan (job 9). A changed pixel ratio
  // (a window dragged to another screen) is a plain number, checked every frame.
  let needSize = true, wakeTimer = 0;
  const ratioNow = () => Math.min(cap, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1));
  const size = () => {
    needSize = false;
    const r = sceneCanvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const nd = Math.min(cap, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1));
    if (nw === w && nh === h && nd === dpr && sceneCanvas.width === Math.round(nw * nd)) return false;
    w = nw; h = nh; dpr = nd;
    for (const c of [sceneCanvas, labelCanvas, overCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    dirtyScene = dirtyOver = true;
    onResize(w, h);
    return true;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { needSize = true; if (size()) api.request('both'); }) : null;
  if (ro) ro.observe(sceneCanvas);
  const stats = { scene: [], over: [], frames: [] };
  let lastFrame = 0;
  const frame = now => {
    raf = 0;
    if (!alive) return;
    if (needSize || !ro || ratioNow() !== dpr) size();
    // wake(ms): the scene asks to be drawn again in ms (the picture of a moving map settles into a full paint).
    const info = { w, h, dpr, now, still: false, wake };
    let more = false;
    if (lastFrame) stats.frames.push(now - lastFrame);
    lastFrame = now;
    if (dirtyScene) {
      dirtyScene = false;
      const t0 = performance.now();
      if (drawScene(sctx, lctx, info)) { dirtyScene = true; more = true; }
      stats.scene.push(performance.now() - t0);
      if (!info.still) dirtyOver = true;   // the over layer follows the scene's camera (a frame that changed nothing: not)
    }
    if (dirtyOver) {
      dirtyOver = false;
      const t0 = performance.now();
      if (drawOver(octx, info)) { dirtyOver = true; more = true; }
      stats.over.push(performance.now() - t0);
    }
    for (const k of ['scene', 'over', 'frames']) if (stats[k].length > 600) stats[k].splice(0, 300);
    if (more) schedule(); else lastFrame = 0;
  };
  const wake = ms => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { wakeTimer = 0; api.request('scene'); }, ms);
  };
  const schedule = () => {
    if (raf || !alive) return;
    // While the page is hidden there are no animation frames; a timer keeps a pending change from waiting.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { raf = -setTimeout(() => frame(performance.now()), 32); return; }
    raf = requestAnimationFrame(frame);
  };
  const api = {
    get w() { return w; }, get h() { return h; }, get dpr() { return dpr; },
    stats,
    request(which = 'both') {
      if (which === 'scene' || which === 'both') dirtyScene = true;
      if (which === 'over' || which === 'both') dirtyOver = true;
      schedule();
    },
    resize() { if (size()) api.request('both'); },
    setDprCap(c) { cap = c; if (size()) api.request('both'); },
    destroy() {
      alive = false;
      clearTimeout(wakeTimer);
      if (raf > 0) cancelAnimationFrame(raf); else if (raf < 0) clearTimeout(-raf);
      raf = 0;
      if (ro) ro.disconnect();
      for (const c of [sceneCanvas, labelCanvas, overCanvas]) { try { c.width = 0; c.height = 0; } catch (e) { /* gone */ } }
    },
  };
  size();
  return api;
}

// Text widths, measured once per font and string.
const widths = new Map();
export function textWidth(ctx, font, text, spacing = 0) {
  const key = font + '|' + spacing + '|' + text;
  let v = widths.get(key);
  if (v == null) {
    ctx.font = font;
    v = ctx.measureText(text).width + spacing * Math.max(0, text.length - 1);
    if (widths.size > 8000) widths.clear();
    widths.set(key, v);
  }
  return v;
}

// An rgb or hex colour at an alpha, for fading token colours (strokeStyle alpha multiplies globalAlpha).
export function withAlpha(colour, a) {
  const c = String(colour).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const v = hex[1];
    return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a.toFixed(3)})`;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(',').map(s => s.trim());
    const base = p.length > 3 ? Number(p[3]) : 1;
    return `rgba(${p[0]},${p[1]},${p[2]},${(base * a).toFixed(3)})`;
  }
  return c;
}

// Text with a soft dark halo (concept 8a's text shadow), drawn crisp at the device's pixel ratio.
export function haloText(ctx, text, x, y, fill, halo, night) {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (night) { ctx.strokeStyle = withAlpha(halo, 0.42); ctx.lineWidth = 6; ctx.strokeText(text, x, y); }
  ctx.strokeStyle = halo; ctx.lineWidth = 3; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// The names' pictures (sprites.js): each name stroked and filled once, then copied (job 9). The context's transform
// must be setTransform(dpr, 0, 0, dpr, 0, 0) and x, y snapped to device pixels, as for haloText.
const sprites = createSprites({ paint: haloText });
function spriteText(ctx, text, x, y, fill, halo, night, dpr, font, align = 'left') {
  if (sprites.draw(ctx, { text, font, x, y, fill, halo, night, dpr, align, measure: (f, t) => textWidth(ctx, f, t) })) return;
  ctx.font = font; ctx.textAlign = align;
  haloText(ctx, text, x, y, fill, halo, night);
}
export const _sprites = sprites;   // for the tests and the profile

// Letter-spaced capitals for galaxy titles: the canvas's own letterSpacing where the browser has it, otherwise
// one letter at a time.
export function spacedText(ctx, text, x, y, spacing, stroke) {
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = `${spacing}px`;
    if (stroke) ctx.strokeText(text, x, y); else ctx.fillText(text, x, y);
    ctx.letterSpacing = '0px';
    return;
  }
  let cx = x;
  for (const ch of text) { if (stroke) ctx.strokeText(ch, cx, y); else ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
}

const snap = (v, dpr) => Math.round(v * dpr) / dpr;

/**
 * The highlight (search's active result, the hovered and the selected topic, 25 Oct): a soft glow and a crisp ring in
 * the theme's --map-focus colours, gap px off the dot (world transform set; r in world units).
 */
export function focusRing(ctx, x, y, r, k, tk, { gap = 3, width = 2.25, alpha = 1, glow = true } = {}) {
  const R = r + (gap + width / 2) / k;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (glow) {
    ctx.strokeStyle = tk['--map-focus-glow'] || 'rgba(120,196,255,.55)'; ctx.lineWidth = (width + 5) / k;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
  }
  ctx.strokeStyle = tk['--map-focus'] || '#ffffff'; ctx.lineWidth = width / k;
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
  ctx.restore();
}

// The threads' bends as shown (the clearing moves their ends a little; main.js), or as saved.
export const curvesOf = S => S.vcurves || S.curves;

/** The camera, zoom ratio, culled list and drawn radii for one frame (shared by both layers). */
export function frameView(S, w, h) {
  const m = S.dm || S.model, cam = S.cam;
  const { k, x: tx, y: ty } = cam.transform;
  const ratio = k / (cam.kFit || k);
  const dotScale = dotScaleFor(ratio);
  const list = S.list || (S.list = []);
  list.length = 0;
  const x0 = (-tx - CULL_PX) / k, y0 = (-ty - CULL_PX) / k, x1 = (w - tx + CULL_PX) / k, y1 = (h - ty + CULL_PX) / k;
  for (let i = 0; i < m.n; i++) {
    if (!m.placed[i]) continue;
    const r = m.r[i] * 2;
    if (m.x[i] + r < x0 || m.x[i] - r > x1 || m.y[i] + r < y0 || m.y[i] - r > y1) continue;
    list.push(i);
  }
  return { k, tx, ty, ratio, dotScale, list, w, h };
}

// Which names must show whatever else does: the selected topic and the one Claude is teaching now.
function mustSet(S) {
  const out = new Set(S.forcedLabels || []);
  if (S.selected >= 0) out.add(S.selected);
  return out;
}

const topicFont = (m, i) => {
  const u = loudOf(m.yield100[i] / 100);
  const size = Math.round((11 + 2 * u) * 2) / 2;
  return { font: `${m.yield100[i] >= 85 ? 500 : 400} ${size}px ${FONT}`, size };
};

// Each topic's name, font and width, worked out once per model (names grow with yield, as in the concept).
function nameCache(ctx, S) {
  const m = S.model;
  if (S.nameCache && S.nameCache.model === m && S.nameCache.n === m.n) return S.nameCache;
  const text = new Array(m.n), font = new Array(m.n), size = new Float32Array(m.n), width = new Float32Array(m.n);
  for (let i = 0; i < m.n; i++) {
    text[i] = labelText(m.name[i], m.short[i]);
    const f = topicFont(m, i);
    font[i] = f.font; size[i] = f.size;
    width[i] = -1;
  }
  S.nameCache = { model: m, n: m.n, text, font, size, width };
  return S.nameCache;
}

/**
 * The galaxy titles and topic names for this frame (screen px), placed by labels.js, never overlapping. Kept on
 * the scene (S.placed) for the over layer, the knockout, taps on a title and the audit.
 */
function layoutNames(ctx, S, v, now) {
  const m = S.dm || S.model, { k, tx, ty, ratio, dotScale, w, h } = v;
  // The system names, fixed at their galaxies' centres (clearing.js sizes and fades them); topic names keep off them.
  const cats = titleBoxes(S.halos, S.titles, { k, tx, ty, w, h, light: S.pal && S.pal.theme === 'light', measure: (font, text) => textWidth(ctx, font, text) });
  const must = mustSet(S);
  const hvNode = S.hover.node;
  const veilUp = S.hoverVeil > 0.01;
  const hoverSet = new Set();
  if (hvNode >= 0 && veilUp) { hoverSet.add(hvNode); for (const j of S.hoverNeighbours(hvNode)) hoverSet.add(j); }
  const spot = S.spot && S.spot.nodes && S.spot.nodes.size ? S.spot.nodes : null;
  const prev = S.labelPrev || new Map();
  const nc = nameCache(ctx, S);
  const cands = [];
  const cap = revealCap(ratio, S.labelCap ?? 60);   // ?? not ||: 0 is "key names only", not "unset"
  const maxCands = cap * 4 + 40;
  let ordinary = 0;
  const addCand = (i, isMust, font = null) => {
    if (!isMust && ordinary >= maxCands) return;
    const sx = tx + k * m.x[i], sy = ty + k * m.y[i];
    if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) return;
    if (nc.width[i] < 0) { ctx.font = nc.font[i]; nc.width[i] = ctx.measureText(nc.text[i]).width; }
    const r = drawnRadius(m, i, k, dotScale) * k;
    if (!isMust) ordinary++;
    // the search list's active result: bold, a size up (its own width and height)
    if (font) { cands.push({ i, x: sx, y: sy, r: r + 7, w: textWidth(ctx, font, nc.text[i]), h: Math.ceil(ACTIVE_PX * 1.25), nameH: Math.ceil(ACTIVE_PX * 1.25), badge: false, must: true, active: true, prev: prev.has(i) ? prev.get(i).spot : null, text: nc.text[i], font }); return; }
    const nameH = Math.ceil(nc.size[i] * 1.25);
    // The Learn next topic carries its "LEARN NEXT" line inside its own box (DES4-07), so the line is kept off stars,
    // titles and threads by the same rules as the name.
    const badge = S.teach && S.teach.next && S.teach.next.has(i) ? learnNextWidth(ctx) : 0;
    cands.push({ i, x: sx, y: sy, r, w: Math.max(nc.width[i], badge), h: nameH + (badge ? BADGE_H : 0), nameH, badge: !!badge,
      ...(badge ? { alt: { w: nc.width[i], h: nameH }, altPrev: !!(prev.has(i) && prev.get(i).alt) } : {}),
      must: isMust, prev: prev.has(i) ? prev.get(i).spot : null, text: nc.text[i], font: nc.font[i] });
  };
  for (const i of must) if (m.placed[i] && !(S.dim && S.dim[i]) && !hoverSet.has(i)) addCand(i, true);
  const act = spot && S.searchActive != null && spot.has(S.searchActive) && m.placed[S.searchActive] ? S.searchActive : -1;
  if (act >= 0 && !hoverSet.has(act)) addCand(act, true, ACTIVE_FONT);
  if (spot) for (const i of spot) if (i !== act && m.placed[i] && !must.has(i) && !hoverSet.has(i)) addCand(i, true);
  // Then by tier and priority (main.js's labelOrder), the names already showing first within their tier.
  const order = S.labelOrder || [];
  const tierOf = S.labelTier || (() => 3);
  let pending = [];
  let tier = -1;
  const flush = () => { pending.sort((a, b) => (prev.has(b) - prev.has(a))); for (const i of pending) addCand(i, false); pending = []; };
  for (const i of spot ? [] : order) {
    if (must.has(i) || !m.placed[i] || (S.dim && S.dim[i]) || hoverSet.has(i)) continue;
    const t = tierOf(i);
    if (t !== tier) { flush(); tier = t; }
    pending.push(i);
  }
  flush();
  // The bright look-alike threads (mixed-up pairs) are kept clear of ordinary names, as stars are: their points,
  // every 6 px on screen, go on a coarse grid and count as tiny stars that belong to no galaxy.
  const pairCells = new Map(), CELLPX = 32;
  if (S.linkSel && curvesOf(S)) {
    for (const li of S.linkSel) {
      const l = m.links[li];
      if (!isMixedRow(l) || (S.dim && (S.dim[l[A]] || S.dim[l[B]]))) continue;
      const x1 = tx + k * m.x[l[A]], y1 = ty + k * m.y[l[A]], x2 = tx + k * m.x[l[B]], y2 = ty + k * m.y[l[B]];
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > w || Math.max(y1, y2) < 0 || Math.min(y1, y2) > h) continue;
      const cx = tx + k * curvesOf(S).qx[li], cy = ty + k * curvesOf(S).qy[li];
      const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
      for (let q = 1; q < steps; q++) {
        const [px, py] = threadPoint(q / steps, x1, y1, x2, y2, cx, cy);
        const key = Math.floor(px / CELLPX) * 100003 + Math.floor(py / CELLPX);
        const list = pairCells.get(key);
        const pt = { i: -1, x: px, y: py, r: 2.5, cat: -1 };
        if (list) list.push(pt); else pairCells.set(key, [pt]);
      }
    }
  }
  const near = box => {
    const wx0 = (box.x - tx) / k, wy0 = (box.y - ty) / k, wx1 = (box.x + box.w - tx) / k, wy1 = (box.y + box.h - ty) / k;
    const pad = 12 / k;
    const out = [];
    for (const j of S.picker.within(wx0 - pad, wy0 - pad, wx1 + pad, wy1 + pad)) {
      if (S.dim && S.dim[j]) continue;
      const r = drawnRadius(m, j, k, dotScale) * k * (m.t[j] < 0 ? 0.8 : 1);
      out.push({ i: j, x: tx + k * m.x[j], y: ty + k * m.y[j], r, cat: m.cat[j] });
    }
    if (pairCells.size) {
      for (let gx = Math.floor((box.x - 4) / CELLPX); gx <= Math.floor((box.x + box.w + 4) / CELLPX); gx++)
        for (let gy = Math.floor((box.y - 4) / CELLPX); gy <= Math.floor((box.y + box.h + 4) / CELLPX); gy++) {
          const list = pairCells.get(gx * 100003 + gy);
          if (list) for (const pt of list) if (pt.x > box.x - 3 && pt.x < box.x + box.w + 3 && pt.y > box.y - 3 && pt.y < box.y + box.h + 3) out.push(pt);
        }
    }
    return out;
  };
  const keepClear = [...(S.beadBoxes || []), ...(S.familyBoxes || []), ...(S.holeBoxes || [])];
  const res = placeMapLabels({ cats, cands, near, blocked: keepClear.length ? [...(S.blocked || []), ...keepClear] : S.blocked || [], w, h, cap,
    deadline: performance.now() + (S.cam.gesturing || S.bench ? 4 : 12), clock: () => performance.now() });
  // Fade new names in; keep each name's spot for the next frame.
  const next = new Map();
  const byI = new Map(cands.map(c => [c.i, c]));
  const topics = res.topics.map(p => {
    const c = byI.get(p.i);
    const was = prev.get(p.i);
    const since = was ? was.since : now;
    next.set(p.i, { spot: p.spot, since, alt: !!p.alt });
    return { ...p, text: c.text, font: c.font, nameH: c.nameH, badge: c.badge && !p.alt, since, active: !!c.active };
  });
  S.labelPrev = next;
  return { cats: res.cats, topics, dropped: res.dropped, ratio };
}

// ------------------------------------------------------------------ the map in motion (motion.js)

// The picture's buffers are plain canvases: an OffscreenCanvas copied into the page's canvas cost five times as
// much in Chrome's profile (a transfer every frame).
function buffer(old, W, H) {
  if (old && old.width === W && old.height === H) return old;
  if (old) { old.width = W; old.height = H; return old; }
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(W, H);
  return null;
}

// The scene seen through a few overrides (another camera, the quality level): reads fall through to S, and what the
// paint writes (its frame, view, names) stays on the overlay until copied back.
const through = (S, over) => Object.assign(Object.create(S), over);
const copyBack = (S, P) => { for (const key of Object.keys(P)) if (!LOD_KEYS.has(key)) S[key] = P[key]; };
const LOD_KEYS = new Set(['skyParts', 'glows', 'labelCap', 'cam', 'blocked']);

/**
 * Draws the scene and its names. Returns true while something is still animating. On a slow device a moving
 * camera moves a picture of the map (motion.js); a still one, a fast device and any change of what the map shows
 * are painted in full.
 */
export function drawScene(ctx, lctx, S, info) {
  const { w, h, dpr, now } = info;
  if (!S.model || !S.model.n || !S.cam || !S.pal || !S.tweens) return paintScene(ctx, lctx, S, info);
  const M = S.motion || (S.motion = { pace: createPace(), snap: null, last: null, movedAt: -Infinity, sig: null, scene: null, labels: null });
  const T = S.cam.transform;
  const moved = !M.last || M.last.k !== T.k || M.last.x !== T.x || M.last.y !== T.y;
  if (moved) { if (M.last && M.last.k !== T.k) M.zoomAt = now; M.last = { k: T.k, x: T.x, y: T.y }; M.movedAt = now; }
  const moving = moved || now - M.movedAt < SETTLE_MS;
  const sig = sigOf(S, w, h, dpr);
  const changed = !sameSig(sig, M.sig);
  M.sig = sig;
  const animating = S.tweens.size > 0 || (S.appear && S.appear.size > 0) || !!S.move;
  const wake = typeof info.wake === 'function' ? info.wake : () => {};
  if (!moving || !M.pace.slow || animating || changed || S.bench) {
    // A full paint at the camera as it is: at rest whole; while moving on a slow device, at its quality level.
    M.snap = null;
    const lod = moving && M.pace.slow ? lodOverrides(M.pace.level, S) : null;
    const t0 = performance.now();
    let more;
    if (lod && Object.keys(lod).length) { const P = through(S, lod); more = paintScene(ctx, lctx, P, info); copyBack(S, P); wake(SETTLE_MS); }
    else more = paintScene(ctx, lctx, S, info);
    M.pace.note(performance.now() - t0);
    if (moving && M.pace.slow) wake(SETTLE_MS);
    return more;
  }
  // A scaled copy is cheap where the canvas is on the GPU and dear where it is not (software canvas: Chrome's
  // headless profile): once a scaled copy has cost more than half a paint, a zoom paints instead (at the quality
  // level), and only pans copy the picture.
  const scaleOK = !(M.scaledMs > 0.5 * M.pace.ema);
  if (!scaleOK && now - (M.zoomAt ?? -Infinity) < SETTLE_MS) {
    M.snap = null;
    const P = through(S, lodOverrides(M.pace.level, S));
    const t0 = performance.now();
    const more = paintScene(ctx, lctx, P, info);
    copyBack(S, P);
    M.pace.note(performance.now() - t0);
    wake(SETTLE_MS);
    return more;
  }
  if (!usable(M.snap, T, w, h, dpr)) {
    // A new picture: the scene and its names painted a margin larger than the screen, at this camera.
    const m = marginFor(w, h), W = w + 2 * m, H = h + 2 * m;
    M.scene = buffer(M.scene, Math.round(W * dpr), Math.round(H * dpr));
    M.labels = buffer(M.labels, Math.round(W * dpr), Math.round(H * dpr));
    const sc = M.scene && M.scene.getContext('2d'), lc = M.labels && M.labels.getContext('2d');
    if (!sc || !lc) { M.pace.reset(); return paintScene(ctx, lctx, S, info); }
    const P = through(S, {
      cam: { transform: { k: T.k, x: T.x + m, y: T.y + m }, kFit: S.cam.kFit, gesturing: true },
      blocked: (S.blocked || []).map(b => ({ ...b, x: b.x + m, y: b.y + m })), lastPlace: null,
      ...lodOverrides(M.pace.level, S),
    });
    const t0 = performance.now();
    paintScene(sc, lc, P, { ...info, w: W, h: H });
    M.pace.note(performance.now() - t0);
    if (Object.prototype.hasOwnProperty.call(P, 'nameCache')) S.nameCache = P.nameCache;
    // The names go into the scene's picture too (one copy a frame instead of two), unless a hover has them dimmed
    // (the names canvas carries that dim in CSS).
    const merged = !((S.hoverVeil || 0) > 0.01);
    if (merged) { sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalAlpha = 1; sc.globalCompositeOperation = 'source-over'; sc.drawImage(M.labels, 0, 0); }
    M.snap = { k: T.k, x: T.x, y: T.y, m, w, h, dpr, merged, cleared: false, names: P.placed, spotBoxes: P.spotBoxes, view: P.view };
  } else if (!moved) {
    // The picture is on screen already and the camera has not moved: nothing to draw until the map settles.
    info.still = true;
    wake(Math.max(16, SETTLE_MS - (now - M.movedAt)));
    return false;
  }
  // The picture where the camera has it now: one drawImage per canvas.
  const p = placement(M.snap, T);
  let px = p.x, py = p.y;
  if (Math.abs(p.f - 1) < 1e-9) { px = Math.round(px * dpr) / dpr; py = Math.round(py * dpr) / dpr; }   // a pan: whole pixels, sharp
  const layers = M.snap.merged ? [[ctx, M.scene]] : [[ctx, M.scene], [lctx, M.labels]];
  if (M.snap.merged && !M.snap.cleared) { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, lctx.canvas.width, lctx.canvas.height); M.snap.cleared = true; }
  const tb = performance.now();
  for (const [c, buf] of layers) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = true;
    // 'copy' replaces every pixel (the picture covers the screen): no separate clear
    c.globalCompositeOperation = 'copy';
    c.drawImage(buf, px, py, p.w, p.h);
    c.globalCompositeOperation = 'source-over';
  }
  if (p.f !== 1) { const ms = performance.now() - tb; M.scaledMs = M.scaledMs == null ? ms : M.scaledMs + 0.3 * (ms - M.scaledMs); }
  // The rest of the map (the hover layer, a tap on a title, the orbits) reads this frame from the scene.
  const q = { ...p, x: px, y: py };
  S.frame = frameView(S, w, h);
  S.view = { ...M.snap.view, k: T.k, list: S.frame.list };
  const names = M.snap.names;
  if (names) S.placed = { ...names, cats: names.cats.map(c => ({ ...c, box: moveBox(c.box, q) })), topics: names.topics.map(t => ({ ...t, box: moveBox(t.box, q) })) };
  S.spotBoxes = M.snap.spotBoxes ? M.snap.spotBoxes.map(b => moveBox(b, q)) : null;
  wake(SETTLE_MS);
  return false;
}

export function placeNames(ctx, S, v, now) {
  const m = S.dm || S.model, { k, tx, ty, w, h } = v;
  const key = `${k}|${w}x${h}|${S.dim ? 1 : 0}|${S.spot ? 1 : 0}|${S.selected}|${S.hover.node}|${S.searchActive ?? -1}|${(S.blocked || []).length}`;
  const lp = S.lastPlace;
  let names;
  if (S.cam.gesturing && lp && lp.key === key && lp.model === m) {
    const dx = tx - lp.tx, dy = ty - lp.ty;
    const inView = b => b.x >= 6 && b.x + b.w <= w - 6 && b.y >= 4 && b.y + b.h <= h - 4 && !(S.blocked || []).some(o => overlaps(b, o, 4));
    const move = b => ({ ...b, x: b.x + dx, y: b.y + dy });
    names = { ...lp.names, cats: lp.names.cats.map(c => ({ ...c, box: move(c.box) })),
      topics: lp.names.topics.map(t => ({ ...t, box: move(t.box) })).filter(t => inView(t.box)) };
  } else names = layoutNames(ctx, S, v, now);
  S.lastPlace = { key, model: m, tx, ty, names: lp && lp.key === key && S.cam.gesturing && lp.model === m ? lp.names : names };
  if (S.lastPlace.names !== names) { S.lastPlace.tx = lp.tx; S.lastPlace.ty = lp.ty; }
  S.placed = names;
  return names;
}

/** Paints the scene and its names at S.cam's camera. Returns true while something is still animating. */
function paintScene(ctx, lctx, S, { w, h, dpr, now }) {
  // The zoom decides the clearing round each system's name (main.js, clearing.js): the stars as shown this frame.
  if (S.updateDisplay && S.cam && S.model) { const k0 = S.cam.transform.k; S.updateDisplay(k0, k0 / (S.cam.kFit || k0)); }
  const m = S.dm || S.model, pal = S.pal, tk = S.tokens;
  for (const c of [ctx, lctx]) { c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h); }
  if (!m || !m.n || !S.cam) return false;
  const night = pal.theme !== 'light';
  const animTween = S.tweens.step(now), animAppear = S.appear.step(now);
  const v = frameView(S, w, h);
  const { k, tx, ty, dotScale } = v;
  S.frame = v;
  const tOf = i => (m.t[i] < 0 && !S.tweens.has(i) ? -1 : S.tweens.value(i, m.t[i]));
  const grow = i => dotScale * (S.appear.has(i) ? Math.max(0.01, S.appear.value(i, 1)) : 1);
  const view = { k, list: v.list, dim: S.dim, tOf, grow, glows: S.glows && !(S.lowPower && S.cam.gesturing), skip: null };
  S.view = view;
  const prof = S.prof || null;
  if (prof) prof.cur = {};
  let pt = prof ? performance.now() : 0;
  const mark = name => { if (prof) { const t = performance.now(); prof.cur[name] = (prof.cur[name] || 0) + t - pt; pt = t; } };

  // 1. The galaxies: their haze and nebulae (soft, from their buffer), then the dust, crisp at screen size.
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
  if (S.haze) drawHaze(ctx, S.haze, S.dim ? 0.55 : 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mark('haze');
  if (S.skyParts && night) drawDust(ctx, S.skyParts, { k, tx, ty, w, h, alpha: S.dim ? 0.5 : 1 });
  mark('dust');

  const names = placeNames(ctx, S, v, now);
  mark('place');
  const lines = shownLinks(S);
  const showLinks = !(S.linksAtRestOnly && S.cam.gesturing);
  if (showLinks && lines && lines.length) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cut = new Path2D();
    cut.rect(-10, -10, w + 20, h + 20);
    for (const c of names.cats) cut.rect(c.box.x - KO, c.box.y - KO, c.box.w + 2 * KO, c.box.h + 2 * KO);
    for (const t of names.topics) cut.rect(t.box.x - KO, t.box.y - KO, t.box.w + 2 * KO, t.box.h + 2 * KO);
    ctx.clip(cut, 'evenodd');
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    // On the whole map a mixed-up pair shows at 55% (25 Oct: quiet, so the stars lead); it comes up to full on hover.
    drawLinks(ctx, { links: m.links, indices: lines, x: m.x, y: m.y, layer: 'base', tokens: S.linkTokens, k, qx: curvesOf(S) && curvesOf(S).qx, qy: curvesOf(S) && curvesOf(S).qy, pairFade: 0.55 });
    if (S.sysLinks && S.sysLinks.length) drawLinks(ctx, { links: m.links, indices: S.sysLinks, x: m.x, y: m.y, layer: 'focus', tokens: S.linkTokens, k,
      radius: j => drawnRadius(m, j, k, dotScale) + 3 / k, qx: curvesOf(S) && curvesOf(S).qx, qy: curvesOf(S) && curvesOf(S).qy });
    ctx.restore();
  }

  mark('links');
  // 3. Glows, clean dots with their cores, unseen rings, marks.
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
  drawGlows(ctx, m, view, pal);
  mark('glows');
  drawNodes(ctx, m, view, pal);
  drawMarks(ctx, m, view, tk['--map-mark'], S.teach);
  // This morning's picks (named by default): a fine ring in the highlight colour, so they can be found at a glance.
  if (S.picks && S.picks.size) for (const i of S.picks) {
    if (!m.placed[i] || (S.dim && S.dim[i]) || i === S.selected) continue;
    focusRing(ctx, m.x[i], m.y[i], drawnRadius(m, i, k, grow(i)), k, tk, { gap: 2.5, width: 1.4, alpha: 0.75, glow: false });
  }
  mark('dots');

  // 4. Galaxy titles and topic names, in screen px, on the names canvas.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sceneCtx = ctx;
  ctx = lctx;
  let fading = false;
  const spot = S.spot && S.spot.nodes && S.spot.nodes.size ? S.spot : null;
  // The system names: still, centred in their clearing (just sky: no plate, no halo; the threads are cut beneath
  // them); the counts line under the name, quieter, once there is room.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const c of names.cats) {
    const t = c.t;
    if (!t) continue;
    const cx = snap(c.box.x + c.box.w / 2, dpr), ny = snap(c.box.y + t.nh / 2, dpr);
    ctx.globalAlpha = t.alpha;
    ctx.font = t.font;
    // a soft halo in the sky's colour keeps the name crisp over a bright core or a cloud
    ctx.strokeStyle = tk['--map-cat-halo']; ctx.lineWidth = 4; ctx.strokeText(t.name, cx, ny);
    ctx.fillStyle = tk['--map-cat-label'];
    ctx.fillText(t.name, cx, ny);
    if (t.sub && t.subAlpha > 0.02) {
      ctx.globalAlpha = t.subAlpha;
      ctx.font = t.sub_font;
      haloText(ctx, t.sub, cx, snap(c.box.y + t.nh + 3 + (c.box.h - t.nh - 3) / 2, dpr), tk['--map-unit-label'], tk['--map-label-halo'], night);
    }
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Names (a spot's names while one shows, placed by the same rules) on the names canvas, above the spot's veil.
  for (const t of names.topics) {
    const a = spot ? 1 : Math.min(1, (now - t.since) / FADE_MS);
    if (a < 1) fading = true;
    const i = t.i;
    const weak = m.t[i] >= 500, big = m.yield100[i] >= 85;
    const fill = t.active ? tk['--map-focus'] : spot || !night ? tk['--map-label'] : withAlpha(tk['--map-label'], weak ? 1 : big ? 0.95 : 0.88);
    const nameH = t.nameH || t.box.h;
    ctx.globalAlpha = Math.max(0, a);
    spriteText(ctx, t.text, snap(t.box.x, dpr), snap(t.box.y + nameH / 2, dpr), fill, tk['--map-label-halo'], night, dpr, t.font);
    if (t.badge) {   // the Learn next topic: the line inside the name's own box (DES4-07)
      ctx.font = SUB_FONT;
      ctx.fillStyle = night ? '#ffb27e' : '#b8470a';
      spacedText(ctx, LEARN_NEXT_WORD, snap(t.box.x, dpr), snap(t.box.y + nameH + BADGE_H / 2, dpr), 1.4, false);
    }
  }
  ctx.globalAlpha = 1;
  mark('text');
  if (prof) { for (const [k2, v2] of Object.entries(prof.cur)) (prof.sum[k2] = prof.sum[k2] || []).push(v2); }

  // 5. A spot (search results, a unit): the rest dims to about a quarter and the spot is drawn again on top; its
  // names were placed with the map's own rules above (DES4-03), and its threads are cut beneath every name.
  if (spot) {
    const sc = sceneCtx;
    sc.setTransform(dpr, 0, 0, dpr, 0, 0);
    sc.fillStyle = withAlpha(tk['--map-ground'], spot.veil ?? 0.62);
    sc.fillRect(0, 0, w, h);
    if (S.spotLinks && S.spotLinks.length) {
      sc.save();
      const cut = new Path2D();
      cut.rect(-10, -10, w + 20, h + 20);
      for (const c of names.cats) cut.rect(c.box.x - KO, c.box.y - KO, c.box.w + 2 * KO, c.box.h + 2 * KO);
      for (const t of names.topics) cut.rect(t.box.x - KO, t.box.y - KO, t.box.w + 2 * KO, t.box.h + 2 * KO);
      sc.clip(cut, 'evenodd');
      sc.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
      // a key row's lines are lit in their hues (spot.lit); a search's or a unit's stay as at rest
      drawLinks(sc, { links: m.links, indices: S.spotLinks, x: m.x, y: m.y, layer: spot.lit ? 'focus' : 'base', tokens: S.linkTokens, k,
        radius: j => drawnRadius(m, j, k, dotScale) + 3 / k, qx: curvesOf(S) && curvesOf(S).qx, qy: curvesOf(S) && curvesOf(S).qy });
      sc.restore();
    }
    sc.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    for (const i of spot.nodes) if (m.placed[i]) drawOne(sc, m, i, view, pal, grow(i));
    // the search list's active result: the highlight ring (its pulse is a DOM ring, main.js placeBeacon)
    const act = S.searchActive;
    if (act != null && act >= 0 && spot.nodes.has(act) && m.placed[act]) focusRing(sc, m.x[act], m.y[act], drawnRadius(m, act, k, grow(act)), k, tk, { gap: 3, width: 2.5 });
    sc.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.spotBoxes = names.topics.filter(t => spot.nodes.has(t.i)).map(t => ({ ...t.box }));
  } else S.spotBoxes = null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return animTween || animAppear || fading || !!S.move;
}

// ------------------------------------------------------------------ the hover layer

const LINK_WORDS = {
  versus: [l => (isMixedRow(l) ? 'look-alike, mixed up' : 'look-alike'), l => (isMixedRow(l) ? 'look-alike, mixed up' : 'look-alike')],
  treated_by: [() => 'treated by', () => 'treats'],
  adverse_effect: [() => 'can cause', () => 'side effect of'],
  causes: [() => 'leads to', () => 'caused by'],
};
/** The few words on a hover pill, from the hovered topic's side: "treated by", "caused by", "look-alike". */
export function linkWord(row, fromIndex) {
  const name = TYPE_NAMES[row[TYPE]] || 'versus';
  const w = LINK_WORDS[name] || LINK_WORDS.versus;
  return row[A] === fromIndex ? w[0](row) : w[1](row);
}

// Samples a thread every few px in screen space, so a box can ask whether a lit thread runs under it.
function threadSamples(S, v, idx) {
  const m = S.dm || S.model, { k, tx, ty } = v, pts = [];
  for (const li of idx) {
    const l = m.links[li];
    const x1 = tx + k * m.x[l[A]], y1 = ty + k * m.y[l[A]], x2 = tx + k * m.x[l[B]], y2 = ty + k * m.y[l[B]];
    const cx = curvesOf(S) ? tx + k * curvesOf(S).qx[li] : null, cy = curvesOf(S) ? ty + k * curvesOf(S).qy[li] : null;
    const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(6, Math.ceil(len / 3));
    for (let s = 0; s <= steps; s++) { const [x, y] = threadPoint(s / steps, x1, y1, x2, y2, cx, cy); pts.push(x, y); }
  }
  return b => { for (let q = 0; q < pts.length; q += 2) if (pts[q] > b.x - 2 && pts[q] < b.x + b.w + 2 && pts[q + 1] > b.y - 2 && pts[q + 1] < b.y + b.h + 2) return true; return false; };
}

/**
 * The hover layer's layout for topic i, once per topic and camera (concept 8a's hoverLayout): its own name above the
 * grown star where clear, the link pills on the longer threads, then its neighbours' names, each kept off the others
 * and off the lit threads (a name with no clear spot gets a dark plate, like the pills).
 */
export function hoverLayout(ctx, S, i, v) {
  const m = S.dm || S.model, { k, tx, ty, dotScale, w, h } = v;
  const key = `${i}|${k.toFixed(5)}|${tx.toFixed(2)}|${ty.toFixed(2)}|${w}x${h}`;
  if (S.hoverLay && S.hoverLay.key === key && S.hoverLay.placed === S.placed) return S.hoverLay;
  const idx = S.hoverLinks(i);
  const nb = S.hoverNeighbours(i).filter(j => m.placed[j]);
  const hits = threadSamples(S, v, idx);
  const sx = tx + k * m.x[i], sy = ty + k * m.y[i];
  const R = Math.max(drawnRadius(m, i, k, dotScale) * k * 1.45, drawnRadius(m, i, k, dotScale) * k + 5, 7);
  const inView = b => b.x > 6 && b.x + b.w < w - 6 && b.y > 4 && b.y + b.h < h - 4;
  const discs = [{ i, x: sx, y: sy, r: R }, ...nb.map(j => ({ i: j, x: tx + k * m.x[j], y: ty + k * m.y[j], r: drawnRadius(m, j, k, dotScale) * k }))];
  const discArea = (b, self) => discs.reduce((s, d) => (d.i === self ? s : s + overlapArea(b, { x: d.x - d.r - 2, y: d.y - d.r - 2, w: 2 * d.r + 4, h: 2 * d.r + 4 })), 0);
  const boxes = [...(S.blocked || [])].map(b => ({ ...b, blocked: true }));
  // The names the map shows under the veil (the names canvas is not redrawn for a hover): the other topics' names and
  // the galaxy titles are kept clear of, and each neighbour keeps its own spot while it is clear, so no name shows
  // twice; a name that must move has its dim copy painted out (erase), drawn by drawOver (DES4-05).
  const baseTopics = (S.placed && S.placed.topics) || [];
  const base = new Map(baseTopics.map(t => [t.i, t]));
  const mine = new Set([i, ...nb]);
  for (const t of baseTopics) if (!mine.has(t.i)) boxes.push({ ...t.box, base: true });
  for (const c of (S.placed && S.placed.cats) || []) boxes.push({ ...c.box, base: true });
  const reserved = new Map();
  for (const j of nb) if (j !== i && base.has(j)) { const r = { ...base.get(j).box, nb: j }; reserved.set(j, r); boxes.push(r); }
  const erase = [];
  const nameText = labelText(m.name[i], null);
  const nw = textWidth(ctx, NAME_FONT, nameText);
  let nameBox = null, best = Infinity;
  for (let s = 0; s < SPOTS.length; s++) {
    const b = spotBox(s, sx, sy, R + 3, nw, 16);
    if (SPOTS[s][3] > 12 || !inView(b) || boxes.some(o => overlaps(b, o, 2))) continue;
    const above = Math.abs(b.x + nw / 2 - sx) < 1 && b.y < sy;
    const cost = (above ? 0 : 2 + SPOTS[s][3]) + 150 * (hits(b) ? 1 : 0) + 3 * discArea(b, i);
    if (cost < best) { best = cost; nameBox = b; }
  }
  if (!nameBox) nameBox = { x: Math.max(8, Math.min(w - 8 - nw, sx - nw / 2)), y: Math.max(6, sy - R - 22), w: nw, h: 16 };
  boxes.push(nameBox);
  if (base.has(i)) erase.push({ i, box: base.get(i).box });
  const pills = [];
  const many = idx.length > 6;
  for (const li of idx) {
    const l = m.links[li];
    const cross = m.cat[l[A]] !== m.cat[l[B]];
    const x1 = tx + k * m.x[l[A]], y1 = ty + k * m.y[l[A]], x2 = tx + k * m.x[l[B]], y2 = ty + k * m.y[l[B]];
    if ((many && !cross && !isMixedRow(l)) || Math.hypot(x2 - x1, y2 - y1) <= 72) continue;
    const words = linkWord(l, i);
    const t = l[A] === i ? 0.62 : 0.38;
    const [px, py] = threadPoint(t, x1, y1, x2, y2, curvesOf(S) ? tx + k * curvesOf(S).qx[li] : null, curvesOf(S) ? ty + k * curvesOf(S).qy[li] : null);
    const pw = textWidth(ctx, PILL_FONT, words) + 14;
    const b = { x: px - pw / 2, y: py - 9.5, w: pw, h: 19 };
    if (!inView(b) || boxes.some(o => overlaps(b, o, 3))) continue;
    boxes.push(b);
    pills.push({ words, x: px, y: py, w: pw, box: b });
  }
  const names = [];
  for (const j of nb) {
    if (j === i) continue;
    const d = discs.find(q => q.i === j);
    const bt = base.get(j);
    if (bt) {
      // Where the map already shows it, while that spot is still clear (its own reserved box aside).
      const mineBox = reserved.get(j);
      const clear = inView(bt.box) && !boxes.some(o => o !== mineBox && overlaps(bt.box, o, 3)) && !discs.some(q => q.i !== j && gapTo(bt.box, q) < 1);
      if (clear) { names.push({ j, text: bt.text, font: bt.font, nameH: bt.nameH, box: bt.box, plate: hits(bt.box), kept: true }); continue; }
      boxes.splice(boxes.indexOf(mineBox), 1);
      erase.push({ i: j, box: bt.box });
    }
    const text = labelText(m.name[j], m.short[j]);
    const tw = textWidth(ctx, NB_FONT, text);
    let pick = null;
    for (let s = 0; s < SPOTS.length; s++) {
      const b = spotBox(s, d.x, d.y, d.r, tw, 14);
      if (SPOTS[s][3] > 16 || !inView(b) || gapTo(b, d) < 2 || boxes.some(o => overlaps(b, o, 3))) continue;
      const lines = hits(b) ? 1 : 0;
      const unclear = discs.some(q => q.i !== j && gapTo(b, q) < Math.max(gapTo(b, d) + 3, 4));
      const cost = SPOTS[s][3] + 150 * lines + 400 * (unclear ? 1 : 0) + 3 * discArea(b, j);
      if (!pick || cost < pick.cost) pick = { b, cost, lines };
      if (cost === SPOTS[s][3]) break;
    }
    if (!pick) continue;   // no room: the card and the panel still name it
    boxes.push(pick.b);
    names.push({ j, text, box: pick.b, plate: pick.lines > 0 });
  }
  S.hoverLay = { key, placed: S.placed, i, name: { text: nameText, box: nameBox }, pills, names, R, erase };
  return S.hoverLay;
}

/** Draws the over layer. Returns true while it is still animating. */
export function drawOver(ctx, S, { w, h, dpr, now }) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const m = S.dm || S.model, pal = S.pal, tk = S.tokens;
  if (!m || !m.n || !S.cam || !S.frame || !S.view) return false;
  const night = pal.theme !== 'light';
  const hv = S.hover.frame(now);
  S.hoverVeil = hv.veil;
  const v = S.frame, { k, tx, ty, dotScale } = v;
  const view = S.view;
  const grownOf = (i, g) => {
    const r = Math.max(m.r[i], 1.5 / k) * dotScale;
    const G = Math.max(1.45, (r * k + 5) / (r * k), 7 / (r * k));
    return dotScale * (1 + (G - 1) * g);
  };
  if (hv.veil > 0.002) {
    ctx.fillStyle = withAlpha(tk['--map-veil'], hv.veil);
    ctx.fillRect(0, 0, w, h);
  }
  if (hv.node >= 0 && m.placed[hv.node]) {
    const i = hv.node;
    const L = hoverLayout(ctx, S, i, v);
    const a = Math.max(hv.veil, hv.grow * 0.6);
    // The dim copies of the names this layer draws elsewhere are painted out, so each name shows once (DES4-05).
    if (L.erase.length && hv.veil > 0.01) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = withAlpha(tk['--map-ground'], 0.92 * Math.min(1, hv.veil));
      for (const e of L.erase) ctx.fillRect(e.box.x - 2, e.box.y - 2, e.box.w + 4, e.box.h + 4);
    }
    const idx = S.hoverLinks(i);
    if (idx.length && a > 0.02) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cut = new Path2D();
      cut.rect(-10, -10, w + 20, h + 20);
      for (const t of L.names) if (!t.plate) cut.rect(t.box.x - 2, t.box.y - 2, t.box.w + 4, t.box.h + 4);
      cut.rect(L.name.box.x - 2, L.name.box.y - 2, L.name.box.w + 4, L.name.box.h + 4);
      ctx.clip(cut, 'evenodd');
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
      const ft = { link: withAlpha(S.linkTokens.link, a), hi: withAlpha(S.linkTokens.hi, a), ground: withAlpha(S.linkTokens.ground, a) };
      drawLinks(ctx, { links: m.links, indices: idx, x: m.x, y: m.y, layer: 'hover', tokens: ft, k, radius: j => drawnRadius(m, j, k, dotScale) + 3 / k,
        qx: curvesOf(S) && curvesOf(S).qx, qy: curvesOf(S) && curvesOf(S).qy });
      ctx.restore();
    }
    // Pills sit on their threads, drawn after every thread so none crosses a pill.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of L.pills) {
      ctx.globalAlpha = a;
      ctx.fillStyle = tk['--map-card-bg'];
      roundRect(ctx, p.box.x, p.box.y, p.box.w, p.box.h, 9.5); ctx.fill();
      ctx.strokeStyle = night ? 'rgba(255,255,255,0.1)' : 'rgba(20,40,70,0.14)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = PILL_FONT; ctx.fillStyle = night ? 'rgb(220,229,239)' : tk['--map-label'];
      ctx.fillText(p.words, snap(p.x, dpr), snap(p.y + 0.5, dpr));
    }
    ctx.globalAlpha = 1;
    // The neighbours above the veil, then their names.
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    if (hv.veil > 0.01) {
      ctx.globalAlpha = hv.veil;
      for (const j of S.hoverNeighbours(i)) if (j !== i && m.placed[j]) drawOne(ctx, m, j, view, pal, dotScale);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'left';
    for (const t of L.names) {
      ctx.globalAlpha = hv.veil;
      if (t.plate) { ctx.fillStyle = tk['--map-card-bg']; roundRect(ctx, t.box.x - 5, t.box.y - 2, t.box.w + 10, t.box.h + 4, 7); ctx.fill(); }
      spriteText(ctx, t.text, snap(t.box.x, dpr), snap(t.box.y + (t.nameH || t.box.h) / 2, dpr), night ? 'rgb(220,229,239)' : tk['--map-label'], tk['--map-label-halo'], night, dpr, t.font || NB_FONT);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }
  // Shrinking topics the pointer just left, then the grown one with its ring and name.
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
  for (const l of hv.leaving) if (m.placed[l.node]) drawOne(ctx, m, l.node, view, pal, grownOf(l.node, l.grow));
  if (hv.node >= 0 && m.placed[hv.node]) {
    const i = hv.node, g = grownOf(i, hv.grow);
    const R = drawOne(ctx, m, i, view, pal, g);
    focusRing(ctx, m.x[i], m.y[i], R, k, tk, { gap: 2.5, width: 2, alpha: Math.min(1, hv.grow * 1.3) });
    // The selected topic held in focus (its panel open): the fine second ring outside, as before.
    if (i === S.selected) focusRing(ctx, m.x[i], m.y[i], R, k, tk, { gap: 9, width: 1, alpha: 0.7 * Math.min(1, hv.grow * 1.3), glow: false });
    const L = S.hoverLay && S.hoverLay.i === i ? S.hoverLay : null;
    if (L) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = Math.min(1, hv.grow * 1.4);
      ctx.font = NAME_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      spriteText(ctx, L.name.text, snap(L.name.box.x + L.name.box.w / 2, dpr), snap(L.name.box.y + 8, dpr), night ? '#f5f8fb' : tk['--map-label'], tk['--map-label-halo'], night, dpr, NAME_FONT, 'center');
      ctx.globalAlpha = 1;
    }
  }
  // The selected topic while another topic has the focus (a hover on another star): the highlight ring, and a fine
  // second ring outside it (it stays while the panel is open). In focus itself it is drawn above, grown.
  if (S.selected >= 0 && m.placed[S.selected] && hv.node !== S.selected) {
    const i = S.selected;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    const r = drawOne(ctx, m, i, view, pal, dotScale);
    focusRing(ctx, m.x[i], m.y[i], r, k, tk, { gap: 3.5, width: 2.5 });
    focusRing(ctx, m.x[i], m.y[i], r, k, tk, { gap: 9, width: 1, alpha: 0.7, glow: false });
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'left';
  return hv.animating;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
