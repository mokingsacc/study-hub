// The Library's vectors. Passages are embedded with the same Workers AI bge model as the map's topics
// (similarity.js EMBED_MODEL, 384 dimensions), so a topic's stored vector searches the library with no AI call.
// Every vector is kept in D1 as int8 (library_passages.vec), and, when the Vectorize binding LIBRARY_VEC is there,
// also in the Vectorize index (namespace = the user, id 'p<pid>'), which answers the nearest passages in a few
// tens of milliseconds at any size. Without Vectorize (wrangler dev, the tests, or an index that fails) the same
// search runs on the D1 vectors in the Worker (exact cosine; fine for a few thousand passages).
import { EMBED_MODEL, EMBED_DIMS, quantise, dequantise } from '../../../public/js/shared/similarity.js';

export { EMBED_MODEL, EMBED_DIMS };
export const AI_BATCH = 100;                       // texts per Workers AI call (bge takes up to 100)
export const EMBED_CHARS = 1800;                   // characters of a passage embedded (bge reads 512 tokens)
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const RERANK_MODEL = '@cf/baai/bge-reranker-base';
export const VEC_TOPK = 50;

/** The text a passage is embedded from: its heading path and its text. */
export const passageText = p => `${p.heading ? `${p.heading}\n` : ''}${p.text}`.slice(0, EMBED_CHARS);

/** Vectors for these texts (Workers AI, AI_BATCH a call). Throws when Workers AI fails or answers short. */
export async function embedMany(ai, texts) {
  if (!ai || typeof ai.run !== 'function') throw new Error('Workers AI is not bound');
  const out = [];
  for (let k = 0; k < texts.length; k += AI_BATCH) {
    const part = texts.slice(k, k + AI_BATCH);
    const r = await ai.run(EMBED_MODEL, { text: part });
    const data = r && r.data;
    if (!Array.isArray(data) || data.length !== part.length || !data.every(v => Array.isArray(v) && v.length)) throw new Error('Workers AI returned no embeddings');
    out.push(...data);
  }
  return out;
}

// A small per-isolate cache of query vectors: the same search twice costs no second AI call.
const QUERY_CACHE = new Map();
const QUERY_CACHE_MAX = 300;
export async function embedQuery(ai, text) {
  const key = String(text).toLowerCase().trim().slice(0, 300);
  if (QUERY_CACHE.has(key)) return QUERY_CACHE.get(key);
  const [v] = await embedMany(ai, [QUERY_PREFIX + key]);
  const f = Float32Array.from(v);
  if (QUERY_CACHE.size >= QUERY_CACHE_MAX) QUERY_CACHE.delete(QUERY_CACHE.keys().next().value);
  QUERY_CACHE.set(key, f);
  return f;
}
export const _clearQueryCache = () => QUERY_CACHE.clear();

export { quantise, dequantise };

