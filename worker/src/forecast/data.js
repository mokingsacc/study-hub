import { json, londonDay } from '../util.js';
import { defaultSettings, PUBLIC_SETTINGS } from '../db.js';
import { examDayOf } from '../exam-day.js';
import { noteJob } from '../job-log.js';
import { legacySystem, SYSTEMS_V2, S } from '../map/systems.js';
import { examKind } from '../../../public/js/hub/predict-input.js';
import { PLAN, MODEL_VERSION, LESSON_WINDOW, FSRS6_DEFAULT, MEASURE } from './constants.js';
import {
  forecastScore, planNextHour, whatIf, compareWhatIf, whatIfLine, checkForms, checkSummary, checkLine, summaryLine, weekChange, forecastLine,
  formAdvice, formKey, liftCalibration, rng, measureTargets,
} from './model.js';

const DAY_MS = 86_400_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const median = xs => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const FORM_TYPES = { nbme: 'nbme', uwsa: 'uwsa', free120: 'free120' };
const DUE = "d.suspended = 0 AND d.buried = 0 AND d.ctype IN ('review', 'relearning', 'learning') AND d.due_day IS NOT NULL AND d.due_day <= ?2";

/** Runs statements as one batch; with a missing table each runs alone and a failing one gives []. */
async function batchSoft(env, stmts) {
  try { return (await env.DB.batch(stmts)).map(r => r.results || []); } catch (e) {
    if (!noTable(e)) throw e;
    return Promise.all(stmts.map(s => s.all().then(r => r.results || [], err => { if (!noTable(err)) throw err; return []; })));
  }
}

// ------------------------------------------------------------------ the reads
/** The raw rows (one D1 batch). only: a list of the names below to read (the rest come back empty), for teach-plan.js. */
export async function readRaw(env, user, { now = Date.now(), only = null } = {}) {
  const today = londonDay(now);
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const names = ['topics', 'tags', 'causes', 'cardTopics', 'partners', 'lessons', 'lessonAnswers', 'sittings', 'due', 'cardTimes', 'blocks', 'fsrs', 'settings',
    'history', 'checks', 'log', 'cats'];
  const all = [
    q(`SELECT t.id, t.name, t.category_id AS system, s.seen, s.weakness_raw, s.right_n, s.questions_n, cp.prior FROM topics t
        LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
        LEFT JOIN category_priors cp ON cp.user_id = t.user_id AND cp.category_id = t.category_id
       WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed')`, user),
    q(`SELECT topic_id, sum(CASE WHEN obs_key LIKE 'hub:%' THEN 1 ELSE 0 END) AS nb, sum(CASE WHEN obs_key LIKE 'hub:%' THEN 0 ELSE 1 END) AS uw
       FROM evidence WHERE user_id = ?1 AND held = 0 AND kind = 'question' AND topic_id IS NOT NULL GROUP BY topic_id`, user),
    q(`SELECT topic_id, cause, error_type, count(*) AS n FROM misses WHERE user_id = ?1 AND held = 0 AND deleted_at IS NULL AND topic_id IS NOT NULL AND at >= ?2
       GROUP BY topic_id, cause, error_type`, user, now - 120 * DAY_MS),
    q(`SELECT ct.topic_id, count(*) AS n, avg(d.r) AS r, sum(CASE WHEN c.lapses > 0 THEN 1 ELSE 0 END) AS lapsed FROM card_topics ct
        LEFT JOIN card_due d ON d.user_id = ct.user_id AND d.card_id = ct.card_id AND d.suspended = 0
        LEFT JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
       WHERE ct.user_id = ?1 AND ct.removed_at IS NULL GROUP BY ct.topic_id`, user),
    q(`SELECT from_id, to_id, confusion, confused_n FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active', 'proposed') AND (confusion > 0 OR confused_n > 0)`, user),
    q(`SELECT id, topic_id, kind, day, started_at, ended_at, minutes FROM lessons WHERE user_id = ?1 AND status = 'done' AND topic_id IS NOT NULL AND ended_at >= ?2`, user, now - 90 * DAY_MS),
    q(`SELECT f.topic_id, f.at, f.y, f.p FROM forecasts f WHERE f.user_id = ?1 AND f.stratum = 'question' AND f.retracted = 0 AND f.at >= ?2
        AND f.topic_id IN (SELECT topic_id FROM lessons WHERE user_id = ?1 AND status = 'done' AND ended_at >= ?3)`, user, now - 120 * DAY_MS, now - 90 * DAY_MS),
    q(`SELECT s.id, s.name, s.kind, s.exam_type, s.timing, s.external_label, s.scheduled_date, s.finished_at, s.created_at, s.score_pct, s.official_score, s.status,
        (SELECT sum(b.correct) FROM blocks b WHERE b.sitting_id = s.id AND b.ended_at IS NOT NULL) AS correct,
        (SELECT sum(b.scored) FROM blocks b WHERE b.sitting_id = s.id AND b.ended_at IS NOT NULL) AS scored FROM sittings s`),
    q(`SELECT d.card_id, d.r, d.ivl, (SELECT ct.topic_id FROM card_topics ct WHERE ct.user_id = d.user_id AND ct.card_id = d.card_id AND ct.removed_at IS NULL
        ORDER BY ct.strong DESC LIMIT 1) AS topic_id FROM card_due d WHERE d.user_id = ?1 AND ${DUE} ORDER BY d.due_day LIMIT 400`, user, today),
    q(`SELECT time_s FROM evidence WHERE user_id = ?1 AND kind = 'card_review' AND time_s > 0 AND time_s < 600 AND at >= ?2 ORDER BY at DESC LIMIT 500`, user, now - 30 * DAY_MS),
    q(`SELECT minutes, count FROM uworld_blocks WHERE minutes > 0 AND count > 0 AND day >= ?1`, addDays(today, -42)),
    q(`SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = 'anki.fsrs'`, user),
    q(`SELECT key, value FROM settings WHERE key IN (${PUBLIC_SETTINGS.map((_, i) => `?${i + 1}`).join(', ')})`, ...PUBLIC_SETTINGS),
    q(`SELECT day, at, mid, low, high, low50, high50, sd, p_target, level, trend, state_json, inflation, pct, n_forms, rough, top_json FROM score_forecasts WHERE user_id = ?1 ORDER BY day`, user),
    q(`SELECT * FROM score_forecast_checks WHERE user_id = ?1 ORDER BY form_day`, user),
    q(`SELECT id, at, chosen_id, chosen_kind, rule, other_id, source, lesson_id, targets_json, outcome_json, evaluated_at FROM score_plan_log WHERE user_id = ?1 AND at >= ?2 ORDER BY at`,
      user, now - 60 * DAY_MS),
    q(`SELECT id, name, short_name FROM categories WHERE user_id = ?1`, user),
  ];
  const want = only ? names.filter(n => only.includes(n)) : names;
  const rows = await batchSoft(env, want.map(n => all[names.indexOf(n)]));
  const raw = { now, today };
  names.forEach(n => { raw[n] = rows[want.indexOf(n)] || []; });
  return raw;
}

