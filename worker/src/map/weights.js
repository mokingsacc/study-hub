// The weakness score's weights (plan §7.1 and §7.2, WEIGHTS v1). Pure: no D1, no clock.
//
// Every evidence row is a raw observation (realtime and teach write the facts; nothing precomputed). At score
// time evidenceMass(row) turns one row into a fail mass f and a pass mass p, in answers' worth of evidence, and
// names the group whose half-life and caps apply. It reads only `kind` and the fact columns (result, outcome,
// verdict, confidence, error_type, flaw_kind, time_s, others_pct, amount, rating, detail_json), never `source`,
// so a new source (AnkiMobile, a new spoken cue) needs no change here. Unknown kinds have no mass but still
// mark the topic seen.
//
// A weight change bumps WEIGHTS_VERSION; repairScores then sends every row whose formula_version is older to be
// recomputed, 30 a run, once each (a Recent activity line counts them).

import { causeMult, CAUSE_MULT } from '../../../public/js/shared/cause.js';

export let WEIGHTS_VERSION = 10;
export const DAY_MS = 86400000;

// Half-lives in days, by group (plan §7.1). Card state never decays while it holds.
export const HALF_LIFE = { q: 21, card: 14, card_state: null, lesson_pass: 7, lesson_fail: 14, self: 14, gap: 14, gate: null };

// The stored buckets (topic_scores columns), each with its half-life.
export const BUCKETS = {
  q_pass: HALF_LIFE.q, q_fail: HALF_LIFE.q,
  card_pass: HALF_LIFE.card, card_fail: HALF_LIFE.card, card_state: HALF_LIFE.card_state,
  lesson_pass: HALF_LIFE.lesson_pass, lesson_fail: HALF_LIFE.lesson_fail,
  self_pass: HALF_LIFE.self, self_fail: HALF_LIFE.self, gap_fail: HALF_LIFE.gap,
  gate_nq: HALF_LIFE.gate,
};
export const BUCKET_NAMES = Object.keys(BUCKETS);

// Topic-level caps on the decayed buckets (plan §7.1) and per-lesson caps on the raw rows (plan §7.2).
export const CAPS = {
  card_p: 0.5, card_f: 0.9, lesson_p: 0.8, self_p: 0.4, rating_f: 0.4, gap_f: 1.0, self_f: 1.0,
  row_f: 1.6, row_p: 1.2,
  per_lesson: { lesson_probe: { p: 0.4, f: 0.5 }, pair_item: { p: 0.8, f: 1.2 } },
};

// The three gates, in mastery space (plan §7.1).
export const GATES = {
  blue: { q_pass: 1.0, max: 0.63 },        // no blue from hope: t1000 >= 400
  deep: { q_pass: 2.5, max: 0.795 },       // deep blue is earned: t1000 >= 100
  floor: { strong: 2, min: 0.421, days: 60 },   // one miss is not Very weak: t1000 <= 780
  strong_f: 0.5,                            // a strong fail's decayed f
};

export const GATE_CREDIT = { viva: 0.5, card: 0.25, card_max: 0.5, blue_max: 1.0, deep_max: 1.5, window_days: 60, concept: 0 };

export const CLOSING_VIVA = 0.5;
/** A viva row's weight factor (pure): CLOSING_VIVA for a lesson's closing viva, else 1. */
export const vivaPhaseWeight = row => (detailOf(row).phase === 'after' ? CLOSING_VIVA : 1);

/**
 * The non-question credit toward the gates from a topic's rows (pure; held rows skipped): strong-viva days times 0.5
 * plus right-card days times 0.25 (capped), from the last window_days before now. dayOf(row): its London day (row.day
 * by default).
 */
