import { tokensOf, cut, shingles, overlapRatio } from './text.js';
import { embedQuery, nearest, rerank, dequantise, EMBED_MODEL } from './vectors.js';
import { expandAbbrev } from '../map/vocab.js';
import { searchTopics } from '../map/resolve.js';

// The final score blends the cross-encoder with the fused rank score: 0.4 / 0.6 had the best recall@10 and MRR on
// the evaluation set (tests/worker/fixtures/library-eval.json; 1.0 alone was worse than either signal blended).
export const RERANK_W = 0.4;
export const RRF_K = 60, RERANK_N = 40, FTS_N = 40, LINK_N = 60, DEFAULT_K = 10, MAX_K = 50;
export const COVER_MIN = 0.3;                // reranked score a passage needs to count as "about" the topic
export const SHOW_MIN = 0.35;                // link confidence counted as "in your library" before coverage is built
export const DUP_MIN = 0.6;                  // shared 5-gram share for two passages to be one note copied
export const TEXT_OUT = 700;                 // characters of a passage a search answers with
const STOP = new Set('a an the of in on at to for and or with by is are was be what which how why when who whom does do did vs versus it its as from into than that this these those about'.split(' '));
export const SHORTHAND = {
  treatment: ['tx', 'treat', 'therapy', 'management'], treat: ['tx', 'treatment'], therapy: ['tx', 'treatment'], management: ['mx', 'tx', 'treatment', 'manage'],
  manage: ['management', 'tx'], diagnosis: ['dx', 'diagnose'], diagnose: ['dx', 'diagnosis'], symptoms: ['sx', 'symptom'], symptom: ['sx'],
  history: ['hx'], prophylaxis: ['ppx', 'prevent', 'prevention'], prevention: ['ppx', 'prophylaxis', 'prevent'], fracture: ['fx'], biopsy: ['bx'],
  patient: ['pt'], cause: ['causes', 'etiology'], causes: ['cause', 'etiology'], mechanism: ['moa'], moa: ['mechanism'],
  tx: ['treatment'], dx: ['diagnosis'], sx: ['symptoms'], hx: ['history'], ppx: ['prophylaxis'], mx: ['management'],
  'first-line': ['first', 'line'], drug: ['drugs', 'medication', 'agent'], test: ['tests', 'testing', 'screen', 'workup'],
  stone: ['stones', 'calculi', 'nephrolithiasis'], stones: ['stone', 'calculi', 'nephrolithiasis'],
};

const noTable = e => /no such table|no such column|no such module/i.test(String(e && e.message));
export const normKey = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const wordsOf = s => (String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []);

// ------------------------------------------------------------------ FTS expressions (pure)

const q = w => `"${w.replace(/"/g, '')}"`;
const group = w => {
  const syn = SHORTHAND[w] || [];
  return syn.length ? `(${[w, ...syn].map(q).join(' OR ')})` : q(w);
};
/** The content words of a text (stopwords out, at most 10). */
export const contentWords = text => wordsOf(text).filter(w => !STOP.has(w) && (w.length > 1 || /\d/.test(w))).slice(0, 10);

/** FTS5 MATCH expressions: {all, phrase, any} for a text (null when it has no words). */
export function ftsExpr(text) {
  const w = contentWords(text);
  if (!w.length) return null;
  return {
    all: w.map(group).join(' AND '),
    phrase: w.length >= 2 ? q(w.join(' ')) : null,
    any: w.length >= 2 ? w.map(group).join(' OR ') : null,
  };
}

// ------------------------------------------------------------------ fusion (pure)

/**
 * Reciprocal rank fusion. lists: [{name, w, ids: [pid best first]}]. boost: Map(pid -> 0..1) added as
 * boostW * value. Returns [{pid, score, via: [names]}] best first.
 */
export function fuse(lists, { k = RRF_K, boost = null, boostW = 0.006 } = {}) {
  const by = new Map();
  for (const l of lists) {
    const seen = new Set();
    l.ids.forEach((pid, rank) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      const e = by.get(pid) || { pid, score: 0, via: [] };
      e.score += (l.w ?? 1) / (k + rank + 1);
      if (!e.via.includes(l.name)) e.via.push(l.name);
      by.set(pid, e);
    });
  }
  if (boost) for (const [pid, v] of boost) { const e = by.get(pid); if (e) e.score += boostW * v; }
  return [...by.values()].sort((a, b) => b.score - a.score || a.pid - b.pid);
}

