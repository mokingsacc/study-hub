import { similarityGraph } from './similarity.js';
import { familyOf, DONUT } from './donut.js';
// The foundation systems go on a ring round the donut (foundations-ring.js); without any, these are donut.js's own.
import { seatWithRing, placeWithRing } from './foundations-ring.js';

export const V3 = Object.freeze({
  // 2. categories
  far: 1.7,                 // target distance (Ra + Rb + gap) · (1 + far · (1 - ŝ)): unrelated pairs ~2.7× apart
  gap: 60,                  // sky between two related galaxies' discs (world units)
  catIters: 800,            // force layout on the category graph
  spring: 0.6, springPower: 2, spread: 0.02, catGravity: 0.004,   // springs ∝ ŝ²: the strongest ties win the few places beside a galaxy
  // 3. units
  facing: 0.7,              // how much two units that face the same way count as related
  // 4. topics
  target: 0.12,             // pull to the blended unit target (× alpha)
  between: 0.9,             // a related topic in another unit counts this share of membership
  lean: 0,                  // how far a topic with cross-system ties leans, as a share of the galaxy's radius (0 since
  leanGain: 1.1,            // v5: topics stay inside their own cluster); lean = lean · R · tanh(gain · |ties|)
  simRest: 22,              // rest length of a similarity spring beyond touching, for a weak pair (× (1 - w))
  simStrength: 0.4,
  charge: -9, chargeMax: 60,
  velocityDecay: 0.6,
  chunkTicks: 96, chunkMs: 6,
});

const TAU = 2 * Math.PI;

/** FNV-1a 32-bit (layout.js and the Worker's positions.js have the same). */
function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}
const round1 = v => Math.round(v * 10) / 10;
const byHash = model => (a, b) => fnv1a(model.id[a]) - fnv1a(model.id[b]) || (model.id[a] < model.id[b] ? -1 : 1);

// ------------------------------------------------------------------ 2. categories by relatedness

/**
 * The categories' relatedness: {ks: [category index, ...] (-1 first, as v2 orders galaxies), at: Map(c -> k),
 * n, R (estimated radius), S (k×k, cross-category similarity mass / √(n_a n_b), scaled so the largest is 1)}.
 */
export function categoryRelatedness(model, graph, f) {
  const counts = new Map();
  const area = new Map();
  for (let i = 0; i < model.n; i++) {
    const c = model.cat[i];
    counts.set(c, (counts.get(c) || 0) + 1);
    area.set(c, (area.get(c) || 0) + (model.r[i] + f.collidePad) ** 2);
  }
  const ks = [...counts.keys()].sort((a, b) => a - b);
  const at = new Map(ks.map((c, k) => [c, k]));
  const K = ks.length;
  const M = new Float64Array(K * K);
  for (let e = 0; e < graph.size; e++) {
    const ca = at.get(model.cat[graph.a[e]]), cb = at.get(model.cat[graph.b[e]]);
    if (ca === cb) continue;
    M[ca * K + cb] += graph.w[e]; M[cb * K + ca] += graph.w[e];
  }
  const n = ks.map(c => counts.get(c));
  const R = ks.map(c => Math.sqrt(area.get(c) / 0.6));
  const S = new Float64Array(K * K);
  let max = 0;
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) if (a !== b) { S[a * K + b] = M[a * K + b] / Math.sqrt(n[a] * n[b]); max = Math.max(max, S[a * K + b]); }
  if (max > 0) for (let k = 0; k < S.length; k++) S[k] /= max;
  return { ks, at, K, n, R, S, M };
}

// The two leading eigenvectors of a symmetric k×k matrix (power iteration with deflation, a fixed start).
function topTwo(B, K) {
  const out = [];
  const A = Float64Array.from(B);
  for (let e = 0; e < 2; e++) {
    let v = Float64Array.from({ length: K }, (_, i) => 1 + ((i * 7 + e * 3) % 11) / 10 - 0.5 * e * (i % 2));
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(K);
      for (let i = 0; i < K; i++) { let s = 0; for (let j = 0; j < K; j++) s += A[i * K + j] * v[j]; w[i] = s; }
      let norm = 0;
      for (let i = 0; i < K; i++) norm += w[i] * w[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < K; i++) w[i] /= norm;
      let r = 0;
      for (let i = 0; i < K; i++) { let s = 0; for (let j = 0; j < K; j++) s += A[i * K + j] * w[j]; r += w[i] * s; }
      lambda = r;
      v = w;
    }
    out.push({ v, lambda });
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) A[i * K + j] -= lambda * v[i] * v[j];
  }
  return out;
}