export function formsOf(sittings = []) {
  const out = [];
  for (const s of sittings) {
    const label = [s.name, s.external_label].filter(Boolean).join(' · ');
    const kind = FORM_TYPES[s.exam_type] || (s.exam_type ? null : FORM_TYPES[examKind(label, s.kind)]);
    if (!kind || s.status !== 'done') continue;
    const pct = num(s.score_pct) != null ? Number(s.score_pct) / 100 : num(s.scored) ? Number(s.correct) / Number(s.scored) : null;
    const score = num(s.official_score);
    if (pct == null && score == null) continue;
    const day = s.finished_at ? londonDay(s.finished_at) : s.scheduled_date || londonDay(s.created_at);
    // No finish time (an exam sat outside the hub): it counts from the start of its day, so only a forecast from an
    // earlier day is ever checked against it.
    const at = Number(s.finished_at) || Date.parse(`${day}T00:00:00Z`) - 3_600_000;
    out.push({ sitting_id: s.id, name: s.name, label, kind, day, at, pct, score, timing: s.timing || 'strict' });
  }
  out.sort((a, b) => a.at - b.at);
  const seen = new Set();
  for (const f of out) { const k = formKey(f) || f.label; f.repeat = seen.has(k); seen.add(k); }
  return out;
}

export function nextFormOf(sittings = [], today) {
  return sittings.filter(s => s.status !== 'done' && s.scheduled_date && s.scheduled_date >= today)
    .filter(s => FORM_TYPES[s.exam_type] || (!s.exam_type && FORM_TYPES[examKind([s.name, s.external_label].filter(Boolean).join(' '), s.kind)]))
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date)).map(s => ({ day: s.scheduled_date, name: s.name }))[0] || null;
}

/** Study minutes in the what-if's two weeks: days that are not off weekdays or rest days, at study_minutes_per_day. */
export function whatifMinutes(settings, today) {
  const off = new Set((settings.off_weekdays || []).map(Number)), rest = new Set(settings.rest_days || []);
  let days = 0;
  for (let i = 0; i < PLAN.whatif_days; i++) {
    const d = addDays(today, i);
    if (settings.exam_date && d >= settings.exam_date && settings.exam_date >= today) break;   // a passed exam stops nothing
    if (!off.has(new Date(`${d}T12:00:00Z`).getUTCDay()) && !rest.has(d)) days++;
  }
  return days * PLAN.study_minutes_per_day;
}

export function causeClass(cause, errorType, knewBefore) {
  const c = cause || null, e = errorType || null;
  if (c === 'confusion') return 'confusion';
  if (c === 'misread' || e === 'misread' || e === 'test_taking' || e === 'calculation') return 'slip';
  if (c === 'missing_fact' || (!c && (e === 'knowledge_gap' || e === 'threshold'))) return knewBefore || e === 'threshold' ? 'faded' : 'misunderstanding';
  if (c === 'reasoning' || c === 'ignored_clue' || c === 'guess' || e === 'premature_closure' || e === 'faulty_synthesis') return 'misunderstanding';
  return null;
}

