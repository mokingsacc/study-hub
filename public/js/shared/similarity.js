
export const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
export const EMBED_DIMS = 384;
export const EMBED_BATCH = 50;          // texts per Workers AI call (the model takes up to 100)
export const NEIGHBOURS_K = 8;          // neighbours kept per topic
export const MIN_Z = 1.5;               // a neighbour stands at least 1.5 sd above the mean pair
export const TOP_Z = 4;                 // and scores 1 from 4 sd up
export const TEXT_MAX = 480;            // characters embedded per topic

/** The text a topic is embedded from: its name, its other names and its one-line statement, trimmed. */
export function embedText({ name = '', short_name = null, kind = null, unit = null, statement = null } = {}) {
  const parts = [String(name || '').trim()];
  if (short_name && String(short_name).trim() && String(short_name).trim() !== parts[0]) parts[0] += ` (${String(short_name).trim()})`;
  if (kind && kind !== 'condition') parts.push(`a ${kind}`);
  if (unit && String(unit).trim()) parts.push(`in ${String(unit).trim()}`);
  let text = parts.filter(Boolean).join(', ');
  const st = String(statement || '').replace(/\s+/g, ' ').trim();
  if (st) text += `. ${st}`;
  return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX).replace(/\s+\S*$/, '') : text;
}

/** FNV-1a 32-bit as 8 hex digits: the fingerprint of the text a vector was made from. */
export function textKey(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A unit-length copy (Float32Array) of a vector; a zero vector stays zero. */
export function normalise(vec) {
  const out = Float32Array.from(vec || [], v => (Number.isFinite(v) ? v : 0));
  let s = 0;
  for (let i = 0; i < out.length; i++) s += out[i] * out[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b == null ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c == null ? '=' : B64[c & 63]);
  }
  return out;
}
function fromB64(s) {
  const str = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => (i + k < str.length ? B64.indexOf(str[i + k]) : -1));
    out[o++] = (n[0] << 2) | (n[1] >> 4);
    if (n[2] >= 0 && o < out.length) out[o++] = ((n[1] & 15) << 4) | (n[2] >> 2);
    if (n[3] >= 0 && o < out.length) out[o++] = ((n[2] & 3) << 6) | n[3];
  }
  return out.slice(0, o);
}

/** {q, scale}: the vector as int8 in base64 (unit length first, then the largest component maps to 127). */
export function quantise(vec) {
  const v = normalise(vec);
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max > 0 ? max / 127 : 1;
  const bytes = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale))) & 255;
  return { q: toB64(bytes), scale: Math.round(scale * 1e7) / 1e7 };
}

/** The unit-length vector back from quantise() (null when the text is not a vector). */
export function dequantise(q, scale = 1) {
  const bytes = fromB64(q);
  if (!bytes.length) return null;
  const v = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) v[i] = (bytes[i] > 127 ? bytes[i] - 256 : bytes[i]) * (Number(scale) || 1);
  return normalise(v);
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** A pair's score (0..1) from its z (sd above the mean pair); 0 below MIN_Z. */
export const scoreOfZ = (z, { minZ = MIN_Z, topZ = TOP_Z } = {}) => (!(z >= minZ) ? 0 : Math.min(1, 0.15 + (0.85 * (z - minZ)) / (topZ - minZ)));

/**
 * Every topic's nearest neighbours by cosine. ids[i] with unit vectors vecs[i] (same length, nulls skipped).
 * Returns {mean, sd, lists: [[[j, s100], ...] per i]} with at most k neighbours each, best first, every score
 * at least MIN_Z sd above the mean of all pairs. Deterministic: ties go to the lower index.
 */
export function neighbourLists(vecs, { k = NEIGHBOURS_K, minZ = MIN_Z, topZ = TOP_Z } = {}) {
  const n = vecs.length;
  const cos = new Float32Array(n * n);
  let sum = 0, sq = 0, pairs = 0;
  for (let i = 0; i < n; i++) {
    if (!vecs[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!vecs[j]) continue;
      const c = dot(vecs[i], vecs[j]);
      cos[i * n + j] = c; cos[j * n + i] = c;
      sum += c; sq += c * c; pairs++;
    }
  }
  const mean = pairs ? sum / pairs : 0;
  const sd = pairs > 1 ? Math.sqrt(Math.max(1e-12, sq / pairs - mean * mean)) : 1;
  const lists = [];
  for (let i = 0; i < n; i++) {
    const best = [];
    if (vecs[i]) {
      for (let j = 0; j < n; j++) {
        if (j === i || !vecs[j]) continue;
        const z = (cos[i * n + j] - mean) / sd;
        if (z < minZ) continue;
        if (best.length < k) best.push([j, z]);
        else if (z > best[best.length - 1][1]) best[best.length - 1] = [j, z];
        else continue;
        best.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      }
    }
    lists.push(best.map(([j, z]) => [j, Math.max(1, Math.round(100 * scoreOfZ(z, { minZ, topZ })))]));
  }
  return { mean, sd, lists };
}