/**
 * Where each galaxy goes, before packing: classical MDS on the target distances as the start, then a force layout
 * on the category graph. Returns {x, y: Float64Array(K), delta} centred, its long axis across (screens are wide).
 */
export function placeCategories(rel, f = V3) {
  const { K, R, S } = rel;
  const x = new Float64Array(K), y = new Float64Array(K);
  if (K <= 1) return { x, y };
  const delta = new Float64Array(K * K);
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    if (a === b) continue;
    const s = S[a * K + b];
    const d = (R[a] + R[b] + f.gap) * (1 + f.far * (1 - s));
    delta[a * K + b] = d;
  }
  // Classical MDS: B = -1/2 J D² J.
  const D2 = new Float64Array(K * K);
  for (let k = 0; k < K * K; k++) D2[k] = delta[k] * delta[k];
  const rowMean = new Float64Array(K);
  let all = 0;
  for (let a = 0; a < K; a++) { let s = 0; for (let b = 0; b < K; b++) s += D2[a * K + b]; rowMean[a] = s / K; all += s; }
  all /= K * K;
  const B = new Float64Array(K * K);
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) B[a * K + b] = -0.5 * (D2[a * K + b] - rowMean[a] - rowMean[b] + all);
  const [e1, e2] = topTwo(B, K);
  for (let a = 0; a < K; a++) { x[a] = e1.v[a] * Math.sqrt(Math.max(e1.lambda, 0)); y[a] = e2.v[a] * Math.sqrt(Math.max(e2.lambda, 0)); }
  // A degenerate start (every pair the same distance, as when the systems share no links yet): spread on a circle in
  // order. MDS then gives near-equal eigenvalues and piles systems on top of each other, which the push below would
  // fling apart without bound (audit AUD-016), so a start where most systems sit on another counts as degenerate too.
  let spread = 0, piled = 0, pairs = 0;
  for (let a = 0; a < K; a++) spread += x[a] * x[a] + y[a] * y[a];
  const typical = Math.sqrt(spread / K);
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { pairs++; if (Math.hypot(x[a] - x[b], y[a] - y[b]) < 0.05 * typical) piled++; }
  if (!(spread > 1e-6) || piled > 0.2 * pairs) for (let a = 0; a < K; a++) { x[a] = Math.cos((TAU * a) / K) * 100; y[a] = Math.sin((TAU * a) / K) * 100; }
  // Scale the MDS start so its typical neighbour sits about one touching distance away.
  let mean = 0, cnt = 0, md = 0;
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { mean += R[a] + R[b] + f.gap; md += Math.hypot(x[a] - x[b], y[a] - y[b]); cnt++; }
  const sc = md > 0 ? (2.2 * mean) / md : 1;
  for (let a = 0; a < K; a++) { x[a] *= sc; y[a] *= sc; }
  // A force layout on the category graph: related pairs held at touching distance by springs as strong as their
  // relatedness, every pair kept apart (discs never overlap, a soft push spreads the rest), weak gravity.
  const vx = new Float64Array(K), vy = new Float64Array(K);
  for (let it = 0; it < f.catIters; it++) {
    const cool = 1 - it / f.catIters;
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
      let dx = x[b] - x[a], dy = y[b] - y[a];
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) { dx = 1e-3 * (((a * 31 + b * 17) % 7) - 3) || 1e-3; dy = 1e-3 * (((a * 13 + b * 29) % 5) - 2); d = Math.sqrt(dx * dx + dy * dy); }
      const ux = dx / d, uy = dy / d, touch = R[a] + R[b] + f.gap, s = S[a * K + b];
      let F = 0;
      if (s > 0) F += f.spring * s ** f.springPower * (d - touch);     // related: drawn to touching, the strongest most
      const dp = Math.max(d, 0.25 * touch);                              // the push is bounded: two discs on top of
      F -= f.spread * (touch * touch) / (dp * dp) * touch;              // each other part, they don't fly off
      if (d < touch) F -= (touch - d) * 0.5;                            // never overlapping
      F = Math.max(-2 * touch, Math.min(2 * touch, F));
      vx[a] += ux * F; vy[a] += uy * F; vx[b] -= ux * F; vy[b] -= uy * F;
    }
    for (let a = 0; a < K; a++) {
      vx[a] -= x[a] * f.catGravity; vy[a] -= y[a] * f.catGravity;
      const step = 0.1 + 0.4 * cool;
      x[a] += vx[a] * step; y[a] += vy[a] * step; vx[a] *= 0.5; vy[a] *= 0.5;
    }
  }
  // A last guard: if anything went non-finite or far beyond every disc laid end to end, fall back to the circle.
  let reach = 0;
  for (let a = 0; a < K; a++) reach += 2 * R[a] + f.gap;
  let bad = false;
  for (let a = 0; a < K; a++) if (!Number.isFinite(x[a]) || !Number.isFinite(y[a]) || Math.abs(x[a]) > 4 * reach || Math.abs(y[a]) > 4 * reach) bad = true;
  if (bad) {
    const rr = reach / TAU + Math.max(...R);
    for (let a = 0; a < K; a++) { x[a] = Math.cos((TAU * a) / K) * rr; y[a] = Math.sin((TAU * a) / K) * rr; }
  }
  // Centre, then turn the long axis across the screen, with a fixed sense.
  let cx = 0, cy = 0;
  for (let a = 0; a < K; a++) { cx += x[a]; cy += y[a]; }
  cx /= K; cy /= K;
  let sxx = 0, syy = 0, sxy = 0;
  for (let a = 0; a < K; a++) { x[a] -= cx; y[a] -= cy; sxx += x[a] * x[a]; syy += y[a] * y[a]; sxy += x[a] * y[a]; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(-th), s = Math.sin(-th);
  let skew = 0, skewY = 0;
  for (let a = 0; a < K; a++) {
    const u = x[a] * c - y[a] * s, v = x[a] * s + y[a] * c;
    x[a] = u; y[a] = v; skew += u * u * u; skewY += v * v * v;
  }
  if (skew < 0) for (let a = 0; a < K; a++) x[a] = -x[a];
  if (skewY < 0) for (let a = 0; a < K; a++) y[a] = -y[a];
  return { x, y, delta };
}

