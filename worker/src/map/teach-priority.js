import { londonDay } from '../util.js';
import { planFactor, lessonFactor, feedbackEffects, orderKey } from '../forecast/teach-factor.js';
import { TEACH } from '../forecast/constants.js';
import { errorKeyOf } from './weights.js';
import { pairOrder as linkPairOrder, orderName } from './links.js';
import { buildProfile } from '../profiles.js';
import { rankJoin, RANK_COLS, examRankText } from '../exam-ranks.js';
import { CONCEPT_ROWS_SQL, conceptRowsOf } from './concepts.js';
import { WEAK_BANDS } from '../../../public/js/shared/concept.js';
import { stateSelect, liveMap, overlay, weakestCategories } from './live.js';
import { examDayOf, daysToExam, EXAM_DATE_SQL } from '../exam-day.js';

export const LIVE_CAND_SQL = `SELECT s.topic_id, s.category_id, t.yield, s.t, s.band, s.mastery, s.weakness, s.weakness_raw, s.certainty, s.certainty_level, ${stateSelect('s')}
  FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
  WHERE s.user_id = ?1 AND s.seen = 1 AND t.status IN ('proposed','confirmed')`;
export const SEEN_CANDIDATES = 60;
/** The seen candidates (pure): the SEEN_CANDIDATES largest yield x live ungated weakness. */
export function seenCandidates(live) {
  return [...live.values()].map(r => ({ id: r.topic_id, g: (Number(r.yield) || 0) * (Number(r.weakness_raw) || 0) }))
    .sort((a, b) => b.g - a.g || String(a.id).localeCompare(String(b.id))).slice(0, SEEN_CANDIDATES).map(x => x.id);
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// Lane bands for Y (taxonomy's yield.js BANDS hold the same numbers; a test keeps them equal).
export const YIELD_BANDS = { A: [0.70, 1.00], B: [0.40, 0.55], C: [0.20, 0.30], off: [0.05, 0.15] };
export const T_MAX = 1.05;
export const NO_LESSON_ERRORS = ['misread', 'test_taking'];

// Phases by days left (D). a: the share of a category's prior weakness an unseen topic counts for.
export const PHASES = [
  { name: 'build', minD: 29, a: 0.65, lesson_minutes: 10, lanes: null, pair_upgrade: true },
  // quiet_days: outside lane A, a topic with no evidence in this many days is left out (E10; map_rules says so).
  { name: 'consolidate', minD: 11, a: 0.25, lesson_minutes: 8, lanes: null, pair_upgrade: false, quiet_days: 28 },
  { name: 'final', minD: 3, a: 0, lesson_minutes: 5, lanes: ['A', 'B'], pair_upgrade: false, mode: 'patch' },
  { name: 'rest', minD: -Infinity, a: 0, lesson_minutes: 3, lanes: ['A', 'B'], pair_upgrade: false, mode: 'patch', rest: true },
];

export const OPEN_PHASE = Object.freeze({ ...PHASES[0], name: 'open', minD: null, open: true });

/** Days from today to the exam date (the exam_date setting, passed in): null with no exam set. */
export function daysLeft(today = londonDay(), examDay = null) {
  return daysToExam(today, examDay);
}
/** The phase for d days left; no exam (null) or an exam in the past is the open phase. */
export function phaseFor(d) {
  if (d == null || !Number.isFinite(d) || d < 0) return OPEN_PHASE;
  return PHASES.find(p => d >= p.minD);
}

export function phaseOf(profile, today = londonDay()) {
  const lanes = profile && profile.checklist ? profile.checklist.lanes : null;
  if (!profile || (Array.isArray(lanes) && lanes.length)) { const d = daysLeft(today); return { days_left: d, phase: phaseFor(d), laneless: false }; }
  const exam = typeof profile.exam_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(profile.exam_date) ? profile.exam_date : null;
  const d = exam ? Math.round((Date.parse(exam + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / DAY_MS) : null;
  return { days_left: d != null && d >= 0 ? d : null, phase: PHASES[0], laneless: true };
}
const profileOfRow = row => { if (!row) return null; let over = {}; try { over = row.profile_json ? JSON.parse(row.profile_json) : {}; } catch { over = {}; } return buildProfile(row.profile, over); };
export const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

// Fridays and Sundays are topics days (40 questions, then Anki and weak topics until 18:00).
export function isTopicsDay(day) {
  const wd = new Date(day + 'T12:00:00Z').getUTCDay();
  return wd === 5 || wd === 0;
}

// The lane a yield falls in ('A', 'B', 'C' or 'off'); a yield inside a gap goes to the band below.
export function laneOf(y) {
  const v = Number(y) || 0;
  if (v >= YIELD_BANDS.A[0]) return 'A';
  if (v >= YIELD_BANDS.B[0]) return 'B';
  if (v >= YIELD_BANDS.C[0]) return 'C';
  return 'off';
}
// Y: a topic without a yield yet counts as the lowest off-checklist value, so it never outranks a placed one.
export const yieldOf = row => (Number(row.yield) > 0 ? Number(row.yield) : YIELD_BANDS.off[0]);

// N: the stored ungated weakness; unseen topics carry 1 − prior there, scaled by the phase's a.
export function nOf(row, phase) {
  const raw = row.weakness_raw != null ? Number(row.weakness_raw) : 1 - (row.prior_mastery != null ? Number(row.prior_mastery) : 0.62);
  return row.seen ? raw : phase.a * raw;
}

// K: 0 only when the topic has fail-side rows in 60 days and all of them are slips.
export const kOf = row => ((row.fails_60d || 0) > 0 && (row.slip_fails_60d || 0) >= row.fails_60d ? 0 : 1);

export function tieBreak(row) {
  const t = 1 + 0.01 * Math.min(row.sure_wrong_60d || 0, 2)
    + 0.01 * Math.max(0, Math.min((row.misses_60d || 0) - 1, 3))
    + 0.01 * (row.slow_60d ? 1 : 0) + 0.01 * (row.overdue ? 1 : 0)
    + 0.01 * (row.confused ? 1 : 0) + 0.01 * (row.weak_category ? 1 : 0);
  return Math.min(T_MAX, t);
}

export function gain(row, phase) {
  return yieldOf(row) * nOf(row, phase) * kOf(row) * tieBreak(row);
}

// The pair upgrade (§2.7): a mixed-up partner B worth at least half of A makes it a pair lesson.
export function pairGain(gA, gB) {
  return (gA + 0.6 * gB) / 1.3;
}
export const PAIR_CONFUSION = 0.5;
// The planner's pair test is not offered again within this many days of one on either topic.
export const PAIR_RECENT_DAYS = TEACH.pair_recent_days;

// The exclusion that keeps a topic out of the pick, or null (E4 makes a topic eligible, so it is a flag).
// row.last: the latest finished lesson on the topic {outcome, ended_at, card_action}; row.last_fail_at: the newest fail-side
// evidence (a miss, a missed re-test, a stated gap, a card lapse). A miss after the lesson lifts E2 and E3: the
// lesson did not stick, so the topic is eligible again at once (this replaces the old check-back's E5).
export function exclusion(row, ctx) {
  const { phase, now } = ctx;
  const named = ctx.named && ctx.named.has(row.topic_id);
  const requested = ctx.requested && ctx.requested.has(row.topic_id);
  if (row.status === 'merged' || row.status === 'retired') return 'E7';
  if (kOf(row) === 0) return 'E1';
  if (named) return null;
  const last = row.last;
  const missedSince = !!(last && row.last_fail_at && row.last_fail_at > (last.ended_at || 0));
  if (last && !missedSince) {
    if (last.outcome === 'landed') return 'E2';
    if (last.outcome === 'partial' && now - last.ended_at < 2 * DAY_MS) return 'E3';
  }
  if (row.band === 'strong' && !requested) return 'E6';
  if ((row.held_n || 0) > 0 && !(row.live_n > 0)) return 'E8';
  if (ctx.skip && ctx.skip.has(row.topic_id)) return 'E9';
  if (row.taught_today && !(last && last.outcome === 'not_landed')) return 'E9';
  if (phase.quiet_days && laneOf(yieldOf(row)) !== 'A' && !(row.last_ev_at && now - row.last_ev_at < phase.quiet_days * DAY_MS)) return 'E10';
  if (phase.lanes && !phase.lanes.includes(laneOf(yieldOf(row)))) return 'final';
  return null;
}

/**
 * Ranks topic rows. ctx: {phase, now, today, named?: Set, requested?: Set, skip?: Set, lastCategories?: [cat],
 * topicsDay?}. Returns {ranked: [{...row, Y, N, K, T, gain, lane, previous_angle_failed}], excluded: [{topic_id, rule}]}.
 * Ties go to the higher yield, then the id, so the order never depends on read order.
 */
export function rankTopics(rows, ctx) {
  const ranked = [], excluded = [];
  for (const row of rows) {
    const scored = { ...row, Y: yieldOf(row), N: nOf(row, ctx.phase), K: kOf(row), T: tieBreak(row), lane: laneOf(yieldOf(row)) };
    scored.gain = scored.Y * scored.N * scored.K * scored.T;
    // The planner (ctx.planner, teach-plan.js): the better of its lesson and pair-test values is the score (One list,
    // 1 Nov 2026). Patch phases teach lessons only, so no pair test there.
    const pairOff = !!((ctx.phase && ctx.phase.mode) || (ctx.pairOff && ctx.pairOff.has(row.topic_id)));
    if (ctx.planner) scored.plan = planFactor(ctx.planner, row.topic_id, { pairOff, fb: ctx.feedback || null });
    scored.score = scored.plan ? (scored.plan.planned ? scored.plan.best : 0) : scored.gain;
    scored.previous_angle_failed = !!(row.last && row.last.outcome === 'not_landed');
    const named = ctx.named && ctx.named.has(row.topic_id);
    const rule = exclusion(row, ctx) || (scored.plan && scored.plan.hidden && !named ? 'hidden' : null);
    if (rule) excluded.push({ topic_id: row.topic_id, rule });
    else ranked.push(scored);
  }
  const planned = r => (r.plan && r.plan.planned ? 1 : 0);
  ranked.sort((a, b) => planned(b) - planned(a) || b.score - a.score || b.gain - a.gain || b.Y - a.Y || String(a.topic_id).localeCompare(String(b.topic_id)));
  if (ctx.topicsDay && ranked.length > 1) interleave(ranked, ctx.lastCategories || []);
  return { ranked, excluded };
}

// Topics days: when the top topic's category matches one of today's last two lessons, the best topic from
// another category goes first if it is worth at least 0.85 of the top.
export function interleave(ranked, lastCategories) {
  if (!lastCategories.length || !lastCategories.includes(ranked[0].category_id)) return ranked;
  const i = ranked.findIndex(r => !lastCategories.includes(r.category_id) && !!(r.plan && r.plan.planned) === !!(ranked[0].plan && ranked[0].plan.planned));
  const val = r => (r.score != null ? r.score : r.gain);
  if (i > 0 && val(ranked[i]) >= 0.85 * val(ranked[0])) ranked.unshift(ranked.splice(i, 1)[0]);
  return ranked;
}

// FNV-1a over a string, as 8 hex characters.
export function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
export const pairOrder = lessonId => orderName(linkPairOrder(lessonId));

const fmtDay = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// One plain line, built by code from labels and counts only (never question or gap text), at most 200.
export function whyLine(row, servedBy, extra = {}) {
  const head = [row.lane && row.lane !== 'off' ? `Lane ${row.lane}` : 'Off the checklist', row.mehlman_rank ? `Mehlman #${row.mehlman_rank}` : null,
    examRankText(row.nbme_rank ?? null, row.cms_rank ?? null) || null].filter(Boolean).join(', ');
  const bits = [];
  if (servedBy === 'request' && extra.requested_at) bits.push(`you tapped Teach me at ${fmtTime(extra.requested_at)} on ${fmtDay(extra.requested_at)}`);
  if (servedBy === 'gap' && extra.gap_at) bits.push(`you logged a gap on it on ${fmtDay(extra.gap_at)}`);
  if (servedBy === 'named') bits.push('you asked for it');
  if (!row.seen) bits.push('not seen yet');
  if (row.sure_wrong_60d) bits.push(`${plural(row.sure_wrong_60d, 'sure-and-wrong miss', 'sure-and-wrong misses')}`);
  if (row.misses_60d && row.misses_60d > (row.sure_wrong_60d || 0)) bits.push(`${plural(row.misses_60d, 'miss', 'misses')} in 60 days`);
  if (row.slow_60d) bits.push('slow answers');
  if (row.overdue) bits.push('a miss on it is due a check');
  if (row.last && row.last_fail_at && row.last_fail_at > (row.last.ended_at || 0)) bits.push('a miss since the last lesson');
  if (row.confused && extra.partner) bits.push(`mixed up with ${extra.partner}`);
  else if (row.confused) bits.push('a mixed-up look-alike');
  if (row.previous_angle_failed) bits.push("last lesson didn't land");
  if (row.weak_category) bits.push('one of your weakest systems');
  const s = bits.length ? `${head}: ${bits.join(', ')}.` : `${head}.`;
  return s.length > 200 ? s.slice(0, 197).replace(/[ ,;:]+\S*$/, '') + '…' : s;
}

// Gaps keep the hub's words ('test-taking'); misses the key ('test_taking').
const isSlipGap = g => NO_LESSON_ERRORS.includes(errorKeyOf(g.error_type));
/** A pair test ("Test me", "test me on my pairs"): it marks the link and its items, never a lesson on a topic (LRN4-1). */
export const isPairTest = l => !!l && l.kind === 'pair_test';
/** A lesson closed by "done" before its final case (lesson_save: abandoned, stopped_early). */
export const stoppedEarly = l => !!l && l.status === 'abandoned' && l.abandon_reason === 'stopped_early';
export const unsavedLesson = l => !!l && l.status === 'abandoned' && l.abandon_reason === 'timeout' && !!l.started_at;
export const keptLesson = l => unsavedLesson(l) && [l.probe_json, l.steps_json].some(j => typeof j === 'string' && j !== '' && j !== '[]');
export function answersGap(l, g) {
  if (!l || !g || l.topic_id !== g.topic_id || isPairTest(l)) return false;
  if (l.status === 'in_progress') return true;
  if (!(l.status === 'done' || stoppedEarly(l) || unsavedLesson(l))) return false;
  return (l.ended_at || l.started_at || 0) > g.at;
}

/**
 * The tier choice (§2.2), pure. data: what rankTopicsFor read; opts: {namedIds, mode, skip, now}.
 * Returns {served_by, topic_id, row, request?, gap?, pair?: {topic_id, link_id, confusion}, runner_ups, queue} or
 * {rest: true} or {none: true}.
 */
export function choose(data, opts = {}) {
  const now = opts.now ?? data.now;
  const byId = data.byId;
  const ranked = data.ranked;
  const resolve = id => resolveMerged(id, data.merged);
  const others = id => ranked.filter(r => r.topic_id !== id);
  const tail = (id, n) => others(id).slice(0, n).map(r => ({ topic_id: r.topic_id, name: r.name, gain: round3(r.gain), why: whyLine(r, 'pick') }));
  const wrap = (servedBy, id, extra = {}) => {
    const row = byId.get(id) || null;
    return { served_by: servedBy, topic_id: id, row, ...extra, runner_ups: tail(id, 2), queue: tail(id, 5) };
  };

  if (opts.namedIds && opts.namedIds.length) {
    const id = resolve(opts.namedIds[0]);
    const pairId = opts.namedIds[1] ? resolve(opts.namedIds[1]) : null;
    return wrap('named', id, pairId ? { pair: { topic_id: pairId, ...linkBetween(data, id, pairId) } } : {});
  }

  const requests = (data.requests || []).filter(r => now - r.requested_at < 24 * HOUR_MS && r.topic_id).sort((a, b) => a.requested_at - b.requested_at);
  for (const r of requests) {
    const id = resolve(r.topic_id);
    const row = byId.get(id);
    if (!id || (row && row.status === 'retired')) continue;
    const pair = r.pair_topic_id ? { topic_id: resolve(r.pair_topic_id), ...linkBetween(data, id, resolve(r.pair_topic_id)) } : null;
    return wrap('request', id, { request: r, ...(pair ? { pair } : {}) });
  }

  if (data.phase.rest) return { rest: true };

  if (opts.mode === 'pair_test') {
    const top = topPair(data);
    if (top) return wrap('pick', top.a, { pair: { topic_id: top.b, link_id: top.link_id, confusion: top.confusion } });
  }

  const ctx = { phase: data.phase, now, skip: opts.skip || new Set() };
  // With the planner a stated gap is evidence the planner already weighs (One list, 1 Nov 2026), not a tier of its own.
  const gapPick = data.planner ? null : (data.gaps || []).map(g => ({ ...g, topic_id: resolve(g.topic_id) })).filter(g => {
    const row = byId.get(g.topic_id);
    if (!row || isSlipGap(g) || now - g.at > 7 * DAY_MS) return false;
    if (!data.laneless && laneOf(yieldOf(row)) !== 'A' && laneOf(yieldOf(row)) !== 'B') return false;
    if ((data.lessons || []).some(l => answersGap(l, g))) return false;
    if (ctx.skip.has(g.topic_id)) return false;
    // Only E1 (slips), E6 (strong) and E7 (merged or retired) hold a stated gap back.
    return !['E1', 'E6', 'E7'].includes(exclusion({ ...row, last: null, taught_today: false }, { ...ctx, named: null }));
  }).map(g => ({ g, gain: gain(byId.get(g.topic_id), data.phase) }))
    .sort((a, b) => b.gain - a.gain || b.g.at - a.g.at)[0];
  if (gapPick) return wrap('gap', gapPick.g.topic_id, { gap: gapPick.g });

  const top = ranked.find(r => !ctx.skip.has(r.topic_id));
  if (!top) return { none: true };
  const pick = wrap('pick', top.topic_id);
  // The planner's better action for the top topic is a pair test with its look-alike: teach_next defaults to pair_test.
  if (top.plan && top.plan.action === 'pair' && top.plan.partner && opts.mode !== 'patch' && !data.phase.mode) {
    pick.pair = { topic_id: top.plan.partner, ...linkBetween(data, top.topic_id, top.plan.partner) };
    pick.planned = 'pair_test';
  } else if (data.phase.pair_upgrade && opts.mode !== 'patch' && !data.planner) {
    const partner = bestPartner(data, top);
    if (partner) pick.pair = partner;
  }
  return pick;
}

const round3 = x => Math.round(x * 1000) / 1000;

export function nextUp(data, { limit = 10, skip = new Set() } = {}) {
  if (!data || !data.ok || (data.phase && data.phase.rest)) return [];
  const out = [], seen = new Set();
  for (const r of data.ranked || []) {
    if (skip.has(r.topic_id)) continue;
    const partner = r.plan && r.plan.action === 'pair' && r.plan.partner ? r.plan.partner : null;
    const id = partner ? orderKey(`pair:${r.topic_id}:${partner}`) : `lesson:${r.topic_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = partner && data.byId ? data.byId.get(partner) : null;
    out.push({ id, kind: partner ? 'pair' : 'lesson', topic_id: r.topic_id, name: r.name,
      ...(partner ? { partner_id: partner, partner_name: (p && p.name) || partner } : {}), planned: !!(r.plan && r.plan.planned), row: r });
    if (out.length >= limit) break;
  }
  return out;
}

/** An item in plain words: "Ascites", or "Ascites against Nephrotic syndrome" for a pair test. */
export const itemName = it => (it.kind === 'pair' && it.partner_name ? `${it.name} against ${it.partner_name}` : it.name);

/** The order the planner follows for its lesson-type steps (forecast/model.js candidates): ids and topics only. */
export const orderOf = items => (items || []).map(i => ({ id: i.id, kind: i.kind, topic_id: i.topic_id, ...(i.partner_id ? { partner_id: i.partner_id } : {}) }));

/**
 * rankTopicsFor with the planner's values always there (worked out now when none fresh is stored), and nextUp over it:
 * {data, items}. Every surface calls this, so all read the same stored plan row. opts: rankTopicsFor's, plus limit.
 */
export async function nextUpFor(env, user, opts = {}) {
  const data = await rankTopicsFor(env, user, { ...opts, plan_live: true });
  return { data, items: nextUp(data, { limit: opts.limit || 10 }) };
}

// Follows merged_into at most 5 hops; a retired end resolves to itself (callers drop it).
export function resolveMerged(id, merged = new Map()) {
  let cur = id;
  for (let i = 0; i < 5 && merged.has(cur); i++) {
    const next = merged.get(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

function linkBetween(data, a, b) {
  const l = (data.links || []).find(x => (x.from_id === a && x.to_id === b) || (x.from_id === b && x.to_id === a));
  return l ? { link_id: l.id, confusion: l.confusion } : { link_id: null, confusion: null };
}

// A mixed-up partner whose gain is at least half the pick's, or null.
export function bestPartner(data, top) {
  let best = null;
  for (const l of data.links || []) {
    if (l.confusion < PAIR_CONFUSION) continue;
    const other = l.from_id === top.topic_id ? l.to_id : l.to_id === top.topic_id ? l.from_id : null;
    if (!other) continue;
    const row = data.byId.get(other);
    if (!row || row.status === 'retired' || row.status === 'merged') continue;
    const gB = gain(row, data.phase);
    if (gB >= 0.5 * top.gain && (!best || gB > best.gainB)) best = { topic_id: other, link_id: l.id, confusion: l.confusion, gainB: gB, gain: round3(pairGain(top.gain, gB)) };
  }
  if (!best) return null;
  const { gainB, ...pair } = best;
  return pair;
}

// "Test me on my pairs": the mixed-up pair with the highest confusion × the larger yield.
export function topPair(data) {
  let best = null;
  for (const l of data.links || []) {
    if (l.confusion < PAIR_CONFUSION) continue;
    const a = data.byId.get(l.from_id), b = data.byId.get(l.to_id);
    const score = l.confusion * Math.max(a ? yieldOf(a) : 0, b ? yieldOf(b) : 0);
    if (!best || score > best.score) best = { a: l.from_id, b: l.to_id, link_id: l.id, confusion: l.confusion, score };
  }
  return best;
}


// The map's Shaky band is coded 'mixed' (scale.js BANDS); concept.js lists 'shaky', so both count here.
const WEAK_SET = new Set([...WEAK_BANDS, 'mixed']);
/** Whether a cluster is worth a lesson (pure): 2+ clinical members weak or shaky that share a mix-up pair or the root. */
export function teachable(cluster, bandOf = m => m.band) {
  const members = (cluster && cluster.members) || [];
  const weak = new Set(members.filter(m => m.kind !== 'concept' && WEAK_SET.has(bandOf(m))).map(m => m.id));
  if (weak.size < 2) return { ok: false, weak: [...weak], pair: false, root: false };
  const pair = ((cluster && cluster.pairs) || []).some(p => weak.has(p.a) && weak.has(p.b));
  const rootId = cluster && cluster.root && cluster.root.id;
  const tied = members.filter(m => weak.has(m.id) && m.id !== rootId && m.root_tie).length;
  const root = tied >= 2 || (weak.has(rootId) && tied >= 1);
  return { ok: pair || root, weak: [...weak], pair, root };
}

export function clusterValue(cluster, data) {
  let v = 0;
  const plan = data && data.planner;
  for (const m of (cluster && cluster.members) || []) {
    const row = data && data.byId ? data.byId.get(m.id) : null;
    const n = row ? (row.N != null ? Number(row.N) : row.seen && row.weakness_raw != null ? Number(row.weakness_raw) : null) : null;
    const part = n != null && Number.isFinite(n) ? yieldOf(row) * n * (Number(m.density) || 0) : Number(m.cost) || 0;
    v += plan ? part * lessonFactor(plan, m.id) : part;
  }
  return Math.round(v * 1000) / 1000;
}

/**
 * Which cluster "teach me" serves, or null (pure). clusters: readClusters' rows; data: rankTopicsFor's. opts: {skip: Set
 * (topic or cluster ids), clusterId (a tap or "(cluster: k_…)"), topicId (mode cluster with a topic: its cluster), force
 * (mode cluster: no comparison with the topics), now}. Returns {cluster, value, top_gain, top_name, weak, why} or null.
 */
export function chooseCluster(clusters, data, { skip = new Set(), clusterId = null, topicId = null, force = false, now = Date.now() } = {}) {
  const live = m => { const r = data && data.byId ? data.byId.get(m.id) : null; return (r && r.band) || m.band; };
  const lastFail = c => Math.max(0, ...c.members.map(m => Number(((data && data.byId && data.byId.get(m.id)) || {}).last_fail_at) || 0));
  const named = !!(clusterId || topicId);
  let list = (clusters || []).filter(c => c && Array.isArray(c.members) && c.members.length);
  if (clusterId) list = list.filter(c => c.id === clusterId);
  else if (topicId) list = list.filter(c => c.members.some(m => m.id === topicId));
  const scored = [];
  for (const c of list) {
    const t = teachable(c, live);
    if (!named) {
      if (skip.has(c.id) || (c.root && skip.has(c.root.id))) continue;
      // Taught since its newest miss (or in the last two days when no miss is read): it waits until a miss says it did not stick.
      if (c.lesson_at && (c.lesson_at >= lastFail(c) || now - c.lesson_at < 2 * DAY_MS)) continue;
      if (!t.ok) continue;
    }
    scored.push({ cluster: c, value: clusterValue(c, data), weak: t.weak, pair: t.pair, root: t.root });
  }
  scored.sort((a, b) => b.value - a.value || (a.cluster.id < b.cluster.id ? -1 : 1));
  const best = scored[0];
  if (!best) return null;
  const top = ((data && data.ranked) || []).find(r => !skip.has(r.topic_id)) || null;
  const topGain = top ? Number(top.score != null ? top.score : top.gain) || 0 : 0;
  if (!named && !force && !(best.value > topGain)) return null;
  const nameOf = id => (best.cluster.members.find(m => m.id === id) || {}).name || id;
  const weakNames = best.weak.map(nameOf);
  const list3 = weakNames.length > 3 ? `${weakNames.slice(0, 3).join(', ')} and ${weakNames.length - 3} more` : weakNames.length > 1 ? `${weakNames.slice(0, -1).join(', ')} and ${weakNames[weakNames.length - 1]}` : weakNames.join('');
  const tie = best.root && best.cluster.root && best.cluster.root.name ? `share one root, ${best.cluster.root.name}` : best.pair ? 'get mixed up with each other' : 'sit together';
  const tail = `; together they cost more than ${top && top.name ? `${top.name} alone` : 'any one topic'}.`;
  const long = `A cluster: ${list3 || 'its topics'} ${weakNames.length > 1 ? 'are' : 'is'} weak and ${tie}${tail}`;
  const why = named ? `You asked for this cluster: ${best.cluster.name}.`
    : long.length <= 200 ? long : `A cluster: ${weakNames.length} weak topics that ${tie}${tail}`;
  return { cluster: best.cluster, value: best.value, top_gain: Math.round(topGain * 1000) / 1000, top_name: top ? top.name : null, weak: best.weak,
    why: why.length > 200 ? `${why.slice(0, 197).replace(/[ ,;:]+\S*$/, '')}…` : why };
}

// ---------------------------------------------------------------- reads

// Which of the named tables exist (one query, remembered: a table that exists stays; a missing one is asked
// again after a minute). Lets teach work before every area's 0010 fragment is applied, leaving out what is not there.
const knownByDb = new WeakMap();
export async function tablesPresent(env, user, names) {
  const now = Date.now();
  if (!knownByDb.has(env.DB)) knownByDb.set(env.DB, new Map());
  const known = knownByDb.get(env.DB);
  const ask = names.filter(n => !(known.get(n) === true || (typeof known.get(n) === 'number' && now - known.get(n) < 60_000)));
  if (ask.length) {
    let found = [];
    try {
      found = ((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(ask)).all()).results || []).map(r => r.name);
    } catch { found = ask; }   // cannot tell: assume present, and let the read say otherwise
    for (const n of ask) known.set(n, found.includes(n) ? true : now);
  }
  return new Set(names.filter(n => known.get(n) === true));
}

const FAIL_SIDE = `((kind = 'question' AND result IN ('wrong','flawed','omitted')) OR (kind = 'retest' AND outcome = 'missed_again')
  OR kind = 'gap_stated' OR (kind = 'card_check' AND verdict IN ('gap','shaky')))`;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
export const CLUSTERS_READ = `SELECT c.*, (SELECT max(coalesce(l.ended_at, l.started_at)) FROM lessons l WHERE l.user_id = c.user_id AND l.cluster_id = c.id
    AND l.status IN ('done', 'in_progress')) AS lesson_at,
    (SELECT count(*) FROM lessons l WHERE l.user_id = c.user_id AND l.cluster_id = c.id AND l.status = 'done') AS lesson_n
  FROM clusters c WHERE c.user_id = ?1 AND c.status = 'active' ORDER BY c.cost DESC, c.id LIMIT ?2`;
const noClusters = e => /no such table:?\s*(?:main\.)?clusters\b|no such column:?\s*(?:l\.)?cluster_id/i.test(String(e && e.message));
let clustersMissing = false;
export const _resetClustersMissing = () => { clustersMissing = false; planMissing = false; feedbackMissing = false; };
// The planner's stored values (0073_planner_teach.sql) ride in the same batch, left out the same way before the migration.
const PLAN_ROW_SQL = 'SELECT at, model_version, plan_json FROM score_plan_coefs WHERE user_id = ?1';
const noPlanTable = e => /no such table:?\s*(?:main\.)?score_plan_coefs\b/i.test(String(e && e.message));
let planMissing = false;
const FEEDBACK_SQL = 'SELECT option_id, action, reason, day, until_day FROM plan_feedback WHERE user_id = ?1 AND day >= ?2';
const noFeedbackTable = e => /no such table:?\s*(?:main\.)?plan_feedback\b/i.test(String(e && e.message));
let feedbackMissing = false;

/**
 * Everything the pick needs, in one D1 batch (one query; a second only when a topic faded into the 60 weakest since
 * its row was written): candidate topics with their scores as of now (live.js: the fade read on the spot) and
 * 60-day evidence counts, lessons of the last 14 days plus open ones, Teach me taps, stated gaps of the last
 * 7 days, mixed-up versus links, merged topics and the three weakest categories.
 * opts: {now?, today?, ids?: [topic ids to include], skip?: [ids], lastCategories?, plan_live? (work the planner's values
 * out when none fresh is stored: teach_next), plan? (a plan already loaded), planner? (false: none), waitUntil?}
 * Returns {ok, now, today, days_left, phase, rows, byId, ranked, excluded, lessons, requests, gaps, links, merged,
 * weak_categories, planner} or {ok: false, reason} when the map tables are not there yet.
 */
export async function rankTopicsFor(env, user, opts = {}) {
  const now = opts.now ?? Date.now();
  // The planner's values (forecast/teach-plan.js): its stored row rides in the batch; none fresh, teach_next works them out.
  const wantPlan = opts.planner !== false && !opts.plan;
  const today = opts.today ?? londonDay(now);
  // The exam date: the caller's (opts.examDay, null for none), else the setting, read in the batch below.
  let examDay = opts.examDay !== undefined ? examDayOf(opts.examDay === null ? '' : opts.examDay) : examDayOf(undefined);
  let d = daysLeft(today, examDay);
  let phase = phaseFor(d);
  const since60 = now - 60 * DAY_MS, since7 = now - 7 * DAY_MS, since14 = now - 14 * DAY_MS, since72h = now - 72 * HOUR_MS;
  const extraIds = [...new Set((opts.ids || []).filter(Boolean).map(String))].slice(0, 20);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  // The candidates: the 60 weakest by their stored rows, and (in ?2, with the named ones) any of the 60 weakest as of now
  // (live.js) not among them. D1 allows 5 terms in one compound SELECT, so they share the json_each term.
  const topicsSql = live => q(`WITH cand(id) AS (
           SELECT id FROM (SELECT t.id FROM topics t JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
             WHERE t.user_id = ?1 AND t.status IN ('proposed','confirmed') AND s.seen = 1
             ORDER BY t.yield * coalesce(s.weakness_raw, 0) DESC LIMIT 60)
           UNION SELECT id FROM (SELECT t.id FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
             WHERE t.user_id = ?1 AND t.status IN ('proposed','confirmed') AND coalesce(s.seen, 0) = 0 ORDER BY t.yield DESC LIMIT 20)
           UNION SELECT value FROM json_each(?2)
           UNION SELECT id FROM (
             SELECT topic_id AS id FROM gaps WHERE user_id = ?1 AND origin = 'stated' AND held = 0 AND topic_id IS NOT NULL AND at >= ?4
             UNION SELECT topic_id FROM lessons WHERE user_id = ?1 AND status = 'requested' AND requested_at >= ?5 AND topic_id IS NOT NULL
             UNION SELECT pair_topic_id FROM lessons WHERE user_id = ?1 AND status = 'requested' AND requested_at >= ?5 AND pair_topic_id IS NOT NULL)
           UNION SELECT id FROM (
             SELECT from_id AS id FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active','proposed') AND confusion >= 0.5
             UNION SELECT to_id FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active','proposed') AND confusion >= 0.5)),
         ev AS (SELECT topic_id, sum(held = 0) AS live_n, sum(held = 1) AS held_n, max(CASE WHEN held = 0 THEN at END) AS last_ev_at,
             max(CASE WHEN held = 0 AND (${FAIL_SIDE} OR (kind = 'card_lapse' AND json_extract(detail_json, '$.first_sight') IS NULL)) THEN at END) AS last_fail_at,
             sum(held = 0 AND at >= ?3 AND ${FAIL_SIDE}) AS fails_60d,
             sum(held = 0 AND at >= ?3 AND ${FAIL_SIDE} AND error_type IN ('misread','test_taking')) AS slip_fails_60d,
             sum(held = 0 AND at >= ?3 AND kind = 'question' AND result = 'wrong' AND confidence = 'sure') AS sure_wrong_60d,
             sum(held = 0 AND at >= ?3 AND kind = 'question' AND result IN ('wrong','flawed','omitted')) AS misses_60d,
             max(held = 0 AND at >= ?3 AND kind = 'question' AND time_s > 120) AS slow_60d
           FROM evidence WHERE user_id = ?1 AND slot = 0 AND topic_id IN (SELECT id FROM cand) GROUP BY topic_id)
         SELECT t.id AS topic_id, t.name, t.short_name, t.kind, t.status, t.merged_into, t.category_id, t.unit_id, t.yield,
           u.num AS unit_num, u.name AS unit_name, u.lane AS unit_lane, u.mehlman_rank, ${RANK_COLS}, c.name AS category,
           coalesce(s.seen, 0) AS seen, s.weakness_raw, s.prior_mastery, s.band, s.t, s.certainty, s.why_json,
           ev.live_n, ev.held_n, ev.last_ev_at, ev.last_fail_at, ev.fails_60d, ev.slip_fails_60d, ev.sure_wrong_60d, ev.misses_60d, ev.slow_60d,
           t.id IN (SELECT m.topic_id FROM misses m WHERE m.user_id = ?1 AND m.topic_id IS NOT NULL AND m.held = 0 AND m.deleted_at IS NULL AND m.next_retest_day <= ?6) AS overdue,
           t.id IN (SELECT k.from_id FROM links k WHERE k.user_id = ?1 AND k.type = 'versus' AND k.status IN ('active','proposed') AND k.confusion >= 0.5
             UNION SELECT k.to_id FROM links k WHERE k.user_id = ?1 AND k.type = 'versus' AND k.status IN ('active','proposed') AND k.confusion >= 0.5) AS confused
         FROM topics t JOIN cand ON cand.id = t.id
         LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
         LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
         ${rankJoin('u')}
         LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
         LEFT JOIN ev ON ev.topic_id = t.id
         WHERE t.user_id = ?1`, user, JSON.stringify([...new Set([...extraIds, ...live])]), since60, since7, since72h, today);
  let res;
  const batch = (withClusters, withPlan, withFeedback) => env.DB.batch([
      topicsSql([]),
      q(`SELECT id, topic_id, topic_name, pair_topic_id, link_id, kind, status, outcome, served_by, requested_by, request_from, surface_hint,
           requested_at, started_at, ended_at, day, goal, memory_used_json, steps_json, tactics_json, card_action, abandon_reason
         FROM lessons WHERE user_id = ? AND (coalesce(ended_at, started_at, requested_at) >= ? OR status IN ('requested','in_progress'))
         ORDER BY coalesce(ended_at, started_at, requested_at) DESC LIMIT 200`, user, since14),
      q(`SELECT id, at, day, topic_id, error_type, source, origin FROM gaps
         WHERE user_id = ? AND origin = 'stated' AND held = 0 AND topic_id IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 50`, user, since7),
      q(`SELECT id, from_id, to_id, confusion, a_vs_b, b_vs_a, last_confused_at FROM links
         WHERE user_id = ? AND type = 'versus' AND status IN ('active','proposed') AND confusion >= 0.5 ORDER BY confusion DESC LIMIT 200`, user),
      q(`SELECT id, merged_into FROM topics WHERE user_id = ? AND status = 'merged' AND merged_into IS NOT NULL LIMIT 1000`, user),
      // The exam_date setting (the weakest systems, once here, come from the live colours below).
      q(EXAM_DATE_SQL),
      // Each topic's latest finished lesson, however old (a landed one keeps its topic out until later evidence). A pair
      // test teaches nothing, so it is never a topic's last lesson (LRN4-1): it feeds only the link and its items.
      q(`SELECT id, topic_id, outcome, ended_at, card_action FROM (SELECT id, topic_id, outcome, ended_at, card_action,
           row_number() OVER (PARTITION BY topic_id ORDER BY ended_at DESC, id DESC) AS rn FROM lessons
           WHERE user_id = ? AND status = 'done' AND topic_id IS NOT NULL AND coalesce(kind, 'lesson') <> 'pair_test') WHERE rn = 1 LIMIT 2000`, user),
      q(CONCEPT_ROWS_SQL, user),
      // The seen topics' states (live.js), so the pick reads each colour as of now: a topic left alone fades.
      q(LIVE_CAND_SQL, user),
      q(`SELECT profile, profile_json FROM users WHERE id = ?`, user),
      // The error clusters (clusters.js), for teach_next's cluster pick, in this same batch.
      ...(withClusters ? [q(CLUSTERS_READ, user, 12)] : []),
      // The planner's stored values (0073): last, so the slots above keep their places.
      ...(withPlan ? [q(PLAN_ROW_SQL, user)] : []),
      ...(withFeedback ? [q(FEEDBACK_SQL, user, addDays(today, -8))] : []),
    ]);
  let withC = !clustersMissing, withP = wantPlan && !planMissing, withF = !feedbackMissing;
  try {
    for (let tries = 0; ; tries++) {
      try { res = await batch(withC, withP, withF); break; } catch (e) {
        if (tries < 3 && withC && noClusters(e)) { clustersMissing = true; withC = false; continue; }
        if (tries < 3 && withP && noPlanTable(e)) { planMissing = true; withP = false; continue; }
        if (tries < 3 && withF && noFeedbackTable(e)) { feedbackMissing = true; withF = false; continue; }
        throw e;
      }
    }
  } catch (e) {
    if (noTable(e)) return { ok: false, reason: 'The map is not set up yet.', now, today, exam_day: examDay, days_left: d != null && d >= 0 ? d : null, phase };
    throw e;
  }
  const [topics1, lessons, gaps, links, merged, examRows, lastDone, concepts, liveRows, users, ...rest] = res.map(r => r.results || []);
  const profile = profileOfRow(users[0]);
  const p = phaseOf(profile, today);
  const clusterRows = withC ? rest[0] : undefined;
  const planRow = withP ? (rest[withC ? 1 : 0] || [])[0] || null : undefined;
  const feedback = withF ? feedbackEffects(rest[(withC ? 1 : 0) + (withP ? 1 : 0)] || [], today) : null;
  let planner = opts.plan || null;
  if (wantPlan) {
    const tp = await import('../forecast/teach-plan.js');
    planner = tp.planFromRow(planRow, now);
    if (!planner && opts.plan_live) planner = await tp.loadTeachPlan(env, user, { now, live: true, waitUntil: opts.waitUntil || null, row: planRow ?? null });
  }
  if (opts.examDay === undefined) {
    examDay = examDayOf(examRows && examRows[0] ? examRows[0].value : undefined);
    d = daysLeft(today, examDay);
    phase = phaseFor(d);
  }
  // Past the exam there is no countdown: days_left is null, as with no exam set (the phase is the open one).
  if (d != null && d < 0) d = null;
  const live = liveMap(liveRows, now);
  // A topic among the 60 weakest now that its stored row did not put in the batch (it faded since): one more read, rarely.
  const have = new Set(topics1.map(r => r.topic_id));
  const missing = seenCandidates(live).filter(id => !have.has(id));
  let topics0 = topics1;
  if (missing.length) {
    const more = ((await topicsSql(missing).all()).results || []).filter(r => !have.has(r.topic_id));
    topics0 = [...topics1, ...more];
  }
  const topics = overlay(topics0, live);
  const weakCats = weakestCategories(live);
  return { ...shapeData({ topics, lessons, gaps, links, merged, weakCats, lastDone }, { now, today, exam_day: p.laneless ? null : examDay, days_left: p.laneless ? p.days_left : d,
      phase: p.laneless ? p.phase : phase, skip: opts.skip, lastCategories: opts.lastCategories, named: opts.named, planner, feedback,
      laneless: p.laneless, profile: p.laneless ? profile : null }),
    concepts: conceptRowsOf(concepts), ...(clusterRows ? { cluster_rows: clusterRows } : {}) };
}

/**
 * Turns the read rows into ranked data (pure; the tests feed it fixtures). Lessons give each topic its latest
 * finished lesson, whether it was taught today, and the categories of today's last two lessons.
 */
export function shapeData(raw, { now, today, exam_day = null, days_left, phase, skip, lastCategories, named, planner = null, feedback = null, laneless = false, profile = null }) {
  const lessons = raw.lessons || [];
  const merged = new Map((raw.merged || []).map(m => [m.id, m.merged_into]));
  const weak = new Set((raw.weakCats || []).map(c => c.category_id));
  const lastBy = new Map(), todayBy = new Set();
  const doneToday = [];
  const keepLast = l => {
    const prev = lastBy.get(l.topic_id);
    if (!prev || (l.ended_at || 0) > prev.ended_at) lastBy.set(l.topic_id, { outcome: l.outcome, ended_at: l.ended_at || 0, lesson_id: l.id, card_action: l.card_action || null });
  };
  for (const l of raw.lastDone || []) if (l.topic_id && !isPairTest(l)) keepLast(l);
  for (const l of lessons) {
    // A lesson stopped with "done" before its final case, or started and never saved, counts as taught today
    // (LRN3-3, LRN4-3), never as a finished one.
    if ((stoppedEarly(l) || unsavedLesson(l)) && l.topic_id && l.day === today) todayBy.add(l.topic_id);
    // A pair test is a 3-minute test, not a lesson on either topic (LRN4-1).
    if (l.status !== 'done' || !l.topic_id || isPairTest(l)) continue;
    keepLast(l);
    if (l.day === today) { todayBy.add(l.topic_id); doneToday.push(l); }
  }
  const rows = (raw.topics || []).map(t => ({
    ...t, seen: t.seen ? 1 : 0, overdue: !!t.overdue, confused: !!t.confused, slow_60d: !!t.slow_60d, weak_category: weak.has(t.category_id),
    lane: laneOf(yieldOf(t)), last: lastBy.get(t.topic_id) || null, taught_today: todayBy.has(t.topic_id),
  }));
  const byId = new Map(rows.map(r => [r.topic_id, r]));
  const catOf = id => (byId.get(id) || {}).category_id;
  // A Teach me tap is answered once a lesson on the same topic (and pair) starts after it, however it started
  // ("teach me X" named in chat, a pick): it no longer outranks everything (RH2-1).
  const answered = l => lessons.some(o => o.id !== l.id && o.topic_id === l.topic_id && (o.pair_topic_id || null) === (l.pair_topic_id || null)
    && ['in_progress', 'done'].includes(o.status) && (o.started_at || 0) > (l.requested_at || 0));
  const openRequests = lessons.filter(l => l.status === 'requested' && now - (l.requested_at || 0) < 72 * HOUR_MS && !answered(l));
  const lastCats = lastCategories || doneToday.sort((a, b) => (b.ended_at || 0) - (a.ended_at || 0)).slice(0, 2).map(l => catOf(l.topic_id)).filter(Boolean);
  // A pair tested in the last week (either topic) is not offered again as a pair test (the planner's pick then teaches it).
  const pairOff = new Set();
  for (const l of lessons) {
    const when = Number(l.ended_at || l.started_at) || 0;
    if (isPairTest(l) && l.status !== 'requested' && now - when < PAIR_RECENT_DAYS * DAY_MS) for (const id of [l.topic_id, l.pair_topic_id]) if (id) pairOff.add(id);
  }
  const { ranked, excluded } = rankTopics(rows, {
    planner, pairOff, feedback,
    phase, now, today, skip: new Set(skip || []), named: new Set(named || []), lastCategories: lastCats, topicsDay: isTopicsDay(today),
    requested: new Set(openRequests.filter(l => now - (l.requested_at || 0) < 24 * HOUR_MS).map(l => l.topic_id)),
  });
  for (const r of ranked) byId.set(r.topic_id, r);
  return {
    ok: true, now, today, exam_day, days_left, phase, rows, byId, ranked, excluded, lessons, merged, links: raw.links || [], gaps: raw.gaps || [], planner,
    requests: openRequests,
    weak_categories: [...weak], last_categories: lastCats,
    ...(laneless ? { laneless: true } : {}), ...(profile ? { profile } : {}),
  };
}