/** Cosine of two unit vectors (Float32Array or plain arrays). */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
export function unit(v) {
  const out = Float32Array.from(v);
  let s = 0;
  for (let i = 0; i < out.length; i++) s += out[i] * out[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

// ------------------------------------------------------------------ the index

// Vectorize stays off for a few minutes after it fails (a local dev binding, an index not made yet).
let vecDownUntil = 0;
export const vectorizeOn = env => !!(env && env.LIBRARY_VEC && typeof env.LIBRARY_VEC.query === 'function') && Date.now() >= vecDownUntil;
const vecDown = e => { vecDownUntil = Date.now() + 5 * 60_000; console.error('library: Vectorize unavailable, using the D1 vectors', e && e.message); };
export const _resetVectorize = () => { vecDownUntil = 0; };

/** Upserts [{pid, values}] into Vectorize for this user. Returns true when they went in. */
export async function vectorizeUpsert(env, user, rows) {
  if (!vectorizeOn(env) || !rows.length) return false;
  try {
    for (let k = 0; k < rows.length; k += 500) {
      await env.LIBRARY_VEC.upsert(rows.slice(k, k + 500).map(r => ({ id: `p${r.pid}`, values: Array.from(r.values), namespace: user, metadata: { doc: r.doc_id } })));
    }
    return true;
  } catch (e) { vecDown(e); return false; }
}

/** Deletes these passages' vectors from Vectorize (best effort). */
export async function vectorizeDelete(env, pids) {
  if (!vectorizeOn(env) || !pids.length) return false;
  try {
    for (let k = 0; k < pids.length; k += 500) await env.LIBRARY_VEC.deleteByIds(pids.slice(k, k + 500).map(p => `p${p}`));
    return true;
  } catch (e) { vecDown(e); return false; }
}

// The D1 vectors decoded once per isolate per user and library state (count and newest pid).
const D1_CACHE = new Map();
async function d1Vectors(env, user) {
  const head = await env.DB.prepare(`SELECT count(*) AS n, coalesce(max(pid), 0) AS top, coalesce(sum(pid), 0) AS s FROM library_passages WHERE user_id = ?1 AND vec_state >= 1`).bind(user).first();
  const key = `${head.n}:${head.top}:${head.s}`;
  const hit = D1_CACHE.get(user);
  if (hit && hit.key === key) return hit;
  const rows = (await env.DB.prepare(`SELECT pid, vec, vec_scale FROM library_passages WHERE user_id = ?1 AND vec_state >= 1 AND vec IS NOT NULL`).bind(user).all()).results || [];
  const pids = new Int32Array(rows.length);
  const mat = new Float32Array(rows.length * EMBED_DIMS);
  rows.forEach((r, i) => {
    pids[i] = r.pid;
    const v = dequantise(r.vec, r.vec_scale);
    mat.set(v.length === EMBED_DIMS ? v : new Float32Array(EMBED_DIMS), i * EMBED_DIMS);
  });
  const entry = { key, pids, mat };
  D1_CACHE.set(user, entry);
  return entry;
}
export const _clearD1Cache = () => D1_CACHE.clear();

/**
 * The nearest passages to a unit vector: [{pid, score}] best first, from Vectorize (namespace = user) or, without
 * it, from the D1 vectors. {via: 'vectorize'|'d1'} is set on the returned list.
 */
export async function nearest(env, user, vector, k = VEC_TOPK) {
  const q = unit(vector);
  if (vectorizeOn(env)) {
    try {
      const r = await env.LIBRARY_VEC.query(Array.from(q), { topK: Math.min(100, k), namespace: user, returnValues: false, returnMetadata: 'none' });
      const out = (r && r.matches || []).map(m => ({ pid: Number(String(m.id).slice(1)), score: m.score })).filter(m => Number.isInteger(m.pid));
      out.via = 'vectorize';
      return out;
    } catch (e) { vecDown(e); }
  }
  const { pids, mat } = await d1Vectors(env, user);
  const n = pids.length;
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * EMBED_DIMS;
    for (let j = 0; j < EMBED_DIMS; j++) s += mat[o + j] * q[j];
    scores[i] = s;
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k);
  const out = idx.map(i => ({ pid: pids[i], score: Math.round(scores[i] * 1e4) / 1e4 }));
  out.via = 'd1';
  return out;
}

/**
 * Cross-encoder scores (0..1) for these texts against the query, in the same order, from Workers AI's bge reranker;
 * null when it is not there or fails (the caller keeps the fused order).
 */
export async function rerank(ai, query, texts) {
  if (!ai || typeof ai.run !== 'function' || !texts.length) return null;
  try {
    const r = await ai.run(RERANK_MODEL, { query: String(query).slice(0, 400), contexts: texts.map(t => ({ text: String(t).slice(0, 1400) })), top_k: texts.length });
    const list = (r && (r.response || r.result || r.data)) || [];
    if (!Array.isArray(list) || !list.length) return null;
    const out = new Array(texts.length).fill(0);
    const raw = list.map(x => Number(x.score));
    const squash = raw.some(s => s > 1 || s < 0);
    list.forEach((x, i) => {
      const id = Number(x.id ?? x.index ?? i);
      if (id >= 0 && id < out.length) out[id] = squash ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
    });
    return out;
  } catch (e) {
    console.error('library: rerank failed', e && e.message);
    return null;
  }
}
