
export const SETTLE_MS = 120;
export const SLOW_MS = 8, FAST_MS = 5;          // EMA of a paint: slow above 8 ms, fast again under 5 (hysteresis)
export const LOD_MS = Object.freeze([16, 24]);   // EMA over these: level 1 (no dust in motion), level 2 (no glows, fewer names)
export const ZOOM_LO = 0.8, ZOOM_HI = 1.3;        // how far the picture may scale before it is painted again

/** The margin (css px) painted round the screen for a picture: a quarter of the short side, 64 to 320 px. */
export function marginFor(w, h) {
  return Math.round(Math.max(64, Math.min(320, 0.25 * Math.min(w, h))));
}

/**
 * Where a picture lands for camera t: {f, x, y, w, h} in css px (f: its scale). snap: {k, x, y, m, w, h}, the camera,
 * margin and screen it was painted for. A world point at screen s0 then is at f·s0 + (t.x − f·snap.x) now.
 */
export function placement(snap, t) {
  const f = t.k / snap.k;
  return { f, x: t.x - f * (snap.x + snap.m), y: t.y - f * (snap.y + snap.m), w: f * (snap.w + 2 * snap.m), h: f * (snap.h + 2 * snap.m) };
}

/** Whether a placed picture covers the whole w × h screen (no empty edge). */
export function covers(p, w, h) {
  return p.x <= 0.01 && p.y <= 0.01 && p.x + p.w >= w - 0.01 && p.y + p.h >= h - 0.01;
}

/** Whether the picture can stand in for a paint at camera t on a w × h screen at dpr. */
export function usable(snap, t, w, h, dpr) {
  if (!snap || snap.w !== w || snap.h !== h || snap.dpr !== dpr) return false;
  const p = placement(snap, t);
  return p.f >= ZOOM_LO && p.f <= ZOOM_HI && covers(p, w, h);
}

/** A box painted into the picture (in the picture's own css px, margin included), where it shows now (p: placement). */
export const moveBox = (b, p) => ({ ...b, x: p.x + p.f * b.x, y: p.y + p.f * b.y, w: p.f * b.w, h: p.f * b.h });

/**
 * What a picture shows besides the camera: the things whose change must paint the map again even mid-move. Kept as
 * a list compared by identity (sameSig), cheap per frame.
 */
export function sigOf(S, w, h, dpr) {
  const spot = S.spot || null;
  return [S.model, S.pal, S.tokens, S.linkTokens, S.haze, S.skyParts, S.dim, spot, spot && spot.veil, S.selected, S.searchActive, S.linkSel, S.spotLinks,
    S.picks, S.picks ? S.picks.size : 0, S.forcedLabels ? S.forcedLabels.size : 0, S.hover ? S.hover.node : -1, (S.hoverVeil || 0) > 0.01, S.labelCap,
    (S.blocked || []).length, S.glows, S.halos, S.titles && S.titles.length, w, h, dpr];
}
export function sameSig(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How slow the paints have been: an EMA of their ms, with slow/fast hysteresis and the motion quality level. */
export function createPace({ alpha = 0.25 } = {}) {
  let ema = 0, slow = false, n = 0;
  return {
    note(ms) {
      if (!(ms >= 0)) return;
      ema = n ? ema + alpha * (ms - ema) : ms;
      n++;
      if (!slow && ema > SLOW_MS) slow = true;
      else if (slow && ema < FAST_MS) slow = false;
    },
    get ema() { return ema; },
    get slow() { return slow; },
    // 0: whole; 1: no dust while moving; 2: no glows either, and half the minor names
    get level() { return !slow ? 0 : ema > LOD_MS[1] ? 2 : ema > LOD_MS[0] ? 1 : 0; },
    reset() { ema = 0; slow = false; n = 0; },
  };
}

/** What a paint while moving leaves out at a quality level: overrides for the scene (render.js paints through them). */
export function lodOverrides(level, S) {
  const o = {};
  if (level >= 1) o.skyParts = null;
  if (level >= 2) { o.glows = false; o.labelCap = Math.floor((S.labelCap ?? 60) / 2); }
  return o;
}