// ------------------------------------------------------------------ 3. units round the ring

/**
 * The ring order of k units from their affinity (k×k, symmetric): a greedy chain from the most connected unit,
 * then 2-opt on the cycle until no swap helps. Returns the unit positions 0..k-1 in ring order.
 */
export function ringOrder(A, k) {
  if (k <= 3) return Array.from({ length: k }, (_, i) => i);
  const tot = Array.from({ length: k }, (_, u) => { let s = 0; for (let v = 0; v < k; v++) if (v !== u) s += A[u * k + v]; return s; });
  let start = 0;
  for (let u = 1; u < k; u++) if (tot[u] > tot[start] + 1e-12) start = u;
  const order = [start];
  const used = new Uint8Array(k);
  used[start] = 1;
  while (order.length < k) {
    const end = order[order.length - 1];
    let best = -1, bw = -Infinity;
    for (let v = 0; v < k; v++) if (!used[v] && A[end * k + v] > bw + 1e-12) { bw = A[end * k + v]; best = v; }
    order.push(best); used[best] = 1;
  }
  const at = (i) => order[(i + k) % k];
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let i = 0; i < k - 1; i++) for (let j = i + 2; j < k; j++) {
      if (i === 0 && j === k - 1) continue;
      const a = at(i), b = at(i + 1), c = at(j), d = at(j + 1);
      const gain = A[a * k + c] + A[b * k + d] - A[a * k + b] - A[c * k + d];
      if (gain > 1e-9) {
        for (let lo = i + 1, hi = j; lo < hi; lo++, hi--) { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; }
        improved = true;
      }
    }
    if (!improved) break;
  }
  return order;
}