/** Folds near-duplicate passages (shared 5-grams >= DUP_MIN) into the first, best one: also_in on it. */
export function foldDuplicates(rows, min = DUP_MIN) {
  const out = [];
  for (const r of rows) {
    const sh = r._sh || (r._sh = shingles(r.text));
    const dup = out.find(o => overlapRatio(o._sh, sh) >= min);
    if (dup) { (dup.also_in || (dup.also_in = [])).push({ doc_id: r.doc_id, title: r.title, page: r.page, id: r.pid, _text: r.text }); continue; }
    out.push(r);
  }
  return out;
}

export const citeOf = r => `${r.title}, ${r.page_to && r.page_to !== r.page ? `pp. ${r.page}–${r.page_to}` : `p. ${r.page}`}${r.heading ? ` — ${cut(r.heading.split(' › ').slice(-2).join(' › '), 90)}` : ''}`;

// ------------------------------------------------------------------ vocabulary

/**
 * What the query or topic means in the hub's own words: {topic, phrases: [{text, w, why}], rerankQuery, topicVec}.
 * One D1 batch for the topic, one for the library's terms.
 */
// Vocabularies are kept per isolate for VOCAB_TTL (keyed on the database binding, so one test's never serves another's):
// a repeated search or a topic's second look costs no vocabulary reads.
const VOCAB = new WeakMap();
export const VOCAB_TTL = 5 * 60_000;
export async function vocabulary(env, user, opts = {}) {
  const db = env && env.DB;
  if (!db || typeof db !== 'object') return vocabularyRead(env, user, opts);
  if (!VOCAB.has(db)) VOCAB.set(db, new Map());
  const cache = VOCAB.get(db);
  const key = `${user}|${opts.q || ''}|${opts.topicId || ''}|${opts.expand !== false}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < VOCAB_TTL) return hit.v;
  const v = await vocabularyRead(env, user, opts);
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), v });
  return v;
}

async function vocabularyRead(env, user, { q: text = null, topicId = null, expand = true } = {}) {
  const phrases = [];
  const add = (t, w, why) => {
    const s = String(t || '').trim();
    if (!s || s.length > 80 || phrases.some(p => normKey(p.text) === normKey(s))) return;
    phrases.push({ text: s, w, why });
  };
  let topic = null, topicVec = null, lookAlikes = [];
  if (text) add(text, 1, 'query');
  if (!expand) return { topic: null, phrases, rerankQuery: String(text || '').slice(0, 300), topicVec: null };
  // A query that names a map topic ("SAAG", "uric acid stones") brings that topic's vocabulary too.
  let resolved = false;
  if (!topicId && text) {
    try {
      const hits = await searchTopics(env, user, { q: text, limit: 3 });
      if (hits.length && hits[0].score >= 0.85 && !(hits[1] && hits[1].score >= hits[0].score)) { topicId = hits[0].id; resolved = true; }
    } catch (e) { if (!noTable(e)) throw e; }
  }
  if (topicId) {
    const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
    try {
      const [t, al, la, ev] = await env.DB.batch([
        P(`SELECT t.id, t.name, t.short_name, t.category_id, c.name AS category, u.name AS unit FROM topics t LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
           LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id WHERE t.user_id = ?1 AND t.id = ?2`, user, topicId),
        P(`SELECT alias, kind FROM topic_aliases WHERE user_id = ?1 AND topic_id = ?2 AND status = 'active' AND length(alias) <= 60
             AND kind IN ('name','abbrev','british','synonym','amboss_title','nbme_term','merge','typo')
           ORDER BY CASE kind WHEN 'name' THEN 0 WHEN 'abbrev' THEN 1 WHEN 'synonym' THEN 2 WHEN 'british' THEN 3 WHEN 'amboss_title' THEN 4 ELSE 5 END, length(alias) LIMIT 14`, user, topicId),
        P(`SELECT o.name FROM links k JOIN topics o ON o.user_id = k.user_id AND o.id = CASE WHEN k.from_id = ?2 THEN k.to_id ELSE k.from_id END
           WHERE k.user_id = ?1 AND k.type = 'versus' AND k.status IN ('active','proposed') AND (k.from_id = ?2 OR k.to_id = ?2) ORDER BY k.confusion DESC, k.strength DESC LIMIT 3`, user, topicId),
        P(`SELECT vec, scale, model FROM topic_embeddings WHERE user_id = ?1 AND topic_id = ?2`, user, topicId),
      ]);
      topic = (t.results || [])[0] || null;
      if (topic) {
        add(topic.name, 1, 'topic');
        if (topic.short_name) add(topic.short_name, 0.9, 'abbreviation');
        for (const a of al.results || []) add(a.alias, a.kind === 'abbrev' ? 0.9 : a.kind === 'name' || a.kind === 'synonym' || a.kind === 'british' ? 0.85 : 0.6, a.kind === 'abbrev' ? 'abbreviation' : 'alias');
        lookAlikes = (la.results || []).map(r => r.name);
        const e = (ev.results || [])[0];
        if (e && e.model === EMBED_MODEL) topicVec = dequantise(e.vec, e.scale);
        if (resolved) topic.resolved = true;
      }
    } catch (e) { if (!noTable(e)) throw e; }
  }
  // Abbreviations both ways: vocab.js's list and the library's own definitions.
  const base = phrases.slice(0, 6);
  const abbrKeys = new Set(), longs = new Set();
  for (const p of base) {
    for (const w of String(p.text).split(/[\s/,]+/)) {
      if (/^[A-Za-z][A-Za-z0-9]{1,7}$/.test(w) && (w.length <= 6)) {
        abbrKeys.add(w.toLowerCase());
        const long = expandAbbrev(w, topic && topic.category_id);
        if (long && (w === w.toUpperCase() || p.why === 'abbreviation')) add(long, 0.85, 'abbreviation');
      }
    }
    longs.add(normKey(p.text));
  }
  try {
    const rows = (await env.DB.prepare(`SELECT abbr, long, n FROM library_terms WHERE user_id = ?1 AND (abbr_key IN (SELECT value FROM json_each(?2))
        OR lower(long) IN (SELECT value FROM json_each(?3))) ORDER BY n DESC LIMIT 12`).bind(user, JSON.stringify([...abbrKeys]), JSON.stringify([...longs])).all()).results || [];
    for (const r of rows) {
      // An abbreviation in the query brings its long form; a long form brings the abbreviation (only an
      // abbreviation the text defines at least twice, or the only one, so "MS" never drags in every meaning).
      if (abbrKeys.has(r.abbr.toLowerCase()) && (r.n >= 2 || rows.filter(x => x.abbr.toLowerCase() === r.abbr.toLowerCase()).length === 1)) add(r.long, 0.8, 'defined in your notes');
      if (longs.has(normKey(r.long))) add(r.abbr, 0.7, 'defined in your notes');
    }
  } catch (e) { if (!noTable(e)) throw e; }
  // An abbreviation written in capitals inside a longer query ("SAAG gradient") brings the topics it is an alias of.
  const caps = text ? [...new Set((String(text).match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).map(w => w.toLowerCase()))] : [];
  if (caps.length && !(topic && topic.resolved && phrases.length > 1 && String(text).trim().split(/\s+/).length === 1)) {
    try {
      const rows = (await env.DB.prepare(`SELECT DISTINCT t.name FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ('proposed','confirmed')
          WHERE a.user_id = ?1 AND a.status = 'active' AND a.alias_key IN (SELECT value FROM json_each(?2)) AND (a.kind = 'abbrev' OR length(a.alias) <= 6) LIMIT 6`)
        .bind(user, JSON.stringify(caps)).all()).results || [];
      for (const r of rows) add(r.name, 0.8, 'abbreviation');
    } catch (e) { if (!noTable(e)) throw e; }
  }
  for (const l of lookAlikes) phrases.push({ text: l, w: 0.35, why: 'look-alike', pair: true });
  if (topic && topic.unit) phrases.push({ text: topic.unit, w: 0.2, why: 'unit', broad: true });
  const names = phrases.filter(p => !p.pair && !p.broad).map(p => p.text);
  const base0 = text || (topic && topic.name) || names[0] || '';
  const longForm = phrases.find(p => p.why === 'abbreviation' || p.why === 'defined in your notes');
  const isAbbr = /^[A-Za-z][A-Za-z0-9]{1,7}$/.test(base0.trim()) && base0.trim() === base0.trim().toUpperCase();
  const rerankQuery = isAbbr && longForm && !/^[A-Z0-9]+$/.test(longForm.text) ? `${base0} (${longForm.text})` : base0;
  return { topic, phrases: phrases.slice(0, 18), rerankQuery: rerankQuery.slice(0, 300), topicVec };
}

// ------------------------------------------------------------------ the search

export const MENTION_N = 300;
const AMBIGUOUS = new Set(['all', 'cap', 'ten', 'men', 'hit', 'as', 'ms', 'or', 'pe', 'ra', 'ar', 'md', 'mg', 'ad', 'am', 'pd', 'it', 'ca', 'pa', 'gi']);
/**
 * The FTS expression for "names the topic" (its name, aliases of 4+ letters, abbreviations) and a check that a
 * passage really does (an abbreviation must appear in capitals): {expr, check} or null.
 */
export function mentionPlan(vocab) {
  const names = vocab.phrases.filter(p => p.why === 'topic' || p.why === 'alias' || p.why === 'abbreviation' || p.why === 'defined in your notes' || p.why === 'query');
  const exact = [], loose = [];
  for (const p of names) {
    const t = String(p.text).trim();
    if (/^[A-Za-z][A-Za-z0-9]{1,5}$/.test(t) && t === t.toUpperCase()) { if (!AMBIGUOUS.has(t.toLowerCase()) && t.length >= 3) exact.push(t); continue; }
    if (wordsOf(t).length && t.length >= 4) loose.push(t);
  }
  const parts = [...loose, ...exact].map(t => contentWords(t)).filter(w => w.length).map(w => q(w.join(' ')));
  if (!parts.length) return null;
  const looseKeys = loose.map(normKey).filter(Boolean);
  const exactRe = exact.map(a => new RegExp(`(^|[^A-Za-z0-9])${a}([^A-Za-z0-9]|$)`));
  return {
    expr: [...new Set(parts)].slice(0, 12).join(' OR '),
    check: s => { const k = ` ${normKey(s)} `; return looseKeys.some(l => k.includes(` ${l} `)) || exactRe.some(re => re.test(s)); },
  };
}

const FTS_SQL = `SELECT f.rowid AS pid FROM library_fts f JOIN library_passages p ON p.pid = f.rowid
  WHERE library_fts MATCH ?2 AND p.user_id = ?1 ORDER BY bm25(library_fts, 2.0, 1.0) LIMIT ?3`;

/** The FTS sub-queries for a vocabulary: [{name, w, expr}]. */
export function ftsPlan(vocab) {
  const plan = [];
  const main = vocab.phrases.find(p => p.why === 'query' || p.why === 'topic');
  vocab.phrases.forEach((p, i) => {
    const e = ftsExpr(p.text);
    if (!e) return;
    if (p.pair) {
      // Passages that set the look-alike against this topic.
      const m = main && ftsExpr(main.text);
      if (m) plan.push({ name: `versus:${i}`, w: p.w, expr: `(${m.all}) AND (${e.all})` });
      return;
    }
    if (p.broad) { plan.push({ name: `unit`, w: p.w, expr: e.all }); return; }
    plan.push({ name: `all:${i}`, w: p.w, expr: e.all });
    if (e.phrase) plan.push({ name: `phrase:${i}`, w: p.w * 1.15, expr: e.phrase });
    if (e.any && (p.why === 'query' || p.why === 'topic')) plan.push({ name: `any:${i}`, w: 0.45, expr: e.any });
  });
  return plan.slice(0, 24);
}

/**
 * Hybrid search. opts: {q?, topicId?, k = 10, rerank = true, threshold?: number, full?: bool, ai?, now?}.
 * Returns {q, topic, expanded: [{text, why}], results: [...], n_candidates, vectors: 'vectorize'|'d1'|'off', ms: {...}}.
 * A result: {id, doc_id, title, page, page_to, heading, kind, cite, text, char_start, char_end, score, rerank?, via, also_in?}.
 */
export async function searchLibrary(env, user, opts = {}) {
  const t0 = Date.now();
  const ms = {};
  const k = Math.max(1, Math.min(MAX_K, Number(opts.k) || DEFAULT_K));
  const text = opts.q ? String(opts.q).trim().slice(0, 200) : null;
  const topicId = opts.topicId || null;
  const ai = opts.ai === undefined ? env.AI : opts.ai;
  if (!text && !topicId) return { q: null, results: [], expanded: [], ms: { total: 0 } };
  const vocab = await vocabulary(env, user, { q: text, topicId, expand: opts.expand !== false });
  ms.vocab = Date.now() - t0;
  const plan = ftsPlan(vocab);
  const wantAll = Number.isFinite(opts.threshold);
  const mention = wantAll ? mentionPlan(vocab) : null;
  if (mention) plan.push({ name: 'mention', w: 0.5, expr: mention.expr, limit: MENTION_N });
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const t1 = Date.now();
  const ftsP = (async () => {
    const stmts = plan.map(p => P(FTS_SQL, user, p.expr, p.limit || FTS_N));
    if (topicId) stmts.push(P(`SELECT pid, score FROM library_links WHERE user_id = ?1 AND topic_id = ?2 ORDER BY score DESC LIMIT ?3`, user, topicId, LINK_N));
    if (!stmts.length) return [];
    try { return await env.DB.batch(stmts); } catch (e) { if (noTable(e)) return []; throw e; }
  })().finally(() => { ms.fts = Date.now() - t1; });
  const vecP = (async () => {
    const out = [];
    try {
      if (text && ai) {
        const te = Date.now();
        const v = await embedQuery(ai, vocab.rerankQuery || text);
        ms.embed = Date.now() - te;
        const tv = Date.now();
        const r = await nearest(env, user, v, 50);
        ms.vec = Date.now() - tv;
        out.push({ name: 'vector', w: 1, ids: r.map(x => x.pid), via: r.via });
      }
      if (vocab.topicVec) {
        const tv = Date.now();
        const r = await nearest(env, user, vocab.topicVec, 50);
        ms.vec_topic = Date.now() - tv;
        out.push({ name: 'topic-vector', w: 0.9, ids: r.map(x => x.pid), via: r.via });
      }
    } catch (e) {
      if (!noTable(e)) console.error('library: vector search failed', e && e.message);
    }
    return out;
  })();
  const [ftsRes, vecLists] = await Promise.all([ftsP, vecP]);
  const lists = [];
  plan.forEach((p, i) => { const rows = ftsRes[i] && ftsRes[i].results; if (rows && rows.length) lists.push({ name: p.name, w: p.w, ids: rows.map(r => r.pid) }); });
  const links = topicId && ftsRes[plan.length] ? ftsRes[plan.length].results || [] : [];
  const boost = new Map(links.map(l => [l.pid, l.score]));
  if (links.length) lists.push({ name: 'linked', w: 0.8, ids: links.map(l => l.pid) });
  lists.push(...vecLists);
  const mentionIds = new Set((lists.find(l => l.name === 'mention') || { ids: [] }).ids);
  const fused = fuse(lists.filter(l => l.name !== 'mention' || !wantAll).concat(wantAll ? [{ name: 'mention', w: 0.15, ids: [...mentionIds] }] : []), { boost });
  ms.fuse = Date.now() - t0;
  const take = wantAll ? fused.filter((f, i) => i < 80 || mentionIds.has(f.pid)).slice(0, 80 + MENTION_N) : fused.slice(0, Math.max(RERANK_N, k));
  let rows = [];
  if (take.length) {
    const tr = Date.now();
    rows = (await P(`SELECT p.pid, p.doc_id, d.title, p.page, p.page_to, p.heading, p.kind, p.text, p.char_start, p.char_end, p.tokens
        FROM library_passages p JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
        WHERE p.user_id = ?1 AND p.pid IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(take.map(f => f.pid))).all()).results || [];
    ms.rows = Date.now() - tr;
  }
  const byPid = new Map(rows.map(r => [r.pid, r]));
  let ranked = take.map(f => ({ ...byPid.get(f.pid), fused: f.score, via: f.via })).filter(r => r.text != null);
  const top = ranked.length ? ranked[0].fused : 1;
  let reranked = false;
  if (opts.rerank !== false && ai && ranked.length > 1) {
    const tr = Date.now();
    const head = ranked.slice(0, wantAll ? 80 : RERANK_N);
    const scores = await rerank(ai, vocab.rerankQuery || text, head.map(r => `${r.heading ? `${r.heading}\n` : ''}${r.text}`));
    ms.rerank = Date.now() - tr;
    if (scores) {
      reranked = true;
      head.forEach((r, i) => { r.rerank = Math.round(scores[i] * 1000) / 1000; });
      ranked = [...head, ...ranked.slice(head.length)];
    }
  }
  for (const r of ranked) {
    const f = r.fused / top;
    r.score = Math.round((reranked && r.rerank != null ? RERANK_W * r.rerank + (1 - RERANK_W) * f : f) * 1000) / 1000;
  }
  ranked.sort((a, b) => b.score - a.score || a.pid - b.pid);
  if (wantAll) {
    const names = mention ? mention.check : () => false;
    ranked = ranked.filter(r => (reranked ? r.rerank != null && r.rerank >= opts.threshold : r.score >= opts.threshold) || (boost.get(r.pid) || 0) >= 0.8
      || (mentionIds.has(r.pid) && names(`${r.heading || ''}\n${r.text}`)));
    // A passage kept for naming the topic scores at least SHOW_MIN, so it counts wherever coverage is counted.
    for (const r of ranked) if (r.score < SHOW_MIN && mentionIds.has(r.pid)) r.score = SHOW_MIN;
  }
  const folded = foldDuplicates(ranked);
  const results = (wantAll ? folded : folded.slice(0, k)).map(r => shapeResult(r, { full: opts.full }));
  ms.total = Date.now() - t0;
  const via = vecLists.find(l => l.via) ? vecLists.find(l => l.via).via : 'off';
  return {
    q: text, topic: vocab.topic ? { id: vocab.topic.id, name: vocab.topic.name } : null,
    expanded: vocab.phrases.map(p => ({ text: p.text, why: p.why })), rerank_query: vocab.rerankQuery,
    results, n_candidates: fused.length, reranked, vectors: via, ms,
  };
}

