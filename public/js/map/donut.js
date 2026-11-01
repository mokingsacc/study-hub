
import { isFoundationCategory } from '../shared/concept.js';

/** [id, name, member category ids]. The order is the default order round the ring (top, then clockwise). */
export const FAMILIES = Object.freeze([
  ['women-children', 'Women & children', ['obstetrics', 'gynaecology-and-breast', 'neonates-genetics-and-child-development']],
  ['mind-senses', 'Mind & senses', ['psychiatry', 'neurology', 'ophthalmology', 'ent']],
  ['infection-immunity', 'Infection & immunity', ['infectious-disease', 'immunology-and-allergy', 'dermatology', 'rheumatology-and-msk']],
  ['organs', 'Organs', ['cardiology', 'respiratory', 'haematology', 'renal-urinary-and-electrolytes', 'endocrine-and-diabetes', 'gi-and-hepatology',
    'male-reproductive-and-urology']],
  ['acute-care', 'Acute care', ['surgery-trauma-and-perioperative', 'emergency-toxicology-and-environment']],
  ['population', 'Population', ['prevention-and-geriatrics', 'biostatistics-and-epidemiology', 'ethics-and-communication']],
].map(([id, name, members]) => Object.freeze({ id, name, members: Object.freeze(members) })));
export const OTHER = Object.freeze({ id: 'other', name: 'Other', members: Object.freeze([]) });
let ACTIVE = FAMILIES;
let FAMILY_BY_CAT = new Map(FAMILIES.flatMap(f => f.members.map(c => [c, f])));

/** The family a category id belongs to (Other for one the table does not name, and for topics with none). */
export const familyOf = id => FAMILY_BY_CAT.get(id) || OTHER;

export function setFamilies(list) {
  ACTIVE = list ? Object.freeze(list.map(f => Object.freeze({ id: f.id, name: f.name, members: Object.freeze([...f.members]) }))) : FAMILIES;
  FAMILY_BY_CAT = new Map(ACTIVE.flatMap(f => f.members.map(c => [c, f])));
}

export const DONUT = Object.freeze({
  row: 0.87,          // ring to ring, in seat spacings (a hexagonal lattice's row height)
  hole: 1.8,          // the inner ring's radius at least, in seat spacings: it decides how many seats the inner
                      // ring gets (5 of 23), so a wide hole is not ringed by a few galaxies far apart
  holeBand: 1.1,      // the hole's radius, clear of every galaxy, in ring bands (a galaxy across, 2 R, plus gap):
  spacing: 1.3,       // the seat spacing along a ring aimed for, in seat spacings (it ends up a little wider)
  keep: 0.05,         // Tidy keeps the current seating unless a new one costs at least this much less (5%)
  exhaustive: 6,      // families of up to this many systems are tried in every order; bigger ones by swaps
  gap: 40,           // world units between two galaxies at their closest: room for both glows and a bead cluster
  familyGap: 60,      // more between two galaxies of different families (100 in all, 2.5 times the gap inside a
  familyTurn: 0.12,   // and at least this turn (radians) of empty ring between two families' wedges
});

const TAU = 2 * Math.PI;
const START = -Math.PI / 2;   // the first seat, and the first family, at the top
const wrap = a => ((a % TAU) + TAU) % TAU;

/**
 * K seats as [{x, y, row, angle}] in units of the seat spacing, round (0, 0), sorted by angle from the top going
 * clockwise (screen y points down), then by ring. 1 ring up to 6 systems, 2 up to 13, else 3. Each ring has seats
 * in proportion to its length; odd rings are turned half a seat so the rings are staggered.
 */
