import { easeOutCubic, easeInOut, reducedMotion } from './tween.js';

export const T = Object.freeze({ intent: 40, grow: 140, dimAfter: 250, dim: 180, cardAfter: 300, grace: 80, shrink: 200, veilOut: 200 });

export function createHover({ intentMs = T.intent } = {}) {
  let node = -1, mode = null, since = 0, growFrom = 0, veilFrom = null, cardAt = Infinity, peek = false;
  let held = -1;                     // the selected node (its panel is open): the focus rests on it, with no card
  let leftAt = null;                 // when the pointer left the node (grace runs from here)
  let leaving = [];                  // [{node, at, from}] shrinking nodes
  let veilOutAt = null, veilOutFrom = 0;
  const intent = () => (reducedMotion() ? 0 : intentMs);

  const growAt = t => {
    if (node < 0) return 0;
    const p = reducedMotion() ? 1 : Math.max(0, Math.min(1, (t - growFrom) / T.grow));
    return t < growFrom ? 0 : easeOutCubic(p);
  };
  const veilAt = t => {
    if (node >= 0 && veilFrom != null) return t < veilFrom ? 0 : reducedMotion() ? 1 : easeOutCubic(Math.min(1, (t - veilFrom) / T.dim));
    if (veilOutAt != null) {
      const p = reducedMotion() ? 1 : Math.min(1, (t - veilOutAt) / T.veilOut);
      return veilOutFrom * (1 - easeInOut(p));
    }
    return 0;
  };

  function release(t) {
    if (node < 0) return;
    leaving = leaving.filter(l => l.node !== node);
    leaving.push({ node, at: t, from: growAt(t) });
    node = -1; mode = null; peek = false; leftAt = null; cardAt = Infinity;
  }
  function fadeVeil(t) {
    const v = veilAt(t);
    veilFrom = null;
    if (v > 0) { veilOutAt = t; veilOutFrom = v; }
  }

  // The focus back on the selected node: straight from another focus the veil stays up and the node grows at once.
  function enterHeld(t) {
    const wasVeil = veilAt(t);
    if (node >= 0 && node !== held) release(t);
    leaving = leaving.filter(l => l.node !== held);
    const grown = node === held ? growAt(t) : 0;
    node = held; mode = 'held'; since = t; leftAt = null; veilOutAt = null; peek = false; cardAt = Infinity;
    growFrom = grown > 0 ? Math.min(growFrom, t) : t;
    veilFrom = wasVeil > 0 ? t - T.dim * (1 - Math.cbrt(1 - Math.min(1, wasVeil))) : t;   // the veil carries on from where it is
  }
  // Leaving a hover: back to the selected node when there is one, else everything fades.
  function letGo(t) {
    if (held >= 0) { if (node !== held || mode !== 'held') enterHeld(t); return; }
    fadeVeil(t); release(t);
  }

  function enter(i, t, how) {
    const cross = node >= 0 && node !== i;   // straight from another node: no shrink and regrow of the veil
    const wasVeil = veilAt(t);
    if (cross) release(t);
    leaving = leaving.filter(l => l.node !== i);
    node = i; mode = how; since = t; leftAt = null; veilOutAt = null;
    if (how === 'touch') {
      peek = true;
      growFrom = t;
      veilFrom = wasVeil > 0 ? t - T.dim : t;
      cardAt = t;
    } else {
      peek = false;
      growFrom = cross ? t : t + intent();
      veilFrom = cross && wasVeil > 0 ? t - T.dim : since + T.dimAfter;
      cardAt = cross && wasVeil > 0 ? t : since + T.cardAfter;
    }
  }

  return {
    get node() { return node; },
    get peeking() { return peek; },
    get mode() { return mode; },
    get held() { return held; },

    /** The mouse or pen is over node i (-1: over nothing) at time t. */
    move(i, t, pointerType = 'mouse') {
      if (pointerType === 'touch') return;
      if (peek) return;                      // a touch peek stays until another tap
      if (i === node) { leftAt = null; return; }
      if (i < 0) { if (node >= 0 && mode !== 'held' && leftAt == null) leftAt = t; return; }
      if (i === held) { enterHeld(t); return; }
      enter(i, t, pointerType === 'pen' ? 'pen' : 'mouse');
    },

    /** A tap on node i (-1: empty map). Returns 'peek', 'open', 'selected' (the selected node itself) or 'clear'. */
    tap(i, t) {
      if (i < 0) { if (node >= 0 && mode !== 'held') letGo(t); return 'clear'; }
      if (i === held) { if (node !== held || mode !== 'held') enterHeld(t); return 'selected'; }
      if (i === node && peek) return 'open';
      enter(i, t, 'touch');
      return 'peek';
    },

    /** Peek a node from code (search, keyboard). */
    peekNode(i, t) { if (i < 0) return; if (i === held) { enterHeld(t); return; } enter(i, t, 'touch'); },

    /** Everything off (Esc, a route change); with a selected node the focus goes back to it. */
    clear(t) { if (node >= 0 && mode !== 'held') letGo(t); },

    /** Node i is selected (its panel opened): the focus rests on it, without a card, until deselect(). */
    select(i, t) {
      if (!(i >= 0)) { this.deselect(t); return; }
      if (held === i && node === i && mode === 'held') return;
      held = i;
      // A hover or peek on another node keeps going; it comes back here when it ends.
      if (node < 0 || node === i || mode === 'held') enterHeld(t);
    },

    /** No node selected any more (the panel closed): the held focus fades like a hover that ends. */
    deselect(t) {
      if (held < 0) return;
      held = -1;
      if (node >= 0 && mode === 'held') { fadeVeil(t); release(t); }
    },

    /**
     * The state at time t: {node, grow 0..1, veil 0..1, card, peek, leaving: [{node, grow}], animating}. Calling it
     * also lets the grace period run out (the leave happens here, not on a timer).
     */
    frame(t) {
      if (node >= 0 && leftAt != null && t - leftAt >= T.grace) letGo(t);
      const g = growAt(t);
      const v = veilAt(t);
      const shrinking = [];
      leaving = leaving.filter(l => {
        const p = reducedMotion() ? 1 : Math.min(1, (t - l.at) / T.shrink);
        if (p >= 1) return false;
        shrinking.push({ node: l.node, grow: l.from * (1 - easeInOut(p)) });
        return true;
      });
      if (veilOutAt != null && v <= 0) veilOutAt = null;
      const card = node >= 0 && t >= cardAt;
      const animating = (node >= 0 && (g < 1 || (veilFrom != null && v < 1) || (cardAt !== Infinity && t < cardAt) || leftAt != null)) || shrinking.length > 0 || veilOutAt != null;
      return { node, grow: g, veil: v, card, peek, mode, leaving: shrinking, animating };
    },
  };
}

/** Pointer gestures on the canvas: a tap is a press and release within 10 px and 350 ms. */
export const TAP = Object.freeze({ px: 10, ms: 350 });
export const isTap = (down, up) => !!down && Math.hypot(up.x - down.x, up.y - down.y) <= TAP.px && up.t - down.t <= TAP.ms;
