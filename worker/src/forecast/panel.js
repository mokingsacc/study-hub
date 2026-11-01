import { json, readJson, londonDay, londonDayStart } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import { summaryOf } from '../map/events.js';
import { PLAN } from './constants.js';
import { examWeight, causeMix, recallGap, forecastScore, Phi } from './model.js';
import { planDay, followOrder, feedbackEffects, tickOff, stepStatus, knowItUntil, SKIP_REASONS, REASON_KEYS, DAY_PLAN } from './plan-day.js';
import { orderKey } from './teach-factor.js';

const DAY_MS = 86_400_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? (typeof s === 'string' ? JSON.parse(s) : s) : d; } catch { return d; } };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shortDay = day => { const d = new Date(`${day}T12:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const longDay = day => { const d = new Date(`${day}T12:00:00Z`); return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const TARGET_RANGE = Object.freeze([200, 300]);
// The system a step's chance and share are read from (a cluster's own systems are its members').
const share = x => (x < 0.01 ? `${(100 * x).toFixed(1)}%` : `${Math.round(100 * x)}%`);
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CAUSE_WORDS = { misunderstanding: 'misunderstandings', confusion: 'mix-ups with a look-alike', faded: 'facts that faded', slip: 'slips' };

// ------------------------------------------------------------------ why this option (pure)
export function whyLine(step, state, ew = examWeight(state)) {
  const byId = new Map((state.topics || []).map(t => [t.id, t]));
  const t = step.topic_id ? byId.get(step.topic_id) : null;
  const misses = x => Object.values((x && x.causes) || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  if (step.kind === 'pair' && t) {
    const u = step.partner_id ? byId.get(step.partner_id) : null;
    const mixed = (Number(t.causes && t.causes.confusion) || 0) + (Number(u && u.causes && u.causes.confusion) || 0);
    const w = (ew.topic.get(t.id) || 0) + (u ? ew.topic.get(u.id) || 0 : 0);
    return mixed ? `You mixed these up ${times(mixed)} in the last four months; together about ${share(w)} of the exam.`
      : `They are look-alikes on your map; together about ${share(w)} of the exam.`;
  }
  if ((step.kind === 'lesson' || step.kind === 'cluster') && t) {
    const n = misses(t), w = ew.topic.get(t.id) || 0, p = Math.round(100 * (num(t.p) ?? 0.6));
    if (recallGap(t)) return `Your cards on this are recalled well but your questions are not, so a lesson beats more cards. About ${share(w)} of the exam.`;
    const mix = causeMix(t);
    const top = ['misunderstanding', 'confusion', 'faded'].sort((a, b) => (Number(t.causes && t.causes[b]) || 0) - (Number(t.causes && t.causes[a]) || 0))[0];
    const why = n && t.causes && Number(t.causes[top]) > 0 ? `${plural(n, 'miss', 'misses')} here in four months, mostly ${CAUSE_WORDS[top]}` : mix.misunderstanding >= 0.4 ? 'Not yet solid on your map' : 'Worth a lesson on your map';
    return `${why}; about ${share(w)} of the exam, and your chance now is about ${p}%.`;
  }
  if (step.kind === 'uworld') {
    if (!step.system) return 'Mixed systems, like the real exam, on the questions you have not done.';
    const s = ew.system[step.system] || {};
    const ps = (state.topics || []).filter(x => x.system === step.system);
    const p = ps.length ? Math.round(100 * ps.reduce((a, x) => a + (num(x.p) ?? 0.6), 0) / ps.length) : null;
    return `${step.system_name || step.system} is about ${share(s.B || 0)} of the exam${p != null ? `, and your chance there is about ${p}%` : ''}.`;
  }
  if (step.kind === 'cards') return `${plural(Number(step.n) || 0, 'card is', 'cards are')} due; reviewing them now keeps more of them for exam day.`;
  return '';
}

// ------------------------------------------------------------------ target (pure)
/** P(score >= target) from the forecast's normal distribution, and the words: On track, or Behind by about X. */
export function targetView(fc, target) {
  const t = Math.round(Number(target) || fc.target || 260);
  const sd = Math.max(1, Number(fc.sd) || 10);
  const p = 1 - Phi((t - fc.mid) / sd);
  const gap = t - fc.mid;
  const on = gap <= 0;
  const pct = Math.round(100 * p);
  return { value: t, p: Math.round(p * 1000) / 1000, on_track: on, behind: on ? 0 : gap,
    word: on ? 'On track' : `Behind by about ${gap}`,
    line: on ? `On track for ${t}: about a ${pct}% chance of ${t} or more.` : `Behind by about ${gap} for ${t}: about a ${pct}% chance of ${t} or more.` };
}

// ------------------------------------------------------------------ what moved my forecast (pure)
/** A system's name in a word or two for a spoken line: "Renal, Urinary and Electrolytes" reads "Renal". */
export const shortName = n => String(n || '').split(/,| and /)[0].trim() || String(n || '');
export function whatMoved(then, fc, state, { names = {}, forms = null } = {}) {
  if (!then || num(then.mid) == null || !fc || fc.mid == null) return null;
  const change = Math.round(fc.mid - Number(then.mid));
  const since = then.day;
  const newForms = (state.forms || []).filter(f => f.day > since);
  let formsPart = 0;
  if (newForms.length) {
    const without = forms != null ? forms : forecastScore({ ...state, forms: (state.forms || []).filter(f => f.day <= since) }).mid;
    formsPart = Math.round(fc.mid - without);
  }
  const rest = change - formsPart;
  const was = (parse(then.inputs_json, {}) || {}).systems || {};
  const moves = Object.entries(fc.by_system || {}).filter(([id]) => was[id] && num(was[id].p) != null)
    .map(([id, s]) => ({ id, name: shortName(names[id] || id), d: Number(s.B) * (Number(s.p) - Number(was[id].p)), dp: Number(s.p) - Number(was[id].p) }))
    .filter(m => Math.abs(m.dp) >= 0.01);
  const up = moves.filter(m => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 2).map(m => m.name);
  const down = moves.filter(m => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 2).map(m => m.name);
  const signed = n => (n > 0 ? `Up ${n}` : n < 0 ? `Down ${-n}` : 'No change');
  const and = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
  const lines = [`${signed(change)} since ${shortDay(since)}.`];
  if (newForms.length) lines.push(`${signed(formsPart)} from ${newForms.length === 1 ? 'your new form' : 'your new forms'}, ${and(newForms.map(f => f.label || f.name))}.`);
  if (rest) lines.push(`${signed(rest)} from your map and your trend.`);
  const parts = [];
  if (up.length) parts.push(`${and(up)} got stronger`);
  if (down.length) parts.push(`${and(down)} got weaker`);
  if (parts.length) lines.push(`On your map, ${parts.join('; ')}.`);
  return { change, since, forms: formsPart, rest, up, down, lines };
}

// ------------------------------------------------------------------ the next form (pure)
export function nextForm(advice, state) {
  if (!advice || !advice.day) return null;
  const name = advice.name || 'your next NBME';
  const line = `Take ${name} on ${longDay(advice.day)}.`;
  const why = advice.scheduled ? 'It is on your schedule.' : advice.why === 'no form yet' ? 'No form yet: one now gives the forecast its first real reading.'
    : `Forms go every ${PLAN.form_every[0]} to ${PLAN.form_every[1]} days, the last one 7 to 14 days before the exam.`;
  const narrow = advice.sd_now != null && advice.sd_after != null ? `It would narrow your level's range from plus or minus ${advice.sd_now} to about ${advice.sd_after}.` : '';
  return { name: advice.name || null, day: advice.day, line, why, narrow, exam_day: state.exam_day };
}

// ------------------------------------------------------------------ reads
/** The rows the panel needs, one batch; a missing table reads as empty. */
export async function readDay(env, user, now = Date.now()) {
  const today = londonDay(now), start = londonDayStart(now);
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const stmts = [
    q('SELECT day, minutes, low_energy, steps_json, decision_id, created_by, created_at, updated_at FROM plan_days WHERE user_id = ?1 AND day = ?2', user, today),
    q('SELECT id, at, day, option_id, kind, topic_id, partner_id, action, reason, until_day, decision_id FROM plan_feedback WHERE user_id = ?1 AND day >= ?2 ORDER BY at', user, addDays(today, -8)),
    q(`SELECT id, topic_id, pair_topic_id, kind, cluster_id, ended_at, plan_id FROM lessons WHERE user_id = ?1 AND status = 'done' AND ended_at >= ?2`, user, start),
    q(`SELECT obs_key AS key, topic_id, at FROM evidence WHERE user_id = ?1 AND held = 0 AND kind = 'question' AND slot = 0 AND obs_key NOT LIKE 'hub:%' AND at >= ?2 ORDER BY at LIMIT 2000`, user, start),
    q(`SELECT count(*) AS n FROM evidence WHERE user_id = ?1 AND held = 0 AND kind = 'card_review' AND at >= ?2`, user, start),
    q('SELECT day, mid, inputs_json FROM score_forecasts WHERE user_id = ?1 AND day <= ?2 ORDER BY day DESC LIMIT 1', user, addDays(today, -7)),
  ];
  const one = s => s.all().then(r => r.results || [], e => { if (!noTable(e)) throw e; return null; });
  let rows;
  try { rows = (await env.DB.batch(stmts)).map(r => r.results || []); } catch (e) {
    if (!noTable(e)) throw e;
    rows = await Promise.all(stmts.map(one));
  }
  const [plan, feedback, lessons, uworld, cards, then] = rows;
  return { today, start, ready: plan != null && feedback != null, plan: (plan || [])[0] || null, feedback: feedback || [], lessons: lessons || [], uworld: uworld || [],
    cards: Number(((cards || [])[0] || {}).n) || 0, then: (then || [])[0] || null };
}

export function decisionOf(log = [], now = Date.now()) {
  const home = log.filter(r => (r.source || 'home') !== 'teach').sort((a, b) => Number(b.at) - Number(a.at))[0];
  return home && now - Number(home.at) < PLAN.log_every_ms ? home.id : `d${now}`;
}

/** The Anki Voice page (the origin of the connector link, never its token), or null. */
export function ankiVoiceOrigin(env) {
  for (const v of [env && env.ANKI_VOICE_URL, env && env.ANKI_MCP_URL]) {
    if (!v) continue;
    try { const u = new URL(String(v)); if (u.protocol === 'https:' || u.hostname === 'localhost') return u.origin; } catch { /* not a link */ }
  }
  return null;
}

/** The steps for a fresh plan (pure over computeForecast's result): planDay plus a why line on each. */
export function freshSteps(r, { minutes, low_energy, fb, exclude = new Set() }) {
  const out = planDay(r.state, r.fc, { minutes, low_energy, hidden: fb.hidden, factor: fb.factor, exclude, first_id: r.plan && r.plan.choice ? r.plan.choice.id : null, names: r.names,
    ...(Array.isArray(r.order) ? { order: r.order } : {}) });
  const ew = examWeight(r.state);
  return { ...out, steps: out.steps.map(s => ({ ...s, why: whyLine(s, r.state, ew) })) };
}

/** The one list's next lesson or pair test on the sheet: the day plan's first still to do, else the planner's own (data.js). */
export function nextLesson(list, plan, state, ew) {
  const step = (list || []).find(s => (s.kind === 'lesson' || s.kind === 'pair') && s.status === 'todo');
  const o = step || (plan && plan.next_lesson) || null;
  if (!o) return null;
  return { id: o.id, kind: o.kind, topic_id: o.topic_id || null, ...(o.partner_id ? { partner_id: o.partner_id } : {}), name: o.name, line: o.line,
    in_plan: !!step, why: o.why || whyLine(o, state, ew) };
}

/** A stored plan's steps kept as they are when it is planned again: the ones done or skipped today. */
function keptSteps(steps, statuses) {
  const st = new Map(statuses.map(s => [s.id, s.status]));
  return steps.filter(s => st.get(s.id) === 'done' || st.get(s.id) === 'skipped');
}

/** Statuses for a list of steps on a day (pure over readDay's rows). */
export function statusesOf(steps, day, systemOf) {
  const ticks = tickOff(steps, { lessons: day.lessons, uworld: day.uworld, cards: day.cards, since: day.start }, systemOf);
  return stepStatus(steps, ticks, day.feedback, day.today);
}

export async function panelFor(env, user, r, { now = Date.now() } = {}) {
  const day = await readDay(env, user, now);
  const { state, fc, plan, names } = r;
  const fb = feedbackEffects(day.feedback, day.today);
  const decision = decisionOf((r.raw && r.raw.log) || [], now);
  const systemOf = new Map((state.topics || []).map(t => [t.id, t.system]));
  let row = day.plan;
  let steps = row ? parse(row.steps_json, []) : null;
  if (!steps) {
    const fresh = freshSteps(r, { minutes: PLAN.hour_minutes, low_energy: fb.lowEnergy, fb });
    steps = fresh.steps;
    row = { day: day.today, minutes: PLAN.hour_minutes, low_energy: fb.lowEnergy ? 1 : 0, decision_id: decision, created_by: 'code', created_at: now };
    if (day.ready) {
      await env.DB.prepare(`INSERT INTO plan_days (user_id, day, minutes, low_energy, steps_json, decision_id, created_by, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'code', ?7, ?7) ON CONFLICT (user_id, day) DO NOTHING`).bind(user, day.today, row.minutes, row.low_energy, JSON.stringify(steps), decision, now).run()
        .catch(e => { if (!noTable(e)) console.error('day plan not stored', e && e.message); });
    }
  }
  // One list (1 Nov 2026): the stored plan's lessons and pair tests still to do follow the list as it is now, so the sheet
  // agrees with Home and teach me all day; the re-pointed steps are stored (code's bookkeeping, like the first plan).
  const ewNow = examWeight(state);
  const followed = Array.isArray(r.order) && row.steps_json ? followOrder(state, fc, steps, statusesOf(steps, day, systemOf), r.order, { names }) : steps;
  if (followed !== steps) {
    steps = followed.map(s => (s.why ? s : { ...s, why: whyLine(s, state, ewNow) }));
    if (day.ready) {
      await env.DB.prepare('UPDATE plan_days SET steps_json = ?3, updated_at = ?4 WHERE user_id = ?1 AND day = ?2').bind(user, day.today, JSON.stringify(steps), now).run()
        .catch(e => { if (!noTable(e)) console.error('day plan not followed', e && e.message); });
    }
  }
  const list = statusesOf(steps, day, systemOf);
  const left = Math.max(0, Number(row.minutes) - list.filter(s => s.status === 'done').reduce((a, s) => a + (Number(s.minutes) || 0), 0));
  const ranked = (plan && plan.ranked) || [];
  const ew = examWeight(state);
  const fOf = o => (fb.factor.has(orderKey(o.id)) ? fb.factor.get(orderKey(o.id)) : 1);
  const byValue = ranked.filter(o => !fb.hidden.has(orderKey(o.id)))
    .map(o => ({ o, v: (o.per_hour ? o.per_hour.median : 0) * fOf(o) }))
    .sort((a, b) => b.v - a.v);
  // One list: the lessons and pair tests among them in the list's order (their places kept), as on the day plan.
  const inOrder = byValue.filter(x => x.o.ord != null).sort((a, b) => a.o.ord - b.o.ord);
  let k = 0;
  const closers = byValue.map(x => (x.o.ord != null ? inOrder[k++] : x)).slice(0, 3)
    .map(({ o }) => ({ id: o.id, kind: o.kind, line: o.line, why: whyLine({ ...o, system_name: names[o.system] || o.system }, state, ew) }));
  return {
    day: day.today, decision_id: row.decision_id || decision, minutes: Number(row.minutes), low_energy: !!Number(row.low_energy), chosen: row.created_by === 'mo',
    saved: day.ready, steps: list, now: list.find(s => s.status === 'todo') || null, left_minutes: left,
    // The one list's next lesson or pair test (the same as Home and teach me): the plan's first still to do, else the planner's.
    next_lesson: nextLesson(list, plan, state, ew),
    done_n: list.filter(s => s.status === 'done').length, todo_n: list.filter(s => s.status === 'todo').length,
    target: targetView(fc, state.target), closers, closers_rough: !!(plan && plan.rough),
    moved: whatMoved(day.then, fc, state, { names }), form: nextForm(r.form, state),
    uworld: { left: Number(state.uworld && state.uworld.left) || 0, pool: (Number(state.uworld && state.uworld.left) || 0) > 50 ? ['Unused'] : (Number(state.uworld && state.uworld.left) || 0) > 0 ? ['Unused', 'Incorrect'] : ['Incorrect'],
      min_per_q: num(state.uworld && state.uworld.min_per_q) ?? PLAN.min_per_q },
    anki_voice: ankiVoiceOrigin(env), skip_reasons: SKIP_REASONS, chips: [30, 60, 120, 180],
  };
}

// ------------------------------------------------------------------ ops plan.day and plan.step (registry/plan.js)
export const WRITES = {
  plan_days: { actions: 'iu', cols: ['day', 'minutes', 'low_energy', 'steps_json', 'decision_id'] },
  plan_feedback: { actions: 'i', cols: ['at', 'day', 'option_id', 'kind', 'topic_id', 'partner_id', 'action', 'reason', 'until_day', 'decision_id'] },
};
const io = { compute: async (env, user, now) => (await import('./data.js')).computeForecast(env, user, { now }) };
export function _setIo(over) { const prev = { ...io }; Object.assign(io, over); return () => Object.assign(io, prev); }
const hoursWords = m => (m % 60 === 0 ? plural(m / 60, 'hour', 'hours') : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`);

/** The plan_days row diff: an insert for a new day, else an update with the row as it was. */
function dayRow(cur, after) {
  return cur ? { table: 'plan_days', op: 'update', key: { day: cur.day }, before: { minutes: cur.minutes, low_energy: cur.low_energy, steps_json: cur.steps_json, decision_id: cur.decision_id, created_by: cur.created_by },
    after: { ...after, created_by: 'mo' } } : { table: 'plan_days', op: 'insert', key: { day: after.day }, before: null, after };
}

async function replan(env, user, ctx, day, { minutes, low_energy, extraHidden = [] }) {
  const r = await io.compute(env, user, ctx.now);
  const fb = feedbackEffects(day.feedback, day.today);
  for (const id of extraHidden) fb.hidden.add(orderKey(id));
  const systemOf = new Map((r.state.topics || []).map(t => [t.id, t.system]));
  const old = day.plan ? parse(day.plan.steps_json, []) : [];
  const statuses = statusesOf(old, day, systemOf);
  const kept = keptSteps(old, statuses);
  const spent = statuses.filter(s => s.status === 'done').reduce((t, s) => t + (Number(s.minutes) || 0), 0);
  const budget = Math.max(0, minutes - spent);
  let fresh = [];
  if (budget >= 3) {
    // planDay fills at least 15 minutes; a shorter remainder keeps only the steps that fit it.
    let run = 0;
    fresh = freshSteps(r, { minutes: Math.max(DAY_PLAN.min_minutes, budget), low_energy, fb, exclude: new Set(kept.map(s => s.id)) }).steps
      .filter(s => (run += s.minutes) <= budget + 1e-9);
  }
  return { steps: [...kept, ...fresh], decision: (day.plan && day.plan.decision_id) || decisionOf((r.raw && r.raw.log) || [], ctx.now), r };
}

export async function planDayPlanner(env, user, args, ctx) {
  const a = args || {};
  const bad = Object.keys(a).find(k => !['minutes', 'low_energy'].includes(k));
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  const day = await readDay(env, user, ctx.now);
  if (!day.ready) return { refuse: 'The day plan needs the latest update of the hub (migration 0075).' };
  const cur = day.plan;
  const minutes = a.minutes == null ? Number(cur && cur.minutes) || PLAN.hour_minutes : Math.round(Number(a.minutes));
  if (!Number.isFinite(minutes) || minutes < DAY_PLAN.min_minutes || minutes > DAY_PLAN.max_minutes) return { refuse: `Pick between ${DAY_PLAN.min_minutes} minutes and ${DAY_PLAN.max_minutes / 60} hours.`, field: 'minutes' };
  if (a.low_energy != null && typeof a.low_energy !== 'boolean') return { refuse: 'low_energy is true or false.', field: 'low_energy' };
  const low = a.low_energy == null ? !!Number(cur && cur.low_energy) : a.low_energy;
  const { steps, decision } = await replan(env, user, ctx, day, { minutes, low_energy: low });
  const after = cur ? { minutes, low_energy: low ? 1 : 0, steps_json: JSON.stringify(steps), decision_id: decision, updated_at: ctx.now }
    : { day: day.today, minutes, low_energy: low ? 1 : 0, steps_json: JSON.stringify(steps), decision_id: decision, created_by: 'mo', created_at: ctx.now, updated_at: ctx.now };
  const what = a.low_energy != null && a.minutes == null ? (low ? 'Low energy on for today' : 'Low energy off for today') : `Today's plan: ${hoursWords(minutes)}${low ? ', low energy' : ''}`;
  const summary = summaryOf(`${what} (${plural(steps.length, 'step', 'steps')})`);
  return { rows: [dayRow(cur, after)], events: [{ target_type: 'plan_days', target_id: day.today, summary }], summary, reply: { steps: steps.length } };
}

export async function planStepPlanner(env, user, args, ctx) {
  const a = args || {};
  const bad = Object.keys(a).find(k => !['option_id', 'action', 'reason'].includes(k));
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  if (typeof a.option_id !== 'string' || !/^[a-z]+(:[\w.-]+){0,2}$/.test(a.option_id) || a.option_id.length > 160) return { refuse: 'option_id is a step of today\'s plan.', field: 'option_id' };
  if (!['done', 'skip'].includes(a.action)) return { refuse: 'action is done or skip.', field: 'action' };
  if (a.action === 'skip' && !REASON_KEYS.includes(a.reason)) return { refuse: `Say why: ${REASON_KEYS.join(', ')}.`, field: 'reason' };
  if (a.action === 'done' && a.reason != null) return { refuse: 'Done takes no reason.', field: 'reason' };
  const day = await readDay(env, user, ctx.now);
  if (!day.ready) return { refuse: 'Done and Skip need the latest update of the hub (migration 0075).' };
  const steps = day.plan ? parse(day.plan.steps_json, []) : [];
  const step = steps.find(s => s.id === a.option_id) || null;
  const kind = step ? step.kind : a.option_id.split(':')[0];
  const topic = step ? step.topic_id || null : null, partner = step ? step.partner_id || null : null;
  const fbRow = { at: ctx.now, day: day.today, option_id: a.option_id, kind, topic_id: topic, partner_id: partner, action: a.action, reason: a.action === 'skip' ? a.reason : null,
    until_day: a.reason === 'know_it' ? knowItUntil(day.today) : null, decision_id: (day.plan && day.plan.decision_id) || null, created_by: 'mo', created_at: ctx.now, updated_at: ctx.now };
  const rows = [{ table: 'plan_feedback', op: 'insert', key: { id: `pf_${rand()}` }, before: null, after: fbRow }];
  const label = step ? stepLabel(step) : a.option_id;
  const word = a.action === 'done' ? 'Done' : `Skipped (${SKIP_REASONS.find(x => x.key === a.reason).word.toLowerCase()})`;
  // Events pair with rows by index (events.js), so undo puts each row back.
  const events = [{ target_type: 'plan_feedback', target_id: a.option_id, topic_id: topic, summary: summaryOf(`${word}: ${label}`) }];
  let evidence = null;
  const touched = [];
  if (a.reason === 'know_it' && topic) {
    const ids = [topic, partner].filter(Boolean);
    const cats = await env.DB.prepare(`SELECT id, category_id FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(ids)).all().then(x => x.results || [], () => []);
    const catOf = new Map(cats.map(c => [c.id, c.category_id]));
    evidence = { upsert: ids.filter(id => catOf.has(id)).map(id => ({ obs_key: `plan:${id}:${day.today}`, slot: 0, topic_id: id, category_id: catOf.get(id) || null, kind: 'self_mastered', at: ctx.now, day: day.today,
      source: 'plan', source_ref: a.option_id, created_by: 'mo', detail_json: JSON.stringify({ label: 'already know it', from: 'plan' }) })) };
    touched.push(...evidence.upsert.map(e => e.topic_id));
    if (!evidence.upsert.length) evidence = null;
  }
  // A skip frees its minutes: the rest of the day is planned again (too tired: the gentle plan).
  if (a.action === 'skip' && day.plan) {
    const low = a.reason === 'too_tired' ? true : !!Number(day.plan.low_energy);
    const withSkip = { ...day, feedback: [...day.feedback, fbRow] };
    const { steps: next } = await replan(env, user, ctx, withSkip, { minutes: Number(day.plan.minutes), low_energy: low, extraHidden: [a.option_id] });
    if (!next.some(s => s.id === a.option_id) && step) next.unshift(step);   // the skipped step stays listed, as skipped
    rows.push(dayRow(day.plan, { minutes: Number(day.plan.minutes), low_energy: low ? 1 : 0, steps_json: JSON.stringify(next), decision_id: day.plan.decision_id, updated_at: ctx.now }));
    events.push({ target_type: 'plan_days', target_id: day.today, summary: summaryOf(a.reason === 'too_tired' ? 'The rest of today planned again, low energy' : 'The rest of today planned again') });
  }
  const summary = events[0].summary;
  return { rows, events, ...(evidence ? { evidence } : {}), touched_topics: touched, summary, reply: { option_id: a.option_id, action: a.action, reason: fbRow.reason } };
}

export const stepLabel = s => String(s.line || s.name || s.id).replace(/(?:, \d+ minutes|: about [\d.]+ points an hour).*$/, '');

export const planTier = (args, plan, ctx) => (ctx && ctx.actor === 'mo' ? 'free' : 'refused');

// ------------------------------------------------------------------ routes
async function changeThenPanel(env, user, op, args, via) {
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op, args, via });
  return changeResponse(r);
}
export async function dayRoute(request, env, ctx, params, url, user) {
  const b = await readJson(request, 2000);
  const args = {};
  if (b.minutes !== undefined) args.minutes = b.minutes;
  if (b.low_energy !== undefined) args.low_energy = b.low_energy;
  return changeThenPanel(env, user, 'plan.day', args, 'api:POST /api/forecast/day');
}
/** POST /api/forecast/step {option_id, action, reason?}: Done or Skip on a step. */
export async function stepRoute(request, env, ctx, params, url, user) {
  const b = await readJson(request, 2000);
  const args = { option_id: b.option_id, action: b.action };
  if (b.reason != null) args.reason = b.reason;
  return changeThenPanel(env, user, 'plan.step', args, 'api:POST /api/forecast/step');
}
export async function targetRoute(request, env, ctx, params, url, user) {
  const b = await readJson(request, 2000);
  const t = Math.round(Number(b.target));
  if (!Number.isFinite(t) || t < TARGET_RANGE[0] || t > TARGET_RANGE[1]) return json({ error: `A target between ${TARGET_RANGE[0]} and ${TARGET_RANGE[1]}.`, refused: true }, 400);
  return changeThenPanel(env, user, 'setting.set', { key: 'target_score', value: t }, 'api:POST /api/forecast/target');
}
