import { norm, isCut, candidates, contentWords, isDiscriminatorDiff, spanQualified, contextWords, contextBars, userKey } from '../../../public/js/shared/names.js';
import { categoryFor, VOCABS } from './vocab.js';
import { systemsOf, legacySystem, withParents } from './systems.js';
import { buildLeakIndex, leaks } from '../checks.js';
import { hubQuestionLabel } from '../util.js';
import { isFoundationCategory } from '../../../public/js/shared/concept.js';

export const ACCEPT = 0.85;
export const CUT_MIN = 6;               // a cut-off key shorter than this never matches by prefix
export const LABEL_MAX = 200;
const MERGE_HOPS = 5;

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const uniq = list => [...new Set(list)];

/**
 * The category a system name points at, from any vocabulary (or the one named): its id, or null.
 * Takes (label) or (label, vocab); the design's (vocab, label) order is accepted too.
 */
export function resolveCategory(a, b = null) {
  const [label, vocab] = VOCABS.includes(a) && b != null ? [b, a] : [a, b];
  const r = categoryFor(label, vocab);
  return r ? r.category_id : null;
}

/**
 * Every system a category hint stands for (taxonomy v2): a system id is itself; an old merged category's id, or a
 * system name that named one ('Hematology & Oncology', the hub's 'Neurology, Eye and ENT'), is every system its
 * topics went to, so the hint still settles an abbreviation two topics share. [] for no hint.
 */
export function hintSystems(hint, system = null) {
  if (Array.isArray(hint)) return hint;
  if (hint != null) { const s = systemsOf(hint); return withParents(s.length ? s : [String(hint)]); }
  const r = system ? categoryFor(system) : null;
  return r ? withParents(r.category_ids || (r.category_id ? [r.category_id] : [])) : [];
}
// The one id a hint is stored or filtered as (an old id reads as the system it became).
const hintId = hint => (Array.isArray(hint) ? hint[0] ?? null : hint == null ? null : legacySystem(hint) || String(hint));

// ---------------------------------------------------------------- reads

// Alias hits for a set of keys, plus prefix hits for cut-off keys, in one D1 batch.
// Each hit: {key, alias_kind, id, name, status, category_id, category2_id, unit_id, yield, disciplines} (merged topics followed one hop).
const ALIAS_SQL = `SELECT a.alias_key AS key, a.kind AS alias_kind, coalesce(m.id, t.id) AS id, coalesce(m.name, t.name) AS name,
    coalesce(m.status, t.status) AS status, coalesce(m.category_id, t.category_id) AS category_id, coalesce(m.category2_id, t.category2_id) AS category2_id,
    coalesce(m.unit_id, t.unit_id) AS unit_id, coalesce(m.yield, t.yield) AS yield, coalesce(m.disciplines, t.disciplines) AS disciplines
  FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id
  LEFT JOIN topics m ON t.status = 'merged' AND m.user_id = t.user_id AND m.id = t.merged_into
  WHERE a.user_id = ?1 AND a.status = 'active' AND t.status IN ('proposed','confirmed','merged')`;

// Before 0012 (taxonomy v2) topics have no disciplines column: the same read without it.
const ALIAS_SQL_V0 = ALIAS_SQL.replace(', coalesce(m.disciplines, t.disciplines) AS disciplines', '');

