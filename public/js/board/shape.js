import { bandOf, bandWord } from '../map/scale.js';

export const TABS = ['log', 'tally', 'yield', 'checklist'];
export const TAB_NAMES = { log: 'Error log', tally: 'Topic tally', yield: 'High yield', checklist: 'Checklist' };
export const STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const STEP_NAMES = { recognise: 'Recognise', distinguish: 'Distinguish', test: 'Test', treat: 'Treat', trap: 'Trap' };
export const STEP_SHORT = { recognise: 'R', distinguish: 'D', test: 'Te', treat: 'Tr', trap: 'Tp' };
export const RANGES = ['7', '30', 'all'];
export const RANGE_NAMES = { 7: '7 days', 30: '30 days', all: 'All' };
export const LANES = ['A', 'B', 'C', 'off'];
export const LANE_NAMES = { A: 'Lane A', B: 'Lane B', C: 'Lane C', off: 'Not on the checklist' };
export const LOG_GROUPS = ['system', 'day', 'none'];
export const LOG_SORTS = ['newest', 'slowest', 'sure_wrong', 'weakest'];
export const TALLY_ORDERS = ['checklist', 'most_missed', 'weakest', 'newest', 'sure_wrong', 'slowest'];
export const TALLY_ORDER_NAMES = { checklist: 'Checklist', most_missed: 'Most missed', weakest: 'Weakest', newest: 'Newest', sure_wrong: 'Sure and wrong', slowest: 'Slowest' };
export const YIELD_ORDERS = ['mehlman', 'yield'];
export const CHECK_FILTERS = ['all', 'not_done', 'started', 'done'];
export const SLOW_S = 120;

// Error types as stored (the Anki keys) and in CONTRACT's words; a Worker test pins these to checks.js.
export const ERROR_KEYS = ['knowledge_gap', 'misread', 'premature_closure', 'faulty_synthesis', 'test_taking', 'threshold', 'calculation'];
export const ERROR_WORDS = {
  knowledge_gap: 'knowledge gap', misread: 'misread', premature_closure: 'premature closure', faulty_synthesis: 'faulty synthesis',
  test_taking: 'test-taking', threshold: 'threshold or number', calculation: 'calculation',
};
export const SLIPS = ['misread', 'test_taking'];
export const CONF_WORDS = { sure: 'Sure', lean: 'Lean', guess: 'Guess', unsaid: 'Not said' };
// A miss that is not a plain wrong answer, in words (the server's outcomes, then the hub's flaw kinds).
const OUTCOME_WORDS = {
  wrong_changed_from_right: 'changed from right', right_guess: 'right by a guess', right_changed_from_wrong: 'changed to right',
  right_flawed: 'right but shaky',
};
const FLAW_WORDS = { lucky_guess: 'right by a guess', right_wrong_reason: 'right, wrong reason', shaky_elimination: 'shaky elimination', misread_detail: 'misread a detail' };

// The flags column of a compact row (board.js builds it in SQL with these bits).
export const FLAG = { slow: 1, sure_wrong: 2, card: 4, reviewed: 8, unplaced: 16, anki: 32, hub: 64 };
export const LOG_COLS = ['id', 'day', 'at', 'logged_at', 'label', 'topic_raw', 'topic_id', 'category_id', 'unit_id', 'lane', 'error_type', 'confidence',
  'result', 'outcome', 'flaw_kind', 'time_s', 'flags', 'next_retest_day', 'rule', 'uw_qid'];
export const TALLY_COLS = ['id', 'day', 'at', 'logged_at', 'topic_id', 'category_id', 'unit_id', 'lane', 'error_type', 'confidence', 'result', 'time_s', 'flags'];
// Topic, unit and category tuples in the payloads' maps.
export const TOPIC_COLS = ['name', 'short_name', 'category_id', 'unit_id', 'status', 'amboss_url', 't1000', 'band', 'cert100', 'yield'];
export const UNIT_COLS = ['id', 'num', 'kind', 'name', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id', 'yield',
  'onenote_section', 'onenote_link', 'coverage_json', 'notes_gap', 'topic_id', 'nbme_rank', 'cms_rank'];