export function gateCredit(rows, dayOf = row => row.day, now = Date.now()) {
  const viva = new Map(), card = new Set();   // viva: day -> its best phase weight (a closing viva half)
  let concept = 0;   // topics the concept underlies, held, summed over days (concept-held.js)
  const since = now - GATE_CREDIT.window_days * DAY_MS;
  for (const row of rows || []) {
    if (!row || Number(row.held) === 1) continue;
    if (Number.isFinite(Number(row.at)) && Number(row.at) < since) continue;
    if (row.kind === 'recall_audit' && detailOf(row).part !== 'belief' && lessonResult(row) === 'right') viva.set(dayOf(row), Math.max(viva.get(dayOf(row)) || 0, vivaPhaseWeight(row)));
    else if (row.kind === 'card_review') {
      const r = REVIEW_RATING[lower(row.rating)] || REVIEW_RATING[String(row.amount)];
      if (r === 'good' || r === 'easy') card.add(dayOf(row));
    } else if (row.kind === 'concept_held') concept += Math.max(0, Number(row.amount) || 0);
  }
  let vivaW = 0;
  for (const w of viva.values()) vivaW += w;
  return vivaW * GATE_CREDIT.viva + Math.min(card.size * GATE_CREDIT.card, GATE_CREDIT.card_max) + concept * (Number(GATE_CREDIT.concept) || 0);
}

/**
 * The gate a topic's non-question credit lifted (pure): 'blue' when the blue cap would have held a topic above it
 * without that credit, 'deep' the same for deep blue, else null. The two never both hold (deep needs q_pass >= 1.0).
 */
export function gateLiftOf(pHat, b) {
  const q = Number(b && b.q_pass) || 0, nq = Number(b && b.gate_nq) || 0;
  const opens = (gate, max) => nq > 0 && q < gate.q_pass && q + Math.min(nq, max) >= gate.q_pass && pHat > gate.max;
  return opens(GATES.blue, GATE_CREDIT.blue_max) ? 'blue' : opens(GATES.deep, GATE_CREDIT.deep_max) ? 'deep' : null;
}

export const PRIOR = { k0: 3, weight: 10, min: 0.5, max: 0.72, g_min: 0.55, g_max: 0.72, g_default: 0.62, days: 60, learned_min: 0.35, learned_max: 0.85 };

// A stored m0 is the old rule's (0.50-0.72) or a learned starting guess (0.35-0.85): read within the wider range.
export const clampM0 = m0 => Math.min(PRIOR.learned_max, Math.max(PRIOR.learned_min, Number(m0)));

export const GUESS_KIND = 'starting_guess';
export function guessM0(version, categoryId) {
  const v = version && typeof version === 'object' ? version : null;
  if (!v) return null;
  const c = categoryId != null && v.by_category ? v.by_category[categoryId] : null;
  const m = c && Number.isFinite(Number(c.m0)) ? Number(c.m0) : Number(v.global);
  return Number.isFinite(m) ? clampM0(m) : null;
}

export const PACE = { pace_s: 90, slow_s: 120, steps: [[90, 0], [120, 0.15], [180, 0.4], [Infinity, 0.55]] };
/** 'slow' over 120 s, 'over pace' over 90 s, 'on pace', or null with no time. */
export const paceWord = s => { const t = num(s); return t == null ? null : t > PACE.slow_s ? 'slow' : t > PACE.pace_s ? 'over pace' : 'on pace'; };

export const HEARD_MULT = { clear: 1, partial: 0.85, unclear: 0.6, not_said: 1 };
/** A row's heard multiplier (pure): HEARD_MULT of detail_json.heard, 1 when none was recorded. */
export const heardMult = row => HEARD_MULT[detailOf(row).heard] ?? 1;
export const WORD_RULES = ['right_guess', 'right_flawed', 'shaky_elimination', 'misread_detail'];

// A right answer whose words showed a foundation concept understood (concepts.js, polarity right): a light Good on the
// concept topic (fsrs.js REVIEW_W.concept_right reads this), never a mass and never toward the gates, so concept orbs
// can improve as well as worsen without a passing remark outweighing a question.
export const CONCEPT_RIGHT_WEIGHT = 0.2;

