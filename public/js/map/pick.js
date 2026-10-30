// Picking (plan §9: geometric, never by pixel colour, which would push the canvas off the GPU). A uniform grid
// over the topics' world positions answers "which topic is under the pointer" in well under 0.1 ms. Rebuilt only
// when positions change. Pure: tested in node.

/**
 * A pick index over model.x / model.y / model.r. nearest(wx, wy, slop, ok?, grow?, minR?) is the topic whose disc
 * edge is nearest the point, within slop world units of the edge (so a big disc wins its own area), or -1.
 */
export function createPicker(model, cell = 32) {
  const cells = new Map();
  const key = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);
  let maxR = 0;
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    maxR = Math.max(maxR, model.r[i]);
    const k = key(Math.floor(model.x[i] / cell), Math.floor(model.y[i] / cell));
    const list = cells.get(k);
    if (list) list.push(i); else cells.set(k, [i]);
  }
  return {
    // minR: the smallest radius a disc counts as having (a finger's 44 px target on a tiny node).
    nearest(wx, wy, slop = 0, ok = null, grow = null, minR = 0) {
      const reach = Math.max(maxR * 2, minR) + slop;
      const c0x = Math.floor((wx - reach) / cell), c1x = Math.floor((wx + reach) / cell);
      const c0y = Math.floor((wy - reach) / cell), c1y = Math.floor((wy + reach) / cell);
      let best = -1, bestD = Infinity;
      for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
        const list = cells.get(key(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (ok && !ok(i)) continue;
          const r = Math.max(model.r[i] * (grow ? grow(i) : 1), minR);
          const d = Math.hypot(model.x[i] - wx, model.y[i] - wy) - r;
          if (d <= slop && d < bestD) { best = i; bestD = d; }
        }
      }
      return best;
    },
    // Every topic whose centre lies in a world rectangle (for culling and the unit route's fit).
    within(x0, y0, x1, y1) {
      const out = [];
      const inside = i => model.x[i] >= x0 && model.x[i] <= x1 && model.y[i] >= y0 && model.y[i] <= y1;
      const cx0 = Math.floor(x0 / cell), cx1 = Math.floor(x1 / cell), cy0 = Math.floor(y0 / cell), cy1 = Math.floor(y1 / cell);
      // A rectangle wider than the filled cells (zoomed far out, or a runaway layout) walks the filled cells instead.
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > cells.size) {
        for (const list of cells.values()) for (const i of list) if (inside(i)) out.push(i);
        return out;
      }
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const list = cells.get(key(cx, cy));
        if (!list) continue;
        for (const i of list) if (inside(i)) out.push(i);
      }
      return out;
    },
  };
}
