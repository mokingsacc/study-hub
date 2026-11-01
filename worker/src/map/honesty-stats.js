import { BANDS } from '../../../public/js/map/scale.js';

export const DAY_MS = 86400000;
export const WINDOW_DAYS = 28;
// Below these the numbers are noise: a band's right rate from 30 answers, slope and AUC from 150 with 30 of each.
export const MIN = { band: 30, slope: 150, each: 30, guess: 30 };
export const BOOT = { B: 400, seed: 20261031 };
export const P_CLIP = [0.01, 0.99];
export const K0_B2 = 3;
export const VERDICTS = ['honest', 'too gloomy', 'too rosy', 'not enough answers yet'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pc = x => Math.round(100 * x);

// What each band promises for the next question, from the colour scale (mastery = 0.85 − 0.55·t1000/1000).
const mOfT = t => Math.round((0.85 - 0.55 * t / 1000) * 100) / 100;
export const BAND_RANGES = Object.fromEntries(BANDS.map((b, i) => [b.code, {
  word: b.word, lo: i === BANDS.length - 1 ? 0 : mOfT(b.to + 1), hi: i === 0 ? 1 : mOfT(b.from),
}]));
export const BAND_ORDER = [...BANDS.map(b => b.code), 'unseen'];

export const clipP = p => clamp(Number(p), P_CLIP[0], P_CLIP[1]);
export const logLoss = (p, y) => { const q = clipP(p); return -(y ? Math.log(q) : Math.log(1 - q)); };
export const brier = (p, y) => (Number(p) - y) ** 2;

/** Wilson score interval for k of n (95%). */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const ph = k / n, z2 = z * z, den = 1 + z2 / n;
  const mid = (ph + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(ph * (1 - ph) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** A small seeded random source (mulberry32), so the bootstrap gives the same interval every night on the same data. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap by day: items [{day, d}] where d is one answer's difference (model − baseline). Days are resampled
 * whole, because answers on one day share a mood and a block. Returns {mean, lo, hi} (95%), or null under 2 days.
 */
export function bootstrapByDay(items, { B = BOOT.B, seed = BOOT.seed } = {}) {
  const days = new Map();
  for (const it of items || []) {
    const g = days.get(it.day) || { s: 0, n: 0 };
    g.s += it.d; g.n += 1;
    days.set(it.day, g);
  }
  const list = [...days.values()];
  if (list.length < 2) return null;
  const total = list.reduce((a, g) => ({ s: a.s + g.s, n: a.n + g.n }), { s: 0, n: 0 });
  const rnd = seeded(seed), means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < list.length; i++) { const g = list[Math.floor(rnd() * list.length)]; s += g.s; n += g.n; }
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return { mean: total.s / total.n, lo: means[Math.floor(0.025 * B)], hi: means[Math.min(B - 1, Math.ceil(0.975 * B) - 1)] };
}

/** B0 for rows in time order: the running right rate of the answers before each one, (rights + 1) / (answers + 2). */
export function runningBaseRate(rows) {
  let k = 0, n = 0;
  return rows.map(r => { const b = (k + 1) / (n + 2); k += r.y ? 1 : 0; n += 1; return b; });
}

const logit = p => { const q = clipP(p); return Math.log(q / (1 - q)); };
const sigm = x => 1 / (1 + Math.exp(-x));

export function calibrationFit(ps, ys) {
  const x = ps.map(logit), n = x.length;
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const m = sigm(a + b * x[i]), w = m * (1 - m), e = ys[i] - m;
      g0 += e; g1 += e * x[i]; h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  let c = 0;
  for (let it = 0; it < 50; it++) {
    let g = 0, h = 0;
    for (let i = 0; i < n; i++) { const m = sigm(c + x[i]); g += ys[i] - m; h += m * (1 - m); }
    if (!(h > 1e-12)) break;
    const dc = g / h;
    c += dc;
    if (Math.abs(dc) < 1e-9) break;
  }
  return { intercept: r4(c), slope: r4(b) };
}

/** AUC (Mann-Whitney, ties count half): the chance a right answer had a higher p than a wrong one. */
export function auc(ps, ys) {
  const idx = ps.map((p, i) => i).sort((i, j) => ps[i] - ps[j]);
  let rankSum = 0, pos = 0, i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && ps[idx[j + 1]] === ps[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (ys[idx[k]]) { rankSum += rank; pos++; }
    i = j + 1;
  }
  const neg = idx.length - pos;
  if (!pos || !neg) return null;
  return r4((rankSum - pos * (pos + 1) / 2) / (pos * neg));
}

/** One band's (or the unseen group's) verdict: does its right rate's interval meet what the band promises? */
export function bandVerdict(n, k, range, meanP) {
  if (n < MIN.band) return 'too few';
  const [lo, hi] = wilson(k, n);
  const want = range ? [range.lo, range.hi] : [meanP, meanP];
  if (lo > want[1]) return 'too gloomy';
  if (hi < want[0]) return 'too rosy';
  return 'honest';
}

/** Reliability per band: n, right rate, its Wilson interval, the band's range, the mean p, and the verdict. */
export function reliability(rows) {
  const by = new Map();
  for (const r of rows) {
    const b = BAND_RANGES[r.band] ? r.band : 'unseen';
    const g = by.get(b) || { n: 0, k: 0, sp: 0 };
    g.n++; g.k += r.y ? 1 : 0; g.sp += Number(r.p);
    by.set(b, g);
  }
  return BAND_ORDER.filter(b => by.has(b)).map(b => {
    const g = by.get(b), range = BAND_RANGES[b] || null, ci = wilson(g.k, g.n);
    return { band: b, word: range ? range.word : 'Not seen yet', range: range ? [range.lo, range.hi] : null, n: g.n, right: g.k,
      rate: r4(g.k / g.n), ci: [r4(ci[0]), r4(ci[1])], mean_p: r4(g.sp / g.n), verdict: bandVerdict(g.n, g.k, range, g.sp / g.n) };
  });
}

const BASELINES = {
  B0: { label: 'flat guess (running right rate)', p: r => r.b0 },
  B1: { label: 'category prior', p: r => r.m0 },
  B2: { label: 'prior + his record on the topic', p: r => (K0_B2 * r.m0 + (Number(r.prior_right_n) || 0)) / (K0_B2 + (Number(r.prior_real_n) || 0)) },
};

/**
 * The metrics of one set of forecasts [{day, p, y, band, m0, prior_real_n, prior_right_n, b0}]. withBands: the
 * reliability rows too (left off the next/first splits to keep the reply small).
 */
export function metrics(rows, { withBands = true } = {}) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const k = rows.reduce((a, r) => a + (r.y ? 1 : 0), 0);
  const ll = rows.map(r => logLoss(r.p, r.y)), br = rows.map(r => brier(r.p, r.y));
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const out = { n, base_rate: r4(k / n), mean_p: r4(mean(rows.map(r => Number(r.p)))), log_loss: r4(mean(ll)), brier: r4(mean(br)), baselines: {} };
  for (const [name, b] of Object.entries(BASELINES)) {
    const bp = rows.map(b.p);
    if (bp.some(p => p == null || !Number.isFinite(Number(p)))) continue;
    const bl = rows.map((r, i) => logLoss(bp[i], r.y));
    const boot = bootstrapByDay(rows.map((r, i) => ({ day: r.day, d: ll[i] - bl[i] })));
    out.baselines[name] = { label: b.label, log_loss: r4(mean(bl)), brier: r4(mean(rows.map((r, i) => brier(bp[i], r.y)))),
      diff: boot ? { mean: r4(boot.mean), lo: r4(boot.lo), hi: r4(boot.hi) } : null };
  }
  const d0 = out.baselines.B0 && out.baselines.B0.diff;
  out.beats_guessing = n < MIN.guess || !d0 ? 'too few' : d0.hi < 0 ? 'yes' : d0.lo > 0 ? 'no' : 'not sure yet';
  if (withBands) out.reliability = reliability(rows);
  const enough = n >= MIN.slope && k >= MIN.each && n - k >= MIN.each;
  if (enough) {
    const ps = rows.map(r => Number(r.p)), ys = rows.map(r => (r.y ? 1 : 0));
    out.calibration = calibrationFit(ps, ys);
    out.auc = auc(ps, ys);
  } else out.calibration = out.auc = null;
  return out;
}

/** The overall verdict from the bands with enough answers: honest, too gloomy, too rosy or not enough answers yet. */
export function verdictOf(m) {
  const bands = ((m && m.reliability) || []).filter(b => b.verdict !== 'too few');
  if (!bands.length) return VERDICTS[3];
  const gloomy = bands.filter(b => b.verdict === 'too gloomy').length, rosy = bands.filter(b => b.verdict === 'too rosy').length;
  if (!gloomy && !rosy) return 'honest';
  if (gloomy && !rosy) return 'too gloomy';
  if (rosy && !gloomy) return 'too rosy';
  return m.base_rate > m.mean_p ? 'too gloomy' : 'too rosy';   // both ways: the overall lean decides
}

const isNext = r => (Number(r.prior_real_n) || 0) > 0;
function stratum(rows, { full = true } = {}) {
  const next = rows.filter(isNext), first = rows.filter(r => !isNext(r));
  return { all: metrics(rows), next: metrics(next, { withBands: full }), first: metrics(first, { withBands: full }) };
}

/**
 * The full report from stored forecasts [{stratum, at, day, p, y, band, m0, prior_real_n, prior_right_n, model_id}]
 * (retracted ones already left out). B0 runs over all time in each stratum before the windows are cut.
 */
export function report(rows, { now = Date.now() } = {}) {
  const list = (rows || []).filter(r => r && Number.isFinite(Number(r.p)) && (r.y === 0 || r.y === 1 || r.y === '0' || r.y === '1'))
    .map(r => ({ ...r, p: Number(r.p), y: Number(r.y), m0: Number(r.m0), at: Number(r.at) }))
    .sort((a, b) => a.at - b.at);
  const by = { question: list.filter(r => r.stratum !== 'card'), card: list.filter(r => r.stratum === 'card') };
  for (const s of Object.values(by)) runningBaseRate(s).forEach((b, i) => { s[i].b0 = b; });
  const since = now - WINDOW_DAYS * DAY_MS;
  const win = rows2 => rows2.filter(r => r.at >= since);
  const windows = {
    '28d': { questions: stratum(win(by.question), { full: false }), cards: { all: metrics(win(by.card)) } },
    all_time: { questions: stratum(by.question, { full: false }), cards: { all: metrics(by.card) } },
  };
  const models = [...new Set(list.map(r => r.model_id).filter(Boolean))];
  const out = { as_of: new Date(now).toISOString(), window_days: WINDOW_DAYS, minimums: MIN, models, windows, facets: facetComparison(list) };
  out.line = honestyLine(out);
  out.verdict = out.line.verdict;
  return out;
}

const rangeWords = b => (b.range ? (b.range[1] >= 1 ? `${pc(b.range[0])}% or more` : b.range[0] <= 0 ? `under ${pc(b.range[1])}%` : `${pc(b.range[0])}-${pc(b.range[1])}%`)
  : `about ${pc(b.mean_p)}%`);

/**
 * The one line: "Map honesty, 28 days, 412 answers: honest. Weak topics 46% right (expected 41-52%); better than a flat
 * guess: yes". 28 days when a band there has enough answers, else all time. The band named is the one most off when the
 * verdict is not honest, else the band with the most answers. Returns {text, verdict, window, n}.
 */
export function honestyLine(rep) {
  const pick = key => {
    const q = rep && rep.windows && rep.windows[key] && rep.windows[key].questions;
    return q && q.all && q.all.n ? { key, q } : null;
  };
  const w = [pick('28d'), pick('all_time')].find(x => x && verdictOf(x.q.all) !== VERDICTS[3]) || pick('28d') || pick('all_time');
  if (!w) return { text: 'Map honesty: no answers to check yet.', verdict: VERDICTS[3], window: null, n: 0 };
  const m = w.q.all, label = w.key === '28d' ? `${WINDOW_DAYS} days` : 'all time';
  const verdict = verdictOf(m);
  const head = `Map honesty, ${label}, ${m.n} answer${m.n === 1 ? '' : 's'}: ${verdict}`;
  if (verdict === VERDICTS[3]) return { text: `${head} (a band needs ${MIN.band}).`, verdict, window: w.key, n: m.n };
  const ok = m.reliability.filter(b => b.verdict !== 'too few');
  const off = ok.filter(b => b.verdict === verdict);
  const band = (off.length ? off : ok).slice().sort((a, b) => b.n - a.n)[0];
  const next = w.q.next && w.q.next.n ? w.q.next : m;
  const guess = { yes: 'yes', no: 'no', 'not sure yet': 'not sure yet', 'too few': 'not sure yet' }[next.beats_guessing] || 'not sure yet';
  const who = band.band === 'unseen' ? 'New topics' : `${band.word} topics`;
  return { text: `${head}. ${who} ${pc(band.rate)}% right (expected ${rangeWords(band)}); better than a flat guess: ${guess}`, verdict, window: w.key, n: m.n };
}

// ------------------------------------------------------------------ the Diagnose / Manage split (wave 3)
// Forecasts whose answer had one facet carry the facet model's p too (p_facet, from answers before it). Does the split
// predict better than the topic's overall p on those same answers? Held out by construction (prequential); if not, the
// report says so.
export const MIN_FACET = 60;
export function facetComparison(rows) {
  const list = (rows || []).filter(r => (r.facet === 'diagnose' || r.facet === 'manage') && r.p_facet != null && Number.isFinite(Number(r.p_facet)));
  const n = list.length;
  const by = f => list.filter(r => r.facet === f).length;
  if (n < MIN_FACET) {
    return { n, diagnose: by('diagnose'), manage: by('manage'), verdict: 'not enough answers yet',
      text: `Diagnose / Manage split: ${n} tagged answer${n === 1 ? '' : 's'} so far, ${MIN_FACET} needed before it is tested.` };
  }
  const d = list.map(r => ({ day: r.day, d: logLoss(Number(r.p_facet), r.y) - logLoss(r.p, r.y) }));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const boot = bootstrapByDay(d);
  const verdict = !boot ? 'not sure yet' : boot.hi < 0 ? 'better' : boot.lo > 0 ? 'worse' : 'no better';
  const words = { better: 'predicts better than the overall colour', worse: 'predicts worse than the overall colour, so trust the overall colour',
    'no better': 'does not beat the overall colour yet', 'not sure yet': 'not sure yet (too few days)' }[verdict];
  return { n, diagnose: by('diagnose'), manage: by('manage'), log_loss: r4(mean(list.map(r => logLoss(r.p, r.y)))),
    log_loss_facet: r4(mean(list.map(r => logLoss(Number(r.p_facet), r.y)))), diff: boot ? { mean: r4(boot.mean), lo: r4(boot.lo), hi: r4(boot.hi) } : null,
    verdict, text: `Diagnose / Manage split, ${n} answers: ${words}.` };
}

export const SELF = { high: 8, min_each: 5, cold_ms: DAY_MS, rating_min: 5 };
const RATE_LEVEL = { again: 'guess', hard: 'lean', good: 'sure', easy: 'sure' };
const RATE_WORD = { guess: 'Guess', lean: 'Lean', sure: 'Sure' };
const RATE_FACET = { recognise: 'diagnose', distinguish: 'diagnose', test: 'diagnose', treat: 'manage', trap: 'manage' };
export function ratingCalibration(ratings, answers) {
  const byTopic = new Map();
  for (const a of answers || []) { if (!byTopic.has(a.topic_id)) byTopic.set(a.topic_id, []); byTopic.get(a.topic_id).push(a); }
  for (const l of byTopic.values()) l.sort((a, b) => Number(a.at) - Number(b.at));
  const g = { guess: { n: 0, k: 0 }, lean: { n: 0, k: 0 }, sure: { n: 0, k: 0 } };
  for (const r of ratings || []) {
    const level = RATE_LEVEL[String(r.rating || '').toLowerCase()];
    let d = {};
    try { d = JSON.parse(r.detail_json || '{}') || {}; } catch { d = {}; }
    const facet = RATE_FACET[d.step] || null;
    if (!level || !facet) continue;
    const next = (byTopic.get(r.topic_id) || []).find(a => Number(a.at) > Number(r.at) && (a.facet == null || a.facet === facet));
    if (!next) continue;
    g[level].n++; g[level].k += Number(next.y) ? 1 : 0;
  }
  const rate = x => (x.n ? r4(x.k / x.n) : null);
  const n = g.guess.n + g.lean.n + g.sure.n;
  const enough = n >= SELF.rating_min;
  const bits = ['sure', 'lean', 'guess'].filter(k => g[k].n).map(k => `${RATE_WORD[k]} ${pc(g[k].k / g[k].n)}% (${g[k].n})`);
  const text = enough ? `Your self-ratings, then right on your next answer on that part: ${bits.join(', ')}.`
    : `Your self-ratings: ${n} followed by an answer on that part so far, ${SELF.rating_min} needed.`;
  return { guess: { n: g.guess.n, rate: rate(g.guess) }, lean: { n: g.lean.n, rate: rate(g.lean) }, sure: { n: g.sure.n, rate: rate(g.sure) }, n, enough, text };
}

export function selfCalibration(lessons, answers, ratings = null) {
  const byTopic = new Map();
  for (const a of answers || []) { if (!byTopic.has(a.topic_id)) byTopic.set(a.topic_id, []); byTopic.get(a.topic_id).push(a); }
  for (const l of byTopic.values()) l.sort((a, b) => Number(a.at) - Number(b.at));
  const g = { high: { n: 0, k: 0 }, low: { n: 0, k: 0 } };
  for (const l of lessons || []) {
    const r = Number(l.mo_rating), end = Number(l.ended_at);
    if (!(r >= 1 && r <= 10) || !Number.isFinite(end)) continue;
    const next = (byTopic.get(l.topic_id) || []).find(a => Number(a.at) >= end + SELF.cold_ms);
    if (!next) continue;
    const k = r >= SELF.high ? 'high' : 'low';
    g[k].n++; g[k].k += Number(next.y) ? 1 : 0;
  }
  const rate = x => (x.n ? r4(x.k / x.n) : null);
  const enough = g.high.n >= SELF.min_each && g.low.n >= SELF.min_each;
  const text = enough
    ? `Your lesson ratings: rated ${SELF.high}+ then ${pc(g.high.k / g.high.n)}% right on the next cold answer (${g.high.n}), under ${SELF.high} then ${pc(g.low.k / g.low.n)}% (${g.low.n}).`
    : `Your lesson ratings: ${g.high.n + g.low.n} followed by a cold answer so far, ${SELF.min_each} each side needed.`;
  const out = { high: { n: g.high.n, rate: rate(g.high) }, low: { n: g.low.n, rate: rate(g.low) }, enough, text };
  if (ratings) { out.ratings = ratingCalibration(ratings, answers); out.text = `${text} ${out.ratings.text}`; }
  return out;
}

export function gateLiftLine(topics, answers) {
  const by = k => {
    const l = (answers || []).filter(a => a && a.gate_lift === k);
    const right = l.filter(a => Number(a.y) === 1).length;
    return { n: l.length, right, rate: l.length ? r4(right / l.length) : null };
  };
  const blue = by('blue'), deep = by('deep');
  const n = Math.max(0, Number(topics) || 0);
  const text = `Blue without a real question: ${n} topic${n === 1 ? '' : 's'}, right on ${blue.right} of ${blue.n} later question${blue.n === 1 ? '' : 's'}.`;
  return { topics: n, blue, deep, text };
}
