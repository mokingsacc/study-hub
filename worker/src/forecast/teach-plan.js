import { PLAN, EFFECT, MODEL_VERSION, TEACH } from './constants.js';
import { examWeight, actionCoefs, actionMinutes, lessonEffect, conversionFit, pCorrect } from './model.js';
import { readRaw, buildState, LOG_COLS } from './data.js';
import { londonDay } from '../util.js';

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const r3 = x => Math.round(x * 1000) / 1000;
const sig = x => Number(x.toPrecision(4));
const clampP = p => Math.min(0.98, Math.max(0.02, Number(p)));
const withShift = (p, s) => { const q = clampP(p); return 1 / (1 + Math.exp(-(Math.log(q / (1 - q)) + s))); };
const median = xs => { const s = xs.filter(x => x > 0).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

export const PLAN_READS = ['topics', 'tags', 'causes', 'cardTopics', 'partners', 'lessons', 'lessonAnswers', 'sittings', 'fsrs', 'settings', 'log'];

export function teachPlan(state) {
  const ew = examWeight(state);
  const cal = state.calibration || {};
  const slope = k => (cal[k] && cal[k].validated ? cal[k].slope : 1);
  const le = lessonEffect((state.lesson && state.lesson.obs) || [], EFFECT.lesson, state.fsrs_w);
  const k = conversionFit(state.forms || []).k;
  const mean = { lesson: Math.max(TEACH.lesson_floor, le.mean * slope('lesson')), pair: EFFECT.pair.mean * slope('pair') };
  const minutes = { lesson: actionMinutes(state, { kind: 'lesson' }), pair: PLAN.pair_minutes };
  const ctx = { ew, pOf: new Map() };
  const byId = new Map((state.topics || []).map(t => [t.id, t]));
  const topics = {};
  for (const t of state.topics || []) {
    if (!ew.topic.get(t.id)) continue;
    const lc = actionCoefs(state, { kind: 'lesson', topic: t }, ctx);
    const row = { l: sig(k * mean.lesson * lc.c.lesson / minutes.lesson * 60), p: r3(pCorrect(state, t)), ls: r3(lc.targets[0].shift.lesson) };
    const partner = t.partner && byId.get(t.partner);
    if (partner && ew.topic.get(partner.id)) {
      const pc = actionCoefs(state, { kind: 'pair', topic: t, partner }, ctx);
      row.pr = partner.id;
      row.v = sig(k * mean.pair * pc.c.pair / minutes.pair * 60);
      row.pt = pc.targets.map(x => [x.topic_id, r3(x.p), r3(x.shift.pair)]);
    }
    topics[t.id] = row;
  }
  return { model_version: MODEL_VERSION, at: state.now, k: Math.round(k * 10) / 10, mean: { lesson: r3(mean.lesson), pair: r3(mean.pair) }, minutes,
    validated: { lesson: !!(cal.lesson && cal.lesson.validated), pair: !!(cal.pair && cal.pair.validated) },
    unit: sig(median(Object.values(topics).map(r => r.l))), topics };
}

/** Writes the plan (one row a user, replaced). Quiet before 0073. */
export async function storeTeachPlan(env, user, plan, now = Date.now()) {
  try {
    await env.DB.prepare(`INSERT INTO score_plan_coefs (user_id, at, model_version, plan_json) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (user_id) DO UPDATE SET at = excluded.at, model_version = excluded.model_version, plan_json = excluded.plan_json`)
      .bind(user, now, MODEL_VERSION, JSON.stringify(plan)).run();
    return true;
  } catch (e) { if (noTable(e)) return false; throw e; }
}

export const PLAN_ROW_SQL = 'SELECT at, model_version, plan_json FROM score_plan_coefs WHERE user_id = ?1';

/** The stored row as a plan when it is fresh and of this model version ({...plan, source: 'stored'}), else null (pure). */
export function planFromRow(row, now = Date.now()) {
  if (!row || Number(row.model_version) !== MODEL_VERSION || !(now - Number(row.at) < TEACH.fresh_ms) || now < Number(row.at) - 60_000) return null;
  try { const plan = JSON.parse(row.plan_json); return plan && plan.topics ? { ...plan, source: 'stored' } : null; } catch { return null; }
}

export async function loadTeachPlan(env, user, { now = Date.now(), live = false, waitUntil = null, row } = {}) {
  if (row === undefined) {
    row = null;
    try { row = await env.DB.prepare(PLAN_ROW_SQL).bind(user).first(); } catch (e) { if (!noTable(e)) console.error('teach plan read failed', e && e.message); }
  }
  const stored = planFromRow(row, now);
  if (stored) return stored;
  if (!live) return null;
  try {
    const raw = await readRaw(env, user, { now, only: PLAN_READS });
    const plan = teachPlan(buildState(raw));
    if (!Object.keys(plan.topics).length) return null;
    const p = storeTeachPlan(env, user, plan, now).catch(e => console.error('teach plan not stored', e && e.message));
    if (typeof waitUntil === 'function') waitUntil(p); else await p;
    return { ...plan, source: 'live' };
  } catch (e) {
    console.error('teach plan not worked out', e && e.message);
    return null;
  }
}

/**
 * The topics a teach pick targets, each with its chance without and with it at the mean effects (the validation log's
 * targets). pick: {kind: 'lesson' | 'pair' | 'cluster', id, topic_id, partner_id?, members?: [{id, density}]}. A cluster
 * lesson moves each member by the lesson's shift x the member's density (ASSUMPTION: the share of its errors the cluster holds).
 */
export function teachTargets(plan, pick) {
  const out = [];
  const T = id => plan && plan.topics ? plan.topics[id] : null;
  const push = (topic_id, p, shift) => out.push({ id: pick.id, topic_id, p_without: r3(clampP(p)), p_with: r3(withShift(p, shift)) });
  if (pick.kind === 'pair') {
    const row = T(pick.topic_id);
    for (const [tid, p, s] of (row && row.pr === pick.partner_id && row.pt) || []) push(tid, p, plan.mean.pair * s);
    if (!out.length) for (const id of [pick.topic_id, pick.partner_id]) { const r = T(id); if (r) push(id, r.p, 0); }
  } else if (pick.kind === 'cluster') {
    for (const m of pick.members || []) { const r = T(m.id); if (r) push(m.id, r.p, plan.mean.lesson * r.ls * Math.min(1, Math.max(0, Number(m.density) || 0))); }
  } else {
    const r = T(pick.topic_id);
    if (r) push(pick.topic_id, r.p, plan.mean.lesson * r.ls);
  }
  return out;
}

/** The decision log row for a teach pick (pure): source teach, not randomised (rule thompson, no propensity). */
export function teachLogRow(user, now, plan, pick, ranked = []) {
  const targets = teachTargets(plan, pick);
  if (!targets.length) return null;
  const cands = ranked.slice(0, 10).map(r => {
    const f = r.plan || {};
    const pair = f.action === 'pair' && f.partner;
    const row = plan.topics[r.topic_id] || {};
    return { id: pair ? `pair:${r.topic_id}:${f.partner}` : `lesson:${r.topic_id}`, kind: pair ? 'pair' : 'lesson', median: (pair ? row.v : row.l) ?? null, score: r3(Number(r.score) || 0) };
  });
  return { user_id: user, id: `t${now}`, at: now, day: londonDay(now), chosen_id: pick.id, chosen_kind: pick.kind === 'pair' ? 'pair' : 'lesson', rule: 'thompson', propensity: null,
    other_id: null, candidates_json: JSON.stringify(cands), targets_json: JSON.stringify(targets), model_version: MODEL_VERSION, source: 'teach', lesson_id: pick.lesson_id || null };
}

/** Writes a teach pick to score_plan_log; quiet before the tables exist. */
export async function logTeachPick(env, user, now, plan, pick, ranked) {
  const row = teachLogRow(user, now, plan, pick, ranked);
  if (!row) return null;
  try {
    await env.DB.prepare(`INSERT INTO score_plan_log (${LOG_COLS.join(', ')}) VALUES (${LOG_COLS.map((_, i) => `?${i + 1}`).join(', ')}) ON CONFLICT (user_id, id) DO NOTHING`)
      .bind(...LOG_COLS.map(c => row[c] ?? null)).run();
    return row;
  } catch (e) { if (noTable(e)) return null; throw e; }
}