export function seatLattice(K, d = DONUT) {
  if (K <= 0) return [];
  if (K === 1) return [{ x: 0, y: 0, row: 0, angle: 0 }];
  const rows = K <= 6 ? 1 : K <= 13 ? 2 : 3;
  const tri = (d.row * rows * (rows - 1)) / 2;
  const h = rows === 1 ? Math.max(0.55, (d.spacing * K) / TAU) : Math.max(d.hole, ((d.spacing * K) / TAU - tri) / rows);
  const rho = Array.from({ length: rows }, (_, r) => h + d.row * r);
  const sum = rho.reduce((a, b) => a + b, 0);
  // seats per ring by the largest remainder, each ring at least 2
  const want = rho.map(p => (K * p) / sum);
  const n = want.map(w => Math.max(2, Math.floor(w)));
  let left = K - n.reduce((a, b) => a + b, 0);
  const order = want.map((w, r) => [w - Math.floor(w), r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (let q = 0; left > 0; q = (q + 1) % rows, left--) n[order[q][1]]++;
  for (let r = rows - 1; left < 0; r = (r + rows - 1) % rows) if (n[r] > 2) { n[r]--; left++; }
  const out = [];
  for (let r = 0; r < rows; r++) {
    const step = TAU / n[r], off = r % 2 ? step / 2 : 0;
    for (let j = 0; j < n[r]; j++) {
      const a = START + off + j * step;
      out.push({ x: rho[r] * Math.cos(a), y: rho[r] * Math.sin(a), row: r, angle: wrap(a - START) });
    }
  }
  out.sort((p, q) => p.angle - q.angle || p.row - q.row);
  return out;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Σ S[a][b] × distance(seat of a, seat of b) over every pair of systems. S: K×K, symmetric. */
export function seatingCost(seats, seatOf, S, K = seatOf.length) {
  let c = 0;
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { const w = S[a * K + b]; if (w > 0) c += w * dist(seats[seatOf[a]], seats[seatOf[b]]); }
  return c;
}

// Every order of 0..n-1, the first fixed (a rotation of the ring is the same seating), in a fixed order.
function* orders(n) {
  const rest = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1);
  function* perm(list) {
    if (list.length <= 1) { yield list; return; }
    for (let i = 0; i < list.length; i++) for (const p of perm([...list.slice(0, i), ...list.slice(i + 1)])) yield [list[i], ...p];
  }
  for (const p of perm(rest)) yield [0, ...p];
}

// The families present, each with its systems (k indices, by id): table order, Other last.
function familiesOf(ids) {
  const by = new Map();
  ids.forEach((id, k) => { const f = familyOf(id); if (!by.has(f.id)) by.set(f.id, { fam: f, members: [] }); by.get(f.id).members.push(k); });
  const rank = f => { const i = ACTIVE.findIndex(x => x.id === f.id); return i < 0 ? ACTIVE.length : i; };
  for (const v of by.values()) v.members.sort((a, b) => (String(ids[a]) < String(ids[b]) ? -1 : String(ids[a]) > String(ids[b]) ? 1 : a - b));
  return [...by.values()].sort((p, q) => rank(p.fam) - rank(q.fam));
}

// Seats [from, from + m) in angle order for each family in this order: [{fam, members, seats: [seat index]}].
function blocksFor(fams, order) {
  let at = 0;
  return order.map(f => { const b = { ...fams[f], seats: Array.from({ length: fams[f].members.length }, (_, j) => at + j) }; at += b.seats.length; return b; });
}

// Each family's systems on its own seats: every order tried for a family of up to `exhaustive`, pairwise swaps for a
// bigger one; round after round until nothing improves. Only the family's own pairs change as it moves, so each try
// is scored on them alone (seat distances worked out once). seatOf is changed in place; returns the whole cost.
function seatWithin(blocks, seats, seatOf, S, K, d) {
  const D = new Float64Array(K * K);
  for (let p = 0; p < K; p++) for (let q = p + 1; q < K; q++) D[p * K + q] = D[q * K + p] = dist(seats[p], seats[q]);
  // the cost of the pairs that touch the family m (each counted once)
  const own = (m, inM) => {
    let c = 0;
    for (const a of m) { const sa = seatOf[a] * K; for (let b = 0; b < K; b++) if (b !== a && (!inM[b] || b > a)) { const w = S[a * K + b]; if (w > 0) c += w * D[sa + seatOf[b]]; } }
    return c;
  };
  for (let round = 0; round < 12; round++) {
    let better = false;
    for (const blk of blocks) {
      const m = blk.members;
      if (m.length < 2) continue;
      const inM = new Uint8Array(K);
      for (const k of m) inM[k] = 1;
      const mine = m.map(k => seatOf[k]).sort((x, y) => x - y);
      let cur = own(m, inM);
      if (m.length <= d.exhaustive) {
        let best = cur, bestSeats = m.map(k => seatOf[k]);
        for (const p of orders(m.length + 1)) {
          // p[1..] is an order of 1..m: member q takes the seat mine[p[q + 1] - 1]
          for (let q = 0; q < m.length; q++) seatOf[m[q]] = mine[p[q + 1] - 1];
          const c = own(m, inM);
          if (c < best - 1e-9) { best = c; bestSeats = m.map(k => seatOf[k]); }
        }
        m.forEach((k, q) => { seatOf[k] = bestSeats[q]; });
        if (best < cur - 1e-9) better = true;
      } else {
        for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
          const a = m[i], c2 = m[j];
          [seatOf[a], seatOf[c2]] = [seatOf[c2], seatOf[a]];
          const c = own(m, inM);
          if (c < cur - 1e-9) { cur = c; better = true; } else [seatOf[a], seatOf[c2]] = [seatOf[c2], seatOf[a]];
        }
      }
    }
    if (!better) break;
  }
  return seatingCost(seats, seatOf, S, K);
}

// The families' order round the ring by Σ (their systems' weight) × (mean distance between their seats): every
// order when there are few families, else swaps from the table's order.
function familyOrder(fams, seats, S, K) {
  const F = fams.length;
  const W = new Float64Array(F * F);
  for (let f = 0; f < F; f++) for (let g = f + 1; g < F; g++) {
    let w = 0;
    for (const a of fams[f].members) for (const b of fams[g].members) w += S[a * K + b];
    W[f * F + g] = W[g * F + f] = w;
  }
  const costOf = order => {
    const blocks = blocksFor(fams, order);
    const at = new Map(blocks.map((b, p) => [order[p], b.seats]));
    let c = 0;
    for (let f = 0; f < F; f++) for (let g = f + 1; g < F; g++) {
      const w = W[f * F + g];
      if (!(w > 0)) continue;
      const A = at.get(f), B = at.get(g);
      let s = 0;
      for (const p of A) for (const q of B) s += dist(seats[p], seats[q]);
      c += (w * s) / (A.length * B.length);
    }
    return c;
  };
  let best = Array.from({ length: F }, (_, f) => f), bestCost = costOf(best);
  if (F <= 8) {
    for (const o of orders(F)) { const c = costOf(o); if (c < bestCost - 1e-9) { bestCost = c; best = o; } }
  } else {
    for (let better = true, round = 0; better && round < 20; round++) {
      better = false;
      for (let i = 1; i < F; i++) for (let j = i + 1; j < F; j++) {
        const o = [...best]; [o[i], o[j]] = [o[j], o[i]];
        const c = costOf(o);
        if (c < bestCost - 1e-9) { bestCost = c; best = o; better = true; }
      }
    }
  }
  return best;
}

/**
 * The current seating, read off where the systems are now (Map id -> [x, y]): each system's ring by its distance from
 * the rings' centre (fitted to the points), the families' order by angle, and on each ring each family's systems in
 * angle order on that family's seats of the ring. Null when a system has no centre, a family is not one block on
 * each ring, or no run of seats fits the rings as read (a new system, a first donut). Returns {seatOf, order}
 * (order: family indices round the ring).
 */
export function currentSeating(ids, fams, seats, current) {
  const K = ids.length;
  if (!current || !K || seats.length !== K || !fams.length) return null;
  const pts = ids.map(id => current.get(id));
  if (pts.some(p => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const rows = Math.max(...seats.map(s => s.row)) + 1;
  const perRow = Array.from({ length: rows }, (_, r) => seats.filter(s => s.row === r).length);
  // rows by distance from a centre: the points' mean first, then the least-squares centre of concentric rings
  let cx = pts.reduce((a, p) => a + p[0], 0) / K, cy = pts.reduce((a, p) => a + p[1], 0) / K;
  const rowOf = new Int32Array(K);
  const readRows = () => {
    const byD = Array.from({ length: K }, (_, k) => k).sort((a, b) => Math.hypot(pts[a][0] - cx, pts[a][1] - cy) - Math.hypot(pts[b][0] - cx, pts[b][1] - cy) || a - b);
    let q = 0;
    for (let r = 0; r < rows; r++) for (let j = 0; j < perRow[r]; j++) rowOf[byD[q++]] = r;
  };
  readRows();
  if (rows > 1) {
    // x² + y² = 2x·cx + 2y·cy + e_row: normal equations, solved by elimination
    const U = 2 + rows, A = Array.from({ length: U }, () => new Float64Array(U + 1));
    for (let k = 0; k < K; k++) {
      const [x, y] = pts[k], v = new Float64Array(U);
      v[0] = 2 * x; v[1] = 2 * y; v[2 + rowOf[k]] = 1;
      for (let i = 0; i < U; i++) { for (let j = 0; j < U; j++) A[i][j] += v[i] * v[j]; A[i][U] += v[i] * (x * x + y * y); }
    }
    let ok = true;
    for (let i = 0; i < U && ok; i++) {
      let piv = i;
      for (let j = i + 1; j < U; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      if (Math.abs(A[piv][i]) < 1e-9) { ok = false; break; }
      [A[i], A[piv]] = [A[piv], A[i]];
      for (let j = 0; j < U; j++) if (j !== i) { const f = A[j][i] / A[i][i]; for (let c = i; c <= U; c++) A[j][c] -= f * A[i][c]; }
    }
    if (ok) { cx = A[0][U] / A[0][0]; cy = A[1][U] / A[1][1]; readRows(); }
  }
  const ang = pts.map(p => wrap(Math.atan2(p[1] - cy, p[0] - cx) - START));
  const famOf = new Int32Array(K);
  fams.forEach((f, q) => f.members.forEach(k => { famOf[k] = q; }));
  // the families' order round the ring, by the circular mean of their systems' angles
  const mid = fams.map(f => wrap(Math.atan2(f.members.reduce((a, k) => a + Math.sin(ang[k]), 0), f.members.reduce((a, k) => a + Math.cos(ang[k]), 0))));
  const order = fams.map((_, q) => q).sort((p, q) => mid[p] - mid[q] || p - q);
  const rank = new Int32Array(fams.length);
  order.forEach((f, i) => { rank[f] = i; });
  // on each ring the families are blocks, in that order round the ring
  const onRow = Array.from({ length: rows }, (_, r) => Array.from({ length: K }, (_, k) => k).filter(k => rowOf[k] === r).sort((a, b) => ang[a] - ang[b] || a - b));
  for (const list of onRow) {
    const blocks = [];
    list.forEach((k, i) => { if (i === 0 || famOf[k] !== famOf[list[i - 1]]) blocks.push(famOf[k]); });
    if (blocks.length > 1 && blocks[0] === blocks[blocks.length - 1]) blocks.pop();
    if (new Set(blocks).size !== blocks.length) return null;
    const lo = blocks.indexOf(blocks.reduce((m, f) => (rank[f] < rank[m] ? f : m), blocks[0]));
    const turned = [...blocks.slice(lo), ...blocks.slice(0, lo)];
    for (let i = 1; i < turned.length; i++) if (rank[turned[i]] < rank[turned[i - 1]]) return null;
  }
  // each family's systems on each ring, in angle order round the family's own middle
  const rel = k => Math.atan2(Math.sin(ang[k] - mid[famOf[k]]), Math.cos(ang[k] - mid[famOf[k]]));
  const mine = fams.map((f, q) => Array.from({ length: rows }, (_, r) => f.members.filter(k => rowOf[k] === r).sort((a, b) => rel(a) - rel(b) || a - b)));
  // the runs of seats, starting at each seat in turn: those whose rings match; the one nearest the angles as read
  let best = null, bestScore = Infinity;
  for (let s0 = 0; s0 < K; s0++) {
    const seatOf = new Int32Array(K);
    let at = s0, fits = true;
    for (const f of order) {
      const m = fams[f].members.length, run = Array.from({ length: m }, (_, q) => (at + q) % K);
      at += m;
      for (let r = 0; r < rows && fits; r++) {
        const here = run.filter(s => seats[s].row === r).sort((a, b) => ((a - s0 + K) % K) - ((b - s0 + K) % K));
        if (here.length !== mine[f][r].length) fits = false;
        else mine[f][r].forEach((k, j) => { seatOf[k] = here[j]; });
      }
      if (!fits) break;
    }
    if (!fits) continue;
    const diff = Array.from({ length: K }, (_, k) => ang[k] - seats[seatOf[k]].angle);
    const turn = Math.atan2(diff.reduce((a, d) => a + Math.sin(d), 0), diff.reduce((a, d) => a + Math.cos(d), 0));
    const score = diff.reduce((a, d) => a + Math.atan2(Math.sin(d - turn), Math.cos(d - turn)) ** 2, 0);
    if (score < bestScore - 1e-9) { bestScore = score; best = seatOf; }
  }
  if (!best) return null;
  const startOf = f => Math.min(...fams[f].members.map(k => best[k]).filter(s => !fams[f].members.some(k => best[k] === (s + K - 1) % K)));
  return { seatOf: best, order: [...order].sort((p, q) => startOf(p) - startOf(q)) };
}

/**
 * Which system sits on which seat. ids: category id per system (k); S: K×K relatedness (0..1, symmetric);
 * current: Map(id -> [x, y]) of where the systems are now (Tidy), or null. Returns {seats, seatOf: Int32Array
 * (k -> seat), families: [{id, name, members: [k]}] in ring order, cost, kept: whether the current seating stayed}.
 * A fresh seating: the families' order first, then each family's systems on its seats. With a current seating it
 * is also polished within its families; whichever of the two costs less replaces it only when it costs at least
 * DONUT.keep less, so Tidy never reshuffles the map for a hair's gain.
 */
export function seatCategories(ids, S, { current = null, d = DONUT } = {}) {
  const K = ids.length;
  const seats = seatLattice(K, d);
  const fams = familiesOf(ids);
  const make = order => {
    const blocks = blocksFor(fams, order);
    const seatOf = new Int32Array(K);
    for (const b of blocks) b.members.forEach((k, j) => { seatOf[k] = b.seats[j]; });
    return { blocks, seatOf };
  };
  const out = (order, seatOf, cost, kept) => ({ seats, seatOf, cost, kept,
    families: order.map(f => ({ id: fams[f].fam.id, name: fams[f].fam.name, members: [...fams[f].members] })) });
  const order = familyOrder(fams, seats, S, K);
  const fresh = make(order);
  const freshCost = seatWithin(fresh.blocks, seats, fresh.seatOf, S, K, d);
  const cur = currentSeating(ids, fams, seats, current);
  if (!cur) return out(order, fresh.seatOf, freshCost, false);
  const curCost = seatingCost(seats, cur.seatOf, S, K);
  const polished = Int32Array.from(cur.seatOf);
  const polishedCost = seatWithin(blocksFor(fams, cur.order).map(b => ({ ...b, seats: b.members.map(k => cur.seatOf[k]) })), seats, polished, S, K, d);
  const [bestOrder, best, bestCost] = polishedCost <= freshCost ? [cur.order, polished, polishedCost] : [order, fresh.seatOf, freshCost];
  if (bestCost <= (1 - d.keep) * curCost - 1e-9) return out(bestOrder, best, bestCost, false);
  return out(cur.order, cur.seatOf, curCost, true);
}

/** The hole's radius in world units for galaxies of radii R: holeBand ring bands, a band being a typical galaxy
 *  across (twice the mean radius) plus the gap between two. 0 for a map too small to be a donut (under 7 systems). */
export function holeRadius(R, { gap = DONUT.gap, holeBand = DONUT.holeBand } = {}) {
  const K = R.length;
  if (K < 7) return 0;
  let s = 0;
  for (let k = 0; k < K; k++) s += R[k];
  return holeBand * ((2 * s) / K + gap);
}

export function placeSeats(seats, seatOf, R, { gap = DONUT.gap, familyGap = DONUT.familyGap, fam = null, holeBand = DONUT.holeBand, hole = holeRadius(R, { gap, holeBand }), turn: minTurn = DONUT.familyTurn } = {}) {
  const K = seatOf.length;
  const x = new Float64Array(K), y = new Float64Array(K);
  if (K <= 1) return { x, y, rho: [0], hole: { x: 0, y: 0, r: 0 }, turn: 0, wedges: K ? [{ key: fam ? fam[0] : null, a0: START - Math.PI, a1: START + Math.PI, members: [0] }] : [] };
  const keyOf = k => (fam ? fam[k] : null);
  const need = (a, b) => R[a] + R[b] + gap + (keyOf(a) !== keyOf(b) ? familyGap : 0);
  const rows = Math.max(...seats.map(st => st.row)) + 1;
  // the families in the seating's order round the ring (each one run of seats; by where its run starts), each with
  // its systems per ring in run order
  const byKey = new Map();
  for (let k = 0; k < K; k++) { if (!byKey.has(keyOf(k))) byKey.set(keyOf(k), []); byKey.get(keyOf(k)).push(k); }
  const groups = [...byKey].map(([key, list]) => {
    const set = new Set(list.map(k => seatOf[k]));
    const start = [...set].filter(s => !set.has((s + K - 1) % K)).sort((a, b) => a - b)[0] ?? 0;
    const pos = k => (seatOf[k] - start + K) % K;
    const sorted = [...list].sort((a, b) => pos(a) - pos(b));
    return { key, start, list: sorted, byRow: Array.from({ length: rows }, (_, r) => sorted.filter(k => seats[seatOf[k]].row === r)) };
  }).sort((p, q) => p.start - q.start);
  const F = groups.length;
  const half = (k, p) => Math.asin(Math.min(1, R[k] / p));
  const step = (a, b, p) => 2 * Math.asin(Math.min(1, need(a, b) / (2 * p)));
  const width = (list, p) => { if (!list.length) return 0; let w = half(list[0], p) + half(list[list.length - 1], p); for (let j = 1; j < list.length; j++) w += step(list[j - 1], list[j], p); return w; };
  const maxR = r => Math.max(0, ...groups.flatMap(g => g.byRow[r]).map(k => R[k]));
  // the radii only grow: from the hole's edge, scaled up while the wedges do not fit round the circle, and pushed out
  // ring by ring for whatever the angles still leave too close
  const rho0 = Math.max(hole + maxR(0), maxR(0), 1);
  let rho = [rho0];
  for (let r = 1; r < rows; r++) rho.push(rho[r - 1] + 0.5 * (maxR(r - 1) + maxR(r) + gap));
  // each family's width (its widest ring) and the turn the gap between families needs, at these radii
  const wedgesAt = rr => {
    const widths = groups.map(g => g.byRow.map((list, r) => width(list, rr[r])));
    const W = widths.map(w => Math.max(...w));
    let T = F > 1 ? minTurn : 0;
    for (let r = 0; F > 1 && r < rows; r++) for (let f = 0; f < F; f++) {
      const A = groups[f].byRow[r], B = groups[(f + 1) % F].byRow[r];
      if (!A.length || !B.length) continue;
      const a = A[A.length - 1], b = B[0];
      T = Math.max(T, step(a, b, rr[r]) - half(a, rr[r]) - half(b, rr[r]));
    }
    return { widths, W, T, sumW: W.reduce((t, w) => t + w, 0) };
  };
  const ang = new Float64Array(K);
  let turn = 0, wedges = [];
  for (let it = 0; it < 1000; it++) {
    const { widths, W, T, sumW } = wedgesAt(rho);
    if (sumW + F * T > TAU - 1e-9 || W.some(v => v >= Math.PI * 1.999)) {
      // too wide to go round: the rings that set a family's width go out a little (1%, so none goes far past need)
      const binding = new Set(widths.map((w, g) => w.indexOf(W[g])));
      rho = rho.map((p, r) => (binding.has(r) ? p * 1.01 : p));
      continue;
    }
    turn = (TAU - sumW) / F;
    let at = START + turn / 2;
    wedges = groups.map((g, f) => {
      const a0 = at, a1 = at + W[f], mid = (a0 + a1) / 2;
      at = a1 + turn;
      g.byRow.forEach((list, r) => {
        let a = mid - width(list, rho[r]) / 2 + (list.length ? half(list[0], rho[r]) : 0);
        list.forEach((k, j) => { if (j) a += step(list[j - 1], k, rho[r]); ang[k] = a; });
      });
      return { key: g.key, a0, a1, members: [...g.list] };
    });
    // each ring at the smallest radius from rho[r] out where nothing on it, or on a ring inside it, is too close
    const next = [];
    for (let r = 0; r < rows; r++) {
      const list = groups.flatMap(g => g.byRow[r]).sort((p, q) => wrap(ang[p]) - wrap(ang[q]));
      const inner = groups.flatMap(g => g.byRow.slice(0, r).flat());
      const ok = p => {
        for (let q = 0; q < list.length; q++) {
          const a = list[q], b = list[(q + 1) % list.length];
          if (hole > 0 && p < hole + R[a]) return false;
          if (a !== b && 2 * p * Math.abs(Math.sin((ang[a] - ang[b]) / 2)) < need(a, b) - 1e-9) return false;
          for (const o of inner) if (Math.hypot(p * Math.cos(ang[a]) - x[o], p * Math.sin(ang[a]) - y[o]) < need(a, o) - 1e-9) return false;
        }
        return true;
      };
      let lo = Math.max(rho[r], r ? next[r - 1] : 0), hi = lo;
      if (!ok(lo)) {
        hi = lo * 2 + 1;
        while (!ok(hi)) hi *= 2;
        for (let q = 0; q < 60; q++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
      }
      next.push(hi);
      for (const k of list) { x[k] = hi * Math.cos(ang[k]); y[k] = hi * Math.sin(ang[k]); }
    }
    const moved = next.some((p, r) => p > rho[r] + 1e-3);
    rho = next;
    if (!moved) break;
  }
  let clear = Infinity;
  for (let k = 0; k < K; k++) clear = Math.min(clear, Math.hypot(x[k], y[k]) - R[k]);
  return { x, y, rho, hole: { x: 0, y: 0, r: Math.max(0, clear) }, turn, wedges };
}

export function galaxyFootprints(model, { link = DONUT.gap } = {}) {
  const by = new Map();
  for (let i = 0; i < model.n; i++) {
    if (!model.placed[i]) continue;
    const c = model.cat[i];
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(i);
  }
  const out = [];
  for (const [c, all] of by) {
    // the clusters by single linkage (a union-find over the system's own dots)
    const n = all.length, up = Int32Array.from({ length: n }, (_, q) => q);
    const root = q => { while (up[q] !== q) { up[q] = up[up[q]]; q = up[q]; } return q; };
    for (let p = 0; p < n; p++) {
      const i = all[p], xi = model.x[i], yi = model.y[i], ri = model.r[i] || 0;
      for (let q = p + 1; q < n; q++) {
        const j = all[q], d = link + ri + (model.r[j] || 0), dx = model.x[j] - xi;
        if (dx > d || dx < -d) continue;
        const dy = model.y[j] - yi;
        if (dy > d || dy < -d || dx * dx + dy * dy >= d * d) continue;
        const a = root(p), b = root(q);
        if (a !== b) up[Math.max(a, b)] = Math.min(a, b);
      }
    }
    const size = new Int32Array(n);
    for (let q = 0; q < n; q++) size[root(q)]++;
    let main = 0;
    for (let q = 1; q < n; q++) if (size[q] > size[main]) main = q;
    const list = [], strays = [];
    for (let q = 0; q < n; q++) (root(q) === main ? list : strays).push(all[q]);
    let x = 0, y = 0;
    for (const i of list) { x += model.x[i]; y += model.y[i]; }
    x /= list.length; y /= list.length;
    let R = 0;
    for (const i of list) R = Math.max(R, Math.hypot(model.x[i] - x, model.y[i] - y) + (model.r[i] || 0));
    out.push({ c, x, y, R, n, list, strays });
  }
  return out.sort((p, q) => p.c - q.c);
}

/**
 * Each family's wedge on the map as it is drawn: [{id, name, a0, a1, r0, r1, members: [category index]}], angles
 * in radians (screen: clockwise from +x, a1 > a0), radii in world units round {cx, cy}: the donut's centre, the world's
 * origin, where placeSeats puts it; ring: the foundation galaxies [{c, name (short), x, y, R}]. Null when there are
 * fewer than 3 systems. Each wedge is the angular hull of its galaxies as drawn (galaxyFootprints: their main
 * clusters' centres and reach), which is exactly the wedge placeSeats gave the family; were two to overlap (a layout
 * from before v7), they meet half way. r0 and r1 are the nearest and farthest reach of those clusters' dots from the
 * centre (strays left out): every family's arc is drawn on the one circle past r1 (families.js arcRadiusPx).
 */
export function familySectors(model, { pad = 0.04 } = {}) {
  const all = galaxyFootprints(model).map(g => {
    const cat = model.cats[g.c];
    const ring = isFoundationCategory(cat ? cat.id : null);
    let { x, y, R } = g;
    if (ring) {
      // a foundation orb is placed whole (foundations-ring.js), every dot of it
      const list = [...g.list, ...g.strays];
      x = list.reduce((t, i) => t + model.x[i], 0) / list.length; y = list.reduce((t, i) => t + model.y[i], 0) / list.length;
      R = 0;
      for (const i of list) R = Math.max(R, Math.hypot(model.x[i] - x, model.y[i] - y) + (model.r[i] || 0));
    }
    return { c: g.c, x, y, R, list: g.list, fam: familyOf(cat ? cat.id : null), ring, name: cat ? cat.short || cat.name || cat.id : '' };
  });
  // the foundations ring round the donut has no wedge (foundations-ring.js); each of its galaxies is named beside it
  const ring = all.filter(g => g.ring).map(g => ({ c: g.c, name: g.name, x: g.x, y: g.y, R: g.R }));
  const gals = all.filter(g => !g.ring);
  if (gals.length < 3) return null;
  const cx = 0, cy = 0;
  let r0 = Infinity, r1 = 0;
  for (const g of gals) {
    g.rho = Math.hypot(g.x - cx, g.y - cy);
    g.a = Math.atan2(g.y - cy, g.x - cx);
    g.half = g.rho > g.R ? Math.asin(Math.min(1, g.R / g.rho)) : Math.PI / 2;
    g.r0 = Infinity; g.r1 = 0;
    for (const i of g.list) { const d = Math.hypot(model.x[i] - cx, model.y[i] - cy), r = model.r[i] || 0; g.r0 = Math.min(g.r0, d - r); g.r1 = Math.max(g.r1, d + r); }
    r0 = Math.min(r0, g.r0); r1 = Math.max(r1, g.r1);
  }
  const byFam = new Map();
  for (const g of gals) { if (!byFam.has(g.fam.id)) byFam.set(g.fam.id, { fam: g.fam, gals: [] }); byFam.get(g.fam.id).gals.push(g); }
  // each family's span round its own circular mean, so a family across the +x axis is one span
  const spans = [...byFam.values()].map(({ fam, gals: list }) => {
    const mx = list.reduce((a, g) => a + Math.cos(g.a), 0), my = list.reduce((a, g) => a + Math.sin(g.a), 0);
    const mid = Math.atan2(my, mx);
    let lo = Infinity, hi = -Infinity;
    for (const g of list) {
      const d = Math.atan2(Math.sin(g.a - mid), Math.cos(g.a - mid));
      lo = Math.min(lo, d - g.half); hi = Math.max(hi, d + g.half);
    }
    return { id: fam.id, name: fam.name, members: list.map(g => g.c).sort((a, b) => a - b), a0: mid + lo, a1: mid + hi, mid };
  }).sort((p, q) => wrap(p.mid - START) - wrap(q.mid - START));
  const F = spans.length;
  for (let f = 0; F > 1 && f < F; f++) {
    const s = spans[f], n = spans[(f + 1) % F];
    let shift = 0;   // the next wedge's angles brought into this one's turn
    while (n.a0 + shift < s.a1 - Math.PI) shift += TAU;
    while (n.a0 + shift > s.a1 + Math.PI) shift -= TAU;
    const n0 = n.a0 + shift;
    if (n0 >= s.a1) continue;
    const meet = (s.a1 + n0) / 2;
    s.a1 = meet - pad;
    n.a0 = meet + pad - shift;
  }
  for (const s of spans) { while (s.a1 < s.a0) s.a1 += TAU; delete s.mid; }
  return { cx, cy, r0: Math.max(0, r0), r1, sectors: spans, ring };
}
