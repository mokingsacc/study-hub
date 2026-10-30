// Fakes for the Library tests: R2 (with multipart uploads and ranges), Workers AI (deterministic bag-of-words
// embeddings, a word-overlap reranker, a vision model that reads a fixed text) and Vectorize (namespaces, cosine).
// None of them calls the network.
import { EMBED_DIMS } from '../../public/js/shared/similarity.js';

export function fakeR2() {
  const objects = new Map();
  const uploads = new Map();
  let n = 0;
  const bytesOf = v => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(0));
  const obj = (key, o, range) => {
    const data = range ? o.data.subarray(range.offset, range.length != null ? range.offset + range.length : undefined) : o.data;
    return {
      key, size: o.data.length, customMetadata: o.customMetadata || {}, httpMetadata: o.httpMetadata || {},
      range: range ? { offset: range.offset, length: data.length } : undefined,
      body: new Blob([data]).stream(),
      text: async () => new TextDecoder().decode(data), arrayBuffer: async () => data.slice().buffer, json: async () => JSON.parse(new TextDecoder().decode(data)),
    };
  };
  return {
    objects, uploads,
    async put(key, value, opts = {}) { objects.set(key, { data: bytesOf(value).slice(), customMetadata: opts.customMetadata, httpMetadata: opts.httpMetadata }); return { key }; },
    async get(key, opts = {}) { const o = objects.get(key); return o ? obj(key, o, opts.range) : null; },
    async head(key) { const o = objects.get(key); return o ? { key, size: o.data.length, customMetadata: o.customMetadata || {} } : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix = '', include = [] } = {}) {
      const list = [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
        .map(k => ({ key: k, size: objects.get(k).data.length, ...(include.includes('customMetadata') ? { customMetadata: objects.get(k).customMetadata || {} } : {}) }));
      return { objects: list, truncated: false };
    },
    async createMultipartUpload(key, opts = {}) {
      const uploadId = `up${++n}`;
      uploads.set(uploadId, { key, parts: new Map(), opts });
      return this.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key, uploadId,
        async uploadPart(partNumber, data) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('no such upload');
          const etag = `e${partNumber}-${bytesOf(data).length}`;
          u.parts.set(partNumber, { data: bytesOf(data).slice(), etag });
          return { partNumber, etag };
        },
        async complete(parts) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('no such upload');
          const chunks = parts.sort((a, b) => a.partNumber - b.partNumber).map(p => {
            const got = u.parts.get(p.partNumber);
            if (!got || got.etag !== p.etag) throw new Error(`part ${p.partNumber} etag mismatch`);
            return got.data;
          });
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const all = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { all.set(c, o); o += c.length; }
          objects.set(key, { data: all, customMetadata: u.opts.customMetadata, httpMetadata: u.opts.httpMetadata });
          uploads.delete(uploadId);
          return { key };
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
  };
}

// A word's fixed pseudo-random direction (FNV hash seeded), summed over a text's words: texts sharing words point alike.
const STOP = new Set('a an the of in on at to for and or with by is are be what which how why it its as from that this'.split(' '));
function hash(s, seed) { let h = 0x811c9dc5 ^ seed; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
export function fakeVector(text, dims = EMBED_DIMS) {
  const v = new Float64Array(dims);
  const words = (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOP.has(w)).map(w => w.replace(/(es|s)$/, ''));
  for (const w of words) for (let k = 0; k < 4; k++) { const h = hash(w, k * 7919); v[h % dims] += (h & 1 ? 1 : -1); }
  v[0] += 0.5;   // every text shares a little, as real embeddings do
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Array.from(v, x => x / n);
}

export function fakeAI({ rerank = true, ocrText = 'Page transcribed by the fake vision model: hyperkalemia ECG peaked T waves.', calls = [] } = {}) {
  return {
    calls,
    async run(model, input) {
      calls.push(model);
      if (/bge-(small|base|large)/.test(model)) return { shape: [input.text.length, EMBED_DIMS], data: input.text.map(t => fakeVector(String(t).replace(/^Represent this sentence for searching relevant passages: /, ''))) };
      if (/reranker/.test(model)) {
        if (!rerank) throw new Error('reranker down');
        const q = new Set((String(input.query).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOP.has(w)));
        return { response: input.contexts.map((c, id) => {
          const w = new Set((String(c.text).toLowerCase().match(/[a-z0-9]+/g) || []));
          let hit = 0; for (const x of q) if (w.has(x)) hit++;
          return { id, score: q.size ? hit / q.size : 0 };
        }).sort((a, b) => b.score - a.score) };
      }
      if (/vision|llama-4|llava/.test(model)) return { response: ocrText };
      throw new Error(`fake AI has no ${model}`);
    },
  };
}

export function fakeVectorize() {
  const rows = new Map();
  const calls = { upsert: 0, query: 0, delete: 0 };
  return {
    rows, calls,
    async upsert(list) { calls.upsert++; for (const r of list) rows.set(r.id, { ...r }); return { count: list.length }; },
    async deleteByIds(ids) { calls.delete++; for (const id of ids) rows.delete(id); return { count: ids.length }; },
    async query(vec, { topK = 10, namespace } = {}) {
      calls.query++;
      const out = [];
      for (const r of rows.values()) {
        if (namespace !== undefined && r.namespace !== namespace) continue;
        let s = 0; for (let i = 0; i < vec.length; i++) s += vec[i] * r.values[i];
        out.push({ id: r.id, score: s });
      }
      return { matches: out.sort((a, b) => b.score - a.score).slice(0, topK), count: Math.min(topK, out.length) };
    },
  };
}

/** A page in the extractor's shape from lines of text: headings as {h: 'text'} (bold, centred). */
export function page(n, items, { size = 10, x = 90 } = {}) {
  let y = 60;
  const lines = [];
  for (const it of items) {
    if (typeof it === 'string') {
      const bullet = /^- /.test(it);
      if (bullet) { lines.push({ t: '-', s: size, b: 0, x, y }); lines.push({ t: it.slice(2), s: size, b: 0, x: x + 18, y }); }
      else lines.push({ t: it, s: size, b: 0, x, y });
    } else if (it.h) lines.push({ t: it.h, s: size, b: 1, x: 250, y });
    else if (it.row) it.row.forEach((c, i) => lines.push({ t: c, s: size, b: 0, x: x + i * 120, y }));
    y += 14;
  }
  lines.push({ t: 'MEHLMANMEDICAL.COM', s: 12, b: 0, x: 300, y: 20 }, { t: String(n), s: 12, b: 0, x: 500, y: 780 });
  return { n, w: 612, h: 792, images: 0, lines };
}
