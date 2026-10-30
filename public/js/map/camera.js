import { reducedMotion } from './tween.js';

export const MIN_RATIO = 0.5, MAX_RATIO = 12;
export const FLY_MS = 650, ENSURE_MS = 300, FIT_MS = 600;
const STORE = 'ph-map-cam';

/** The transform {k, x, y} that fits world bounds into w × h with pad px each side. */
export function fitTransform(b, w, h, pad = 40) {
  if (!b || !(w > 0) || !(h > 0)) return { k: 1, x: w / 2 || 0, y: h / 2 || 0 };
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  const k = Math.max(1e-4, Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh));
  return { k, x: w / 2 - k * (b.x0 + bw / 2), y: h / 2 - k * (b.y0 + bh / 2) };
}

/**
 * The smallest pan that brings world point (wx, wy) into the visible part of the canvas: inside w × h, outside
 * `occluded` (the sheet's rect in canvas px), with a margin. Returns null when it is already in view.
 */
export function ensureTarget(t, wx, wy, w, h, occluded = null, margin = 48) {
  let vx0 = margin, vy0 = margin, vx1 = w - margin, vy1 = h - margin;
  if (occluded) {
    // A side sheet covers the right; a bottom sheet the bottom.
    if (occluded.left > w * 0.4 && occluded.top <= margin) vx1 = Math.min(vx1, occluded.left - margin);
    else if (occluded.top > 0) vy1 = Math.min(vy1, occluded.top - margin);
  }
  if (vx1 <= vx0) vx1 = vx0 + 1;
  if (vy1 <= vy0) vy1 = vy0 + 1;
  const sx = t.x + t.k * wx, sy = t.y + t.k * wy;
  let dx = 0, dy = 0;
  if (sx < vx0) dx = vx0 - sx; else if (sx > vx1) dx = vx1 - sx;
  if (sy < vy0) dy = vy0 - sy; else if (sy > vy1) dy = vy1 - sy;
  if (!dx && !dy) return null;
  return { k: t.k, x: t.x + dx, y: t.y + dy };
}

