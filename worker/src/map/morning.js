import { json, readJson, londonDay } from '../util.js';
import { applyChange, changeResponse } from './change.js';
import { nextUpFor, nextUp, itemName, choose, laneOf, yieldOf, tablesPresent, phaseFor, daysLeft } from './teach-priority.js';
import { planLessonRequest } from './teach-brief.js';
import { rankJoin, RANK_COLS, examRankText } from '../exam-ranks.js';

const DAY_MS = 86_400_000;
export const OFFER_HOUR = 6;
export const LONG_UNSEEN_DAYS = 21;
export const CONTRAST_AVOID = 0.3;     // the contrast pick: yield × (1 + 0.3 × avoidance)
export const AVOID_MAX = 0.05;
export const AVOID_RULES = {
  passed: { min: 3, base: 0.5, step: 0.1, steps: 2, days: 60 },
  abandoned: { min: 2, base: 0.3, step: 0.1, steps: 1, days: 60 },
  unstudied: { min: 3, base: 0.3, step: 0.05, steps: 3, days: 30 },
};
export const AVOID_TEXT = [
  'Passed: offered on 3 or more days in 60 (a "next" counts too) and never chosen, with no lesson on it since.',
  'Abandoned: 2 or more lessons in 60 days stopped before the end or never saved, none landed since.',
  'Unstudied: 3 or more misses in 30 days (misreads and slips left out) and no lesson in those 30 days.',
];
const REASON_MAX = 140;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const round2 = x => Math.round(x * 100) / 100;
const TIMES = ['no times', 'once', 'twice', 'three times', 'four times', 'five times', 'six times', 'seven times', 'eight times', 'nine times', 'ten times'];
export const times = n => TIMES[n] || `${n} times`;
const waitUntilOf = ctx => (ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx)
  : ctx && ctx.executionCtx && typeof ctx.executionCtx.waitUntil === 'function' ? ctx.executionCtx.waitUntil.bind(ctx.executionCtx) : null);
export const promptFor = t => (t.partner_id ? `Test me on ${t.name} (map: ${t.id}, ${t.partner_id})` : `Teach me ${t.name} (map: ${t.id})`);

// The one writer (events.js), loaded when used; the tests swap it.
const io = { writeBatch: async (...a) => (await import('./events.js')).writeBatch(...a) };
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}
const bookkeeping = (env, user, statements, via) => io.writeBatch(env, user, { actor: 'code', surface: 'cron', via, statements, events: [] });

// ================================================================ avoidance

const NONE_SQL = `SELECT NULL AS topic_id WHERE 0 AND ? = ?`;
export const AVOID_SQL = `SELECT g.topic_id, t.name, t.category_id, g.passes, g.offers, g.chosen, g.first_pass_at, g.last_pass_at, g.abandoned,
    g.last_abandon_at, g.misses, g.first_miss_at, g.last_lesson_at, g.landed_at
  FROM (SELECT topic_id,
      count(DISTINCT CASE WHEN pass = 1 THEN day END) AS passes, count(DISTINCT CASE WHEN offer = 1 THEN day END) AS offers, sum(chosen) AS chosen,
      min(CASE WHEN pass = 1 THEN at END) AS first_pass_at, max(CASE WHEN pass = 1 THEN at END) AS last_pass_at,
      sum(abandoned) AS abandoned, max(CASE WHEN abandoned = 1 THEN at END) AS last_abandon_at,
      sum(miss) AS misses, min(CASE WHEN miss = 1 THEN at END) AS first_miss_at,
      max(lesson_at) AS last_lesson_at, max(landed_at) AS landed_at
    FROM (
      SELECT topic_id, day, 1 AS offer, CASE WHEN state IN ('declined','ignored') OR (state = 'open' AND day < ?4) THEN 1 ELSE 0 END AS pass,
        CASE WHEN state = 'chosen' THEN 1 ELSE 0 END AS chosen, 0 AS abandoned, 0 AS miss, NULL AS lesson_at, NULL AS landed_at, offered_at AS at
      FROM teach_offers WHERE user_id = ?1 AND offered_at >= ?2
      UNION ALL SELECT topic_id, day, 0, 1, 0, 0, 0, NULL, NULL, at FROM teach_skips WHERE user_id = ?1 AND at >= ?2
      UNION ALL SELECT l.topic_id, l.day, 0, 0, 0,
        CASE WHEN l.status = 'abandoned' AND l.started_at IS NOT NULL AND (l.abandon_reason IN ('stopped_early','claude') OR (l.abandon_reason = 'timeout'
          AND NOT EXISTS (SELECT 1 FROM teach_skips k WHERE k.user_id = l.user_id AND k.topic_id = l.topic_id AND k.day = l.day))) THEN 1 ELSE 0 END,
        0, l.started_at, CASE WHEN l.status = 'done' AND l.outcome = 'landed' THEN l.ended_at END, coalesce(l.ended_at, l.started_at, l.requested_at)
      FROM lessons l WHERE l.user_id = ?1 AND l.topic_id IS NOT NULL AND coalesce(l.kind, 'lesson') <> 'pair_test'
        AND coalesce(l.ended_at, l.started_at, l.requested_at) >= ?2
      UNION ALL SELECT topic_id, day, 0, 0, 0, 0, 1, NULL, NULL, at FROM evidence
        WHERE user_id = ?1 AND slot = 0 AND held = 0 AND topic_id IS NOT NULL AND at >= ?3 AND kind = 'question' AND result IN ('wrong','flawed','omitted')
          AND coalesce(error_type, '') NOT IN ('misread','test_taking')
    ) GROUP BY topic_id HAVING passes >= 1 OR abandoned >= 1 OR misses >= 3) g
  JOIN topics t ON t.user_id = ?1 AND t.id = g.topic_id AND t.status IN ('proposed','confirmed')
  ORDER BY g.topic_id LIMIT 500`;