export function shapeResult(r, { full = false, max = TEXT_OUT } = {}) {
  return {
    id: r.pid, doc_id: r.doc_id, title: r.title, page: r.page, page_to: r.page_to, heading: r.heading || null, kind: r.kind, cite: citeOf(r),
    text: full ? r.text : cut(r.text, max), char_start: r.char_start, char_end: r.char_end, score: r.score,
    ...(r.rerank != null ? { rerank: r.rerank } : {}), via: r.via, ...(r.also_in ? { also_in: alsoIn(r.also_in, full) } : {}),
  };
}
const alsoIn = (list, full) => list.slice(0, full ? 30 : 8).map(({ _text, ...a }) => (full ? { ...a, text: _text } : a));

// ------------------------------------------------------------------ topic coverage

export async function buildCoverage(env, user, topicId, { now = Date.now(), ai } = {}) {
  const t0 = Date.now();
  const r = await searchLibrary(env, user, { topicId, threshold: COVER_MIN, k: MAX_K, full: false, ai });
  if (!r.topic) return { n: 0, built: false };
  const keep = [];
  for (const x of r.results) {
    keep.push({ pid: x.id, s: x.score });
    for (const a of x.also_in || []) keep.push({ pid: a.id, s: Math.max(0, x.score - 0.01) });
  }
  const libAt = await libraryStamp(env, user);
  const stmts = [
    env.DB.prepare(`DELETE FROM library_links WHERE user_id = ?1 AND topic_id = ?2 AND method = 'search'`).bind(user, topicId),
  ];
  if (keep.length) {
    stmts.push(env.DB.prepare(`INSERT INTO library_links (user_id, topic_id, pid, score, method, updated_at)
      SELECT ?1, ?2, json_extract(j.value, '$.pid'), json_extract(j.value, '$.s'), 'search', ?3 FROM json_each(?4) j WHERE true
      ON CONFLICT (user_id, topic_id, pid) DO UPDATE SET score = excluded.score, method = 'search', updated_at = excluded.updated_at`)
      .bind(user, topicId, now, JSON.stringify(keep)));
  }
  stmts.push(env.DB.prepare(`INSERT INTO library_coverage (user_id, topic_id, n, lib_at, built_at, ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (user_id, topic_id) DO UPDATE SET n = excluded.n, lib_at = excluded.lib_at, built_at = excluded.built_at, ms = excluded.ms`)
    .bind(user, topicId, keep.length, libAt, now, Date.now() - t0));
  await env.DB.batch(stmts);
  return { n: keep.length, built: true, reranked: r.reranked, ms: Date.now() - t0 };
}

