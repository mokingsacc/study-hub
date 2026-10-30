// The Review page's reads and its two changes (plan §13; owner REV). It reads only board_misses (over
// misses_live, so nothing from an unfinished sitting), units, topics, categories, the stored topic_scores
// (unit chips through weakness's UNIT_SUMMARY_SQL) and checklist_progress. Each read is one D1 batch whose big
// lists D1 builds as JSON text: the page gets them spliced in as they are (board-routes.js), and Claude's
// board_* tools parse the same text and shape it with the page's own public/js/board/shape.js, so the page and
// Claude count, filter and order the same rows the same way.
//
//   logData / tallyData / checklistData / summaryData (env, user, opts)  the raw payload parts
//   errorLog, tally, checklist (env, user, args, ctx)   board_error_log, board_tallies, board_checklist
//   missDetail(env, user, ids, {audience})              the long stored fields of the rows being opened
//   missFromAnki(env, user, id)                          Right reasoning and Other options, live, never stored
//   planChecklistTick, planMissReview                    the planners of ops checklist.tick and miss.review
// Hard rules kept here: Anki's correct_reasoning and why_wrong_options are never stored and never reach Claude
// (only missFromAnki fetches them, for the page); right_reasoning is never in a Claude reply; held rows never
// show; step ticks write self_mastered evidence in the change's own batch; Studied and reviewed move no colour.
import { HttpError, londonDay } from '../util.js';
import { ankiCall } from '../anki.js';
import { leaks } from '../checks.js';
import { leakIndexFor } from './guard.js';
import { summaryFromSql, UNIT_SUMMARY_SQL } from './weakness.js';
import { summaryOf } from './events.js';
import { liveTopic, searchTopics } from './resolve.js';
import { categoryFor } from './vocab.js';
import { UNLOGGED_SQL, unloggedWords } from './retests.js';
import {
  STEPS, STEP_NAMES, LOG_COLS, TALLY_COLS, TOPIC_COLS, CATEGORY_COLS, ERROR_KEYS, TALLY_ORDERS, CHECK_FILTERS, LANES, isDay, addDays,
  rowsOf, mapOf, unitsOf, progressOf, matchFilters, countMisses, logSentence, tallyLines, tallyView, highYieldRows, checklistRows,
  checklistTotals, checklistView, checklistSentence, chipOf, unitCode, plural,
} from '../../../public/js/board/shape.js';

