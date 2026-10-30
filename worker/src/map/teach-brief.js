import { json, readJson, londonDay, questionLink } from '../util.js';
import { listQueue } from './topics.js';
import { leaks } from '../checks.js';
import { applyChange, changeResponse } from './change.js';
import { leakIndexFor, stemSafe, questionSafe, gapSafe } from './guard.js';
import { rankTopicsFor, choose, whyLine as pickWhy, laneOf, yieldOf, tablesPresent, NO_LESSON_ERRORS, keptLesson } from './teach-priority.js';
import { memoryRows, selectMemory, tacticBrief, contentTypeOf, briefMisconceptions, CONTENT_TYPES, FAVOURITES, TACTIC_VOCAB } from './teach-memory.js';
import { methodBlock, METHOD_VERSION } from './teach-method.js';
import { mehlmanFor, ruleParts } from './mehlman.js';
import { resolveTopic, searchTopics, liveTopic } from './resolve.js';
import { lookAlikes, pairBrief } from './links-store.js';
import { pullNewIfStale } from './sync.js';
import { whyLine as scoreWhy } from './weakness.js';
import { getPrefs } from '../users.js';
import { dueOn } from './cards.js';
import { topicObjectives } from './uworld-objectives.js';
import { rankJoin, RANK_COLS, examRankText } from '../exam-ranks.js';
import { errorKeyOf } from './weights.js';
import { briefPatternStatements, shapeBriefPatterns, PATTERN_TABLES } from './habits.js';

export const BRIEF_CAP = 14_000;
export const WALL_MS = 3000, PULL_MS = 1500, SOURCE_MS = 2500;
export const MODES = ['lesson', 'pair', 'pair_test', 'patch'];
export const SURFACES = ['voice', 'chat', 'code'];
export const FORBIDDEN_KEYS = ['correct_reasoning', 'why_wrong_options', 'right_reasoning', 'other_options', 'stem'];
const MAP_SUFFIX = /\(map:\s*([a-z0-9._-]+)(?:\s*,\s*([a-z0-9._-]+))?\s*\)/i;
const VS = /\s+(?:vs\.?|versus)\s+/i;
const DAY_MS = 86_400_000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t || null; };
const newLessonId = () => 'L' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const waitUntilOf = ctx => (ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx)
  : ctx && ctx.executionCtx && typeof ctx.executionCtx.waitUntil === 'function' ? ctx.executionCtx.waitUntil.bind(ctx.executionCtx) : null);

// PAN's card refresh, loaded when first used (a literal path, so wrangler bundles it); the tests swap it with _setIo.
const io = {
  refreshSources: async (...a) => {
    const m = await import('./sources.js');
    if (typeof m.refreshSources !== 'function') throw new Error('refreshSources is not in sources.js');
    return m.refreshSources(...a);
  },
  // Release 2.5 (MORNING): today's two-topic offer and the topic's "What you know" summary.
  morning: () => import('./morning.js'),
  knowledgeBrief: async (...a) => (await import('./knowledge.js')).knowledgeBriefFor(...a),
  library: async (...a) => (await import('../library/search.js')).libraryBrief(...a),
};
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

// ---------------------------------------------------------------- arguments (pure)

/** "Teach me X (map: a, b)" / "X vs Y": {text, ids: [a, b?], vs: [x, y] | null}. */
export function parseTopic(topic) {
  const s = String(topic || '').trim();
  const m = MAP_SUFFIX.exec(s);
  const ids = m ? [m[1], m[2]].filter(Boolean).map(x => x.toLowerCase()) : [];
  const text = s.replace(MAP_SUFFIX, '').replace(/^(teach me|test me on)\s+/i, '').trim();
  const parts = text.split(VS).map(x => x.trim()).filter(Boolean);
  return { text, ids, vs: parts.length === 2 ? parts : null };
}

const ARG_KEYS = ['topic', 'pair', 'from_miss', 'mode', 'surface', 'voice', 'skip', 'lesson_id', 'peek'];
export function checkArgs(a) {
  if (!isObj(a)) return 'teach_next takes an object.';
  for (const k of Object.keys(a)) if (!ARG_KEYS.includes(k)) return `Unknown argument ${k}.`;
  for (const [k, n] of [['topic', 120], ['pair', 120], ['from_miss', 40], ['lesson_id', 40]]) {
    if (a[k] != null && (typeof a[k] !== 'string' || !a[k].trim() || a[k].length > n)) return `${k} is text of at most ${n} characters.`;
  }
  if (a.mode != null && !MODES.includes(a.mode)) return `mode is one of ${MODES.join(', ')}.`;
  if (a.surface != null && !SURFACES.includes(a.surface)) return `surface is one of ${SURFACES.join(', ')}.`;
  if (a.skip != null && (!Array.isArray(a.skip) || a.skip.length > 10 || a.skip.some(x => typeof x !== 'string' || x.length > 120))) return 'skip is a list of at most 10 topic ids.';
  for (const k of ['peek', 'voice']) if (a[k] != null && typeof a[k] !== 'boolean') return `${k} is true or false.`;
  return null;
}

