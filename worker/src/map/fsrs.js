import { FSRSAlgorithm, generatorParameters, default_w } from 'ts-fsrs';
import { questionBase, errorKeyOf, ERROR_MULT, PACE, detailOf, confidenceOf, causeMultOf, vivaPhaseWeight, heardMult, WORD_RULES, CONCEPT_RIGHT_WEIGHT } from './weights.js';
import { reviewList } from './cards.js';
import { londonDay } from '../util.js';

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
// The trend (statistics review, 31 Oct 2026): over the last 21 days, from reviews of weight 0.5 or more that are not
// re-exposures, on at least 2 London days with at least one real question; a move of 0.08 in p is a change.
export const TREND = { window_days: 21, min_w: 0.5, min_days: 2, delta: 0.08, answers: 5 };

// How much each kind of review moves a topic (1 is a normal question). A lesson's final case right comes minutes after
// the teaching, so it says little about memory: 0.3; a miss there still counts 0.8 (statistics review, 31 Oct 2026).
// lesson_fail (wave 3, lessons as evidence): a failure inside a lesson after the teaching is a strong signal, a right
// there is not, so a step check wrong twice, a probe wrong on a strand the lesson's trigger did not cover, a teach-back
// judged wrong (partial: half) and a misconception newly found in the lesson are each an Again at 0.3.
export const REVIEW_W = {
  question: 1, retest: 1, confused_with: 0.3,
  lesson_final: 0.8, lesson_final_right: 0.3, lesson_probe_right: 0.3, pair_item: 0.3, lesson_fail: 0.3,
  card_review: 0.5, card_lapse: 0.6, card_first_sight: 0.3, card_check: 0.4, card_mature: 0.5,
  gap_stated: 0.3, gap_shaky: 0.2, self_rating: 0.2, self_mastered: 0.1,
  recall_audit: 0.5, recall_audit_belief: 0.3,
  review_option: 0.3,
  // A foundation concept (concepts.js, 0063): each clinical miss or wrong belief that rests on the concept is an Again on
  // the concept topic at the row's own weight (amount: half the miss's cause weight, shared/concept.js conceptWeight), at
  // most concept_miss. It never touches the clinical topic, whose miss already counts there.
  concept_miss: 0.5,
  // A right answer whose words showed the concept understood (answer forms, 1 Nov 2026): a light Good on the concept
  // topic, at most this (weights.js CONCEPT_RIGHT_WEIGHT), so a concept orb can improve as well as worsen.
  concept_right: CONCEPT_RIGHT_WEIGHT,
  concept_held: 0, concept_held_max: 0.6,
};
export const REEXPOSURE_W = 0.4;
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
      if (g === 'again') w *= causeMultOf(row);   // by the miss's cause (wave 2), else its error type
      else {
        if (WORD_RULES.includes(base.rule)) w *= heardMult(row);   // a flaw heard in garbled words counts less (0067)
        const t = num(row.time_s);
        if (t != null && t > PACE.slow_s) g = 'hard';
        else if (g === 'good' && t != null && t <= PACE.pace_s && (confidenceOf(row.confidence) === 'sure' || lower(row.verdict) === 'sound')) g = 'easy';
      }
      w *= difficultyWeight(GRADE[g], row.others_pct);
      const q = mk(g, w * W.question, true);
      const blk = Number(detailOf(row).tutor) === 1 && /^uworld:([^:]+):q\d+$/.exec(String(row.source_ref || ''));
      if (q && blk) q.tutor = blk[1];
      return q;
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
      return mk('again', W.confused_with * causeMultOf(row) * heardMult(row));
    }
    case 'lesson_final': {
      const r = lessonResult(row);
      if (!r) return null;
      if (r === 'right') return mk(confidenceOf(row.confidence) === 'guess' ? 'hard' : 'good', W.lesson_final_right);
      if (r === 'partial') return mk('hard', W.lesson_final_right);
      return mk('again', W.lesson_final);
    }
    case 'lesson_probe': {
      const r = lessonResult(row);
      if (r === 'right') return mk('good', W.lesson_probe_right);
      return (r === 'wrong' || r === 'unsure') && detailOf(row).from === 'new' ? mk('again', W.lesson_fail) : null;
    }
    // A step check (wave 3): wrong twice after the teaching is an Again; wrong then right, or right, is no credit. A pair
    // lesson's practice pairs are lesson_check rows with a link_id and stay without weight (LRN4-5).
    case 'lesson_check': return lessonResult(row) === 'wrong' && detailOf(row).link_id == null ? mk('again', W.lesson_fail) : null;
    case 'lesson_teachback': {
      const r = lessonResult(row);
      return r === 'wrong' ? mk('again', W.lesson_fail) : r === 'partial' ? mk('again', W.lesson_fail / 2) : null;
    }
    case 'lesson_misconception': return mk('again', W.lesson_fail);
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
      const h = kind === 'card_check' ? heardMult(row) : 1;
      if (v === 'gap' || (kind === 'card_weak_part' && !v)) return mk('again', W.card_check * h);
      if (v === 'shaky') return mk('hard', W.card_check * h);
      if (v === 'sound') return mk('good', W.card_check * h);
      return null;
    }
    case 'card_mature': return mk('good', W.card_mature);
    case 'gap_stated': return lower(row.verdict) === 'shaky' ? mk('hard', W.gap_shaky * heardMult(row)) : mk('again', W.gap_stated * heardMult(row));
    case 'self_rating': { const g = gradeOf(row.rating); return g ? mk(g, W.self_rating * clamp(num(row.amount) ?? 1, 0, 1)) : null; }
    case 'self_mastered': return mk('good', W.self_mastered);
    // Only a right statement is a review: a wrong one is a misconception, and talking about a choice is never a miss.
    case 'review_option': return lessonResult(row) === 'right' ? mk('good', W.review_option) : null;
    case 'recall_audit': {
      // A lesson's closing viva counts half (weights.js CLOSING_VIVA).
      const ph = vivaPhaseWeight(row);
      if (detailOf(row).part === 'belief') return mk('again', W.recall_audit_belief * ph);
      const r = lessonResult(row);
      if (!r || r === 'unsure') return null;
      const share = clamp(num(row.amount) ?? 1, 0, 1);
      return mk(r === 'right' ? 'good' : r === 'partial' ? 'hard' : 'again', W.recall_audit * share * ph * heardMult(row));
    }
    case 'concept_miss': {
      const w = clamp(num(row.amount) ?? W.concept_miss, 0, W.concept_miss);
      return mk('again', w);
    }
    case 'concept_right': return mk('good', clamp(num(row.amount) ?? W.concept_right, 0, W.concept_right));
    case 'concept_held': return mk('good', clamp((num(row.amount) || 0) * (Number(W.concept_held) || 0), 0, Number(W.concept_held_max) || 0));
    default: return null;
  }
}

