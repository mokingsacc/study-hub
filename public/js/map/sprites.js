// Names as pictures (job 9, 29 Oct): a map name is its text stroked twice (the soft halo) and filled, which is the
// slowest thing the canvas does with text. Each name is drawn once into a small picture per font, text, colours and
// pixel ratio, and every later frame copies that picture to the name's place (one drawImage). The picture's anchor
// sits on a whole device pixel, so a name drawn at a snapped place looks exactly as one drawn there directly.
// Measured widths are kept too (render.js textWidth).

export const SPRITE_MAX = 500;
export const HALO_PAD = 4;   // css px round the text: the night halo's 6 px stroke reaches 3 px out

/** The font's size in px, from a canvas font string ("600 13.5px …"). */
export const fontPx = font => { const m = /(\d+(?:\.\d+)?)px/.exec(font); return m ? Number(m[1]) : 12; };

/**
 * A sprite's size and anchor in device px for text tw css px wide in a font of px css px, at dpr, aligned 'left' or
 * 'center' on its x and 'middle' on its y: {W, H, ax, ay}, all whole numbers, so the anchor lands on a pixel.
 */
export function spriteBox(tw, px, dpr, align = 'left') {
  const pad = Math.ceil(HALO_PAD * dpr);
  const half = Math.ceil((px * 0.85 + HALO_PAD) * dpr);
  const twD = Math.ceil(tw * dpr);
  const ax = align === 'center' ? pad + Math.ceil(twD / 2) : pad;
  const W = align === 'center' ? 2 * ax : twD + 2 * pad;
  return { W, H: 2 * half, ax, ay: half };
}

// A plain canvas, not an OffscreenCanvas: copying one into the map's canvas is a straight blit, where an
// OffscreenCanvas (or its ImageBitmap) cost a transfer per name in Chrome's profile (job 9).
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * A cache of name pictures. draw(ctx, {text, font, x, y, fill, halo, night, dpr, align, measure}) draws one at
 * (x, y) css px under ctx's setTransform(dpr, …) (its globalAlpha carries through) and returns false when it could
 * not (no canvas here: the caller draws the text itself). paint(c, text, x, y) is the text as drawn directly.
 */
export function createSprites({ max = SPRITE_MAX, make = makeCanvas, paint } = {}) {
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    get size() { return cache.size; },
    get stats() { return { hits, misses, size: cache.size }; },
    clear() { cache.clear(); },
    draw(ctx, { text, font, x, y, fill, halo, night, dpr, align = 'left', measure }) {
      const key = `${dpr}|${align}|${night ? 1 : 0}|${font}|${fill}|${halo}|${text}`;
      let s = cache.get(key);
      if (s) { hits++; cache.delete(key); cache.set(key, s); }
      else {
        misses++;
        const b = spriteBox(measure(font, text), fontPx(font), dpr, align);
        const canvas = make(b.W, b.H);
        if (!canvas) return false;
        const c = canvas.getContext('2d');
        if (!c) return false;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.font = font;
        c.textAlign = align;
        c.textBaseline = 'middle';
        paint(c, text, b.ax / dpr, b.ay / dpr, fill, halo, night);
        s = { canvas, ...b };
        cache.set(key, s);
        while (cache.size > max) cache.delete(cache.keys().next().value);
      }
      ctx.drawImage(s.canvas, x - s.ax / dpr, y - s.ay / dpr, s.W / dpr, s.H / dpr);
      return true;
    },
  };
}
