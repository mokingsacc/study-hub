import { FSRSAlgorithm, generatorParameters, default_w } from 'ts-fsrs';
import { questionBase, errorKeyOf, ERROR_MULT, PACE, detailOf, confidenceOf } from './weights.js';

export const FSRS_VERSION = 1;
export const DAY_MS = 86400000;

// The fitted settings (calibration of 25 Oct 2026). decay replaces FSRS-6's w20 (0.1542, a curve fitted to
// flashcards that stays high for weeks; ts-fsrs clamps it to 0.8): a new question on a topic is forgotten faster
// than one card's fact.
export const FIT = { decay: 0.8, lookahead_days: 14, k0: 3, fade_days: 14, s0_pass: 2, same_day: 'spread' };
export const W_DEFAULT = Object.freeze([...default_w]);
// s0_pass scales the first-review stabilities of Hard, Good and Easy (w1..w3): a right answer on a new question
// says more about a topic than one flashcard says about its fact.
export const fitW = (decay = FIT.decay, w = W_DEFAULT, s0_pass = FIT.s0_pass ?? 1) =>
  Object.freeze([w[0], w[1] * s0_pass, w[2] * s0_pass, w[3] * s0_pass, ...w.slice(4, 20), decay]);

export const GRADE = { again: 1, hard: 2, good: 3, easy: 4 };
const GRADE_NAME = ['', 'again', 'hard', 'good', 'easy'];
export const S_RANGE = [0.01, 3650];
export const TREND = { n: 5, eps: 0.03 };   // the trend reads up to the last 5 reviews; under 0.03 a review is steady

// How much each kind of review moves a topic (1 is a normal question).
export const REVIEW_W = {
  question: 1, retest: 1, confused_with: 0.3,
  lesson_final: 0.8, lesson_probe_right: 0.3, pair_item: 0.3,
  card_review: 0.5, card_lapse: 0.6, card_first_sight: 0.3, card_check: 0.4, card_mature: 0.5,
  gap_stated: 0.3, gap_shaky: 0.2, self_rating: 0.2, self_mastered: 0.1,
};
// Which question rules are which grade, and their weight before modifiers.
const Q_RULES = {
  wrong_sure: ['again', 1.2], wrong_lean: ['again', 1], wrong: ['again', 1], wrong_guess: ['again', 0.8], omitted: ['again', 0.8],
  wrong_changed_from_right: ['again', 0.8],
  right_guess: ['hard', 1], right_flawed: ['hard', 1], right_changed_from_wrong: ['hard', 1], shaky_elimination: ['hard', 1],
  misread_detail: ['hard', 0.8], right_sure: ['good', 1], right_lean: ['good', 1], right: ['good', 1],
};

const lower = v => (v == null ? null : String(v).trim().toLowerCase() || null);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// The "% of others correct" tempering, the same shape as weights.js questionMass: d = pct/100.
export function difficultyWeight(grade, pct) {
  const p = num(pct);
  if (p == null || p < 0 || p > 100) return 1;
  const d = p / 100;
  return grade === GRADE.again ? 0.6 + 0.8 * d : 0.6 + 0.8 * (1 - d);
}

function lessonResult(row) {
  const r = lower(row.result) || lower(row.outcome);
  if (r === 'right' || r === 'got_it' || r === 'correct') return 'right';
  if (r === 'partial' || r === 'half') return 'partial';
  if (r === 'wrong' || r === 'missed' || r === 'missed_again' || r === 'incorrect') return 'wrong';
  if (r === 'unsure' || r === 'not_sure' || r === 'not sure' || r === "don't know" || r === 'dont_know') return 'unsure';
  return null;
}