/**
 * The lesson effect's observations (spec 3.3c): each answer on a lesson's topic 2-21 days after it, against the map's chance
 * on that topic just before the lesson (the newest per-answer forecast before it; the topic's starting guess when none).
 */
export function lessonObs(lessons = [], answers = [], priorOf = () => 0.6) {
  const byTopic = new Map();
  for (const a of answers) { if (!byTopic.has(a.topic_id)) byTopic.set(a.topic_id, []); byTopic.get(a.topic_id).push({ at: Number(a.at), y: Number(a.y), p: num(a.p) }); }
  for (const list of byTopic.values()) list.sort((x, y) => x.at - y.at);
  const out = [];
  for (const l of lessons) {
    const list = byTopic.get(l.topic_id) || [], start = Number(l.started_at) || Number(l.ended_at), end = Number(l.ended_at);
    if (!end) continue;
    const before = list.filter(a => a.at < start && a.p != null).pop();
    const p_pre = before ? before.p : priorOf(l.topic_id);
    for (const a of list) {
      const days = (a.at - end) / DAY_MS;
      if (days >= LESSON_WINDOW.from_days && days <= LESSON_WINDOW.to_days) out.push({ p_pre, y: a.y, days, lesson_id: l.id });
    }
  }
  return out;
}

/**
 * The decision log's linked outcomes as calibration per action kind (spec 4), with the coin flips' difference-in-
 * differences beside it ({n, obs, pred}: mean chosen-minus-other lift, observed and predicted). The rule to show a number
 * stays liftCalibration's (30 or more linked outcomes and a validated slope).
 */
export function calibrationOf(log = []) {
  const by = {}, did = {};
  for (const r of log) {
    const o = parse(r.outcome_json, null);
    if (!o || !o.done || !(o.n > 0)) continue;
    (by[r.chosen_kind] = by[r.chosen_kind] || []).push({ pred: o.pred, obs: o.obs, n: o.n });
    if (o.did && num(o.did.obs) != null && num(o.did.pred) != null) (did[r.chosen_kind] = did[r.chosen_kind] || []).push(o.did);
  }
  const mean = (xs, k) => Math.round(xs.reduce((a, x) => a + Number(x[k]), 0) / xs.length * 1000) / 1000;
  return Object.fromEntries(Object.entries(by).map(([k, recs]) => [k, { ...liftCalibration(recs),
    ...(did[k] ? { did: { n: did[k].length, obs: mean(did[k], 'obs'), pred: mean(did[k], 'pred') } } : {}) }]));
}

/** Home's own decisions (a teach pick is logged with source teach, 0073). */
const homeLog = log => log.filter(r => (r.source || 'home') !== 'teach');

const upcomingExam = (stored, today) => { const d = examDayOf(stored); return d && d >= today ? d : null; };