export async function fetchAliases(env, user, keys, cutKeys = []) {
  const stmts = sql => {
    const out = [env.DB.prepare(`${sql} AND a.alias_key IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(uniq(keys)))];
    for (const k of cutKeys) out.push(env.DB.prepare(`${sql} AND a.alias_key >= ?2 AND a.alias_key < ?2 || '~' LIMIT 40`).bind(user, k));
    return out;
  };
  let res;
  try { res = await env.DB.batch(stmts(ALIAS_SQL)); } catch (e) {
    if (/no such column/i.test(String(e && e.message)) && /disciplines/.test(String(e && e.message))) {
      try { res = await env.DB.batch(stmts(ALIAS_SQL_V0)); } catch (e2) { if (noTable(e2)) return { byKey: new Map(), prefix: new Map() }; throw e2; }
    } else if (noTable(e)) return { byKey: new Map(), prefix: new Map() };
    else throw e;
  }
  const live = r => r.status === 'proposed' || r.status === 'confirmed';
  const byKey = new Map();
  for (const r of (res[0].results || []).filter(live)) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    if (!byKey.get(r.key).some(x => x.id === r.id)) byKey.get(r.key).push(r);
  }
  const prefix = new Map(cutKeys.map((k, i) => [k, (res[i + 1].results || []).filter(live)]));
  return { byKey, prefix };
}

// ---------------------------------------------------------------- root causes

const rootHit = h => !!h && isFoundationCategory(h.category_id);
/** fetchAliases' {byKey, prefix} without the root-cause topics' names (pure). */
export function withoutRoots(data) {
  const byKey = new Map(), prefix = new Map();
  for (const [k, hits] of (data && data.byKey) || []) { const keep = hits.filter(h => !rootHit(h)); if (keep.length) byKey.set(k, keep); }
  for (const [k, hits] of (data && data.prefix) || []) prefix.set(k, hits.filter(h => !rootHit(h)));
  return { byKey, prefix };
}

// ---------------------------------------------------------------- pure deciding

const inCat = (h, cat) => {
  if (!cat || (Array.isArray(cat) && !cat.length)) return false;
  const set = Array.isArray(cat) ? cat : [cat];
  return set.includes(h.category_id) || (h.category2_id != null && set.includes(h.category2_id));
};
const distinct = hits => { const m = new Map(); for (const h of hits) if (!m.has(h.id)) m.set(h.id, h); return [...m.values()]; };

// One topic among hits: the only one, the only one whose own name this is (B4-2: an alias that clashes with another
// topic's name never hides that topic), or the only one in the hinted category. {hit, bySystem} or null.
function pick(hits, hint) {
  const d = distinct(hits);
  if (d.length === 1) return { hit: d[0], bySystem: false };
  const named = distinct(hits.filter(h => h.alias_kind === 'name'));
  if (d.length > 1 && named.length === 1) return { hit: named[0], bySystem: false };
  if (d.length > 1 && hint) {
    const h = d.filter(x => inCat(x, hint));
    if (h.length === 1) return { hit: h[0], bySystem: true };
  }
  return null;
}

/** The texts' parts and the keys to look up: {items: [{text, cut, cand}], keys, cutKeys}. */
export function plan(texts, { exact = false } = {}) {
  const items = [];
  const keys = new Set(), cutKeys = new Set();
  for (const text of texts) {
    const cand = candidates(text);
    const cut = isCut(text);
    const parts = exact ? cand.parts.filter(p => p.via !== 'span') : cand.parts;
    items.push({ text, cut, cand: { ...cand, parts } });
    for (const p of parts) keys.add(p.key);
    const k = norm(text);
    if (cut && !exact && k.length >= CUT_MIN) cutKeys.add(k);
  }
  return { items, keys: [...keys], cutKeys: [...cutKeys] };
}

/**
 * Steps 1 and 4 to 6 over looked-up aliases (pure, so the queue re-run decides exactly as resolveTopic does).
 * Returns {topic_id, confidence, via, learn, name} or {topic_id: null, hits} (hits: every topic seen, for candidates).
 */
export function decide(planned, { byKey, prefix }, hint = null, { exact = false, skipFirst = false } = {}) {
  const seen = [];
  const hitsOf = key => { const h = byKey.get(key) || []; seen.push(...h); return h; };
  const ok = (p, confidence, via, learn = []) => ({ topic_id: p.hit.id, name: p.hit.name, confidence: p.bySystem ? Math.min(confidence, 0.9) : confidence,
    via: p.bySystem ? `${via}+system` : via, learn });

  // 1: the most explicit text, exactly.
  const first = planned.items[0];
  if (first && !skipFirst) {
    const p = pick(hitsOf(first.cand.parts[0] ? first.cand.parts[0].key : ''), hint);
    if (p) return ok(p, 1.0, 'alias');
  }
  // 4: for each text in order, its whole (later texts) and its colon, vs, head and bracket parts. A text whose
  // parts point at two different topics stops here: Claude decides.
  for (let i = 0; i < planned.items.length; i++) {
    const it = planned.items[i];
    const structural = it.cand.parts.filter(p => p.via !== 'span' && (p.via !== 'full' || i > 0 || skipFirst));
    const found = [];
    for (const p of structural) {
      if (p.via === 'head') {
        const ctx = contextWords(it.text, p.key);
        const heads = byKey.get(p.key) || [];
        if (ctx.length && heads.some(h => contextBars(ctx, h))) return { topic_id: null, hits: distinct([...seen, ...heads]), ambiguous: true };
      }
      const pk = pick(hitsOf(p.key), hint);
      if (pk) found.push({ ...pk, via: p.via === 'full' ? 'alias' : p.via });
      else if ((byKey.get(p.key) || []).length > 1) return { topic_id: null, hits: distinct(seen), ambiguous: true };
    }
    const ids = uniq(found.map(f => f.hit.id));
    if (ids.length === 1) return ok(found[0], 0.9, found[0].via);
    if (ids.length > 1) return { topic_id: null, hits: distinct(seen), ambiguous: true };
  }
  if (exact) return { topic_id: null, hits: distinct(seen) };
  // 5: a label cut short: one topic whose alias keys start with it, and no telling-apart word against the rest.
  for (const it of planned.items) {
    if (!it.cut) continue;
    const k = norm(it.text);
    const rows = prefix.get(k) || [];
    seen.push(...rows);
    const all = distinct(rows);
    if (!all.length) continue;
    const inHint = hint ? all.filter(x => inCat(x, hint)) : [];
    const chosen = all.length === 1 ? all[0] : inHint.length === 1 ? inHint[0] : null;
    if (!chosen) return { topic_id: null, hits: distinct(seen), ambiguous: true };
    const chosenKeys = rows.filter(r => r.id === chosen.id).map(r => r.key);
    const clash = rows.some(r => r.id !== chosen.id && chosenKeys.some(ck => isDiscriminatorDiff(ck, r.key)));
    if (clash) return { topic_id: null, hits: distinct(seen), ambiguous: true };
    return { topic_id: chosen.id, name: chosen.name, confidence: 0.9, via: 'cut', learn: [{ alias: it.text.trim(), kind: 'truncated' }] };
  }
  // 6: word spans of every text, all pointing at one topic. The category hint settles only an abbreviation
  // that names two topics ('MS'); two different spans naming two topics go to Claude.
  const picked = [];
  for (const it of planned.items) {
    const caps = new Set((String(it.text).match(/\b[A-Z][A-Z0-9]{1,9}\b/g) || []).map(w => w.toLowerCase()));
    for (const sp of it.cand.parts) {
      if (sp.via !== 'span') continue;
      const hits = hitsOf(sp.key).filter(h => h.alias_kind !== 'abbrev' || caps.has(sp.key));
      if (!hits.length) continue;
      // A span next to a telling-apart word ('Gestational' diabetes mellitus, 'Unstable' angina) names another
      // condition: it goes to Claude, never onto the parent or the look-alike subtype.
      if (spanQualified(it.text, sp.key)) return { topic_id: null, hits: distinct(seen), ambiguous: true };
      const ctx = contextWords(it.text, sp.key, { near: true });
      if (ctx.length && hits.some(h => contextBars(ctx, h))) return { topic_id: null, hits: distinct(seen), ambiguous: true };
      const pk = pick(hits, hint);
      if (!pk) return { topic_id: null, hits: distinct(seen), ambiguous: true };
      picked.push(pk);
    }
  }
  if (picked.length && uniq(picked.map(x => x.hit.id)).length === 1) return ok(picked.find(x => x.bySystem) || picked[0], 0.85, 'span');
  return { topic_id: null, hits: distinct(seen), ambiguous: picked.length > 0 };
}

// ---------------------------------------------------------------- refs

const cueMs = s => { const m = /^(\d+):(\d{2})$/.exec(s); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null; };

async function firstOrNull(stmt) {
  try { return await stmt.first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

// The hub question behind (block, q_index): its analysis topic and system as texts, leak-checked against the
// question itself, plus the sitting's hold.
async function hubQuestion(env, user, blockId, qIndex) {
  const a = await firstOrNull(env.DB.prepare(`SELECT a.topic, a.system, b.sitting_id, b.idx AS block_idx, s.status, s.name AS sitting_name,
      json_extract(e.questions_json, '$[' || CAST(?3 AS INTEGER) || ']') AS q
    FROM blocks b JOIN sittings s ON s.id = b.sitting_id LEFT JOIN exams e ON e.id = s.exam_id
    LEFT JOIN analyses a ON a.block_id = b.id AND a.q_index = ?3
    WHERE b.id = ?1`).bind(blockId, null, qIndex));
  if (!a) return null;
  let index = null, num = null;
  try { const q = a.q ? JSON.parse(a.q) : null; index = q ? buildLeakIndex(q) : null; num = q ? q.num : null; } catch { index = null; }
  const safe = t => (t && (!index || !leaks(index, t)) ? t : null);
  return { texts: [safe(a.topic)].filter(Boolean), system: safe(a.system), sitting_id: a.sitting_id, held: a.status !== 'done',
    label: hubQuestionLabel(a.sitting_name, num, qIndex, a.block_idx) };
}

// A placed miss or evidence row for an observation key: {topic_id, held, sitting_id} or null.
async function placedObs(env, user, obsKey) {
  const r = await firstOrNull(env.DB.prepare(`SELECT topic_id, held, sitting_id FROM misses WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL
      UNION ALL SELECT topic_id, held, sitting_id FROM evidence WHERE user_id = ?1 AND obs_key = ?3 AND slot = 0 AND topic_id IS NOT NULL LIMIT 1`)
    .bind(user, userKey(user, obsKey), obsKey));
  return r && r.topic_id ? r : null;
}

export async function resolveRef(env, user, ref) {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 200) return null;
  let m;
  if ((m = /^block:([\w-]+):q(\d{1,3})$/.exec(s))) {
    const [blockId, q] = [m[1], Number(m[2])];
    const placed = await placedObs(env, user, `hub:${blockId}:${q}`);
    const hq = await hubQuestion(env, user, blockId, q);
    if (placed) return { topic_id: placed.topic_id, texts: [], label: hq && hq.label, sitting_id: placed.sitting_id || (hq && hq.sitting_id), held: !!placed.held || !!(hq && hq.held) };
    return hq ? { texts: hq.texts, system: hq.system, label: hq.label, sitting_id: hq.sitting_id, held: hq.held } : null;
  }
  if ((m = /^uworld:([\w-]+)@(\d+:\d{2})$/.exec(s))) {
    const at = cueMs(m[2]);
    const b = await firstOrNull(env.DB.prepare('SELECT id, day, questions_json FROM uworld_blocks WHERE id = ?').bind(m[1]));
    if (!b || at == null) return null;
    let qs = [];
    try { qs = JSON.parse(b.questions_json || '[]'); } catch { qs = []; }
    const q = qs.filter(x => Number.isFinite(x.start_ms) && x.start_ms <= at).sort((x, y) => y.start_ms - x.start_ms)[0];
    if (!q) return null;
    const obs = q.uworld_id ? `uw:${q.uworld_id}:${b.day}` : `uwb:${b.id}:${q.q}`;
    const placed = await placedObs(env, user, obs);
    const label = q.uworld_id ? `UW ${q.uworld_id}` : `UWorld block Q${q.q}`;
    if (placed) return { topic_id: placed.topic_id, texts: [], label };
    return { texts: [q.topic].filter(Boolean), system: q.system || null, label, uworld_label: true };
  }
  if ((m = /^(?:UWorld|UW)\s*#?\s*(\d{3,7})$/i.exec(s))) {
    const id = m[1];
    const miss = await firstOrNull(env.DB.prepare('SELECT topic_id FROM misses_live WHERE user_id = ? AND uw_qid = ? AND topic_id IS NOT NULL ORDER BY at DESC LIMIT 1').bind(user, id));
    if (miss) return { topic_id: miss.topic_id, texts: [], label: `UW ${id}` };
    const b = await firstOrNull(env.DB.prepare('SELECT questions_json FROM uworld_blocks WHERE questions_json LIKE ? ORDER BY day DESC LIMIT 1')
      .bind(`%"uworld_id":"${id}"%`));
    let q = null;
    try { q = b ? JSON.parse(b.questions_json).find(x => String(x.uworld_id) === id) : null; } catch { q = null; }
    return { texts: q && q.topic ? [q.topic] : [], system: (q && q.system) || null, label: `UW ${id}`, uworld_label: true };
  }
  // '<sitting> Q<n>', or '<sitting> B<b> Q<n>' for a block whose numbering started again (B3-3: hubQuestionLabel).
  if ((m = SITTING_REF.exec(s))) {
    const [name, b, n] = [m[1].trim(), m[2] ? Number(m[2]) : null, Number(m[3])];
    const label = b ? `${name} B${b} Q${n}` : `${name} Q${n}`;
    const miss = await firstOrNull(env.DB.prepare(`SELECT topic_id, sitting_id FROM misses WHERE user_id = ? AND label = ? COLLATE NOCASE AND deleted_at IS NULL
        ORDER BY at DESC LIMIT 1`).bind(user, label));
    if (miss && miss.topic_id) return { topic_id: miss.topic_id, texts: [], label, sitting_id: miss.sitting_id };
    // The question itself: Q<n> of the exam, or the n-th of block b.
    const blk = await firstOrNull(b
      ? env.DB.prepare(`SELECT b.id, b.q_from + ?2 - 1 AS q FROM sittings s JOIN blocks b ON b.sitting_id = s.id
          WHERE s.name = ?1 COLLATE NOCASE AND b.idx = ?3 AND b.q_from + ?2 - 1 <= b.q_to ORDER BY s.created_at DESC LIMIT 1`).bind(name, n, b - 1)
      : env.DB.prepare(`SELECT b.id, ?2 - 1 AS q FROM sittings s JOIN blocks b ON b.sitting_id = s.id
          WHERE s.name = ?1 COLLATE NOCASE AND b.q_from <= ?2 - 1 AND b.q_to >= ?2 - 1 ORDER BY s.created_at DESC LIMIT 1`).bind(name, n));
    if (!blk) return { texts: [], label };
    const placed = await placedObs(env, user, `hub:${blk.id}:${blk.q}`);
    const hq = await hubQuestion(env, user, blk.id, blk.q);
    if (placed) return { topic_id: placed.topic_id, texts: [], label, sitting_id: hq && hq.sitting_id, held: !!placed.held || !!(hq && hq.held) };
    return hq ? { texts: hq.texts, system: hq.system, label, sitting_id: hq.sitting_id, held: hq.held } : { texts: [], label };
  }
  return null;
}

export const SITTING_REF = /^(.{2,60}?)[,\s]+(?:(?:B|block)\s?(\d{1,2})[,\s]+)?(?:Q\s?|question\s+)(\d{1,3})$/i;

export async function hubQuestionsOfRef(env, user, ref) {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 200) return [];
  let m;
  if ((m = /^block:([\w-]+):q(\d{1,3})$/.exec(s))) return [{ block_id: m[1], q_index: Number(m[2]) }];
  if (!(m = SITTING_REF.exec(s))) return [];
  const [name, b, n] = [m[1].trim(), m[2] ? Number(m[2]) : null, Number(m[3])];
  if (/^(?:uw|uworld)$/i.test(name)) return [];
  if (b) {
    const blk = await firstOrNull(env.DB.prepare(`SELECT b.id, b.q_from + ?2 - 1 AS q FROM sittings s JOIN blocks b ON b.sitting_id = s.id
        WHERE s.name = ?1 COLLATE NOCASE AND b.idx = ?3 AND b.q_from + ?2 - 1 <= b.q_to ORDER BY s.created_at DESC LIMIT 1`).bind(name, n, b - 1));
    return blk ? [{ block_id: blk.id, q_index: Number(blk.q) }] : [];
  }
  // The newest sitting of that name: each block's question printed Q<n>, and the exam's n-th question (a form numbered
  // straight through, or one whose questions carry no number).
  let rows = [];
  try {
    rows = (await env.DB.prepare(`WITH s AS (SELECT id, exam_id FROM sittings WHERE name = ?1 COLLATE NOCASE ORDER BY created_at DESC LIMIT 1)
        SELECT b.id AS block_id, CAST(j.key AS INTEGER) AS q FROM s JOIN blocks b ON b.sitting_id = s.id JOIN exams e ON e.id = s.exam_id, json_each(e.questions_json) j
          WHERE CAST(j.key AS INTEGER) BETWEEN b.q_from AND b.q_to AND (CAST(json_extract(j.value, '$.num') AS INTEGER) = ?2 OR CAST(j.key AS INTEGER) = ?2 - 1)
        LIMIT 20`).bind(name, n).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
  const seen = new Set();
  return rows.map(r => ({ block_id: r.block_id, q_index: Number(r.q) })).filter(q => !seen.has(`${q.block_id}:${q.q_index}`) && seen.add(`${q.block_id}:${q.q_index}`));
}

/** The first hub question a ref names, or null (callers that need one; leak checks use hubQuestionsOfRef). */
export async function hubQuestionOfRef(env, user, ref) {
  return (await hubQuestionsOfRef(env, user, ref))[0] || null;
}

// ---------------------------------------------------------------- card

// The topics a card is linked to (panel's card_topics; or the miss whose Anki notes hold the note): one topic or null.
async function cardTopic(env, user, cardId, noteId) {
  const ids = [];
  if (cardId != null) {
    try {
      const rows = (await env.DB.prepare(`SELECT topic_id, match, strong FROM card_topics WHERE user_id = ? AND card_id = ? AND removed_at IS NULL`).bind(user, cardId).all()).results || [];
      const best = rows.filter(r => ['miss', 'claude', 'gap'].includes(r.match) || r.strong);
      ids.push(...uniq((best.length ? best : rows).map(r => r.topic_id)));
    } catch (e) { if (!noTable(e)) throw e; }
  }
  if (!ids.length && noteId != null) {
    try {
      const rows = (await env.DB.prepare(`SELECT DISTINCT topic_id FROM misses WHERE user_id = ? AND topic_id IS NOT NULL AND deleted_at IS NULL AND held = 0
          AND EXISTS (SELECT 1 FROM json_each(misses.anki_note_ids_json) j WHERE j.value = ?) LIMIT 3`).bind(user, noteId).all()).results || [];
      ids.push(...rows.map(r => r.topic_id));
    } catch (e) { if (!noTable(e)) throw e; }
  }
  return ids.length === 1 ? ids[0] : null;
}

// Follows merged_into, 5 hops at most: the live topic, or null when it is missing or retired.
export async function liveTopic(env, user, id) {
  let cur = String(id);
  for (let hop = 0; hop <= MERGE_HOPS; hop++) {
    const t = await firstOrNull(env.DB.prepare('SELECT id, name, status, merged_into, category_id FROM topics WHERE user_id = ? AND id = ?').bind(user, cur));
    if (!t || t.status === 'retired') return null;
    if (t.status !== 'merged') return t;
    if (!t.merged_into) return null;
    cur = t.merged_into;
  }
  return null;
}

// ---------------------------------------------------------------- candidates

// The small words two names of one topic differ in ("during pregnancy", "in pregnancy", "of pregnancy").
const FOLD = ['during', 'in', 'of'];
export const FOLD_SCORE = 0.8;
/**
 * Each text's key with "during", "in" or "of" swapped for the others, one word at a time (pure; candidates only, so
 * no stored key ever changes): 'physiologic change during pregnancy' -> 'physiologic change in pregnancy', '... of ...'.
 */
export function foldedKeys(texts) {
  const out = new Set();
  for (const t of (texts || []).slice(0, 3)) {
    const k = norm(t), w = k.split(' ');
    w.forEach((x, i) => {
      if (!FOLD.includes(x) || i === 0 || i === w.length - 1) return;
      for (const y of FOLD) if (y !== x) out.add([...w.slice(0, i), y, ...w.slice(i + 1)].join(' '));
    });
    out.delete(k);
  }
  return [...out].slice(0, 12);
}

// Same-category topics sharing a content word with the texts, for Claude's choice (top 5 by shared words).
async function nearTopics(env, user, texts, hint, exclude) {
  const words = uniq(texts.flatMap(t => contentWords(norm(t)))).filter(w => w.length >= 4).slice(0, 6);
  if (!words.length) return [];
  let rows;
  try {
    // PERF5: each alias is read once through idx_aliases_topic (the planner used to scan every alias once per topic:
    // 87,000 rows read for a call with a category, 1.4 million without), the words are plain LIKEs (no json_each),
    // and the rows come in topic order, as before, so the same topics are offered.
    const like = words.map((w, k) => `' ' || a.alias_key || ' ' LIKE ?${k + 3}`).join(' OR ');
    rows = (await env.DB.prepare(`SELECT DISTINCT t.id, t.name, t.category_id, t.unit_id, a.alias_key AS key FROM topics t
        JOIN topic_aliases a INDEXED BY idx_aliases_topic ON a.user_id = t.user_id AND a.topic_id = t.id
        WHERE t.user_id = ?1 AND a.status = 'active' AND t.status IN ('proposed','confirmed') AND (?2 IS NULL OR t.category_id = ?2 OR t.category2_id = ?2)
          AND (${like}) ORDER BY t.id, a.alias_key LIMIT 60`)
      .bind(user, hint || null, ...words.map(w => `% ${w} %`)).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
  const score = new Map();
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    const shared = words.filter(w => ` ${r.key} `.includes(` ${w} `)).length;
    const cur = score.get(r.id);
    if (!cur || shared > cur.shared) score.set(r.id, { id: r.id, name: r.name, category_id: r.category_id, unit_id: r.unit_id, shared });
  }
  return [...score.values()].sort((a, b) => b.shared - a.shared).slice(0, 5)
    .map(c => ({ id: c.id, name: c.name, category_id: c.category_id, unit_id: c.unit_id, score: Math.round(50 * c.shared / words.length) / 100, via: 'word' }));
}

// The queue item for what could not be placed (realtime writes it; ids per plan §5.2 topic_queue).
// A gap is always queued as gap:<gap_id> (plan §6.4), its topic words as the label.
export function queueItem(user, { texts, source = null, source_ref = null, gap_id = null, card_id = null, system = null, hint = null, cut = false, ref_label = null, candidates: cands = [] }) {
  const text = texts[0];
  const gapId = gap_id ?? (source === 'gap' ? source_ref : null);
  let kind, key, raw;
  if (gapId != null) { kind = 'gap'; key = String(gapId); raw = text ? String(text).trim() : ref_label || 'A gap with no topic'; }
  else if (text) { kind = 'label'; key = norm(text); raw = String(text).trim(); }
  else if (card_id != null) { kind = 'card'; key = String(card_id); raw = ref_label || `Card ${card_id}`; }
  else return null;
  if (kind === 'label' && !key) return null;
  const context = Object.fromEntries(Object.entries({ system, category_hint: hint, cut: cut || null, source, source_ref, ref_label }).filter(([, v]) => v != null && v !== ''));
  for (const [k, v] of Object.entries(context)) if (typeof v === 'string') context[k] = v.slice(0, 400);
  return { id: userKey(user, `${kind}:${key}`), kind, label_raw: raw.slice(0, LABEL_MAX), label_norm: kind === 'label' ? key : norm(raw) || kind,
    context, candidates: cands.slice(0, 5) };
}

// ---------------------------------------------------------------- resolveTopic

/**
 * resolveTopic(env, user, {texts, system?, category_id?, card_id?, note_id?, ref?, topic_id?, exact?, source?, source_ref?, gap_id?, roots?})
 *   -> {topic_id, confidence, via, learn: [{alias, kind}], name?, held?, sitting_id?}
 *    | {topic_id: null, candidates: [{id, name, category_id, score, via}], queue, held?, sitting_id?}
 * texts: ordered names, most explicit first ([condition, topic] from the Anki log, [gap.topic], [analysis.topic]).
 * exact: true (links' look-alike heads) stops after the structural parts, with no prefixes or spans.
 * roots: true lets a root-cause topic (a foundation concept) be the answer; otherwise none ever is (withoutRoots).
 */
export async function resolveTopic(env, user, opts = {}) {
  const { system = null, card_id = null, note_id = null, ref = null, topic_id = null, exact = false, source = null, source_ref = null, gap_id = null, roots = false } = opts;
  // A root-cause topic is never a miss's, gap's, card's or label's home (only a link's other end asks for one).
  const clinical = t => (roots || !t || !rootHit(t) ? t : null);
  const aliases = async (...a) => (roots ? fetchAliases(env, user, ...a) : withoutRoots(await fetchAliases(env, user, ...a)));
  let texts = (Array.isArray(opts.texts) ? opts.texts : [opts.texts]).filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, LABEL_MAX));
  const named = texts.length > 0;
  let hint = opts.category_id || resolveCategory(system);
  let hints = hintSystems(opts.category_id || null, opts.category_id ? null : system);
  const extra = {};

  // 0: a topic id given.
  if (topic_id) {
    const t = clinical(await liveTopic(env, user, topic_id));
    if (t) return { topic_id: t.id, name: t.name, confidence: 1, via: 'id', learn: [] };
  }
  // 3 (read first, so its label can join the texts): the ref.
  let refHit = null, uwTexts = [];
  if (ref) {
    const r = await resolveRef(env, user, ref);
    if (r) {
      if (r.held) { extra.held = true; extra.sitting_id = r.sitting_id; }
      else if (r.sitting_id) extra.sitting_id = r.sitting_id;
      if (r.topic_id) refHit = clinical(await liveTopic(env, user, r.topic_id));
      if (!refHit && r.texts && r.texts.length && r.uworld_label && named) uwTexts = r.texts.filter(t => !texts.includes(t));
      else if (!refHit && r.texts && r.texts.length) texts = texts.concat(r.texts.filter(t => !texts.includes(t)));
      if (!hint && r.system) { hint = resolveCategory(r.system); hints = hintSystems(null, r.system); }
      extra.ref_label = r.label || null;
    }
  }
  const planned = plan(texts, { exact });
  const data = texts.length ? await aliases(planned.keys, planned.cutKeys) : { byKey: new Map(), prefix: new Map() };

  // 1: the most explicit text, exactly.
  const firstOnly = texts.length ? decide({ items: planned.items.slice(0, 1).map(it => ({ ...it, cand: { ...it.cand, parts: it.cand.parts.slice(0, 1) } })) },
    data, hints, { exact: true }) : null;
  if (firstOnly && firstOnly.topic_id) return { ...firstOnly, ...extra };
  // 2: the card or note.
  if (card_id != null || note_id != null) {
    const id = await cardTopic(env, user, card_id, note_id);
    const t = id ? clinical(await liveTopic(env, user, id)) : null;
    if (t) return { topic_id: t.id, name: t.name, confidence: 0.95, via: 'card', learn: [], ...extra };
  }
  // 3: the ref's own placed question, when no text named a topic.
  if (refHit && !named) return { topic_id: refHit.id, name: refHit.name, confidence: ACCEPT, via: 'ref', learn: [], ...extra };
  // 4 to 6.
  let d = texts.length ? decide(planned, data, hints, { exact, skipFirst: false }) : { topic_id: null, hits: [] };
  if (!d.topic_id && uwTexts.length && !d.ambiguous && !(d.hits || []).length) {
    const uwPlan = plan(uwTexts, { exact });
    const uw = decide(uwPlan, await aliases(uwPlan.keys, uwPlan.cutKeys), hints, { exact });
    if (uw.topic_id) return { ...uw, via: `${uw.via}+uworld`, learn: [], ...extra };
    d = { ...d, hits: uw.hits || [] };
  }
  hint = hintId(hint);
  if (d.topic_id) return { ...d, ...extra };

  // 7: unresolved.
  let cands = [];
  for (const h of d.hits || []) if (!cands.some(c => c.id === h.id)) cands.push({ id: h.id, name: h.name, category_id: h.category_id, unit_id: h.unit_id, score: 0.6, via: 'alias' });
  // A name that differs only in "during", "in" or "of" ("Physiologic changes during pregnancy") is offered first. Folded
  // here, for candidates only: norm() and the stored alias keys never fold them.
  if (texts.length && !exact) {
    const fk = foldedKeys(texts);
    if (fk.length) {
      const fd = await aliases(fk);
      for (const k of fk) for (const h of fd.byKey.get(k) || []) if (!cands.some(c => c.id === h.id)) cands.unshift({ id: h.id, name: h.name, category_id: h.category_id, unit_id: h.unit_id, score: FOLD_SCORE, via: 'fold' });
    }
  }
  const room = refHit ? 4 : 5;
  if (cands.length < room && texts.length && !exact) {
    for (const c of await nearTopics(env, user, texts, hint, new Set([...cands.map(x => x.id), ...(refHit ? [refHit.id] : [])]))) if (cands.length < room) cands.push(c);
  }
  if (refHit) {
    cands = cands.filter(c => c.id !== refHit.id);
    const best = cands.length && named ? Math.max(...cands.map(c => c.score)) : null;
    const ref = { id: refHit.id, name: refHit.name, category_id: refHit.category_id, score: best == null ? ACCEPT : Math.max(0, Math.round(best * 100 - 5) / 100), via: 'ref' };
    if (best == null) cands.unshift(ref); else cands.push(ref);
  }
  if (!roots) cands = cands.filter(c => !rootHit(c));
  cands = cands.slice(0, 5);
  const queue = queueItem(user, { texts, source, source_ref, gap_id, card_id, system, hint, cut: texts.some(isCut), ref_label: extra.ref_label, candidates: cands.map(c => ({ id: c.id, name: c.name, score: c.score })) });
  return { topic_id: null, candidates: cands.slice(0, 5), queue, ...extra };
}

// ---------------------------------------------------------------- search

/**
 * searchTopics(env, user, {q, category?, kind?, status?, limit ≤ 20}) behind map_search and GET /api/map/search.
 * Ranks exact 1.0, colon / vs / head 0.9, key prefix 0.8 (shorter keys first), word span 0.7; yield breaks ties.
 * status: 'proposed' | 'confirmed' | 'any' (default: proposed and confirmed).
 */
export async function searchTopics(env, user, { q, category = null, kind = null, status = null, limit = 10 } = {}) {
  const text = String(q ?? '').trim().slice(0, 120);
  const key = norm(text);
  if (!key) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  const cand = candidates(text);
  const parts = cand.parts;
  const statuses = status === 'any' ? ['proposed', 'confirmed', 'retired'] : status === 'proposed' || status === 'confirmed' ? [status] : ['proposed', 'confirmed'];
  const filter = `AND t.status IN (SELECT value FROM json_each(?3)) AND (?4 IS NULL OR t.category_id = ?4 OR t.category2_id = ?4) AND (?5 IS NULL OR t.kind = ?5)`;
  const cols = `SELECT DISTINCT t.id, t.name, t.short_name, t.kind, t.category_id, t.status, t.unit_id, t.yield, a.alias_key AS key FROM topic_aliases a
    JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id WHERE a.user_id = ?1 AND a.status = 'active'`;
  const args = [user, null, JSON.stringify(statuses), category || null, kind || null];
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`${cols} AND a.alias_key IN (SELECT value FROM json_each(?2)) ${filter} LIMIT 200`).bind(user, JSON.stringify(parts.map(p => p.key)), ...args.slice(2)),
      env.DB.prepare(`${cols} AND a.alias_key >= ?2 AND a.alias_key < ?2 || '~' ${filter} ORDER BY length(a.alias_key) LIMIT 60`).bind(user, key, ...args.slice(2)),
    ]);
  } catch (e) { if (noTable(e)) return []; throw e; }
  // The word-prefix search reads every alias (about 2,000 rows a call, PERF5), and its matches score 0.75: it is asked
  // for only when fewer than n topics already score above that, so the top n are exactly what the three searches gave.
  const wordPrefix = () => env.DB.prepare(`${cols} AND a.alias_key LIKE '% ' || ?2 || '%' ${filter} ORDER BY length(a.alias_key) LIMIT 40`)
    .bind(user, key, ...args.slice(2)).all();
  const viaOf = new Map(parts.map(p => [p.key, p.via]));
  const best = new Map();
  const consider = (r, score, matched_on) => {
    const cur = best.get(r.id);
    if (!cur || score > cur.score || (score === cur.score && r.key.length < cur.keyLen)) {
      best.set(r.id, { id: r.id, name: r.name, short_name: r.short_name, kind: r.kind, category_id: r.category_id, status: r.status, unit_id: r.unit_id,
        yield: r.yield, score, matched_on, keyLen: r.key.length });
    }
  };
  for (const r of res[0].results || []) {
    const via = viaOf.get(r.key);
    consider(r, via === 'full' ? 1 : via === 'span' ? 0.7 : 0.9, via === 'full' ? 'exact' : via);
  }
  for (const r of res[1].results || []) consider(r, 0.8, 'prefix');
  if ([...best.values()].filter(b => b.score > 0.75).length < n) {
    let third;
    try { third = await wordPrefix(); } catch (e) { if (noTable(e)) third = { results: [] }; else throw e; }
    for (const r of third.results || []) consider(r, 0.75, 'word_prefix');
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.keyLen - b.keyLen || b.yield - a.yield).slice(0, n)
    .map(({ keyLen, ...r }) => r);
}

// ---------------------------------------------------------------- the queue re-run

export const REQUEUE_MAX = 50;

/**
 * The open items a set of new keys may place, best match first (pure): the item's key is a new key (4), contains one
 * as whole words (3), is a cut label one starts with (3), or shares words with one (1 + the share of its words). Items
 * sharing no word are left out; ties keep the queue's own order (refs, then age).
 */
export function rankRequeue(open, newKeys) {
  const keys = uniq((newKeys || []).filter(Boolean));
  const words = new Set(keys.flatMap(k => k.split(' ')).filter(w => w.length >= 3));
  const scored = [];
  (open || []).forEach((it, i) => {
    const k = it.label_norm || '';
    const kw = k.split(' ').filter(Boolean);
    let score = 0;
    if (keys.includes(k)) score = 4;
    else if (keys.some(nk => ` ${k} `.includes(` ${nk} `))) score = 3;
    else if (isCut(it.label_raw) && keys.some(nk => nk.startsWith(k))) score = 3;
    else {
      const shared = kw.filter(w => words.has(w)).length;
      if (shared) score = 1 + shared / kw.length;
    }
    if (score > 0) scored.push({ it, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.it);
}

/**
 * After an alias or topic write: re-resolve up to 50 open label and look-alike queue items whose key shares a
 * word with the new keys (or a cut item whose key starts one of them), and place the confident ones in one
 * follow-up change (actor code, via 'requeue'). Returns {checked, placed, batch_id?}. Two reads and one write.
 */
export async function requeueOpen(env, user, keys, { now = Date.now(), apply = null } = {}) {
  const newKeys = uniq((keys || []).map(norm).filter(Boolean));
  if (!newKeys.length) return { checked: 0, placed: 0 };
  let open;
  try {
    open = (await env.DB.prepare(`SELECT id, kind, label_norm, label_raw, context_json FROM topic_queue WHERE user_id = ? AND status = 'open'
        AND kind IN ('label','lookalike','gap') ORDER BY refs DESC, first_seen_at LIMIT 400`).bind(user).all()).results || [];
  } catch (e) { if (noTable(e)) return { checked: 0, placed: 0 }; throw e; }
  open = open.filter(it => it.kind !== 'gap' || (it.label_raw && !/^Gap\b/.test(it.label_raw)));
  // Ranked by how well each item matches the new names before the cut (release-2 fixes: the first 50 sharing any
  // word, by refs, let common words like "syndrome" crowd out the items a new alias actually places).
  const items = rankRequeue(open, newKeys).slice(0, REQUEUE_MAX);
  if (!items.length) return { checked: 0, placed: 0 };
  const plans = items.map(it => ({ it, p: plan([it.label_raw]) }));
  const data = await fetchAliases(env, user, uniq(plans.flatMap(x => x.p.keys)), uniq(plans.flatMap(x => x.p.cutKeys)));
  const clinical = withoutRoots(data);
  const placements = [];
  for (const { it, p } of plans) {
    let ctx = {};
    try { ctx = JSON.parse(it.context_json || '{}'); } catch { ctx = {}; }
    // Only a concept's own item (concepts.js, context.source 'concept') may land on a root-cause topic.
    const d = decide(p, ctx.source === 'concept' ? data : clinical, hintSystems(ctx.category_hint || null, ctx.category_hint ? null : ctx.system));
    if (d.topic_id && d.confidence >= ACCEPT) placements.push({ queue_id: it.id, topic_id: d.topic_id });
  }
  if (!placements.length) return { checked: items.length, placed: 0 };
  const run = apply || (async (...a) => (await import('./change.js')).applyChange(...a));
  const r = await run(env, user, { actor: 'code', surface: 'code', op: 'queue.resolve', args: { items: placements }, via: 'requeue' });
  return { checked: items.length, placed: r && r.ok ? placements.length : 0, batch_id: r && r.batch_id, refused: r && r.refused ? r.reason : undefined };
}

/**
 * Misconceptions kept by name because their topic was not on the map (teach_memory_save in "log this", "gap:",
 * the Teaching page) join the topic once a name of it is added: [{key, topic_id}] from a change's alias.added and
 * topic.added events. One read, then one code batch (each row's event says where it went). Returns {linked}.
 */
export async function relinkMisconceptions(env, user, named, { now = Date.now() } = {}) {
  const byKey = new Map((named || []).filter(x => x && x.key && x.topic_id).map(x => [norm(x.key), x.topic_id]));
  if (!byKey.size) return { linked: 0 };
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT m.id, m.topic_name FROM misconceptions m WHERE m.user_id = ? AND m.topic_id IS NULL AND m.topic_name IS NOT NULL LIMIT 300`)
      .bind(user).all()).results || [];
  } catch (e) { if (noTable(e)) return { linked: 0 }; throw e; }
  const hits = rows.map(r => ({ r, topic: byKey.get(norm(r.topic_name)) })).filter(x => x.topic);
  if (!hits.length) return { linked: 0 };
  const { writeBatch } = await import('./events.js');
  await writeBatch(env, user, { actor: 'code', surface: 'code', via: 'requeue:misconceptions', undoable: false,
    rows: hits.map(({ r, topic }) => ({ table: 'misconceptions', op: 'update', key: { id: r.id }, before: { topic_id: null }, after: { topic_id: topic, updated_at: now } })),
    events: hits.map(({ r, topic }) => ({ kind: 'misconception.saved', target_type: 'misconception', target_id: r.id, topic_id: topic,
      summary: `Misconception now on the map: ${String(r.topic_name).slice(0, 120)}` })),
    recompute: [] });
  return { linked: hits.length };
}