/**
 * The avoidance read as one prepared statement, for a caller's own D1 batch (rankTopicsFor's one query). Before
 * migration 0015 it is a statement that returns nothing. opts: {now, today}.
 */
export async function avoidanceStatement(env, user, { now = Date.now(), today = londonDay(now) } = {}) {
  const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
  if (!has.has('teach_offers') || !has.has('teach_skips')) return env.DB.prepare(NONE_SQL).bind(user, user);
  return env.DB.prepare(AVOID_SQL).bind(user, now - AVOID_RULES.passed.days * DAY_MS, now - AVOID_RULES.unstudied.days * DAY_MS, today);
}

/** One topic's avoidance from its read row (pure): {topic_id, name, score, rules: [{rule, n}], line} or null. */
export function avoidanceOf(row, now = Date.now()) {
  if (!row || !row.topic_id) return null;
  const n = k => Number(row[k]) || 0;
  const rules = [];
  let score = 0;
  const add = (rule, count) => {
    const r = AVOID_RULES[rule];
    score += r.base + r.step * Math.min(Math.max(0, count - r.min), r.steps);
    rules.push({ rule, n: count });
  };
  if (n('passes') >= AVOID_RULES.passed.min && n('chosen') === 0 && !(row.last_lesson_at && row.first_pass_at && row.last_lesson_at > row.first_pass_at)) add('passed', n('passes'));
  if (n('abandoned') >= AVOID_RULES.abandoned.min && !(row.landed_at && row.last_abandon_at && row.landed_at > row.last_abandon_at)) add('abandoned', n('abandoned'));
  if (n('misses') >= AVOID_RULES.unstudied.min && !(row.last_lesson_at && row.last_lesson_at >= now - AVOID_RULES.unstudied.days * DAY_MS)) add('unstudied', n('misses'));
  if (!rules.length) return null;
  return { topic_id: row.topic_id, name: row.name || row.topic_id, category_id: row.category_id || null, score: round2(Math.min(1, score)), rules, line: avoidLine(row.name || row.topic_id, rules) };
}

/** The honest line for the strongest rule: "You've passed on X four times". */
export function avoidLine(name, rules) {
  const r = rules[0];
  if (!r) return null;
  if (r.rule === 'passed') return `You've passed on ${name} ${times(r.n)}.`;
  if (r.rule === 'abandoned') return `You've stopped ${name} ${times(r.n)} before the end.`;
  return `${r.n} misses on ${name} in 30 days, and no lesson on it yet.`;
}

/** Rows -> Map(topic_id -> avoidance), only topics a rule fires for. */
export function avoidanceFromRows(rows, now = Date.now()) {
  const out = new Map();
  for (const r of rows || []) { const a = avoidanceOf(r, now); if (a) out.set(a.topic_id, a); }
  return out;
}

/** teach_next's bounded lift (for the integrator's rankTopics): 1 to 1.05. It can never lift a lower lane over a higher one. */
export const avoidFactor = score => 1 + AVOID_MAX * Math.max(0, Math.min(1, Number(score) || 0));

/** The avoidance of every topic a rule fires for, as a Map. */
export async function avoidanceFor(env, user, { now = Date.now() } = {}) {
  try {
    const st = await avoidanceStatement(env, user, { now });
    return avoidanceFromRows((await st.all()).results || [], now);
  } catch (e) {
    if (noTable(e)) return new Map();
    throw e;
  }
}

// ================================================================ the offer (pure)

