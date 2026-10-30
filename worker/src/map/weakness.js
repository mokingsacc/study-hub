import {
  WEIGHTS_VERSION, DAY_MS, BUCKETS, BUCKET_NAMES, CAPS, GATES, PRIOR, PACE, paceWord,
  evidenceMass, isStrongFail, strongNow, decay, detailOf, kindGroup, confidenceOf,
} from './weights.js';
import { MODEL, trendOf, reviewOf, modelFromStored } from './fsrs.js';
import { bandOf, bandWord } from '../../../public/js/map/scale.js';
import { chunks, summaryOf, writeBatch } from './events.js';
import { londonDay } from '../util.js';

export const SAME_BATCH_MAX = 20;
export const STRONG_KEEP = 10;
export const WHY_MAX = 3;
export const LIVE_STATUSES = ['proposed', 'confirmed'];
// When a stored score is worth rewriting or announcing.
export const EVENT_T = 20, REFRESH_T = 10, REFRESH_RAW = 0.005, REFRESH_CERT = 5, PRIOR_MOVE = 0.005;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const lower = v => (v == null ? null : String(v).toLowerCase());
const noTable = e => /no such table/i.test(String(e && e.message));

// ------------------------------------------------------------------ prior

export const gOf = g => (g == null || !Number.isFinite(Number(g)) ? PRIOR.g_default : clamp(Number(g), PRIOR.g_min, PRIOR.g_max));

export function priorOf(n, right_n, g) {
  const nn = Math.max(0, Number(n) || 0);
  const r = nn ? clamp((Number(right_n) || 0) / nn, 0, 1) : 0;
  return clamp((nn * r + PRIOR.weight * gOf(g)) / (nn + PRIOR.weight), PRIOR.min, PRIOR.max);
}

// The m0 for a topic: its category's stored prior, else a prior from g alone.
export function m0For(categoryId, priors = {}, g = null) {
  const p = categoryId != null ? priors[categoryId] : undefined;
  if (p != null && Number.isFinite(Number(p))) return clamp(Number(p), PRIOR.min, PRIOR.max);
  return priorOf(0, 0, g);
}

// ------------------------------------------------------------------ building the state

const emptyBuckets = () => Object.fromEntries(BUCKET_NAMES.map(b => [b, 0]));
const isQFail = (row, m) => (row.kind === 'question' && ['wrong', 'flawed', 'omitted'].includes(lower(row.result)))
  || (row.kind === 'retest' && m.rule === 'missed_again');
const lessonKey = row => row.lesson_id || String(row.obs_key || '').split(':').slice(0, 2).join(':');

// Per-lesson caps (probes p 0.4 / f 0.5; pair items p 0.8 / f 1.2 per topic), as a scale on each capped row.
function lessonScales(entries) {
  const sums = new Map();
  for (const e of entries) {
    const cap = CAPS.per_lesson[e.row.kind];
    if (!cap) continue;
    const k = `${lessonKey(e.row)}|${e.row.kind}`;
    const s = sums.get(k) || { f: 0, p: 0, cap };
    s.f += e.m.f; s.p += e.m.p;
    sums.set(k, s);
  }
  return e => {
    const s = sums.get(`${lessonKey(e.row)}|${e.row.kind}`);
    if (!s) return { f: 1, p: 1 };
    return { f: s.f > s.cap.f ? s.cap.f / s.f : 1, p: s.p > s.cap.p ? s.cap.p / s.p : 1 };
  };
}

/**
 * The stored state of one topic from its live evidence rows: group masses decayed to now, strong fails, counts
 * and dates. Also returns each row's decayed contribution, for the why list.
 */
export function buildState(rows, now, model = MODEL) {
  const b = emptyBuckets();
  const st = {
    seen: 0, first_seen_at: null, last_seen_at: null, last_question_at: null, last_miss_at: null, evidence_at: null,
    strong: [], counts: { n_seen: 0, questions_n: 0, right_n: 0, misses_n: 0, sure_wrong_n: 0, slow_n: 0, cards_n: 0,
      lapses_n: 0, lessons_n: 0, retests_n: 0, gaps_n: 0 },
  };
  const entries = [];
  const cards = new Set(), lessons = new Set();
  for (const row of rows || []) {
    if (!row || Number(row.held) === 1) continue;
    const at = Number(row.at);
    if (!Number.isFinite(at)) continue;
    st.seen = 1;
    st.first_seen_at = st.first_seen_at == null ? at : Math.min(st.first_seen_at, at);
    st.last_seen_at = st.last_seen_at == null ? at : Math.max(st.last_seen_at, at);
    const upd = Number(row.updated_at) || at;
    st.evidence_at = st.evidence_at == null ? upd : Math.max(st.evidence_at, upd);
    const m = evidenceMass(row);
    entries.push({ row, m, at });
    countRow(st.counts, row, m, cards, lessons);
    if (row.kind === 'question' || row.kind === 'retest') {
      st.last_question_at = Math.max(st.last_question_at ?? at, at);
      if (isQFail(row, m)) st.last_miss_at = Math.max(st.last_miss_at ?? at, at);
    }
  }
  st.counts.cards_n = cards.size;
  st.counts.lessons_n = lessons.size;
  const scale = lessonScales(entries);
  const contrib = [];
  for (const e of entries) {
    if (!e.m.group) continue;
    const s = scale(e);
    const age = (now - e.at) / DAY_MS;
    const f = e.m.f * s.f * decay(age, BUCKETS[e.m.bucket_f]);
    const p = e.m.p * s.p * decay(age, BUCKETS[e.m.bucket_p]);
    if (f) b[e.m.bucket_f] += f;
    if (p) b[e.m.bucket_p] += p;
    const strong = isStrongFail(e.row, e.m, now);
    if (strong) st.strong.push([e.at, round(e.m.f, 6)]);
    if (f || p) contrib.push({ row: e.row, m: e.m, f, p, strong, bucket_f: e.m.bucket_f, bucket_p: e.m.bucket_p });
  }
  st.strong.sort((x, y) => y[0] - x[0]);
  st.strong = st.strong.slice(0, STRONG_KEEP);
  st.buckets = b;
  st.ref_at = now;
  // FSRS memory over the same rows (reviews after now never count: a row is never dated ahead of the clock).
  const fs = model.run(entries.filter(e => e.at <= now).map(e => e.row));
  st.fsrs = fs.state ? { s: fs.state.s, d: fs.state.d, at: fs.state.at, n: fs.state.n } : null;
  const tr = trendOf(fs.points);
  st.trend = tr.trend;
  st.trend_slope = tr.slope;
  for (const e of entries) if (!e.m.group && reviewOf(e.row)) contrib.push({ row: e.row, m: e.m, f: 0, p: 0, strong: false, bucket_f: null, bucket_p: null });
  return { state: st, contrib };
}

