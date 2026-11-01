
import { ENERGY, KNOW_IT } from './constants.js';

/** An option id with a pair test's two topics sorted, so 'pair:b:a' and 'pair:a:b' are the same option. */
export function orderKey(id) {
  const s = String(id || '');
  if (!s.startsWith('pair:')) return s;
  const [, a, b] = s.split(':');
  return `pair:${[a, b].sort().join(':')}`;
}

export function feedbackEffects(rows = [], today) {
  const hidden = new Set(), factor = new Map(), done = new Set();
  let lowEnergy = false;
  for (const r of rows || []) {
    const id = orderKey(r.option_id);
    if (r.action === 'done' && r.day === today) { done.add(id); continue; }
    if (r.action !== 'skip') continue;
    if (r.reason === 'know_it' && r.until_day && r.until_day >= today) factor.set(id, KNOW_IT.factor);
    if (r.day !== today) continue;
    if (r.reason === 'too_tired') lowEnergy = true;
    hidden.add(id);
  }
  return { hidden, factor, done, lowEnergy };
}

const NEUTRAL = Object.freeze({ lesson: 1, pair: null, best: 1, action: 'lesson', partner: null, planned: false });

export function planFactor(plan, id, { pairOff = false, fb = null } = {}) {
  const row = plan && plan.topics ? plan.topics[id] : null;
  const unit = plan && Number(plan.unit) > 0 ? Number(plan.unit) : 0;
  if (!row || !unit || !(Number(row.l) > 0)) return NEUTRAL;
  const adj = (v, key, kind) => {
    if (v == null || !fb) return v;
    if ((fb.hidden && fb.hidden.has(key)) || (fb.done && fb.done.has(key))) return null;   // hidden, or marked done today
    const f = fb.factor && fb.factor.has(key) ? fb.factor.get(key) : 1;
    return v * f / (fb.lowEnergy ? ENERGY[kind] ?? 1 : 1);
  };
  const lesson = adj(Number(row.l) / unit, `lesson:${id}`, 'lesson');
  const pairKey = row.pr ? orderKey(`pair:${id}:${row.pr}`) : null;
  const pair = adj(!pairOff && row.pr && Number(row.v) > 0 ? Number(row.v) / unit : null, pairKey, 'pair');
  if (lesson == null && pair == null) return { ...NEUTRAL, best: 0, planned: true, hidden: true };
  const isPair = pair != null && (lesson == null || pair > lesson);
  return { lesson: lesson ?? 0, pair, best: isPair ? pair : lesson, action: isPair ? 'pair' : 'lesson', partner: isPair ? row.pr : null, planned: true };
}

/** A lesson's factor alone (cluster members: a cluster lesson is a lesson on each). */
export const lessonFactor = (plan, id) => planFactor(plan, id, { pairOff: true }).lesson;

export const PLAN_LINE_VALIDATED = 'Worth about the most exam points per minute right now.';
export const PLAN_LINE_ROUGH = 'Ranked by the planner, still rough.';
/** The line for why_chosen: the strong claim only once the action kind's numbers are validated (30+ outcomes, slope). */
export const planLine = validated => (validated ? PLAN_LINE_VALIDATED : PLAN_LINE_ROUGH);

/** "Lane A: 3 misses in 60 days. Ranked by the planner, still rough." The reasons are trimmed first; never over max. */
export function withPlanLine(why, line, max = 200) {
  const base = String(why || '').trim();
  if (!line) return base.length > max ? `${base.slice(0, max - 1).replace(/[ ,;:]+\S*$/, '')}…` : base;
  if (!base) return line;
  const room = max - line.length - 1;
  const head = base.length <= room ? base : `${base.slice(0, Math.max(0, room - 1)).replace(/[ ,;:]+\S*$/, '')}…`;
  return `${head} ${line}`;
}