const lane = row => laneOf(yieldOf(row));
const laneWord = l => (l === 'off' ? 'Off list' : `Lane ${l}`);
const cutReason = s => (s.length > REASON_MAX ? s.slice(0, REASON_MAX - 1).replace(/\s·?\s*\S*$/, '') + '…' : s);

export function topReason(row, servedBy = 'pick', { lanes = true } = {}) {
  const bits = lanes ? [laneWord(row.lane || lane(row))] : [];
  if (lanes && row.mehlman_rank) bits.push(`Mehlman #${row.mehlman_rank}`);
  if (lanes && examRankText(row.nbme_rank ?? null, row.cms_rank ?? null)) bits.push(examRankText(row.nbme_rank ?? null, row.cms_rank ?? null));
  bits.push(row.seen && row.t != null ? `weakness ${Math.round(Number(row.t) * 100)}` : 'never seen');
  if (row.misses_60d) bits.push(`${row.misses_60d} miss${row.misses_60d === 1 ? '' : 'es'}/60 d`);
  if (row.sure_wrong_60d) bits.push(`${row.sure_wrong_60d} sure-wrong`);
  if (row.overdue) bits.push('a miss to check again');
  if (servedBy === 'request') bits.push('tapped');
  if (servedBy === 'gap') bits.push('gap logged');
  if (lanes && !(row.seen && row.t != null)) bits.push(`yield ${round2(yieldOf(row)).toFixed(2)}`);   // a number even for an unseen topic
  return cutReason(bits.join(' · '));
}

/** The contrast's reason: lane, days unseen, the avoidance counts, yield (lanes false: as topReason). */
export function contrastReason(c, { lanes = true } = {}) {
  const bits = lanes ? [laneWord(c.lane || lane(c))] : [];
  if (lanes && c.mehlman_rank) bits.push(`Mehlman #${c.mehlman_rank}`);
  if (lanes && examRankText(c.nbme_rank ?? null, c.cms_rank ?? null)) bits.push(examRankText(c.nbme_rank ?? null, c.cms_rank ?? null));
  bits.push(c.never_seen ? 'never seen' : c.unseen_days != null ? `unseen ${c.unseen_days} d` : 'seen lately');
  for (const r of (c.avoid && c.avoid.rules) || []) {
    if (r.rule === 'passed') bits.push(`passed ${r.n}×`);
    if (r.rule === 'abandoned') bits.push(`stopped ${r.n}×`);
    if (r.rule === 'unstudied') bits.push(`${r.n} misses/30 d, no lesson`);
  }
  if (lanes) bits.push(`yield ${round2(yieldOf(c)).toFixed(2)}`);
  return cutReason(bits.join(' · '));
}

export function pickContrast(cands, { exclude = new Set(), category = null, avoid = new Map(), now = Date.now(), phase = null } = {}) {
  const elig = [];
  for (const c of cands || []) {
    if (!c || exclude.has(c.id) || c.band === 'strong' || c.taught_today_at) continue;
    if (c.status && !['proposed', 'confirmed'].includes(c.status)) continue;
    if (c.landed_at && !(c.last_miss_at && c.last_miss_at > c.landed_at)) continue;
    const l = lane(c);
    if (phase && phase.lanes && !phase.lanes.includes(l)) continue;
    const av = avoid.get(c.id) || null;
    const never = !c.seen || !c.last_seen_at;
    const days = never ? null : Math.floor((now - c.last_seen_at) / DAY_MS);
    if (!(av && av.score > 0) && !(never || days >= LONG_UNSEEN_DAYS)) continue;
    elig.push({ ...c, lane: l, avoid: av, never_seen: never, unseen_days: days, score: yieldOf(c) * (1 + CONTRAST_AVOID * (av ? av.score : 0)) });
  }
  const age = c => (c.never_seen ? Infinity : c.unseen_days);
  elig.sort((a, b) => b.score - a.score || age(b) - age(a) || String(a.id).localeCompare(String(b.id)));
  return elig.find(c => c.category_id !== category) || elig[0] || null;
}

const offerRow = (slot, pick, t, reason, why) => ({ slot, pick, topic_id: t.id, topic_name: t.name, category_id: t.category_id || null, reason, why });

/**
 * The day's two options (pure). data: rankTopicsFor's result; cands, avoid: as pickContrast. Returns
 * {rest: true} on a rest day, {none: true} when nothing fits, else {options: [a, b?]}.
 */