function countRow(c, row, m, cards, lessons) {
  const group = kindGroup(row.kind);
  const result = lower(row.result);
  if (row.kind === 'question') {
    c.questions_n++; c.n_seen++;
    if (result === 'right') c.right_n++;
    else if (['wrong', 'flawed', 'omitted'].includes(result)) c.misses_n++;
    if (result === 'wrong' && confidenceOf(row.confidence) === 'sure') c.sure_wrong_n++;
    if (Number(row.time_s) > PACE.slow_s) c.slow_n++;
  } else if (row.kind === 'retest') { c.retests_n++; c.n_seen++; }
  if ((group === 'card' || group === 'card_state') && row.card_id != null) cards.add(String(row.card_id));
  if (group === 'card' && (m.rule === 'first_sight')) c.lapses_n += Math.max(0, Number(row.amount ?? detailOf(row).lapses) || 0);
  else if (group === 'card' && (row.kind === 'card_lapse' || Number(detailOf(row).lapsed) > 0)) c.lapses_n++;
  if (group === 'lesson') lessons.add(lessonKey(row));
  if (row.gap_id != null) c.gaps_n++;
}

// ------------------------------------------------------------------ reading a state

// The capped pass and fail masses from (decayed) buckets.
export function massesOf(b) {
  const P = b.q_pass + Math.min(b.card_pass + b.card_state, CAPS.card_p) + Math.min(b.lesson_pass, CAPS.lesson_p) + Math.min(b.self_pass, CAPS.self_p);
  const F = b.q_fail + Math.min(b.card_fail, CAPS.card_f) + b.lesson_fail
    + Math.min(Math.min(b.self_fail, CAPS.rating_f) + Math.min(b.gap_fail, CAPS.gap_f), CAPS.self_f);
  return { P, F };
}

// The three gates in mastery space (plan §7.1), the same for both formulas.
export function gated(pHat, b, strongCount) {
  let mastery = pHat;
  if (b.q_pass < GATES.blue.q_pass) mastery = Math.min(mastery, GATES.blue.max);
  if (b.q_pass < GATES.deep.q_pass) mastery = Math.min(mastery, GATES.deep.max);
  if (strongCount < GATES.floor.strong) mastery = Math.max(mastery, GATES.floor.min);
  return mastery;
}
const t1000Of_ = mastery => Math.round(1000 * clamp((0.85 - mastery) / 0.55, 0, 1));

// Formula 2 (kept for rows stored before formula 3, and as the calibration's baseline): mastery, t and band from
// buckets already at `now`: the Beta posterior, then the three gates.
export function scoreFromBuckets(b, strongCount, m0) {
  const k0 = PRIOR.k0;
  const { P, F } = massesOf(b);
  const pHat = (m0 * k0 + P) / (k0 + P + F);
  const mastery = gated(pHat, b, strongCount);
  const c = (P + F) / (P + F + k0);
  return { P, F, pHat, mastery, t1000: t1000Of_(mastery), certainty: c };
}

/**
 * Formula 3: FSRS memory blended with the prior, then the gates. fsrs: {s, d, at, n} or null (seen, but nothing
 * that is a review: the prior, gated). fsrs undefined: a row from formula 2, read the old way.
 */
export function scoreFromState(b, strongCount, m0, fsrs, now) {
  if (fsrs === undefined) return scoreFromBuckets(b, strongCount, m0);
  const { P, F } = massesOf(b);
  const r = MODEL.blend(fsrs, now, m0);
  const mastery = gated(r.p, b, strongCount);
  return { P, F, pHat: r.p, R: r.R, mastery, t1000: t1000Of_(mastery), certainty: r.c };
}

const certLevel = cert100 => (cert100 >= 60 ? 'high' : cert100 >= 33 ? 'medium' : 'low');

// Decays a state's buckets from its ref_at to now (exact) and reads its score. m0: the topic's prior.
export function readScore(state, now, m0) {
  const age = Math.max(0, (now - Number(state.ref_at ?? now)) / DAY_MS);
  const b = {};
  for (const name of BUCKET_NAMES) b[name] = (Number(state.buckets && state.buckets[name]) || 0) * decay(age, BUCKETS[name]);
  const strong = (state.strong || []).filter(([at, f]) => strongNow(at, f, now));
  const out = { buckets: b, strong, ref_at: now, prior_mastery: m0 };
  if (state.fsrs !== undefined) Object.assign(out, { fsrs: state.fsrs, trend: state.trend ?? null, trend_slope: state.trend_slope ?? null });
  if (!state.seen) {
    return { ...out, seen: 0, mastery: null, weakness: null, weakness_raw: round(1 - m0, 6), t1000: null, band: 'unseen',
      certainty: 0, cert100: 0, certainty_level: 'low' };
  }
  const s = scoreFromState(b, strong.length, m0, state.fsrs, now);
  const cert100 = Math.round(100 * s.certainty);
  return {
    ...out, seen: 1, mastery: round(s.mastery, 6), weakness: round(1 - s.mastery, 6), weakness_raw: round(1 - s.pHat, 6),
    t1000: s.t1000, band: bandOf(s.t1000), certainty: round(s.certainty, 6), cert100, certainty_level: certLevel(cert100),
    recall: s.R == null ? null : round(s.R, 4),
  };
}

// ------------------------------------------------------------------ scoreTopic and the why list

const priorValue = prior => (typeof prior === 'number' ? prior : prior && Number.isFinite(Number(prior.prior ?? prior.m0))
  ? Number(prior.prior ?? prior.m0) : priorOf(0, 0, prior && prior.g));

/**
 * One topic's score from its live evidence rows (held rows are skipped). prior: m0, or {prior} / {m0} / {g}.
 * Returns the state (buckets, strong fails, counts, dates), the read score and why (the top rows by
 * leave-one-out change in t1000).
 */
export function scoreTopic(rows, prior, now = Date.now(), model = MODEL) {
  const m0 = clamp(priorValue(prior), PRIOR.min, PRIOR.max);
  const { state, contrib } = buildState(rows, now, model);
  const score = readScore(state, now, m0);
  const why = state.seen ? whyRows(rows, contrib, score, m0, now, model) : [];
  return { ...state, ...score, counts: state.counts, why };
}

const WHY_LOO_MAX = 30;   // leave-one-out reruns FSRS per row, so only the newest 30 contributing rows are tried