// Error type multipliers on f only (Anki keys; anything else counts in full). faulty synthesis is a reasoning slip
// like premature closure (wave 2: reasoning 0.8), so the two weigh the same.
export const ERROR_MULT = { premature_closure: 0.8, faulty_synthesis: 0.8, calculation: 0.5, misread: 0.3, test_taking: 0.3 };
export const ERROR_KEYS = ['knowledge_gap', 'misread', 'premature_closure', 'faulty_synthesis', 'test_taking', 'threshold', 'calculation'];

// Every mass in one place (map_rules and the tests read this).
export const WEIGHTS = {
  question: {
    wrong_sure: [1.5, 0], wrong_lean: [1.1, 0], wrong_guess: [0.8, 0], wrong: [1.0, 0], omitted: [0.8, 0],
    wrong_changed_from_right: [0.8, 0.2], right_guess: [0.7, 0.3], right_flawed: [0.6, 0.4], right_changed_from_wrong: [0.5, 0.5],
    shaky_elimination: [0.4, 0.6], misread_detail: [0.3, 0.7], right_sure: [0, 1.0], right_lean: [0.2, 0.8], right: [0.15, 0.85],
  },
  confused_with: 0.3,
  retest: { got_it: [0, 1.2], missed_again: [1.2, 0] },
  card: { lapse: [0.3, 0], check_gap: [0.3, 0], weak_part: 0.15, weak_parts_max: 3, check_shaky: [0.15, 0.1], check_sound: [0, 0.1],
    first_sight_lapse: 0.15, first_sight_max: 4, mature: [0, 0.25] },
  // An Anki review of a card on the topic (anki_cards' ease): Again is a lapse, Good and Easy are passes.
  card_review: { again: [0.3, 0], hard: [0.15, 0.05], good: [0, 0.1], easy: [0, 0.15] },
  lesson_probe: { right: [0, 0.2], partial: [0, 0.1], wrong: [0, 0], unsure: [0, 0], new_strand_wrong: [0.3, 0] },
  // Lessons as evidence (wave 3): failures after the teaching count, rights there earn nothing (short-term performance).
  lesson_check: { wrong: [0.3, 0] },
  lesson_teachback: { wrong: [0.3, 0], partial: [0.15, 0] },
  lesson_misconception: [0.3, 0],
  lesson_final: { right: [0, 0.4], right_guess: [0.1, 0.2], partial: [0.2, 0.2], wrong: [0.6, 0], wrong_sure: [0.7, 0], unsure: [0.6, 0] },
  pair_item: { right: [0, 0.2], wrong: [0.3, 0], unsure: [0.3, 0] },
  gap_stated: { gap: [0.5, 0], shaky: [0.3, 0] },
  self_mastered: [0, 0.06],
  self_rating: { again: [0.3, 0], hard: [0.15, 0], good: [0, 0.1], easy: [0, 0.2] },
};

export const KINDS = {
  q: ['question', 'confused_with', 'retest'],
  card: ['card_lapse', 'card_check', 'card_weak_part', 'card_review'],
  card_state: ['card_new', 'card_young', 'card_mature', 'card_suspended'],
  lesson: ['lesson_probe', 'lesson_final', 'lesson_check', 'pair_item', 'lesson_teachback', 'lesson_misconception'],
  self: ['gap_stated', 'self_mastered', 'self_rating'],
};
const GROUP_OF = Object.fromEntries(Object.entries(KINDS).flatMap(([g, ks]) => ks.map(k => [k, g])));
export const kindGroup = kind => GROUP_OF[kind] || null;

// ------------------------------------------------------------------ fact normalising

const lower = v => (v == null ? null : String(v).trim().toLowerCase() || null);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// sure | lean | guess | null. Realtime maps the Anki 3/2/1 and hub '1'/'2'/'3' scales at ingestion; the words
// are accepted here too, never the bare numbers (the two scales run opposite ways).
export function confidenceOf(v) {
  const s = lower(v);
  if (!s) return null;
  if (s === 'sure' || s === 'certain') return 'sure';
  if (s === 'lean' || s === 'leaning' || s === 'think so' || s === 'likely') return 'lean';
  if (s === 'guess' || s === 'guessed' || s === 'guessing') return 'guess';
  return null;
}