export function pickOffer(data, { cands = [], avoid = new Map(), now = Date.now(), skip = new Set() } = {}) {
  if (!data || !data.ok) return { none: true };
  if (data.phase && data.phase.rest) return { rest: true };
  // One list (1 Nov 2026): the planner's top two, a lesson or a pair test each.
  if (data.planner) {
    const items = nextUp(data, { limit: 2, skip });
    if (!items.length) return { none: true };
    return { options: items.map((it, i) => offerRow(i ? 'b' : 'a', i ? 'runner_up' : 'top', { id: it.topic_id, name: itemName(it), category_id: it.row.category_id || null },
      topReason(it.row), { served_by: 'pick', kind: it.kind, ...(it.partner_id ? { partner_id: it.partner_id } : {}), lane: it.row.lane || lane(it.row),
        mehlman_rank: it.row.mehlman_rank || null, t100: it.row.seen && it.row.t != null ? Math.round(it.row.t * 100) : null })) };
  }
  const chosen = choose(data, { now, skip });
  if (chosen.rest) return { rest: true };
  const top = chosen.topic_id && skip.has(chosen.topic_id) ? {} : chosen;
  const options = [];
  const exclude = new Set(skip);
  let category = null;
  const lanes = { lanes: !data.laneless };
  if (top.topic_id && top.row) {
    const row = top.row;
    options.push(offerRow('a', 'top', { id: top.topic_id, name: row.name, category_id: row.category_id }, topReason(row, top.served_by, lanes),
      { served_by: top.served_by, lane: row.lane || lane(row), mehlman_rank: row.mehlman_rank || null, t100: row.seen && row.t != null ? Math.round(row.t * 100) : null,
        misses_60d: row.misses_60d || 0, sure_wrong_60d: row.sure_wrong_60d || 0, gain: row.gain != null ? Math.round(row.gain * 1000) / 1000 : null }));
    exclude.add(top.topic_id);
    if (top.pair && top.pair.topic_id) exclude.add(top.pair.topic_id);
    category = row.category_id || null;
  }
  const phase = data.phase || null;
  const contrast = pickContrast(cands, { exclude, category, avoid, now, phase });
  if (contrast) {
    const slot = options.length ? 'b' : 'a';
    options.push(offerRow(slot, 'contrast', contrast, contrastReason(contrast, lanes), {
      lane: contrast.lane, unseen_days: contrast.unseen_days, never_seen: contrast.never_seen, yield: round2(yieldOf(contrast)),
      avoid: contrast.avoid ? { score: contrast.avoid.score, rules: contrast.avoid.rules } : null }));
    exclude.add(contrast.id);
    if (slot === 'a') {
      const second = pickContrast(cands, { exclude, category: contrast.category_id, avoid, now, phase });
      if (second) options.push(offerRow('b', 'contrast', second, contrastReason(second, lanes), { lane: second.lane, unseen_days: second.unseen_days,
        never_seen: second.never_seen, yield: round2(yieldOf(second)), avoid: second.avoid ? { score: second.avoid.score, rules: second.avoid.rules } : null }));
    }
  } else if (options.length) {
    // Nothing long unseen or avoided: the best runner-up, from another system when there is one.
    const others = (data.ranked || []).filter(r => !exclude.has(r.topic_id));
    const r = others.find(x => x.category_id !== category) || others[0];
    if (r) options.push(offerRow('b', 'runner_up', { id: r.topic_id, name: r.name, category_id: r.category_id }, topReason(r, 'pick', lanes), { lane: r.lane, gain: Math.round(r.gain * 1000) / 1000 }));
  }
  return options.length ? { options } : { none: true };
}

// ================================================================ reads and writes

const OFFER_COLS = `day, slot, topic_id, topic_name, category_id, pick, reason, why_json, state, offered_at, decided_at, via, lesson_id, updated_at`;