// Leave-one-out: each contributing row's effect on t1000, by scoring the topic again without it (its decayed
// masses out of the buckets, and the FSRS reviews run again without it).
function whyRows(rows, contrib, score, m0, now, model = MODEL) {
  const items = [];
  const list = contrib.length > WHY_LOO_MAX ? [...contrib].sort((x, y) => Number(y.row.at) - Number(x.row.at)).slice(0, WHY_LOO_MAX) : contrib;
  const live = (rows || []).filter(r => r && Number(r.held) !== 1 && Number.isFinite(Number(r.at)) && Number(r.at) <= now);
  for (const c of list) {
    const b = { ...score.buckets };
    if (c.f) b[c.bucket_f] = Math.max(0, b[c.bucket_f] - c.f);
    if (c.p) b[c.bucket_p] = Math.max(0, b[c.bucket_p] - c.p);
    const fs = model.run(live.filter(r => r !== c.row)).state;
    const without = scoreFromState(b, score.strong.length - (c.strong ? 1 : 0), m0, fs ? { s: fs.s, d: fs.d, at: fs.at, n: fs.n } : null, now);
    const dt = score.t1000 - without.t1000;
    items.push({ c, dt, mass: c.f + c.p + (reviewOf(c.row) ? 0.01 : 0) });
  }
  items.sort((x, y) => Math.abs(y.dt) - Math.abs(x.dt) || y.mass - x.mass || Number(y.c.row.at) - Number(x.c.row.at));
  return items.filter(x => x.dt !== 0 || x.mass >= 0.1).slice(0, WHY_MAX).map(x => whyItem(x.c, x.dt));
}

const SAFE_REF = /^[A-Za-z0-9#:.\- ]{1,24}$/;
export function safeRef(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return SAFE_REF.test(s) && /\d/.test(s) && s.split(/\s+/).length <= 4 ? s : null;
}

function questionWords(row, m) {
  // Named as the masses count it: over 90 s already weighs a little ("over pace"), over 120 s is slow (weights.js PACE).
  const pw = paceWord(row.time_s);
  const slow = pw === 'slow' || pw === 'over pace' ? `${pw} (${Math.round(Number(row.time_s))} s) ` : '';
  switch (m.rule) {
    case 'wrong_sure': return 'sure and wrong';
    case 'wrong_lean': return 'wrong when leaning';
    case 'wrong_guess': return 'guessed wrong';
    case 'wrong': return 'wrong';
    case 'omitted': return 'left blank';
    case 'wrong_changed_from_right': return 'changed a right answer to wrong';
    case 'right_guess': return `${slow}right by a guess`;
    case 'right_flawed': return `${slow}right for a shaky reason`;
    case 'right_changed_from_wrong': return `${slow}changed to right`;
    case 'shaky_elimination': return `${slow}right by shaky elimination`;
    case 'misread_detail': return `${slow}right despite a misread`;
    default: return `${slow}right`;
  }
}

// The words for one row, built by code from its facts (never question or gap text).
export function rowWords(row, m = evidenceMass(row)) {
  const ref = safeRef(detailOf(row).label) || safeRef(row.source_ref);
  const on = ref ? ` on ${ref}` : '';
  const res = m.rule;
  switch (row.kind) {
    case 'question': return questionWords(row, m) + on;
    case 'confused_with': return `picked as the look-alike${on}`;
    case 'retest': return `re-test ${res === 'got_it' ? 'right' : 'missed'}${on}`;
    case 'card_lapse': return res === 'first_sight' ? `a card forgotten ${Number(row.amount ?? detailOf(row).lapses) || 0} times` : 'a card lapsed';
    case 'card_check': return res === 'card_weak_part' ? 'parts of a card missed' : res === 'card_lapse' ? 'a card lapsed'
      : `a card check (${lower(row.verdict) || 'gap'})`;
    case 'card_weak_part': return res === 'card_lapse' ? 'a card lapsed' : 'parts of a card missed';
    case 'card_mature': return 'a mature card';
    case 'card_review': return `a card rated ${res || lower(row.rating) || 'in Anki'}`;
    case 'lesson_probe': return `a lesson question ${res || 'skipped'}`;
    case 'lesson_final': return `a lesson's final case ${res || 'skipped'}`;
    case 'pair_item': return `a look-alike drill case ${res || 'skipped'}`;
    case 'gap_stated': return lower(row.verdict) === 'shaky' ? 'a shaky spot you named' : 'a gap you named';
    case 'self_mastered': return 'a step ticked mastered';
    case 'self_rating': return `rated ${lower(row.rating)}`;
    default: return String(row.kind || 'evidence').replace(/_/g, ' ');
  }
}

function whyItem(c, dt) {
  const r = c.row;
  const item = { label: rowWords(r, c.m), kind: r.kind, day: r.day || null, dt };
  if (r.gap_id != null) item.gap_id = String(r.gap_id);
  if (r.miss_id != null) item.miss_id = String(r.miss_id);
  if (r.card_id != null) item.card_id = Number(r.card_id);
  return item;
}

// "today", "yesterday" or "on 22 Oct", from a YYYY-MM-DD day and now (London).
export function dayWords(day, now = Date.now()) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const today = londonDay(now);
  if (day === today) return 'today';
  if (day === londonDay(now - DAY_MS)) return 'yesterday';
  const [, mo, d] = day.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `on ${d} ${MONTHS[mo - 1]}`;
}

const WHY_LINE_MAX = 200;

/**
 * One sentence for a colour, from the stored row and its why_json: "Weak: sure and wrong on UW 19038 yesterday;
 * no right answer since." The weak bands name what pulls the topic down, the strong ones what holds it up.
 */
export function whyLine(score, why, now = Date.now()) {
  const s = score || {};
  const band = s.band || bandOf(s.t1000 ?? (s.t != null ? Math.round(Number(s.t) * 1000) : null));
  if (!Number(s.seen) || band === 'unseen') return 'Not seen yet.';
  let items = Array.isArray(why) ? why : (() => { try { return JSON.parse(why || '[]'); } catch { return []; } })();
  items = items.filter(x => x && typeof x.label === 'string');
  const weakSide = band === 'weak' || band === 'very_weak';
  const strongSide = band === 'strong' || band === 'good';
  let pick = items.filter(x => (weakSide ? x.dt > 0 : strongSide ? x.dt < 0 : true));
  if (!pick.length) pick = items;
  const parts = pick.map(x => [x.label, dayWords(x.day, now)].filter(Boolean).join(' '));
  const lastQ = Number(s.last_question_at) || 0, lastMiss = Number(s.last_miss_at) || 0;
  if (weakSide && lastMiss && lastMiss >= lastQ) parts.push('no right answer since');
  let line = `${bandWord(band)}: ${parts.length ? parts.join('; ') : 'not much to go on yet'}.`;
  while (line.length > WHY_LINE_MAX && parts.length > 1) {
    parts.splice(parts.length - (parts[parts.length - 1] === 'no right answer since' ? 2 : 1), 1);
    line = `${bandWord(band)}: ${parts.join('; ')}.`;
  }
  return line.length > WHY_LINE_MAX ? line.slice(0, WHY_LINE_MAX - 1) + '…' : line;
}

// ------------------------------------------------------------------ stored rows