/** The library's state stamp: the newest indexing or embedding change (coverage older than it is rebuilt). */
export async function libraryStamp(env, user) {
  const r = await env.DB.prepare(`SELECT coalesce(max(CASE WHEN status = 'ready' THEN indexed_at END), 0) AS at, sum(status = 'ready') AS ready, count(*) AS n FROM library_docs WHERE user_id = ?1`).bind(user).first();
  return (Number(r && r.at) || 0) + (Number(r && r.n) || 0);
}

/**
 * A topic's coverage for the page and for Claude: {topic_id, n, docs: [{doc_id, title, pages: [{page, passages: [...]}]}],
 * stale, built_at}. Rebuilt first when the library changed since (unless build: false).
 */
export async function topicCoverage(env, user, topicId, { build = true, force = false, limit = 200, textMax = 400, ai } = {}) {
  let cov = null;
  try { cov = await env.DB.prepare(`SELECT n, lib_at, built_at FROM library_coverage WHERE user_id = ?1 AND topic_id = ?2`).bind(user, topicId).first(); } catch (e) { if (noTable(e)) return { topic_id: topicId, n: 0, docs: [], off: true }; throw e; }
  const stamp = await libraryStamp(env, user);
  let stale = force || !cov || cov.lib_at !== stamp;
  if (stale && build) { await buildCoverage(env, user, topicId, { ai }); stale = false; cov = { built_at: Date.now() }; }
  const rows = (await env.DB.prepare(`SELECT l.pid, l.score, l.method, p.doc_id, d.title, p.page, p.page_to, p.heading, p.kind, p.text, p.char_start, p.char_end
      FROM library_links l JOIN library_passages p ON p.user_id = l.user_id AND p.pid = l.pid JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
      WHERE l.user_id = ?1 AND l.topic_id = ?2 AND (l.method = 'search' OR l.score >= ?3) ORDER BY l.score DESC LIMIT ?4`).bind(user, topicId, SHOW_MIN, limit).all()).results || [];
  const folded = foldDuplicates(rows);
  const docs = new Map();
  for (const r of folded) {
    if (!docs.has(r.doc_id)) docs.set(r.doc_id, { doc_id: r.doc_id, title: r.title, best: r.score, pages: new Map() });
    const d = docs.get(r.doc_id);
    if (!d.pages.has(r.page)) d.pages.set(r.page, []);
    d.pages.get(r.page).push({ id: r.pid, heading: r.heading, kind: r.kind, cite: citeOf(r), text: cut(r.text, textMax), score: Math.round(r.score * 1000) / 1000,
      char_start: r.char_start, char_end: r.char_end, page_to: r.page_to, method: r.method, ...(r.also_in ? { also_in: alsoIn(r.also_in, textMax > 1000) } : {}) });
  }
  return {
    topic_id: topicId, n: folded.length, n_passages: rows.length, stale, built_at: cov && cov.built_at || null,
    docs: [...docs.values()].sort((a, b) => b.best - a.best).map(d => ({ doc_id: d.doc_id, title: d.title, best: d.best,
      pages: [...d.pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, passages]) => ({ page, passages })) })),
  };
}

