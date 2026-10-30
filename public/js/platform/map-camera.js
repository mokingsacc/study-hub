import { fitTransform, ensureTarget, MIN_RATIO, MAX_RATIO, FLY_MS, ENSURE_MS, FIT_MS } from '../map/camera.js';
import { reducedMotion, easeInOutCubic } from '../map/tween.js';

const DRAG_PX = 4;          // movement before a press becomes a pan (a tap stays a tap)
const FLING_MIN = 0.25;     // px per ms that starts a glide
const FLING_DECAY = 0.0045; // per ms

export function createCamera(canvas, { onChange = () => {}, onGesture = () => {} } = {}) {
  let w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  let kFit = 1, kMin = MIN_RATIO, kMax = MAX_RATIO, ext = null;
  let gesture = false, anim = 0, glide = 0, wheelTimer = 0;
  const pts = new Map();
  let base = null;   // the gesture's start: {t, mid, dist} (re-based whenever a finger comes or goes)
  let vel = null;    // {vx, vy, at} from the last moves

  const cam = {
    transform: { k: 1, x: 0, y: 0 },
    get kFit() { return kFit; },
    get size() { return { w, h }; },
    get gesturing() { return gesture; },
    ratio: () => cam.transform.k / kFit,
    toScreen: (wx, wy) => [cam.transform.x + cam.transform.k * wx, cam.transform.y + cam.transform.k * wy],
    toWorld: (sx, sy) => [(sx - cam.transform.x) / cam.transform.k, (sy - cam.transform.y) / cam.transform.k],
  };

  // Keeps the view on the map: at most one map's width or height of sky beyond its edges (as d3's translateExtent).
  function clamp(t) {
    const k = Math.max(kMin, Math.min(kMax, t.k));
    let { x, y } = t;
    if (ext) {
      const fix = (pos, size, a, b) => {
        const v0 = -pos / k, v1 = (size - pos) / k;
        if (v1 - v0 >= b - a) return size / 2 - k * (a + b) / 2;
        if (v0 < a) return -a * k;
        if (v1 > b) return size - b * k;
        return pos;
      };
      x = fix(x, w, ext.x0, ext.x1);
      y = fix(y, h, ext.y0, ext.y1);
    }
    return { k, x, y };
  }
  function apply(t, byUser) {
    cam.transform = clamp(t);
    onChange(cam.transform, byUser);
  }
  function stop() {
    if (anim) cancelAnimationFrame(anim);
    if (glide) cancelAnimationFrame(glide);
    anim = glide = 0;
  }
  // Glides to t over ms: zoom in log space, the screen's centre moving in world space, so a fly never swings.
  function animate(t, ms) {
    stop();
    const to = clamp(t);
    if (reducedMotion() || !(ms > 0)) { apply(to, false); return; }
    const from = cam.transform;
    const c0 = [(w / 2 - from.x) / from.k, (h / 2 - from.y) / from.k], c1 = [(w / 2 - to.x) / to.k, (h / 2 - to.y) / to.k];
    const l0 = Math.log(from.k), l1 = Math.log(to.k);
    const start = performance.now();
    const step = now => {
      const p = Math.min(1, (now - start) / ms), e = easeInOutCubic(p);
      const k = Math.exp(l0 + (l1 - l0) * e), cx = c0[0] + (c1[0] - c0[0]) * e, cy = c0[1] + (c1[1] - c0[1]) * e;
      cam.transform = { k, x: w / 2 - k * cx, y: h / 2 - k * cy };
      onChange(cam.transform, false);
      anim = p < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  }
  const setGesture = on => { if (gesture !== on) { gesture = on; onGesture(on); } };

  // ---- pointers
  const rel = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function rebase() {
    const list = [...pts.values()];
    if (!list.length) { base = null; return; }
    const mid = list.length > 1 ? [(list[0][0] + list[1][0]) / 2, (list[0][1] + list[1][1]) / 2] : list[0];
    const dist = list.length > 1 ? Math.hypot(list[0][0] - list[1][0], list[0][1] - list[1][1]) : 0;
    base = { t: { ...cam.transform }, mid, dist, moved: base ? base.moved : false, start: base ? base.start : mid };
  }
  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stop();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    pts.set(e.pointerId, rel(e));
    vel = null;
    rebase();
    if (pts.size > 1) { base.moved = true; setGesture(true); }
  }
  function move(e) {
    if (!pts.has(e.pointerId) || !base) return;
    const prev = pts.get(e.pointerId), p = rel(e);
    pts.set(e.pointerId, p);
    const list = [...pts.values()];
    if (list.length === 1) {
      if (!base.moved && Math.hypot(p[0] - base.start[0], p[1] - base.start[1]) < DRAG_PX) return;
      if (!base.moved) { base.moved = true; rebase(); base.mid = base.start; setGesture(true); }
      const now = performance.now();
      if (vel && now > vel.at) { const dt = now - vel.at; vel = { vx: 0.6 * (p[0] - prev[0]) / dt + 0.4 * vel.vx, vy: 0.6 * (p[1] - prev[1]) / dt + 0.4 * vel.vy, at: now }; }
      else vel = { vx: 0, vy: 0, at: now };
      apply({ k: base.t.k, x: base.t.x + p[0] - base.mid[0], y: base.t.y + p[1] - base.mid[1] }, true);
      return;
    }
    const a = list[0], b = list[1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const k = Math.max(kMin, Math.min(kMax, base.t.k * (base.dist > 0 ? dist / base.dist : 1)));
    const wx = (base.mid[0] - base.t.x) / base.t.k, wy = (base.mid[1] - base.t.y) / base.t.k;
    vel = null;
    apply({ k, x: mid[0] - k * wx, y: mid[1] - k * wy }, true);
  }
  function up(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const moved = base && base.moved;
    rebase();
    if (pts.size) return;
    base = null;
    const v = vel;
    vel = null;
    if (moved && v && performance.now() - v.at < 60 && Math.hypot(v.vx, v.vy) > FLING_MIN && !reducedMotion()) { fling(v); return; }
    setGesture(false);
  }
  function fling(v) {
    let { vx, vy } = v, last = performance.now();
    const step = now => {
      const dt = Math.min(32, now - last);
      last = now;
      const f = Math.exp(-FLING_DECAY * dt);
      vx *= f; vy *= f;
      const t = cam.transform;
      apply({ k: t.k, x: t.x + vx * dt, y: t.y + vy * dt }, true);
      if (Math.hypot(vx, vy) < 0.02) { glide = 0; setGesture(false); return; }
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }
  // The wheel: zoom about the pointer; a trackpad pinch (ctrlKey) faster per pixel than a mouse wheel's notch.
  function wheel(e) {
    e.preventDefault();
    stop();
    const [ax, ay] = rel(e);
    const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? h : 1);
    const t = cam.transform, k = Math.max(kMin, Math.min(kMax, t.k * 2 ** (-px * (e.ctrlKey ? 0.011 : 0.0024))));
    const wx = (ax - t.x) / t.k, wy = (ay - t.y) / t.k;
    setGesture(true);
    apply({ k, x: ax - k * wx, y: ay - k * wy }, true);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => setGesture(false), 140);
  }
  const noPageZoom = e => e.preventDefault();   // Safari's own pinch-to-zoom of the page
  const opts = { passive: false };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, opts);
  canvas.addEventListener('gesturestart', noPageZoom, opts);

  Object.assign(cam, {
    // The whole map's bounds set the zoom range (half the fit out, twelve times in) and how far it may pan.
    setBounds(b) {
      const ft = fitTransform(b, w, h, w < 640 ? 24 : 48);
      kFit = ft.k; kMin = kFit * MIN_RATIO; kMax = kFit * MAX_RATIO;
      ext = b ? { x0: b.x0 - (b.x1 - b.x0), y0: b.y0 - (b.y1 - b.y0), x1: b.x1 + (b.x1 - b.x0), y1: b.y1 + (b.y1 - b.y0) } : null;
      return ft;
    },
    fit(b, { ms = FIT_MS, pad = null, maxRatio = MAX_RATIO } = {}) {
      const t = fitTransform(b, w, h, pad ?? (w < 640 ? 24 : 48));
      const k = Math.min(t.k, kFit * maxRatio);
      if (k < t.k && b) { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; animate({ k, x: w / 2 - k * cx, y: h / 2 - k * cy }, ms); return; }
      animate(t, ms);
    },
    flyTo(wx, wy, k = null, ms = FLY_MS) {
      const kk = Math.max(kMin, Math.min(kMax, k || cam.transform.k));
      animate({ k: kk, x: w / 2 - kk * wx, y: h / 2 - kk * wy }, ms);
    },
    ensureVisible(wx, wy, occluded = null) {
      const t = ensureTarget(cam.transform, wx, wy, w, h, occluded);
      if (t) animate(t, ENSURE_MS);
    },
    zoomBy(f, ms = 250) {
      const t = cam.transform, k = Math.max(kMin, Math.min(kMax, t.k * f));
      const [wx, wy] = cam.toWorld(w / 2, h / 2);
      animate({ k, x: w / 2 - k * wx, y: h / 2 - k * wy }, ms);
    },
    resize(nw, nh) {
      const [wx, wy] = cam.toWorld(w / 2, h / 2);
      w = Math.max(1, nw); h = Math.max(1, nh);
      apply({ k: cam.transform.k, x: w / 2 - cam.transform.k * wx, y: h / 2 - cam.transform.k * wy }, false);
    },
    set(t) { stop(); apply(t, false); },
    interrupt() { stop(); },
    destroy() {
      stop();
      clearTimeout(wheelTimer);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel, opts);
      canvas.removeEventListener('gesturestart', noPageZoom, opts);
      pts.clear();
    },
  });
  return cam;
}
