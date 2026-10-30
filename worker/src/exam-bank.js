import { HttpError, readJson, json, str } from './util.js';
import { assertUnderCap } from './db.js';
import { callJson } from './claude.js';
import { vocabulary, ftsPlan, fuse } from './library/search.js';
import { embedMany, embedQuery, quantise, dequantise, unit as unitVec, rerank, EMBED_DIMS } from './library/vectors.js';

export const COLL_WORD = { nbme: 'NBME', cms: 'CMS' };
export const COLL_LONG = { nbme: 'Original Forms (NBME + Free 120)', cms: 'CMS Forms' };
export const ANSWER_FILTERS = ['has', 'none', 'conflict'];
const MAX_K = 50, FTS_N = 60, VEC_N = 60, EMBED_PER_RUN = 300, RERANK_N = 40, RERANK_W = 0.5;
const noTable = e => /no such table|no such column|no such module/i.test(String(e && e.message));
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// The ranks live in exam-ranks.js (no imports), so the map's modules can show them without loading the search.
export { examRanks, examRankText, rankJoin, RANK_COLS } from './exam-ranks.js';
import { examRanks, examRankText } from './exam-ranks.js';

// ------------------------------------------------------------------ shaping

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** The answer in words: the key, or why there is none. */
export function answerWords(r) {
  if (r.ans_status === 'conflict') {
    const claims = parse(r.claims_json, []).map(c => (c.letters || []).join('')).filter(Boolean);
    return `Sources disagree (${[...new Set(claims)].join(' vs ')})`;
  }
  if (!r.ans) return 'No answer in the source';
  return r.ans;
}

/** A list row: no full text, a snippet near the first query word. */
export function shapeHit(r, words = []) {
  const stem = String(r.stem || '').replace(/\[Image[^\]]*\]\s*/g, '');
  let at = 0;
  const low = stem.toLowerCase();
  for (const w of words) { const i = low.indexOf(w); if (i >= 0) { at = Math.max(0, i - 80); break; } }
  const snip = (at ? '…' : '') + cut(stem.slice(at), 240);
  return {
    id: r.id, cite: r.cite, coll: r.coll, form: r.form, topic: r.topic || r.off_title || null, on_checklist: !!r.unit_id, unit_id: r.unit_id || null,
    task: r.task || null, answer: answerWords(r), ans_status: r.ans_status, status: r.status, snippet: snip,
  };
}

/** One question in full, as the Library's viewer shows it. */
export function shapeQuestion(r, ranks) {
  const choices = parse(r.choices_json, []).map(([l, t]) => ({ l, t }));
  const rk = (ranks && r.unit_id && ranks.get(r.unit_id)) || {};
  const distractor = r.distractor && /^[A-Z]$/.test(r.distractor) ? choices.find(c => c.l === r.distractor) : null;
  return {
    id: r.id, cite: r.cite, coll: r.coll, collection: COLL_LONG[r.coll], form: r.form, block: r.block, num: r.num, status: r.status,
    topic: r.topic || null, off_checklist: r.unit_id ? null : r.off_title || null, category: r.category || null, unit_id: r.unit_id || null,
    rank: examRankText(rk.nbme && rk.nbme.rank, rk.cms && rk.cms.rank) || null,
    task: r.task || null, stem: r.stem, question: r.qs || null, choices,
    answer: answerWords(r), answer_letters: r.ans ? r.ans.split('') : [], ans_status: r.ans_status, claims: parse(r.claims_json, []),
    explanation: r.expl || null,
    study: { key_clue: r.clue || null, tempting: distractor ? `${distractor.l}. ${distractor.t}` : r.distractor || null, why_wrong: r.why_wrong || null },
    source: r.source || null, also: r.also ? r.also.split(', ') : [], flags: r.flags ? r.flags.split(', ') : [],
  };
}

// ------------------------------------------------------------------ filters

