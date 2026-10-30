import { TYPE_NAMES, FLAGS, MIXED_UP } from '../shared/link-rank.js';

export const SIM = Object.freeze({
  type: Object.freeze({ versus: 1, treated_by: 0.8, causes: 0.65, adverse_effect: 0.55 }),
  strengthFloor: 0.6,      // a link's weight is typeW × (0.6 + 0.4 · strength)
  mixedBonus: 0.2,         // a mixed-up look-alike adds up to this much
  proposed: 0.75,          // a proposed link counts this share
  embed: 0.85,             // an embedding neighbour's score counts this share
});

/**
 * The related pairs of a model as {n, a: Int32Array, b: Int32Array, w: Float32Array, off, adj} (a < b; off/adj:
 * CSR by topic, adj holding pair indices). sim: [[i, j, s100]] by topic index (embedding neighbours; either
 * direction, duplicates fine).
 */
export function similarityGraph(model, sim = [], s = SIM) {
  const n = model.n;
  const pairs = new Map();
  const add = (i, j, w) => {
    if (!(w > 0) || i === j || i < 0 || j < 0 || i >= n || j >= n) return;
    const a = Math.min(i, j), b = Math.max(i, j), key = a * n + b;
    const prev = pairs.get(key) || 0;
    pairs.set(key, 1 - (1 - prev) * (1 - Math.min(1, w)));
  };
  for (const l of model.links || []) {
    const type = TYPE_NAMES[l[2]];
    const tw = s.type[type] ?? 0.5;
    const strength = Math.max(0, Math.min(1, (Number(l[3]) || 0) / 100));
    const conf = Math.max(0, Math.min(1, (Number(l[4]) || 0) / 100 / (2 * MIXED_UP)));   // 1 from twice the mixed-up line
    let w = tw * (s.strengthFloor + (1 - s.strengthFloor) * strength);
    if (type === 'versus') w += s.mixedBonus * conf;
    if (Number(l[5]) & FLAGS.proposed) w *= s.proposed;
    add(l[0], l[1], w);
  }
  // Embedding neighbours: one pair however many times it is listed (the stronger score counts).
  const emb = new Map();
  for (const r of sim || []) {
    const i = r[0], j = r[1], v = Math.max(0, Math.min(1, (Number(r[2]) || 0) / 100));
    if (i === j || i == null || j == null) continue;
    const a = Math.min(i, j), b = Math.max(i, j), key = a * n + b;
    if (v > (emb.get(key) || 0)) emb.set(key, v);
  }
  for (const [key, v] of emb) add(Math.floor(key / n), key % n, v * s.embed);
  const keys = [...pairs.keys()].sort((x, y) => x - y);
  const a = new Int32Array(keys.length), b = new Int32Array(keys.length), w = new Float32Array(keys.length);
  keys.forEach((key, k) => { a[k] = Math.floor(key / n); b[k] = key % n; w[k] = pairs.get(key); });
  const deg = new Uint32Array(n + 1);
  for (let k = 0; k < keys.length; k++) { deg[a[k]]++; deg[b[k]]++; }
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[n]);
  const at = off.slice(0, n);
  for (let k = 0; k < keys.length; k++) { adj[at[a[k]]++] = k; adj[at[b[k]]++] = k; }
  return { n, a, b, w, off, adj, size: keys.length };
}

/** sim rows by topic id ([[id, id, s100]], GET /api/map/layout-input) -> by index for this model. */
export function simByIndex(model, rows = []) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r)) continue;
    const i = model.index.get(r[0]), j = model.index.get(r[1]);
    if (i == null || j == null || i === j) continue;
    out.push([i, j, Number(r[2]) || 0]);
  }
  return out;
}