// The Anki error key, accepting the hub's words as well ('test-taking', 'threshold or number').
export function errorKeyOf(v) {
  const s = lower(v);
  if (!s) return null;
  const k = s.replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (ERROR_KEYS.includes(k)) return k;
  if (k.startsWith('threshold')) return 'threshold';
  if (k.startsWith('test_taking') || k === 'testtaking') return 'test_taking';
  if (k.startsWith('misread')) return 'misread';
  if (k.startsWith('premature')) return 'premature_closure';
  if (k.startsWith('faulty')) return 'faulty_synthesis';
  if (k.startsWith('calc')) return 'calculation';
  if (k.startsWith('knowledge')) return 'knowledge_gap';
  return null;
}

/**
 * A miss's multiplier on its own topic (wave 2): its judged cause (detail_json.cause, shared/cause.js CAUSE_MULT:
 * missing fact or confusion 1, reasoning or ignored clue 0.8, guess 0.8, misread 0.3) when one was judged, else its
 * error type's (ERROR_MULT), which reads the same causes from the error type.
 */
export function causeMultOf(row) {
  const m = causeMult(detailOf(row).cause, confidenceOf(row && row.confidence));
  return m ?? (ERROR_MULT[errorKeyOf(row && row.error_type)] ?? 1);
}

