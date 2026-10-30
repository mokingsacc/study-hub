
export const CAPS = { desktop: 60, ipad: 45, phone: 25 };
export const DENSITY = { key: 0, fewer: 0.6, normal: 1, more: 1.5 };
// 34, not 28 (DES3-16): AMBOSS names run long, and the word that tells look-alikes apart ("Heart failure with
// preserved…", "Spontaneous bacterial peritonitis") sat just past 28.
export const MAX_CHARS = 34;

/** Label cap for a screen width and the label_density pref. */
export function capFor(width, density = 'key') {
  const base = width < 640 ? CAPS.phone : width < 1100 ? CAPS.ipad : CAPS.desktop;
  return Math.round(base * (DENSITY[density] ?? 1));
}

/** A topic's label text: its short name when it has one, else its name cut at MAX_CHARS characters, at a word, with an ellipsis. */
export function labelText(name, short = null) {
  const s = String(short || name || '').trim();
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 16 ? cut.slice(0, sp) : cut).replace(/[\s,;:·–-]+$/, '') + '…';
}

/** priority = yield × (seen ? 0.5 + t : 0.3): big, weak topics are named first. */
export function priority(yield100, t1000) {
  const y = Math.max(0.05, (Number(yield100) || 0) / 100);
  return t1000 < 0 || t1000 == null ? y * 0.3 : y * (0.5 + t1000 / 1000);
}


export const KO = 3;                 // threads stay this far clear of a name (px)
export const NAME_GAP = 3;           // px between two names
export const FADE_MS = 160;          // a new name fades in

// Spots round a star of radius r for a w × h name: sixteen directions at three distances, each box touching the
// circle of that distance at its nearest point. [cos, sin, pad, penalty], cheapest first: right of the star,
// then left, above, below and the diagonals, then further out.
export const SPOTS = (() => {
  const out = [];
  [[4, 0], [9, 5], [16, 12]].forEach(([pad, pen]) => {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8, c = Math.cos(a), s = Math.sin(a);
      const ap = k === 0 ? 0 : k === 8 ? 1 : 2 + 1.5 * Math.abs(s) * (s > 0 ? 1.3 : 1) + (c < 0 ? 0.5 : 0);
      out.push([Math.abs(c) < 1e-9 ? 0 : c, Math.abs(s) < 1e-9 ? 0 : s, pad, pen + ap]);
    }
  });
  return out.sort((p, q) => p[3] - q[3]);
})();

/** The box for spot s round a star at (x, y) with screen radius r. */
export function spotBox(s, x, y, r, w, h) {
  const [c, sn, pad] = SPOTS[s];
  const R = r + pad, px = x + R * c, py = y + R * sn;
  return { x: px - (w * (1 - c)) / 2, y: py - (h * (1 - sn)) / 2, w, h };
}

export const REVEAL = Object.freeze({ atFit: 0.45, power: 1.8 });
export function revealCap(ratio, base) {
  const r = Math.max(0.25, ratio || 1);
  return Math.round(base * REVEAL.atFit * (r >= 1 ? r ** REVEAL.power : r * r));
}

export const overlaps = (b, o, gap = 0) => b.x < o.x + o.w + gap && b.x + b.w + gap > o.x && b.y < o.y + o.h + gap && b.y + b.h + gap > o.y;
export const overlapArea = (b, o) => Math.max(0, Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x)) * Math.max(0, Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y));
/** Box edge to a disc's edge (negative when the disc reaches into the box). */
export const gapTo = (b, d) => Math.hypot(Math.max(b.x - d.x, 0, d.x - b.x - b.w), Math.max(b.y - d.y, 0, d.y - b.y - b.h)) - d.r;

// Placed boxes on a coarse grid, so "does this box hit a placed name" is a few lookups.
function boxGrid(cell = 64) {
  const cells = new Map(), all = [];
  const keys = b => { const out = []; for (let gx = Math.floor(b.x / cell); gx <= Math.floor((b.x + b.w) / cell); gx++) for (let gy = Math.floor(b.y / cell); gy <= Math.floor((b.y + b.h) / cell); gy++) out.push(gx * 100003 + gy); return out; };
  return {
    all,
    add(b) { all.push(b); for (const k of keys(b)) { const l = cells.get(k); if (l) l.push(b); else cells.set(k, [b]); } },
    hits(b, gap) { for (const k of keys({ x: b.x - gap, y: b.y - gap, w: b.w + 2 * gap, h: b.h + 2 * gap })) { const l = cells.get(k); if (l) for (const o of l) if (overlaps(b, o, gap)) return true; } return false; },
  };
}

/**
 * Places the topic names for one frame, round the system names already fixed at their galaxies' centres. Everything
 * is in screen px.
 *   cats:  [{c, box, t?}] the system names showing this frame (render.js titleBoxes): fixed, never moved; no topic
 *          name ever sits over one
 *   cands: [{i, x, y, r, w, h, must, prev}] in the order they should claim space (must first, then by priority)
 *   near(box): the visible stars round a box, [{i, x, y, r, cat}], and points on bright threads ({i: -1}) to keep clear of
 *   blocked: [{x, y, w, h}] the map's own buttons and panels
 *   cap: how many ordinary names may show; deadline, clock: stop trying ordinary names once clock() passes it
 * Returns {cats: [{c, box, t}], topics: [{i, box, spot, must}], dropped: [i of must names with no room]}.
 */