/** [sql, args] for the filters (x = xq). */
export function filterSql(f = {}) {
  const w = [], a = [];
  if (f.coll && COLL_WORD[f.coll]) { w.push('x.coll = ?'); a.push(f.coll); }
  if (f.form) { w.push('x.form = ?'); a.push(String(f.form)); }
  if (f.unit) { if (f.unit === 'off') w.push('x.unit_id IS NULL'); else { w.push('x.unit_id = ?'); a.push(String(f.unit)); } }
  if (f.category) { w.push('x.category = ?'); a.push(String(f.category)); }
  if (f.task) { w.push('x.task = ?'); a.push(String(f.task)); }
  if (f.answer === 'has') w.push(`x.ans <> ''`);
  if (f.answer === 'none') w.push(`x.ans_status = 'absent_in_source'`);
  if (f.answer === 'conflict') w.push(`x.ans_status = 'conflict'`);
  return [w.length ? ` AND ${w.join(' AND ')}` : '', a];
}

const LIST_COLS = 'x.rid, x.id, x.cite, x.coll, x.form, x.block, x.num, x.topic, x.off_title, x.unit_id, x.task, x.ans, x.ans_status, x.claims_json, x.status, x.stem';

// ------------------------------------------------------------------ vectors

// The bank's vectors decoded once per isolate (6,500 x 384 floats, about 10 MB), refreshed when the count moves.
const VEC_CACHE = new Map();
async function bankVectors(env, user) {
  const head = await env.DB.prepare(`SELECT count(*) AS n FROM xq WHERE user_id = ? AND vec IS NOT NULL`).bind(user).first();
  const hit = VEC_CACHE.get(user);
  if (hit && hit.n === head.n) return hit;
  const rows = (await env.DB.prepare(`SELECT rid, vec, vec_scale FROM xq WHERE user_id = ? AND vec IS NOT NULL`).bind(user).all()).results || [];
  const rids = new Int32Array(rows.length), mat = new Float32Array(rows.length * EMBED_DIMS);
  rows.forEach((r, i) => { rids[i] = r.rid; const v = dequantise(r.vec, r.vec_scale); if (v && v.length === EMBED_DIMS) mat.set(v, i * EMBED_DIMS); });
  const e = { n: head.n, rids, mat };
  VEC_CACHE.set(user, e);
  return e;
}
export const _clearBankVectors = () => VEC_CACHE.clear();

async function nearestBank(env, user, vector, k) {
  const q = unitVec(vector);
  const { rids, mat } = await bankVectors(env, user);
  const n = rids.length, scores = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * EMBED_DIMS; for (let j = 0; j < EMBED_DIMS; j++) s += mat[o + j] * q[j]; scores[i] = s; }
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k).map(i => rids[i]);
}

/** The text a question is embedded from: its topic, stem, question and choices. */
export const embedText = r => cut([r.topic || r.off_title, r.stem, r.qs, parse(r.choices_json, []).map(c => c[1]).join('; ')].filter(Boolean).join('\n'), 1800);