export function detailOf(row) {
  const d = row && row.detail_json;
  if (d && typeof d === 'object') return d;
  if (typeof d !== 'string' || !d) return {};
  try { const o = JSON.parse(d); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

const flawOf = row => { const f = lower(row.flaw_kind); return f === 'none' ? null : f; };

// ------------------------------------------------------------------ questions

// The base (f, p) of a question row, first matching rule in the plan's order, with its rule name. The outcome
// rules (changed answers, right_guess) come first so a 'wrong' result from wrong_changed_from_right is read as
// the change it was.
export function questionBase(row) {
  const W = WEIGHTS.question;
  const result = lower(row.result), outcome = lower(row.outcome), verdict = lower(row.verdict), flaw = flawOf(row);
  const conf = confidenceOf(row.confidence);
  const pick = name => ({ rule: name, f: W[name][0], p: W[name][1] });
  if (outcome === 'wrong_changed_from_right') return pick('wrong_changed_from_right');
  if (result === 'wrong' || outcome === 'wrong' || (verdict === 'wrong' && !['right', 'flawed', 'omitted'].includes(result))) {
    if (conf === 'sure') return pick('wrong_sure');
    if (conf === 'lean') return pick('wrong_lean');
    if (conf === 'guess') return pick('wrong_guess');
    return pick('wrong');
  }
  if (result === 'omitted') return pick('omitted');
  const right = result === 'right' || result === 'flawed' || (!result && /^right/.test(outcome || ''));
  if (!right) return null;
  if (outcome === 'right_guess' || flaw === 'lucky_guess' || conf === 'guess') return pick('right_guess');
  if (flaw === 'right_wrong_reason' || (verdict === 'right_flawed' && !flaw)) return pick('right_flawed');
  if (outcome === 'right_changed_from_wrong') return pick('right_changed_from_wrong');
  if (flaw === 'shaky_elimination') return pick('shaky_elimination');
  if (flaw === 'misread_detail') return pick('misread_detail');
  if (result === 'flawed') return pick('right_flawed');   // flawed with nothing more to say how
  if (conf === 'sure' || verdict === 'sound') return pick('right_sure');
  if (conf === 'lean') return pick('right_lean');
  return pick('right');
}

// The slowness share s for a right or flawed answer (plan §7.2 modifier 2).
export function slowShare(time_s) {
  const t = num(time_s);
  if (t == null || t <= PACE.pace_s) return 0;
  for (const [upTo, s] of PACE.steps) if (t <= upTo) return s;
  return PACE.steps[PACE.steps.length - 1][1];
}

// Wrong and omitted answers already count in full, so slowness never adds to them.
const NOT_SLOWED = new Set(['wrong_sure', 'wrong_lean', 'wrong_guess', 'wrong', 'omitted']);

// A question row's (f, p) after the four modifiers: error type, slowness, difficulty, caps.
export function questionMass(row) {
  const base = questionBase(row);
  if (!base) return { f: 0, p: 0, rule: null };
  let { f, p } = base;
  f *= causeMultOf(row);
  if (WORD_RULES.includes(base.rule)) f *= heardMult(row);   // a flaw heard in garbled words counts less
  if (!NOT_SLOWED.has(base.rule)) {
    const s = slowShare(row.time_s);
    f += p * s;
    p *= 1 - s;
  }
  const pct = num(row.others_pct);
  if (pct != null && pct >= 0 && pct <= 100) {
    const d = pct / 100;
    f *= 0.6 + 0.8 * d;
    p *= 0.6 + 0.8 * (1 - d);
  }
  return { f: Math.min(f, CAPS.row_f), p: Math.min(p, CAPS.row_p), rule: base.rule };
}

// ------------------------------------------------------------------ cards

const VERDICT_RANK = { gap: 3, shaky: 2, sound: 1 };
const REVIEW_RATING = { again: 'again', hard: 'hard', good: 'good', easy: 'easy', 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

// One card on one day: the worst fact wins, never a sum (plan §7.2). Facts on the merged row: a dated lapse
// (kind card_lapse or detail.lapsed), a check's verdict (gap | shaky | sound; a card_check with none is a gap),
// and missed parts (detail.missed_parts, or amount on a card_weak_part row).
export function cardDayMass(row) {
  const C = WEIGHTS.card;
  const d = detailOf(row);
  const facts = [];
  if (row.kind === 'card_lapse' || Number(d.lapsed) > 0) facts.push({ kind: 'card_lapse', f: C.lapse[0], p: C.lapse[1] });
  const verdict = lower(row.verdict) || (row.kind === 'card_check' ? 'gap' : null);
  const h = heardMult(row);
  if (verdict === 'gap') facts.push({ kind: 'card_check', f: C.check_gap[0] * h, p: C.check_gap[1] * h });
  else if (verdict === 'shaky') facts.push({ kind: 'card_check', f: C.check_shaky[0] * h, p: C.check_shaky[1] * h });
  else if (verdict === 'sound') facts.push({ kind: 'card_check', f: C.check_sound[0] * h, p: C.check_sound[1] * h });
  const parts = num(d.missed_parts) ?? (row.kind === 'card_weak_part' ? num(row.amount) : null);
  if (parts != null && parts > 0) facts.push({ kind: 'card_weak_part', f: C.weak_part * Math.min(parts, C.weak_parts_max), p: 0 });
  if (!facts.length) return { f: 0, p: 0, worst: null };
  facts.sort((a, b) => b.f - a.f || a.p - b.p);
  return { f: facts[0].f, p: facts[0].p, worst: facts[0].kind };
}

export const verdictRank = v => VERDICT_RANK[lower(v)] || 0;

// ------------------------------------------------------------------ lessons and self-reports

function lessonResult(row) {
  const r = lower(row.result) || lower(row.outcome);
  if (!r) return null;
  if (r === 'right' || r === 'got_it' || r === 'correct') return 'right';
  if (r === 'partial' || r === 'half') return 'partial';
  if (r === 'wrong' || r === 'missed' || r === 'missed_again' || r === 'incorrect') return 'wrong';
  if (r === 'unsure' || r === 'not_sure' || r === 'not sure' || r === "don't know" || r === 'dont_know') return 'unsure';
  return null;   // skipped and anything else: no mass
}

function lessonMass(row) {
  const res = lessonResult(row);
  if (!res) return [0, 0];
  const conf = confidenceOf(row.confidence);
  if (row.kind === 'lesson_probe') {
    if ((res === 'wrong' || res === 'unsure') && detailOf(row).from === 'new') return WEIGHTS.lesson_probe.new_strand_wrong;
    return WEIGHTS.lesson_probe[res];
  }
  // A step check wrong twice after the teaching (never a pair lesson's practice pair, which has a link_id: LRN4-5).
  if (row.kind === 'lesson_check') return res === 'wrong' && detailOf(row).link_id == null ? WEIGHTS.lesson_check.wrong : [0, 0];
  if (row.kind === 'lesson_teachback') return WEIGHTS.lesson_teachback[res] || [0, 0];
  if (row.kind === 'lesson_misconception') return WEIGHTS.lesson_misconception;
  if (row.kind === 'pair_item') return WEIGHTS.pair_item[res === 'partial' ? 'wrong' : res];
  if (row.kind === 'lesson_final') {
    if (res === 'right' && conf === 'guess') return WEIGHTS.lesson_final.right_guess;
    if (res === 'wrong' && conf === 'sure') return WEIGHTS.lesson_final.wrong_sure;
    return WEIGHTS.lesson_final[res];
  }
  return [0, 0];
}

// ------------------------------------------------------------------ evidenceMass

// One row's masses: {f, p, bucket_f, bucket_p, group, rule}. bucket_* name the topic_scores columns the masses
// add to; group is null for an unknown kind (zero mass, still seen).
export function evidenceMass(row) {
  const kind = row && row.kind;
  const group = kindGroup(kind);
  const out = (f, p, bucket_f, bucket_p, rule = null) => ({ f: f || 0, p: p || 0, bucket_f, bucket_p, group, rule });
  switch (group) {
    case 'q': {
      if (kind === 'question') {
        const m = questionMass(row);
        return out(m.f, m.p, 'q_fail', 'q_pass', m.rule);
      }
      if (kind === 'confused_with') {
        // 0.3 of the miss's base f, with its error-type multiplier (a misread is a habit, not a mix-up).
        const base = questionBase(row);
        const f = base ? WEIGHTS.confused_with * base.f * causeMultOf(row) * heardMult(row) : 0;
        return out(f, 0, 'q_fail', 'q_pass', base && base.rule);
      }
      const r = lower(row.outcome) || lower(row.result);
      if (r === 'got_it' || r === 'right') return out(...WEIGHTS.retest.got_it, 'q_fail', 'q_pass', 'got_it');
      if (r === 'missed_again' || r === 'missed' || r === 'wrong') return out(...WEIGHTS.retest.missed_again, 'q_fail', 'q_pass', 'missed_again');
      return out(0, 0, 'q_fail', 'q_pass');
    }
    case 'card': {
      const d = detailOf(row);
      if (kind === 'card_review') {
        const r = REVIEW_RATING[lower(row.rating)] || REVIEW_RATING[String(row.amount)];
        return r ? out(...WEIGHTS.card_review[r], 'card_fail', 'card_pass', r) : out(0, 0, 'card_fail', 'card_pass');
      }
      if (kind === 'card_lapse' && Number(d.first_sight) === 1) {
        const n = Math.max(0, num(row.amount) ?? num(d.lapses) ?? 0);
        return out(WEIGHTS.card.first_sight_lapse * Math.min(n, WEIGHTS.card.first_sight_max), 0, 'card_fail', 'card_pass', 'first_sight');
      }
      const m = cardDayMass(row);
      return out(m.f, m.p, 'card_fail', 'card_pass', m.worst);
    }
    case 'card_state':
      return kind === 'card_mature' ? out(...WEIGHTS.card.mature, 'card_fail', 'card_state', 'mature') : out(0, 0, 'card_fail', 'card_state');
    case 'lesson': {
      const [f, p] = lessonMass(row);
      return out(f, p, 'lesson_fail', 'lesson_pass', lessonResult(row));
    }
    case 'self': {
      if (kind === 'gap_stated') {
        const v = lower(row.verdict) === 'shaky' ? 'shaky' : 'gap';
        const h = heardMult(row);
        return out(WEIGHTS.gap_stated[v][0] * h, WEIGHTS.gap_stated[v][1] * h, 'gap_fail', 'self_pass', v);
      }
      if (kind === 'self_mastered') return out(...WEIGHTS.self_mastered, 'self_fail', 'self_pass', 'mastered');
      const r = WEIGHTS.self_rating[lower(row.rating)];
      const share = row.amount == null || !Number.isFinite(Number(row.amount)) ? 1 : Math.min(1, Math.max(0, Number(row.amount)));
      return r ? out(r[0] * share, r[1] * share, 'self_fail', 'self_pass', lower(row.rating)) : out(0, 0, 'self_fail', 'self_pass');
    }
    default:
      return out(0, 0, null, null);
  }
}

// The decay factor for a bucket over age days (half-life null: no decay).
export const decay = (ageDays, halfLife) => (halfLife == null ? 1 : Math.pow(2, -Math.max(0, ageDays) / halfLife));

// A question-group fail that can lift gate 3: a question or re-test fail (never a look-alike row, never a slow
// right, never a stated gap) whose decayed f is at least 0.5 and which is under 60 days old.
export function isStrongFail(row, mass, now) {
  if (!row || !mass || !(row.kind === 'question' || row.kind === 'retest')) return false;
  if (row.kind === 'question') {
    const r = lower(row.result);
    if (!(r === 'wrong' || r === 'flawed' || r === 'omitted' || lower(row.outcome) === 'wrong_changed_from_right')) return false;
  } else if (mass.rule !== 'missed_again') return false;
  return strongNow(row.at, mass.f, now);
}

// Whether a stored strong fail [at, f] still counts at now.
export function strongNow(at, f, now) {
  const age = (now - Number(at)) / DAY_MS;
  if (!(age <= GATES.floor.days)) return false;
  return f * decay(age, HALF_LIFE.q) >= GATES.strong_f - 1e-12;
}

// ------------------------------------------------------------------ gaps into evidence

export const CHECK_SOURCES = ['anki_mac', 'anki_hub', 'anki_phone', 'anki_voice_check'];

// Which kind of evidence a gaps row becomes (plan §6.4): an explicit origin wins; otherwise the Anki check is a
// review, anki_voice with a card or said words is a review, and everything else was stated. The one copy (the data
// audit found two drifting apart): map-fields.js re-exports it.
export function gapOrigin(gap) {
  const o = lower(gap && gap.origin);
  if (o === 'stated' || o === 'review') return o;
  const src = lower(gap && gap.source);
  if (CHECK_SOURCES.includes(src)) return 'review';
  if (src === 'anki_voice' && (gap.card_id != null || (gap.said != null && String(gap.said).trim()))) return 'review';
  return 'stated';
}

const cardCue = gap => lower(gap && gap.source) === 'spoken_cue' && gap.card_id != null && gap.card_id !== '' && /^anki:/.test(String(gap.ref || ''));

// {kind, obs_key, origin, verdict}: a stated gap is gap_stated on gap:<id>; a review gap with a card (or a cue said on
// a reviewed card) merges into that card's day row card:<card_id>:<day> as a card_check; a review gap with no card
// is a card_check on gap:<id>.
export function gapKind(gap) {
  const origin = gapOrigin(gap);
  const verdict = lower(gap && gap.verdict) === 'shaky' ? 'shaky' : 'gap';
  if (origin === 'review' || cardCue(gap)) {
    const card = gap.card_id != null && gap.card_id !== '' ? gap.card_id : null;
    return { kind: 'card_check', obs_key: card != null ? `card:${card}:${gap.day}` : `gap:${gap.id}`, origin, verdict };
  }
  return { kind: 'gap_stated', obs_key: `gap:${gap.id}`, origin, verdict };
}

// The raw evidence row for a gaps row, facts only: the gap's words never leave gaps (the why line names the
// gap by its id). ctx carries topic_id, category_id, label_norm, queue_id, held and sitting_id from ingestion.
export function gapEvidence(gap, ctx = {}) {
  const k = gapKind(gap);
  const heard = ['partial', 'unclear'].includes(lower(gap && gap.heard)) ? lower(gap.heard) : null;
  const at = Number(gap.at) || Number(ctx.at) || Date.now();
  return {
    obs_key: k.obs_key, slot: 0, kind: k.kind, at, day: gap.day,
    topic_id: ctx.topic_id ?? gap.topic_id ?? null, category_id: ctx.category_id ?? null, label_norm: ctx.label_norm ?? null,
    queue_id: ctx.queue_id ?? null, source: gap.source || 'chat', source_ref: `gap:${gap.id}`,
    card_id: gap.card_id ?? null, note_id: gap.note_id ?? null, gap_id: gap.id,
    held: ctx.held ? 1 : 0, sitting_id: ctx.sitting_id ?? null,
    verdict: k.verdict, error_type: errorKeyOf(gap.error_type),
    detail_json: JSON.stringify({ origin: k.origin, ...(heard ? { heard } : {}) }),
  };
}

// ------------------------------------------------------------------ the rules in words (for map_rules)

// Plain lines built from the constants above, so what Claude reads about the colours never drifts from the code.
export function rulesLines() {
  const Q = WEIGHTS.question;
  return [
    `Gates read masses with a half-life of ${HALF_LIFE.q} days (questions), ${HALF_LIFE.card} (cards, gaps), ${HALF_LIFE.lesson_pass} (lesson passes); a miss counts ${Q.wrong_sure[0]} sure, ${Q.wrong_guess[0]} guessed, times its cause (reasoning ${CAUSE_MULT.reasoning}, misread ${CAUSE_MULT.misread}).`,
    `A slow right answer counts partly as a miss: ${PACE.steps.slice(1).map((st, i) => `${Math.round(st[1] * 100)}% over ${PACE.steps[i][0]} s`).join(', ')}.`,
    `A stated gap counts ${WEIGHTS.gap_stated.gap[0]}, a card lapse ${WEIGHTS.card.lapse[0]}.`,
    `Blue needs ${GATES.blue.q_pass} tested: right Qs or cards from misses, strong viva ${GATE_CREDIT.viva}/day, right card ${GATE_CREDIT.card}/day (max ${GATE_CREDIT.card_max}); viva+card max ${GATE_CREDIT.blue_max} (${GATE_CREDIT.deep_max} of deep's ${GATES.deep.q_pass}). 1 miss never Very weak; ratings, lessons: 0.`,
  ];
}

export const WEIGHT_SETS = [
  { id: 'v8', version: 8, date: '2026-10-31', note: 'What tests him opens blue: strong vivas and right card days count toward the gates (GATE_CREDIT).', changes: {} },
  // Baked in by the 1 Nov builds that predate shadow mode (no shadow test ran for these two).
  { id: 'v9', version: 9, date: '2026-11-01', note: "A lesson's closing viva counts half a viva (CLOSING_VIVA).", changes: {} },
  { id: 'v10', version: 10, date: '2026-11-01', note: 'How clearly he was heard scales what the AI read from his words; a right answer showing a concept is a small Good on it (answer forms).', changes: {} },
  { id: 'v11', version: 11, date: '2026-11-01', scored_on: 'concepts',
    note: 'A foundation concept gets a small Good, and credit toward blue, on days he holds the topics it underlies.',
    changes: { REVIEW_W: { concept_held: 0.2 }, GATE_CREDIT: { concept: 0.34 } } },
];
export const SHIPPED_WEIGHTS_VERSION = WEIGHTS_VERSION;
/** Sets the live version (weight-sets.js only: the live set, or a set evaluated for a moment in shadow). */
export function _setWeightsVersion(v) { WEIGHTS_VERSION = Number(v); }