/** The candidate topics for the contrast (by yield, 400 at most) and today's offer rows, in one batch. */
async function offerReads(env, user, { now, today }) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const res = await env.DB.batch([
    q(`SELECT t.id, t.name, t.category_id, t.yield, t.status, u.mehlman_rank, ${RANK_COLS}, coalesce(s.seen, 0) AS seen, s.band, s.t, s.last_seen_at, s.last_miss_at,
         (SELECT max(l.ended_at) FROM lessons l WHERE l.user_id = t.user_id AND l.topic_id = t.id AND l.status = 'done' AND l.outcome = 'landed'
            AND coalesce(l.kind, 'lesson') <> 'pair_test') AS landed_at,
         (SELECT max(l.started_at) FROM lessons l WHERE l.user_id = t.user_id AND l.topic_id = t.id AND l.day = ?2 AND l.started_at IS NOT NULL) AS taught_today_at
       FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
       ${rankJoin('u')}
       WHERE t.user_id = ?1 AND t.status IN ('proposed','confirmed') ORDER BY t.yield DESC, t.id LIMIT 400`, user, today),
    q(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`, user, today),
    await avoidanceStatement(env, user, { now, today }),
  ]);
  const [cands, offers, avoid] = res.map(r => r.results || []);
  return { cands, offers, avoid: avoidanceFromRows(avoid, now) };
}

/** Today's offer worked out (no write): {day, rest?, none?, options?, avoid}. */
export async function buildOffer(env, user, { now = Date.now(), skip = new Set() } = {}) {
  const today = londonDay(now);
  const [data, reads] = await Promise.all([nextUpFor(env, user, { now, today }).then(r => r.data), offerReads(env, user, { now, today })]);
  return { day: today, ...pickOffer(data, { cands: reads.cands, avoid: reads.avoid, now, skip }), avoid: reads.avoid, existing: reads.offers };
}

/** Statements that write a day's offer: earlier open offers become ignored, then the two rows (replace: an unchosen offer is redone). */
export function offerStatements(env, user, day, options, { now, replace = false }) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const out = [q(`UPDATE teach_offers SET state = 'ignored', decided_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND day < ?3 AND state = 'open'`, now, user, day)];
  if (replace) out.push(q(`DELETE FROM teach_offers WHERE user_id = ?1 AND day = ?2 AND NOT EXISTS (SELECT 1 FROM teach_offers o WHERE o.user_id = ?1 AND o.day = ?2 AND o.state <> 'open')`, user, day));
  for (const o of options) {
    out.push(q(`INSERT INTO teach_offers (user_id, day, slot, topic_id, topic_name, category_id, pick, reason, why_json, state, offered_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'code', ?, ?) ON CONFLICT (user_id, day, slot) DO NOTHING`,
    user, day, o.slot, o.topic_id, o.topic_name, o.category_id, o.pick, o.reason, JSON.stringify(o.why || {}), now, now, now));
  }
  return out;
}

export async function offerWritten(env, user, offer) {
  return { sent: false, push: offer && offer.push ? offer.push : null };
}

/** The day's rows as the page and Claude see them (pure). */
export function shapeToday(rows, { day, avoid = new Map(), now = Date.now(), rest = false } = {}) {
  if (rest) return { day, state: 'rest', options: [], line: null, push: null, as_of: now };
  const list = (rows || []).slice().sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
  if (!list.length) return { day, state: 'none', options: [], line: null, push: null, as_of: now };
  const chosen = list.find(r => r.state === 'chosen') || null;
  const options = list.map(r => {
    const av = avoid.get(r.topic_id) || null;
    const partner = parse(r.why_json, {}).partner_id || null;
    return { slot: r.slot, pick: r.pick, topic: { id: r.topic_id, name: r.topic_name, category_id: r.category_id }, reason: r.reason, state: r.state,
      prompt: promptFor({ id: r.topic_id, name: r.topic_name, partner_id: partner }), ...(partner ? { kind: 'pair_test', partner_id: partner } : {}), ...(av ? { avoidance: { score: av.score, rules: av.rules, line: av.line } } : {}),
      ...(r.lesson_id ? { lesson_id: r.lesson_id } : {}) };
  });
  const line = (options.find(o => o.avoidance) || {}).avoidance?.line || null;
  const names = options.map(o => o.topic.name);
  return {
    day, state: chosen ? 'chosen' : list.every(r => r.state === 'ignored') ? 'ignored' : 'open', offered_at: list[0].offered_at,
    chosen: chosen ? { topic_id: chosen.topic_id, lesson_id: chosen.lesson_id || null, at: chosen.decided_at, via: chosen.via || null } : null,
    options, line,
    push: chosen ? null : { title: 'Teach me: pick one', body: `${names.join(' or ')}${line ? `. ${line}` : ''}`.slice(0, 200), open: '#home' },
    as_of: now,
  };
}

/**
 * Today's offer (GET /api/teach/today, the 06:00 job). build: write it when the day has none (code's bookkeeping,
 * one writeBatch). Returns shapeToday's answer, or {ready: false} before migration 0015.
 */
export async function todayOffer(env, user, { now = Date.now(), build = true, replace = false, via = 'api:today' } = {}) {
  const day = londonDay(now);
  try {
    const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
    if (!has.has('teach_offers') || !has.has('teach_skips')) return { ready: false, day, note: 'The morning choice arrives with migration 0015.' };
    let rows = (await env.DB.prepare(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`).bind(user, day).all()).results || [];
    const chosen = rows.some(r => r.state !== 'open');
    if (rows.length && build && !replace && !chosen && !rows.some(r => parse(r.why_json, {}).again)) {
      const b = await buildOffer(env, user, { now });
      const same = b.options && b.options.length === rows.length && b.options.every((o, i) => o.topic_id === rows[i].topic_id && o.topic_name === rows[i].topic_name);
      if (!b.rest && b.options && b.options.length && !same) {
        await bookkeeping(env, user, offerStatements(env, user, day, b.options, { now, replace: true }), via);
        rows = (await env.DB.prepare(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`).bind(user, day).all()).results || [];
        return { ready: true, ...shapeToday(rows, { day, avoid: b.avoid, now }) };
      }
    }
    if ((!rows.length && build) || (replace && !chosen)) {
      // "Pick again" passes over the two on screen; with nothing else to offer they stay (changed: false)
      const skip = new Set(replace ? rows.map(r => r.topic_id) : []);
      const b = await buildOffer(env, user, { now, skip });
      if (b.rest) return { ready: true, ...shapeToday([], { day, rest: true, now }) };
      if (replace && rows.length && !(b.options && b.options.length)) {
        return { ready: true, changed: false, ...shapeToday(rows, { day, avoid: await avoidanceFor(env, user, { now }), now }) };
      }
      if (b.options && b.options.length) {
        const opts = replace ? b.options.map(o => ({ ...o, why: { ...(o.why || {}), again: true } })) : b.options;
        await bookkeeping(env, user, offerStatements(env, user, day, opts, { now, replace }), via);
        rows = (await env.DB.prepare(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`).bind(user, day).all()).results || [];
        const shaped = { ready: true, ...(replace ? { changed: true } : {}), ...shapeToday(rows, { day, avoid: b.avoid, now }) };
        await offerWritten(env, user, shaped).catch(() => null);
        return shaped;
      }
      return { ready: true, ...shapeToday([], { day, now }) };
    }
    const avoid = rows.length ? await avoidanceFor(env, user, { now }) : new Map();
    return { ready: true, ...shapeToday(rows, { day, avoid, now }) };
  } catch (e) {
    if (noTable(e)) return { ready: false, day, note: 'The map is not set up yet.' };
    throw e;
  }
}