/** Cron: embeds up to EMBED_PER_RUN questions that have no vector yet. Returns how many. */
export async function embedPending(env, user = 'mo') {
  if (!env.AI) return 0;
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT rid, topic, off_title, stem, qs, choices_json FROM xq WHERE user_id = ? AND vec IS NULL LIMIT ?`).bind(user, EMBED_PER_RUN).all()).results || [];
  } catch (e) { if (noTable(e)) return 0; throw e; }
  if (!rows.length) return 0;
  const vecs = await embedMany(env.AI, rows.map(embedText));
  const stmts = rows.map((r, i) => { const { q, scale } = quantise(vecs[i]); return env.DB.prepare(`UPDATE xq SET vec = ?, vec_scale = ? WHERE rid = ?`).bind(q, scale, r.rid); });
  for (let k = 0; k < stmts.length; k += 100) await env.DB.batch(stmts.slice(k, k + 100));
  return rows.length;
}

// ------------------------------------------------------------------ search

const FTS_SQL = filters => `SELECT f.rowid AS rid FROM xq_fts f JOIN xq x ON x.rid = f.rowid WHERE xq_fts MATCH ? AND x.user_id = ?${filters}
  ORDER BY bm25(xq_fts, 1.0, 1.5, 2.0) LIMIT ${FTS_N}`;

export async function searchBank(env, user, opts = {}) {
  const k = Math.max(1, Math.min(MAX_K, Number(opts.k) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const [fw, fa] = filterSql(opts);
  const text = opts.q ? String(opts.q).trim().slice(0, 200) : '';
  try {
    if (!text) {
      const [rows, tot] = await env.DB.batch([
        env.DB.prepare(`SELECT ${LIST_COLS} FROM xq x WHERE x.user_id = ?${fw} ORDER BY x.coll DESC, x.form, x.block, x.num LIMIT ? OFFSET ?`).bind(user, ...fa, k, offset),
        env.DB.prepare(`SELECT count(*) AS n FROM xq x WHERE x.user_id = ?${fw}`).bind(user, ...fa),
      ]);
      return { results: (rows.results || []).map(r => shapeHit(r)), total: tot.results[0].n, via: [], expanded: [] };
    }
    const vocab = await vocabulary(env, user, { q: text });
    const plan = ftsPlan(vocab);
    const ai = opts.ai === undefined ? env.AI : opts.ai;
    const ftsP = plan.length ? env.DB.batch(plan.map(p => env.DB.prepare(FTS_SQL(fw)).bind(p.expr, user, ...fa))).catch(e => { console.error('exam bank fts', e && e.message); return []; }) : Promise.resolve([]);
    const vecP = (opts.meaning !== false && ai) ? (async () => {
      try { return await nearestBank(env, user, await embedQuery(ai, vocab.rerankQuery || text), VEC_N * 3); }
      catch (e) { console.error('exam bank vectors', e && e.message); return []; }
    })() : Promise.resolve([]);
    const [ftsR, vecIds] = await Promise.all([ftsP, vecP]);
    const lists = plan.map((p, i) => ({ name: p.name, w: p.w, ids: ((ftsR[i] && ftsR[i].results) || []).map(r => r.rid) }));
    if (vecIds.length) lists.push({ name: 'meaning', w: 0.9, ids: vecIds });
    const fused = fuse(lists);
    // The vector list ignores filters: the row read applies them, so a filtered-out question simply drops.
    const ids = fused.slice(0, 200).map(f => f.pid);
    if (!ids.length) return { results: [], via: [], expanded: vocab.phrases.map(p => p.text) };
    const rows = (await env.DB.prepare(`SELECT ${LIST_COLS} FROM xq x WHERE x.user_id = ? AND x.rid IN (SELECT value FROM json_each(?))${fw}`).bind(user, JSON.stringify(ids), ...fa).all()).results || [];
    const byRid = new Map(rows.map(r => [r.rid, r]));
    const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    let ordered = fused.filter(f => byRid.has(f.pid));
    // The Library's cross-encoder reorders the best 40 (as searchLibrary does): meaning beats a shared word.
    if (opts.meaning !== false && ai && ordered.length > 1) {
      const head = ordered.slice(0, RERANK_N);
      const scores = await rerank(ai, vocab.rerankQuery || text, head.map(f => { const r = byRid.get(f.pid); return `${r.topic || r.off_title || ''}\n${String(r.stem || '').slice(0, 1200)}`; }));
      if (scores) {
        const top = head[0].score || 1;
        head.forEach((f, i) => { f.final = RERANK_W * scores[i] + (1 - RERANK_W) * (f.score / top); });
        head.sort((a, b) => b.final - a.final);
        ordered = [...head, ...ordered.slice(RERANK_N)];
      }
    }
    return {
      results: ordered.slice(offset, offset + k).map(f => ({ ...shapeHit(byRid.get(f.pid), words), via: f.via.map(v => (v === 'meaning' ? 'meaning' : 'words')).filter((v, i, a) => a.indexOf(v) === i) })),
      total: ordered.length, via: [...new Set(lists.filter(l => l.ids.length).map(l => (l.name === 'meaning' ? 'meaning' : 'words')))],
      expanded: vocab.phrases.filter(p => p.why !== 'query').map(p => p.text).slice(0, 8),
    };
  } catch (e) {
    if (noTable(e)) return { results: [], total: 0, via: [], expanded: [], missing: true };
    throw e;
  }
}

export async function getQuestion(env, user, id) {
  const r = await env.DB.prepare(`SELECT * FROM xq WHERE user_id = ? AND id = ?`).bind(user, String(id)).first();
  if (!r) return null;
  return shapeQuestion(r, await examRanks(env, user, [r.unit_id]));
}

export async function bankFacets(env, user) {
  try {
    const [forms, tasks, cats, units, totals, vec] = await env.DB.batch([
      env.DB.prepare(`SELECT coll, form, count(*) AS n FROM xq WHERE user_id = ? GROUP BY coll, form ORDER BY coll DESC, form`).bind(user),
      env.DB.prepare(`SELECT task, count(*) AS n FROM xq WHERE user_id = ? AND task IS NOT NULL GROUP BY task ORDER BY n DESC`).bind(user),
      env.DB.prepare(`SELECT category, count(*) AS n FROM xq WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY category`).bind(user),
      env.DB.prepare(`SELECT x.unit_id, max(x.topic) AS topic, sum(x.coll = 'nbme') AS nbme_n, sum(x.coll = 'cms') AS cms_n, rn.rank AS nbme_rank, rc.rank AS cms_rank,
          (SELECT u.mehlman_rank FROM units u WHERE u.user_id = x.user_id AND u.id = x.unit_id) AS mehlman_rank
        FROM xq x LEFT JOIN xq_rank rn ON rn.user_id = x.user_id AND rn.unit_id = x.unit_id AND rn.coll = 'nbme'
        LEFT JOIN xq_rank rc ON rc.user_id = x.user_id AND rc.unit_id = x.unit_id AND rc.coll = 'cms'
        WHERE x.user_id = ? AND x.unit_id IS NOT NULL GROUP BY x.unit_id ORDER BY x.unit_id`).bind(user),
      env.DB.prepare(`SELECT coll, count(*) AS n, sum(ans = '') AS no_answer, sum(ans_status = 'conflict') AS conflict, sum(status = 'needs_visual_review') AS visual,
          sum(unit_id IS NOT NULL) AS tagged FROM xq WHERE user_id = ? GROUP BY coll`).bind(user),
      env.DB.prepare(`SELECT count(*) AS n FROM xq WHERE user_id = ? AND vec IS NOT NULL`).bind(user),
    ]);
    return {
      forms: forms.results, tasks: tasks.results, categories: cats.results.map(c => c.category),
      units: units.results, totals: Object.fromEntries(totals.results.map(t => [t.coll, t])), embedded: vec.results[0].n,
    };
  } catch (e) {
    if (noTable(e)) return { forms: [], tasks: [], categories: [], units: [], totals: {}, embedded: 0, missing: true };
    throw e;
  }
}

// ------------------------------------------------------------------ for Claude (the connector)

/** Short, cited rows for the connector: no whole questions. */
export function citeRow(r) {
  const ch = parse(r.choices_json, []);
  const say = l => { const c = ch.find(x => x[0] === l); return c ? `${l}. ${cut(c[1], 60)}` : l; };
  return {
    cite: r.cite, topic: r.topic || r.off_title || null, task: r.task || null,
    answer: r.ans && r.ans_status !== 'conflict' ? r.ans.split('').map(say).join(' + ') : answerWords(r),
    choices: cut(ch.map(c => cut(c[1], 40)).join('; '), 240) || null,
    key_clue: cut(r.clue, 160) || null, trap: r.distractor ? say(r.distractor) : null, why_wrong: cut(r.why_wrong, 220) || null,
  };
}

/** The exams' picture of one checklist unit and/or words: ranks and up to `k` cited questions (best match first). */
export async function examEvidence(env, user, { unitId = null, words = null, k = 6 } = {}) {
  try {
    const ranks = unitId ? (await examRanks(env, user, [unitId])).get(unitId) || {} : {};
    let rows = [];
    if (words) {
      const r = await searchBank(env, user, { q: words, k: k * 2, meaning: false });
      const ids = r.results.map(x => x.id);
      if (ids.length) {
        const full = (await env.DB.prepare(`SELECT * FROM xq WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || [];
        const by = new Map(full.map(x => [x.id, x]));
        rows = ids.map(id => by.get(id)).filter(Boolean);
        if (unitId) rows.sort((a, b) => (b.unit_id === unitId) - (a.unit_id === unitId));
      }
    }
    if (rows.length < k && unitId) {
      const more = (await env.DB.prepare(`SELECT * FROM xq WHERE user_id = ? AND unit_id = ? AND clue IS NOT NULL ORDER BY ans = '', coll, rid LIMIT ?`).bind(user, unitId, k * 2).all()).results || [];
      for (const m of more) if (!rows.some(r => r.id === m.id)) rows.push(m);
    }
    const out = {};
    if (ranks.nbme || ranks.cms) out.rank = [ranks.nbme ? `NBME #${ranks.nbme.rank} (${ranks.nbme.n} Qs)` : null, ranks.cms ? `CMS #${ranks.cms.rank} (${ranks.cms.n} Qs)` : null].filter(Boolean).join(' · ');
    out.questions = rows.slice(0, k).map(citeRow);
    return out;
  } catch (e) {
    if (noTable(e)) return { questions: [] };
    throw e;
  }
}

