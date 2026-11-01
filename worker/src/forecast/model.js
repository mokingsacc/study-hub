import {
  BLUEPRINT, WEIGHT, SCALE, KALMAN, FORM_SD, FORM_BIAS, CONVERSION, MAP_SD, INFLATION, COVERAGE_ONLY_MAX, ROUGH_FORMS, DRAWS, SEED,
  EFFECT, STABILITY, FSRS6_DEFAULT, LESSON_WINDOW, ROUTE, RECALL_GAP, PLAN, VALIDATE, MODEL_VERSION, MEASURE,
} from './constants.js';

const DAY_MS = 86_400_000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;
const r4 = x => Math.round(x * 10000) / 10000;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const daysBetween = (a, b) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS;

// ------------------------------------------------------------------ small maths
export function rng(seed = SEED) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function normal(u) { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); }
/** The standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function Phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
const phi = z => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const matMul = (A, B) => A.map(row => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
const transpose = A => A[0].map((_, j) => A.map(r => r[j]));
const matAdd = (A, B) => A.map((r, i) => r.map((v, j) => v + B[i][j]));

// ------------------------------------------------------------------ FSRS-6 (the forgetting curve and the stability updates)
const w20Of = w => (Array.isArray(w) && Number.isFinite(w[20]) ? w[20] : Array.isArray(w) && w.length < 21 ? 0.5 : FSRS6_DEFAULT[20]);
/** R(t, S) = (1 + f t / S)^(-w20), f = 0.9^(-1/w20) - 1: recall after t days at stability S. */
export function recall(t, S, w = FSRS6_DEFAULT) {
  const d = w20Of(w), f = Math.pow(0.9, -1 / d) - 1;
  return Math.pow(1 + f * Math.max(0, t) / Math.max(0.01, S), -d);
}
const W = (w, i) => (Array.isArray(w) && Number.isFinite(w[i]) ? w[i] : FSRS6_DEFAULT[i]);
/** Stability after a successful review at recall R (difficulty D, default 5). */
export const stabilityAfterPass = (S, R, w = FSRS6_DEFAULT, D = 5) => S * (1 + Math.exp(W(w, 8)) * (11 - D) * Math.pow(S, -W(w, 9)) * (Math.exp(W(w, 10) * (1 - R)) - 1));
/** Stability after a lapse at recall R. */
export const stabilityAfterFail = (S, R, w = FSRS6_DEFAULT, D = 5) => Math.min(S, W(w, 11) * Math.pow(D, -W(w, 12)) * (Math.pow(S + 1, W(w, 13)) - 1) * Math.exp(W(w, 14) * (1 - R)));

/**
 * A due card's expected recall on exam day if reviewed now, against not reviewed again before the exam (spec 3.3a, its
 * formula): [R_now R(T, S'_pass) + (1 - R_now) R(T, S'_fail)] - R(elapsed + T, S). An overdue card keeps falling, so the
 * skipped side is the card left as it is. card: {r: recall now, s: stability in days}. T: days to the exam.
 */
export function cardDeltaR(card, T, w = FSRS6_DEFAULT) {
  const S = Math.max(0.1, num(card.s) ?? 1), r = clamp(num(card.r) ?? 0.9, 0.01, 0.999);
  const d = w20Of(w), f = Math.pow(0.9, -1 / d) - 1;
  const elapsed = S * (Math.pow(r, -1 / d) - 1) / f;
  const now = r * recall(T, stabilityAfterPass(S, r, w), w) + (1 - r) * recall(T, stabilityAfterFail(S, r, w), w);
  return now - recall(elapsed + T, S, w);
}

// ------------------------------------------------------------------ input 1: P(correct) per topic
export const pCorrect = (state, t) => clamp(num(t && t.p) ?? 0.6, 0.02, 0.98);

// ------------------------------------------------------------------ input 2: exam weight per topic
export function examWeight(state) {
  const bySys = new Map();
  for (const t of state.topics || []) {
    if (!BLUEPRINT[t.system]) continue;
    const m = WEIGHT.nbme * (Number(t.n_nbme) || 0) + WEIGHT.uworld * (Number(t.n_uw) || 0) + WEIGHT.alpha;
    if (!bySys.has(t.system)) bySys.set(t.system, []);
    bySys.get(t.system).push([t.id, m]);
  }
  const topic = new Map(), system = {};
  for (const [sys, B] of Object.entries(BLUEPRINT)) {
    const list = bySys.get(sys) || [];
    const M = list.reduce((a, [, m]) => a + m, 0);
    for (const [id, m] of list) topic.set(id, B * m / M);
    system[sys] = { B, n: list.length };
  }
  return { topic, system };
}

/** The map's blueprint-weighted chance overall, and per system. */
export function mapChance(state, ew = examWeight(state)) {
  const sys = {};
  let P = 0, covered = 0;
  for (const t of state.topics || []) {
    const w = ew.topic.get(t.id);
    if (!w) continue;
    const p = pCorrect(state, t);
    P += w * p; covered += w;
    (sys[t.system] = sys[t.system] || { wp: 0, w: 0, n: 0 });
    sys[t.system].wp += w * p; sys[t.system].w += w; sys[t.system].n++;
  }
  // A system with no topics on the map takes the covered systems' chance.
  const base = covered ? P / covered : 0.6;
  const by = {};
  for (const [s, B] of Object.entries(BLUEPRINT)) by[s] = { B: r4(B), p: r4(sys[s] ? sys[s].wp / sys[s].w : base), topics: sys[s] ? sys[s].n : 0 };
  return { P: Object.values(by).reduce((a, s) => a + s.B * s.p, 0), by_system: by };
}

// ------------------------------------------------------------------ causes: which fix can move a topic
export function causeMix(t) {
  const c = { ...ROUTE.prior };
  for (const k of Object.keys(c)) c[k] += Number(t && t.causes && t.causes[k]) || 0;
  const gap = recallGap(t);
  if (gap) { c.confusion += c.faded; c.faded = 0; }
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / total])), gap };
}
export const recallGap = t => !!t && (num(t.card_r) ?? 0) >= RECALL_GAP.card_r && (Number(t.q_n) || 0) >= RECALL_GAP.q_n
  && (Number(t.q_right) || 0) / Number(t.q_n) < RECALL_GAP.q_acc;