/** The raw rows as model.js's state (pure). */
export function buildState(raw) {
  const { now, today } = raw;
  const settings = defaultSettings(today);
  for (const r of raw.settings || []) { const v = parse(r.value, r.value); if (v != null) settings[r.key] = v; }
  const recent = addDays(today, -PLAN.lesson_recent_days);
  const lessonDay = new Map();
  for (const l of raw.lessons || []) if (l.day && l.day >= recent && (!lessonDay.has(l.topic_id) || l.day > lessonDay.get(l.topic_id))) lessonDay.set(l.topic_id, l.day);
  const tags = new Map((raw.tags || []).map(r => [r.topic_id, r]));
  const cards = new Map((raw.cardTopics || []).map(r => [r.topic_id, r]));
  const partner = new Map();
  for (const l of raw.partners || []) {
    const s = Number(l.confusion) + 0.01 * Number(l.confused_n || 0);
    for (const [a, b] of [[l.from_id, l.to_id], [l.to_id, l.from_id]]) if (!partner.has(a) || partner.get(a)[1] < s) partner.set(a, [b, s]);
  }
  const prior = new Map();
  const topics = (raw.topics || []).map(t => {
    const sys = legacySystem(t.system) || t.system;
    const p = num(t.weakness_raw) != null ? 1 - Number(t.weakness_raw) : num(t.prior) ?? 0.6;
    prior.set(t.id, num(t.prior) ?? 0.6);
    const tg = tags.get(t.id), cd = cards.get(t.id);
    return { id: t.id, name: t.name, system: sys, p, seen: Number(t.seen) ? 1 : 0, n_nbme: tg ? Number(tg.nb) || 0 : 0, n_uw: tg ? Number(tg.uw) || 0 : 0,
      q_right: Number(t.right_n) || 0, q_n: Number(t.questions_n) || 0, card_n: cd ? Number(cd.n) || 0 : 0, card_r: cd ? num(cd.r) : null, card_lapsed: cd ? Number(cd.lapsed) || 0 : 0,
      partner: partner.has(t.id) ? partner.get(t.id)[0] : null, lesson_day: lessonDay.get(t.id) || null, causes: {} };
  });
  const byId = new Map(topics.map(t => [t.id, t]));
  for (const m of raw.causes || []) {
    const t = byId.get(m.topic_id);
    if (!t) continue;
    const cls = causeClass(m.cause, m.error_type, t.q_right > 0 || t.card_lapsed > 0);
    if (cls) t.causes[cls] = (t.causes[cls] || 0) + Number(m.n);
  }
  const forms = formsOf(raw.sittings || []);
  const mins = (raw.blocks || []).map(b => Number(b.minutes) / Number(b.count)).filter(x => x > 0.2 && x < 6);
  const fsrs = parse(raw.fsrs && raw.fsrs[0] && raw.fsrs[0].cursor, {});
  const lessonMinutes = median((raw.lessons || []).map(l => Number(l.minutes)).filter(x => x > 0));
  const log = raw.log || [];
  return {
    // The exam_date setting; none set, or a date that has passed, forecasts today (model.js: no weeks to propagate).
    now, today, exam_day: upcomingExam(settings.exam_date, today), target: Number(settings.target_score) || 260,
    topics, forms, checks: (raw.checks || []).map(c => ({ z: num(c.z) })),
    lesson: { minutes: lessonMinutes, obs: lessonObs(raw.lessons || [], raw.lessonAnswers || [], id => prior.get(id) ?? 0.6) },
    cards: { sec: median((raw.cardTimes || []).map(r => Number(r.time_s))), due: (raw.due || []).filter(d => d.topic_id).map(d => ({ card_id: d.card_id, topic_id: d.topic_id, r: num(d.r) ?? 0.9, s: Math.max(1, Number(d.ivl) || 1) })),
      due_n: (raw.due || []).length, per_topic: Object.fromEntries((raw.cardTopics || []).map(r => [r.topic_id, Number(r.n) || 0])) },
    uworld: { min_per_q: median(mins), left: Number(settings.uworld_total_left) || 0 },
    fsrs_w: Array.isArray(fsrs.w) && fsrs.w.length >= 19 ? fsrs.w : FSRS6_DEFAULT,
    schedule: { next_form: nextFormOf(raw.sittings || [], today), last_form_day: forms.length ? forms[forms.length - 1].day : null },
    whatif_minutes: whatifMinutes(settings, today),
    // Coin flips are a share of Home's decisions only (a teach pick is never randomised).
    calibration: calibrationOf(log), randomised_share: homeLog(log).length ? homeLog(log).filter(r => r.rule === 'coin').length / homeLog(log).length : 0,
  };
}

/** System id -> its plain name (categories), for the lines. */
const namesOf = cats => ({ ...Object.fromEntries(SYSTEMS_V2.map((row, i) => [Object.values(S)[i], row[0]])),
  ...Object.fromEntries((cats || []).filter(c => legacySystem(c.id) === c.id).map(c => [c.id, c.name])) });
/** The decision's random numbers: fixed within an hour, so opening Home twice shows the same plan. */
export function decisionDraws(now) {
  const u = rng((Math.floor(now / 3_600_000) * 2654435761) >>> 0);
  return { pick: u(), coin: u() };
}

export async function loadOrder(env, user, now = Date.now()) {
  try {
    const tp = await import('../map/teach-priority.js');
    const { data, items } = await tp.nextUpFor(env, user, { now, limit: PLAN.max_lessons + PLAN.max_pairs });
    return data && data.ok ? tp.orderOf(items) : null;
  } catch (e) {
    if (!noTable(e)) console.error('one list not read', e && e.message);
    return null;
  }
}

/** Everything the page and the job need, worked out now. order: the one list (loadOrder; read here when not given). */
export async function computeForecast(env, user, { now = Date.now(), raw = null, order } = {}) {
  raw = raw || await readRaw(env, user, { now });
  if (order === undefined) order = await loadOrder(env, user, now);
  const state = buildState(raw);
  const names = namesOf(raw.cats);
  const fc = forecastScore(state);
  const plan = planNextHour(state, fc, { names, ...decisionDraws(now), randomised_share: state.randomised_share, ...(order ? { order } : {}) });
  const wi = whatIf(state, fc, { names });
  const cmp = wi.plans.length > 1 ? compareWhatIf(wi.plans[0], wi.plans[1], wi.draws) : null;
  const history = (raw.history || []).map(r => ({ day: r.day, at: Number(r.at), mid: num(r.mid), low: num(r.low), high: num(r.high), pct: num(r.pct), rough: Number(r.rough) ? 1 : 0 }));
  const checks = raw.checks || [];
  const summary = checkSummary(checks);
  const change = weekChange(history, state.today, fc.mid);
  return { raw, state, fc, plan, order, whatif: wi, compare: cmp, names, history, checks, summary, change, line: forecastLine(fc, change),
    what_if_line: cmp ? whatIfLine(wi.plans[0], wi.plans[1], cmp) : '', form: formAdvice(state, fc) };
}