const TRAP = /\b(?:trap|traps|avoid|contraindicat\w*|withhold|never (?:give|use|start|do|order)|do not (?:give|use|start|order)|don'?t (?:give|use|start|order))\b/;
const TREAT = /\b(?:give|start|treat|treatment|manage|management|surgery|surgical|operate|drain|stop|switch|prescribe|admit|refer|repair|intubate|intubation|transfuse|transfusion|antibiotics?|therapy|dose|untwist|resect|resection|decompress|decompression|detorsion|reduce|cardiovert|cardioversion|anticoagulate|anticoagulation|deliver|delivery|induce|excise|excision)\b/;
const CONTRAST = /\b(?:versus|vs|rather than|distinguish\w*|tells? (?:them )?apart|unlike|instead of)\b/;
const TEST = /\b(?:test|tests|testing|order|check|measure|ct|cta|mri|x-?ray|ultrasound|ecg|ekg|echo\w*|biopsy|levels?|cultures?|serolog\w*|scan|screen|screening|workup|work-up|labs?|smear|gradient|spirometr\w*|pft|d-dimer|angiogra\w*|endoscop\w*|colonoscop\w*|bronchoscop\w*|sigmoidoscop\w*|egd|lumbar puncture|paracentesis|thoracentesis|urinalysis|tsh)\b/;
export function fiveStepOf(text) {
  const { then } = ruleParts(text);
  const s = String(then || text || '').toLowerCase();
  if (!s) return null;
  if (TRAP.test(s)) return 'trap';
  if (TREAT.test(s)) return 'treat';
  // "then thyroiditis, not Graves": a contrast with a named condition (capital letter after "not").
  if (CONTRAST.test(s) || /\bnot\s+(?:an?\s+)?[A-Z]/.test(String(then || text || ''))) return 'distinguish';
  if (TEST.test(s)) return 'test';
  if (/\bnot\b/.test(s)) return 'distinguish';
  // A Then-clause that names what it is ("then retinitis pigmentosa", "then it is ...") is recognition.
  if (then && !/\b(?:because|so|which|that|when|while|since)\b/.test(s) && s.split(/\s+/).length <= 12) return 'recognise';
  return null;
}

// An Anki re-test rule as a ready question and its answer: "If X, then Y." -> "X: what then?" / "Y".
export function ruleQuestion(rule) {
  const { if: c, then } = ruleParts(rule);
  return c && then ? { q: `${cap(c, 160)}: what then?`, a: cap(then, 200) } : null;
}

// ---------------------------------------------------------------- reads

async function readLesson(env, user, id) {
  try { return await env.DB.prepare(`SELECT * FROM lessons WHERE user_id = ? AND id = ?`).bind(user, id).first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

export async function resolveFromMiss(env, user, ref) {
  const s = String(ref).trim();
  try {
    if (/^gap:/i.test(s)) {
      const g = await env.DB.prepare(`SELECT id, topic_id, held, error_type FROM gaps WHERE user_id = ? AND id = ?`).bind(user, s.slice(4)).first();
      return g ? { topic_id: g.topic_id, gap_id: g.id, held: g.held, error_type: g.error_type } : null;
    }
    const anki = /^anki[:\s#]*(\d+)$/i.exec(s);
    const m = await env.DB.prepare(`SELECT id, topic_id, held, error_type, sitting_id FROM misses WHERE user_id = ?1 AND deleted_at IS NULL
        AND (id = ?2 OR anki_mistake_id = ?3 OR upper(label) = upper(?2) OR (uw_qid IS NOT NULL AND uw_qid = ?4)) ORDER BY at DESC LIMIT 1`)
      .bind(user, s, anki ? Number(anki[1]) : -1, (/^(?:uw(?:orld)?\s*)?(\d{3,7})$/i.exec(s) || [])[1] || '').first();
    return m ? { topic_id: m.topic_id, miss_id: m.id, held: m.held, error_type: m.error_type } : null;
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

/**
 * Everything the brief reads about the pick, in one D1 batch: the topic with unit, category and stored score;
 * aliases; up to 5 live misses; the gaps of the last 30 days; cards; past lessons; the topic's (and its pair's)
 * misconceptions; the tactic scores; the newest what-clicked lines; the newest seq. Misses are read column by
 * column, so the two long Anki fields and right_reasoning never come back.
 */
export async function briefReads(env, user, { topicId, pairTopicId = null, now, today }) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const t = topicId || '';
  const has = await tablesPresent(env, user, ['card_topics', 'card_cache', 'topic_notes', 'misconceptions', 'tactic_scores', ...PATTERN_TABLES]);
  const patterns = PATTERN_TABLES.every(n => has.has(n)) && has.has('misconceptions') ? briefPatternStatements(env, user, t) : [];
  const none = () => q(`SELECT NULL AS id WHERE 0 AND ? = ?`, user, t);
  const cardsSql = has.has('card_topics') && has.has('card_cache')
    ? q(`SELECT c.card_id, c.note_id, c.question, c.answer, c.vs, c.schedule, c.image_count, c.lapses, c.fetched_at, ct.match FROM card_topics ct
       JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
       WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.removed_at IS NULL AND c.deleted_at IS NULL AND (ct.strong = 1 OR ct.match <> 'search')
       ORDER BY ct.match = 'miss' DESC, ct.strong DESC, c.lapses DESC LIMIT 4`, user, t)
    : q(`SELECT NULL AS card_id WHERE 0 AND ? = ?`, user, t);
  // Every linked card's schedule, for the reviews that close the lesson (dueOn picks today's).
  const dueSql = has.has('card_topics') && has.has('card_cache')
    ? q(`SELECT c.card_id, c.note_id, c.question, c.schedule, c.fetched_at FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
       WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.removed_at IS NULL AND c.deleted_at IS NULL AND (ct.strong = 1 OR ct.match <> 'search')
         AND c.schedule IS NOT NULL AND c.schedule NOT LIKE 'new%' AND c.schedule NOT LIKE '%suspended%' LIMIT 40`, user, t)
    : q(`SELECT NULL AS card_id WHERE 0 AND ? = ?`, user, t);
  const res = await env.DB.batch([
    q(`SELECT t.id, t.name, t.kind, t.category_id, t.yield, t.amboss_url, c.name AS category, u.num AS unit_num, u.name AS unit_title, u.lane, u.mehlman_rank, ${RANK_COLS},
         s.seen, s.t, s.band, s.certainty, s.why_json, s.last_question_at, s.last_miss_at
       FROM topics t LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
       ${rankJoin('u')}
       LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id WHERE t.user_id = ? AND t.id = ?`, user, t),
    q(`SELECT alias FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active' ORDER BY length(alias) LIMIT 12`, user, t),
    q(`SELECT id, label, day, at, source, result, confidence, time_s, slow, error_type, my_reasoning, reasoning_source, rule, look_alikes, next_retest_day,
         anki_mistake_id, block_id, sitting_id, q_index, step FROM misses WHERE user_id = ? AND topic_id = ? AND held = 0 AND deleted_at IS NULL ORDER BY at DESC LIMIT 5`, user, t),
    q(`SELECT id, day, at, source, origin, gap, said, card_id, ref, error_type, mixed_with, step, confidence FROM gaps WHERE user_id = ? AND topic_id = ? AND held = 0 AND at >= ?
       ORDER BY origin = 'stated' DESC, at DESC LIMIT 6`, user, t, now - 30 * DAY_MS),
    cardsSql,
    q(`SELECT l.id, l.day, l.kind, l.status, l.abandon_reason, l.goal, l.outcome, l.weak_spot, l.memory_used_json, l.probe_json, l.steps_json, l.tactics_json, l.mo_rating, l.what_clicked, l.started_at, l.ended_at FROM lessons l
       WHERE l.user_id = ?1 AND (l.status = 'done' OR (l.status = 'abandoned' AND (l.abandon_reason = 'stopped_early'
           OR (l.abandon_reason = 'timeout' AND l.started_at IS NOT NULL)))) AND (l.topic_id = ?2 OR l.pair_topic_id = ?2)
         AND coalesce(l.kind, 'lesson') <> 'pair_test'
       ORDER BY l.ended_at DESC LIMIT 3`, user, t),
    has.has('misconceptions')
      ? q(`SELECT id, topic_id, belief, words, ref, status, seen_n, first_seen, last_seen FROM misconceptions WHERE user_id = ?1 AND status <> 'closed'
           AND topic_id IN (?2, ?3) ORDER BY last_seen DESC LIMIT 6`, user, t, pairTopicId || t)
      : none(),
    has.has('tactic_scores') ? q(`SELECT content_type, tactic, wins, losses, uses, clicked_n FROM tactic_scores WHERE user_id = ? LIMIT 100`, user) : none(),
    q(`SELECT l.day, l.topic_id, coalesce(tp.name, l.topic_name) AS topic, l.what_clicked FROM lessons l LEFT JOIN topics tp ON tp.user_id = l.user_id AND tp.id = l.topic_id
       WHERE l.user_id = ?1 AND l.status = 'done' AND l.what_clicked IS NOT NULL ORDER BY l.topic_id = ?2 DESC, l.ended_at DESC LIMIT 3`, user, t),
    q(`SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?`, user),
    dueSql,
    // Does lessons have memory_brought_json yet (migration 0039)? In the same batch, so it costs no query.
    env.DB.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'lessons' AND sql LIKE '%memory_brought_json%'`),
    ...patterns,
  ]);
  const [topic, aliases, misses, gaps, cards, past, miscs, tactics, clicked, seq, due, brought, ...pat] = res.map(r => r.results || []);
  return { topic: topic[0] || null, aliases: aliases.map(a => a.alias), misses, gaps, cards, past, misconceptions: miscs, tactics, clicked, seq: (seq[0] || {}).seq || 0,
    due: dueOn(due, today, londonDay), brought_col: !!(brought[0] && brought[0].n), patterns: patterns.length ? shapeBriefPatterns(pat) : null };
}

// ---------------------------------------------------------------- shaping (pure)

const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const fmtDay = ms => (ms ? new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }) : 'earlier');

export function shapeMisses(misses, origin = null) {
  return misses.map(m => ({
    id: m.id, label: m.label, ...(m.sitting_id && m.q_index != null && questionLink(origin, m.sitting_id, m.q_index) ? { link: questionLink(origin, m.sitting_id, m.q_index) } : {}), day: m.day, result: m.result, confidence: m.confidence ?? null, time_s: m.time_s ?? null, slow: !!m.slow,
    error_type: m.error_type ?? null, my_reasoning: cap(m.my_reasoning, 300), rule: cap(m.rule, 300), look_alike: cap(m.look_alikes, 300),
    ...(m.step ? { step: m.step } : {}),
  }));
}

export function shapeGaps(gaps) {
  return gaps.slice(0, 3).map(gapSafe).map(g => ({ gap_id: g.id, day: g.day, source: g.source, origin: g.origin || 'stated', words: cap(g.said || g.gap, 200),
    ...(g.card_id ? { card_id: g.card_id } : g.ref ? { ref: g.ref } : {}),
    ...(g.step ? { step: g.step } : {}), ...(g.mixed_with ? { mixed_with: g.mixed_with } : {}), ...(g.confidence ? { confidence: g.confidence } : {}) }));
}

export function stoppedRecently(past, now) {
  const p = (past || [])[0];
  return p && p.status === 'abandoned' && (p.abandon_reason === 'stopped_early' || keptLesson(p)) && now - (p.ended_at || 0) < 3 * DAY_MS ? p.id : null;
}

export function edgeFromLog({ misses, gaps, past, now, lastLesson }) {
  const recent = now - 21 * DAY_MS;
  const held = [];
  for (const p of past) if (p.outcome === 'landed' && p.goal && held.length < 2) held.push(cap(p.goal, 200));
  for (const m of misses) if (m.result === 'flawed' && m.rule && held.length < 2) held.push(cap(m.rule, 200));
  const broke = misses.filter(m => m.my_reasoning).slice(0, 3).map(m => cap(m.my_reasoning, 200));
  const lessonSince = at => past.some(p => (p.ended_at || 0) > at && !(p.status === 'abandoned' && p.abandon_reason === 'timeout' && !keptLesson(p)));
  // A miss a landed lesson has since worked on no longer shows the edge: that reasoning was already fixed (LRN3-1).
  const landedSince = at => past.some(p => p.outcome === 'landed' && (p.ended_at || 0) > at);
  const probe_saved = misses.some(m => m.at >= recent && !landedSince(m.at) && m.my_reasoning && (m.reasoning_source == null || ['mo', 'hub', 'anki', 'transcript', 'recorder'].includes(m.reasoning_source)))
    || gaps.some(g => (g.origin || 'stated') === 'stated' && g.at >= recent && !lessonSince(g.at));
  // The angle that failed: the tactics the lesson used first (LRN3-6), then its repair angles and the notes it leaned on.
  const failed = lastLesson && lastLesson.outcome === 'not_landed'
    ? { day: lastLesson.day, tactics: [...new Set([...parse(lastLesson.tactics_json, []), ...parse(lastLesson.steps_json, []).map(s => s.repair_angle).filter(Boolean),
      ...parse(lastLesson.memory_used_json, []).map(u => u.id)])].slice(0, 4) } : null;
  return { held, broke, probe_saved, previous_angle_failed: failed };
}

export function teachMoBrief(reads, { lessonId, mode, goalHint, contentType = null, favourites = FAVOURITES, avoid = [] }) {
  const type = CONTENT_TYPES.includes(contentType) ? contentType : contentTypeOf({ mode, topicKind: reads.topic && reads.topic.kind, goalHint });
  const tactics = tacticBrief(reads.tactics || [], { contentType: type, lessonId, favourites, avoid });
  tactics.clicked = (reads.clicked || []).map(c => ({ day: c.day, topic: c.topic || null, text: cap(c.what_clicked, 200) }));
  return { misconceptions: briefMisconceptions(reads.misconceptions || []), tactics };
}

const TRIM = [
  b => { if (b.queue && b.queue.length > 2) { b.queue = b.queue.slice(0, 2); return true; } return false; },
  b => { if (b.past_lessons && b.past_lessons.length > 1) { b.past_lessons = b.past_lessons.slice(0, 1); return true; } return false; },
  b => {
    const m = b.mehlman;
    if (!m || !m.passages || (m.passages.length <= 3 && m.passages.every(p => p.text.length <= 250))) return false;
    m.passages = m.passages.slice(0, 3).map(p => ({ ...p, text: cap(p.text, 250) }));
    return true;
  },
  b => {
    const l = b.library;
    if (!l || !l.passages || (l.passages.length <= 3 && l.passages.every(p => p.text.length <= 400))) return false;
    l.passages = l.passages.slice(0, 3).map(p => ({ ...p, text: cap(p.text, 400) }));
    return true;
  },
  b => { if (b.uworld_objectives && b.uworld_objectives.length > 4) { b.uworld_objectives = b.uworld_objectives.slice(0, 4); return true; } return false; },
  b => { if (b.cards && b.cards.length > 2) { b.cards = b.cards.slice(0, 2); return true; } return false; },
  b => { if (b.misses && b.misses.length > 3) { b.misses = b.misses.slice(0, 3); return true; } return false; },
  b => { if (b.memory && b.memory.length > 4) { b.memory = b.memory.slice(0, 4); return true; } return false; },
  b => { if (b.ready_questions) { delete b.ready_questions; if (b.answers) delete b.answers.ready; return true; } return false; },
  b => { if (b.tactics && b.tactics.clicked && b.tactics.clicked.length > 1) { b.tactics.clicked = b.tactics.clicked.slice(0, 1); return true; } return false; },
  b => { if (b.knowledge && (b.knowledge.related || b.knowledge.mehlman || b.knowledge.closed)) { delete b.knowledge.related; delete b.knowledge.mehlman; delete b.knowledge.closed; return true; } return false; },
  b => { if (b.patterns && b.patterns.habits && b.patterns.habits.length > 1) { b.patterns.habits = b.patterns.habits.slice(0, 1); return true; } return false; },
  b => { if (b.about_mo && b.about_mo.length > 400) { b.about_mo = cap(b.about_mo, 400); return true; } return false; },
];
const size = b => JSON.stringify(b).length;

/** Trims a brief to the cap in the fixed order; fields 1 to 6 (misconceptions included), the method and sources_status are never trimmed. */
export function trimBrief(brief, max = BRIEF_CAP) {
  for (const step of TRIM) {
    if (size(brief) <= max) break;
    step(brief);
  }
  if (size(brief) > max) {   // last resort: long free text in the misses and look-alikes, then the queue goes
    for (const m of brief.misses || []) for (const k of ['my_reasoning', 'rule', 'look_alike']) m[k] = cap(m[k], 120);
    if (size(brief) > max) delete brief.queue;
  }
  return brief;
}

// Every key in a value, at any depth (for the forbidden-keys guard).
export function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

function scrubLeaks(misses, index) {
  let n = 0;
  for (const m of misses) {
    // Every row, hub or not: text that reads like question text never reaches the brief.
    for (const [k, safe] of [['my_reasoning', stemSafe], ['rule', questionSafe], ['look_alike', questionSafe], ['look_alikes', questionSafe]]) if (m[k] && !safe(m[k])) { m[k] = null; n++; }
    if (index && index.size) for (const k of ['my_reasoning', 'rule', 'look_alike', 'look_alikes']) if (m[k] && leaks(index, m[k])) { m[k] = null; n++; }
  }
  return n;
}

// The versus link (active or proposed, any confusion) between a and b, or a's most mixed-up one when b is null.
async function versusLink(env, user, a, b) {
  try {
    return await env.DB.prepare(`SELECT id, from_id, to_id FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active','proposed')
      AND (?3 IS NULL AND (from_id = ?2 OR to_id = ?2) OR (from_id = ?2 AND to_id = ?3) OR (from_id = ?3 AND to_id = ?2))
      ORDER BY confusion DESC LIMIT 1`).bind(user, a, b ?? null).first();
  } catch { return null; }
}

const withWall = (p, ms, onLate) => Promise.race([p, new Promise(r => setTimeout(() => r(onLate), Math.max(0, ms)))]);

// ---------------------------------------------------------------- teachNext

/**
 * teach_next. args (plan §2.3): {topic?, pair?, from_miss?, mode?, surface?, skip?, lesson_id?, peek?}. ctx: {actor?,
 * surface?, via?, request_id?, waitUntil? | executionCtx?, now?}. Returns the brief, {rest: true, ...}, or {refused, reason}.
 */
export async function teachNext(env, user, args = {}, ctx = {}) {
  const t0 = Date.now();
  const bad = checkArgs(args);
  if (bad) return { refused: true, reason: bad };
  const now = ctx.now ?? t0;
  const today = londonDay(now);
  const surface = args.surface || (args.voice ? 'voice' : SURFACES.includes(ctx.surface) ? ctx.surface : 'chat');
  const peek = !!args.peek;
  const wu = waitUntilOf(ctx);
  const left = () => WALL_MS - (Date.now() - t0);

  // 1. What was named: a resumed lesson, "teach me this one", "(map: id)", "X vs Y" or plain text.
  let resume = null, namedIds = [], unresolved = null, fromMiss = null, explicitPair = null, carriesOn = null;
  if (args.lesson_id) {
    resume = await readLesson(env, user, args.lesson_id);
    if (!resume) return { refused: true, reason: 'No lesson has that id.' };
    const carry = resume.status === 'abandoned' && (resume.abandon_reason === 'stopped_early' || keptLesson(resume)) && resume.topic_id;
    if (!carry && !['in_progress', 'requested'].includes(resume.status)) return { refused: true, reason: 'That lesson is finished: say "teach me" for the next one.' };
    namedIds = [resume.topic_id, resume.pair_topic_id].filter(Boolean);
    if (!resume.topic_id && resume.topic_name) unresolved = { text: resume.topic_name, choices: [] };
    if (carry) { carriesOn = resume.id; resume = null; }
  } else if (args.from_miss) {
    fromMiss = await resolveFromMiss(env, user, args.from_miss);
    if (!fromMiss) return { refused: true, reason: `I can't find ${args.from_miss} on the hub yet; give its label (such as UW 4757) or try again in a minute.` };
    if (fromMiss.held) return { refused: true, reason: "That sitting isn't finished, so its results stay hidden until it ends." };
    if (NO_LESSON_ERRORS.includes(errorKeyOf(fromMiss.error_type))) return { refused: true, reason: 'That one was a misread or a test-taking slip: no lesson and no card. Say so to Mo in one sentence.' };
    if (fromMiss.topic_id) namedIds = [fromMiss.topic_id];
    else return { refused: true, reason: 'That miss is not on the map yet: place it with map_queue and map_resolve, or say "teach me" with its topic.' };
  } else if (args.topic || args.pair) {
    // A pair with no topic ("test me on placenta previa", pair only) is taken as the topic, its look-alike found below.
    const topicArg = args.topic || args.pair, pairArg = args.topic ? args.pair : null;
    const p = parseTopic(topicArg);
    if (p.ids.length) namedIds = p.ids;
    else {
      const texts = p.vs || [p.text];
      for (const [i, text] of texts.entries()) {
        const r = await resolveTopic(env, user, { texts: [text], source: 'teach', source_ref: 'teach_next' }).catch(e => { if (noTable(e)) return { topic_id: null, candidates: [] }; throw e; });
        if (r.topic_id && (r.confidence ?? 0) >= 0.85) namedIds[i] = r.topic_id;
        else if (i === 0) {
          let choices = (r.candidates || []).slice(0, 3).map(c => ({ id: c.id, name: c.name }));
          if (choices.length < 3) {
            const more = await searchTopics(env, user, { q: text, limit: 3 }).catch(() => []);
            for (const s of more) if (choices.length < 3 && !choices.some(c => c.id === s.id)) choices.push({ id: s.id, name: s.name });
          }
          unresolved = { text, choices };
        }
      }
      namedIds = namedIds.filter(Boolean);
    }
    if (pairArg) {
      const r = await resolveTopic(env, user, { texts: [parseTopic(pairArg).text], source: 'teach' }).catch(() => ({}));
      if (r && r.topic_id && (r.confidence ?? 0) >= 0.85) explicitPair = r.topic_id;
    }
  }
  if (explicitPair && namedIds.length === 1) namedIds.push(explicitPair);
  // Merged names follow their target; a retired one is unknown.
  for (let i = 0; i < namedIds.length; i++) {
    const t = await liveTopic(env, user, namedIds[i]).catch(() => null);
    if (t) namedIds[i] = t.id;
    else if (i === 0 && !unresolved) { unresolved = { text: args.topic || args.pair ? parseTopic(args.topic || args.pair).text : namedIds[i], choices: [] }; namedIds = []; break; }
  }

  const skip = args.skip || [];
  const rankOpts = { now, today, ids: namedIds, skip, named: namedIds };
  const pullP = pullNewIfStale(env, user, { maxMs: PULL_MS, ctx: wu ? { waitUntil: wu } : null }).catch(e => ({ ran: false, ok: false, error: e && e.message }));
  let [data, pull] = await Promise.all([rankTopicsFor(env, user, rankOpts), pullP]);
  if (pull && pull.added > 0 && data.ok) data = await rankTopicsFor(env, user, rankOpts);
  const sources_status = { anki_new: !pull ? 'skipped' : pull.timed_out ? 'stale' : pull.ran ? (pull.ok ? 'fresh' : 'unreachable') : 'fresh', mehlman: 'pending', cards: 'cached' };
  if (!data.ok) {
    return { lesson_id: null, map_ready: false, method_version: METHOD_VERSION, days_left: data.days_left, phase: data.phase && data.phase.name, surface,
      next_step: 'The map is not set up yet: use list_gaps, list_mistakes and high_yield_notes as before.', method: methodBlock(), sources_status };
  }
  const phase = data.phase;

  // 3. The pick.
  let mode = args.mode || (phase.mode === 'patch' ? 'patch' : 'lesson');
  let choice;
  if (resume && resume.status === 'requested') choice = { served_by: 'request', topic_id: resume.topic_id, request: resume };
  else if (namedIds.length) {
    choice = choose(data, { namedIds, mode, skip: new Set(skip), now });
    // "Teach me X (map: x)" after a Teach me tap on X: this lesson IS the tap, so the tap's row is converted (the
    // same lesson id) instead of staying open and serving X again (RH2-1).
    const tap = (data.requests || []).filter(r => r.topic_id === namedIds[0] && (r.pair_topic_id || null) === (namedIds[1] || null))
      .sort((a, b) => (a.requested_at || 0) - (b.requested_at || 0))[0];
    if (tap && !choice.request) choice = { ...choice, request: tap };
  }
  else if (unresolved) choice = { served_by: 'named', topic_id: null };
  else choice = choose(data, { mode, skip: new Set(skip), now });
  if (choice.rest && !namedIds.length && !unresolved) {
    return { rest: true, lesson_id: null, method_version: METHOD_VERSION, days_left: data.days_left, phase: phase.name, surface,
      say: 'Rest days: no new teaching. Name a topic if you want a 3-minute patch.', method: methodBlock(), sources_status };
  }
  if (choice.none) {
    return { lesson_id: null, nothing_due: true, method_version: METHOD_VERSION, days_left: data.days_left, phase: phase.name, surface,
      say: 'Nothing on the map needs a lesson right now; name a topic to teach.', method: methodBlock(), sources_status };
  }
  if (choice.served_by === 'pick' && !namedIds.length && !unresolved && !resume && !carriesOn && !peek && !skip.length && !args.mode) {
    const offer = await io.morning().then(m => m.offerForTeachNext(env, user, { now })).catch(e => { if (!noTable(e)) console.error('morning offer read failed', e && e.message); return null; });
    if (offer) {
      return { lesson_id: null, offer, method_version: METHOD_VERSION, days_left: data.days_left, phase: phase.name, surface,
        say: cap(`Two for today: ${offer.options.map(o => `${o.topic.name} (${o.reason})`).join(', or ')}.${offer.line ? ` ${offer.line}` : ''}`, 400),
        next_step: 'Offer Mo both, one short line each, and ask which. Then call teach_next once with topic set to his pick\'s prompt. "You choose": the first one. Something else: teach_next with that topic.',
        sources_status };
    }
  }
  if (!peek && skip.length) later(wu, io.morning().then(m => m.noteSkips(env, user, { ids: skip, now, via: surface })));
  if (phase.rest && namedIds.length) mode = 'patch';
  const topicId = choice.topic_id || null;
  let pairTopicId = choice.pair ? choice.pair.topic_id : null;
  let linkId = choice.pair ? choice.pair.link_id : (resume && resume.link_id) || null;
  if (choice.pair && !args.mode && mode === 'lesson') mode = 'pair';
  if (resume) mode = resume.kind || mode;
  if (choice.served_by === 'request' && choice.request && choice.request.kind) mode = choice.request.kind;
  if ((mode === 'pair' || mode === 'pair_test') && !pairTopicId && topicId) {
    const best = (data.links || []).filter(l => l.from_id === topicId || l.to_id === topicId).sort((a, b) => b.confusion - a.confusion)[0];
    if (best) { pairTopicId = best.from_id === topicId ? best.to_id : best.from_id; linkId = best.id; }
  }
  if ((mode === 'pair' || mode === 'pair_test') && topicId && !linkId) {
    const l = await versusLink(env, user, topicId, pairTopicId);
    if (l) { linkId = l.id; if (!pairTopicId) pairTopicId = l.from_id === topicId ? l.to_id : l.from_id; }
  }
  if (mode === 'pair_test' && !linkId) {
    return { refused: true, reason: pairTopicId
      ? 'There is no look-alike link between those two yet: add it with map_add_link, then ask again.'
      : 'This topic has no look-alike on the map yet: name the second topic, or add the link with map_add_link.' };
  }
  if (mode === 'pair' && !pairTopicId) mode = 'lesson';
  const lessonId = resume ? resume.id : choice.request ? choice.request.id : newLessonId();

  const sources = data.profile && Array.isArray(data.profile.sources) ? data.profile.sources : null;
  const useMehlman = !sources || sources.includes('mehlman'), useAnki = !sources || sources.includes('anki_voice');
  const readsP = briefReads(env, user, { topicId, pairTopicId, now, today });
  const mehlmanP = !useMehlman ? Promise.resolve(null) : topicId ? mehlmanFor(env, user, topicId, { timeoutMs: Math.min(SOURCE_MS, Math.max(200, left() - 200)), now, ctx: wu ? { waitUntil: wu } : null })
    : unresolved ? mehlmanFor(env, user, { name: unresolved.text }, { timeoutMs: Math.min(SOURCE_MS, Math.max(200, left() - 200)) }) : Promise.resolve(null);
  const lookP = topicId ? lookAlikes(env, user, topicId, 3).catch(() => []) : Promise.resolve([]);
  const pairP = linkId ? pairBrief(env, user, linkId, lessonId).catch(() => null) : Promise.resolve(null);
  // refreshSources answers a status even when Anki is down ({cards: 'fresh'|'cached'|'unreachable'|'off'|'skipped'}).
  const cardsP = topicId && useAnki ? io.refreshSources(env, user, topicId, { kinds: ['cards'], timeoutMs: Math.min(SOURCE_MS, Math.max(200, left() - 200)) })
    .then(r => (r && r.cards === 'fresh' ? 'fresh' : r && r.cards === 'unreachable' ? 'unreachable' : 'cached'),
      e => (/Cannot find|not in sources|Failed to load|No such module/i.test(String(e && e.message)) ? 'cached' : 'unreachable'))
    : Promise.resolve('cached');
  const prefsP = getPrefs(env, user).catch(() => ({}));
  const knowledgeP = topicId ? io.knowledgeBrief(env, user, topicId).catch(() => null) : Promise.resolve(null);
  const libraryP = topicId ? io.library(env, user, topicId, { ai: env.AI }).catch(e => { if (!noTable(e)) console.error('library brief failed', e && e.message); return null; }) : Promise.resolve(null);
  if (wu && topicId) wu(libraryP);   // a coverage build still running at the wall finishes in the background
  const PENDING = Symbol('pending');
  const objectivesP = topicId ? topicObjectives(env, user, topicId).catch(() => []) : Promise.resolve([]);
  const [reads, mehlman, looks, pair, cardsState, prefs, knowledge, library, uwObjectives] = await Promise.all([
    readsP,
    withWall(mehlmanP.catch(() => ({ status: 'unreachable', match: null, passages: [] })), left(), PENDING),
    withWall(lookP, left(), []),
    withWall(pairP, left(), null),
    withWall(cardsP, left(), 'pending'),
    prefsP,
    withWall(knowledgeP, left(), null),
    withWall(libraryP, left(), PENDING),
    withWall(objectivesP, left(), []),
  ]);
  const pats = reads.patterns || null;
  const teachPrefs = (prefs && prefs.teach) || {};
  const minutesPref = Number(teachPrefs.lesson_minutes);
  const turnWords = Number(teachPrefs.turn_words) > 0 ? Number(teachPrefs.turn_words) : 90;
  const favourites = Array.isArray(teachPrefs.favourites) && teachPrefs.favourites.length ? teachPrefs.favourites.filter(x => TACTIC_VOCAB.includes(x)) : FAVOURITES;
  sources_status.mehlman = !useMehlman ? 'off' : mehlman === PENDING ? 'pending' : mehlman ? mehlman.status : 'unreachable';
  sources_status.cards = cardsState;
  if (topicId) sources_status.library = library === PENDING ? 'pending' : library ? library.status : 'off';
  let { cards, due } = reads;
  if (cardsState === 'fresh' && topicId) ({ cards, due } = await briefReads(env, user, { topicId, pairTopicId, now, today }).catch(() => reads));

  // 5. Shape.
  const row = (topicId && data.byId.get(topicId)) || null;
  // The misses' text is scrubbed once, on copies of the rows themselves, so every part built from them (misses,
  // edge_from_log, ready_questions, the goal hint) carries only what passed.
  const leakIndex = reads.misses.some(m => m.block_id) ? await leakIndexFor(env, user, { missIds: reads.misses.map(m => m.id) }).catch(() => null) : null;
  const safeMisses = reads.misses.map(m => ({ ...m }));
  scrubLeaks(safeMisses, leakIndex);
  const misses = shapeMisses(safeMisses, env.HUB_ORIGIN);
  scrubLeaks(misses, leakIndex);
  const lastLesson = reads.past.find(p => p.status !== 'abandoned') || null;   // the last finished lesson (a stopped one has no outcome)
  const edge = edgeFromLog({ misses: safeMisses, gaps: reads.gaps, past: reads.past, now, lastLesson });
  const memory = selectMemory(await memoryRows(env, user), { topic_id: topicId, category_id: reads.topic && reads.topic.category_id, kind: mode === 'pair' || mode === 'pair_test' ? 'pair' : mode, surface });
  const ready = [], readyAnswers = [];
  for (const c of cards) if (ready.length < 2 && c.question) { ready.push({ ref: `card:${c.card_id}`, q: cap(c.question, 200) }); readyAnswers.push({ ref: `card:${c.card_id}`, a: cap(c.answer, 200) }); }
  for (const m of safeMisses) { const rq = ruleQuestion(m.rule); if (rq && ready.length < 3) { ready.push({ ref: m.id, q: rq.q }); readyAnswers.push({ ref: m.id, a: rq.a }); } }
  const steps = [...safeMisses.map(m => m.step || fiveStepOf(m.rule)), ...reads.gaps.map(g => g.step)].filter(Boolean);
  // The most common step over the topic's misses and gaps; none when nothing says it clearly (Claude sets the goal from the rule).
  const goalHint = steps.length ? steps.sort((a, b) => steps.filter(x => x === b).length - steps.filter(x => x === a).length)[0] : null;
  // After a lesson that did not land, tactics.try never suggests the angle that failed (LRN3-6).
  const avoid = edge.previous_angle_failed ? edge.previous_angle_failed.tactics : [];
  const mo = teachMoBrief(reads, { lessonId, mode, goalHint, contentType: resume && resume.content_type, favourites, avoid });
  const topicName = (reads.topic && reads.topic.name) || (row && row.name) || (unresolved && unresolved.text) || null;
  const extra = { requested_at: choice.request && choice.request.requested_at, gap_at: choice.gap && choice.gap.at };
  const whyChosen = row ? pickWhy({ ...row, previous_angle_failed: !!(lastLesson && lastLesson.outcome === 'not_landed') }, choice.served_by, extra)
    : unresolved ? 'You asked for it; it is not on the map yet.' : 'You asked for it.';
  const t = reads.topic;

  const brief = {
    lesson_id: peek ? null : lessonId, mode, served_by: choice.served_by, method_version: METHOD_VERSION, days_left: data.days_left, phase: phase.name, surface,
    as_of_seq: reads.seq, card_ok: phase.name !== 'final' && phase.name !== 'rest' ? true : data.days_left >= 4, lesson_minutes: mode === 'pair_test' ? 3 : minutesPref > 0 ? minutesPref : phase.lesson_minutes,
    turn_words: turnWords,
    topic: t ? {
      id: t.id, name: t.name, category: t.category || t.category_id, kind: t.kind,
      unit: t.unit_num != null || t.unit_title ? { num: t.unit_num, title: t.unit_title, lane: t.lane, mehlman_rank: t.mehlman_rank,
        exam_rank: examRankText(t.nbme_rank ?? null, t.cms_rank ?? null) || null } : null,
      yield: t.yield, band: t.band || 'unseen', t1000: t.t != null ? Math.round(t.t * 1000) : null, cert100: t.certainty != null ? Math.round(t.certainty * 100) : 0,
      why: scoreWhy({ seen: t.seen, t: t.t, band: t.band, last_question_at: t.last_question_at, last_miss_at: t.last_miss_at }, t.why_json, now),
      why_chosen: whyChosen, ...(t.amboss_url ? { amboss_url: t.amboss_url } : {}),
    } : null,
    runner_ups: (choice.runner_ups || []).map(r => ({ id: r.topic_id, name: r.name, why: cap(r.why, 160) })),
    ...(choice.request ? { requested_by: { from: choice.request.request_from || choice.request.requested_by || 'map', at: choice.request.requested_at } } : {}),
    ...(carriesOn || stoppedRecently(reads.past, now) ? { carries_on: carriesOn || stoppedRecently(reads.past, now) } : {}),
    ...(unresolved ? { new_topic_name: unresolved.text, choices: unresolved.choices } : {}),
    ...(pair || (mode === 'pair' || mode === 'pair_test') ? { pair: pair ? { topic: pair.a.id === topicId ? pair.b : pair.a, link_id: pair.link_id,
      order: pair.order || null, a: pair.a, b: pair.b, vs_a: cap(pair.vs_a, 300), vs_b: cap(pair.vs_b, 300), confusion: pair.confusion }
      : { topic: pairTopicId ? { id: pairTopicId, name: (data.byId.get(pairTopicId) || {}).name || null } : null, link_id: linkId } } : {}),
    gaps: shapeGaps(reads.gaps),
    misconceptions: mo.misconceptions,
    tactics: mo.tactics,
    edge_from_log: edge,
    goal_hint: goalHint,
    misses,
    ...(pats && pats.patterns ? { patterns: pats.patterns } : {}),
    ...(uwObjectives && uwObjectives.length ? { uworld_objectives: uwObjectives.map(o => ({ ref: `UW ${o.qid}`, day: o.day, outcome: o.outcome,
      objective: o.objective ? cap(o.objective, 260) : null })) } : {}),
    look_alikes: (looks || []).slice(0, 3),
    ready_questions: ready,
    cards: cards.map(c => ({ card_id: c.card_id, note_id: c.note_id, case: cap(c.question, 160), answer: cap(c.answer, 200), vs: cap(c.vs, 200),
      schedule: c.schedule, image_count: c.image_count || 0 })),
    ...(due && due.length ? { due_today: due.slice(0, 6).map(c => ({ card_id: c.card_id, note_id: c.note_id, case: cap(c.question, 120) })) } : {}),
    anking_hint: [...new Map([topicName, ...(reads.aliases || [])].filter(Boolean).map(x => [x.toLowerCase(), x])).values()].slice(0, 3),
    ...libraryPart(library, PENDING),
    ...(!useMehlman ? {} : { mehlman: mehlman && mehlman !== PENDING ? { status: mehlman.status, match: mehlman.match,
      passages: library && library !== PENDING && library.passages && library.passages.length >= 2 ? [] : mehlman.passages,
      ...(library && library !== PENDING && library.passages && library.passages.length >= 2 ? { superseded_by: 'library' } : {}) } : { status: 'pending', match: null, passages: [] } }),
    pictures: [],
    past_lessons: reads.past.map(p => (p.status === 'abandoned' && p.abandon_reason === 'timeout' && !keptLesson(p) ? { day: p.day, kind: p.kind, outcome: 'not_saved',
      note: `Started ${fmtDay(p.started_at || p.ended_at)}, not saved: ask him whether to carry on from there or start fresh.` } : { day: p.day, kind: p.kind, goal: cap(p.goal, 200), outcome: p.status === 'abandoned' ? 'stopped_early' : p.outcome, weak_spot: cap(p.weak_spot, 200),
      tactics: [...new Set([...parse(p.tactics_json, []), ...parse(p.steps_json, []).map(s => s.repair_angle).filter(Boolean)])].slice(0, 3),
      mo_rating: p.mo_rating ?? null, what_clicked: cap(p.what_clicked, 200),
      // Stopped with "done" before the final case: the steps covered and how their checks went, so the next lesson
      // recaps them in a line and goes on to the final case instead of starting again at the probe (LRN3-3).
      ...(p.status === 'abandoned' ? { covered: parse(p.steps_json, []).slice(0, 6).map(s => ({ step: cap(s.title, 120), check: s.check || null })) } : {}),
      ...(keptLesson(p) ? { closed: 'no save for 3 h; its checkpoints were kept', probe: parse(p.probe_json, []).slice(0, 4).map(x => ({ q: cap(x.summary, 120), result: x.result || null })) } : {}) })),
    memory,
    ...(pats && pats.about_mo ? { about_mo: pats.about_mo } : {}),
    ...(knowledge && knowledge.lessons ? { knowledge } : {}),
    method: methodBlock(),
    queue: [...(data.requests || []).filter(r => r.id !== lessonId && r.topic_id).slice(0, 2).map(r => ({ id: r.topic_id, name: (data.byId.get(r.topic_id) || {}).name || r.topic_name, why: 'tapped Teach me' })),
      ...(choice.queue || []).map(r => ({ id: r.topic_id, name: r.name, why: cap(r.why, 160) }))].slice(0, 5),
    sources_status,
    answers: { ready: readyAnswers },
  };
  if (surface === 'voice') brief.say = cap(`${topicName ? `${topicName}: ` : ''}${whyChosen}`, 250);
  if (surface !== 'voice') {
    const waiting = await listQueue(env, user, { limit: 1 }).catch(() => null);
    if (waiting && waiting.open) brief.to_place = { open: waiting.open, next_step: `First, quietly place the ${waiting.open} waiting item${waiting.open === 1 ? '' : 's'}: map_queue then map_resolve (25 at a time; an existing topic when one fits, else new_topic in the right system). Then teach.` };
  }
  trimBrief(brief);

  // 6. The lessons row (not for a peek): a new row, a converted tap, or the resumed lesson as it is.
  if (!peek && !(resume && resume.status === 'in_progress')) {
    const start = await applyChange(env, user, {
      actor: ctx.actor || 'claude', surface, op: 'lesson.start', via: ctx.via || 'mcp:teach_next', request_id: ctx.request_id,
      args: { lesson_id: lessonId, topic_id: topicId, topic_name: topicName, pair_topic_id: pairTopicId, link_id: linkId, kind: mode, served_by: choice.served_by,
        why_chosen: whyChosen, priority: row ? Math.round(row.gain * 1000) / 1000 : null, priority_json: row ? JSON.stringify({ Y: row.Y, N: round(row.N), K: row.K, T: row.T, lane: row.lane }) : null,
        miss_ids: misses.map(m => m.id), gap_ids: brief.gaps.map(g => g.gap_id), method_version: METHOD_VERSION,
        content_type: mo.tactics.content_type, tactics_suggested: mo.tactics.try, misc_ids: mo.misconceptions.map(m => m.id),
        from_miss: fromMiss && fromMiss.miss_id ? fromMiss.miss_id : null,
        ...(reads.brought_col ? { memory_ids: (brief.memory || []).filter(m => m && m.pinned).map(m => m.id) } : {}) },
    });
    if (start.refused) return start;
    if (start.seq) brief.as_of_seq = start.seq;
    if (topicId) later(wu, io.morning().then(m => m.noteLessonStart(env, user, { topicId, lessonId, now, via: surface })));
  }
  if (!peek) touchSeen(env, user, brief.as_of_seq, now, wu);
  return brief;
}
const round = x => Math.round(x * 1000) / 1000;
// The brief's `library` (library/search.js libraryBrief): {n, passages: [{cite, doc_id, page, heading, passage_id, text}], more}
// within 1,200 tokens; nothing when the library is empty or not there yet.
function libraryPart(library, PENDING) {
  if (library === PENDING) return { library: { status: 'pending', n: null, passages: [], next_step: 'Search it with map_topic {include: ["library"]}.' } };
  if (!library || library.status === 'off' || (!library.n && !(library.passages || []).length)) return {};
  return { library: { status: library.status, n: library.n, passages: library.passages, ...(library.candidates ? { candidates: library.candidates } : {}), ...(library.use ? { use: library.use } : {}), more: library.more,
    ...(library.more ? { next_step: 'More in his library: map_topic {include: ["library"]}.' } : {}) } };
}
// A bookkeeping hook (morning.js) run beside the reply: in waitUntil when there is one; never fails teach_next.
function later(wu, p) {
  const safe = p.catch(e => { if (!noTable(e)) console.error('morning hook failed', e && e.message); });
  if (wu) wu(safe);
  return safe;
}

// mcp_seen {seq, at} (map_overview's "since you last looked"): stored unless one was stored in the last 30 minutes.
function touchSeen(env, user, seq, now, wu) {
  if (user !== 'mo') return;
  const p = env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('mcp_seen', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value
      WHERE coalesce(json_extract(settings.value, '$.at'), 0) < ?2`).bind(JSON.stringify({ seq, at: now }), now - 30 * 60_000).run()
    .catch(e => console.error('mcp_seen not stored', e && e.message));
  if (wu) wu(p);
}

// ---------------------------------------------------------------- op lesson.start

const START_KEYS = ['lesson_id', 'topic_id', 'topic_name', 'pair_topic_id', 'link_id', 'kind', 'served_by', 'why_chosen', 'priority', 'priority_json',
  'miss_ids', 'gap_ids', 'method_version', 'from_miss', 'content_type', 'tactics_suggested', 'misc_ids', 'memory_ids'];

/** Planner for op lesson.start (teach_next only): a new in_progress row, or a requested row converted. Not undoable. */
export async function planLessonStart(env, user, a, ctx) {
  for (const k of Object.keys(a)) if (!START_KEYS.includes(k)) return { refuse: `Unknown argument ${k}.` };
  if (typeof a.lesson_id !== 'string' || !/^[\w-]{1,40}$/.test(a.lesson_id)) return { refuse: 'lesson_id is missing.' };
  if (!['lesson', 'pair', 'pair_test', 'patch'].includes(a.kind)) return { refuse: 'kind is lesson, pair, pair_test or patch.' };
  const now = ctx.now || Date.now();
  const cur = await readLesson(env, user, a.lesson_id);
  const fields = {
    topic_id: a.topic_id || null, topic_name: a.topic_name ? String(a.topic_name).slice(0, 120) : null, pair_topic_id: a.pair_topic_id || null, link_id: a.link_id || null,
    kind: a.kind, status: 'in_progress', served_by: a.served_by || null, started_at: now, surface: ctx.surface || 'chat', day: londonDay(now),
    why_chosen: a.why_chosen ? String(a.why_chosen).slice(0, 200) : null, priority: a.priority ?? null, priority_json: a.priority_json || null,
    miss_ids_json: JSON.stringify(a.miss_ids || []), gap_ids_json: JSON.stringify(a.gap_ids || []),
    content_type: CONTENT_TYPES.includes(a.content_type) ? a.content_type : null,
    tactics_suggested_json: JSON.stringify((a.tactics_suggested || []).filter(x => TACTIC_VOCAB.includes(x)).slice(0, 2)),
    misc_ids_json: JSON.stringify((a.misc_ids || []).filter(x => typeof x === 'string').slice(0, 6)),
    method_version: a.method_version || METHOD_VERSION, updated_at: now,
    // The pinned notes the brief brought in (migration 0039), so lesson_save asks for memory.used on each.
    ...(Array.isArray(a.memory_ids) ? { memory_brought_json: JSON.stringify(a.memory_ids.filter(x => typeof x === 'string').slice(0, 6)) } : {}),
  };
  const name = fields.topic_name || 'a topic';
  const event = { kind: 'lesson.started', target_type: 'lesson', target_id: a.lesson_id, topic_id: fields.topic_id, undoable: false,
    summary: `${a.kind === 'pair_test' ? 'Pair test' : 'Lesson'} started: ${name}`.slice(0, 160) };
  const refs = { misses: a.from_miss ? [a.from_miss] : [] };
  if (cur) {
    if (cur.status !== 'requested') return { refuse: 'That lesson has already started.' };
    const before = Object.fromEntries(Object.keys(fields).map(k => [k, cur[k] ?? null]));
    return { rows: [{ table: 'lessons', op: 'update', key: { id: cur.id }, before, after: fields }], events: [event], refs, count: 1, summary: event.summary };
  }
  return { rows: [{ table: 'lessons', op: 'insert', key: { id: a.lesson_id }, after: { ...fields, source: 'teach_next', created_by: ctx.actor === 'mo' ? 'mo' : 'claude', created_at: now } }],
    events: [event], refs, count: 1, summary: event.summary };
}

// ---------------------------------------------------------------- op lesson.request (the Teach me tap)

export const PROMPT = ({ kind, a, b }) => (b ? `${kind === 'pair_test' ? 'Test me on' : 'Teach me'} ${a.name} versus ${b.name} (map: ${a.id}, ${b.id})` : `Teach me ${a.name} (map: ${a.id})`);

/**
 * Planner for op lesson.request {topic_id, pair_topic_id?, kind?, from: map|board, device: mac|ipad|phone}: a
 * requested lessons row served first for 24 h (expired at 72 h). A second tap on the same topic within 24 h reuses it.
 */
export async function planLessonRequest(env, user, a, ctx) {
  for (const k of Object.keys(a)) if (!['topic_id', 'pair_topic_id', 'kind', 'from', 'device'].includes(k)) return { refuse: `Unknown field ${k}.` };
  if (typeof a.topic_id !== 'string' || !a.topic_id || a.topic_id.length > 120) return { refuse: 'topic_id is needed.', field: 'topic_id' };
  const kind = a.kind || (a.pair_topic_id ? 'pair' : 'lesson');
  if (!['lesson', 'pair', 'pair_test'].includes(kind)) return { refuse: 'kind is lesson, pair or pair_test.', field: 'kind' };
  if (a.from != null && !['map', 'board', 'panel', 'review', 'today'].includes(a.from)) return { refuse: 'from is map or board.', field: 'from' };
  if (a.device != null && !['mac', 'ipad', 'phone', 'other'].includes(a.device)) return { refuse: 'device is mac, ipad or phone.', field: 'device' };
  const t = await liveTopic(env, user, a.topic_id);
  if (!t) return { refuse: 'That topic is not on the map.', field: 'topic_id' };
  const p = a.pair_topic_id ? await liveTopic(env, user, a.pair_topic_id) : null;
  if (a.pair_topic_id && !p) return { refuse: 'The second topic is not on the map.', field: 'pair_topic_id' };
  if (kind !== 'lesson' && !p) return { refuse: 'A pair needs pair_topic_id.', field: 'pair_topic_id' };
  const now = ctx.now || Date.now();
  let linkId = null;
  if (p) {
    const l = await env.DB.prepare(`SELECT id FROM links WHERE user_id = ? AND type = 'versus' AND status IN ('active','proposed')
      AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).bind(user, t.id, p.id, p.id, t.id).first().catch(() => null);
    linkId = l ? l.id : null;
    if (kind === 'pair_test' && !linkId) return { refuse: 'Those two are not linked as look-alikes yet.', field: 'pair_topic_id' };
  }
  const prompt = PROMPT({ kind, a: t, b: p });
  const open = await env.DB.prepare(`SELECT id, request_from, surface_hint, requested_at, updated_at FROM lessons WHERE user_id = ?1 AND status = 'requested'
      AND topic_id = ?2 AND coalesce(pair_topic_id, '') = ?3 AND kind = ?4 AND requested_at >= ?5 ORDER BY requested_at LIMIT 1`)
    .bind(user, t.id, p ? p.id : '', kind, now - 24 * 3600_000).first();
  const summary = `Teach me tapped: ${p ? `${t.name} versus ${p.name}` : t.name}`.slice(0, 160);
  if (open) {
    const after = { request_from: a.from || open.request_from, surface_hint: a.device || open.surface_hint, updated_at: now };
    return { rows: [{ table: 'lessons', op: 'update', key: { id: open.id }, before: { request_from: open.request_from, surface_hint: open.surface_hint, updated_at: open.updated_at }, after }],
      events: [{ kind: 'lesson.requested', target_type: 'lesson', target_id: open.id, topic_id: t.id, undoable: false, summary }], count: 1, summary,
      reply: { lesson_id: open.id, prompt, reused: true } };
  }
  const id = newLessonId();
  return { rows: [{ table: 'lessons', op: 'insert', key: { id }, after: { topic_id: t.id, topic_name: t.name, pair_topic_id: p ? p.id : null, link_id: linkId, kind,
    status: 'requested', requested_by: ctx.actor === 'claude' ? 'claude' : a.from || 'map', request_from: a.from || 'map', surface_hint: a.device || null, requested_at: now,
    source: 'teach_request', created_by: ctx.actor === 'claude' ? 'claude' : 'mo', created_at: now, updated_at: now } }],
  events: [{ kind: 'lesson.requested', target_type: 'lesson', target_id: id, topic_id: t.id, undoable: false, summary }], count: 1, summary,
  reply: { lesson_id: id, prompt, reused: false } };
}

// ---------------------------------------------------------------- REST

// POST /api/teach/request {topic_id, pair_topic_id?, kind?, from, device} -> {lesson_id, prompt, reused}
export async function requestRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'lesson.request', args: body, via: 'api:POST /api/teach/request' });
  if (r.ok) return json({ lesson_id: r.lesson_id, prompt: r.prompt, reused: r.reused, seq: r.seq });
  return changeResponse(r);
}

// GET /api/teach/lessons?topic=&limit= -> {lessons: [...]}: the panel's and Review page's lesson lines.
export async function lessonsRoute(request, env, ctx, params, url, user) {
  const topic = url.searchParams.get('topic');
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT id, topic_id, topic_name, pair_topic_id, link_id, kind, status, abandon_reason, served_by, request_from, requested_at,
        started_at, ended_at, minutes, surface, day, goal, five_step, outcome, blend, mo_rating, what_clicked, tactics_json, content_type, weak_spot,
        card_id, card_note_id, card_action
      FROM lessons WHERE user_id = ?1 AND (?2 IS NULL OR topic_id = ?2 OR pair_topic_id = ?2)
      ORDER BY coalesce(ended_at, started_at, requested_at) DESC LIMIT ?3`).bind(user, topic || null, limit).all()).results || [];
  } catch (e) { if (!noTable(e)) throw e; }
  return json({ lessons: rows.map(r => ({ ...r, five_step: parse(r.five_step, r.five_step), tactics: parse(r.tactics_json, []), tactics_json: undefined })) });
}

export async function nextRoute(request, env, ctx, params, url, user) {
  const args = { peek: true };
  if (url.searchParams.get('topic')) args.topic = url.searchParams.get('topic').slice(0, 120);
  if (url.searchParams.get('mode')) args.mode = url.searchParams.get('mode');
  const r = await teachNext(env, user, args, { actor: 'mo', surface: 'chat', via: 'api:GET /api/teach/next', executionCtx: ctx });
  return r.refused ? json({ error: r.reason }, 400) : json(r);
}

export { laneOf, yieldOf };