const CARD_DAY_KINDS = new Set(['card_review', 'card_check', 'card_lapse', 'card_weak_part', 'gap_stated']);
export function cardDayKey(row, at = Number(row && row.at)) {
  if (!CARD_DAY_KINDS.has(row.kind) || row.card_id == null) return null;
  if (row.kind === 'card_lapse' && Number(detailOf(row).first_sight) === 1) return null;
  return `${row.card_id}|${row.day || new Date(at).toISOString().slice(0, 10)}`;
}

// A topic's cards on one day (ANKI-S4). Anki's review log brings every review, about a hundred a day, and a topic
// can have a dozen cards, so flashcard recall must never swamp the questions. Each card review is heard in its place,
// but together a topic's card reviews of one day weigh what one review of CARD_DAY_W did before (the heaviest one's
// weight plus a step for each more, at most CARD_DAY_W.max, under one question's 1), shared out in proportion.
export const CARD_DAY_W = { step: 0.15, max: 0.8 };
function capCardDays(revs) {
  const days = new Map();
  for (const r of revs) if (r.cardDay) { if (!days.has(r.cardDay)) days.set(r.cardDay, []); days.get(r.cardDay).push(r); }
  for (const g of days.values()) {
    if (g.length < 2) continue;
    const sum = g.reduce((t, r) => t + r.w, 0);
    const total = Math.min(CARD_DAY_W.max, Math.max(...g.map(r => r.w)) + CARD_DAY_W.step * (g.length - 1));
    if (sum > 0) for (const r of g) r.w *= total / sum;
  }
}

