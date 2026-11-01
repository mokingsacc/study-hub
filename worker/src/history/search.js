import { vocabulary, ftsPlan, fuse, contentWords } from '../library/search.js';
import { embedQuery, dequantise, unit, EMBED_MODEL, EMBED_DIMS } from '../library/vectors.js';
import { searchTopics } from '../map/resolve.js';
import { KINDS, SHOWN_KINDS, SOURCES, openAt, kindStored, kindShown } from './items.js';

export const DEFAULT_K = 10, MAX_K = 25, FTS_N = 50, VEC_N = 50, SNIPPET = 200;
// The cosine a hit found by meaning alone needs (bge-small: unrelated texts sit around 0.3 to 0.45).
export const MEANING_MIN = 0.5;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const noTable = e => /no such table|no such column|no such module/i.test(String(e && e.message));

// ------------------------------------------------------------------ filters (pure)

/** The SQL filter on history_items h (and categories c): [' AND ...', args]. topic: {id, name} or {text}. */
export function filterSql(f = {}) {
  const w = [], a = [];
  if (Array.isArray(f.kinds) && f.kinds.length) { w.push('h.kind IN (SELECT value FROM json_each(?))'); a.push(JSON.stringify(f.kinds)); }
  if (f.topic && f.topic.id) { w.push('(h.topic_id = ? OR lower(coalesce(h.topic, \'\')) = lower(?))'); a.push(f.topic.id, f.topic.name || f.topic.id); }
  else if (f.topic && f.topic.text) { w.push('instr(lower(coalesce(h.topic, \'\')), lower(?)) > 0'); a.push(f.topic.text); }
  if (f.system) { w.push(`instr(lower(coalesce(h.system, '') || '|' || coalesce(c.name, '') || '|' || coalesce(h.category_id, '')), lower(?)) > 0`); a.push(f.system); }
  if (f.source) { w.push('h.source = ?'); a.push(f.source); }
  if (f.since) { w.push('h.day >= ?'); a.push(f.since); }
  if (f.until) { w.push('h.day <= ?'); a.push(f.until); }
  return [w.length ? ` AND ${w.join(' AND ')}` : '', a];
}

// A miss or gap shows only while its row is live (a sitting's held rows, a deleted miss: never, even between sweeps).
const LIVE = `AND (h.kind != 'miss' OR EXISTS (SELECT 1 FROM misses m WHERE m.user_id = h.user_id AND m.id = h.src_id AND m.held = 0 AND m.deleted_at IS NULL))
  AND (h.kind != 'gap' OR EXISTS (SELECT 1 FROM gaps g WHERE g.user_id = h.user_id AND g.id = h.src_id AND g.held = 0))`;
const CAT_JOIN = 'LEFT JOIN categories c ON c.user_id = h.user_id AND c.id = h.category_id';
const ROW_COLS = `h.rid, h.kind, h.day, h.at, h.source, h.label, h.topic_id, coalesce(t.name, h.topic) AS topic, h.text, h.open`;
const ROWS_FROM = `FROM history_items h LEFT JOIN topics t ON t.user_id = h.user_id AND t.id = h.topic_id ${CAT_JOIN}`;

/** The text around the first word that matched, about SNIPPET characters, cut at word edges. */
export function snippet(text, terms = [], n = SNIPPET) {
  const t = String(text || '');
  if (t.length <= n) return t;
  const low = t.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const stem = term.length > 6 ? term.slice(0, 6) : term;
    const re = new RegExp(`(^|[^a-z0-9])${stem.replace(/[^a-z0-9]/g, '')}`);
    const m = re.exec(low);
    if (m && (at < 0 || m.index < at)) at = m.index + m[1].length;
  }
  let start = at < 0 ? 0 : Math.max(0, at - 60);
  if (start > 0) { const sp = t.indexOf(' ', start); start = sp >= 0 && sp < at ? sp + 1 : start; }
  let end = Math.min(t.length, start + n);
  if (end < t.length) { const sp = t.lastIndexOf(' ', end); if (sp > start + n / 2) end = sp; }
  return `${start > 0 ? '…' : ''}${t.slice(start, end).trim()}${end < t.length ? '…' : ''}`;
}