// Anki's ease (1..4) or a rating word -> a grade.
export function gradeOf(v) {
  const s = lower(v);
  if (s == null) return null;
  if (GRADE[s]) return GRADE[s];
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

/**
 * One evidence row as a review: {grade 1..4, w, real} or null. real: a question-side review (a question or a
 * re-test), which the gates count. Unknown kinds, held rows and states that say nothing are null.
 */
export function reviewOf(row) {
  if (!row || Number(row.held) === 1) return null;
  const kind = row.kind;
  const W = REVIEW_W;
  const mk = (g, w, real = false) => (w > 0 ? { grade: GRADE[g] ?? g, w, real } : null);
  switch (kind) {
    case 'question': {
      const base = questionBase(row);
      if (!base) return null;
      let [g, w] = Q_RULES[base.rule] || ['good', 1];
      if (g === 'again') w *= ERROR_MULT[errorKeyOf(row.error_type)] ?? 1;
      else {
        const t = num(row.time_s);
        if (t != null && t > PACE.slow_s) g = 'hard';
        else if (g === 'good' && t != null && t <= PACE.pace_s && (confidenceOf(row.confidence) === 'sure' || lower(row.verdict) === 'sound')) g = 'easy';
      }
      w *= difficultyWeight(GRADE[g], row.others_pct);
      return mk(g, w * W.question, true);
    }
    case 'retest': {
      const r = lower(row.outcome) || lower(row.result);
      if (r === 'got_it' || r === 'right') return mk('good', W.retest, true);
      if (r === 'missed_again' || r === 'missed' || r === 'wrong') return mk('again', W.retest, true);
      return null;
    }
    case 'confused_with': {
      const base = questionBase(row);
      if (!base || base.f <= 0) return null;
      return mk('again', W.confused_with * (ERROR_MULT[errorKeyOf(row.error_type)] ?? 1));
    }
    case 'lesson_final': {
      const r = lessonResult(row);
      if (!r) return null;
      if (r === 'right') return mk(confidenceOf(row.confidence) === 'guess' ? 'hard' : 'good', W.lesson_final);
      if (r === 'partial') return mk('hard', W.lesson_final);
      return mk('again', W.lesson_final);
    }
    case 'lesson_probe': return lessonResult(row) === 'right' ? mk('good', W.lesson_probe_right) : null;
    case 'pair_item': {
      const r = lessonResult(row);
      if (!r) return null;
      return mk(r === 'right' ? 'good' : 'again', W.pair_item);
    }
    case 'card_review': {
      const g = gradeOf(row.rating) ?? gradeOf(row.amount);
      return g ? mk(g, W.card_review) : null;
    }
    case 'card_lapse': {
      const d = detailOf(row);
      if (Number(d.first_sight) === 1) {
        const n = Math.max(0, num(row.amount) ?? num(d.lapses) ?? 0);
        return n > 0 ? mk('again', W.card_first_sight * Math.min(n, 4) / 2) : null;
      }
      return mk('again', W.card_lapse);
    }
    case 'card_check': case 'card_weak_part': {
      const d = detailOf(row);
      if (row.kind === 'card_lapse' || Number(d.lapsed) > 0) return mk('again', W.card_lapse);
      const v = lower(row.verdict) || (kind === 'card_check' ? 'gap' : null);
      if (v === 'gap' || (kind === 'card_weak_part' && !v)) return mk('again', W.card_check);
      if (v === 'shaky') return mk('hard', W.card_check);
      if (v === 'sound') return mk('good', W.card_check);
      return null;
    }
    case 'card_mature': return mk('good', W.card_mature);
    case 'gap_stated': return lower(row.verdict) === 'shaky' ? mk('hard', W.gap_shaky) : mk('again', W.gap_stated);
    case 'self_rating': { const g = gradeOf(row.rating); return g ? mk(g, W.self_rating) : null; }
    case 'self_mastered': return mk('good', W.self_mastered);
    default: return null;
  }
}

const CARD_DAY_KINDS = new Set(['card_review', 'card_check', 'card_lapse', 'card_weak_part', 'gap_stated']);
function cardDayKey(row, at) {
  if (!CARD_DAY_KINDS.has(row.kind) || row.card_id == null) return null;
  if (row.kind === 'card_lapse' && Number(detailOf(row).first_sight) === 1) return null;
  return `${row.card_id}|${row.day || new Date(at).toISOString().slice(0, 10)}`;
}

// A topic's cards on one day (ANKI-S4). Anki's review log brings every review, about a hundred a day, and a topic
// can have a dozen cards: each review stays a row (the panel and the why list read them), but FSRS hears a topic's
// card reviews of one day as one review, so flashcard recall never swamps the questions. Its grade: every card passed
// is Good (Easy when all were Easy), Hard if any was Hard, one lapse in four or more cards a weak pass (Hard), more
// lapses Again. Its weight grows with the cards, from the heaviest one's up to CARD_DAY_W.max (under one question's 1).
export const CARD_DAY_W = { step: 0.15, max: 0.8 };
export function cardDayGrade(grades) {
  const again = grades.filter(g => g === GRADE.again).length, hard = grades.filter(g => g === GRADE.hard).length;
  if (!again) return hard ? GRADE.hard : Math.min(...grades);
  return again * 4 <= grades.length ? GRADE.hard : GRADE.again;
}
function topicCardDays(revs) {
  const days = new Map();
  for (let i = 0; i < revs.length; i++) {
    const r = revs[i];
    if (!r.cardDay) continue;
    const g = days.get(r.cardDay);
    if (!g) { days.set(r.cardDay, { first: r, grades: [r.grade], w: r.w }); continue; }
    g.grades.push(r.grade);
    g.w = Math.max(g.w, r.w);
    if (r.at < g.first.at) g.first.at = r.at;
    revs[i] = null;
  }
  for (const g of days.values()) {
    g.first.grade = cardDayGrade(g.grades);
    g.first.w = g.grades.length > 1 ? Math.min(CARD_DAY_W.max, g.w + CARD_DAY_W.step * (g.grades.length - 1)) : g.w;
  }
  for (let i = revs.length - 1; i >= 0; i--) if (revs[i] === null) revs.splice(i, 1);
}

// ------------------------------------------------------------------ the model

const algos = new Map();
function algoFor(w) {
  const key = w.join(',');
  let a = algos.get(key);
  if (!a) {
    a = new FSRSAlgorithm(generatorParameters({ w: [...w], enable_short_term: true, enable_fuzz: false }));
    algos.set(key, a);
  }
  return a;
}

/**
 * A model for one set of settings (the stored model uses FIT; the calibration tries others).
 * cfg: {decay, lookahead_days, k0, fade_days, w?}. Everything it returns is pure.
 */
export function makeModel(cfg = {}) {
  const c = { ...FIT, ...cfg };
  const w = fitW(c.decay, c.w || W_DEFAULT, c.s0_pass ?? 1);
  const A = algoFor(w);
  const S0 = g => clamp(A.init_stability(g), ...S_RANGE);
  const D0 = g => clamp(A.init_difficulty(g), 1, 10);
  const curve = (days, s) => A.forgetting_curve(Math.max(0, days), Math.max(S_RANGE[0], s));
  const neutralS = (() => { let lo = 0.01, hi = 3650; for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (curve(c.lookahead_days, m) < 0.6) lo = m; else hi = m; } return Math.sqrt(lo * hi); })();
  const neutral = { s: neutralS, d: D0(3) };

  // One weighted review on a state (or the first, from nothing).
  function step(st, rv, at) {
    const g = rv.grade, wt = clamp(rv.w, 0, 2);
    if (!st) {
      const full = { s: S0(g), d: D0(g) };
      const s = wt >= 1 ? full.s : Math.exp(Math.log(neutral.s) + wt * (Math.log(full.s) - Math.log(neutral.s)));
      const d = wt >= 1 ? full.d : neutral.d + wt * (full.d - neutral.d);
      return { s: clamp(s, ...S_RANGE), d: clamp(d, 1, 10), at, n: wt, reviews: 1 };
    }
    const elapsed = Math.max(0, (at - st.at) / DAY_MS);
    const r = curve(c.same_day === 'spread' ? Math.max(1, elapsed) : elapsed, st.s);
    let s1;
    // Same-day reviews: FSRS's short-term rule, or (same_day 'spread') as if a day apart, since two questions on a
    // topic in one block are two different questions, not one card seen twice.
    if (elapsed < 1 && c.same_day !== 'spread') s1 = A.next_short_term_stability(st.s, g);
    else if (g === 1) s1 = Math.min(A.next_forget_stability(st.d, st.s, r), st.s);
    else s1 = A.next_recall_stability(st.d, st.s, r, g);
    const d1 = clamp(A.next_difficulty(st.d, g), 1, 10);
    const s = Math.exp(Math.log(st.s) + wt * (Math.log(clamp(s1, ...S_RANGE)) - Math.log(st.s)));
    return { s: clamp(s, ...S_RANGE), d: clamp(st.d + wt * (d1 - st.d), 1, 10), at: st.at + Math.min(1, wt) * (at - st.at), n: st.n + wt, reviews: st.reviews + 1 };
  }

  // R at the next likely question, `now` given.
  const recall = (st, now) => (st ? curve((now - st.at) / DAY_MS + c.lookahead_days, st.s) : null);

  // p and its certainty from a state, the prior m0 and now.
  function blend(st, now, m0) {
    if (!st) return { p: m0, c: 0, R: null };
    const age = Math.max(0, (now - st.at) / DAY_MS);
    const fade = c.fade_days ? Math.pow(2, -age / c.fade_days) : 1;
    const ne = st.n * fade;
    const cert = ne / (ne + c.k0);
    const R = recall(st, now);
    return { p: (1 - cert) * m0 + cert * R, c: cert, R };
  }

  /**
   * The reviews of some evidence rows in time order, run through FSRS. Returns {state, points} where state is
   * {s, d, at, n, reviews, real_n} (null when no row is a review) and points is [{at, R, grade, w}] (R read at
   * the lookahead right after each review, for the trend).
   */
  function run(rows) {
    const revs = [];
    const cardDays = new Map();
    for (const row of rows || []) {
      const at = Number(row && row.at);
      if (!Number.isFinite(at)) continue;
      const rv = reviewOf(row);
      if (!rv) continue;
      const k = cardDayKey(row, at);
      const prev = k ? cardDays.get(k) : null;
      if (prev) {   // the same review of the same card that day, from another source: heard once, at its worst
        prev.grade = Math.min(prev.grade, rv.grade);
        prev.w = Math.max(prev.w, rv.w);
        if (at < prev.at) prev.at = at;
        continue;
      }
      const r = { ...rv, at, key: `${row.obs_key || ''}#${Number(row.slot) || 0}` };
      if (k) { r.cardDay = k.slice(k.indexOf('|') + 1); cardDays.set(k, r); }
      revs.push(r);
    }
    topicCardDays(revs);
    revs.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let st = null, real = 0;
    const points = [];
    for (const rv of revs) {
      st = step(st, rv, rv.at);
      if (rv.real) real += rv.w;
      points.push({ at: rv.at, R: curve(c.lookahead_days, st.s), grade: rv.grade, w: rv.w });
    }
    return { state: st ? { ...st, real_n: real } : null, points };
  }

  return { cfg: c, w, step, run, recall, blend, curve, neutral };
}