/** How many library passages are about a topic (one indexed query): {n, docs}. Fails soft to null before 0018. */
export async function topicCount(env, user, topicId) {
  try {
    const r = await env.DB.prepare(`SELECT count(*) AS n, count(DISTINCT p.doc_id) AS docs FROM library_links l JOIN library_passages p ON p.user_id = l.user_id AND p.pid = l.pid
      WHERE l.user_id = ?1 AND l.topic_id = ?2 AND (l.method = 'search' OR l.score >= ?3)`).bind(user, topicId, SHOW_MIN).first();
    return { n: Number(r && r.n) || 0, docs: Number(r && r.docs) || 0 };
  } catch (e) { if (noTable(e)) return null; throw e; }
}

// ------------------------------------------------------------------ the teach brief's part

export const BRIEF_TOKENS = 1200;

/**
 * The teach brief's `library`: the best 3-5 passages on the topic within BRIEF_TOKENS (citations included),
 * distinct notes only. {status: 'ok'|'empty'|'off', n, passages: [{cite, doc_id, page, heading, text}], more}.
 * Uses the cached coverage when it is fresh; otherwise searches within the time left (no rebuild past it).
 */
export const SHORTLIST = 8, FULL = 2, FULL_CHARS = 1100, LINE_CHARS = 150;