/** How much of the topic an action's fix can move: sum over causes of share x what the fix covers. */
export const routeMult = (t, kind) => { const m = causeMix(t), cov = ROUTE.cover[kind]; return cov ? Object.keys(cov).reduce((s, k) => s + (m[k] || 0) * cov[k], 0) : 1; };

// ------------------------------------------------------------------ percent to score
export function conversionFit(forms = [], prior = CONVERSION) {
  const pairs = forms.filter(f => num(f.pct) != null && num(f.score) != null && f.timing !== 'loose' && !f.repeat && f.kind !== 'free120');
  const s2 = prior.obs_sd ** 2;
  let p11 = 1 / prior.a_sd ** 2, p12 = 0, p22 = 1 / prior.k_sd ** 2, b1 = prior.a / prior.a_sd ** 2, b2 = prior.k / prior.k_sd ** 2;
  for (const f of pairs) { const z = f.pct - prior.at, y = f.score; p11 += 1 / s2; p12 += z / s2; p22 += z * z / s2; b1 += y / s2; b2 += z * y / s2; }
  const det = p11 * p22 - p12 * p12;
  const cov = [[p22 / det, -p12 / det], [-p12 / det, p11 / det]];
  return { a: cov[0][0] * b1 + cov[0][1] * b2, k: cov[1][0] * b1 + cov[1][1] * b2, cov, n: pairs.length };
}

// ------------------------------------------------------------------ the forecast: a Kalman filter
const NBME_RE = /(\d{1,2})/, UWSA_RE = /(?:uwsa|sa|self[- ]?assessment)\s*#?\s*-?\s*([123])\b/i;
export function formKey(form) {
  const label = String((form && (form.label || form.name)) || '');
  if (form && form.kind === 'free120') return 'Free 120';
  if (form && form.kind === 'uwsa') { const m = UWSA_RE.exec(label) || /\b([123])\b/.exec(label); return m ? `UWSA ${m[1]}` : null; }
  const m = NBME_RE.exec(label);
  return m ? `NBME ${+m[1]}` : null;
}
const formSd = f => FORM_SD[formKey(f)] ?? FORM_SD.default;
const formBias = f => FORM_BIAS[formKey(f)] ?? FORM_BIAS.default;
const isUwsa = f => f.kind === 'uwsa';

/** The readings a form gives (pure): a 3-digit score, a percent through the line, or both (the pair also reads the line). */
export function readingsOf(f, fit) {
  const out = [], u = isUwsa(f) ? 1 : 0, b = formBias(f), sf = formSd(f);
  const kv = (p) => ((p - CONVERSION.at) ** 2) * fit.cov[1][1];
  if (num(f.score) != null) out.push({ kind: 'score', H: [1, 0, u, 0], y: f.score - b, R: sf ** 2 + KALMAN.bias_sd ** 2, raw: f.score, bias: b });
  if (num(f.pct) != null) {
    const conv = CONVERSION.a + fit.k * (f.pct - CONVERSION.at);
    if (num(f.score) != null) out.push({ kind: 'line', H: [0, 0, 0, 1], y: f.score - conv, R: CONVERSION.obs_sd ** 2 + kv(f.pct) });
    else out.push({ kind: 'pct', H: [1, 0, u, -1], y: conv - b, R: sf ** 2 + KALMAN.bias_sd ** 2 + kv(f.pct), raw: f.pct, bias: b, conv });
  }
  return out;
}

