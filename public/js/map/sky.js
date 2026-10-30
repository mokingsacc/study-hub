// The night sky behind the map (concept 8a): a faint band of the Milky Way and two layers of background stars that
// drift apart a little with the pointer and the camera, so the map has depth. They are drawn once per size, at the
// device's pixel ratio, and moved only with CSS transforms (no redraw). Deterministic: the same sky every load.

const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const MARGIN = 40;

function glint(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.22, `rgba(${rgb},0.5)`); gr.addColorStop(0.55, `rgba(${rgb},0.12)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return c;
}

/** The starfield in host (behind the map's canvases): {draw(w, h, dpr), drift(px, py, cam), show(on), destroy()}. */
export function createSky(host) {
  const wrap = document.createElement('div');
  wrap.className = 'map-sky';
  wrap.setAttribute('aria-hidden', 'true');
  const far = document.createElement('canvas'), near = document.createElement('canvas');
  far.className = 'map-stars is-far'; near.className = 'map-stars is-near';
  wrap.append(far, near);
  host.prepend(wrap);
  let size = '';
  let pointer = [0, 0], cam = [0, 0];
  const apply = () => {
    far.style.transform = `translate3d(${(-pointer[0] * 7 + cam[0] * 0.012).toFixed(2)}px, ${(-pointer[1] * 5 + cam[1] * 0.012).toFixed(2)}px, 0)`;
    near.style.transform = `translate3d(${(-pointer[0] * 18 + cam[0] * 0.03).toFixed(2)}px, ${(-pointer[1] * 13 + cam[1] * 0.03).toFixed(2)}px, 0)`;
  };
  function draw(w, h, dpr) {
    const key = `${w}x${h}@${dpr}`;
    if (key === size) return;
    size = key;
    const W = w + 2 * MARGIN, H = h + 2 * MARGIN, area = (W * H) / (1500 * 960);
    const spark = glint('226,236,255');
    [[far, 360, 0.22, 0.75, 0.05, 0.36, 7], [near, 95, 0.45, 1.15, 0.1, 0.55, 11]].forEach(([cv, count, r0, r1, a0, a1, seed], layer) => {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
      const ctx = cv.getContext('2d'), rnd = rng(seed);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (layer === 0) {
        ctx.save();
        ctx.translate(W * 0.5, H * 0.52); ctx.rotate(-0.42); ctx.scale(1, 0.16);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.62);
        g.addColorStop(0, 'rgba(150,175,225,0.05)'); g.addColorStop(0.5, 'rgba(150,175,225,0.022)'); g.addColorStop(1, 'rgba(150,175,225,0)');
        ctx.fillStyle = g; ctx.fillRect(-W, -W, 2 * W, 2 * W);
        ctx.restore();
        for (let i = 0; i < 420 * area; i++) {
          const t = rnd(), off = (rnd() + rnd() + rnd() - 1.5) * H * 0.09;
          const x = t * W + Math.sin(0.42) * off, y = H * 0.52 + (t - 0.5) * W * -Math.tan(0.42) * 0.98 + Math.cos(0.42) * off;
          ctx.fillStyle = `rgba(205,220,255,${(0.04 + rnd() * 0.16).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(x, y, 0.2 + rnd() * 0.45, 0, 7); ctx.fill();
        }
      }
      for (let i = 0; i < count * area; i++) {
        const x = rnd() * W, y = rnd() * H, r = r0 + rnd() ** 2 * (r1 - r0), a = a0 + rnd() ** 1.6 * (a1 - a0);
        ctx.fillStyle = rnd() < 0.18 ? `rgba(255,234,212,${a.toFixed(3)})` : `rgba(212,226,255,${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      if (layer === 1) for (let i = 0; i < 7 * area; i++) {
        const x = rnd() * W, y = rnd() * H, len = 5 + rnd() * 6;
        ctx.drawImage(spark, x - 7, y - 7, 14, 14);
        ctx.strokeStyle = 'rgba(226,236,255,0.22)'; ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.moveTo(x, y - len); ctx.lineTo(x, y + len); ctx.stroke();
      }
    });
    apply();
  }
  return {
    el: wrap,
    draw,
    // px, py: the pointer's place as -0.5..0.5 of the screen; the camera's pan in screen px (null to keep).
    drift(px, py, camXY = null) {
      if (px != null) pointer = [px, py];
      if (camXY) cam = [Math.max(-2000, Math.min(2000, camXY[0])), Math.max(-2000, Math.min(2000, camXY[1]))];
      apply();
    },
    show(on) { wrap.hidden = !on; },
    destroy() { for (const c of [far, near]) { c.width = 0; c.height = 0; } wrap.remove(); },
  };
}