// ------------------------------------------------------------------ vectors

// Decoded once per isolate per database binding and user, again when the count or the newest write moves.
const VEC = new WeakMap();
async function vectors(env, user, head) {
  const db = env.DB;
  if (!VEC.has(db)) VEC.set(db, new Map());
  const cache = VEC.get(db);
  const key = `${head.e}:${head.m}`;
  const hit = cache.get(user);
  if (hit && hit.key === key) return hit;
  const rows = (await env.DB.prepare(`SELECT rid, vec, vec_scale FROM history_items WHERE user_id = ? AND model = ? AND vec IS NOT NULL`).bind(user, EMBED_MODEL).all()).results || [];
  const rids = new Int32Array(rows.length), mat = new Float32Array(rows.length * EMBED_DIMS);
  rows.forEach((r, i) => { rids[i] = r.rid; const v = dequantise(r.vec, r.vec_scale); if (v && v.length === EMBED_DIMS) mat.set(v, i * EMBED_DIMS); });
  const entry = { key, rids, mat };
  cache.set(user, entry);
  return entry;
}

async function nearest(env, user, head, vector, k) {
  const q = unit(vector);
  const { rids, mat } = await vectors(env, user, head);
  const n = rids.length, scores = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * EMBED_DIMS; for (let j = 0; j < EMBED_DIMS; j++) s += mat[o + j] * q[j]; scores[i] = s; }
  return Array.from({ length: n }, (_, i) => i).filter(i => scores[i] >= MEANING_MIN).sort((a, b) => scores[b] - scores[a]).slice(0, k).map(i => rids[i]);
}

// ------------------------------------------------------------------ the search

/** Checks hub_history's arguments; returns {problems} or the cleaned options. */
export function readOptions(a = {}) {
  const problems = [];
  for (const k of ['since', 'until']) if (a[k] != null && !DAY.test(String(a[k]))) problems.push(`${k} must be a day, YYYY-MM-DD.`);
  const asked = Array.isArray(a.kinds) ? a.kinds : a.kinds != null ? [a.kinds] : [];
  for (const k of asked) if (!KINDS.includes(k) && !SHOWN_KINDS.includes(k)) problems.push(`kinds: ${k} is not one of ${SHOWN_KINDS.join(', ')}.`);
  const kinds = [...new Set(asked.map(kindStored))];
  if (a.source != null && !SOURCES.includes(a.source)) problems.push(`source must be one of ${SOURCES.join(', ')}.`);
  if (problems.length) return { problems };
  return { q: String(a.query || '').trim().slice(0, 200), kinds, topic: a.topic ? String(a.topic).trim().slice(0, 120) : null, system: a.system ? String(a.system).trim().slice(0, 60) : null,
    source: a.source || null, since: a.since || null, until: a.until || null, k: Math.max(1, Math.min(MAX_K, Number(a.limit) || DEFAULT_K)) };
}