// ------------------------------------------------------------------ the record, the check, the outcomes
/** Today's row (pure). */
export function forecastRow(user, day, at, fc, plan) {
  const inputs = { systems: Object.fromEntries(Object.entries(fc.by_system).map(([k, s]) => [k, { B: s.B, p: s.p }])), readings: fc.readings, k: fc.k, inflation: fc.inflation };
  const top = (plan.hour || []).map(o => ({ id: o.id, kind: o.kind, line: o.line, minutes: Math.round(o.minutes) }));
  return { user_id: user, day, at, mid: fc.mid, low: fc.low, high: fc.high, low50: fc.low50, high50: fc.high50, sd: fc.sd, p_target: fc.p_target, level: fc.level, trend: fc.trend,
    state_json: JSON.stringify(fc.snapshot), inflation: fc.inflation.s2, pct: fc.pct, n_forms: fc.n_forms, rough: fc.rough ? 1 : 0, model_version: MODEL_VERSION,
    top_json: JSON.stringify(top), inputs_json: JSON.stringify(inputs) };
}
export const ROW_COLS = ['user_id', 'day', 'at', 'mid', 'low', 'high', 'low50', 'high50', 'sd', 'p_target', 'level', 'trend', 'state_json', 'inflation', 'pct', 'n_forms', 'rough',
  'model_version', 'top_json', 'inputs_json'];
const CHECK_COLS = ['user_id', 'sitting_id', 'label', 'form_day', 'forecast_day', 'forecast_mid', 'pred_mean', 'pred_sd', 'kind', 'actual', 'error', 'z', 'pit', 'hit50', 'hit80', 'crps',
  'actual_pct', 'score', 'created_at', 'updated_at'];

export const kindOfId = id => { const k = String(id || '').split(':')[0]; return k === 'cluster' ? 'lesson' : k; };

export function doneFor(r, kind, actionId, targets, { lessons = [], activity = [], systemOf = new Map() } = {}) {
  const at = Number(r.at), inDay = x => Number(x) >= at && Number(x) <= at + DAY_MS;
  if (kind === 'lesson' || kind === 'pair') {
    if (r.lesson_id && actionId === r.chosen_id && lessons.some(l => l.id === r.lesson_id && inDay(l.ended_at))) return true;
    const tids = new Set(targets.map(t => t.topic_id));
    return lessons.some(l => tids.has(l.topic_id) && inDay(l.ended_at) && (kind === 'pair' ? l.kind === 'pair_test' || l.kind === 'pair' : true));
  }
  const distinct = list => new Set(list.map(a => a.obs_key || `${a.at}:${a.topic_id}`)).size;
  if (kind === 'uworld') {
    const qs = activity.filter(a => a.kind === 'uworld' && !Number(a.slot) && inDay(a.at));
    if (distinct(qs) < MEASURE.uworld_min) return false;
    const sys = String(actionId).slice('uworld:'.length);
    if (!sys || sys === 'random') return true;
    return qs.filter(a => systemOf.get(a.topic_id) === sys).length >= MEASURE.system_share * qs.length;
  }
  if (kind === 'cards') return distinct(activity.filter(a => a.kind === 'card' && inDay(a.at))) >= MEASURE.cards_min;
  return false;
}

function liftOf(targets, answers, at) {
  let n = 0, sumY = 0, sumP0 = 0, sumLift = 0;
  const byTopic = new Map();
  for (const t of targets) if (!byTopic.has(t.topic_id)) byTopic.set(t.topic_id, t);
  for (const a of answers) {
    const t = byTopic.get(a.topic_id);
    const days = (Number(a.at) - Number(at)) / DAY_MS;
    if (!t || days < LESSON_WINDOW.from_days || days > LESSON_WINDOW.to_days) continue;
    n++; sumY += Number(a.y); sumP0 += Number(t.p_without); sumLift += Number(t.p_with) - Number(t.p_without);
  }
  const r3 = x => Math.round(x * 1000) / 1000;
  return n ? { n, obs: r3((sumY - sumP0) / n), pred: r3(sumLift / n) } : { n: 0 };
}