/** How the exams tell a from b: questions that name both (one usually the answer, the other the trap), best first. */
export async function examVersus(env, user, a, b, k = 5) {
  try {
    const r = await searchBank(env, user, { q: `${a} ${b}`, k: 30, meaning: false });
    const ids = r.results.map(x => x.id);
    if (!ids.length) return { versus: `${a} vs ${b}`, questions: [] };
    const full = (await env.DB.prepare(`SELECT * FROM xq WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || [];
    const by = new Map(full.map(x => [x.id, x]));
    const names = s => String(s).toLowerCase().split(/\s*(?:\/|,| or )\s*/).filter(Boolean);
    const has = (row, s) => { const t = [row.topic, row.off_title, row.stem, row.choices_json, row.expl, row.clue, row.why_wrong].join(' ').toLowerCase(); return names(s).some(n => t.includes(n)); };
    const rows = ids.map(id => by.get(id)).filter(Boolean).filter(x => has(x, a) && has(x, b));
    return { versus: `${a} vs ${b}`, n: rows.length, questions: rows.slice(0, k).map(citeRow) };
  } catch (e) {
    if (noTable(e)) return { versus: `${a} vs ${b}`, questions: [] };
    throw e;
  }
}

// ------------------------------------------------------------------ Ask the data

export const ASK_TABLES = ['xq', 'xq_fts', 'xq_rank', 'units'];
const BANNED = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|savepoint|release|begin|commit|rollback|load_extension)\b/i;

/** null when the SQL is one read-only statement over the bank's tables, else the reason it is refused. */
export function checkSql(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) return 'Only SELECT queries.';
  if (s.includes(';')) return 'One statement only.';
  if (BANNED.test(s.replace(/'[^']*'/g, "''"))) return 'Only reading is allowed.';
  if (/sqlite_|_cf_|d1_/i.test(s)) return 'System tables are off limits.';
  const names = [...s.replace(/'[^']*'/g, "''").matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)].map(m => m[1].toLowerCase());
  const ctes = [...s.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase());
  const bad = names.filter(n => !ASK_TABLES.includes(n) && !ctes.includes(n) && n !== 'json_each');
  return bad.length ? `Unknown table ${bad[0]}.` : null;
}

const ASK_SCHEMA_TEXT = `SQLite tables (read-only; Mo's own user_id is 'mo'):
xq: one row per unique exam question. coll 'nbme' (Original Forms: NBME forms 1-16 + Free 120s 2019/2021/2023) or 'cms' (CMS subject forms); keep them separate unless asked to combine.
  id, cite (label to cite, e.g. 'CMS Peds 4 Q12', 'NBME 13 B2 Q31'), form ('Form 13', 'Pediatrics 4'), block, num,
  status (ready | no_answer_in_source | needs_visual_review | incomplete | needs_review | conflict | missing),
  unit_id (checklist unit 'u001'..'u229'; NULL = off the checklist), topic (checklist topic name), category (checklist category, e.g. 'KIDNEY + ELECTROLYTES'), off_title (topic when off the checklist),
  task (question type: 'most likely diagnosis', 'next step in management', 'most likely cause/etiology', 'most appropriate diagnostic test', 'most appropriate pharmacotherapy', 'mechanism/pathophysiology', 'most likely finding', 'prevention/screening', 'most appropriate initial step', 'risk factor', 'ethics/communication', 'complication/prognosis', 'adverse effect', 'biostatistics/epidemiology', 'contraindication', 'patient safety/quality', 'other'),
  ans (key letters, '' when the source had none), ans_status ('single_source' | 'agreed' | 'absent_in_source' | 'conflict' | 'single_source_marked_uncertain'), claims_json (every source's claim),
  stem, qs (question sentence), choices_json (JSON [[letter, text], ...]; use json_each(choices_json) with json_extract(value,'$[0]') and '$[1]'), expl (explanation),
  clue (AI key clue), distractor (AI: letter of the most tempting wrong answer), why_wrong (AI: why that tempting answer is wrong).
xq_fts: FTS5 (rowid = xq.rid; columns body, study, topic). e.g. SELECT x.cite FROM xq_fts JOIN xq x ON x.rid = xq_fts.rowid WHERE xq_fts MATCH '"hemolytic uremic" OR HUS'.
xq_rank: unit_id, coll, rank (1 = most questions; ties share), n (unique questions), of_n (tagged questions in that collection).
units: id ('u001'), name, lane ('A'|'B'|'C'), mehlman_rank (Mehlman's top list, 1 = highest yield).`;

const PLAN_SYSTEM = `You turn Mo's plain-English question about his exam-question data into at most 4 read-only SQLite queries.
${ASK_SCHEMA_TEXT}
Rules: SELECT only, one statement each, each returns at most 60 rows (use LIMIT). Always return cite (or counts) so the answer can be cited. For "most common" questions return counts with denominators. For wrong answers: the tempting answer's text is the choice whose letter = distractor. For conditions use topic/category and FTS (names and abbreviations). For how exams separate two conditions, fetch questions naming both, with cite, ans, the answer's text, distractor's text, clue and why_wrong. Do not select whole stems or explanations unless needed; cut with substr(stem,1,300).`;

const ANSWER_SYSTEM = `You answer Mo's question about his own exam-question data (NBME = Original Forms, CMS = CMS Forms) from the query results only.
Rules: Use only facts in the rows; never add outside medical knowledge as if it came from the exams. Give numbers with denominators and keep NBME and CMS separate unless asked. Cite questions by their cite label in brackets, e.g. (CMS Peds 4 Q12). If the rows cannot answer, say so plainly and say what the data does hold. Mention when questions have no answer key in the source if it matters. Plain, short: at most about 180 words, short paragraphs or a few bullets, no tables, no markdown headings.`;

const PLAN_SCHEMA = { type: 'object', properties: { queries: { type: 'array', items: { type: 'object', properties: { purpose: { type: 'string' }, sql: { type: 'string' } }, required: ['purpose', 'sql'], additionalProperties: false } } }, required: ['queries'], additionalProperties: false };
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } }, required: ['answer', 'citations'], additionalProperties: false };

const shortCell = v => (typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v);

/** A word of the SQL (outside strings) that names any other table of the hub, or null. */
export function otherTable(sql, tables) {
  const words = String(sql || '').replace(/'[^']*'/g, "''").toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
  return words.find(w => tables.has(w) && !ASK_TABLES.includes(w) && !w.startsWith('xq_fts')) || null;
}

/** Runs Claude's queries (checked, capped). [{purpose, sql, rows?, error?}]. */
export async function runAskQueries(env, queries) {
  const out = [];
  let tables = new Set();
  try { tables = new Set(((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all()).results || []).map(r => r.name.toLowerCase())); } catch { /* the regex check still runs */ }
  for (const q of (queries || []).slice(0, 4)) {
    const other = otherTable(q.sql, tables);
    const bad = checkSql(q.sql) || (other ? `Unknown table ${other}.` : null);
    if (bad) { out.push({ purpose: q.purpose, sql: q.sql, error: bad }); continue; }
    try {
      const rows = (await env.DB.prepare(`SELECT * FROM (${String(q.sql).trim().replace(/;\s*$/, '')}) LIMIT 60`).all()).results || [];
      out.push({ purpose: q.purpose, sql: q.sql, rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, shortCell(v)]))) });
    } catch (e) { out.push({ purpose: q.purpose, sql: q.sql, error: cut(e && e.message, 200) }); }
  }
  return out;
}