/** The 06:00 minute job (sync.js, at 06:00, 06:05 and 06:10 London): writes today's offer once. */
export async function morningJob(env, user, { now = Date.now() } = {}) {
  const r = await todayOffer(env, user, { now, build: true, via: 'cron:morning' });
  return { day: r.day, state: r.state || null, n: (r.options || []).length };
}


/**
 * Planner for op today.pick {topic_id, device?}: lesson.request's planner (a requested lesson teach_next serves
 * first), today's offer rows set chosen and declined, and a lesson requested from an earlier pick today closed
 * (abandoned, changed_mind). Not undoable (a tap, like lesson.request).
 */
export async function planTodayPick(env, user, args, ctx) {
  for (const k of Object.keys(args || {})) if (!['topic_id', 'device'].includes(k)) return { refuse: `Unknown field ${k}.` };
  if (typeof args.topic_id !== 'string' || !args.topic_id || args.topic_id.length > 120) return { refuse: 'topic_id is needed.', field: 'topic_id' };
  const now = ctx.now || Date.now();
  const day = londonDay(now);
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`).bind(user, day).all()).results || [];
  } catch (e) {
    if (noTable(e)) return { refuse: 'The morning choice is not set up yet.' };
    throw e;
  }
  if (!rows.length) return { refuse: 'There is no offer for today yet.', field: 'topic_id' };
  const pick = rows.find(r => r.topic_id === args.topic_id);
  if (!pick) return { refuse: "That topic is not one of today's two.", field: 'topic_id' };
  const pairWith = parse(pick.why_json, {}).partner_id || null;   // a pair test from the one list
  const req = await planLessonRequest(env, user, { topic_id: pick.topic_id, from: 'map', ...(pairWith ? { pair_topic_id: pairWith, kind: 'pair_test' } : {}),
    ...(args.device ? { device: args.device } : {}) }, ctx);
  if (req.refuse) return req;
  const lessonId = req.reply && req.reply.lesson_id;
  const out = (req.rows || []).map(r => (r.table === 'lessons' && r.op === 'insert' ? { ...r, after: { ...r.after, request_from: 'today', requested_by: 'today' } }
    : r.table === 'lessons' && r.op === 'update' ? { ...r, after: { ...r.after, request_from: 'today' } } : r));
  const prev = rows.find(r => r.state === 'chosen' && r.topic_id !== pick.topic_id && r.lesson_id);
  for (const r of rows) {
    const state = r.topic_id === pick.topic_id ? 'chosen' : 'declined';
    const lid = state === 'chosen' ? lessonId || null : null;
    if (r.state === state && (r.lesson_id || null) === lid) continue;
    out.push({ table: 'teach_offers', op: 'update', key: { day: r.day, slot: r.slot },
      before: { state: r.state, decided_at: r.decided_at ?? null, via: r.via ?? null, lesson_id: r.lesson_id ?? null, updated_at: r.updated_at },
      after: { state, decided_at: now, via: 'web', lesson_id: lid, updated_at: now } });
  }
  if (prev) {
    const l = await env.DB.prepare(`SELECT id, status, abandon_reason, ended_at, updated_at FROM lessons WHERE user_id = ? AND id = ?`).bind(user, prev.lesson_id).first();
    if (l && l.status === 'requested' && l.id !== lessonId) {
      out.push({ table: 'lessons', op: 'update', key: { id: l.id }, before: { status: l.status, abandon_reason: l.abandon_reason ?? null, ended_at: l.ended_at ?? null, updated_at: l.updated_at },
        after: { status: 'abandoned', abandon_reason: 'changed_mind', ended_at: now, updated_at: now } });
    }
  }
  const summary = `Today's choice: ${pick.topic_name || pick.topic_id}`.slice(0, 160);
  return { rows: out, events: (req.events || []).map(e => ({ ...e, summary })), count: 1, summary, reply: { ...(req.reply || {}), day, chosen: pick.topic_id } };
}