export function placeMapLabels({ cats = [], cands = [], near = () => [], blocked = [], w, h, cap = 60, deadline = Infinity, clock = () => 0 }) {
  const grid = boxGrid();
  const inView = b => b.x >= 6 && b.x + b.w <= w - 6 && b.y >= 4 && b.y + b.h <= h - 4 && !blocked.some(o => overlaps(b, o, 4));
  const outCats = cats.filter(t => t && t.box).map(t => ({ c: t.c, box: t.box, t: t.t }));
  for (const t of outCats) grid.add(t.box);
  const topics = [], dropped = [];
  let free = 0, tried = 0;
  // Ordinary names are tried in priority order until the cap is met, or four times the cap have been tried (a
  // crowded stretch of sky gives up rather than spend the frame).
  const budget = cap * 4 + 20;
  for (const cd of cands) {
    if (!cd.must && (free >= cap || tried >= budget)) continue;
    // A frame's time is shared: past the deadline only the names that must show are still placed.
    if (!cd.must && (tried & 7) === 0 && clock() > deadline) { tried = budget; continue; }
    if (!cd.must) tried++;
    const own = { x: cd.x, y: cd.y, r: cd.r };
    const discs = near({ x: cd.x - cd.w - 30, y: cd.y - cd.h - 30, w: 2 * cd.w + 60, h: 2 * cd.h + 60 }).filter(d => d.i !== cd.i);
    const search = (bw, bh, prevOk) => {
      let best = null;
      const tryAt = s => {
        const pen = SPOTS[s][3];
        if (!cd.must && pen > 12) return null;   // ordinary names only take a spot close in
        const b = spotBox(s, cd.x, cd.y, cd.r, bw, bh);
        if (!inView(b) || grid.hits(b, NAME_GAP)) return null;
        const mine = gapTo(b, own);
        if (mine < 1.5) return null;
        let stars = 0, unclear = false;
        for (const d of discs) {
          const g = gapTo(b, d);
          if (g < 0) { stars += overlapArea(b, { x: d.x - d.r, y: d.y - d.r, w: 2 * d.r, h: 2 * d.r }) + 1; if (!cd.must) return null; }
          if (d.i >= 0 && g < Math.max(mine + 3, 4)) { unclear = true; if (!cd.must) return null; }   // points on a thread (i -1) are never read as a star
        }
        return { b, s, stars, cost: pen + 3 * stars + 400 * (unclear ? 1 : 0) };
      };
      // Its spot from the last frame first, while it is still clear: names do not jump about as the map moves.
      if (prevOk && cd.prev != null && cd.prev >= 0 && cd.prev < SPOTS.length) {
        const p = tryAt(cd.prev);
        if (p && p.cost < 400 && (cd.must || p.cost === SPOTS[cd.prev][3])) best = p;
      }
      if (!best) {
        for (let s = 0; s < SPOTS.length; s++) {
          const p = tryAt(s);
          if (!p) continue;
          if (!best || p.cost < best.cost) best = p;
          if (p.cost === SPOTS[s][3]) break;   // a clean spot: nothing cheaper is left (spots are cheapest first)
        }
      }
      return best;
    };
    let best = search(cd.w, cd.h, !cd.altPrev);
    // A name with an extra line (the topic being taught: render.js passes alt: {w, h}, the name alone) drops that
    // line when the line is what puts it over stars: the shorter box is taken when it costs less (fewer stars, or a
    // closer clean spot). The line shows with it again once there is room.
    if (cd.alt && (!best || best.stars > 0)) {
      const b2 = search(cd.alt.w, cd.alt.h, !!cd.altPrev);
      if (b2 && (!best || b2.cost < best.cost)) { best = b2; best.alt = true; }
    }
    if (!best) { if (cd.must) dropped.push(cd.i); continue; }
    best.b.i = cd.i;
    grid.add(best.b);
    topics.push({ i: cd.i, box: best.b, spot: best.s, must: !!cd.must, ...(best.alt ? { alt: true } : {}) });
    if (!cd.must) free++;
  }
  return { cats: outCats, topics, dropped };
}

/**
 * The audit (concept 8a's, for the real map): no two names overlap, and no thread runs through a name. boxes:
 * [{s, x, y, w, h}] as drawn; threadsAt(box) -> how many threads pass through it (after the cut beneath names).
 */
export function auditBoxes(boxes, threadsAt = () => 0) {
  const overlapsOut = [], lineThroughText = [];
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) if (overlapArea(boxes[a], boxes[b]) > 0.5) overlapsOut.push(`${boxes[a].s} / ${boxes[b].s}`);
    if (threadsAt(boxes[a]) > 0) lineThroughText.push(boxes[a].s);
  }
  return { names: boxes.length, overlaps: overlapsOut, lineThroughText };
}
