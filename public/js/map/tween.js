// Tiny tweens for the map (plan §9: every animation takes 0 ms under reduced motion). Values are worked out
// from the clock each frame, so nothing runs between frames and an idle map draws nothing at all.

export const easeOutCubic = p => 1 - (1 - p) ** 3;
export const easeInOutCubic = p => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
export const easeInOut = p => 0.5 - Math.cos(Math.PI * p) / 2;
export const linear = p => p;

let reduced = null;
/** Whether the page should not animate (the OS setting, read once and kept current). */
export function reducedMotion() {
  if (reduced === null) {
    reduced = false;
    try {
      const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (mq) { reduced = mq.matches; mq.addEventListener?.('change', e => { reduced = e.matches; }); }
    } catch (e) { reduced = false; }
  }
  return reduced;
}
export function _setReduced(v) { reduced = v; }

/** 0..1 progress of an animation that started at `start` and lasts `ms`, eased; 1 at once under reduced motion. */
export function progress(start, ms, now, ease = linear) {
  if (reducedMotion() || !(ms > 0)) return 1;
  const p = (now - start) / ms;
  return p <= 0 ? 0 : p >= 1 ? 1 : ease(p);
}

/**
 * Per-node tweens of one numeric value (t1000 for colour changes, a 0..1 grow for new topics). tweens.set(i,
 * from, to, ms) starts one; tweens.value(i, base) is the value now; tweens.step(now) drops finished ones and says
 * whether any are still running (the renderer keeps drawing while they are).
 */
export function createTweens(clock = () => performance.now()) {
  const live = new Map();
  let now = clock();
  return {
    set(i, from, to, ms, ease = easeInOutCubic) {
      if (from == null || to == null || from === to || reducedMotion() || !(ms > 0)) { live.delete(i); return; }
      live.set(i, { from, to, start: clock(), ms, ease });
    },
    value(i, base) {
      const t = live.get(i);
      if (!t) return base;
      const p = progress(t.start, t.ms, now, t.ease);
      return t.from + (t.to - t.from) * p;
    },
    has: i => live.has(i),
    step(at = clock()) {
      now = at;
      for (const [i, t] of live) if (now - t.start >= t.ms) live.delete(i);
      return live.size > 0;
    },
    clear() { live.clear(); },
    get size() { return live.size; },
  };
}