export const SCORE_COLS = [
  'user_id', 'topic_id', 'seen', 'first_seen_at', 'last_seen_at', 'last_question_at', 'last_miss_at', 'category_id', 'prior_mastery', 'ref_at',
  ...BUCKET_NAMES, 'strong_fails_json', 'mastery', 'weakness', 'weakness_raw', 't', 'band', 'certainty', 'certainty_level',
  'n_seen', 'questions_n', 'right_n', 'misses_n', 'sure_wrong_n', 'slow_n', 'cards_n', 'lapses_n', 'lessons_n', 'retests_n', 'gaps_n',
  'why_json', 'evidence_at', 'computed_at', 'refreshed_at', 'formula_version',
  'fsrs_s', 'fsrs_d', 'fsrs_at', 'fsrs_n', 'trend',
];
const COUNT_COLS = ['n_seen', 'questions_n', 'right_n', 'misses_n', 'sure_wrong_n', 'slow_n', 'cards_n', 'lapses_n', 'lessons_n', 'retests_n', 'gaps_n'];

// The topic_scores columns for a score (from scoreTopic or readScore over a stored state).
export function scoreColumns(user, topicId, s, { category_id = null, now = Date.now(), computed_at = now } = {}) {
  const row = {
    user_id: user, topic_id: topicId, seen: s.seen ? 1 : 0, first_seen_at: s.first_seen_at ?? null, last_seen_at: s.last_seen_at ?? null,
    last_question_at: s.last_question_at ?? null, last_miss_at: s.last_miss_at ?? null, category_id, prior_mastery: round(s.prior_mastery, 6),
    ref_at: s.ref_at ?? now, strong_fails_json: JSON.stringify(s.strong || []),
    mastery: s.mastery, weakness: s.weakness, weakness_raw: s.weakness_raw, t: s.t1000 == null ? null : s.t1000 / 1000,
    band: s.band, certainty: s.certainty, certainty_level: s.certainty_level,
    why_json: JSON.stringify(s.why || []), evidence_at: s.evidence_at ?? null, computed_at, refreshed_at: now, formula_version: WEIGHTS_VERSION,
    fsrs_s: s.fsrs ? round(s.fsrs.s, 6) : null, fsrs_d: s.fsrs ? round(s.fsrs.d, 6) : null, fsrs_at: s.fsrs ? Math.round(s.fsrs.at) : null,
    fsrs_n: s.fsrs ? round(s.fsrs.n, 6) : 0, trend: s.trend ?? null,
  };
  for (const b of BUCKET_NAMES) row[b] = s.buckets ? s.buckets[b] || 0 : 0;
  for (const c of COUNT_COLS) row[c] = s.counts && s.counts[c] != null ? s.counts[c] : (s[c] ?? null);
  return row;
}

// A stored topic_scores row back into a state readScore can decay.
export function stateOf(stored) {
  const buckets = {};
  for (const b of BUCKET_NAMES) buckets[b] = Number(stored[b]) || 0;
  let strong = [];
  try { strong = JSON.parse(stored.strong_fails_json || '[]'); } catch { strong = []; }
  let why = [];
  try { why = JSON.parse(stored.why_json || '[]'); } catch { why = []; }
  const counts = Object.fromEntries(COUNT_COLS.map(c => [c, stored[c] ?? null]));
  // Formula 3 rows carry their FSRS state (null when seen without a review); older rows read the old way.
  const fsrs = stored.fsrs_at != null && stored.fsrs_s != null
    ? { s: Number(stored.fsrs_s), d: Number(stored.fsrs_d) || 5, at: Number(stored.fsrs_at), n: Number(stored.fsrs_n) || 0 }
    : Number(stored.formula_version) >= 3 ? null : undefined;
  return {
    fsrs, trend: stored.trend ?? null,
    seen: Number(stored.seen) ? 1 : 0, ref_at: Number(stored.ref_at) || 0, buckets, strong: Array.isArray(strong) ? strong : [], why, counts,
    first_seen_at: stored.first_seen_at ?? null, last_seen_at: stored.last_seen_at ?? null, last_question_at: stored.last_question_at ?? null,
    last_miss_at: stored.last_miss_at ?? null, evidence_at: stored.evidence_at ?? null,
  };
}

const t1000Of = row => (row && row.t != null ? Math.round(Number(row.t) * 1000) : null);

/**
 * Upserts of topic_scores rows, one JSON parameter per 150 rows. cas: when true, each row carries the ev_rev it
 * was read at and is only rewritten while ev_rev still equals it (for the cron's own writes; changes get theirs
 * from realtime's writeBatch). category_id falls back to the topic's own (a topic added in the same batch).
 */
export function scoreUpserts(DB, rows, { cas = false } = {}) {
  if (!rows.length) return [];
  const cols = cas ? [...SCORE_COLS, 'ev_rev'] : SCORE_COLS;
  const sel = cols.map(c => (c === 'category_id'
    ? `coalesce(json_extract(value, '$.category_id'), (SELECT tp.category_id FROM topics tp WHERE tp.user_id = json_extract(value, '$.user_id') AND tp.id = json_extract(value, '$.topic_id')))`
    : `json_extract(value, '$.${c}')`)).join(', ');
  const set = SCORE_COLS.filter(c => c !== 'user_id' && c !== 'topic_id').map(c => `${c} = excluded.${c}`).join(', ');
  const guard = cas ? ' WHERE topic_scores.ev_rev = excluded.ev_rev' : '';
  return chunks(rows).map(part => DB.prepare(`INSERT INTO topic_scores (${cols.join(', ')}) SELECT ${sel} FROM json_each(?) WHERE true
      ON CONFLICT (user_id, topic_id) DO UPDATE SET ${set}${guard}`).bind(JSON.stringify(part)));
}

// A score.changed event when the band changes, t1000 moves by 20 or more, or seen flips (plan §6.9, §7.3).
export function scoreEvent(prev, next, { topic_id, name = null, min_dt = EVENT_T } = {}) {
  const prevT = prev ? t1000Of(prev) : null;
  const prevBand = prev ? prev.band || 'unseen' : 'unseen';
  const prevSeen = prev ? (Number(prev.seen) ? 1 : 0) : 0;
  const seen = next.seen ? 1 : 0;
  const moved = prevT != null && next.t1000 != null && Math.abs(next.t1000 - prevT) >= min_dt;
  if (!(next.band !== prevBand || moved || seen !== prevSeen)) return null;
  const who = summaryOf(name || topic_id).slice(0, 100);
  const word = bandWord(next.band);
  let summary;
  if (seen && !prevSeen) summary = `${who} is on the map: ${word}`;
  else if (next.band !== prevBand) summary = `${who} is now ${word} (was ${bandWord(prevBand)})`;
  else summary = `${who} is still ${word}, a little ${next.t1000 > prevT ? 'weaker' : 'stronger'}`;
  return {
    kind: 'score.changed', target_type: 'topic', target_id: topic_id, topic_id, summary: summaryOf(summary),
    after: { t1000: next.t1000, c100: next.cert100 ?? 0, band: next.band, seen, prev_t1000: prevT, prev_band: prevBand },
  };
}