// ================================================================ routes

// GET /api/teach/today -> today's two options (made now when the 06:00 job has not run yet).
export async function todayRoute(request, env, ctx, params, url, user) {
  return json(await todayOffer(env, user, { build: url.searchParams.get('build') !== '0' }));
}

// POST /api/teach/today/choose {topic_id, device?} -> {lesson_id, prompt, reused, day, chosen, today}
export async function todayChooseRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'today.pick', args: isObj(body) ? body : {}, via: 'api:POST /api/teach/today/choose' });
  if (!r.ok) return changeResponse(r);
  return json({ lesson_id: r.lesson_id, prompt: r.prompt, reused: !!r.reused, day: r.day, chosen: r.chosen, seq: r.seq ?? null, today: await todayOffer(env, user, { build: false }) });
}

export async function todayMoreRoute(request, env, ctx, params, url, user) {
  const now = Date.now(), today = londonDay(now);
  const n = Math.max(1, Math.min(20, Number(url.searchParams.get('n')) || 8));
  let rows = [];
  try { rows = (await env.DB.prepare(`SELECT topic_id FROM teach_offers WHERE user_id = ? AND day = ?`).bind(user, today).all()).results || []; }
  catch (e) { if (!noTable(e)) throw e; }
  const skip = new Set(rows.map(r => r.topic_id));
  let data = null;
  try { data = (await nextUpFor(env, user, { now, today })).data; } catch (e) { if (!noTable(e)) throw e; }
  if (!data || !data.ok || (data.phase && data.phase.rest)) return json({ day: today, more: [] });
  // The one list after today's two (nextUp), so the scroll goes on in the same order.
  const more = nextUp(data, { limit: n, skip })
    .map(it => ({ topic: { id: it.topic_id, name: itemName(it), category_id: it.row.category_id }, reason: topReason(it.row),
      prompt: promptFor({ id: it.topic_id, name: itemName(it), partner_id: it.partner_id || null }), ...(it.partner_id ? { kind: 'pair_test', partner_id: it.partner_id } : {}) }));
  return json({ day: today, more });
}

// POST /api/teach/today/refresh -> today's offer worked out again, unless one is already chosen.
export async function todayRefreshRoute(request, env, ctx, params, url, user) {
  return json(await todayOffer(env, user, { build: true, replace: true, via: 'api:today.refresh' }));
}

// ================================================================ teach_next's hooks

/**
 * For a plain "teach me" (teach_next's own pick): today's offer while it is open, no lesson has started since it was made
 * and its first is still the pick (top), as {day, options: [{topic, reason, prompt, line?}], line}; else null. Never a write.
 */
export async function offerForTeachNext(env, user, { now = Date.now(), top = null } = {}) {
  const day = londonDay(now);
  const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
  if (!has.has('teach_offers') || !has.has('teach_skips')) return null;
  const [o, started] = await env.DB.batch([
    env.DB.prepare(`SELECT ${OFFER_COLS} FROM teach_offers WHERE user_id = ? AND day = ? ORDER BY slot`).bind(user, day),
    env.DB.prepare(`SELECT max(started_at) AS at FROM lessons WHERE user_id = ? AND day = ? AND started_at IS NOT NULL`).bind(user, day),
  ]);
  const rows = o.results || [];
  if (rows.length < 2 || rows.some(r => r.state !== 'open')) return null;
  // One list (1 Nov 2026): an offer whose first is no longer the list's top (made before a change nobody opened Home for)
  // is not offered; the plain pick, the list's top, is served instead.
  if (top && rows[0].topic_id !== top) return null;
  const startedAt = ((started.results || [])[0] || {}).at;
  if (startedAt && startedAt >= rows[0].offered_at) return null;
  const avoid = await avoidanceFor(env, user, { now });
  const shaped = shapeToday(rows, { day, avoid, now });
  return { day, options: shaped.options.map(x => ({ topic: { id: x.topic.id, name: x.topic.name }, reason: x.reason, prompt: x.prompt, ...(x.avoidance ? { line: x.avoidance.line } : {}) })), line: shaped.line };
}

