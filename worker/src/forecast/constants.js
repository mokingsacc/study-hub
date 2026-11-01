import { S } from '../map/systems.js';

export const MODEL_VERSION = 2;

export const BLUEPRINT_SOURCE = 'USMLE Step 2 CK score report content areas (PDF) and content outline (web page), read 1 Nov 2026';
export const USMLE_SYSTEMS = Object.freeze({
  renal_repro: { name: 'Renal/Urinary and Reproductive Systems', range: [7, 13] },
  cardio: { name: 'Cardiovascular System', range: [6, 12] },
  msk_skin: { name: 'Musculoskeletal System, Skin and Subcutaneous Tissue', range: [6, 12] },
  behavioural: { name: 'Behavioral Health', range: [5, 10] },
  gi: { name: 'Gastrointestinal System', range: [5, 10] },
  nervous: { name: 'Nervous System and Special Senses', range: [5, 10] },
  resp: { name: 'Respiratory System', range: [5, 10] },
  multisystem: { name: 'Multisystem Processes and Disorders', range: [4, 8] },
  endo: { name: 'Endocrine System', range: [3, 7] },
  pregnancy: { name: 'Pregnancy, Childbirth and the Puerperium', range: [3, 7] },
  blood: { name: 'Blood and Lymphoreticular System', range: [3, 6] },
  immune: { name: 'Immune System', range: [3, 5] },
  social: { name: 'Social Sciences: legal, ethical, professionalism, systems and patient safety', range: [10, 15] },
  biostat: { name: 'Biostatistics, Epidemiology, Population Health, Medical Literature', range: [3, 5] },
  development: { name: 'Human Development', range: [2, 4] },
});
export const BLUEPRINT_SPLIT = Object.freeze({
  renal_repro: { [S.renal]: 0.5, [S.gyn]: 0.3, [S.uro]: 0.2 },
  cardio: { [S.cardio]: 1 },
  msk_skin: { [S.rheum]: 0.5, [S.derm]: 1 / 3, [S.surg]: 1 / 6 },
  behavioural: { [S.psych]: 1 },
  gi: { [S.gi]: 1 },
  nervous: { [S.neuro]: 5.5 / 7.5, [S.eye]: 1 / 7.5, [S.ent]: 1 / 7.5 },
  resp: { [S.resp]: 1 },
  multisystem: { [S.id]: 2.5 / 6, [S.em]: 2 / 6, [S.surg]: 1.5 / 6 },
  endo: { [S.endo]: 1 },
  pregnancy: { [S.obs]: 1 },
  blood: { [S.haem]: 1 },
  immune: { [S.immuno]: 1 },
  social: { [S.ethics]: 0.8, [S.prev]: 0.2 },
  biostat: { [S.biostat]: 1 },
  development: { [S.child]: 1 },
});
export const BLUEPRINT = (() => {
  const raw = {};
  for (const [k, { range }] of Object.entries(USMLE_SYSTEMS)) {
    const mid = (range[0] + range[1]) / 2;
    for (const [sys, f] of Object.entries(BLUEPRINT_SPLIT[k])) raw[sys] = (raw[sys] || 0) + mid * f;
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  return Object.freeze(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total])));
})();
export const WEIGHT = Object.freeze({ nbme: 2, uworld: 1, alpha: 1 });

export const SCALE = Object.freeze({
  sem: 6, norm_mean: 251, norm_sd: 15, pass: 218,
  // ASSUMPTION (spec 2.2): day-of variance (fatigue and the day itself), added at the exam.
  day_sd: 3,
  // The 80% interval is never narrower than +-8 (spec 1.2).
  min_half80: 8, z80: 1.2816, z50: 0.6745,
});
export const KALMAN = Object.freeze({
  // Prior (spec 2.2): L0 ~ N(245, 15^2), the LCME mean shaded for an IMG, weak on purpose; g0 ~ N(+1.5, 1.5^2) points a week.
  level: 245, level_sd: 15, trend: 1.5, trend_sd: 1.5,
  // Process noise per week: q_L = 2^2, q_g = 0.5^2 (about a 3-week recency half-life).
  q_level: 4, q_trend: 0.25,
  u_sd: 3,
  alpha_sd: 8,
  // A form's own bias is a random effect around its mean, SD 4 (spec 2.2).
  bias_sd: 4,
});
export const FORM_SD = Object.freeze({ 'NBME 15': 5.5, 'NBME 16': 5.5, 'NBME 12': 6, 'NBME 13': 6, 'NBME 14': 6, 'UWSA 2': 6, 'UWSA 1': 6.5, 'Free 120': 6.5, default: 7 });
export const FORM_BIAS = Object.freeze({ 'UWSA 2': 4.5, 'NBME 9': -5.5, 'UWSA 3': -6, default: 0 });
export const CONVERSION = Object.freeze({ at: 0.70, a: 243, a_sd: 8, k: 200, k_sd: 70, obs_sd: 4 });
// The map's blueprint estimate enters as a weak reading with this SD (spec 2.2), only for today.
export const MAP_SD = 10;
// Calibration (spec 2.3): variance inflation s^2 ~ IG(3, 2) (prior mean 1), updated by each checked form's z^2.
export const INFLATION = Object.freeze({ alpha: 3, beta: 2 });
// With this many checked forms or fewer, report coverage counts only (spec 2.3).
export const COVERAGE_ONLY_MAX = 8;
export const ROUGH_FORMS = 3;