function kPredict(x, P, weeks) {
  if (weeks <= 0) return { x, P };
  const F = [[1, weeks, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const xn = F.map(r => r.reduce((s, v, j) => s + v * x[j], 0));
  const Pn = matAdd(matMul(matMul(F, P), transpose(F)), [[KALMAN.q_level * weeks, 0, 0, 0], [0, KALMAN.q_trend * weeks, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  return { x: xn, P: Pn };
}
function kUpdate(x, P, { H, y, R }) {
  const PH = P.map(r => r.reduce((s, v, j) => s + v * H[j], 0));
  const S = H.reduce((s, v, i) => s + v * PH[i], 0) + R;
  const mean = H.reduce((s, v, i) => s + v * x[i], 0);
  const K = PH.map(v => v / S);
  const xn = x.map((v, i) => v + K[i] * (y - mean));
  const Pn = P.map((r, i) => r.map((v, j) => v - K[i] * PH[j]));
  return { x: xn, P: Pn, mean, S };
}
const priorState = () => ({ x: [KALMAN.level, KALMAN.trend, 0, 0], P: [[KALMAN.level_sd ** 2, 0, 0, 0], [0, KALMAN.trend_sd ** 2, 0, 0], [0, 0, KALMAN.u_sd ** 2, 0], [0, 0, 0, KALMAN.alpha_sd ** 2]] });
/** Moves a stored state {x, P, at} to time `at` (ms). */
export const propagate = (snap, at) => kPredict(snap.x, snap.P, Math.max(0, (at - snap.at) / (7 * DAY_MS)));

export function usableForms(forms = [], fit = conversionFit(forms)) {
  return forms.filter(f => f.timing !== 'loose' && !f.repeat && (f.kind !== 'free120' || fit.n >= 2) && (num(f.score) != null || num(f.pct) != null));
}

/** The variance inflation from the checked forms' z (spec 2.3): s^2 ~ IG(3 + n/2, 2 + sum z^2 / 2); E[s^2] = beta / (alpha - 1). */
export function inflation(checks = []) {
  const zs = checks.map(c => num(c.z)).filter(z => z != null);
  const a = INFLATION.alpha + zs.length / 2, b = INFLATION.beta + zs.reduce((s, z) => s + z * z, 0) / 2;
  return { s2: b / (a - 1), n: zs.length, mean_z: zs.length ? r3(zs.reduce((s, z) => s + z, 0) / zs.length) : null };
}

/**
 * forecastScore(state) -> the exam-day forecast: {mid, low, high, low50, high50, sd, p_target, percentile, level, trend,
 *   pct, conversion, snapshot: {x, P, at} (the state now, for freezing), readings, inflation, n_forms, rough, ...}.
 * Each form is a reading y = L + b_f (+ u for UWSA) + e; a percent reads through the line (whose intercept error is in the
 * state); the map's blueprint estimate is one weak reading today (MAP_SD). Then propagated to the exam with its trend,
 * plus the exam's SEM and the day's own noise, scaled by the inflation from past checks.
 */
export function forecastScore(state) {
  const now = Number(state.now) || Date.parse(`${state.today}T12:00:00Z`);
  const ew = examWeight(state);
  const map = mapChance(state, ew);
  const fit = conversionFit(state.forms || []);
  const forms = usableForms(state.forms || [], fit).filter(f => f.at <= now).sort((a, b) => a.at - b.at);
  let { x, P } = priorState();
  let t = forms.length ? forms[0].at : now;
  const readings = [];
  for (const f of forms) {
    ({ x, P } = kPredict(x, P, (f.at - t) / (7 * DAY_MS))); t = f.at;
    for (const r of readingsOf(f, fit)) { const u = kUpdate(x, P, r); x = u.x; P = u.P; readings.push({ label: f.label, day: f.day, kind: r.kind, y: r1(r.y), sd: r1(Math.sqrt(r.R)) }); }
  }
  ({ x, P } = kPredict(x, P, (now - t) / (7 * DAY_MS)));
  const mapScore = CONVERSION.a + fit.k * (map.P - CONVERSION.at);
  const mapR = { H: [1, 0, 0, -1], y: mapScore, R: MAP_SD ** 2 + ((map.P - CONVERSION.at) ** 2) * fit.cov[1][1] };
  ({ x, P } = kUpdate(x, P, mapR));
  readings.push({ label: 'Your map', day: state.today, kind: 'map', y: r1(mapScore), sd: r1(Math.sqrt(mapR.R)) });
  const snapshot = { x: x.map(r3), P: P.map(r => r.map(r3)), at: now };
  // To the exam
  // No exam set (state.exam_day null) or past it: the forecast is for today (no weeks to propagate).
  const examAt = state.exam_day ? Date.parse(`${state.exam_day}T09:00:00Z`) : now;
  const atExam = kPredict(x, P, Math.max(0, (examAt - now) / (7 * DAY_MS) || 0));
  const inf = inflation(state.checks || []);
  const sd = Math.sqrt((atExam.P[0][0] + SCALE.sem ** 2 + SCALE.day_sd ** 2) * inf.s2);
  const mid = atExam.x[0];
  const h80 = Math.max(SCALE.min_half80, SCALE.z80 * sd), h50 = SCALE.z50 * sd;
  const target = Number(state.target) || 260;
  const nForms = forms.length;
  return {
    mid: Math.round(mid), low: Math.round(mid - h80), high: Math.round(mid + h80), low50: Math.round(mid - h50), high50: Math.round(mid + h50), sd: r1(sd),
    interval_pct: 80, p_target: r3(1 - Phi((target - mid) / sd)), target, percentile: Math.round(100 * Phi((mid - SCALE.norm_mean) / SCALE.norm_sd)),
    p_pass: r3(1 - Phi((SCALE.pass - mid) / sd)),
    level: r1(x[0]), level_sd: r1(Math.sqrt(P[0][0])), trend: r1(x[1]), trend_sd: r1(Math.sqrt(P[1][1])), uwsa_offset: r1(x[2]), line_error: r1(x[3]),
    pct: r4(map.P), by_system: map.by_system, k: r1(fit.k), k_sd: r1(Math.sqrt(fit.cov[1][1])),
    conversion: { a: CONVERSION.a, k: r1(fit.k), at: CONVERSION.at, pairs: fit.n },
    snapshot, readings, inflation: { s2: r3(inf.s2), n: inf.n, mean_z: inf.mean_z },
    n_forms: nForms, rough: nForms < ROUGH_FORMS, model_version: MODEL_VERSION,
  };
}

// ------------------------------------------------------------------ freeze and compare (spec 2.3)
/**
 * The predictive for a form from a frozen snapshot {x, P, at} (raw, before inflation): its 3-digit score when it has one,
 * else its percent read through the line. {mean, sd, kind}.
 */
export function predictiveFor(snap, form, fit = conversionFit([form])) {
  const { x, P } = propagate(snap, form.at);
  const r = readingsOf(form, fit).find(q => q.kind === 'score') || readingsOf(form, fit).find(q => q.kind === 'pct');
  if (!r) return null;
  const mean = r.H.reduce((s, v, i) => s + v * x[i], 0) + (r.bias || 0);
  const v = r.H.reduce((s, hi, i) => s + hi * r.H.reduce((t, hj, j) => t + hj * P[i][j], 0), 0) + r.R;
  return { mean, sd: Math.sqrt(v), kind: r.kind, actual: r.kind === 'score' ? r.raw : r.conv };
}
/** Gaussian CRPS (closed form). */
export const crps = (y, mean, sd) => { const z = (y - mean) / sd; return sd * (z * (2 * Phi(z) - 1) + 2 * phi(z) - 1 / Math.sqrt(Math.PI)); };

/**
 * Each usable form against the forecast frozen before it: the newest stored row written before the form (row.at < form.at)
 * gives the predictive. rows: [{day, at, mid, low, high, state_json, inflation}]. Returns [{sitting_id, label, form_day,
 * forecast_day, forecast_mid, pred_mean, pred_sd, actual, kind, error, z, pit, hit50, hit80, crps, actual_pct}].
 */
export function checkForms(rows = [], forms = []) {
  const sorted = [...rows].filter(r => num(r.at) != null).sort((a, b) => a.at - b.at);
  const fit = conversionFit(forms);
  const out = [];
  for (const f of usableForms(forms, fit)) {
    let row = null;
    for (const x of sorted) { if (x.at < f.at) row = x; else break; }
    if (!row) continue;
    let snap = null;
    try { snap = typeof row.state_json === 'string' ? JSON.parse(row.state_json) : row.state_json; } catch { snap = null; }
    if (!snap || !Array.isArray(snap.x)) continue;
    const pr = predictiveFor(snap, f, fit);
    if (!pr) continue;
    const s = Math.sqrt(Number(row.inflation) || 1);
    const z = (pr.actual - pr.mean) / pr.sd;
    out.push({ sitting_id: f.sitting_id, label: f.label || f.name, form_day: f.day, forecast_day: row.day, forecast_mid: num(row.mid),
      pred_mean: Math.round(pr.mean), pred_sd: r1(pr.sd), actual: Math.round(pr.actual), kind: pr.kind, error: Math.round(pr.actual - pr.mean),
      z: r3(z), pit: r3(Phi(z)), hit50: Math.abs(z) <= SCALE.z50 * s ? 1 : 0, hit80: Math.abs(z) <= SCALE.z80 * s ? 1 : 0, crps: r1(crps(pr.actual, pr.mean, pr.sd)),
      actual_pct: num(f.pct), score: num(f.score) });
  }
  return out;
}
/** Coverage and errors over the checks (spec 2.3: with 8 or fewer, coverage counts only, never "calibrated"). */
export function checkSummary(checks = []) {
  const c = checks.filter(x => num(x.z) != null);
  const n = c.length;
  return { n, inside80: c.filter(x => Number(x.hit80)).length, inside50: c.filter(x => Number(x.hit50)).length,
    mae: n ? r1(c.reduce((a, x) => a + Math.abs(Number(x.error)), 0) / n) : null, mean_z: n ? r3(c.reduce((a, x) => a + Number(x.z), 0) / n) : null,
    crps: n ? r1(c.reduce((a, x) => a + Number(x.crps || 0), 0) / n) : null, coverage_only: n <= COVERAGE_ONLY_MAX,
    biased: n >= 4 && Math.abs(c.reduce((a, x) => a + Number(x.z), 0) / n) > 1 };
}
export function checkLine(c) {
  if (!c || c.actual == null || c.pred_mean == null) return '';
  return c.kind === 'score' ? `Last forecast ${c.pred_mean} for ${c.label}, you scored ${c.actual}.`
    : `Last forecast ${c.pred_mean} for ${c.label} (read from its percent), your percent reads as ${c.actual}.`;
}
/** "4 of 5 inside the 80% range; off by 4 points on average." */
export function summaryLine(s) {
  if (!s || !s.n) return '';
  return `${s.inside80} of ${s.n} inside the 80% range; off by ${s.mae} ${s.mae === 1 ? 'point' : 'points'} on average${s.biased ? `; it has been ${s.mean_z > 0 ? 'too low' : 'too high'} so far` : ''}.`;
}

/** Change in the exam-day forecast over the last week, or null. */
export function weekChange(rows = [], today, mid) {
  const cut = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);
  const old = [...rows].filter(r => r.day && r.day <= cut && num(r.mid) != null).sort((a, b) => String(b.day).localeCompare(String(a.day)))[0];
  return old ? Math.round(mid - old.mid) : null;
}
/** "Forecast 245 (238 to 252), up 2 this week". */
export function forecastLine(fc, change = null) {
  if (!fc || fc.mid == null) return 'No forecast yet';
  const ch = change == null ? '' : change > 0 ? `, up ${change} this week` : change < 0 ? `, down ${-change} this week` : ', same as last week';
  return `Forecast ${fc.mid} (${fc.low} to ${fc.high})${ch}${fc.rough ? ', rough' : ''}`;
}

/**
 * One pooled logit shift (spec 3.3c), fitted by Newton's method on the Laplace posterior: each answer 2-21 days after a
 * lesson has logit P = logit p_pre + delta x R(days, S_lesson), against the map's chance before the lesson. obs: [{p_pre, y,
 * days}]. Returns {mean, sd, n}; with no answers, the prior.
 */
export function lessonEffect(obs = [], prior = EFFECT.lesson, w = FSRS6_DEFAULT) {
  const rows = obs.filter(o => num(o.p_pre) != null && (o.y === 0 || o.y === 1) && o.days >= LESSON_WINDOW.from_days && o.days <= LESSON_WINDOW.to_days)
    .map(o => ({ b: logit(clamp(o.p_pre, 0.02, 0.98)), y: o.y, r: recall(o.days, STABILITY.lesson, w) }));
  let d = prior.mean, h = 1 / prior.sd ** 2;
  for (let it = 0; it < 25; it++) {
    let g = -(d - prior.mean) / prior.sd ** 2; h = 1 / prior.sd ** 2;
    for (const o of rows) { const p = sigmoid(o.b + d * o.r); g += (o.y - p) * o.r; h += p * (1 - p) * o.r * o.r; }
    const step = g / h;
    d += step;
    if (Math.abs(step) < 1e-6) break;
  }
  return { mean: r3(d), sd: r3(Math.sqrt(1 / h)), n: rows.length };
}

// ------------------------------------------------------------------ inputs 3 and 4: what an action moves, and its minutes
export function actionMinutes(state, action) {
  switch (action.kind) {
    case 'lesson': return clamp(num(state.lesson && state.lesson.minutes) ?? PLAN.lesson_minutes, PLAN.lesson_min, PLAN.lesson_max);
    case 'pair': return PLAN.pair_minutes;
    case 'uworld': return (action.n || PLAN.uworld_block) * ((num(state.uworld && state.uworld.min_per_q) ?? PLAN.min_per_q) + PLAN.review_min_per_q);
    case 'cards': return (action.cards || []).length * ((num(state.cards && state.cards.sec) ?? PLAN.sec_per_card) / 60);
    default: return 0;
  }
}
// Days to the exam (state.exam_day, the exam_date setting); 0 with no exam set or once it has passed.
const daysToExam = state => (state.exam_day ? Math.max(0, daysBetween(state.today, state.exam_day) || 0) : 0);

/**
 * The change in P(correct) at the exam, weighted by exam share, per unit of each effect size (spec 3.3; the linear
 * p(1-p) step on the logit scale): {lesson, pair, miss, right, card}. points = k x sum over effects of (effect x coef).
 * ctx: {ew, pOf (topic id -> p, for the greedy's updates)}. Also returns targets: the affected topics' chance without
 * and with the action at the mean effects (for the validation log).
 */
export function actionCoefs(state, action, ctx) {
  const ew = ctx.ew, T = daysToExam(state), w = state.fsrs_w || FSRS6_DEFAULT;
  const pOf = t => (ctx.pOf && ctx.pOf.has(t.id) ? ctx.pOf.get(t.id) : pCorrect(state, t));
  const c = { lesson: 0, pair: 0, miss: 0, right: 0, card: 0 };
  const targets = [];
  switch (action.kind) {
    case 'lesson': {
      const t = action.topic, p = pOf(t), wt = ew.topic.get(t.id) || 0, m = routeMult(t, 'lesson');
      c.lesson = wt * p * (1 - p) * m * recall(T, STABILITY.lesson, w);
      targets.push({ topic_id: t.id, p, shift: { lesson: m * recall(7, STABILITY.lesson, w) } });
      break;
    }
    case 'pair': {
      for (const t of [action.topic, action.partner].filter(Boolean)) {
        const p = pOf(t), wt = ew.topic.get(t.id) || 0, m = routeMult(t, 'pair');
        c.pair += wt * p * (1 - p) * m * recall(T, STABILITY.pair, w);
        targets.push({ topic_id: t.id, p, shift: { pair: m * recall(7, STABILITY.pair, w) } });
      }
      break;
    }
    case 'uworld': {
      // Items land on topics in proportion to exam weight within the system (or the whole exam for a random block).
      const n = action.n || PLAN.uworld_block, R = recall(T, STABILITY.question, w);
      const pool = (state.topics || []).filter(t => ew.topic.has(t.id) && (!action.system || t.system === action.system));
      const Wp = pool.reduce((s, t) => s + ew.topic.get(t.id), 0) || 1;
      for (const t of pool) {
        const wt = ew.topic.get(t.id), p = pOf(t), items = n * wt / Wp;
        c.miss += items * wt * p * (1 - p) * (1 - p) * R;
        c.right += items * wt * p * (1 - p) * p * R;
      }
      break;
    }
    case 'cards': {
      const byId = new Map((state.topics || []).map(t => [t.id, t]));
      for (const card of action.cards || []) {
        const t = byId.get(card.topic_id), wt = t ? ew.topic.get(t.id) || 0 : 0;
        if (!t || !wt) continue;
        const nCards = Math.max(1, Number(state.cards && state.cards.per_topic && state.cards.per_topic[t.id]) || 1);
        c.card += wt * Math.max(0, cardDeltaR(card, T, w)) / nCards * routeMult(t, 'cards');
      }
      break;
    }
    default: break;
  }
  return { c, minutes: actionMinutes(state, action), targets };
}

export function measureTargets(state, action) {
  const ew = examWeight(state), w = state.fsrs_w || FSRS6_DEFAULT;
  const byId = new Map((state.topics || []).map(t => [t.id, t]));
  if (action.kind === 'uworld') {
    const n = action.n || PLAN.uworld_block, R = recall(7, STABILITY.question, w);
    const pool = (state.topics || []).filter(t => ew.topic.has(t.id) && (!action.system || t.system === action.system));
    const Wp = pool.reduce((s, t) => s + ew.topic.get(t.id), 0) || 1;
    return pool.map(t => ({ t, items: n * ew.topic.get(t.id) / Wp })).sort((a, b) => b.items - a.items || String(a.t.id).localeCompare(String(b.t.id)))
      .slice(0, MEASURE.targets_max).map(({ t, items }) => { const p = pCorrect(state, t); return { topic_id: t.id, p, shift: { miss: items * (1 - p) * R, right: items * p * R } }; });
  }
  if (action.kind === 'cards') {
    const perCard = (num(state.cards && state.cards.sec) ?? PLAN.sec_per_card) / 60;
    const due = action.cards || ((state.cards && state.cards.due) || []).slice(0, Math.floor(PLAN.cards_max_minutes / perCard));
    const dR = new Map();
    for (const card of due) {
      const t = byId.get(card.topic_id);
      if (!t || !ew.topic.has(t.id)) continue;
      const nCards = Math.max(1, Number(state.cards && state.cards.per_topic && state.cards.per_topic[t.id]) || 1);
      dR.set(t.id, (dR.get(t.id) || 0) + Math.max(0, cardDeltaR(card, MEASURE.card_days, w)) / nCards * routeMult(t, 'cards'));
    }
    return [...dR.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, MEASURE.targets_max)
      .map(([id, d]) => { const p = pCorrect(state, byId.get(id)); return { topic_id: id, p, shift: { card: d / Math.max(0.05, p * (1 - p)) } }; });
  }
  return [];
}

// ------------------------------------------------------------------ effect draws (common random numbers)
const posNormal = (u, m, s) => Math.max(0, m + s * normal(u));
/** M draws of {k, lesson, pair, miss, right, card}: each shared by every action (common random numbers). */
export function effectDraws(state, fc, { draws = DRAWS, seed = SEED } = {}) {
  const u = rng(seed), le = lessonEffect((state.lesson && state.lesson.obs) || [], EFFECT.lesson, state.fsrs_w || FSRS6_DEFAULT);
  const cal = state.calibration || {};
  const slope = kind => (cal[kind] && cal[kind].validated ? cal[kind].slope : 1);
  const out = [];
  for (let i = 0; i < draws; i++) {
    out.push({ k: Math.max(50, fc.k + fc.k_sd * normal(u)), lesson: (le.mean + le.sd * normal(u)) * slope('lesson'), pair: posNormal(u, EFFECT.pair.mean, EFFECT.pair.sd) * slope('pair'),
      miss: posNormal(u, EFFECT.miss.mean, EFFECT.miss.sd) * slope('uworld'), right: posNormal(u, EFFECT.right.mean, EFFECT.right.sd) * slope('uworld'),
      card: posNormal(u, EFFECT.card.mean, EFFECT.card.sd) * slope('cards') });
  }
  return { draws: out, lesson: le };
}
const valueOf = (c, d) => d.k * (d.lesson * c.lesson + d.pair * c.pair + d.miss * c.miss + d.right * c.right + d.card * c.card);
/** The mean effects (for the greedy and the what-if plans). */
const meanDraw = (fc, le) => ({ k: fc.k, lesson: le.mean, pair: EFFECT.pair.mean, miss: EFFECT.miss.mean, right: EFFECT.right.mean, card: EFFECT.card.mean });

// ------------------------------------------------------------------ the candidates
/** A lesson or a pair test (the kinds the one list of what to do next orders). */
export const lessonish = c => !!c && (c.kind === 'lesson' || c.kind === 'pair');
/** The first lesson-type candidate in the one list's order (its ord), or null. */
export const firstInOrder = list => (list || []).filter(c => lessonish(c) && c.ord != null).reduce((b, c) => (!b || c.ord < b.ord ? c : b), null);

function orderedCandidates(state, ctx, byId) {
  const ew = ctx.ew, md = ctx.md, out = [];
  ctx.order.forEach((it, ord) => {
    const t = byId.get(it.topic_id);
    if (!t || !ew.topic.has(t.id)) return;
    const p = it.kind === 'pair' ? byId.get(it.partner_id) : null;
    if (it.kind === 'pair' && !p) return;
    const a = p ? { kind: 'pair', id: it.id, topic: t, partner: p, name: `${t.name} against ${p.name}`, system: t.system }
      : { kind: 'lesson', id: it.id, topic: t, name: t.name, system: t.system };
    const k = actionCoefs(state, a, ctx);
    out.push({ ...a, ...k, mean: valueOf(k.c, md) / k.minutes * 60, ord });
  });
  return out;
}

export function candidates(state, fc, ctx) {
  const ew = ctx.ew, md = ctx.md, out = [];
  const recent = new Date(Date.parse(`${state.today}T12:00:00Z`) - PLAN.lesson_recent_days * DAY_MS).toISOString().slice(0, 10);
  const byId = new Map((state.topics || []).map(t => [t.id, t]));
  const topics = Array.isArray(ctx.order) ? [] : (state.topics || []).filter(t => ew.topic.has(t.id));
  if (Array.isArray(ctx.order)) out.push(...orderedCandidates(state, ctx, byId));
  const lessons = topics.filter(t => !(t.lesson_day && t.lesson_day >= recent)).map(t => {
    const a = { kind: 'lesson', id: `lesson:${t.id}`, topic: t, name: t.name, system: t.system };
    const k = actionCoefs(state, a, ctx);
    return { ...a, ...k, mean: valueOf(k.c, md) / k.minutes * 60 };
  }).sort((a, b) => b.mean - a.mean).slice(0, PLAN.max_lessons);
  const seenPair = new Set();
  const pairs = topics.filter(t => {
    if (!t.partner || !byId.has(t.partner)) return false;
    const key = [t.id, t.partner].sort().join('|');
    if (seenPair.has(key)) return false;
    seenPair.add(key); return true;
  }).map(t => {
    const a = { kind: 'pair', id: `pair:${t.id}:${t.partner}`, topic: t, partner: byId.get(t.partner), name: `${t.name} against ${byId.get(t.partner).name}`, system: t.system };
    const k = actionCoefs(state, a, ctx);
    return { ...a, ...k, mean: valueOf(k.c, md) / k.minutes * 60 };
  }).sort((a, b) => b.mean - a.mean).slice(0, PLAN.max_pairs);
  out.push(...lessons, ...pairs);
  for (const s of [...Object.keys(BLUEPRINT), null]) {
    const a = { kind: 'uworld', id: `uworld:${s || 'random'}`, system: s, name: s ? (ctx.names[s] || s) : 'random systems', n: PLAN.uworld_block };
    const k = actionCoefs(state, a, ctx);
    out.push({ ...a, ...k, mean: valueOf(k.c, md) / k.minutes * 60 });
  }
  const perCard = (num(state.cards && state.cards.sec) ?? PLAN.sec_per_card) / 60;
  const due = ((state.cards && state.cards.due) || []).slice(0, Math.floor(PLAN.cards_max_minutes / perCard));
  if (due.length) {
    const a = { kind: 'cards', id: 'cards', name: 'due Anki cards', cards: due };
    const k = actionCoefs(state, a, ctx);
    if (k.minutes > 0) out.push({ ...a, ...k, mean: valueOf(k.c, md) / k.minutes * 60, n: due.length });
  }
  return out;
}

// ------------------------------------------------------------------ choosing: draws, P(best), Thompson, the coin flip
/**
 * Points per hour for each candidate over the draws: median, 10-90% range, P(best). opts.pick: a number in [0, 1) choosing
 * the Thompson draw; opts.coin: a number in [0, 1) for the coin flip; opts.randomised_share: the share of past logged
 * decisions that were coin flips (none past PLAN.coin.max_share).
 */
export function rankCandidates(cands, draws) {
  const M = draws.length, vals = cands.map(c => draws.map(d => valueOf(c.c, d) / c.minutes * 60));
  const best = new Array(cands.length).fill(0);
  for (let j = 0; j < M; j++) { let bi = 0; for (let i = 1; i < cands.length; i++) if (vals[i][j] > vals[bi][j]) bi = i; best[bi]++; }
  return cands.map((c, i) => {
    const s = [...vals[i]].sort((a, b) => a - b);
    return { ...c, per_hour: { median: r4(quantile(s, 0.5)), p10: r4(quantile(s, 0.1)), p90: r4(quantile(s, 0.9)) }, p_best: r3(best[i] / M), _vals: vals[i] };
  }).sort((a, b) => b.per_hour.median - a.per_hour.median);
}
export function choose(ranked, { pick = 0.5, coin = 0.5, randomised_share = 0 } = {}) {
  if (!ranked.length) return null;
  const j = Math.min(ranked[0]._vals.length - 1, Math.floor(pick * ranked[0]._vals.length));
  let ti = 0;
  for (let i = 1; i < ranked.length; i++) if (ranked[i]._vals[j] > ranked[ti]._vals[j]) ti = i;
  const byBest = [...ranked].sort((a, b) => b.p_best - a.p_best);
  const [a, b] = byBest;
  const close = a && b && a.p_best >= PLAN.coin.lo && a.p_best <= PLAN.coin.hi && b.p_best >= PLAN.coin.lo && b.p_best <= PLAN.coin.hi;
  if (close && randomised_share < PLAN.coin.max_share) return { chosen: coin < 0.5 ? a : b, rule: 'coin', propensity: 0.5, other: coin < 0.5 ? b : a };
  return { chosen: ranked[ti], rule: 'thompson', propensity: null, draw: j };
}

const fmtHour = p => { if (p <= 0) return '0'; const d = Math.max(0, -Math.floor(Math.log10(p))); return p.toFixed(Math.min(3, d)); };
/** One plain line. With a validated kind: "Lesson on Hyponatremia: about 0.3 points an hour (0.1 to 0.5), 25 minutes."; else "Lesson on Hyponatremia, 25 minutes; gain still rough." */
export function optionLine(o, calibration = {}) {
  const what = { lesson: `Lesson on ${o.name}`, pair: `Pair test: ${o.name}`, uworld: `UWorld block of ${o.n} on ${o.name}`, cards: `Clear ${o.n} due Anki ${o.n === 1 ? 'card' : 'cards'}` }[o.kind] || o.name;
  const kind = o.kind === 'uworld' ? 'uworld' : o.kind;
  const shown = calibration[kind] && calibration[kind].validated;
  return shown ? `${what}: about ${fmtHour(o.per_hour.median)} points an hour (${fmtHour(o.per_hour.p10)} to ${fmtHour(o.per_hour.p90)}), ${Math.round(o.minutes)} minutes.`
    : `${what}, ${Math.round(o.minutes)} minutes; gain still rough.`;
}

/**
 * The next hour (spec 3.4-3.5): the draws rank every candidate; the first pick is Thompson's (or a logged coin flip between
 * two close leaders); then greedy by value density, the chosen topics' chances moved and everything re-ranked, until the
 * hour is full. Returns {hour: [up to PLAN.top], ranked (top 20, no draws), choice, lesson_effect, rough}.
 */
export function planNextHour(state, fc = forecastScore(state), opts = {}) {
  const ew = examWeight(state);
  const { draws, lesson } = effectDraws(state, fc, opts);
  const md = meanDraw(fc, lesson);
  const ordered = Array.isArray(opts.order);
  const ctx = { ew, md, names: opts.names || {}, pOf: new Map(), ...(ordered ? { order: opts.order } : {}) };
  const ranked = rankCandidates(candidates(state, fc, ctx), draws);
  let choice = choose(ranked, opts);
  // One list (1 Nov 2026): a lesson or pair test chosen is the list's first; a coin flip that lands on another is not used.
  if (ordered && choice && lessonish(choice.chosen)) {
    const top = firstInOrder(ranked);
    if (top && top.id !== choice.chosen.id) choice = { chosen: top, rule: 'thompson', propensity: null, draw: choice.draw ?? null };
  }
  const hour = [];
  let left = PLAN.hour_minutes, used = new Set();
  let next = choice && choice.chosen;
  while (next && hour.length < PLAN.top && next.minutes <= left + 1e-9) {
    hour.push(next); used.add(next.id); left -= next.minutes;
    // Move the chosen topics' chances (mean effects) and re-rank what is left.
    for (const tg of next.targets || []) {
      const shift = Object.entries(tg.shift || {}).reduce((s, [k, v]) => s + (md[k] || 0) * v, 0);
      ctx.pOf.set(tg.topic_id, sigmoid(logit(clamp(tg.p, 0.02, 0.98)) + shift));
    }
    if (next.kind === 'cards') used.add('cards');
    let rest = candidates(state, fc, ctx).filter(c => !used.has(c.id));
    // One list: only its next lesson or pair test can come, and only when it fits.
    if (ordered) { const nextL = firstInOrder(rest); rest = rest.filter(c => !lessonish(c) || c === nextL); }
    rest = rest.filter(c => c.minutes <= left + 1e-9);
    next = rest.sort((a, b) => b.mean - a.mean)[0] || null;
    if (next) { const r = rankCandidates([next], draws)[0]; const was = ranked.find(x => x.id === r.id); next = { ...r, p_best: was ? was.p_best : null }; }
  }
  const strip = o => { const { _vals, cards, topic, partner, ...rest } = o; return { ...rest, ...(topic ? { topic_id: topic.id } : {}), ...(partner ? { partner_id: partner.id } : {}), line: optionLine(o, state.calibration || {}) }; };
  // The one list's next lesson or pair test as the planner values it, for the sheet even when the hour has none.
  const nextL = ordered ? firstInOrder(ranked) : null;
  return { hour: hour.map(strip), ranked: ranked.slice(0, 20).map(strip), ...(nextL ? { next_lesson: strip(nextL) } : {}), choice: choice ? { id: choice.chosen.id, rule: choice.rule, propensity: choice.propensity, other: choice.other ? choice.other.id : null } : null,
    lesson_effect: lesson, mean: md, rough: !Object.values(state.calibration || {}).some(c => c && c.validated), draws_n: draws.length };
}

// ------------------------------------------------------------------ forms: scheduled, not ranked (spec 3.3d)
export function formAdvice(state, fc) {
  const next = state.schedule && state.schedule.next_form, last = state.schedule && state.schedule.last_form_day;
  // The last form 7 days before the exam; no cap with no exam set, or once that day has passed (never a day before today).
  const latest = state.exam_day ? new Date(Date.parse(`${state.exam_day}T12:00:00Z`) - PLAN.form_last[0] * DAY_MS).toISOString().slice(0, 10) : null;
  let day = next ? next.day : last ? new Date(Date.parse(`${last}T12:00:00Z`) + PLAN.form_every[1] * DAY_MS).toISOString().slice(0, 10) : state.today;
  if (day < state.today) day = state.today;
  if (latest && latest >= state.today && day > latest && !next) day = latest;
  const P = fc.level_sd ** 2, sf = FORM_SD.default ** 2 + KALMAN.bias_sd ** 2;
  return { day, name: next ? next.name : null, scheduled: !!next, sd_now: fc.level_sd, sd_after: r1(Math.sqrt(1 / (1 / P + 1 / sf))),
    why: next ? 'on your schedule' : last ? `${PLAN.form_every[0]} to ${PLAN.form_every[1]} days after your last form` : 'no form yet' };
}

// ------------------------------------------------------------------ the two-week what-if (common random numbers)
export function whatIfPlan(state, fc, system, ctx) {
  let budget = Number(state.whatif_minutes) || PLAN.whatif_days * PLAN.study_minutes_per_day;
  const local = { ...ctx, pOf: new Map() };
  const sum = { lesson: 0, pair: 0, miss: 0, right: 0, card: 0 };
  const times = new Map();
  let uwLeft = Math.floor((Number(state.uworld && state.uworld.left) || 0) * (BLUEPRINT[system] || 0));
  // The system's 40 most valuable lesson topics on the mean (the rest never reach the top within two weeks' budget).
  const topics = (state.topics || []).filter(t => t.system === system && ctx.ew.topic.has(t.id))
    .map(t => [t, actionCoefs(state, { kind: 'lesson', topic: t }, local).c.lesson]).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  const byId = new Map((state.topics || []).map(t => [t.id, t]));
  let lessons = 0, pairs = 0, blocks = 0;
  for (let guard = 0; guard < 400 && budget > 0; guard++) {
    let best = null;
    const consider = a => { const k = actionCoefs(state, a, local); const v = valueOf(k.c, ctx.md) / k.minutes; if (k.minutes <= budget && v > 0 && (!best || v > best.v)) best = { a, k, v }; };
    for (const t of topics) {
      if ((times.get(t.id) || 0) < PLAN.lesson_repeats) consider({ kind: 'lesson', topic: t });
      if (t.partner && byId.has(t.partner) && (times.get(`p:${t.id}`) || 0) < 1) consider({ kind: 'pair', topic: t, partner: byId.get(t.partner) });
    }
    if (uwLeft >= PLAN.uworld_block) consider({ kind: 'uworld', system, n: PLAN.uworld_block });
    if (!best) break;
    budget -= best.k.minutes;
    for (const key of Object.keys(sum)) sum[key] += best.k.c[key];
    for (const tg of best.k.targets) {
      const shift = Object.entries(tg.shift || {}).reduce((s, [k, v]) => s + (ctx.md[k] || 0) * v, 0);
      local.pOf.set(tg.topic_id, sigmoid(logit(clamp(tg.p, 0.02, 0.98)) + shift));
    }
    if (best.a.kind === 'lesson') { times.set(best.a.topic.id, (times.get(best.a.topic.id) || 0) + 1); lessons++; }
    else if (best.a.kind === 'pair') { times.set(`p:${best.a.topic.id}`, 1); pairs++; }
    else {
      uwLeft -= PLAN.uworld_block; blocks++;
      // A block moves the system's topics a little (mean effects), so the next one is worth a little less.
      for (const t of topics) { const p = local.pOf.get(t.id) ?? pCorrect(state, t); local.pOf.set(t.id, sigmoid(logit(clamp(p, 0.02, 0.98)) + PLAN.uworld_block / Math.max(1, topics.length) * ((1 - p) * ctx.md.miss + p * ctx.md.right) * 0.5)); }
    }
  }
  return { system, coef: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Number(v.toPrecision(4))])), lessons, pairs, blocks };
}
/** Every system's two-week plan and its points over the draws (median, 10-90%), best first; plus the draws for comparisons. */
export function whatIf(state, fc, opts = {}) {
  const ew = examWeight(state);
  const { draws, lesson } = effectDraws(state, fc, opts);
  const ctx = { ew, md: meanDraw(fc, lesson), names: opts.names || {} };
  const plans = Object.keys(BLUEPRINT).map(s => {
    const p = whatIfPlan(state, fc, s, ctx);
    const v = draws.map(d => valueOf(p.coef, d)).sort((a, b) => a - b);
    return { ...p, name: ctx.names[s] || s, median: r1(quantile(v, 0.5)), p10: r1(quantile(v, 0.1)), p90: r1(quantile(v, 0.9)) };
  }).sort((a, b) => b.median - a.median);
  return { plans, draws: draws.map(d => [d.k, d.lesson, d.pair, d.miss, d.right, d.card].map(x => Number(x.toPrecision(3)))) };
}
/** A against B over the same draws: {a, b, diff (median, p10, p90), p_a_beats_b, close}. draws: [[k, lesson, pair, miss, right, card]]. */
export function compareWhatIf(a, b, draws) {
  const v = c => d => d[0] * (d[1] * c.lesson + d[2] * c.pair + d[3] * c.miss + d[4] * c.right + d[5] * c.card);
  const da = draws.map(v(a.coef)), db = draws.map(v(b.coef));
  const diff = da.map((x, i) => x - db[i]).sort((x, y) => x - y);
  const pa = da.filter((x, i) => x > db[i]).length / draws.length;
  const med = quantile(diff, 0.5);
  return { a: a.system, b: b.system, diff: { median: r1(med), p10: r1(quantile(diff, 0.1)), p90: r1(quantile(diff, 0.9)) }, p_a_beats_b: r3(pa),
    close: Math.abs(med) < PLAN.whatif_close_points || Math.max(pa, 1 - pa) < PLAN.whatif_close_p };
}
/** "Two weeks on Renal against Endocrine: about +4 against +1 (Renal ahead in 80% of runs)." or the plain "too close to call". */
export function whatIfLine(a, b, cmp) {
  if (!a || !b || !cmp) return '';
  const head = `Two weeks on ${a.name} against ${b.name}: about +${a.median} against +${b.median}`;
  return cmp.close ? `${head}. Too close to call: choose by what you prefer.` : `${head} (${cmp.p_a_beats_b >= 0.5 ? a.name : b.name} ahead in ${Math.round(100 * Math.max(cmp.p_a_beats_b, 1 - cmp.p_a_beats_b))}% of runs).`;
}

// ------------------------------------------------------------------ the validation loop (spec 4)
/**
 * Lift calibration for one action kind: observed lift (mean answer after, minus the chance without the action) regressed
 * on predicted lift (with minus without), through the origin. records: [{pred, obs, n}]. Validated when n >= 30 linked
 * outcomes, the slope's 80% CI excludes 0 and the slope is within 0.5-2.
 */
export function liftCalibration(records = []) {
  const rs = records.filter(r => num(r.pred) != null && num(r.obs) != null && Math.abs(r.pred) > 1e-6);
  const n = rs.reduce((s, r) => s + (Number(r.n) || 1), 0);
  if (rs.length < 2) return { n, slope: null, lo: null, hi: null, validated: false };
  let sxx = 0, sxy = 0;
  for (const r of rs) { const w = Number(r.n) || 1; sxx += w * r.pred * r.pred; sxy += w * r.pred * r.obs; }
  const slope = sxy / sxx;
  let sse = 0;
  for (const r of rs) { const w = Number(r.n) || 1; sse += w * (r.obs - slope * r.pred) ** 2; }
  const se = Math.sqrt(sse / Math.max(1, n - 1) / sxx);
  const lo = slope - VALIDATE.z80 * se, hi = slope + VALIDATE.z80 * se;
  return { n, slope: r3(slope), lo: r3(lo), hi: r3(hi), validated: n >= VALIDATE.n && lo > 0 && slope >= VALIDATE.slope_min && slope <= VALIDATE.slope_max };
}