/** A lesson started on one of today's open options: that one chosen, the other declined (one statement, code's bookkeeping). */
export async function noteLessonStart(env, user, { topicId, lessonId = null, now = Date.now(), via = 'chat' } = {}) {
  if (!topicId) return { noted: false };
  const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
  if (!has.has('teach_offers')) return { noted: false };
  const day = londonDay(now);
  const st = env.DB.prepare(`UPDATE teach_offers SET state = CASE WHEN topic_id = ?3 THEN 'chosen' ELSE 'declined' END, decided_at = ?4, via = ?5,
      lesson_id = CASE WHEN topic_id = ?3 THEN ?6 ELSE NULL END, updated_at = ?4
    WHERE user_id = ?1 AND day = ?2 AND state = 'open'
      AND EXISTS (SELECT 1 FROM teach_offers o WHERE o.user_id = ?1 AND o.day = ?2 AND o.topic_id = ?3 AND o.state = 'open')`)
    .bind(user, day, topicId, now, String(via).slice(0, 20), lessonId);
  await bookkeeping(env, user, [st], 'mcp:teach_next');
  return { noted: true };
}

/** "next" in a lesson (teach_next {skip}): each skipped topic is a pass for the day (one upsert). */
export async function noteSkips(env, user, { ids = [], now = Date.now(), via = 'chat' } = {}) {
  const list = [...new Set((ids || []).filter(x => typeof x === 'string' && x).map(String))].slice(0, 10);
  if (!list.length) return { noted: 0 };
  const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
  if (!has.has('teach_skips')) return { noted: 0 };
  const st = env.DB.prepare(`INSERT INTO teach_skips (user_id, day, topic_id, n, at, via, created_at, updated_at)
      SELECT ?1, ?2, t.id, 1, ?3, ?4, ?3, ?3 FROM topics t WHERE t.user_id = ?1 AND t.id IN (SELECT value FROM json_each(?5))
    ON CONFLICT (user_id, day, topic_id) DO UPDATE SET n = teach_skips.n + 1, at = excluded.at, updated_at = excluded.updated_at`)
    .bind(user, londonDay(now), now, String(via).slice(0, 20), JSON.stringify(list));
  await bookkeeping(env, user, [st], 'mcp:teach_next');
  return { noted: list.length };
}

/** Run a hook in waitUntil (or now), never failing the caller. */
export function hookLater(ctx, p) {
  const safe = Promise.resolve(p).catch(e => { if (!noTable(e)) console.error('morning hook failed', e && e.message); });
  const wu = waitUntilOf(ctx);
  if (wu) wu(safe);
  return safe;
}

// ================================================================ the Teaching page

export async function avoidanceSection(env, user, { now = Date.now() } = {}) {
  const has = await tablesPresent(env, user, ['teach_offers', 'teach_skips']);
  if (!has.has('teach_offers') || !has.has('teach_skips')) return { ready: false, rules: AVOID_TEXT, topics: [], note: 'The morning choice arrives with migration 0015.' };
  const since = now - 60 * DAY_MS;
  const [a, c] = await env.DB.batch([
    await avoidanceStatement(env, user, { now }),
    env.DB.prepare(`SELECT state, count(*) AS n FROM teach_offers WHERE user_id = ? AND offered_at >= ? GROUP BY state
      UNION ALL SELECT 'skipped', coalesce(sum(n), 0) FROM teach_skips WHERE user_id = ? AND at >= ?`).bind(user, since, user, since),
  ]);
  const topics = [...avoidanceFromRows(a.results || [], now).values()].sort((x, y) => y.score - x.score || String(x.topic_id).localeCompare(String(y.topic_id)));
  const counts = { offered: 0, chosen: 0, declined: 0, ignored: 0, open: 0, skipped: 0 };
  for (const r of c.results || []) { counts[r.state] = (counts[r.state] || 0) + (Number(r.n) || 0); if (r.state !== 'skipped') counts.offered += Number(r.n) || 0; }
  const decided = counts.chosen + counts.declined + counts.ignored;
  return {
    ready: true, rules: AVOID_TEXT, counts, chosen_rate: decided ? round2(counts.chosen / decided) : null,
    topics: topics.slice(0, 20).map(t => ({ topic_id: t.topic_id, name: t.name, score: t.score, rules: t.rules, line: t.line })),
    line: topics.length ? topics[0].line : null,
  };
}

export { phaseFor, daysLeft };
