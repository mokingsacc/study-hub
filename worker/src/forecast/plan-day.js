import { examWeight, effectDraws, candidates, rankCandidates, optionLine, actionCoefs, lessonish, firstInOrder } from './model.js';
import { orderKey } from './teach-factor.js';
import { EFFECT, ENERGY, KNOW_IT } from './constants.js';

const DAY_MS = 86_400_000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ENERGY and KNOW_IT live in constants.js and feedbackEffects in teach-factor.js (the one list of what to do next reads
// them without the planner); they are exported from here as before.
export { ENERGY, KNOW_IT } from './constants.js';
export { feedbackEffects } from './teach-factor.js';
export const DAY_PLAN = Object.freeze({ min_minutes: 15, max_minutes: 600, big_block_minutes: 180, big_block: 40, uworld_share: 0.5, system_share: 0.4,
  cards_share: 0.8, cards_min: 10, max_steps: 12 });
export const SKIP_REASONS = Object.freeze([
  { key: 'too_tired', word: 'Too tired' }, { key: 'know_it', word: 'Already know it' }, { key: 'not_now', word: 'Not now' }, { key: 'disagree', word: 'Disagree' },
]);
export const REASON_KEYS = SKIP_REASONS.map(r => r.key);

/** The low-energy effort multiplier for a kind (1 when energy is fine). */
export const effortOf = (kind, low) => (low ? ENERGY[kind] ?? 1 : 1);

/** The mean effects (as model.js planNextHour uses for its greedy). */
const meanDraw = (fc, le) => ({ k: fc.k, lesson: le.mean, pair: EFFECT.pair.mean, miss: EFFECT.miss.mean, right: EFFECT.right.mean, card: EFFECT.card.mean });

/** A candidate as a step (what the page and the prompts need; no draws, no coefficients). */
function stepOf(o, calibration, names) {
  const s = { id: o.id, kind: o.kind, name: o.name, minutes: Math.round(o.minutes), line: optionLine(o, calibration || {}) };
  if (o.topic) { s.topic_id = o.topic.id; s.topic_name = o.topic.name; }
  if (o.partner) { s.partner_id = o.partner.id; s.partner_name = o.partner.name; }
  if (o.cluster_id) s.cluster_id = o.cluster_id;
  if (o.system) { s.system = o.system; s.system_name = names[o.system] || o.system; }
  if (o.n) s.n = o.n;
  if (o.kind === 'cards') s.n = o.n || (o.cards || []).length;
  return s;
}

/**
 * The day's plan (pure): the steps that fill `minutes`, in order. The first step is the planner's own pick for the hour
 * (opts.first_id) when it fits and is not hidden, so the top of the sheet and the decision log agree; then greedy by mean
 * value per effort-minute, the chosen topics' chances moved (mean effects) and every option re-ranked, until nothing fits.
 * opts: {minutes, low_energy, hidden: Set, factor: Map id -> multiplier, exclude: Set (done already), first_id, names,
 * draws (count, default 200), order (the one list: a lesson or pair test picked is always its first left)}. Each step: {id, kind, name, minutes, line, topic_id?, partner_id?, system?, n?}.
 */
export function planDay(state, fc, opts = {}) {
  const minutes = clamp(Math.round(Number(opts.minutes) || 60), DAY_PLAN.min_minutes, DAY_PLAN.max_minutes);
  const low = !!opts.low_energy, hidden = opts.hidden || new Set(), factor = opts.factor || new Map(), exclude = opts.exclude || new Set();
  const names = opts.names || {};
  const ew = examWeight(state);
  const { draws, lesson } = effectDraws(state, fc, { draws: opts.draws || 200 });
  const md = meanDraw(fc, lesson);
  const ordered = Array.isArray(opts.order);
  const ctx = { ew, md, names, pOf: new Map(), ...(ordered ? { order: opts.order } : {}) };
  const bigBlock = !low && minutes >= DAY_PLAN.big_block_minutes;
  const used = new Set([...exclude, ...[...exclude].map(orderKey)]);
  const steps = [];
  let left = minutes;
  const fOf = c => (factor.has(c.id) ? factor.get(c.id) : factor.has(orderKey(c.id)) ? factor.get(orderKey(c.id)) : 1);
  const score = c => c.mean * fOf(c) / effortOf(c.kind, low);
  for (let guard = 0; guard < 40 && steps.length < DAY_PLAN.max_steps; guard++) {
    let cands = candidates(state, fc, ctx).filter(c => !used.has(c.id) && !hidden.has(c.id) && !hidden.has(orderKey(c.id)) && c.mean > 0);
    if (bigBlock) cands = cands.map(c => (c.kind === 'uworld' ? { ...c, ...actionCoefs(state, { kind: 'uworld', system: c.system, n: DAY_PLAN.big_block }, ctx), n: DAY_PLAN.big_block } : c));
    // One list: only the list's next lesson or pair test can be placed, and only when it fits; never one further down.
    if (ordered) { const nextL = firstInOrder(cands); cands = cands.filter(c => !lessonish(c) || c === nextL); }
    cands = cands.filter(c => c.minutes <= left + 1e-9);
    if (!cands.length) break;
    const first = !steps.length && opts.first_id && !low ? cands.find(c => c.id === opts.first_id) : null;
    const pick = first || cands.reduce((b, c) => (score(c) > score(b) ? c : b));
    const ranked = rankCandidates([pick], draws)[0];
    steps.push(stepOf({ ...pick, per_hour: ranked.per_hour }, state.calibration, names));
    used.add(pick.id);
    left -= pick.minutes;
    for (const tg of pick.targets || []) {
      const shift = Object.entries(tg.shift || {}).reduce((s, [k, v]) => s + (md[k] || 0) * v, 0);
      ctx.pOf.set(tg.topic_id, sigmoid(logit(clamp(tg.p, 0.02, 0.98)) + shift));
    }
  }
  return { minutes, low_energy: low, steps, left: Math.max(0, Math.round(left)) };
}

/**
 * A stored day plan following the one list (pure). Its lesson and pair-test steps still to do are filled, in their places,
 * with the list's items left after the steps done or skipped, so the sheet's lessons are always the list's even when the
 * plan was made hours ago. Other steps stay. Returns the same array when nothing changed. order: as planDay's.
 */
export function followOrder(state, fc, steps = [], statuses = [], order = null, { names = {}, draws = 200 } = {}) {
  if (!Array.isArray(order) || !steps.length) return steps;
  const st = new Map(statuses.map(s => [s.id, s.status]));
  const fixed = new Set(steps.filter(s => st.get(s.id) !== 'todo').map(s => orderKey(s.id)));
  const ew = examWeight(state);
  const { draws: D, lesson } = effectDraws(state, fc, { draws });
  const ctx = { ew, md: meanDraw(fc, lesson), names, pOf: new Map(), order };
  const queue = candidates(state, fc, ctx).filter(c => lessonish(c) && c.ord != null && !fixed.has(orderKey(c.id))).sort((a, b) => a.ord - b.ord);
  let changed = false;
  const out = [];
  for (const s of steps) {
    if (!lessonish(s) || st.get(s.id) !== 'todo') { out.push(s); continue; }
    const c = queue.shift();
    if (!c) { changed = true; continue; }
    if (orderKey(c.id) === orderKey(s.id)) { out.push(s); continue; }
    changed = true;
    out.push(stepOf({ ...c, per_hour: rankCandidates([c], D)[0].per_hour }, state.calibration, names));
  }
  return changed ? out : steps;
}

export function tickOff(steps = [], activity = {}, systemOf = new Map()) {
  const since = Number(activity.since) || 0, done = new Set();
  const lessons = (activity.lessons || []).filter(l => Number(l.ended_at) >= since);
  for (const s of steps) {
    if (s.kind === 'lesson' && lessons.some(l => l.topic_id === s.topic_id && l.kind !== 'pair_test')) done.add(s.id);
    if (s.kind === 'pair') {
      const ids = new Set([s.topic_id, s.partner_id].filter(Boolean));
      if (lessons.some(l => (l.kind === 'pair_test' || l.kind === 'pair') && (ids.has(l.topic_id) || ids.has(l.pair_topic_id)))) done.add(s.id);
    }
    if (s.kind === 'cluster' && s.cluster_id && lessons.some(l => l.cluster_id === s.cluster_id)) done.add(s.id);
  }
  const seen = new Set(), answers = [];
  for (const a of activity.uworld || []) { if (Number(a.at) < since) continue; const k = a.key || `${a.at}:${a.topic_id}`; if (!seen.has(k)) { seen.add(k); answers.push(a); } }
  let pool = answers;
  for (const s of steps.filter(x => x.kind === 'uworld' && x.system)) {
    const need = Math.ceil((s.n || 20) * DAY_PLAN.uworld_share);
    const mine = pool.filter(a => systemOf.get(a.topic_id) === s.system);
    if (mine.length >= Math.ceil(need * DAY_PLAN.system_share) && pool.length >= need) {
      done.add(s.id);
      const take = new Set(mine.slice(0, need));
      let more = need - take.size;
      pool = pool.filter(a => { if (take.has(a)) return false; if (more > 0) { more--; return false; } return true; });
    }
  }
  for (const s of steps.filter(x => x.kind === 'uworld' && !x.system)) {
    const need = Math.ceil((s.n || 20) * DAY_PLAN.uworld_share);
    if (pool.length >= need) { done.add(s.id); pool = pool.slice(need); }
  }
  for (const s of steps.filter(x => x.kind === 'cards')) {
    const n = Number(s.n) || 0;
    const need = n <= DAY_PLAN.cards_min ? n : Math.max(DAY_PLAN.cards_min, Math.ceil(n * DAY_PLAN.cards_share));
    if (need > 0 && (Number(activity.cards) || 0) >= need) done.add(s.id);
  }
  return done;
}

export function stepStatus(steps = [], ticks = new Set(), feedback = [], today = null) {
  const mine = new Map();
  for (const r of feedback) if (!today || r.day === today) mine.set(r.option_id, r);
  return steps.map(s => {
    const f = mine.get(s.id);
    if (ticks.has(s.id)) return { ...s, status: 'done', by: 'auto' };
    if (f && f.action === 'done') return { ...s, status: 'done', by: 'mo' };
    if (f && f.action === 'skip') return { ...s, status: 'skipped', reason: f.reason || null };
    return { ...s, status: 'todo' };
  });
}

/** The day a know-it skip stops lowering its option. */
export const knowItUntil = today => addDays(today, KNOW_IT.days);