export function createCamera(canvas, d3, { onChange = () => {}, onGesture = () => {} } = {}) {
  const sel = d3.select(canvas);
  let w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  let kFit = 1;
  let gesture = false;
  let wheeling = false;
  const zoom = d3.zoom()
    .scaleExtent([MIN_RATIO, MAX_RATIO])
    // Primary button drags and touch only; the wheel is handled below (smoothly); a ctrl-click is left alone.
    .filter(e => e.type !== 'wheel' && !e.ctrlKey && !e.button)
    .on('start', e => { if (e.sourceEvent) { gesture = true; onGesture(true); } })
    .on('zoom', e => { cam.transform = { k: e.transform.k, x: e.transform.x, y: e.transform.y }; onChange(cam.transform, !!e.sourceEvent || wheeling); })
    .on('end', () => { if (gesture) { gesture = false; onGesture(false); } if (!wheeling) cam.save(); });
  sel.call(zoom).on('dblclick.zoom', null);

  // The wheel: zoom about the pointer. A mouse wheel's notch (or a page or line step) glides to its target over a
  // few frames; a trackpad's small steps and a pinch (ctrlKey) apply at once, since they already arrive smoothly.
  let glide = null, glideRaf = 0, wheelEndTimer = 0;
  const clampK = k => { const [a, b] = zoom.scaleExtent(); return Math.max(a, Math.min(b, k)); };
  const scaleAbout = (k, ax, ay) => {
    const t = cam.transform, wx = (ax - t.x) / t.k, wy = (ay - t.y) / t.k;
    sel.call(zoom.transform, d3.zoomIdentity.translate(ax - k * wx, ay - k * wy).scale(k));
  };
  const endWheel = () => {
    clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => { if (!glide) { wheeling = false; if (gesture) { gesture = false; onGesture(false); } cam.save(); } }, 140);
  };
  const step = () => {
    glideRaf = 0;
    if (!glide) return;
    const k = cam.transform.k, f = glide.k / k;
    if (Math.abs(Math.log(f)) < 0.002) { scaleAbout(glide.k, glide.x, glide.y); glide = null; endWheel(); return; }
    scaleAbout(k * f ** (reducedMotion() ? 1 : 0.3), glide.x, glide.y);
    glideRaf = requestAnimationFrame(step);
  };
  const onWheel = e => {
    e.preventDefault();
    sel.interrupt();
    const r = canvas.getBoundingClientRect(), ax = e.clientX - r.left, ay = e.clientY - r.top;
    const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? h : 1);
    const pinch = e.ctrlKey;
    const f = 2 ** (-px * (pinch ? 0.011 : 0.0024));
    if (!wheeling) { wheeling = true; if (!gesture) { gesture = true; onGesture(true); } }
    const notch = !pinch && (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50);
    if (notch) {
      glide = { k: clampK((glide ? glide.k : cam.transform.k) * f), x: ax, y: ay };
      if (!glideRaf) glideRaf = requestAnimationFrame(step);
    } else {
      if (glide) { glide = null; cancelAnimationFrame(glideRaf); glideRaf = 0; }
      scaleAbout(clampK(cam.transform.k * f), ax, ay);
      endWheel();
    }
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const ident = t => d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
  const apply = (t, ms) => {
    const go = reducedMotion() || !(ms > 0) ? sel : sel.transition().duration(ms).ease(d3.easeCubicInOut);
    go.call(zoom.transform, ident(t));
  };

  const cam = {
    transform: { k: 1, x: 0, y: 0 },
    get kFit() { return kFit; },
    get size() { return { w, h }; },
    get gesturing() { return gesture || wheeling; },
    ratio: () => cam.transform.k / kFit,
    toScreen: (wx, wy) => [cam.transform.x + cam.transform.k * wx, cam.transform.y + cam.transform.k * wy],
    toWorld: (sx, sy) => [(sx - cam.transform.x) / cam.transform.k, (sy - cam.transform.y) / cam.transform.k],
    // The whole map's bounds set the zoom range: half the fit out, twelve times in.
    setBounds(b, { keep = true } = {}) {
      const ft = fitTransform(b, w, h, w < 640 ? 24 : 48);
      kFit = ft.k;
      zoom.scaleExtent([kFit * MIN_RATIO, kFit * MAX_RATIO]).translateExtent(b ? [[b.x0 - (b.x1 - b.x0), b.y0 - (b.y1 - b.y0)], [b.x1 + (b.x1 - b.x0), b.y1 + (b.y1 - b.y0)]] : [[-Infinity, -Infinity], [Infinity, Infinity]]);
      if (!keep) apply(ft, 0);
      return ft;
    },
    // maxRatio caps how far a fit may zoom in (a unit of four close topics should not fill the screen).
    fit(b, { ms = FIT_MS, pad = null, maxRatio = MAX_RATIO } = {}) {
      const t = fitTransform(b, w, h, pad ?? (w < 640 ? 24 : 48));
      const k = Math.min(t.k, kFit * maxRatio);
      if (k < t.k && b) { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; apply({ k, x: w / 2 - k * cx, y: h / 2 - k * cy }, ms); return; }
      apply(t, ms);
    },
    flyTo(wx, wy, k = null, ms = FLY_MS) {
      const kk = Math.max(kFit * MIN_RATIO, Math.min(kFit * MAX_RATIO, k || cam.transform.k));
      apply({ k: kk, x: w / 2 - kk * wx, y: h / 2 - kk * wy }, ms);
    },
    ensureVisible(wx, wy, occluded = null) {
      const t = ensureTarget(cam.transform, wx, wy, w, h, occluded);
      if (t) apply(t, ENSURE_MS);
    },
    zoomBy(f, ms = 250) {
      const k = Math.max(kFit * MIN_RATIO, Math.min(kFit * MAX_RATIO, cam.transform.k * f));
      const cx = w / 2, cy = h / 2;
      const [wx, wy] = cam.toWorld(cx, cy);
      apply({ k, x: cx - k * wx, y: cy - k * wy }, ms);
    },
    resize(nw, nh) {
      // A glide still running was aimed at the old size (its tween fights the new one: a panel's edge dragged during
      // one sent the map off into the distance), so it stops here; the caller aims again once the size settles.
      sel.interrupt();
      // Keep the world point at the centre where it was.
      const [wx, wy] = cam.toWorld(w / 2, h / 2);
      w = Math.max(1, nw); h = Math.max(1, nh);
      apply({ k: cam.transform.k, x: w / 2 - cam.transform.k * wx, y: h / 2 - cam.transform.k * wy }, 0);
    },
    set(t) { apply(t, 0); },
    // The view is kept for the session, for one layout of the map (a new layout starts from the whole map).
    layoutVersion: 0,
    save() { try { sessionStorage.setItem(STORE, JSON.stringify({ ...cam.transform, w, h, v: cam.layoutVersion })); } catch (e) { /* private window */ } },
    restore() {
      try {
        const t = JSON.parse(sessionStorage.getItem(STORE) || 'null');
        if (!t || !Number.isFinite(t.k) || !Number.isFinite(t.x) || !Number.isFinite(t.y) || (t.v ?? 0) !== cam.layoutVersion) return false;
        // Re-centre for a different canvas size (a rotated iPad).
        const cx = (t.w || w) / 2, cy = (t.h || h) / 2;
        const wx = (cx - t.x) / t.k, wy = (cy - t.y) / t.k;
        apply({ k: t.k, x: w / 2 - t.k * wx, y: h / 2 - t.k * wy }, 0);
        return true;
      } catch (e) { return false; }
    },
    interrupt() { sel.interrupt(); glide = null; },
    destroy() {
      sel.interrupt(); sel.on('.zoom', null);
      canvas.removeEventListener('wheel', onWheel);
      if (glideRaf) cancelAnimationFrame(glideRaf);
      clearTimeout(wheelEndTimer);
      glide = null;
    },
  };
  return cam;
}