export const MODEL = makeModel();


/** Anki FSRS parameters as model weights: 21 (FSRS-6) or 19 (FSRS-5, given FSRS-6's two more) sane numbers, else null. */
export function ankiWeights(params) {
  const p = Array.isArray(params) ? params.map(Number) : [];
  if (!(p.length === 21 || p.length === 19) || !p.every(Number.isFinite)) return null;
  if (!p.slice(0, 4).every(x => x > 0 && x <= 365) || p[4] <= 0 || p[4] > 10) return null;   // initial stabilities, D0
  return Object.freeze(p.length === 21 ? p : [...p, 0, 0.5]);
}

const MODELS = new Map();
/** The model for these weights (null or none: the shipped MODEL), made once per set. */
export function modelFor(w) {
  if (!Array.isArray(w) || !w.length) return MODEL;
  const k = w.join(',');
  if (!MODELS.has(k)) MODELS.set(k, makeModel({ w }));
  return MODELS.get(k);
}

/**
 * The model for the topic scores from the stored fsrs_params reading (sync_state 'anki.fsrs' cursor: {w, ...}), or
 * MODEL when there is none, it is unusable, or env.FSRS_ANKI_PARAMS is 'off'.
 */
export function modelFromStored(cursor, env = null) {
  if (env && String(env.FSRS_ANKI_PARAMS || '').toLowerCase() === 'off') return MODEL;
  let st = null;
  try { st = typeof cursor === 'string' ? JSON.parse(cursor) : cursor; } catch { st = null; }
  const w = st && ankiWeights(st.w);
  return w ? modelFor(w) : MODEL;
}