export const CATEGORY_COLS = ['name', 'short_name', 'sort', 'checklist_system'];
export const CHIP_COLS = ['t1000', 'band', 'cert100', 'n_topics', 'n_seen', 'n_weak'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const examRankBits = r => [r && r.nbme_rank != null ? `NBME #${r.nbme_rank}` : null, r && r.cms_rank != null ? `CMS #${r.cms_rank}` : null].filter(Boolean);

// ------------------------------------------------------------------ days and words

export const isDay = d => typeof d === 'string' && DAY_RE.test(d);
const dayDate = d => { const m = DAY_RE.exec(d); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };

/** '2026-10-23' -> 'Fri 23 Oct' (with year: 'Fri 23 Oct 2026'). */
export function dayLabel(day, { year = false, weekday = true } = {}) {
  const d = dayDate(day);
  if (!d) return day ? String(day) : '';
  return `${weekday ? WEEKDAYS[d.getUTCDay()] + ' ' : ''}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ' ' + d.getUTCFullYear() : ''}`;
}
/** The day n days after (or before) a day. */
export function addDays(day, n) {
  const d = dayDate(day);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The first day of a range ending today ('7' is today and the 6 days before), or null for 'all'. */
export function sinceDay(today, range) {
  if (range === 'all' || range == null || !isDay(today)) return null;
  const n = Number(range);
  return Number.isInteger(n) && n > 0 ? addDays(today, -(n - 1)) : null;
}
/** 148 -> '2:28'. */
export function mmss(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const errorWords = key => ERROR_WORDS[key] || null;
export const isSlip = key => SLIPS.includes(key);
/** The result in words when it is not a plain wrong answer, else null. */
export function resultWords(r) {
  if (!r) return null;
  if (r.outcome && OUTCOME_WORDS[r.outcome]) return OUTCOME_WORDS[r.outcome];
  if (r.result === 'flawed') return FLAW_WORDS[r.flaw_kind] || 'right but shaky';
  return null;
}
/** Unit codes as the checklist prints them: 47 -> '047'. */
export const unitCode = n => (Number.isInteger(Number(n)) && n !== null && n !== '' ? String(Number(n)).padStart(3, '0') : '');
/** A weakness chip from stored scores ({t1000, band, cert100}); band follows t1000 when it is missing. */
export function chipOf(s) {
  if (!s) return { t1000: null, band: 'unseen', cert100: 0, word: bandWord('unseen') };
  const t1000 = num(s.t1000);
  const band = s.band && s.band !== 'unseen' ? s.band : t1000 == null ? 'unseen' : bandOf(t1000);
  return { t1000: band === 'unseen' ? null : t1000, band, cert100: num(s.cert100) || 0, word: bandWord(band) };
}
/** Certainty in words, as the panel says it. */
export function certWords(cert100) {
  const c = num(cert100) || 0;
  return c >= 60 ? 'plenty to go on' : c >= 33 ? 'a fair amount to go on' : 'based on little so far';
}

// ------------------------------------------------------------------ payload rows

/** Compact rows ([[...], ...] in `cols` order) as objects, with the flag bits spread out. */
export function rowsOf(cols, rows) {
  const out = [];
  for (const a of rows || []) {
    if (!Array.isArray(a)) continue;
    const r = {};
    for (let i = 0; i < cols.length; i++) r[cols[i]] = a[i] === undefined ? null : a[i];
    const f = Number(r.flags) || 0;
    r.slow = !!(f & FLAG.slow);
    r.sure_wrong = !!(f & FLAG.sure_wrong);
    r.card = !!(f & FLAG.card);
    r.reviewed = !!(f & FLAG.reviewed);
    r.unplaced = !!(f & FLAG.unplaced) || !r.topic_id;
    r.in_anki = !!(f & FLAG.anki);
    r.hub = !!(f & FLAG.hub);
    out.push(r);
  }
  return out;
}
/** {id: [..]} tuples as {id: {...}} by their column names. */
export function mapOf(cols, obj) {
  const out = new Map();
  for (const [id, a] of Object.entries(obj || {})) {
    if (!Array.isArray(a)) continue;
    const o = { id };
    cols.forEach((c, i) => { if (c !== 'id') o[c] = a[i] === undefined ? null : a[i]; });
    out.set(id, o);
  }
  return out;
}
/** A list of unit tuples (UNIT_COLS) as a Map by id. */
export function unitsOf(list) {
  const out = new Map();
  for (const a of list || []) {
    if (!Array.isArray(a)) continue;
    const u = {};
    UNIT_COLS.forEach((c, i) => { u[c] = a[i] === undefined ? null : a[i]; });
    if (typeof u.coverage_json === 'string') { try { u.coverage = JSON.parse(u.coverage_json); } catch { u.coverage = {}; } } else u.coverage = u.coverage_json || {};
    delete u.coverage_json;
    out.set(u.id, u);
  }
  return out;
}
/** checklist_progress tuples [unit_id, step, mastered, mastered_at] as Map(unit_id -> {steps, n5, studied_at}). */
export function progressOf(list) {
  const out = new Map();
  for (const a of list || []) {
    if (!Array.isArray(a)) continue;
    const [unit, step, mastered, at] = a;
    let p = out.get(unit);
    if (!p) { p = { steps: Object.fromEntries(STEPS.map(s => [s, 0])), n5: 0, studied_at: null }; out.set(unit, p); }
    if (STEPS.includes(step)) p.steps[step] = Number(mastered) ? 1 : 0;
    if (step === 'studied') p.studied_at = Number(mastered) ? num(at) : null;
  }
  for (const p of out.values()) p.n5 = STEPS.reduce((n, s) => n + p.steps[s], 0);
  return out;
}
/** Step ticks as stored for one unit, from a progress map (all zero when nothing is ticked). */
export function stepsOf(progress, unitId) {
  const p = progress && progress.get(unitId);
  return p ? { ...p.steps } : Object.fromEntries(STEPS.map(s => [s, 0]));
}

// ------------------------------------------------------------------ filters

/**
 * Whether one miss row passes the filters. f: {since?, category?, lane?: A|B|C|off, error_type?,
 * confidence?: sure|lean|guess|unsaid, result?: wrong|flawed, sure_wrong?, slow?, retest_due?, reviewed?: true|false,
 * topic?, q?}. ctx: {today, topics: Map (for names in search)}. Unset filters pass everything.
 */
export function matchFilters(r, f = {}, ctx = {}) {
  if (!r) return false;
  if (f.since && !(r.day >= f.since)) return false;
  if (f.topic && r.topic_id !== f.topic) return false;
  if (f.category && r.category_id !== f.category) return false;
  if (f.lane) {
    if (f.lane === 'off') { if (r.unplaced || r.lane) return false; } else if (r.lane !== f.lane) return false;
  }
  if (f.error_type && r.error_type !== f.error_type) return false;
  if (f.confidence) { if (f.confidence === 'unsaid' ? r.confidence != null : r.confidence !== f.confidence) return false; }
  if (f.result && r.result !== f.result) return false;
  if (f.sure_wrong && !r.sure_wrong) return false;
  if (f.slow && !r.slow) return false;
  if (f.retest_due && !(r.next_retest_day && ctx.today && r.next_retest_day <= ctx.today)) return false;
  if (f.reviewed === true && !r.reviewed) return false;
  if (f.reviewed === false && r.reviewed) return false;
  if (f.q) {
    const t = r.topic_id && ctx.topics ? ctx.topics.get(r.topic_id) : null;
    const hay = [r.label, r.topic_raw, r.rule, t && t.name, t && t.short_name].filter(Boolean).join(' \u0001 ').toLowerCase();
    for (const w of String(f.q).toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(w)) return false;
  }
  return true;
}
/** Whether a re-test date is due by today. */
export const retestDue = (r, today) => !!(r && r.next_retest_day && today && r.next_retest_day <= today);

// ------------------------------------------------------------------ error log

const byNewest = (a, b) => (num(b.at) || 0) - (num(a.at) || 0) || String(b.id).localeCompare(String(a.id));
function logSorter(sort, topics) {
  if (sort === 'slowest') return (a, b) => (num(b.time_s) ?? -1) - (num(a.time_s) ?? -1) || byNewest(a, b);
  if (sort === 'sure_wrong') return (a, b) => (b.sure_wrong - a.sure_wrong) || byNewest(a, b);
  if (sort === 'weakest') {
    const t = r => { const x = r.topic_id && topics ? topics.get(r.topic_id) : null; return x && x.t1000 != null ? Number(x.t1000) : -1; };
    return (a, b) => t(b) - t(a) || byNewest(a, b);
  }
  return byNewest;
}

export function groupLog(rows, { group = 'system', sort = 'newest', categories = new Map(), topics = new Map() } = {}) {
  const list = [...(rows || [])];
  const order = group === 'none' ? logSorter(sort, topics) : byNewest;
  list.sort(order);
  if (group === 'none') return list.length ? [{ key: 'all', label: 'Every miss', rows: list }] : [];
  const groups = new Map();
  const unplaced = [];
  for (const r of list) {
    if (group === 'system' && r.unplaced) { unplaced.push(r); continue; }
    const key = group === 'day' ? r.day || 'no-day' : r.category_id || 'none';
    let g = groups.get(key);
    if (!g) {
      const c = categories.get(key);
      g = { key, label: group === 'day' ? dayLabel(key) || 'No date' : (c && c.name) || 'No system', rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const out = [...groups.values()];
  if (group === 'day') out.sort((a, b) => String(b.key).localeCompare(String(a.key)));
  else out.sort((a, b) => byNewest(a.rows[0], b.rows[0]));
  if (unplaced.length) out.push({ key: 'unplaced', label: 'Not on the map yet', rows: unplaced, unplaced: true });
  return out;
}

/** Counts for a list of misses: {misses, sure_wrong, slow, retests_due, not_reviewed, not_on_map, topics}. */
export function countMisses(rows, today = null) {
  const out = { misses: 0, sure_wrong: 0, slow: 0, retests_due: 0, not_reviewed: 0, not_on_map: 0, topics: 0 };
  const topics = new Set();
  for (const r of rows || []) {
    out.misses++;
    if (r.sure_wrong) out.sure_wrong++;
    if (r.slow) out.slow++;
    if (retestDue(r, today)) out.retests_due++;
    if (!r.reviewed) out.not_reviewed++;
    if (r.unplaced) out.not_on_map++;
    else topics.add(r.topic_id);
  }
  out.topics = topics.size;
  return out;
}

/** "12 misses since Sun 18 Oct, 4 sure and wrong, 3 slow." (the error log's first line for Claude). */
export function logSentence(c, since) {
  const head = `${plural(c.misses, 'miss', 'misses')}${since ? ` since ${dayLabel(since)}` : ' in all'}`;
  const bits = [];
  if (c.sure_wrong) bits.push(`${c.sure_wrong} sure and wrong`);
  if (c.slow) bits.push(`${c.slow} slow`);
  if (c.not_on_map) bits.push(`${c.not_on_map} not on the map yet`);
  return `${[head, ...bits].join(', ')}.`;
}

// ------------------------------------------------------------------ topic tally

// Where a line sits in the tally: the unit's checklist system, else its category's (Contents order: the system's
// first unit on the checklist, then categories off the checklist by their sort).
function systemOf(u, cat) {
  return (u && u.checklist_system) || (cat && cat.checklist_system) || (cat && cat.name) || 'Other';
}
export function systemOrder(units, categories) {
  const order = new Map();
  for (const u of units.values()) {
    const s = systemOf(u, categories.get(u.category_id));
    const o = num(u.checklist_order);
    if (o != null && (!order.has(s) || o < order.get(s))) order.set(s, o);
  }
  for (const c of categories.values()) {
    const s = systemOf(null, c);
    if (!order.has(s)) order.set(s, 100000 + (num(c.sort) || 0));
  }
  return order;
}

function newLine(key, u, t, ctx) {
  const cat = ctx.categories.get(u ? u.category_id : t && t.category_id);
  const off = !u;
  const p = ctx.progress && ctx.progress.get(key);
  return {
    key, unit_id: u ? u.id : null, topic_id: off ? t && t.id : null, num: u ? num(u.num) : null, code: u ? unitCode(u.num) : '',
    name: u ? u.name : (t && t.name) || 'Unknown topic', kind: u ? u.kind : 'topic', lane: u ? u.lane || null : null, mehlman_rank: u ? num(u.mehlman_rank) : null,
    nbme_rank: u ? num(u.nbme_rank) : null, cms_rank: u ? num(u.cms_rank) : null,
    checklist_order: u ? num(u.checklist_order) : null, yield: num(u ? u.yield : t && t.yield) || 0,
    category_id: u ? u.category_id : t && t.category_id, system: systemOf(u, cat), onenote_link: u ? u.onenote_link || null : null,
    misses: 0, sure_wrong: 0, slow: 0, last_day: null, last_at: null, last_logged: null, max_time: null,
    steps: off ? null : p ? { ...p.steps } : Object.fromEntries(STEPS.map(s => [s, 0])), mastered: off ? null : p ? p.n5 : 0,
    studied_at: p ? p.studied_at : null, studied: false, chip: null, topics: [],
  };
}

/**
 * The tally's lines from (already filtered) miss rows: one per checklist unit and one per topic off the
 * checklist, each with its topics and counts, its Studied state and its weakness chip. A line is studied when
 * its Studied tick is newer than the newest miss to arrive on it (logged_at), so a new miss brings it back.
 * ctx: {units, topics, categories, progress, chips} (Maps). opts.withEmpty adds checklist units with no misses.
 * Returns {lines, not_on_map}.
 */
export function tallyLines(rows, ctx, { withEmpty = false } = {}) {
  const lines = new Map();
  const perTopic = new Map();
  let not_on_map = 0;
  for (const r of rows || []) {
    if (r.unplaced) { not_on_map++; continue; }
    const t = ctx.topics.get(r.topic_id) || { id: r.topic_id, name: r.topic_id, category_id: r.category_id };
    const u = ctx.units.get(r.unit_id || t.unit_id) || null;
    const key = u ? u.id : `topic:${r.topic_id}`;
    let L = lines.get(key);
    if (!L) { L = newLine(key, u, { ...t, id: r.topic_id }, ctx); lines.set(key, L); }
    L.misses++;
    if (r.sure_wrong) L.sure_wrong++;
    if (r.slow) L.slow++;
    if (r.day && (!L.last_day || r.day > L.last_day)) L.last_day = r.day;
    if (num(r.at) != null && (L.last_at == null || r.at > L.last_at)) L.last_at = num(r.at);
    const logged = num(r.logged_at) ?? num(r.at);
    if (logged != null && (L.last_logged == null || logged > L.last_logged)) L.last_logged = logged;
    if (num(r.time_s) != null && (L.max_time == null || r.time_s > L.max_time)) L.max_time = num(r.time_s);
    const tk = `${key}|${r.topic_id}`;
    let T = perTopic.get(tk);
    if (!T) {
      const c = chipOf(t);
      T = { topic_id: r.topic_id, name: t.name || r.topic_id, short_name: t.short_name || null, amboss_url: t.amboss_url || null, status: t.status || null,
        misses: 0, sure_wrong: 0, slow: 0, last_day: null, t1000: c.t1000, band: c.band, cert100: c.cert100 };
      perTopic.set(tk, T);
      L.topics.push(T);
    }
    T.misses++;
    if (r.sure_wrong) T.sure_wrong++;
    if (r.slow) T.slow++;
    if (r.day && (!T.last_day || r.day > T.last_day)) T.last_day = r.day;
  }
  if (withEmpty) {
    for (const u of ctx.units.values()) if (u.kind === 'checklist' && !lines.has(u.id)) lines.set(u.id, newLine(u.id, u, null, ctx));
  }
  for (const L of lines.values()) {
    L.topics.sort((a, b) => b.misses - a.misses || (b.last_day || '').localeCompare(a.last_day || '') || a.name.localeCompare(b.name));
    L.studied = L.studied_at != null && (L.last_logged == null || L.studied_at >= L.last_logged);
    const unitChip = L.unit_id && ctx.chips ? ctx.chips.get(L.unit_id) : null;
    if (unitChip) L.chip = chipOf(unitChip);
    else if (L.topics.length) {
      // No unit summary (a topic off the checklist, or a unit not linked yet): its weakest topic.
      const w = [...L.topics].sort((a, b) => (b.t1000 ?? -1) - (a.t1000 ?? -1))[0];
      L.chip = chipOf(w);
    } else L.chip = chipOf(null);
    L.first_topic_id = L.topics.length ? L.topics[0].topic_id : (L.unit_id && ctx.units.get(L.unit_id) && ctx.units.get(L.unit_id).topic_id) || null;
  }
  return { lines: [...lines.values()], not_on_map };
}

const rankOf = L => (L.mehlman_rank == null ? 1e9 : L.mehlman_rank);
const byChecklist = (a, b) => {
  const offA = a.unit_id ? 0 : 1, offB = b.unit_id ? 0 : 1;
  if (offA !== offB) return offA - offB;
  if (offA) return b.misses - a.misses || a.name.localeCompare(b.name);
  return rankOf(a) - rankOf(b) || (a.checklist_order ?? 1e9) - (b.checklist_order ?? 1e9) || a.name.localeCompare(b.name);
};
const ORDERS = {
  checklist: byChecklist,
  most_missed: (a, b) => b.misses - a.misses || b.sure_wrong - a.sure_wrong || (b.last_logged || 0) - (a.last_logged || 0) || byChecklist(a, b),
  weakest: (a, b) => (b.chip.t1000 ?? -1) - (a.chip.t1000 ?? -1) || b.misses - a.misses || byChecklist(a, b),
  newest: (a, b) => (b.last_logged || 0) - (a.last_logged || 0) || byChecklist(a, b),
  sure_wrong: (a, b) => b.sure_wrong - a.sure_wrong || b.misses - a.misses || byChecklist(a, b),
  slowest: (a, b) => b.slow - a.slow || (b.max_time ?? -1) - (a.max_time ?? -1) || byChecklist(a, b),
};

/** Line filters shared by the tally and High yield: lane, category, weak only, search, hide studied. */
export function lineMatches(L, { lane = null, category = null, weakOnly = false, hideStudied = false, q = null } = {}) {
  if (lane) { if (lane === 'off' ? !!L.unit_id : L.lane !== lane) return false; }
  if (category && L.category_id !== category) return false;
  if (weakOnly && !['weak', 'very_weak'].includes(L.chip && L.chip.band)) return false;
  if (hideStudied && L.studied) return false;
  if (q) {
    const hay = [L.name, L.code, ...L.topics.map(t => t.name), ...L.topics.map(t => t.short_name)].filter(Boolean).join(' \u0001 ').toLowerCase();
    for (const w of String(q).toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(w)) return false;
  }
  return true;
}

export function tallyView(lines, { order = 'checklist', group = 'system', units = new Map(), categories = new Map(), ...filters } = {}) {
  const kept = (lines || []).filter(L => lineMatches(L, filters));
  const sorter = ORDERS[order] || ORDERS.checklist;
  if (order !== 'checklist') {
    const flat = [...kept].sort(sorter);
    return { groups: flat.length ? [{ key: 'all', name: TALLY_ORDER_NAMES[order] || 'All', misses: flat.reduce((n, L) => n + L.misses, 0), lines: flat }] : [], lines: flat };
  }
  const sysOrder = systemOrder(units, categories);
  const groups = new Map();
  for (const L of kept) {
    const key = group === 'category' ? L.category_id || 'none' : L.system;
    let g = groups.get(key);
    if (!g) {
      const c = group === 'category' ? categories.get(key) : null;
      g = { key, name: group === 'category' ? (c && c.name) || 'Other' : key, misses: 0, lines: [],
        sort: group === 'category' ? (c ? num(c.sort) || 0 : 1e9) : sysOrder.get(key) ?? 1e9 };
      groups.set(key, g);
    }
    g.misses += L.misses;
    g.lines.push(L);
  }
  const out = [...groups.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  for (const g of out) g.lines.sort(sorter);
  return { groups: out, lines: out.flatMap(g => g.lines) };
}

export function highYieldRows(lines, { order = 'mehlman', includeStudied = false, ...filters } = {}) {
  const kept = (lines || []).filter(L => L.unit_id && L.misses > 0 && (includeStudied || !L.studied) && lineMatches(L, { ...filters, hideStudied: false }));
  const byRank = (a, b) => rankOf(a) - rankOf(b) || (a.checklist_order ?? 1e9) - (b.checklist_order ?? 1e9) || a.name.localeCompare(b.name);
  return kept.sort(order === 'yield' ? (a, b) => (b.yield || 0) - (a.yield || 0) || byRank(a, b) : byRank);
}

// ------------------------------------------------------------------ checklist

/**
 * The Master Checklist's rows: every checklist unit with its five step ticks, Done (all five), its Studied
 * state, misses and chip. ctx: {progress, chips, missCounts: Map(unit_id -> n), categories}.
 */
export function checklistRows(units, ctx = {}) {
  const out = [];
  for (const u of units.values()) {
    if (u.kind !== 'checklist') continue;
    const p = ctx.progress && ctx.progress.get(u.id);
    const steps = p ? { ...p.steps } : Object.fromEntries(STEPS.map(s => [s, 0]));
    const n5 = STEPS.reduce((n, s) => n + (steps[s] ? 1 : 0), 0);
    const cat = ctx.categories ? ctx.categories.get(u.category_id) : null;
    out.push({
      unit_id: u.id, num: num(u.num), code: unitCode(u.num), name: u.name, lane: u.lane || null, mehlman_rank: num(u.mehlman_rank),
      nbme_rank: num(u.nbme_rank), cms_rank: num(u.cms_rank),
      system: systemOf(u, cat), checklist_order: num(u.checklist_order), category_id: u.category_id, steps, n5, done: n5 === STEPS.length,
      studied_at: p ? p.studied_at : null, onenote_link: u.onenote_link || null, onenote_section: u.onenote_section || null,
      coverage: u.coverage || {}, notes_gap: !!Number(u.notes_gap), misses: (ctx.missCounts && ctx.missCounts.get(u.id)) || 0,
      chip: chipOf(ctx.chips ? ctx.chips.get(u.id) : null), topic_id: u.topic_id || null, yield: num(u.yield) || 0,
    });
  }
  return out;
}

/** "Done 0 of 229 · lane A 0 of 87 · B 0 of 119 · C 0 of 23", from every checklist row (never the filtered ones). */
export function checklistTotals(rows) {
  const by_lane = { A: [0, 0], B: [0, 0], C: [0, 0] };
  let done = 0, started = 0, gaps = 0;
  for (const r of rows || []) {
    if (r.done) done++;
    else if (r.n5 > 0) started++;
    if (r.notes_gap) gaps++;
    if (by_lane[r.lane]) { by_lane[r.lane][1]++; if (r.done) by_lane[r.lane][0]++; }
  }
  return { done, of: (rows || []).length, started, gaps, by_lane };
}
export function checklistSentence(t) {
  return `Done ${t.done} of ${t.of} · lane A ${t.by_lane.A[0]} of ${t.by_lane.A[1]} · B ${t.by_lane.B[0]} of ${t.by_lane.B[1]} · C ${t.by_lane.C[0]} of ${t.by_lane.C[1]}`;
}

export function checklistMatches(r, { lane = null, category = null, filter = 'all', q = null } = {}) {
  if (lane && r.lane !== lane) return false;
  if (category && r.category_id !== category) return false;
  if (filter === 'not_done' && r.done) return false;
  if (filter === 'started' && !(r.n5 > 0 && !r.done)) return false;
  if (filter === 'done' && !r.done) return false;
  if (q) {
    const hay = `${r.code} ${r.name} ${r.system}`.toLowerCase();
    for (const w of String(q).toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(w)) return false;
  }
  return true;
}

export function checklistView(rows, { view = 'system', units = new Map(), categories = new Map(), ...filters } = {}) {
  const kept = (rows || []).filter(r => checklistMatches(r, filters));
  const byRank = (a, b) => (a.mehlman_rank ?? 1e9) - (b.mehlman_rank ?? 1e9) || (a.checklist_order ?? 1e9) - (b.checklist_order ?? 1e9) || a.name.localeCompare(b.name);
  const sysOrder = systemOrder(units, categories);
  const groups = new Map();
  for (const r of kept) {
    const key = view === 'lane' ? r.lane || 'none' : r.system;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: view === 'lane' ? (LANE_NAMES[key] || 'No lane') : key, rows: [], sort: view === 'lane' ? 'ABC'.indexOf(key) + (key === 'none' ? 10 : 0) : sysOrder.get(key) ?? 1e9 };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const out = [...groups.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  for (const g of out) { g.rows.sort(byRank); g.done = g.rows.filter(r => r.done).length; }
  return out;
}

export function coverageText(coverage) {
  const parts = [];
  for (const [k, v] of Object.entries(coverage || {})) parts.push(v == null ? k : `${k} (${v})`);
  return parts.join(', ');
}