export function outcomesFor(log = [], lessons = [], answers = [], now = Date.now(), extra = {}) {
  const out = [];
  const ctx = { lessons, activity: extra.activity || [], systemOf: extra.systemOf || new Map() };
  for (const r of log) {
    if (r.evaluated_at != null || Number(r.at) > now - LESSON_WINDOW.to_days * DAY_MS) continue;
    const all = parse(r.targets_json, []);
    let targets = all.filter(t => t.id === r.chosen_id);
    const kind = r.chosen_kind;
    if (!['lesson', 'pair', 'uworld', 'cards'].includes(kind) || !targets.length) { out.push({ id: r.id, outcome: { done: null, reason: 'not measured for this kind' } }); continue; }
    if (!doneFor(r, kind, r.chosen_id, targets, ctx)) { out.push({ id: r.id, outcome: { done: false } }); continue; }
    if (kind === 'cards') {
      const at = Number(r.at);
      const seen = new Set(ctx.activity.filter(a => a.kind === 'card' && Number(a.at) >= at && Number(a.at) <= at + DAY_MS && a.topic_id).map(a => a.topic_id));
      targets = targets.filter(t => seen.has(t.topic_id));
    }
    const o = liftOf(targets, answers, r.at);
    const outcome = o.n ? { done: true, n: o.n, obs: o.obs, pred: o.pred } : { done: true, n: 0 };
    if (r.rule === 'coin' && r.other_id) {
      const mine = new Set(targets.map(t => t.topic_id));
      const other = all.filter(t => t.id === r.other_id && !mine.has(t.topic_id));
      if (!other.length) outcome.did = { reason: 'the other option had no topics of its own' };
      else if (doneFor(r, kindOfId(r.other_id), r.other_id, other, ctx)) outcome.did = { reason: 'both were done' };
      else {
        const b = liftOf(other, answers, r.at);
        outcome.did = o.n && b.n ? { obs: Math.round((o.obs - b.obs) * 1000) / 1000, pred: o.pred, n_other: b.n } : { n_other: b.n, reason: 'too few answers' };
      }
    }
    out.push({ id: r.id, outcome });
  }
  return out;
}

export async function outcomeReads(env, user, log = [], now = Date.now()) {
  const due = log.filter(r => r.evaluated_at == null && Number(r.at) <= now - LESSON_WINDOW.to_days * DAY_MS);
  if (!due.length) return null;
  const topics = new Set();
  for (const r of due) for (const t of parse(r.targets_json, [])) if (t && t.topic_id) topics.add(t.topic_id);
  const from = Math.min(...due.map(r => Number(r.at))), to = Math.max(...due.map(r => Number(r.at)));
  const [answers, activity] = await batchSoft(env, [
    env.DB.prepare(`SELECT topic_id, at, y FROM forecasts WHERE user_id = ?1 AND stratum = 'question' AND retracted = 0 AND at >= ?2 AND at <= ?3
        AND topic_id IN (SELECT value FROM json_each(?4)) ORDER BY at LIMIT 20000`).bind(user, from, to + LESSON_WINDOW.to_days * DAY_MS, JSON.stringify([...topics])),
    env.DB.prepare(`SELECT at, topic_id, obs_key, slot, CASE WHEN kind = 'card_review' THEN 'card' ELSE 'uworld' END AS kind FROM evidence
       WHERE user_id = ?1 AND held = 0 AND at >= ?2 AND at <= ?3 AND (kind = 'card_review' OR (kind = 'question' AND obs_key NOT LIKE 'hub:%'))
       ORDER BY at LIMIT 20000`).bind(user, from, to + DAY_MS),
  ]);
  return { answers, activity };
}

