// Notes (I30): a page drawn as a PNG in the Worker, so Claude can see handwriting and drawings (notes_see). A small
// pure-JS rasteriser: ink outlines (geom.js, the same shapes the page draws) filled with nonzero winding and 4
// sub-scanlines of anti-aliasing, block boxes outlined with their number in the corner (a 3x5 digit font), on white.
// Text is not drawn: notes_read gives it. Encoded with CompressionStream('deflate') (zlib), as PNG wants.
import { decodePoints, outline } from '../../../public/js/notes/geom.js';

export const MAX_PX = 1600;
const SUB = 4;

export function canvas(w, h) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  return { w, h, px };
}

const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export const rgbOf = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? hex(c) : [20, 20, 24]);

function blend(cv, i, [r, g, b], a) {
  if (a <= 0) return;
  const o = i * 4, k = Math.min(1, a);
  cv.px[o] += (r - cv.px[o]) * k; cv.px[o + 1] += (g - cv.px[o + 1]) * k; cv.px[o + 2] += (b - cv.px[o + 2]) * k;
}

/** Fill a polygon [[x, y]] (pixels) with a colour at an opacity, nonzero winding, anti-aliased. */
export function fillPoly(cv, poly, rgb, opacity = 1) {
  if (poly.length < 3) return;
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of poly) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const top = Math.max(0, Math.floor(y0)), bot = Math.min(cv.h - 1, Math.ceil(y1));
  const cov = new Float32Array(cv.w + 1);
  for (let py = top; py <= bot; py++) {
    cov.fill(0);
    let lo = cv.w, hi = -1;
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB;
      const xs = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xa, ya] = poly[j], [xb, yb] = poly[i];
        if ((ya <= y && yb > y) || (yb <= y && ya > y)) xs.push([xa + ((y - ya) * (xb - xa)) / (yb - ya), yb > ya ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        wind += xs[k][1];
        if (!wind) continue;
        const a = Math.max(0, xs[k][0]), b = Math.min(cv.w, xs[k + 1][0]);
        if (b <= a) continue;
        const ia = Math.floor(a), ib = Math.floor(b);
        lo = Math.min(lo, ia); hi = Math.max(hi, ib);
        if (ia === ib) { cov[ia] += (b - a) / SUB; continue; }
        cov[ia] += (ia + 1 - a) / SUB;
        for (let x = ia + 1; x < ib; x++) cov[x] += 1 / SUB;
        if (ib < cv.w) cov[ib] += (b - ib) / SUB;
      }
    }
    for (let x = Math.max(0, lo); x <= Math.min(cv.w - 1, hi); x++) if (cov[x] > 0) blend(cv, py * cv.w + x, rgb, Math.min(1, cov[x]) * opacity);
  }
}

export function rect(cv, x, y, w, h, rgb, a = 1) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y)), x1 = Math.min(cv.w, Math.round(x + w)), y1 = Math.min(cv.h, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(cv, yy * cv.w + xx, rgb, a);
}
export function box(cv, x, y, w, h, rgb, t = 2) {
  rect(cv, x, y, w, t, rgb); rect(cv, x, y + h - t, w, t, rgb); rect(cv, x, y, t, h, rgb); rect(cv, x + w - t, y, t, h, rgb);
}

// 3x5 digits, one row of three bits per line, top to bottom.
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111',
  '111001010010010', '111101111101111', '111101111001111'];
/** A number in a filled label at (x, y): white digits on the colour. */
export function label(cv, n, x, y, rgb, scale = 3) {
  const s = String(n), w = s.length * 4 * scale + scale, h = 7 * scale;
  rect(cv, x, y, w, h, rgb);
  [...s].forEach((d, i) => {
    const bits = DIGITS[Number(d)];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (bits[r * 3 + c] === '1') rect(cv, x + scale + i * 4 * scale + c * scale, y + scale + r * scale, scale, scale, [255, 255, 255]);
  });
}

// ---------------------------------------------------------------- PNG
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/** The canvas as PNG bytes (RGB, no filter). */
export async function encodePng(cv) {
  const raw = new Uint8Array((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) {
    const o = y * (cv.w * 3 + 1);
    for (let x = 0; x < cv.w; x++) { const i = (y * cv.w + x) * 4, j = o + 1 + x * 3; raw[j] = cv.px[i]; raw[j + 1] = cv.px[i + 1]; raw[j + 2] = cv.px[i + 2]; }
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, cv.w); dv.setUint32(4, cv.h); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const BLOCK_RGB = { text: [110, 118, 135], table: [26, 115, 232], image: [24, 128, 56] };
/**
 * Draws a region of a page: {x, y, w, h} in world units, blocks [{n, x, y, w, h, type}] (h worked out by the caller),
 * strokes as stored. Returns {png: Uint8Array, scale, width, height}.
 */
export async function renderPage({ x, y, w, h }, blocks, strokes) {
  const scale = Math.min(2, MAX_PX / Math.max(w, h, 1));
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const cv = canvas(W, H);
  const tx = v => (v - x) * scale, ty = v => (v - y) * scale;
  for (const b of blocks) {
    const c = BLOCK_RGB[b.type] || BLOCK_RGB.text;
    rect(cv, tx(b.x), ty(b.y), b.w * scale, b.h * scale, c, 0.06);
    box(cv, tx(b.x), ty(b.y), b.w * scale, b.h * scale, c, Math.max(1, Math.round(scale * 1.5)));
    label(cv, b.n, tx(b.x), ty(b.y), c, Math.max(2, Math.round(3 * Math.min(1.5, scale))));
  }
  for (const s of [...strokes].sort((a, b) => (a.tool === 'highlighter' ? -1 : 0) - (b.tool === 'highlighter' ? -1 : 0))) {
    if (s.x1 < x || s.x0 > x + w || s.y1 < y || s.y0 > y + h) continue;
    const poly = outline(decodePoints(s.points), s.width, s.tool).map(([px, py]) => [tx(px), ty(py)]);
    fillPoly(cv, poly, s.colour === 'ink' ? [20, 20, 24] : rgbOf(s.colour), s.tool === 'highlighter' ? 0.38 : 1);
  }
  return { png: await encodePng(cv), scale, width: W, height: H };
}