export async function askBank(env, user, question) {
  await assertUnderCap(env);
  const plan = await callJson(env, { role: 'analyst', system: PLAN_SYSTEM, schema: PLAN_SCHEMA, effort: 'high', maxTokens: 8000,
    messages: [{ role: 'user', content: question }] });
  let ran = await runAskQueries(env, plan.data.queries);
  let usd = plan.usd;
  // One repair round when every query failed (a typo in a column name, say).
  if (ran.length && ran.every(r => r.error)) {
    const fix = await callJson(env, { role: 'analyst', system: PLAN_SYSTEM, schema: PLAN_SCHEMA, effort: 'high', maxTokens: 8000,
      messages: [{ role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(plan.data) },
        { role: 'user', content: `These failed: ${JSON.stringify(ran.map(r => ({ sql: r.sql, error: r.error })))}. Write them again.` }] });
    ran = await runAskQueries(env, fix.data.queries);
    usd += fix.usd;
  }
  const body = JSON.stringify(ran.map(r => ({ purpose: r.purpose, ...(r.error ? { error: r.error } : { rows: r.rows }) }))).slice(0, 90_000);
  const ans = await callJson(env, { role: 'analyst', system: ANSWER_SYSTEM, schema: ANSWER_SCHEMA, effort: 'high', maxTokens: 6000,
    messages: [{ role: 'user', content: `Question: ${question}\n\nQuery results (JSON):\n${body}` }] });
  usd += ans.usd;
  // Only citations the rows actually hold, mapped to question ids so the page can open them.
  const seen = new Map();
  for (const r of ran) for (const row of r.rows || []) if (row.cite) seen.set(String(row.cite), row.id || null);
  const cites = [...new Set(ans.data.citations.map(String))].filter(c => seen.has(c));
  const known = await citeIds(env, user, cites.filter(c => !seen.get(c)));
  return {
    answer: ans.data.answer,
    citations: cites.map(c => ({ cite: c, id: seen.get(c) || known.get(c) || null })),
    queries: ran.map(r => ({ purpose: r.purpose, sql: r.sql, rows: r.rows ? r.rows.length : 0, error: r.error || null })),
    usd: Math.round(usd * 10000) / 10000,
  };
}