// ------------------------------------------------------------------ reads

const ids = list => JSON.stringify([...new Set((list || []).filter(x => x != null && x !== '').map(String))]);

/**
 * One read batch for scoring topics: their live evidence, their stored scores, the topics themselves and the
 * user's category priors. Returns {rows: [evidence], stored: Map, topics: Map, priors: {category_id: prior}, g}.
 */
export async function loadForScore(env, user, topicIds) {
  const list = ids(topicIds);
  const res = await env.DB.batch([
    env.DB.prepare('SELECT * FROM evidence_live WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))').bind(user, list),
    env.DB.prepare('SELECT * FROM topic_scores WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))').bind(user, list),
    env.DB.prepare('SELECT id, name, category_id, status FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(user, list),
    env.DB.prepare('SELECT category_id, prior, g FROM category_priors WHERE user_id = ?1').bind(user),
    env.DB.prepare("SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = 'anki.fsrs'").bind(user),
  ]);
  const priors = {};
  let g = null;
  for (const p of res[3].results || []) { priors[p.category_id] = Number(p.prior); g = g ?? p.g; }
  return {
    rows: res[0].results || [],
    stored: new Map((res[1].results || []).map(r => [r.topic_id, r])),
    topics: new Map((res[2].results || []).map(r => [r.id, r])),
    priors, g,
    model: modelFromStored(((res[4] && res[4].results) || [])[0]?.cursor ?? null, env),
  };
}

// The rows after a change: removed keys go (every slot of a bare obs_key), pending rows replace their key.
export function applyPending(rows, pending = [], removed = []) {
  const gone = new Set(), goneSlot = new Set();
  for (const k of removed || []) {
    if (typeof k === 'string') gone.add(k);
    else if (k && k.obs_key != null) (k.slot == null ? gone.add(k.obs_key) : goneSlot.add(`${k.obs_key}#${Number(k.slot) || 0}`));
  }
  const key = r => `${r.obs_key}#${Number(r.slot) || 0}`;
  const incoming = new Map();
  for (const r of pending || []) if (r && r.obs_key != null) incoming.set(key(r), r);
  const out = (rows || []).filter(r => !gone.has(r.obs_key) && !goneSlot.has(key(r)) && !incoming.has(key(r)));
  for (const r of incoming.values()) if (Number(r.held) !== 1) out.push(r);
  return out;
}

// The most common category among a topic's rows (for a topic whose own row is not readable yet).
function rowsCategory(rows) {
  const n = new Map();
  for (const r of rows) if (r.category_id != null) n.set(r.category_id, (n.get(r.category_id) || 0) + 1);
  let best = null, max = 0;
  for (const [c, k] of n) if (k > max) { best = c; max = k; }
  return best;
}

/**
 * Same-batch recompute (plan §7.3). Reads the topics' live evidence, applies the change's pending and removed
 * rows in memory, scores every topic (unseen ones too, carrying weakness_raw = 1 − m0) and returns
 * {statements, events, scores}. Realtime's writeBatch puts the statements in the change's own batch between its
 * compare-and-set and the ev_rev bump. More than 20 topics: the rest go to topic_dirty.
 */
export async function recomputeTopics(env, user, topicIds, { pending = [], removed = [], now = Date.now(), cas = false, loaded = null } = {}) {
  const all = [...new Set((topicIds || []).filter(x => x != null && x !== '').map(String))];
  const out = { statements: [], events: [], scores: {} };
  if (!all.length) return out;
  const mine = all.slice(0, SAME_BATCH_MAX), rest = all.slice(SAME_BATCH_MAX);
  const data = loaded || await loadForScore(env, user, mine);
  const rows = applyPending(data.rows, pending, removed);
  const byTopic = new Map(mine.map(t => [t, []]));
  for (const r of rows) if (r.topic_id != null && byTopic.has(String(r.topic_id))) byTopic.get(String(r.topic_id)).push({ updated_at: now, ...r });
  const writes = [];
  for (const [topicId, list] of byTopic) {
    const stored = data.stored.get(topicId) || null;
    const topic = data.topics.get(topicId) || null;
    const category_id = topic ? topic.category_id : stored ? stored.category_id : rowsCategory(list);
    // Decay never deletes rows, so a seen topic stays seen; only an undo of its last row makes it unseen again.
    const s = scoreTopic(list, m0For(category_id, data.priors, data.g), now, data.model || MODEL);
    const row = scoreColumns(user, topicId, s, { category_id, now });
    if (cas) row.ev_rev = stored ? Number(stored.ev_rev) || 0 : 0;
    writes.push(row);
    out.scores[topicId] = { t1000: s.t1000, c100: s.cert100, band: s.band, seen: s.seen, prev_t1000: t1000Of(stored), prev_band: stored ? stored.band : 'unseen' };
    const ev = scoreEvent(stored, s, { topic_id: topicId, name: topic && topic.name });
    if (ev) out.events.push(ev);
  }
  out.statements.push(...scoreUpserts(env.DB, writes, { cas }));
  if (rest.length) out.statements.push(dirtyInsert(env.DB, user, rest, 'bulk', now));
  return out;
}

const dirtyInsert = (DB, user, topics, reason, now) => DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at)
    SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`)
  .bind(user, reason, now, JSON.stringify(topics));

// ------------------------------------------------------------------ hourly decay

const DECAY_SOURCE = 'scores.decay';
const hourKey = now => Math.floor(now / 3600000);

// Whether a refreshed row differs enough from its stored self to be rewritten.
function worthWriting(stored, next) {
  const prevT = t1000Of(stored);
  if ((stored.band || 'unseen') !== next.band) return true;
  if (prevT != null && next.t1000 != null && Math.abs(next.t1000 - prevT) >= REFRESH_T) return true;
  if (Math.abs((Number(stored.weakness_raw) || 0) - (next.weakness_raw || 0)) >= REFRESH_RAW) return true;
  return Math.abs(Math.round(100 * (Number(stored.certainty) || 0)) - next.cert100) >= REFRESH_CERT;
}

/**
 * Hourly decay (plan §7.3): decays the stored group masses of up to `limit` seen rows to now, in topic order from
 * this hour's cursor, and rewrites only rows whose t1000 moved by 10 or more, whose band changed, or whose
 * ungated weakness_raw (teach's N) or certainty moved. Writes through realtime's writeBatch with one
 * scores.refreshed event (and score.changed for band changes). Each row is guarded by its ev_rev, so a change
 * that lands meanwhile is never overwritten. Returns {n, written, changed, done}.
 */
export async function refreshScores(env, user, { now = Date.now(), limit = 500 } = {}) {
  const hour = hourKey(now);
  const n = Math.max(1, Math.min(5000, limit | 0 || 500));
  let res;
  try {
    res = await env.DB.prepare(`SELECT s.*, tp.name AS topic_name FROM topic_scores s
        LEFT JOIN topics tp ON tp.user_id = s.user_id AND tp.id = s.topic_id
        WHERE s.user_id = ?1 AND s.seen = 1
          AND NOT EXISTS (SELECT 1 FROM sync_state c WHERE c.user_id = ?1 AND c.source = ?2
            AND json_extract(c.cursor, '$.hour') = ?3 AND json_extract(c.cursor, '$.done') = 1)
          AND s.topic_id > coalesce((SELECT json_extract(c.cursor, '$.after') FROM sync_state c WHERE c.user_id = ?1 AND c.source = ?2
            AND json_extract(c.cursor, '$.hour') = ?3), '')
        ORDER BY s.topic_id LIMIT ?4`).bind(user, DECAY_SOURCE, hour, n).all();
  } catch (e) {
    if (noTable(e)) return { n: 0, written: 0, changed: [], done: true, error: 'not_ready' };
    throw e;
  }
  const rows = res.results || [];
  const done = rows.length < n;
  const writes = [], events = [], changed = [];
  for (const stored of rows) {
    const st = stateOf(stored);
    const next = readScore(st, now, Number(stored.prior_mastery));
    if (!worthWriting(stored, next)) continue;
    const full = { ...st, ...next, counts: st.counts, why: st.why, evidence_at: st.evidence_at };
    const row = scoreColumns(user, stored.topic_id, full, { category_id: stored.category_id, now, computed_at: Number(stored.computed_at) || now });
    row.formula_version = Number(stored.formula_version) || WEIGHTS_VERSION;   // a decay is not a recompute
    row.ev_rev = Number(stored.ev_rev) || 0;
    writes.push(row);
    changed.push([stored.topic_id, next.t1000, next.cert100]);
    if ((stored.band || 'unseen') !== next.band) {
      const ev = scoreEvent(stored, next, { topic_id: stored.topic_id, name: stored.topic_name });
      if (ev) events.push(ev);
    }
  }
  const cursor = JSON.stringify({ hour, after: rows.length ? rows[rows.length - 1].topic_id : '', done: done ? 1 : 0 });
  const statements = [
    ...scoreUpserts(env.DB, writes, { cas: true }),
    env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, DECAY_SOURCE, cursor, now),
  ];
  if (changed.length) events.push(refreshedEvent(changed, {}));
  if (!rows.length && done) {
    await env.DB.batch(statements);
    return { n: 0, written: 0, changed: [], done };
  }
  await commit(env, user, statements, events, 'cron:refreshScores');
  return { n: rows.length, written: writes.length, changed, done };
}

function refreshedEvent(changed, extra) {
  const n = changed.length;
  return {
    kind: 'scores.refreshed', target_type: 'scores', target_id: null,
    summary: `Colours refreshed for ${n} topic${n === 1 ? '' : 's'}`,
    after: { n, changed: changed.slice(0, 300), ...extra },
  };
}

// Statements and events in one batch through realtime's writer (actor cron, nothing to undo).
async function commit(env, user, statements, events, via) {
  if (events.length) return writeBatch(env, user, { actor: 'cron', surface: 'cron', via, statements, events, undoable: false });
  if (statements.length) await env.DB.batch(statements);
  return null;
}

// ------------------------------------------------------------------ repair

/**
 * Finds topics whose stored score is stale and puts them in topic_dirty, which realtime's drainDirty clears
 * (plan §7.3 repair): evidence newer than the score's evidence_at (a failed or skipped recompute, a move from
 * the queue), an old formula_version, a live topic with no score row yet, and a row whose category or prior no
 * longer matches. Returns {ids}.
 */
export async function repairScores(env, user, { now = Date.now(), limit = 30, since = null } = {}) {
  const n = Math.max(1, Math.min(200, limit | 0 || 30));
  const from = since ?? now - 7 * DAY_MS;
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`SELECT DISTINCT e.topic_id FROM evidence_live e
          LEFT JOIN topic_scores s ON s.user_id = e.user_id AND s.topic_id = e.topic_id
          WHERE e.user_id = ?1 AND e.topic_id IS NOT NULL AND e.updated_at > ?2
            AND (s.topic_id IS NULL OR s.evidence_at IS NULL OR e.updated_at > s.evidence_at) LIMIT ?3`).bind(user, from, n),
      env.DB.prepare('SELECT topic_id FROM topic_scores WHERE user_id = ?1 AND formula_version < ?2 LIMIT ?3').bind(user, WEIGHTS_VERSION, n),
      env.DB.prepare(`SELECT tp.id AS topic_id FROM topics tp LEFT JOIN topic_scores s ON s.user_id = tp.user_id AND s.topic_id = tp.id
          WHERE tp.user_id = ?1 AND tp.status IN ('proposed', 'confirmed') AND s.topic_id IS NULL LIMIT ?2`).bind(user, n),
      env.DB.prepare(`SELECT s.topic_id FROM topic_scores s JOIN topics tp ON tp.user_id = s.user_id AND tp.id = s.topic_id
          LEFT JOIN category_priors p ON p.user_id = s.user_id AND p.category_id = tp.category_id
          WHERE s.user_id = ?1 AND tp.status IN ('proposed', 'confirmed')
            AND (s.category_id IS NOT tp.category_id OR (p.prior IS NOT NULL AND abs(s.prior_mastery - p.prior) >= ?2)) LIMIT ?3`)
        .bind(user, PRIOR_MOVE, n),
    ]);
  } catch (e) {
    if (noTable(e)) return { ids: [], error: 'not_ready' };
    throw e;
  }
  const found = [...new Set(res.flatMap(r => (r.results || []).map(x => x.topic_id)).filter(Boolean))].slice(0, n);
  if (found.length) await env.DB.batch([dirtyInsert(env.DB, user, found, 'repair', now)]);
  return { ids: found };
}

// ------------------------------------------------------------------ priors

export async function refreshPriors(env, user, { now = Date.now() } = {}) {
  const from = now - PRIOR.days * DAY_MS;
  const reads = [
    env.DB.prepare(`SELECT category_id, count(*) AS n, sum(CASE WHEN result IN ('right', 'flawed') THEN 1 ELSE 0 END) AS right_n
        FROM evidence_live WHERE user_id = ?1 AND kind = 'question' AND slot = 0 AND at >= ?2
          AND result IN ('right', 'flawed', 'wrong', 'omitted')
          AND json_extract(detail_json, '$.from_block') = 1 AND coalesce(json_extract(detail_json, '$.redo'), 0) = 0
        GROUP BY category_id`).bind(user, from),
    env.DB.prepare('SELECT * FROM category_priors WHERE user_id = ?1').bind(user),
    env.DB.prepare(`SELECT s.*, tp.category_id AS topic_category, tp.name AS topic_name FROM topic_scores s
        LEFT JOIN topics tp ON tp.user_id = s.user_id AND tp.id = s.topic_id WHERE s.user_id = ?1`).bind(user),
  ];
  if (user === 'mo') {
    reads.push(env.DB.prepare(`SELECT sum(b.correct) AS correct, sum(b.scored) AS scored FROM blocks b JOIN sittings st ON st.id = b.sitting_id
        WHERE st.status = 'done' AND b.ended_at >= ?1 AND b.scored > 0`).bind(from));
  }
  let res;
  try { res = await env.DB.batch(reads); } catch (e) {
    if (noTable(e)) return { priors: {}, g: null, written: 0, error: 'not_ready' };
    throw e;
  }
  const groups = res[0].results || [];
  const nbme = res[3] ? (res[3].results || [])[0] || {} : {};
  const storedRows = res[2].results || [];
  const extra = [...(res[1].results || []).map(p => p.category_id), ...storedRows.map(s => s.topic_category ?? s.category_id)];
  const { priors, g, priorRows } = priorsFrom(user, groups, nbme, extra, now);
  const { writes, events } = rereadScores(user, storedRows, priors, g, now);
  const statements = [...priorUpserts(env.DB, priorRows), ...scoreUpserts(env.DB, writes, { cas: true })];
  if (statements.length) await commit(env, user, statements, events, 'cron:refreshPriors');
  return { priors, g, written: writes.length };
}

// The prior-reading parts of refreshPriors, shared with taxonomy.remap (which moves topics between systems and
// so recomputes the priors and every stored score in its own batch, and again on undo).

export function priorsFrom(user, groups, nbme = {}, extraCats = [], now = Date.now()) {
  let right = Number(nbme && nbme.correct) || 0, total = Number(nbme && nbme.scored) || 0;
  for (const r of groups) { right += Number(r.right_n) || 0; total += Number(r.n) || 0; }
  const g = total ? gOf(right / total) : PRIOR.g_default;
  const cats = new Map();
  for (const r of groups) {
    if (r.category_id == null) continue;
    const c = cats.get(r.category_id) || { n: 0, right_n: 0 };
    cats.set(r.category_id, { n: c.n + (Number(r.n) || 0), right_n: c.right_n + (Number(r.right_n) || 0) });
  }
  for (const c of extraCats) if (c != null && !cats.has(c)) cats.set(c, { n: 0, right_n: 0 });
  const priors = {};
  const priorRows = [];
  for (const [category_id, c] of cats) {
    priors[category_id] = priorOf(c.n, c.right_n, g);
    priorRows.push({ user_id: user, category_id, prior: round(priors[category_id], 6), right_n: c.right_n, n: c.n, g: round(g, 6), updated_at: now });
  }
  return { priors, g, priorRows };
}

/** category_priors upserts for rows {user_id, category_id, prior, right_n, n, g, updated_at}. */
export function priorUpserts(DB, priorRows) {
  return chunks(priorRows).map(part => DB.prepare(`INSERT INTO category_priors (user_id, category_id, prior, right_n, n, g, updated_at)
      SELECT json_extract(value, '$.user_id'), json_extract(value, '$.category_id'), json_extract(value, '$.prior'), json_extract(value, '$.right_n'),
        json_extract(value, '$.n'), json_extract(value, '$.g'), json_extract(value, '$.updated_at') FROM json_each(?) WHERE true
      ON CONFLICT (user_id, category_id) DO UPDATE SET prior = excluded.prior, right_n = excluded.right_n, n = excluded.n, g = excluded.g,
        updated_at = excluded.updated_at`).bind(JSON.stringify(part)));
}

/**
 * Stored score rows re-read with new priors: every row whose prior moves by PRIOR_MOVE or more, or whose category
 * changes, is read again (no evidence read: the decayed masses are stored). storedRows: topic_scores rows with
 * topic_category (the topic's category now, or the one it is moving to) and topic_name. Returns {writes, changed, events}.
 */
export function rereadScores(user, storedRows, priors, g, now = Date.now()) {
  const writes = [], changed = [], events = [];
  for (const s of storedRows) {
    const category_id = s.topic_category ?? s.category_id;
    const m0 = m0For(category_id, priors, g);
    if (Math.abs(m0 - (Number(s.prior_mastery) || 0)) < PRIOR_MOVE && (category_id ?? null) === (s.category_id ?? null)) continue;
    const st = stateOf(s);
    const next = readScore(st, now, m0);
    const full = { ...st, ...next, counts: st.counts, why: st.why, evidence_at: st.evidence_at };
    const row = scoreColumns(user, s.topic_id, full, { category_id, now, computed_at: Number(s.computed_at) || now });
    row.formula_version = Number(s.formula_version) || WEIGHTS_VERSION;
    row.ev_rev = Number(s.ev_rev) || 0;
    writes.push(row);
    if (next.t1000 !== t1000Of(s) || next.band !== s.band) changed.push([s.topic_id, next.t1000, next.cert100]);
    if ((s.band || 'unseen') !== next.band) {
      const ev = scoreEvent(s, next, { topic_id: s.topic_id, name: s.topic_name });
      if (ev) events.push(ev);
    }
  }
  if (changed.length) events.push(refreshedEvent(changed, { priors: 1 }));
  return { writes, changed, events };
}

/**
 * refreshPriors when this user has no category priors yet (the first hours after release, before the 03:44 run),
 * so the first colours are already read with real priors. One read when they exist. Returns null or refreshPriors' result.
 */
export async function priorsIfMissing(env, user, opts = {}) {
  let have;
  try { have = await env.DB.prepare('SELECT 1 AS x FROM category_priors WHERE user_id = ?1 LIMIT 1').bind(user).first(); } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
  return have ? null : refreshPriors(env, user, opts);
}

// ------------------------------------------------------------------ summaries

const SUMMARY_BANDS = ['strong', 'good', 'mixed', 'weak', 'very_weak', 'unseen'];
const weightOf = y => Math.max(Number(y) || 0, 0.05);

/**
 * A yield-weighted summary of some topics' stored scores (a category, a unit). rows: topic_scores columns
 * joined with topics.yield ({yield, seen, mastery, t, band, certainty}). Plan §7.3; the weights are
 * w = max(yield, 0.05), and a topic in two categories counts fully in both.
 */
export function summarise(rows) {
  const dist = Object.fromEntries(SUMMARY_BANDS.map(b => [b, 0]));
  let wAll = 0, wSeen = 0, wm = 0, wc = 0, wWeak = 0;
  let n_seen = 0, n_weak = 0, n_very_weak = 0;
  const list = rows || [];
  for (const r of list) {
    const w = weightOf(r.yield);
    wAll += w;
    const seen = Number(r.seen) === 1;
    const band = seen ? (r.band || bandOf(t1000Of(r))) : 'unseen';
    dist[SUMMARY_BANDS.includes(band) ? band : 'unseen'] += w;
    if (!seen) continue;
    n_seen++;
    wSeen += w;
    wm += w * (Number(r.mastery) || 0);
    wc += w * Math.round(100 * (Number(r.certainty) || 0));
    if (band === 'weak' || band === 'very_weak') { n_weak++; wWeak += w; }
    if (band === 'very_weak') n_very_weak++;
  }
  const mastery = wSeen ? wm / wSeen : null;
  const t1000 = mastery == null ? null : Math.round(1000 * clamp((0.85 - mastery) / 0.55, 0, 1));
  const coverage = wAll ? wSeen / wAll : 0;
  for (const b of SUMMARY_BANDS) dist[b] = wAll ? dist[b] / wAll : 0;
  return {
    n_topics: list.length, n_seen, n_weak, n_very_weak, n_unseen: list.length - n_seen,
    mastery, t1000, band: bandOf(t1000), cert100: wSeen ? Math.round(wc / wSeen) : 0,
    coverage, weak_share: wSeen ? wWeak / wSeen : 0, dist,
    hull: { t1000, alpha: t1000 == null ? 0.05 : 0.05 + 0.15 * coverage },
  };
}
export const categorySummary = rows => summarise(rows);
export const unitSummaryOf = rows => summarise(rows);

// The same summary in SQL over one GROUP BY (binds ?1 = user). Columns match summarise().
const SUMMARY_SELECT = `count(*) AS n_topics,
    sum(CASE WHEN s.seen = 1 THEN 1 ELSE 0 END) AS n_seen,
    sum(CASE WHEN s.seen = 1 AND s.band IN ('weak', 'very_weak') THEN 1 ELSE 0 END) AS n_weak,
    sum(CASE WHEN s.seen = 1 AND s.band = 'very_weak' THEN 1 ELSE 0 END) AS n_very_weak,
    sum(CASE WHEN s.seen = 1 THEN max(tp.yield, 0.05) * s.mastery END) / sum(CASE WHEN s.seen = 1 THEN max(tp.yield, 0.05) END) AS mastery,
    sum(CASE WHEN s.seen = 1 THEN max(tp.yield, 0.05) END) AS w_seen,
    sum(max(tp.yield, 0.05)) AS w_all,
    sum(CASE WHEN s.seen = 1 THEN max(tp.yield, 0.05) * round(100 * s.certainty) END) AS wc,
    sum(CASE WHEN s.seen = 1 AND s.band IN ('weak', 'very_weak') THEN max(tp.yield, 0.05) END) AS w_weak_share,
    ${SUMMARY_BANDS.map(b => `sum(CASE WHEN ${b === 'unseen' ? "coalesce(s.seen, 0) = 0" : `s.seen = 1 AND s.band = '${b}'`} THEN max(tp.yield, 0.05) ELSE 0 END) AS w_${b}`).join(',\n    ')}`;

export const CATEGORY_SUMMARY_SQL = `SELECT CASE w.k WHEN 0 THEN tp.category_id ELSE tp.category2_id END AS category_id, ${SUMMARY_SELECT}
  FROM topics tp JOIN (SELECT 0 AS k UNION ALL SELECT 1) w ON w.k = 0 OR (tp.category2_id IS NOT NULL AND tp.category2_id IS NOT tp.category_id)
  LEFT JOIN topic_scores s ON s.user_id = tp.user_id AND s.topic_id = tp.id
  WHERE tp.user_id = ?1 AND tp.status IN ('proposed', 'confirmed')
  GROUP BY CASE w.k WHEN 0 THEN tp.category_id ELSE tp.category2_id END`;

// A CTE for the Review page's unit chips (WITH unit_summary AS (...)); binds ?1 = user.
export const UNIT_SUMMARY_SQL = `unit_summary AS (SELECT ut.unit_id, ${SUMMARY_SELECT}
  FROM unit_topics ut JOIN topics tp ON tp.user_id = ut.user_id AND tp.id = ut.topic_id AND tp.status IN ('proposed', 'confirmed')
  LEFT JOIN topic_scores s ON s.user_id = tp.user_id AND s.topic_id = tp.id
  WHERE ut.user_id = ?1 GROUP BY ut.unit_id)`;

// One SQL summary row in summarise()'s shape.
export function summaryFromSql(r) {
  const wAll = Number(r.w_all) || 0, wSeen = Number(r.w_seen) || 0;
  const mastery = r.mastery == null ? null : Number(r.mastery);
  const t1000 = mastery == null ? null : Math.round(1000 * clamp((0.85 - mastery) / 0.55, 0, 1));
  const coverage = wAll ? wSeen / wAll : 0;
  const n_topics = Number(r.n_topics) || 0, n_seen = Number(r.n_seen) || 0;
  return {
    n_topics, n_seen, n_weak: Number(r.n_weak) || 0, n_very_weak: Number(r.n_very_weak) || 0, n_unseen: n_topics - n_seen,
    mastery, t1000, band: bandOf(t1000), cert100: wSeen ? Math.round((Number(r.wc) || 0) / wSeen) : 0,
    coverage, weak_share: wSeen ? (Number(r.w_weak_share) || 0) / wSeen : 0,
    dist: Object.fromEntries(SUMMARY_BANDS.map(b => [b, wAll ? (Number(r[`w_${b}`]) || 0) / wAll : 0])),
    hull: { t1000, alpha: t1000 == null ? 0.05 : 0.05 + 0.15 * coverage },
  };
}

// Unit chips for some units (all of the user's when unitIds is empty): {unit_id: summary}.
export async function unitSummary(env, user, unitIds = []) {
  const want = [...new Set((unitIds || []).filter(Boolean).map(String))];
  const where = want.length ? ' WHERE unit_id IN (SELECT value FROM json_each(?2))' : '';
  const st = env.DB.prepare(`WITH ${UNIT_SUMMARY_SQL} SELECT * FROM unit_summary${where}`);
  const { results } = await (want.length ? st.bind(user, JSON.stringify(want)) : st.bind(user)).all();
  return Object.fromEntries((results || []).map(r => [r.unit_id, summaryFromSql(r)]));
}

// Category summaries for the user: {category_id: summary}.
export async function categorySummaries(env, user) {
  const { results } = await env.DB.prepare(CATEGORY_SUMMARY_SQL).bind(user).all();
  return Object.fromEntries((results || []).map(r => [r.category_id, summaryFromSql(r)]));
}