/** requeueOpen for the names a finished change added (its alias.added and topic.added events), in waitUntil. */
export async function requeueAfter(env, user, batchId, ctx = null, opts = {}) {
  if (!batchId) return { checked: 0, placed: 0 };
  const job = (async () => {
    let rows = [];
    try {
      rows = (await env.DB.prepare(`SELECT kind, after_json FROM map_events WHERE user_id = ? AND batch_id = ? AND kind IN ('alias.added','topic.added')`)
        .bind(user, batchId).all()).results || [];
    } catch (e) { if (noTable(e)) return { checked: 0, placed: 0 }; throw e; }
    const keys = [], named = [];
    for (const r of rows) {
      try {
        const a = JSON.parse(r.after_json || '{}');
        if (a.alias_key) { keys.push(a.alias_key); if (a.topic_id) named.push({ key: a.alias_key, topic_id: a.topic_id }); }
        else if (a.name) { keys.push(a.name); if (a.id) named.push({ key: a.name, topic_id: a.id }); }
      } catch { /* skip */ }
    }
    // Beliefs logged on a topic before it was on the map join it now (LRN3-8).
    try { await relinkMisconceptions(env, user, named, opts); } catch (e) { console.error('misconceptions relink failed', e && e.message); }
    // Misses the change placed, and those the requeue places, bring their look-alikes onto the map (ingestion's own
    // pass, as a code follow-up: plan §8).
    // Two of these can overlap (Claude's placements come one call after another): a batch that lost the race on a
    // new link's unique key is planned and written again once (B3-7), so its placements are never dropped.
    const { raceRetry, lookAlikesAfter } = await import('./ingest/hub.js');
    const links = async id => { try { await raceRetry(() => lookAlikesAfter(env, user, id)); } catch (e) { console.error('look-alikes after placing failed', e && e.message); } };
    await links(batchId);
    const out = await raceRetry(() => requeueOpen(env, user, keys, opts));
    if (out && out.batch_id) await links(out.batch_id);
    return out;
  })().catch(e => { console.error('requeueAfter failed', e && e.message); return { checked: 0, placed: 0, error: true }; });
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(job); return { scheduled: true }; }
  return job;
}