async function citeIds(env, user, cites) {
  if (!cites.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT cite, id FROM xq WHERE user_id = ? AND cite IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(cites)).all()).results || [];
  return new Map(rows.map(r => [r.cite, r.id]));
}

// ------------------------------------------------------------------ routes

export async function searchRoute(request, env, ctx, params, url, user = 'mo') {
  const p = url.searchParams;
  const opts = { q: p.get('q') || '', coll: p.get('coll') || null, form: p.get('form') || null, unit: p.get('unit') || null, category: p.get('category') || null,
    task: p.get('task') || null, answer: ANSWER_FILTERS.includes(p.get('answer')) ? p.get('answer') : null, k: Number(p.get('k')) || 20, offset: Number(p.get('offset')) || 0 };
  return json(await searchBank(env, user, opts));
}

export async function questionRoute(request, env, ctx, params, url, user = 'mo') {
  const q = await getQuestion(env, user, params.id);
  if (!q) throw new HttpError(404, 'That question is not in the exam bank.');
  return json(q);
}

export async function facetsRoute(request, env, ctx, params, url, user = 'mo') {
  return json(await bankFacets(env, user));
}

export async function askRoute(request, env, ctx, params, url, user = 'mo') {
  const b = await readJson(request, 10_000);
  const question = str(b.question, 500).trim();
  if (question.length < 4) throw new HttpError(400, 'Type a question about the exam questions.');
  return json(await askBank(env, user, question));
}
