// Notes ink geometry (I30), shared by the page (canvas.js) and the Worker's picture of a page (worker/src/notes/png.js).
// Pure: no DOM. A stroke is a list of [x, y, p] in world units (1 unit = 1 CSS px at zoom 1) with pen pressure 0..1,
// stored as "x,y,p x,y,p ..." (one decimal, two for pressure). It is drawn as a filled outline whose width follows
// the pressure (pen) or stays even (highlighter), so it is sharp at every zoom.

export const PEN_COLOURS = ['ink', '#d93025', '#1a73e8', '#188038', '#e37400', '#8e24aa'];   // 'ink' follows the theme
export const HL_COLOURS = ['#ffd600', '#5ce65c', '#ff80c8'];
export const TOOLS = ['pen', 'highlighter'];
export const WIDTH = { pen: 2.5, highlighter: 16 };
export const MAX_POINTS = 4000;

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

export function encodePoints(pts) {
  return pts.map(([x, y, p]) => `${r1(x)},${r1(y)},${r2(p == null ? 0.5 : p)}`).join(' ');
}

export function decodePoints(s) {
  const out = [];
  for (const part of String(s || '').trim().split(/\s+/)) {
    if (!part) continue;
    const [x, y, p] = part.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y, Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5]);
  }
  return out;
}

// Ramer-Douglas-Peucker on x and y (pressure rides along), keeping the ends.
export function simplify(pts, eps = 0.5) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let far = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      // A big pressure change is kept too, so the width still swells where the pen pressed.
      const dp = Math.abs(pts[i][2] - (pts[a][2] + pts[b][2]) / 2) * 4;
      if (Math.max(d, dp) > far) { far = Math.max(d, dp); idx = i; }
    }
    if (far > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function bbox(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (!pts.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: r1(x0 - pad), y0: r1(y0 - pad), x1: r1(x1 + pad), y1: r1(y1 + pad) };
}

export const radiusAt = (tool, width, p) => (tool === 'highlighter' ? width / 2 : (width * (0.4 + 0.9 * p)) / 2);

// The stroke's outline as a closed polygon [[x, y], ...]: the left edge, a round cap, the right edge back, a round cap.
export function outline(pts, width, tool = 'pen') {
  const n = pts.length;
  if (!n) return [];
  const rad = i => radiusAt(tool, width, pts[i][2]);
  const arc = (cx, cy, r, from, steps = 8) => Array.from({ length: steps + 1 }, (_, k) => {
    const a = from + (Math.PI * k) / steps;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  if (n === 1) { const [x, y] = pts[0]; const r = Math.max(0.5, rad(0)); return [...arc(x, y, r, 0, 8), ...arc(x, y, r, Math.PI, 8)]; }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = Math.max(0.3, rad(i));
    left.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    right.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
  }
  const ang = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  const endA = ang(pts[n - 2], pts[n - 1]) + Math.PI / 2, startA = ang(pts[1], pts[0]) + Math.PI / 2;
  return [...left, ...arc(pts[n - 1][0], pts[n - 1][1], Math.max(0.3, rad(n - 1)), endA - Math.PI, 6).reverse(),
    ...right.reverse(), ...arc(pts[0][0], pts[0][1], Math.max(0.3, rad(0)), startA - Math.PI, 6).reverse()];
}

// An SVG path for the outline, smoothed through the edge midpoints.
export function outlinePath(poly) {
  if (!poly.length) return '';
  const f = v => Math.round(v * 10) / 10;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M${f(mid(poly[poly.length - 1], poly[0])[0])} ${f(mid(poly[poly.length - 1], poly[0])[1])}`;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], m = mid(p, poly[(i + 1) % poly.length]);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + 'Z';
}

// Is the point inside the polygon (even-odd)?
export function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Distance from a point to a stroke's centre line (the eraser's hit test).
export function distToStroke([x, y], pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return best;
}