// ---- The planner: points = k x sum_t w_t x change in P(correct) on t at the exam ----------------------------------------
export const DRAWS = 500, SEED = 20261222;
// Priors on the effect sizes (each drawn per Monte Carlo draw, one shared draw across actions: common random numbers).
export const EFFECT = Object.freeze({
  // Lesson (spec 3.3c): one pooled logit shift, prior 0.5 SD 0.4 (conservative against tutoring d about 0.8, VanLehn 2011).
  lesson: { mean: 0.5, sd: 0.4 },
  // Pair test or contrast drill: ASSUMPTION 0.3 SD 0.3 logit on each topic of the pair, scaled by its confusion share.
  pair: { mean: 0.3, sd: 0.3 },
  // A question with feedback (spec 3.3b): a miss teaches gamma_f 0.15-0.3 logit (testing-effect meta-analyses, Rowland 2014,
  // Adesope 2017); a right answer ASSUMPTION about a third of that.
  miss: { mean: 0.2, sd: 0.08 }, right: { mean: 0.07, sd: 0.04 },
  card: { mean: 0.05, sd: 0.05 },
});
export const STABILITY = Object.freeze({ lesson: 21, pair: 14, question: 30 });
export const FSRS6_DEFAULT = Object.freeze([0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]);
export const LESSON_WINDOW = Object.freeze({ from_days: 2, to_days: 21 });

export const ROUTE = Object.freeze({
  cover: {
    lesson: { misunderstanding: 1, confusion: 0.5, faded: 0.3, slip: 0 },
    pair: { misunderstanding: 0, confusion: 1, faded: 0, slip: 0 },
    cards: { misunderstanding: 0.1, confusion: 0, faded: 1, slip: 0 },
  },
  // ASSUMPTION: a topic with few misses leans on this prior mix (pseudo-counts).
  prior: { misunderstanding: 1, confusion: 0.5, faded: 0.5, slip: 0.2 },
});
export const RECALL_GAP = Object.freeze({ card_r: 0.9, q_acc: 0.6, q_n: 3 });

// Action sizes and the decision rules.
export const PLAN = Object.freeze({
  uworld_block: 20, min_per_q: 1.5, review_min_per_q: 1.5, lesson_minutes: 25, pair_minutes: 3, sec_per_card: 24,
  lesson_min: 5, lesson_max: 40, cards_max_minutes: 60, hour_minutes: 60, top: 3,
  // How many of each kind go into the Monte Carlo (the rest are clearly behind on the mean).
  max_lessons: 30, max_pairs: 15,
  // A lesson topic is not offered again within this many days of a lesson on it.
  lesson_recent_days: 7,
  // Randomised top-2 (spec 3.4): when both leaders' P(best) are within this band, a logged coin flip, in at most max_share of decisions.
  coin: { lo: 0.35, hi: 0.65, max_share: 0.2 },
  // At most one logged decision an hour (opening Home many times is one decision).
  log_every_ms: 3_600_000,
  // Forms are scheduled, not ranked (spec 3.3d): one every 7-10 days, the last 7-14 days before the exam.
  form_every: [7, 10], form_last: [7, 14],
  // The two-week what-if: study days at this many minutes; "indistinguishable" under 3 points or P under 0.7.
  whatif_days: 14, study_minutes_per_day: 360, whatif_close_points: 3, whatif_close_p: 0.7, lesson_repeats: 2,
});
// Showing a gain as a number (spec 4): only for an action kind with this many linked outcomes and a validated slope.
export const VALIDATE = Object.freeze({ n: 30, slope_min: 0.5, slope_max: 2, z80: 1.2816 });

export const TEACH = Object.freeze({ fresh_ms: 2 * 3_600_000, lesson_floor: 0.05, pair_recent_days: 7 });

export const CARDS = Object.freeze({ marks_min: 0.5, unknown: 1, skipped_max: 10 });

export const ENERGY = Object.freeze({ lesson: 1.8, cluster: 1.8, uworld: 1.6, pair: 0.8, cards: 0.7 });
export const KNOW_IT = Object.freeze({ factor: 0.25, days: 7 });

export const MEASURE = Object.freeze({ uworld_min: 10, system_share: 0.5, cards_min: 10, targets_max: 40, card_days: 14 });
