// The pencil's ink, pure (ink.js draws with it; tests use it without a browser).
export const ERASE_R = 0.012;

/** Draws one stroke on a canvas `W` pixels wide (points are fractions of the width). */
export function drawStroke(g, s, W) {
  const p = s.p;
  g.strokeStyle = s.c; g.fillStyle = s.c;
  g.lineWidth = Math.max(1, s.w * W); g.lineCap = 'round'; g.lineJoin = 'round';
  if (p.length <= 2 || (p.length === 4 && p[0] === p[2] && p[1] === p[3])) {
    g.beginPath(); g.arc(p[0] * W, p[1] * W, g.lineWidth / 2, 0, Math.PI * 2); g.fill(); return;
  }
  g.beginPath(); g.moveTo(p[0] * W, p[1] * W);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    g.quadraticCurveTo(p[i] * W, p[i + 1] * W, mx * W, my * W);
  }
  g.lineTo(p[p.length - 2] * W, p[p.length - 1] * W);
  g.stroke();
}

/** Strokes with a point within r of (x, y): their indexes (pure). */
export function strokesNear(strokes, x, y, r = ERASE_R) {
  const out = [];
  strokes.forEach((s, i) => { for (let k = 0; k < s.p.length; k += 2) if (Math.hypot(s.p[k] - x, s.p[k + 1] - y) <= r) { out.push(i); return; } });
  return out;
}