export async function collectionsOf(env, user, docIds) {
  const ids = [...new Set(docIds)];
  const out = new Map();
  if (!ids.length) return out;
  const rows = (await env.DB.prepare(`SELECT id, collection FROM library_docs WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(ids)).all()).results || [];
  for (const r of rows) out.set(r.id, r.collection || null);
  return out;
}

export const PER_DOC = 2;
export function spreadAcrossBooks(list, collOf) {
  const sorted = list.slice().sort((a, b) => b.score - a.score);
  const firsts = [], seen = new Set();
  for (const x of sorted) { const c = collOf(x) || x.doc_id; if (!seen.has(c)) { seen.add(c); firsts.push(x); } }
  firsts.sort((a, b) => (collOf(b) === 'mehlman') - (collOf(a) === 'mehlman') || b.score - a.score);
  const perDoc = new Map(), out = [];
  const take = x => { perDoc.set(x.doc_id, (perDoc.get(x.doc_id) || 0) + 1); out.push(x); };
  for (const x of firsts) take(x);
  for (const x of sorted) if (!out.includes(x) && (perDoc.get(x.doc_id) || 0) < PER_DOC) take(x);
  // With one book only (or the others used up), the rest still follow by score: the cap is about variety, not a limit.
  for (const x of sorted) if (!out.includes(x)) out.push(x);
  return out;
}
export const BRIEF_USE = 'A shortlist from all of Mo\'s books: two passages in full (Mehlman\'s first) and candidates with their opening line. Choose what will help Mo most for this lesson, wherever it is, and always use Mehlman; read any candidate in full with map_topic {include: ["library"]} (same passages, same order). Name the book you teach from (Mehlman, First Aid, UWorld, Divine Intervention). If any two sources disagree (a number, a cut-off, a first-line drug or test), say so at the very start of the lesson, naming both sources and pages, then teach the US-guideline answer.';

export async function libraryBrief(env, user, topicId, { budget = BRIEF_TOKENS, max = 5, ai, build = true } = {}) {
  const t0 = Date.now();
  let cov;
  try {
    const has = await env.DB.prepare(`SELECT count(*) AS n FROM library_docs WHERE user_id = ?1 AND status IN ('indexing', 'ready')`).bind(user).first();
    if (!has || !has.n) return { status: 'off', n: 0, passages: [] };
    cov = await topicCoverage(env, user, topicId, { build, limit: 40, textMax: 2000, ai });
  } catch (e) { if (noTable(e)) return { status: 'off', n: 0, passages: [] }; throw e; }
  if (cov.off) return { status: 'off', n: 0, passages: [] };
  const flat = [];
  for (const d of cov.docs) for (const p of d.pages) for (const x of p.passages) flat.push({ ...x, doc_id: d.doc_id, title: d.title, page: p.page });
  const coll = await collectionsOf(env, user, flat.map(x => x.doc_id));
  flat.splice(0, flat.length, ...spreadAcrossBooks(flat, x => coll.get(x.doc_id)));
  const out = [], candidates = [];
  const size = () => tokensOf(JSON.stringify(out)) + tokensOf(JSON.stringify(candidates));
  for (const x of flat.slice(0, SHORTLIST)) {
    const base = { cite: x.cite, source: coll.get(x.doc_id) || null, passage_id: x.id };
    if (out.length < FULL) {
      const item = { ...base, doc_id: x.doc_id, page: x.page, ...(x.page_to && x.page_to !== x.page ? { page_to: x.page_to } : {}), heading: x.heading ? cut(x.heading, 120) : null,
        text: cut(x.text, FULL_CHARS) };
      if (size() + tokensOf(JSON.stringify(item)) > budget) break;
      out.push(item);
    } else {
      const c = { ...base, line: cut(x.text, LINE_CHARS) };
      if (size() + tokensOf(JSON.stringify(c)) > budget) break;
      candidates.push(c);
    }
  }
  return { status: out.length ? 'ok' : 'empty', n: cov.n, passages: out, ...(candidates.length ? { candidates } : {}),
    more: Math.max(0, cov.n - out.length - candidates.length), ms: Date.now() - t0, stale: !!cov.stale, ...(out.length ? { use: BRIEF_USE } : {}) };
}