export const LIVE_STATUSES = ['proposed', 'confirmed'];
export const LIMITS = { log: 40, log_default: 15, detail: 10, tally: 60, tally_default: 30, checklist: 60, checklist_default: 40, offset: 5000, review: 25, unit_topics: 20 };
export const ANKI_MS = 4000;
export const ANKI_FIELD_MAX = 1200;
// Never in a reply to Claude, at any depth (the MCP reply layer strips them too).
export const NOT_FOR_CLAUDE = ['right_reasoning', 'other_options', 'correct_reasoning', 'why_wrong_options'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { if (s == null || s === '') return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };
const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

// ------------------------------------------------------------------ SQL
// Every statement names user_id (conventions rule 5). ?1 is always the user.

// The compact row's flag bits (shape.js FLAG): slow, sure and wrong, card made, reviewed, not on the map, in the
// Anki log, a hub question.
const FLAGS_SQL = `(slow | (coalesce(sure_wrong, 0) << 1) | ((coalesce(anki_note_ids_json, '[]') NOT IN ('[]', '')) << 2)
  | ((reviewed_at IS NOT NULL) << 3) | ((topic_id IS NULL) << 4) | ((anki_mistake_id IS NOT NULL) << 5) | ((source = 'hub') << 6))`;
// A topic's tuple (shape.js TOPIC_COLS), stored scores only: t1000 0..1000 (null unseen), band, cert100.
const TOPIC_TUPLE = `json_array(t.name, t.short_name, t.category_id, t.unit_id, t.status, t.amboss_url,
  CASE WHEN s.seen = 1 AND s.t IS NOT NULL THEN CAST(round(s.t * 1000) AS INTEGER) END, coalesce(s.band, 'unseen'),
  CAST(round(coalesce(s.certainty, 0) * 100) AS INTEGER), t.yield)`;
// A unit's tuple (shape.js UNIT_COLS); then the unit's main topic (the panel it opens) and its exam ranks (exam-ranks.js).
const UNIT_TUPLE = `json_array(u.id, u.num, u.kind, u.name, u.lane, u.mehlman_rank, u.checklist_system, u.checklist_order, u.category_id, u.yield,
  u.onenote_section, u.onenote_link, u.coverage_json, u.notes_gap,
  (SELECT ut.topic_id FROM unit_topics ut JOIN topics tp ON tp.user_id = ut.user_id AND tp.id = ut.topic_id AND tp.status IN ('proposed', 'confirmed')
    WHERE ut.user_id = u.user_id AND ut.unit_id = u.id AND ut.role = 'primary' ORDER BY tp.yield DESC, tp.id LIMIT 1),
  (SELECT x.rank FROM xq_rank x WHERE x.user_id = u.user_id AND x.unit_id = u.id AND x.coll = 'nbme'),
  (SELECT x.rank FROM xq_rank x WHERE x.user_id = u.user_id AND x.unit_id = u.id AND x.coll = 'cms'))`;

const SQL = {
  seq: `SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?1`,
  // Active systems only (taxonomy v2 retires the 19 old categories), plus any a live miss still names.
  categories: `SELECT json_group_object(id, json_array(name, short_name, sort, checklist_system)) AS j FROM categories WHERE user_id = ?1
    AND (status = 'active' OR id IN (SELECT category_id FROM board_misses WHERE user_id = ?1 AND category_id IS NOT NULL))`,
  // ?2 first day or null, ?3 topic or null. The rule is held to 600 characters here so the whole log stays far
  // under D1's 2 MB limit on one value, even at 1,500 misses.
  logRows: `SELECT json_group_array(json_array(id, day, at, created_at, label, topic_raw, topic_id, category_id, unit_id, lane, error_type, confidence,
      result, outcome, flaw_kind, time_s, ${FLAGS_SQL}, next_retest_day, substr(rule, 1, 600), uw_qid)) AS j
    FROM board_misses WHERE user_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR topic_id = ?3)`,
  logTopics: `SELECT json_group_object(t.id, ${TOPIC_TUPLE}) AS j FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
    WHERE t.user_id = ?1 AND t.id IN (SELECT topic_id FROM board_misses WHERE user_id = ?1 AND topic_id IS NOT NULL
      AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR topic_id = ?3))`,
  logUnits: `SELECT json_group_array(${UNIT_TUPLE}) AS j FROM units u WHERE u.user_id = ?1
    AND u.id IN (SELECT unit_id FROM board_misses WHERE user_id = ?1 AND unit_id IS NOT NULL AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR topic_id = ?3))`,
  // ?2 first day or null
  tallyRows: `SELECT json_group_array(json_array(id, day, at, created_at, topic_id, category_id, unit_id, lane, error_type, confidence, result, time_s,
      ${FLAGS_SQL})) AS j FROM board_misses WHERE user_id = ?1 AND (?2 IS NULL OR day >= ?2)`,
  tallyTopics: `SELECT json_group_object(t.id, ${TOPIC_TUPLE}) AS j FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
    WHERE t.user_id = ?1 AND t.id IN (SELECT topic_id FROM board_misses WHERE user_id = ?1 AND topic_id IS NOT NULL AND (?2 IS NULL OR day >= ?2))`,
  units: `SELECT json_group_array(${UNIT_TUPLE}) AS j FROM units u WHERE u.user_id = ?1`,
  checklistUnits: `SELECT json_group_array(${UNIT_TUPLE}) AS j FROM units u WHERE u.user_id = ?1 AND u.kind = 'checklist'`,
  progress: `SELECT json_group_array(json_array(unit_id, step, mastered, mastered_at)) AS j FROM checklist_progress WHERE user_id = ?1`,
  missCounts: `SELECT json_group_object(unit_id, n) AS j FROM (SELECT unit_id, count(*) AS n FROM board_misses WHERE user_id = ?1
    AND unit_id IS NOT NULL GROUP BY unit_id)`,
  chips: `WITH ${UNIT_SUMMARY_SQL} SELECT * FROM unit_summary`,
  // ?2 today, ?3 the first day of the last 7
  summary: `SELECT count(*) AS misses, count(DISTINCT topic_id) AS topics, coalesce(sum(topic_id IS NULL), 0) AS not_on_map,
      coalesce(sum(next_retest_day IS NOT NULL AND next_retest_day <= ?2), 0) AS retests_due, coalesce(sum(reviewed_at IS NULL), 0) AS not_reviewed,
      coalesce(sum(coalesce(sure_wrong, 0)), 0) AS sure_wrong, coalesce(sum(slow), 0) AS slow, coalesce(sum(day >= ?3), 0) AS last_7, max(day) AS last_day
    FROM board_misses WHERE user_id = ?1`,
  checkTotals: `SELECT count(*) AS units, coalesce(sum(n5 = 5), 0) AS done, coalesce(sum(n5 > 0 AND n5 < 5), 0) AS started,
      coalesce(sum(lane = 'A'), 0) AS a, coalesce(sum(lane = 'A' AND n5 = 5), 0) AS a_done, coalesce(sum(lane = 'B'), 0) AS b,
      coalesce(sum(lane = 'B' AND n5 = 5), 0) AS b_done, coalesce(sum(lane = 'C'), 0) AS c, coalesce(sum(lane = 'C' AND n5 = 5), 0) AS c_done,
      coalesce(sum(notes_gap), 0) AS gaps
    FROM (SELECT u.lane, u.notes_gap, (SELECT count(*) FROM checklist_progress p WHERE p.user_id = u.user_id AND p.unit_id = u.id AND p.mastered = 1
      AND p.step IN ('recognise', 'distinguish', 'test', 'treat', 'trap')) AS n5 FROM units u WHERE u.user_id = ?1 AND u.kind = 'checklist')`,
  // ?2 ids (JSON)
  // The re-tests from the hub's own table (0036), which holds the Anki log's too.
  detail: `SELECT id, source, sitting_id, q_index, anki_mistake_id, my_reasoning, look_alikes, learning_point, right_reasoning,
      (SELECT json_group_array(json_object('due', r.due, 'result', r.result)) FROM (SELECT due, result FROM retests r0 WHERE r0.user_id = board_misses.user_id
        AND r0.miss_id = board_misses.id ORDER BY due) r) AS retests_json,
      anki_note_ids_json FROM board_misses WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
};

const st = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const first = res => ((res && res.results) || [])[0] || {};
const text = (res, fallback) => { const v = first(res).j; return typeof v === 'string' && v ? v : fallback; };

// Unit chips {unit_id: [t1000, band, cert100, n_topics, n_seen, n_weak]} from the unit_summary rows (weakness's numbers).
function chipsOf(rows) {
  const out = {};
  for (const r of rows || []) {
    const s = summaryFromSql(r);
    out[r.unit_id] = [s.t1000, s.band, s.cert100, s.n_topics, s.n_seen, s.n_weak];
  }
  return out;
}

// ------------------------------------------------------------------ payload parts (one batch each)

/** The error log's parts for the rows since `since` (a day, or null for all), optionally one topic. */
export async function logData(env, user, { since = null, topic = null } = {}) {
  const res = await env.DB.batch([
    st(env, SQL.seq, user), st(env, SQL.logRows, user, since, topic), st(env, SQL.logTopics, user, since, topic),
    st(env, SQL.logUnits, user, since, topic), st(env, SQL.categories, user),
  ]);
  return { seq: first(res[0]).seq || 0, rows: text(res[1], '[]'), topics: text(res[2], '{}'), units: text(res[3], '[]'), categories: text(res[4], '{}') };
}

/** The tally's and High yield's parts: misses since `since`, every unit, the topics, ticks and unit chips. */
export async function tallyData(env, user, { since = null } = {}) {
  const res = await env.DB.batch([
    st(env, SQL.seq, user), st(env, SQL.tallyRows, user, since), st(env, SQL.tallyTopics, user, since), st(env, SQL.units, user),
    st(env, SQL.progress, user), st(env, SQL.chips, user), st(env, SQL.categories, user),
  ]);
  return { seq: first(res[0]).seq || 0, rows: text(res[1], '[]'), topics: text(res[2], '{}'), units: text(res[3], '[]'), progress: text(res[4], '[]'),
    chips: JSON.stringify(chipsOf(res[5].results)), categories: text(res[6], '{}') };
}

/** The Master Checklist's parts: the checklist units, ticks, misses per unit and unit chips. */
export async function checklistData(env, user) {
  const res = await env.DB.batch([
    st(env, SQL.seq, user), st(env, SQL.checklistUnits, user), st(env, SQL.progress, user), st(env, SQL.missCounts, user),
    st(env, SQL.chips, user), st(env, SQL.categories, user),
  ]);
  return { seq: first(res[0]).seq || 0, units: text(res[1], '[]'), progress: text(res[2], '[]'), miss_counts: text(res[3], '{}'),
    chips: JSON.stringify(chipsOf(res[4].results)), categories: text(res[5], '{}') };
}

/** The summary strip: all-time counts and the checklist's Done line. */
export async function summaryData(env, user, { today = londonDay() } = {}) {
  const res = await env.DB.batch([st(env, SQL.seq, user), st(env, SQL.summary, user, today, addDays(today, -6)), st(env, SQL.checkTotals, user),
    st(env, UNLOGGED_SQL, user)]);
  const s = first(res[1]), c = first(res[2]);
  const unlogged = unloggedWords(res[3].results);
  const n = v => Number(v) || 0;
  return {
    seq: first(res[0]).seq || 0, today,
    misses: n(s.misses), topics: n(s.topics), not_on_map: n(s.not_on_map), retests_due: n(s.retests_due), not_reviewed: n(s.not_reviewed),
    sure_wrong: n(s.sure_wrong), slow: n(s.slow), last_7: n(s.last_7), last_day: s.last_day || null,
    ...(unlogged.length ? { finish_review_not_run: unlogged } : {}),
    checklist: { done: n(c.done), of: n(c.units), started: n(c.started), gaps: n(c.gaps),
      by_lane: { A: [n(c.a_done), n(c.a)], B: [n(c.b_done), n(c.b)], C: [n(c.c_done), n(c.c)] } },
  };
}

// The parsed form of a payload, as shape.js reads it.
export function parsedLog(d) {
  return { seq: d.seq, rows: rowsOf(LOG_COLS, parse(d.rows, [])), topics: mapOf(TOPIC_COLS, parse(d.topics, {})), units: unitsOf(parse(d.units, [])),
    categories: mapOf(CATEGORY_COLS, parse(d.categories, {})) };
}
export function parsedTally(d) {
  return { seq: d.seq, rows: rowsOf(TALLY_COLS, parse(d.rows, [])), topics: mapOf(TOPIC_COLS, parse(d.topics, {})), units: unitsOf(parse(d.units, [])),
    progress: progressOf(parse(d.progress, [])), chips: chipMap(parse(d.chips, {})), categories: mapOf(CATEGORY_COLS, parse(d.categories, {})) };
}
export function parsedChecklist(d) {
  return { seq: d.seq, units: unitsOf(parse(d.units, [])), progress: progressOf(parse(d.progress, [])), chips: chipMap(parse(d.chips, {})),
    missCounts: new Map(Object.entries(parse(d.miss_counts, {})).map(([k, v]) => [k, Number(v) || 0])), categories: mapOf(CATEGORY_COLS, parse(d.categories, {})) };
}
function chipMap(obj) {
  const out = new Map();
  for (const [id, a] of Object.entries(obj || {})) if (Array.isArray(a)) out.set(id, { t1000: a[0], band: a[1], cert100: a[2], n_topics: a[3], n_seen: a[4], n_weak: a[5] });
  return out;
}

// ------------------------------------------------------------------ arguments

/** A topic named by id, name or alias: {id} when one is clear, else {candidates}. */
export async function findTopic(env, user, textArg) {
  const s = String(textArg || '').trim().slice(0, 120);
  if (!s) return { candidates: [] };
  if (/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    const t = await liveTopic(env, user, s).catch(e => { if (noTable(e)) return null; throw e; });
    if (t) return { id: t.id, name: t.name };
  }
  const hits = await searchTopics(env, user, { q: s, limit: 5 }).catch(e => { if (noTable(e)) return []; throw e; });
  if (hits.length && hits[0].score >= 0.9 && !(hits[1] && hits[1].score >= hits[0].score)) return { id: hits[0].id, name: hits[0].name };
  return { candidates: hits.map(h => ({ id: h.id, name: h.name })) };
}

/** A category by id, name or short name (any case), from the payload's categories; null when none matches. */
export function findCategory(categories, textArg) {
  if (!textArg) return null;
  const s = String(textArg).trim().toLowerCase();
  for (const [id, c] of categories) if (id === s || String(c.name || '').toLowerCase() === s || String(c.short_name || '').toLowerCase() === s) return id;
  for (const [id, c] of categories) if (String(c.name || '').toLowerCase().startsWith(s)) return id;
  const v = categoryFor(textArg);
  if (v && v.category_id && categories.has(v.category_id)) return v.category_id;
  return null;
}

const DAY_PROBLEM = 'since_day is a day like 2026-10-18.';

// ------------------------------------------------------------------ Claude's reads

function claudeLogRow(r, { topics, units, categories, detail }) {
  const t = r.topic_id ? topics.get(r.topic_id) : null;
  const u = r.unit_id ? units.get(r.unit_id) : null;
  const c = r.category_id ? categories.get(r.category_id) : null;
  const chip = chipOf(t);
  const row = {
    id: r.id, day: r.day, label: r.label, topic_id: r.topic_id || null, topic: t ? t.name : null,
    ...(r.unplaced || (r.topic_raw && t && r.topic_raw !== t.name) ? { logged_as: r.topic_raw || null } : {}),
    category: c ? c.name : null, unit_num: u ? Number(u.num) || null : null, lane: r.lane || null, error_type: r.error_type || null,
    confidence: r.confidence || null, result: r.result, ...(r.outcome && r.outcome !== 'wrong' ? { outcome: r.outcome } : {}),
    ...(r.flaw_kind ? { flaw_kind: r.flaw_kind } : {}), time_s: r.time_s ?? null, slow: r.slow, sure_wrong: r.sure_wrong, rule: r.rule || null,
    next_retest_day: r.next_retest_day || null, reviewed: r.reviewed, card: r.card, band: chip.band, t1000: chip.t1000,
  };
  const d = detail && detail[r.id];
  if (d) {
    row.my_reasoning = d.my_reasoning || null;
    row.look_alikes = d.look_alikes || null;
    row.learning_point = d.learning_point || null;
    if (d.retests && d.retests.length) row.retests = d.retests;
  }
  return row;
}

export async function errorLog(env, user, args = {}, ctx = {}) {
  const a = isObj(args) ? args : {};
  const now = ctx.now || Date.now();
  const today = londonDay(now);
  if (a.since_day != null && !isDay(a.since_day)) return { problems: [DAY_PROBLEM] };
  const since = a.since_day || addDays(today, -6);
  let topic = null;
  if (a.topic) {
    const t = await findTopic(env, user, a.topic);
    if (!t.id) return { found: false, topic: String(a.topic).slice(0, 120), candidates: t.candidates, next_step: 'Call board_error_log again with one of these topic ids.' };
    topic = t.id;
  }
  if (a.error_type != null && !ERROR_KEYS.includes(a.error_type)) return { problems: [`error_type is one of ${ERROR_KEYS.join(', ')}.`] };
  const d = parsedLog(await logData(env, user, { since, topic }));
  const category = a.category ? findCategory(d.categories, a.category) : null;
  if (a.category && !category) return { problems: [`No system called "${String(a.category).slice(0, 40)}". Systems: ${[...d.categories.values()].map(c => c.name).join(', ')}.`] };
  const conf = a.confidence === 'unknown' || a.confidence === 'unsaid' ? 'unsaid' : ['sure', 'lean', 'guess'].includes(a.confidence) ? a.confidence : null;
  const f = { category, error_type: a.error_type || null, confidence: conf, result: ['wrong', 'flawed'].includes(a.result) ? a.result : null,
    sure_wrong: a.sure_wrong_only === true, slow: a.slow_only === true, retest_due: a.retest_due === true,
    reviewed: typeof a.reviewed === 'boolean' ? a.reviewed : null, q: typeof a.query === 'string' ? a.query.slice(0, 80) : null };
  const kept = d.rows.filter(r => matchFilters(r, f, { today, topics: d.topics })).sort((x, y) => (y.at || 0) - (x.at || 0) || String(y.id).localeCompare(String(x.id)));
  const counts = countMisses(kept, today);
  const max = a.detail ? LIMITS.detail : LIMITS.log;
  const limit = intIn(a.limit, 1, max, Math.min(max, LIMITS.log_default));
  const offset = intIn(a.offset, 0, LIMITS.offset, 0);
  const page = kept.slice(offset, offset + limit);
  const detail = a.detail && page.length ? await missDetail(env, user, page.map(r => r.id), { audience: 'claude' }) : null;
  const left = Math.max(0, kept.length - offset - page.length);
  return {
    seq: d.seq, since_day: since, today, total: kept.length, shown: page.length, summary: logSentence(counts, since),
    counts: { sure_wrong: counts.sure_wrong, slow: counts.slow, retests_due: counts.retests_due, not_reviewed: counts.not_reviewed, not_on_map: counts.not_on_map, topics: counts.topics },
    rows: page.map(r => claudeLogRow(r, { ...d, detail })),
    ...(left ? { more: { left, call: `board_error_log with offset ${offset + page.length}` } } : {}),
  };
}

// One tally line as Claude reads it.
function claudeLine(L) {
  return {
    unit_id: L.unit_id || null, ...(L.topic_id ? { topic_id: L.topic_id } : {}), num: L.num, name: L.name, lane: L.unit_id ? L.lane : 'off',
    mehlman_rank: L.mehlman_rank, nbme_rank: L.nbme_rank ?? null, cms_rank: L.cms_rank ?? null, system: L.system, misses: L.misses, sure_wrong: L.sure_wrong, slow: L.slow, last_day: L.last_day,
    studied: L.studied, ...(L.unit_id ? { mastered: L.mastered } : {}), band: L.chip.band, t1000: L.chip.t1000,
    topics: L.topics.slice(0, 8).map(t => ({ topic_id: t.topic_id, name: t.name, misses: t.misses, last_day: t.last_day, band: t.band })),
  };
}

export async function tally(env, user, args = {}, ctx = {}) {
  const a = isObj(args) ? args : {};
  const kind = a.kind === 'high_yield' ? 'high_yield' : 'topics';
  if (a.since_day != null && !isDay(a.since_day)) return { problems: [DAY_PROBLEM] };
  if (a.kind === 'calibration') {
    let category_id = null;
    if (a.category) {
      const [cats] = await env.DB.batch([st(env, SQL.categories, user)]);
      category_id = findCategory(mapOf(CATEGORY_COLS, parse(text(cats, '{}'), {})), a.category);
      if (!category_id) return { problems: [`No system called "${String(a.category).slice(0, 40)}".`] };
    }
    const { calibration } = await import('./calibration.js');
    return calibration(env, user, { since_day: a.since_day || null, category_id });
  }
  if (a.lane != null && !LANES.includes(a.lane)) return { problems: ['lane is A, B, C or off.'] };
  const sorts = kind === 'high_yield' ? ['checklist', 'mehlman', 'yield', ...TALLY_ORDERS] : TALLY_ORDERS;
  if (a.sort != null && !sorts.includes(a.sort)) return { problems: [`sort is one of ${sorts.join(', ')}.`] };
  // High yield always counts every miss (a new miss brings a unit back with its full tally).
  const since = kind === 'high_yield' ? null : a.since_day || null;
  const d = parsedTally(await tallyData(env, user, { since }));
  const category = a.category ? findCategory(d.categories, a.category) : null;
  if (a.category && !category) return { problems: [`No system called "${String(a.category).slice(0, 40)}".`] };
  const { lines, not_on_map } = tallyLines(d.rows, d);
  const includeStudied = a.include_studied === true;
  let list;
  if (kind === 'high_yield') {
    const order = a.sort === 'yield' ? 'yield' : 'mehlman';
    list = highYieldRows(lines, { order, includeStudied, lane: a.lane || null, category });
    if (a.sort && !['checklist', 'mehlman', 'yield'].includes(a.sort)) list = tallyView(list, { order: a.sort }).lines;
  } else {
    list = tallyView(lines, { order: a.sort || 'checklist', group: a.group === 'category' ? 'category' : 'system', units: d.units, categories: d.categories,
      lane: a.lane || null, category, hideStudied: a.include_studied === false }).lines;
  }
  const limit = intIn(a.limit, 1, LIMITS.tally, LIMITS.tally_default);
  const offset = intIn(a.offset, 0, LIMITS.offset, 0);
  const page = list.slice(offset, offset + limit);
  const left = Math.max(0, list.length - offset - page.length);
  const misses = d.rows.length;
  const head = kind === 'high_yield'
    ? `Missed and Mehlman high yield: ${plural(list.length, 'unit')} to study${includeStudied ? ' (studied ones included)' : ''}.`
    : `${plural(misses, 'miss', 'misses')}${since ? ` since ${since}` : ''} across ${plural(lines.length, 'line')}${not_on_map ? `; ${not_on_map} not on the map yet` : ''}.`;
  return {
    seq: d.seq, kind, ...(since ? { since_day: since } : {}), summary: head,
    totals: { misses, topics: new Set(d.rows.filter(r => !r.unplaced).map(r => r.topic_id)).size, units: lines.filter(L => L.unit_id).length, not_on_map },
    units: page.map(claudeLine),
    ...(left ? { more: { left, call: `board_tallies with offset ${offset + page.length}` } } : {}),
  };
}

/** A unit named by code ('047', '47', 'U047'), id or name, from checklist rows: {row} or {candidates}. */
export function findUnitRow(rows, textArg) {
  const s = String(textArg || '').trim();
  const m = /^u?0*(\d{1,3})$/i.exec(s);
  if (m) { const r = rows.find(x => x.num === Number(m[1])); return r ? { row: r } : { candidates: [] }; }
  const exact = rows.find(x => x.unit_id === s) || rows.find(x => x.name.toLowerCase() === s.toLowerCase());
  if (exact) return { row: exact };
  const hits = rows.filter(x => x.name.toLowerCase().includes(s.toLowerCase()));
  return hits.length === 1 ? { row: hits[0] } : { candidates: hits.slice(0, 5).map(x => ({ unit: x.code, name: x.name })) };
}

/**
 * board_checklist: the Master Checklist with Done counts by lane, and each unit's five steps.
 * args: {lane?, category?, system?, filter?: all|not_done|started|done (default not_done), unit?, limit ≤60, offset}.
 */
export async function checklist(env, user, args = {}, ctx = {}) {
  const a = isObj(args) ? args : {};
  if (a.filter != null && !CHECK_FILTERS.includes(a.filter)) return { problems: [`filter is one of ${CHECK_FILTERS.join(', ')}.`] };
  if (a.lane != null && !['A', 'B', 'C'].includes(a.lane)) return { problems: ['lane is A, B or C (the checklist has no units off it).'] };
  const d = parsedChecklist(await checklistData(env, user));
  const rows = checklistRows(d.units, d);
  const totals = checklistTotals(rows);
  const category = a.category ? findCategory(d.categories, a.category) : null;
  if (a.category && !category) return { problems: [`No system called "${String(a.category).slice(0, 40)}".`] };
  let list;
  if (a.unit != null) {
    const u = findUnitRow(rows, a.unit);
    if (!u.row) return { found: false, unit: String(a.unit).slice(0, 40), candidates: u.candidates || [] };
    list = [u.row];
  } else {
    list = checklistView(rows, { view: 'system', units: d.units, categories: d.categories, lane: a.lane || null, category, filter: a.filter || 'not_done' })
      .flatMap(g => g.rows);
    if (a.system) {
      const s = String(a.system).toLowerCase();
      list = list.filter(r => String(r.system).toLowerCase().includes(s));
    }
  }
  const limit = intIn(a.limit, 1, LIMITS.checklist, LIMITS.checklist_default);
  const offset = intIn(a.offset, 0, LIMITS.offset, 0);
  const page = list.slice(offset, offset + limit);
  const left = Math.max(0, list.length - offset - page.length);
  return {
    seq: d.seq, summary: `${checklistSentence(totals)}. A unit is done when all five steps are mastered.`, done: totals.done, of: totals.of,
    started: totals.started, by_lane: totals.by_lane, gaps_in_notes: totals.gaps, shown: page.length,
    units: page.map(r => ({ unit_id: r.unit_id, num: r.num, code: r.code, name: r.name, lane: r.lane, mehlman_rank: r.mehlman_rank, nbme_rank: r.nbme_rank ?? null, cms_rank: r.cms_rank ?? null, system: r.system,
      steps: r.steps, done: r.done, studied: r.studied_at != null, misses: r.misses, band: r.chip.band, t1000: r.chip.t1000 })),
    ...(left ? { more: { left, call: `board_checklist with offset ${offset + page.length}` } } : {}),
  };
}

// ------------------------------------------------------------------ the long fields

/**
 * The stored long fields of some misses, by id: {id: {my_reasoning, look_alikes, learning_point, retests, cards, in_anki,
 * right_reasoning?}}. right_reasoning (the hub analysis's own leak-checked gap, on hub rows) goes to the page only.
 */
export async function missDetail(env, user, ids, { audience = 'page' } = {}) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 100);
  if (!list.length) return {};
  const rows = (await st(env, SQL.detail, user, JSON.stringify(list)).all()).results || [];
  const out = {};
  for (const r of rows) {
    const item = {
      my_reasoning: r.my_reasoning || null, look_alikes: r.look_alikes || null, learning_point: r.learning_point || null,
      retests: (parse(r.retests_json, []) || []).filter(x => x && isDay(x.due)).map(x => ({ due: x.due, result: x.result ?? null })),
      cards: (parse(r.anki_note_ids_json, []) || []).length, in_anki: r.anki_mistake_id != null,
    };
    if (audience === 'page' && r.source === 'hub') {
      if (r.right_reasoning) item.right_reasoning = r.right_reasoning;
      // The question itself opens in Smart review (review.html?sitting=&q=), where its explanations live.
      if (r.sitting_id && Number.isInteger(r.q_index)) item.review = { sitting: r.sitting_id, q: r.q_index };
    }
    out[r.id] = item;
  }
  return out;
}

export function cleanAnkiField(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/^\s*\[[^\]]{1,80}\]\s*/, '').trim();
  if (!s) return null;
  if (s.length > ANKI_FIELD_MAX) s = s.slice(0, ANKI_FIELD_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

/**
 * Right reasoning and Other options for one miss, fetched live from the Anki log (decision 13): only those two
 * fields are taken, nothing is written, and for a hub sitting's miss a field that copies the question (a 6-word
 * run) is dropped. Throws HttpError 404 (no such miss, or not in the Anki log) or 502 (Anki did not answer).
 */
export async function missFromAnki(env, user, id) {
  const m = await st(env, `SELECT id, anki_mistake_id, sitting_id, source FROM board_misses WHERE user_id = ?1 AND id = ?2`, user, String(id)).first();
  if (!m) throw new HttpError(404, 'Not found.');
  if (m.anki_mistake_id == null) throw new HttpError(404, "This one isn't in the Anki log.");
  let reply;
  try {
    // No `fields` filter: the live server may not take it yet (request S1), and the whole record is about 7 KB.
    reply = await ankiCall(env, 'mistake_sources', { ids: [Number(m.anki_mistake_id)] }, { timeoutMs: ANKI_MS });
  } catch (e) {
    throw new HttpError(502, "Couldn't reach Anki just now.");
  }
  const list = Array.isArray(reply && reply.mistakes) ? reply.mistakes : [];
  const rec = list.find(x => x && Number(x.id) === Number(m.anki_mistake_id)) || (list.length === 1 ? list[0] : null);
  // The live server answers an id it no longer has with {id, missing: true}.
  if (!rec || rec.missing) throw new HttpError(404, "Anki has no record of this one any more.");
  let right = cleanAnkiField(rec.correct_reasoning), other = cleanAnkiField(rec.why_wrong_options);
  if (m.sitting_id && (right || other)) {
    const index = await leakIndexFor(env, user, { missIds: [m.id] });
    if (index.size) {
      if (right && leaks(index, right)) right = null;
      if (other && leaks(index, other)) other = null;
    }
  }
  return { right_reasoning: right, other_options: other };
}

// ------------------------------------------------------------------ op checklist.tick

const TICK_KEYS = ['unit_id', 'unit', 'step', 'value', 'mastered'];
const TICK_STEPS = [...STEPS, 'studied', 'all'];

// The unit a tick names: an id ('u047', 'x-hypertension'), a code ('047'), a name, or 'topic:<id>' for a topic off
// the checklist (Studied only). One read. Returns {unit} | {topic} | {refuse}.
async function tickTarget(env, user, given) {
  const s = String(given || '').trim().slice(0, 200);
  if (!s) return { refuse: 'Which unit? (unit_id is missing)' };
  if (s.startsWith('topic:')) {
    const t = await liveTopic(env, user, s.slice(6));
    if (!t) return { refuse: 'That topic is not on the map.' };
    return { topic: t };
  }
  const code = /^u?0*(\d{1,3})$/i.exec(s);
  const rows = (await st(env, `SELECT id, num, kind, name, lane, category_id FROM units WHERE user_id = ?1
      AND (id = ?2 OR num = ?3 OR lower(name) = lower(?2) OR instr(lower(name), lower(?2)) > 0) ORDER BY (id = ?2) DESC, (num = ?3) DESC,
      (lower(name) = lower(?2)) DESC, num LIMIT 6`, user, s, code ? Number(code[1]) : -1).all()).results || [];
  const exact = rows.find(u => u.id === s) || (code && rows.find(u => u.num === Number(code[1]))) || rows.find(u => u.name.toLowerCase() === s.toLowerCase());
  if (exact) return { unit: exact };
  if (rows.length === 1) return { unit: rows[0] };
  if (!rows.length) return { refuse: `No checklist unit matches "${s.slice(0, 60)}".` };
  return { refuse: `Which unit? ${rows.slice(0, 5).map(u => `${u.name} (${unitCode(u.num) || u.id})`).join('; ')}.` };
}

/**
 * Planner for op checklist.tick {unit_id, step: recognise|distinguish|test|treat|trap|studied|all, value}: one
 * checklist_progress row per step that changes (insert or update, so undo is a plain restore), one checklist.ticked
 * event per row, and for the five steps one self_mastered evidence row per topic of the unit (unticking removes
 * them), so the unit's colours move in the same batch. 'all' is Done: all five steps. 'studied' takes the unit (or
 * topic) off the High yield list until a newer miss arrives; it writes no evidence. Nothing to change is a noop.
 */
export async function planChecklistTick(env, user, args, ctx = {}) {
  const a = isObj(args) ? args : {};
  for (const k of Object.keys(a)) if (!TICK_KEYS.includes(k)) return { refuse: `Unknown field ${k}.`, field: k };
  const step = typeof a.step === 'string' ? a.step.trim().toLowerCase() : '';
  if (!TICK_STEPS.includes(step)) return { refuse: 'step is recognise, distinguish, test, treat, trap, studied or all.', field: 'step' };
  const raw = a.value ?? a.mastered;
  if (typeof raw !== 'boolean' && raw !== 0 && raw !== 1) return { refuse: 'value is true (tick) or false (untick).', field: 'value' };
  const value = raw === true || raw === 1;
  const target = await tickTarget(env, user, a.unit_id ?? a.unit);
  if (target.refuse) return { refuse: target.refuse, field: 'unit_id' };
  const off = !!target.topic;
  if (off && step !== 'studied') return { refuse: 'A topic off the checklist has only the Studied tick.', field: 'step' };
  const unitId = off ? `topic:${target.topic.id}` : target.unit.id;
  const name = off ? target.topic.name : target.unit.name;
  const label = off ? name : `${name}${target.unit.num != null ? ` (${unitCode(target.unit.num)})` : ''}`;
  const steps = step === 'all' ? STEPS : [step];
  const now = ctx.now || Date.now();
  const actor = ctx.actor === 'claude' ? 'claude' : ctx.actor === 'code' ? 'code' : 'mo';

  const reads = [st(env, `SELECT unit_id, step, mastered, mastered_at, source, source_ref, created_by, updated_at FROM checklist_progress
    WHERE user_id = ?1 AND unit_id = ?2`, user, unitId)];
  const stepTick = steps.some(s => STEPS.includes(s));
  if (stepTick) {
    reads.push(st(env, `SELECT id, category_id FROM topics WHERE user_id = ?1 AND status IN ('proposed', 'confirmed') AND (unit_id = ?2
        OR id IN (SELECT topic_id FROM unit_topics WHERE user_id = ?1 AND unit_id = ?2 AND role = 'primary')) ORDER BY yield DESC, id LIMIT ?3`,
    user, unitId, LIMITS.unit_topics));
    reads.push(st(env, `SELECT obs_key FROM evidence WHERE user_id = ?1 AND obs_key >= ?2 AND obs_key < ?3`, user, `tick:${unitId}:`, `tick:${unitId};`));
  }
  if (step === 'studied') {
    reads.push(st(env, `SELECT id, created_at FROM board_misses WHERE user_id = ?1 AND (unit_id = ?2 OR (?3 IS NOT NULL AND topic_id = ?3 AND unit_id IS NULL))
      ORDER BY created_at DESC, at DESC LIMIT 1`, user, unitId, off ? target.topic.id : null));
  }
  const res = await env.DB.batch(reads);
  const current = new Map((res[0].results || []).map(r => [r.step, r]));
  const topics = stepTick ? res[1].results || [] : [];
  const tickKeys = stepTick ? new Set((res[2].results || []).map(r => r.obs_key)) : new Set();
  const newest = step === 'studied' ? first(res[res.length - 1]) : {};
  const lastMiss = newest.id || null;

  const rows = [], events = [], upsert = [], remove = [];
  const day = londonDay(now);
  for (const s of steps) {
    const cur = current.get(s);
    let was = cur ? Number(cur.mastered) === 1 : false;
    // A Studied tick older than the newest miss no longer counts (the miss brought the unit back), so ticking it
    // again is a real change: it starts from now.
    if (s === 'studied' && was && newest.created_at != null && !(Number(cur.mastered_at) >= Number(newest.created_at))) was = false;
    if (was === value) continue;
    const ref = s === 'studied' && value && lastMiss ? `last:${lastMiss}`.slice(0, 200) : cur ? cur.source_ref ?? null : null;
    const after = { mastered: value ? 1 : 0, mastered_at: value ? now : null, source_ref: ref, updated_at: now };
    if (cur) {
      rows.push({ table: 'checklist_progress', op: 'update', key: { unit_id: unitId, step: s },
        before: { mastered: Number(cur.mastered) || 0, mastered_at: cur.mastered_at ?? null, source_ref: cur.source_ref ?? null, updated_at: cur.updated_at ?? null }, after });
    } else {
      rows.push({ table: 'checklist_progress', op: 'insert', key: { unit_id: unitId, step: s }, after: { ...after, source: 'hub', created_by: actor } });
    }
    const what = s === 'studied' ? (value ? `Studied: ${label}` : `Studied tick taken off ${label}`) : `${STEP_NAMES[s]} ${value ? 'ticked' : 'unticked'} for ${label}`;
    events.push({ target_type: 'checklist', target_id: `${unitId}:${s}`, topic_id: topics.length === 1 ? topics[0].id : off ? target.topic.id : null, summary: summaryOf(what) });
    if (STEPS.includes(s)) {
      if (value) {
        for (const t of topics) {
          upsert.push({ obs_key: `tick:${unitId}:${s}:${t.id}`, slot: 0, topic_id: t.id, category_id: t.category_id || null, kind: 'self_mastered', at: now, day,
            source: 'board', source_ref: `${unitId}:${s}`, created_by: actor });
        }
      } else {
        for (const k of tickKeys) if (k.startsWith(`tick:${unitId}:${s}:`)) remove.push(k);
      }
    }
  }
  const already = step === 'all' ? `All five steps were already ${value ? 'ticked' : 'unticked'} for ${label}.`
    : `${step === 'studied' ? 'Studied' : STEP_NAMES[step]} was already ${value ? 'ticked' : 'unticked'} for ${label}.`;
  if (!rows.length) return { noop: true, summary: already };
  const summary = summaryOf(step === 'all' ? `All five steps ${value ? 'ticked' : 'unticked'} for ${label}` : events[0].summary);
  const final = Object.fromEntries(steps.map(s => [s, value ? 1 : 0]));
  for (const [s, r] of current) if (!(s in final)) final[s] = Number(r.mastered) ? 1 : 0;
  const n5 = STEPS.reduce((n, s) => n + (final[s] ? 1 : 0), 0);
  return {
    rows, events, evidence: upsert.length || remove.length ? { upsert, remove } : undefined,
    touched_topics: stepTick ? topics.map(t => t.id) : [], count: rows.length, summary,
    reply: { unit_id: unitId, step, value, steps: Object.fromEntries(STEPS.map(s => [s, final[s] ? 1 : 0])), mastered: n5, done: n5 === STEPS.length,
      ...(step === 'studied' ? { studied: value } : {}) },
  };
}

export function tickTier(args) {
  const v = args && (args.value ?? args.mastered);
  return args && String(args.step).toLowerCase() === 'all' && (v === false || v === 0) ? 'confirm' : 'free';
}

// ------------------------------------------------------------------ op miss.review

/**
 * Planner for op miss.review {ids: [≤25] | id, reviewed}: sets reviewed_at and reviewed_by on each live miss that
 * changes, with one miss.reviewed event per row. Never moves a colour; ingestion never overwrites these columns.
 */
export async function planMissReview(env, user, args, ctx = {}) {
  const a = isObj(args) ? args : {};
  for (const k of Object.keys(a)) if (!['ids', 'id', 'reviewed', 'value'].includes(k)) return { refuse: `Unknown field ${k}.`, field: k };
  const ids = [...new Set((Array.isArray(a.ids) ? a.ids : a.id != null ? [a.id] : []).map(x => String(x).trim()).filter(Boolean))];
  if (!ids.length) return { refuse: 'Which misses? (ids is missing)', field: 'ids' };
  if (ids.length > LIMITS.review) return { refuse: `Mark at most ${LIMITS.review} misses at a time.`, field: 'ids' };
  if (ids.some(id => id.length > 120)) return { refuse: 'A miss id is at most 120 characters.', field: 'ids' };
  const raw = a.reviewed ?? a.value;
  if (typeof raw !== 'boolean') return { refuse: 'reviewed is true or false.', field: 'reviewed' };
  const rows0 = (await st(env, `SELECT id, label, topic_id, reviewed_at, reviewed_by FROM board_misses WHERE user_id = ?1
    AND id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(ids)).all()).results || [];
  if (!rows0.length) return { refuse: ids.length === 1 ? 'There is no miss with that id on the Review page.' : 'None of those misses is on the Review page.', field: 'ids' };
  const missing = ids.filter(id => !rows0.some(r => r.id === id));
  if (missing.length) return { refuse: `No miss on the Review page has id ${missing.slice(0, 3).join(', ')}.`, field: 'ids' };
  const now = ctx.now || Date.now();
  const actor = ctx.actor === 'claude' ? 'claude' : 'mo';
  const rows = [], events = [];
  for (const m of rows0) {
    if ((m.reviewed_at != null) === raw) continue;
    rows.push({ table: 'misses', op: 'update', key: { id: m.id }, before: { reviewed_at: m.reviewed_at ?? null, reviewed_by: m.reviewed_by ?? null },
      after: { reviewed_at: raw ? now : null, reviewed_by: raw ? actor : null } });
    events.push({ target_type: 'miss', target_id: m.id, topic_id: m.topic_id || null, summary: summaryOf(`${m.label} marked ${raw ? 'reviewed' : 'not reviewed'}`) });
  }
  if (!rows.length) return { noop: true, summary: ids.length === 1 ? `That one was already marked ${raw ? 'reviewed' : 'not reviewed'}.` : `Those were already marked ${raw ? 'reviewed' : 'not reviewed'}.` };
  const summary = rows.length === 1 ? events[0].summary : `${rows.length} misses marked ${raw ? 'reviewed' : 'not reviewed'}`;
  return { rows, events, refs: { misses: rows.map(r => r.key.id) }, count: rows.length, summary, reply: { ids: rows.map(r => r.key.id), reviewed: raw } };
}