export async function forecastJob(env, user, { now = Date.now() } = {}) {
  const today = londonDay(now);
  let raw;
  try { raw = await readRaw(env, user, { now }); } catch (e) {
    if (noTable(e)) return { skipped: 'no tables yet' };
    throw e;
  }
  const out = { checks: 0, outcomes: 0, wrote: false };
  const rows = (raw.history || []).map(r => ({ ...r, at: Number(r.at) }));
  const known = new Map((raw.checks || []).map(c => [c.sitting_id, c]));
  const checks = checkForms(rows, formsOf(raw.sittings || []));
  const stmts = [], fresh = [];
  for (const c of checks) {
    const was = known.get(c.sitting_id);
    if (was && Number(was.actual) === Number(c.actual)) continue;
    const row = { ...c, user_id: user, created_at: now, updated_at: now };
    stmts.push(env.DB.prepare(`INSERT INTO score_forecast_checks (${CHECK_COLS.join(', ')}) VALUES (${CHECK_COLS.map((_, i) => `?${i + 1}`).join(', ')})
      ON CONFLICT (user_id, sitting_id) DO UPDATE SET actual = excluded.actual, error = excluded.actual - score_forecast_checks.pred_mean,
        z = (excluded.actual - score_forecast_checks.pred_mean) / score_forecast_checks.pred_sd, pit = excluded.pit, hit50 = excluded.hit50, hit80 = excluded.hit80,
        crps = excluded.crps, actual_pct = excluded.actual_pct, score = excluded.score, label = excluded.label, updated_at = excluded.updated_at`)
      .bind(...CHECK_COLS.map(k => row[k] ?? null)));
    fresh.push(c);
  }
  let state = null;
  try { state = buildState(raw); } catch (e) { console.error('forecast state not built', e && e.message); }
  const reads = await outcomeReads(env, user, raw.log || [], now).catch(e => { if (!noTable(e)) console.error('outcome reads failed', e && e.message); return null; });
  const systemOf = new Map(((state && state.topics) || []).map(t => [t.id, t.system]));
  for (const o of outcomesFor(raw.log || [], raw.lessons || [], reads ? reads.answers : raw.lessonAnswers || [], now, { activity: reads ? reads.activity : [], systemOf })) {
    stmts.push(env.DB.prepare('UPDATE score_plan_log SET outcome_json = ?3, evaluated_at = ?4 WHERE user_id = ?1 AND id = ?2').bind(user, o.id, JSON.stringify(o.outcome), now));
    out.outcomes++;
  }
  if (stmts.length) {
    try { await env.DB.batch(stmts); } catch (e) { if (noTable(e)) return { skipped: 'no tables yet' }; throw e; }
    out.checks = fresh.length;
    const merged = new Map(known); for (const c of fresh) merged.set(c.sitting_id, c);
    const sum = checkSummary([...merged.values()]);
    for (const c of fresh) {
      await noteJob(env, { job: 'forecast', user, key: `check:${c.sitting_id}`, ref: 'check', at: now,
        counts: { pred: c.pred_mean, actual: c.actual, kind: c.kind, inside: !!c.hit80, n: sum.n, in80: sum.inside80, mae: sum.mae, label: String(c.label || 'a form').slice(0, 40) } });
    }
  }
  if (state) {
    try {
      const tp = await import('./teach-plan.js');
      out.teach_plan = await tp.storeTeachPlan(env, user, tp.teachPlan(state), now);
    } catch (e) { console.error('teach plan not stored', e && e.message); }
  }
  if (rows.some(r => r.day === today)) return out;
  try {
    const r = await computeForecast(env, user, { now, raw });
    const row = forecastRow(user, today, now, r.fc, r.plan);
    await env.DB.prepare(`INSERT INTO score_forecasts (${ROW_COLS.join(', ')}) VALUES (${ROW_COLS.map((_, i) => `?${i + 1}`).join(', ')}) ON CONFLICT (user_id, day) DO NOTHING`)
      .bind(...ROW_COLS.map(k => row[k] ?? null)).run();
    out.wrote = true; out.mid = r.fc.mid;
    await noteJob(env, { job: 'forecast', user, key: today, ref: 'day', at: now,
      counts: { mid: r.fc.mid, low: r.fc.low, high: r.fc.high, change: r.change, rough: !!r.fc.rough }, detail: r.plan.hour[0] ? r.plan.hour[0].line : null });
  } catch (e) {
    if (noTable(e)) return { ...out, skipped: 'no tables yet' };
    await noteJob(env, { job: 'forecast', user, key: today, ref: 'day', state: 'failed', detail: e, at: now });
    throw e;
  }
  return out;
}

export function logRow(user, now, plan, state = null) {
  const ch = plan.choice;
  if (!ch) return null;
  const pick = id => plan.ranked.find(o => o.id === id) || plan.hour.find(o => o.id === id);
  const targets = [];
  for (const id of [ch.id, ch.other].filter(Boolean)) {
    const o = pick(id);
    const list = o && o.targets && o.targets.length ? o.targets : o && state && (o.kind === 'uworld' || o.kind === 'cards') ? measureTargets(state, o) : [];
    for (const t of list) {
      const shift = Object.entries(t.shift || {}).reduce((s, [k, v]) => s + ((plan.mean && plan.mean[k]) || 0) * v, 0);
      const p = Math.min(0.98, Math.max(0.02, t.p));
      const pw = 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + shift)));
      targets.push({ id, topic_id: t.topic_id, p_without: Math.round(p * 1000) / 1000, p_with: Math.round(pw * 1000) / 1000 });
    }
  }
  const chosen = pick(ch.id);
  return { user_id: user, id: `d${now}`, at: now, day: londonDay(now), chosen_id: ch.id, chosen_kind: chosen ? chosen.kind : 'other', rule: ch.rule, propensity: ch.propensity, other_id: ch.other,
    candidates_json: JSON.stringify(plan.ranked.slice(0, 10).map(o => ({ id: o.id, kind: o.kind, median: o.per_hour.median, p10: o.per_hour.p10, p90: o.per_hour.p90, p_best: o.p_best }))),
    targets_json: JSON.stringify(targets), model_version: MODEL_VERSION, source: 'home' };
}
export const LOG_COLS = ['user_id', 'id', 'at', 'day', 'chosen_id', 'chosen_kind', 'rule', 'propensity', 'other_id', 'candidates_json', 'targets_json', 'model_version',
  'source', 'lesson_id'];