const TEACHES = new Set(['lesson_final', 'pair_item', 'lesson_check', 'lesson_teachback', 'lesson_misconception']);
const TIE = { lesson_probe: 0, lesson_final: 2, lesson_teachback: 3 };
function reexposed(rv, prev, cardLast) {
  if (rv.grade < GRADE.hard) return false;
  if (rv.kind === 'lesson_final') return true;
  if (rv.kind === 'review_option') return true;
  if (!prev || rv.at - prev.at >= DAY_MS) return false;
  if (rv.kind === 'card_review' && cardLast.has(rv.card) && rv.at - cardLast.get(rv.card) < DAY_MS) return true;
  const shown = TEACHES.has(prev.kind) || prev.tutor != null;
  if (!shown) return false;
  if (rv.kind === 'question' || rv.kind === 'retest') return rv.tutor != null && rv.tutor === prev.tutor;
  return true;
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
    // topic in one block are two different questions, not one card seen twice. A re-exposure always takes the
    // short-term rule: a right minutes after seeing the answer is not a one-day recall.
    if (rv.reexposure || (elapsed < 1 && c.same_day !== 'spread')) s1 = A.next_short_term_stability(st.s, g);
    else if (g === 1) s1 = Math.min(A.next_forget_stability(st.d, st.s, r), st.s);
    else s1 = A.next_recall_stability(st.d, st.s, r, g);
    const d1 = clamp(A.next_difficulty(st.d, g), 1, 10);
    const s = Math.exp(Math.log(st.s) + wt * (Math.log(clamp(s1, ...S_RANGE)) - Math.log(st.s)));
    return { s: clamp(s, ...S_RANGE), d: clamp(st.d + wt * (d1 - st.d), 1, 10), at: st.at + Math.min(1, wt) * (at - st.at),
      n: st.n + (rv.reexposure ? 0 : wt), reviews: st.reviews + 1 };
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
    const revs = [], facts = [];
    const ratings = new Map();   // card|day -> that card's ratings that day
    for (const row of rows || []) {
      const at = Number(row && row.at);
      if (!Number.isFinite(at)) continue;
      const rv = reviewOf(row);
      if (!rv) continue;
      const key = `${row.obs_key || ''}#${Number(row.slot) || 0}`;
      const k = cardDayKey(row, at);
      if (!k) { revs.push({ ...rv, at, key, kind: row.kind }); continue; }
      const base = { ...rv, at, key, kind: row.kind, card: k, cardDay: k.slice(k.indexOf('|') + 1) };
      if (row.kind !== 'card_review') { facts.push(base); continue; }
      if (!ratings.has(k)) ratings.set(k, []);
      for (const [t, ease] of reviewList(row)) {
        const r = { ...base, grade: ease, at: t };
        // The same press from a second row (an older row of the same card and day): heard once.
        if (ratings.get(k).some(x => x.grade === ease && Math.abs(x.at - t) <= 120_000)) continue;
        ratings.get(k).push(r);
        revs.push(r);
      }
    }
    // A check, lapse, weak part or gap on a card joins the card's nearest rating that day; with none, they are one review.
    facts.sort((a, b) => a.at - b.at);
    for (const f of facts) {
      const list = ratings.get(f.card);
      if (!list || !list.length) { ratings.set(f.card, [f]); revs.push(f); continue; }
      const near = list.reduce((m, x) => (Math.abs(x.at - f.at) < Math.abs(m.at - f.at) ? x : m));
      near.grade = Math.min(near.grade, f.grade);
      near.w = Math.max(near.w, f.w);
    }
    for (const r of revs) r.w0 = r.w;   // the kind's own weight, before a topic's card day shares it out
    capCardDays(revs);
    revs.sort((a, b) => a.at - b.at || (TIE[a.kind] ?? 1) - (TIE[b.kind] ?? 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let st = null, real = 0, prev = null;
    const points = [], cardLast = new Map();
    for (const rv of revs) {
      if (reexposed(rv, prev, cardLast)) {
        rv.reexposure = true;
        if (rv.kind !== 'lesson_final' && rv.kind !== 'review_option') rv.w *= REEXPOSURE_W;   // those two are already light (0.3)
      }
      const before = st;
      st = step(st, rv, rv.at);
      if (rv.real) real += rv.w;
      points.push({ at: rv.at, R: curve(c.lookahead_days, st.s), grade: rv.grade, w: rv.w, w0: rv.w0, real: !!rv.real, kind: rv.kind,
        reexposure: !!rv.reexposure, before });
      if (rv.kind === 'card_review') cardLast.set(rv.card, rv.at);
      prev = rv;
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
  // FIT in the key (shadow mode, 1 Nov 2026): a weight set may change FIT, so a model made under one set is never reused under another.
  const k = `${w.join(',')}|${JSON.stringify(FIT)}`;
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

export function trendOf(points, { state = null, m0 = 0.6, now = Date.now(), model = MODEL } = {}) {
  const all = (points || []).filter(p => p && Number.isFinite(p.at) && p.at <= now);
  const from = now - TREND.window_days * DAY_MS;
  const win = all.filter(p => p.at >= from && (p.w0 ?? p.w) >= TREND.min_w && !p.reexposure);
  const days = new Set(win.map(p => londonDay(p.at))).size;
  const realWin = win.filter(p => p.real);
  const word = p => (p.grade === GRADE.again ? 'wrong' : p.grade === GRADE.hard ? 'hard' : 'right');
  // answer_at: when each of those answers was (epoch ms), so the panel names its basis ("Slipping: right 22 Oct, wrong today").
  const basis = { days, reviews: win.length, answers: realWin.slice(-TREND.answers).map(word), answer_at: realWin.slice(-TREND.answers).map(p => Math.round(p.at)) };
  if (days < TREND.min_days || !realWin.length || !state) return { trend: null, slope: null, basis: { ...basis, reason: 'not enough yet' } };
  const k0 = model.cfg.k0;
  const pOf = (st, t) => (st ? (st.n / (st.n + k0)) * model.recall(st, t) + (k0 / (st.n + k0)) * m0 : m0);
  const first = win[0];
  const pBefore = pOf(first.before, first.at), pNow = pOf(state, now);
  const delta = pNow - pBefore;
  const real = all.filter(p => p.real);
  const last = real[real.length - 1], prev = real[real.length - 2];
  const missAfterPass = !!(last && prev && last.grade === GRADE.again && prev.grade >= GRADE.hard && last.at >= from);
  const trend = missAfterPass || delta <= -TREND.delta ? -1 : delta >= TREND.delta ? 1 : 0;
  const reason = missAfterPass ? 'last answer a miss after a pass' : trend === 1 ? 'memory up' : trend === -1 ? 'memory down' : 'little change';
  const r3 = x => Math.round(x * 1000) / 1000;
  return { trend, slope: Math.round(delta * 1e4) / 1e4, basis: { ...basis, delta: r3(delta), p_before: r3(pBefore), p_now: r3(pNow), reason } };
}

export const gradeName = g => GRADE_NAME[g] || null;
export const TREND_WORDS = { 1: 'improving', 0: 'steady', '-1': 'slipping' };
// A seen topic with no trend yet (under 2 days of answers in the window, or no real question): said, never left blank.
export const TREND_NONE_WORDS = 'too early to tell';

/** The colour model in words for map_rules (built from FIT and REVIEW_W, so it never drifts from the code). */
export function fsrsRulesLines() {
  return [
    'FSRS memory per topic: right Good (quick and sure: Easy), wrong Again; guessed, flawed or over 2 min Hard; a hard question\'s miss counts less.',
    `A card from a miss counts as an answer the first time; lesson final ${REVIEW_W.lesson_final_right} (miss ${REVIEW_W.lesson_final}, other lesson fails ${REVIEW_W.lesson_fail}), card ${REVIEW_W.card_review}, gap ${REVIEW_W.gap_stated}; a right just after seeing the answer x${REEXPOSURE_W}.`,
    `Colour: R ${FIT.lookahead_days} d on, blended with the prior (${FIT.k0} answers), fading when left (half-life ${FIT.fade_days} d). Trend: p's move in ${TREND.window_days} d (±${TREND.delta}); a miss after a pass slips.`,
  ];
}