/**
 * The trend from the R after each recent review (weight 0.5 or more): the least-squares slope per review over
 * the last TREND.n. 1 improving, 0 steady, -1 slipping; null with fewer than two such reviews.
 */
export function trendOf(points, { n = TREND.n, eps = TREND.eps } = {}) {
  const pts = (points || []).filter(p => p && p.w >= 0.5 && Number.isFinite(p.R)).slice(-n);
  if (pts.length < 2) return { trend: null, slope: null };
  const k = pts.length, mx = (k - 1) / 2;
  const my = pts.reduce((s, p) => s + p.R, 0) / k;
  let sxy = 0, sxx = 0;
  pts.forEach((p, i) => { sxy += (i - mx) * (p.R - my); sxx += (i - mx) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  return { trend: slope > eps ? 1 : slope < -eps ? -1 : 0, slope: Math.round(slope * 1e4) / 1e4 };
}

export const gradeName = g => GRADE_NAME[g] || null;
export const TREND_WORDS = { 1: 'improving', 0: 'steady', '-1': 'slipping' };

/** The colour model in words for map_rules (built from FIT and REVIEW_W, so it never drifts from the code). */
export function fsrsRulesLines() {
  return [
    'Each topic has an FSRS memory fitted on his answers: right is Good (quick and sure: Easy), wrong Again, guessed, flawed or over 2 min Hard; a hard question\'s miss counts less.',
    `Re-tests count as answers; a lesson's final ${REVIEW_W.lesson_final}, card review ${REVIEW_W.card_review}, gap ${REVIEW_W.gap_stated} of one.`,
    `Colour: R at his next question (${FIT.lookahead_days} days on) blended with the system prior (${FIT.k0} answers), drifting back when left (halving in ${FIT.fade_days} days). Trend: R's slope over 5 reviews.`,
  ];
}