// ------------------------------------------------------------------ 4. one galaxy

// The tilt that makes a galaxy an ellipse (v2's, by the category's id), and its inverse on a direction.
function tiltOf(model, c, f) {
  const th = ((fnv1a(`tilt:${model.cats[c] ? model.cats[c].id : c}`) % 180) * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th), t = f.tilt;
  return {
    cos, sin, t,
    // world direction -> the untilted frame the galaxy is laid out in
    inv(x, y) { const u = x * cos + y * sin, v = (-x * sin + y * cos) / t; return [u * cos - v * sin, u * sin + v * cos]; },
  };
}

function galaxySetup(model, graph, list, c, k, rel, P, f, v3) {
  const n = list.length;
  const local = new Map(list.map((i, j) => [i, j]));
  const tilt = tiltOf(model, c, f);
  const area = list.reduce((a, i) => a + (model.r[i] + f.collidePad) ** 2, 0);
  const Rest = Math.sqrt(area / 0.6);
  // Each topic's ties to other systems, as a direction in the untilted frame.
  const ex = new Float64Array(n), ey = new Float64Array(n), ties = new Float64Array(n);
  const edges = [];
  for (let j = 0; j < n; j++) {
    const i = list[j];
    for (let q = graph.off[i]; q < graph.off[i + 1]; q++) {
      const e = graph.adj[q], o = graph.a[e] === i ? graph.b[e] : graph.a[e], w = graph.w[e];
      const lo = local.get(o);
      if (lo != null) { if (lo > j) edges.push([j, lo, w]); continue; }
      const ko = rel.at.get(model.cat[o]);
      if (ko == null || ko === k) continue;
      let dx = P.x[ko] - P.x[k], dy = P.y[ko] - P.y[k];
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;
      dx /= d; dy /= d;
      ex[j] += w * dx; ey[j] += w * dy; ties[j] += w;
    }
    if (ex[j] || ey[j]) { const [ux, uy] = tilt.inv(ex[j], ey[j]); const m = Math.hypot(ex[j], ey[j]), mu = Math.hypot(ux, uy) || 1; ex[j] = (ux / mu) * m; ey[j] = (uy / mu) * m; }
  }
  // Units: the ring (units with an id) and the middle (topics with none).
  const seen = new Map();
  for (const i of list) { const u = model.unit[i]; if (!seen.has(u)) seen.set(u, []); seen.get(u).push(local.get(i)); }
  const ringUnits = [...seen.keys()].filter(u => u >= 0).sort((a, b) => a - b);
  const hasMiddle = seen.has(-1);
  const units = hasMiddle ? [...ringUnits, -1] : ringUnits;
  const ui = new Map(units.map((u, q) => [u, q]));
  const U = units.length;
  const uOf = new Int32Array(n);
  for (let j = 0; j < n; j++) uOf[j] = ui.get(model.unit[list[j]]);
  // Unit affinity from the galaxy's own pairs, plus facing the same way.
  const kR = ringUnits.length;
  const Aff = new Float64Array(kR * kR);
  const Ex = new Float64Array(U), Ey = new Float64Array(U), Un = new Float64Array(U);
  for (let j = 0; j < n; j++) { Ex[uOf[j]] += ex[j]; Ey[uOf[j]] += ey[j]; Un[uOf[j]]++; }
  for (const [a, b, w] of edges) {
    const ua = uOf[a], ub = uOf[b];
    if (ua === ub || ua >= kR || ub >= kR) continue;
    Aff[ua * kR + ub] += w; Aff[ub * kR + ua] += w;
  }
  for (let a = 0; a < kR; a++) for (let b = a + 1; b < kR; b++) {
    const ma = Math.hypot(Ex[a], Ey[a]), mb = Math.hypot(Ex[b], Ey[b]);
    let v = Aff[a * kR + b];
    if (ma > 0 && mb > 0) v += v3.facing * Math.max(0, (Ex[a] * Ex[b] + Ey[a] * Ey[b]) / (ma * mb)) * Math.sqrt(ma * mb);
    v /= Math.sqrt(Un[a] * Un[b]);
    Aff[a * kR + b] = v; Aff[b * kR + a] = v;
  }
  const order = ringOrder(Aff, kR);
  // Arcs by √(unit size), turned (and mirrored if better) so units face the systems they are tied to.
  const q = order.map(u => Math.sqrt(Un[u]));
  const Q = q.reduce((a, b) => a + b, 0) || 1;
  const base = new Float64Array(kR);
  let cum = 0;
  order.forEach((u, p) => { base[u] = (TAU * (cum + q[p] / 2)) / Q; cum += q[p]; });
  let best = null;
  for (const sgn of [1, -1]) {
    let zr = 0, zi = 0;
    for (let u = 0; u < kR; u++) {
      const m = Math.hypot(Ex[u], Ey[u]);
      if (!m) continue;
      const ang = sgn * base[u] - Math.atan2(Ey[u], Ex[u]);
      zr += m * Math.cos(ang); zi += m * Math.sin(ang);
    }
    const mag = Math.hypot(zr, zi);
    if (!best || mag > best.mag + 1e-9) best = { sgn, mag, rot: -Math.atan2(zi, zr) };
  }
  if (!best || best.mag < 1e-9) best = { sgn: 1, mag: 0, rot: ((fnv1a(model.cats[c] ? model.cats[c].id : String(c)) % 360) * Math.PI) / 180 };
  const ringR = kR > 1 ? Math.max(14, f.ring * Math.sqrt(area / 0.6)) : 0;
  const ucx = new Float64Array(U), ucy = new Float64Array(U);
  for (let u = 0; u < kR; u++) { const a = best.rot + best.sgn * base[u]; ucx[u] = Math.cos(a) * ringR; ucy[u] = Math.sin(a) * ringR; }
  // Each topic's target: its unit and the units it is related to, then its lean.
  const wsum = new Float64Array(n * U);
  for (let j = 0; j < n; j++) wsum[j * U + uOf[j]] += 1;
  for (const [a, b, w] of edges) { wsum[a * U + uOf[b]] += v3.between * w; wsum[b * U + uOf[a]] += v3.between * w; }
  const tx = new Float64Array(n), ty = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0, x = 0, y = 0;
    for (let u = 0; u < U; u++) { const w = wsum[j * U + u]; if (!w) continue; s += w; x += w * ucx[u]; y += w * ucy[u]; }
    tx[j] = x / s; ty[j] = y / s;
    const m = Math.hypot(ex[j], ey[j]);
    if (m > 0) { const lean = v3.lean * Rest * Math.tanh(v3.leanGain * ties[j]); tx[j] += (ex[j] / m) * lean; ty[j] += (ey[j] / m) * lean; }
  }
  // The nodes, in hash order (the same on every page), starting at their targets.
  const ord = [...Array(n).keys()].sort((a, b) => byHash(model)(list[a], list[b]));
  const x = new Float64Array(n), y = new Float64Array(n), r = new Float64Array(n);
  ord.forEach((j, p) => { x[j] = tx[j] + Math.cos(p * 2.4) * 9; y[j] = ty[j] + Math.sin(p * 2.4) * 9; });
  for (let j = 0; j < n; j++) r[j] = model.r[list[j]] + f.collidePad;
  const deg = new Float64Array(n);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  const ea = new Int32Array(edges.length), eb = new Int32Array(edges.length), ek = new Float64Array(edges.length), er = new Float64Array(edges.length), bias = new Float64Array(edges.length);
  edges.forEach(([a, b, w], e) => {
    ea[e] = a; eb[e] = b;
    ek[e] = (v3.simStrength * w) / Math.sqrt(Math.max(1, Math.min(deg[a], deg[b])));
    er[e] = r[a] + r[b] + v3.simRest * (1 - w);   // just beyond touching for a close pair
    bias[e] = deg[a] / (deg[a] + deg[b]);
  });
  return { c, k, list, n, x, y, vx: new Float64Array(n), vy: new Float64Array(n), r, tx, ty, ea, eb, ek, er, bias,
    rnd: lcg(11 + c), alpha: 1, phase: 0, ticks: 0, tilt, order: order.map(u => units[u]) };
}