export async function searchHistory(env, user, args = {}) {
  const o = readOptions(args);
  if (o.problems) return { problems: o.problems };
  const ai = args.ai === undefined ? env.AI : args.ai;
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let topic = null;
  if (o.topic) {
    try {
      const hits = await searchTopics(env, user, { q: o.topic, limit: 3 });
      topic = hits.length && hits[0].score >= 0.85 && !(hits[1] && hits[1].score >= hits[0].score) ? { id: hits[0].id, name: hits[0].name } : { text: o.topic };
    } catch (e) { if (!noTable(e)) throw e; topic = { text: o.topic }; }
  }
  const [fw, fa] = filterSql({ ...o, topic });
  let head;
  try {
    const [h, st] = await env.DB.batch([
      P(`SELECT count(*) AS n, coalesce(sum(model = ?), 0) AS e, coalesce(max(updated_at), 0) AS m FROM history_items WHERE user_id = ?`, EMBED_MODEL, user),
      P(`SELECT cursor FROM sync_state WHERE user_id = ? AND source = 'history'`, user),
    ]);
    head = h.results[0];
    let built = false;
    try { built = !!JSON.parse((st.results[0] || {}).cursor || '{}').built; } catch { built = false; }
    head.built = built;
  } catch (e) {
    if (noTable(e)) return { query: o.q, total: 0, hits: [], index: { items: 0, building: true }, note: 'The search index arrives with the next hub update.' };
    throw e;
  }
  const index = { items: Number(head.n) || 0, with_meaning: Number(head.e) || 0, ...(head.built ? {} : { building: true }) };
  const topicOut = topic && topic.id ? { topic: { id: topic.id, name: topic.name } } : {};
  if (!o.q) {
    const rows = (await P(`SELECT ${ROW_COLS} ${ROWS_FROM} WHERE h.user_id = ?${fw} ${LIVE} ORDER BY h.at DESC, h.rid DESC LIMIT ?`, user, ...fa, o.k).all()).results || [];
    return { query: null, ...topicOut, total: rows.length, hits: rows.map(r => shape(r, [], ['filters'])), index };
  }
  const vocab = await vocabulary(env, user, { q: o.q });
  const plan = ftsPlan(vocab);
  const ftsSql = `SELECT f.rowid AS rid FROM history_fts f JOIN history_items h ON h.rid = f.rowid ${o.system ? CAT_JOIN : ''}
    WHERE history_fts MATCH ? AND h.user_id = ?${fw} ORDER BY bm25(history_fts, 1.0, 2.0, 1.0) LIMIT ${FTS_N}`;
  const ftsP = plan.length ? env.DB.batch(plan.map(p => P(ftsSql, p.expr, user, ...fa))).catch(e => { console.error('history fts', e && e.message); return []; }) : Promise.resolve([]);
  const vecP = ai && index.with_meaning ? (async () => {
    try { return await nearest(env, user, head, await embedQuery(ai, vocab.rerankQuery || o.q), VEC_N); }
    catch (e) { console.error('history vectors', e && e.message); return []; }
  })() : Promise.resolve([]);
  const [ftsR, vecIds] = await Promise.all([ftsP, vecP]);
  const lists = plan.map((p, i) => ({ name: p.name, w: p.w, ids: ((ftsR[i] && ftsR[i].results) || []).map(r => r.rid) }));
  if (vecIds.length) lists.push({ name: 'meaning', w: 1, ids: vecIds });
  const fused = fuse(lists).slice(0, 150);
  const expanded = vocab.phrases.filter(p => p.why !== 'query').map(p => p.text).slice(0, 6);
  if (!fused.length) return { query: o.q, ...topicOut, total: 0, hits: [], index, ...(expanded.length ? { expanded } : {}) };
  // The vector list ignores the filters: the row read applies them (and the live check), so a filtered-out item drops.
  const rows = (await P(`SELECT ${ROW_COLS} ${ROWS_FROM} WHERE h.user_id = ? AND h.rid IN (SELECT value FROM json_each(?))${fw} ${LIVE}`,
    user, JSON.stringify(fused.map(f => f.pid)), ...fa).all()).results || [];
  const byRid = new Map(rows.map(r => [r.rid, r]));
  const ordered = fused.filter(f => byRid.has(f.pid));
  const terms = [...new Set([o.q, ...vocab.phrases.map(p => p.text)].flatMap(t => contentWords(t)))];
  return {
    query: o.q, ...topicOut, total: ordered.length,
    hits: ordered.slice(0, o.k).map(f => shape(byRid.get(f.pid), terms, f.via)),
    index, ...(expanded.length ? { expanded } : {}),
  };
}

const shape = (r, terms, via) => ({
  kind: kindShown(r.kind), day: r.day, label: r.label, ...(r.topic ? { topic: r.topic } : {}), source: r.source, snippet: snippet(r.text, terms),
  via: [...new Set(via.map(v => (v === 'meaning' ? 'meaning' : v === 'filters' ? 'filters' : 'words')))], open: openAt(r.open, r.day),
});