// ------------------------------------------------------------------ outputs
const r2 = x => Math.round(x * 100) / 100;
/** The page's JSON (pure over computeForecast's result). */
export function forecastJson(r) {
  const { fc, plan, state } = r;
  const last = [...r.checks].reverse().find(c => c.actual != null) || null;
  const clean = o => { const { targets, c, mean, ...rest } = o; return rest; };
  return {
    line: r.line, mid: fc.mid, low: fc.low, high: fc.high, low50: fc.low50, high50: fc.high50, sd: fc.sd, rough: fc.rough, interval_pct: fc.interval_pct, change: r.change,
    p_target: fc.p_target, target: fc.target, percentile: fc.percentile, p_pass: fc.p_pass, level: fc.level, level_sd: fc.level_sd, trend: fc.trend, trend_sd: fc.trend_sd,
    pct: fc.pct, k: fc.k, k_sd: fc.k_sd, conversion: fc.conversion, readings: fc.readings, inflation: fc.inflation, n_forms: fc.n_forms, exam_day: state.exam_day,
    systems: Object.entries(fc.by_system).map(([id, s]) => ({ id, name: r.names[id] || id, ...s })).sort((a, b) => b.B - a.B),
    plan: { hour: plan.hour.map(clean), ranked: plan.ranked.map(clean), choice: plan.choice, rough: plan.rough, lesson_effect: plan.lesson_effect, draws: plan.draws_n,
      calibration: state.calibration },
    form: r.form,
    what_if: { plans: r.whatif.plans.map(p => ({ system: p.system, name: p.name, median: p.median, p10: p.p10, p90: p.p90, lessons: p.lessons, pairs: p.pairs, blocks: p.blocks, coef: p.coef })),
      draws: r.whatif.draws, compare: r.compare, line: r.what_if_line, minutes: state.whatif_minutes },
    inputs: { lesson_minutes: state.lesson.minutes, lesson_answers: state.lesson.obs.length, cards: { due: state.cards.due_n, sec: state.cards.sec }, uworld: state.uworld,
      topics: state.topics.length, forms: state.forms.map(f => ({ label: f.label, day: f.day, pct: f.pct == null ? null : r2(f.pct), score: f.score, timing: f.timing, repeat: f.repeat })) },
    history: r.history,
    checks: r.checks.map(c => ({ sitting_id: c.sitting_id, label: c.label, form_day: c.form_day, forecast_day: c.forecast_day, pred_mean: num(c.pred_mean), pred_sd: num(c.pred_sd), kind: c.kind,
      actual: num(c.actual), error: num(c.error), z: num(c.z), hit80: num(c.hit80), hit50: num(c.hit50), score: num(c.score) })),
    summary: r.summary, summary_line: summaryLine(r.summary), last_check: last ? checkLine(last) : null,
  };
}

/** GET /api/forecast: worked out now from the live data (the stored row is the frozen record); logs the decision shown (once an hour). */
export async function forecastRoute(request, env, ctx, params, url, user) {
  if (url && url.searchParams.get('line') === '1') return json(await forecastStored(env, user) || { line: 'No forecast yet' });
  const now = Date.now();
  const r = await computeForecast(env, user, { now });
  const lastLog = homeLog(r.raw.log || []).reduce((m, x) => Math.max(m, Number(x.at) || 0), 0);
  if (now - lastLog >= PLAN.log_every_ms) {
    const row = logRow(user, now, r.plan, r.state);
    if (row) {
      const p = env.DB.prepare(`INSERT INTO score_plan_log (${LOG_COLS.join(', ')}) VALUES (${LOG_COLS.map((_, i) => `?${i + 1}`).join(', ')}) ON CONFLICT (user_id, id) DO NOTHING`)
        .bind(...LOG_COLS.map(k => row[k] ?? null)).run().catch(e => { if (!noTable(e)) console.error('plan log not written', e && e.message); });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
    }
  }
  const out = forecastJson(r);
  try { out.panel = await (await import('./panel.js')).panelFor(env, user, r, { now }); } catch (e) { console.error('forecast panel not worked out', e && e.message); out.panel = null; }
  return json(out);
}

/** The newest stored forecast in a few words, for map_overview: {line, day, best_next, last_check, checked}. null before any. */
export async function forecastStored(env, user) {
  let rows, check;
  try {
    [rows, check] = await batchSoft(env, [
      env.DB.prepare('SELECT day, mid, low, high, rough, top_json FROM score_forecasts WHERE user_id = ?1 ORDER BY day DESC LIMIT 8').bind(user),
      env.DB.prepare(`SELECT label, pred_mean, actual, kind, z, hit80, hit50, error, crps FROM score_forecast_checks WHERE user_id = ?1 ORDER BY form_day DESC, updated_at DESC LIMIT 20`).bind(user),
    ]);
  } catch (e) { if (noTable(e)) return null; throw e; }
  const r = rows && rows[0];
  if (!r) return null;
  const change = weekChange(rows.map(x => ({ day: x.day, mid: Number(x.mid) })), r.day, Number(r.mid));
  const top = parse(r.top_json, [])[0];
  const last = (check || []).find(c => c.actual != null);
  const sum = checkSummary(check || []);
  return { line: forecastLine({ mid: r.mid, low: r.low, high: r.high, rough: Number(r.rough) === 1 }, change), day: r.day,
    ...(top ? { best_next: top.line } : {}), ...(last ? { last_check: checkLine(last) } : {}), ...(sum.n ? { checked: summaryLine(sum) } : {}) };
}