function jiggle(g) { return (g.rnd() - 0.5) * 1e-6; }

function collide(g) {
  const { n, x, y, vx, vy, r } = g;
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < n; i++) {
      const xi = x[i] + vx[i], yi = y[i] + vy[i], ri = r[i], ri2 = ri * ri;
      for (let j = i + 1; j < n; j++) {
        const rr = ri + r[j];
        let dx = xi - x[j] - vx[j], dy = yi - y[j] - vy[j];
        let l = dx * dx + dy * dy;
        if (l >= rr * rr) continue;
        if (dx === 0) { dx = jiggle(g); l += dx * dx; }
        if (dy === 0) { dy = jiggle(g); l += dy * dy; }
        l = Math.sqrt(l);
        const p = (rr - l) / l;
        const rj2 = r[j] * r[j], share = rj2 / (ri2 + rj2);
        dx *= p; dy *= p;
        vx[i] += dx * share; vy[i] += dy * share;
        vx[j] -= dx * (1 - share); vy[j] -= dy * (1 - share);
      }
    }
  }
}

function tick(g, f, v3) {
  const { n, x, y, vx, vy } = g;
  if (g.phase === 0) {
    g.alpha += (0 - g.alpha) * f.alphaDecay;
    const alpha = g.alpha;
    const kT = v3.target * alpha;
    for (let i = 0; i < n; i++) { vx[i] += (g.tx[i] - x[i]) * kT; vy[i] += (g.ty[i] - y[i]) * kT; }
    for (let e = 0; e < g.ea.length; e++) {
      const a = g.ea[e], b = g.eb[e];
      let dx = x[b] + vx[b] - x[a] - vx[a], dy = y[b] + vy[b] - y[a] - vy[a];
      if (dx === 0 && dy === 0) { dx = jiggle(g); dy = jiggle(g); }
      const l = Math.sqrt(dx * dx + dy * dy);
      const s = ((l - g.er[e]) / l) * alpha * g.ek[e];
      dx *= s; dy *= s;
      vx[b] -= dx * g.bias[e]; vy[b] -= dy * g.bias[e];
      vx[a] += dx * (1 - g.bias[e]); vy[a] += dy * (1 - g.bias[e]);
    }
    const dmax2 = v3.chargeMax * v3.chargeMax, w = v3.charge * alpha;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = x[j] - x[i], dy = y[j] - y[i];
      let l = dx * dx + dy * dy;
      if (l >= dmax2 || l === 0) continue;   // two at one spot: the collision pass parts them
      if (l < 1) l = Math.sqrt(l);           // d3's distanceMin of 1
      const s = w / l;
      vx[i] += dx * s; vy[i] += dy * s; vx[j] -= dx * s; vy[j] -= dy * s;
    }
  }
  collide(g);
  for (let i = 0; i < n; i++) { vx[i] *= v3.velocityDecay; vy[i] *= v3.velocityDecay; x[i] += vx[i]; y[i] += vy[i]; }
}

// Tilts a settled galaxy into an ellipse (as v2 does) for the short collision-only settle that follows.
function tiltGalaxy(g, f) {
  const { cos, sin } = g.tilt;
  let cx = 0, cy = 0;
  for (let i = 0; i < g.n; i++) { cx += g.x[i]; cy += g.y[i]; }
  cx /= g.n || 1; cy /= g.n || 1;
  for (let i = 0; i < g.n; i++) {
    const x = g.x[i] - cx, y = g.y[i] - cy, u = x * cos + y * sin, v = (-x * sin + y * cos) * f.tilt;
    g.x[i] = u * cos - v * sin; g.y[i] = u * sin + v * cos; g.vx[i] = 0; g.vy[i] = 0;
  }
}

// ------------------------------------------------------------------ the driver

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * The whole layout (v3's passes, seated on the donut since v5). Resolves to {topics: [[id, x, y]], categories:
 * [[id, x, y]], graph, seating} for PUT /api/map/positions, like v2. sim: embedding neighbours [[i, j, s100]] by
 * topic index. f: layout.js FORCES (tilt, ticks); v3: V3. current: Map(category id -> [x, y]) of where each system
 * is now (Tidy: the seating stays unless a new one is clearly better; donut.js seatCategories), or null.
 * onProgress(0..1) after each chunk; next(fn) schedules the next chunk; stop() throws when the page was left.
 */
export async function semanticLayout(model, { sim = [], f, v3 = V3, onProgress = null, next, stop = () => {}, current = null, donut = DONUT } = {}) {
  // The set-up runs a step per chunk too, so a quiet re-arrange never holds a frame.
  const pause = async () => { await new Promise(res => next(res)); stop(); };
  stop();
  const graph = similarityGraph(model, sim);
  await pause();
  const rel = categoryRelatedness(model, graph, f);
  const ids = rel.ks.map(c => (c >= 0 && model.cats[c] ? model.cats[c].id : null));
  const seating = seatWithRing(ids, rel.S, { current, d: donut });
  // the seats at the galaxies' estimated sizes: where each galaxy's ties point while its units are turned
  const fam = ids.map(id => familyOf(id).id);
  const P = placeWithRing(seating, rel.R, { gap: donut.gap, familyGap: donut.familyGap, holeBand: donut.holeBand, fam });
  const members = new Map();
  for (let i = 0; i < model.n; i++) { const c = model.cat[i]; if (!members.has(c)) members.set(c, []); members.get(c).push(i); }
  const gals = [];
  for (let k = 0; k < rel.ks.length; k++) {
    await pause();
    gals.push(galaxySetup(model, graph, members.get(rel.ks[k]), rel.ks[k], k, rel, P, f, v3));
  }
  const perGalaxy = f.galaxyTicks + f.settleTicks;
  const total = gals.length * perGalaxy;
  let done = 0;
  await new Promise((resolve, reject) => {
    let gi = 0;
    const step = () => {
      try { stop(); } catch (e) { reject(e); return; }
      const t0 = now();
      let ticks = 0;
      while (gi < gals.length && ticks < v3.chunkTicks && (ticks === 0 || now() - t0 < v3.chunkMs)) {
        const g = gals[gi];
        tick(g, f, v3); g.ticks++; ticks++; done++;
        if (g.phase === 0 && g.ticks >= f.galaxyTicks) { tiltGalaxy(g, f); g.phase = 1; g.ticks = 0; }
        else if (g.phase === 1 && g.ticks >= f.settleTicks) { g.phase = 2; gi++; done = gi * perGalaxy; }
      }
      if (gi >= gals.length) { resolve(); return; }
      if (onProgress) onProgress(Math.min(0.99, done / total));
      next(step);
    };
    next(step);
  });

  // Each galaxy centred on its own middle, its reach (stars included); then the seats spread for the real sizes.
  stop();
  const R = new Float64Array(gals.length);
  for (const g of gals) {
    let cx = 0, cy = 0;
    for (let i = 0; i < g.n; i++) { cx += g.x[i]; cy += g.y[i]; }
    cx /= g.n || 1; cy /= g.n || 1;
    let reach = 10;
    for (let i = 0; i < g.n; i++) { g.x[i] -= cx; g.y[i] -= cy; reach = Math.max(reach, Math.hypot(g.x[i], g.y[i]) + model.r[g.list[i]]); }
    R[g.k] = reach;
  }
  const at = placeWithRing(seating, R, { gap: donut.gap, familyGap: donut.familyGap, holeBand: donut.holeBand, fam });
  if (onProgress) onProgress(1);

  const topics = [], categories = [];
  for (const g of gals) {
    const gx = at.x[g.k], gy = at.y[g.k];
    for (let i = 0; i < g.n; i++) topics.push([model.id[g.list[i]], round1(gx + g.x[i]), round1(gy + g.y[i])]);
    if (g.c >= 0 && model.cats[g.c]) categories.push([model.cats[g.c].id, round1(gx), round1(gy)]);
  }
  topics.sort((p, q) => (model.index.get(p[0]) ?? 0) - (model.index.get(q[0]) ?? 0));
  return { topics, categories, graph, seating: { ...seating, ids, x: at.x, y: at.y, R, rho: at.rho, wedges: at.wedges } };
}
