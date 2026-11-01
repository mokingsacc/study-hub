import { buildState, readScore, loadForScore } from './weakness.js';
import { heldRows, LINKED_RIGHTS_SQL, CONCEPTS_OF_SQL } from './concept-held.js';
import { logLoss, brier, bootstrapByDay, wilson } from './honesty-stats.js';
import {
  withWeightSet, champion, challenger, testIdOf, currentTestId, resolveLive, ensureLiveSet, liveSet, setById, LIVE_KEY, isChallenger,
} from './weight-sets.js';
import { getSettings } from '../db.js';
import { noteJob } from '../job-log.js';
import { MO } from '../users.js';
import { json, readJson, londonDay } from '../util.js';

// decile_z: a tenth counts as off only when its mean chance is also outside this Wilson interval of its right rate (99%),
// so 40 answers' worth of chance never blocks a better rule.
export const SHADOW = { min_n: 200, max_n: 1000, decile_margin: 0.05, decile_z: 2.576, bins: 10, targets: 300, topics: 20, ms: 8_000, write: 80 };
export const SOURCE = 'map.shadow';                 // sync_state: {more, test_id, at} while a backlog lasts
export const DROPPED_KEY = 'scoring_dropped';
export const VERDICTS = ['collecting', 'better', 'not_better'];

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const r6 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const plural = (n, w) => `${n.toLocaleString('en-GB')} ${w}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ the replay (pure but for the swap)

/** The topic's evidence strictly before the answer, never its own observation, never held (as honesty.js forecastFor). */
export function beforeRows(target, rows) {
  const at = Number(target.at);
  return (rows || []).filter(r => r && Number(r.held) !== 1 && r.obs_key !== target.obs_key && Number(r.at) < at);
}

/** One answer's chances under the set now applied: p ungated, c the colour's (gated mastery; p when unseen). */
function chanceNow(item, base, model) {
  const at = Number(item.target.at);
  const { state } = buildState(item.before, at, model(base));
  const s = readScore(state, at, item.m0);
  const p = 1 - Number(s.weakness_raw);
  const c = s.seen && s.mastery != null ? Number(s.mastery) : p;
  return { p: r6(p), c: r6(c) };
}

export function predictPairs(items, base, { champion: a = champion(), challenger: b = challenger() } = {}) {
  const A = withWeightSet(a, ({ model }) => items.map(it => chanceNow(it, base, model)));
  const B = withWeightSet(b, ({ model }) => items.map(it => chanceNow(it, base, model)));
  return items.map((_, i) => ({ p_champion: A[i].p, c_champion: A[i].c, p_challenger: B[i].p, c_challenger: B[i].c }));
}

// ------------------------------------------------------------------ the verdict (pure)

/** Calibration by tenths: equal-count groups by p, each {k, n, mean_p, rate, err = |mean_p - rate|} (null when empty). */
export function decileErrors(ps, ys, bins = SHADOW.bins) {
  const idx = ps.map((_, i) => i).sort((i, j) => ps[i] - ps[j]);
  const n = idx.length, out = [];
  for (let k = 0; k < bins; k++) {
    const g = idx.slice(Math.floor((k * n) / bins), Math.floor(((k + 1) * n) / bins));
    if (!g.length) { out.push(null); continue; }
    const mp = mean(g.map(i => ps[i])), k1 = g.reduce((t, i) => t + ys[i], 0), rate = k1 / g.length;
    const [lo, hi] = wilson(k1, g.length, SHADOW.decile_z);
    out.push({ k: k + 1, n: g.length, mean_p: r4(mp), rate: r4(rate), err: r4(Math.abs(mp - rate)), outside: mp < lo || mp > hi });
  }
  return out;
}

// Two log losses as words: two decimals, or three when two would read the same ("0.52 vs 0.55").
export function pairWords(a, b) {
  const d = Number(a).toFixed(2) === Number(b).toFixed(2) ? 3 : 2;
  return `${Number(a).toFixed(d)} vs ${Number(b).toFixed(d)}`;
}

/**
 * The test's report from its scored answers (pure). rows: [{day, at, y, phase, p_champion, p_challenger, c_champion,
 * c_challenger}]. opts: {backtest_done, champion_id, challenger_id, min_n, max_n, margin}. Returns {n, n_backtest, n_live,
 * days, log_loss: {champion, challenger}, brier, recall_log_loss, diff: {mean, lo, hi}, deciles: [{k, champion, challenger,
 * worse_by}], worst_decile, verdict, reason, text}.
 */
export function shadowReport(rows, { backtest_done = true, champion_id = 'v?', challenger_id = 'v?', min_n = SHADOW.min_n, max_n = SHADOW.max_n,
  margin = SHADOW.decile_margin, what = 'answer' } = {}) {
  const list = (rows || []).filter(r => r && (Number(r.y) === 0 || Number(r.y) === 1) && Number.isFinite(Number(r.c_champion)) && Number.isFinite(Number(r.c_challenger)));
  const n = list.length;
  const ys = list.map(r => Number(r.y));
  const llA = list.map((r, i) => logLoss(Number(r.c_champion), ys[i])), llB = list.map((r, i) => logLoss(Number(r.c_challenger), ys[i]));
  const out = {
    champion: champion_id, challenger: challenger_id, n, n_backtest: list.filter(r => r.phase === 'backtest').length, n_live: list.filter(r => r.phase === 'live').length,
    days: new Set(list.map(r => r.day)).size, backtest_done: !!backtest_done, min_n, max_n,
    log_loss: { champion: r4(mean(llA)), challenger: r4(mean(llB)) },
    brier: { champion: r4(mean(list.map((r, i) => brier(Number(r.c_champion), ys[i])))), challenger: r4(mean(list.map((r, i) => brier(Number(r.c_challenger), ys[i])))) },
    recall_log_loss: { champion: r4(mean(list.map((r, i) => logLoss(Number(r.p_champion), ys[i])))), challenger: r4(mean(list.map((r, i) => logLoss(Number(r.p_challenger), ys[i])))) },
    diff: null, deciles: [], worst_decile: null, breach: null, verdict: 'collecting', reason: 'too_few', text: '',
  };
  const ll = n ? pairWords(out.log_loss.challenger, out.log_loss.champion) : null;
  if (n) {
    const d = list.map((r, i) => ({ day: r.day, d: llB[i] - llA[i] }));
    const ci = bootstrapByDay(d);
    out.diff = ci ? { mean: r4(ci.mean), lo: r4(ci.lo), hi: r4(ci.hi) } : { mean: r4(mean(d.map(x => x.d))), lo: null, hi: null };
    const A = decileErrors(list.map(r => Number(r.c_champion)), ys), B = decileErrors(list.map(r => Number(r.c_challenger)), ys);
    out.deciles = A.map((a, i) => (a && B[i] ? { k: a.k, n: a.n, champion: a.err, challenger: B[i].err, worse_by: r4(B[i].err - a.err), outside: B[i].outside } : null)).filter(Boolean);
    out.worst_decile = out.deciles.length ? out.deciles.reduce((m, x) => (x.worse_by > m.worse_by ? x : m)) : null;
    out.breach = out.deciles.find(x => x.worse_by > margin && x.outside) || null;
  }
  const same = n > 0 && list.every((r, i) => Math.abs(llB[i] - llA[i]) < 1e-9);
  const ci = out.diff;
  const breach = !!out.breach;
  const head = `Shadow test of rules ${challenger_id}`;
  const N = plural(n, what);
  if (n < min_n || !backtest_done) {
    out.reason = 'too_few';
    out.text = `${head}: ${n < min_n ? `${N} of ${min_n} scored so far` : `${N} scored`}${backtest_done ? '' : ', past answers still being replayed'}; no verdict yet`;
  } else if (same) {
    Object.assign(out, { verdict: 'not_better', reason: 'same', text: `The new scoring rule gives the same chances on these ${N}; kept the current one` });
  } else if (ci && ci.lo != null && ci.lo > 0) {
    Object.assign(out, { verdict: 'not_better', reason: 'worse', text: `The new scoring rule was not better: ${ll} on ${N}; kept the current one` });
  } else if (ci && ci.hi != null && ci.hi < 0 && !breach) {
    Object.assign(out, { verdict: 'better', reason: 'better', text: `New scoring rule predicts your answers better: ${ll} on ${N}` });
  } else if (n >= max_n) {
    Object.assign(out, { verdict: 'not_better', reason: breach ? 'calibration' : 'no_difference',
      text: `The new scoring rule was not clearly better on ${N} (${ll})${breach ? ', and it was off in one tenth of your answers' : ''}; kept the current one` });
  } else if (breach && ci && ci.hi != null && ci.hi < 0) {
    Object.assign(out, { reason: 'calibration', text: `${head}: better on average (${ll}) but off by more than ${Math.round(margin * 100)} points in one tenth of your answers, so it stays in shadow` });
  } else {
    Object.assign(out, { reason: 'no_difference', text: `${head}: no clear difference yet on ${N} (${ll}), still testing` });
  }
  return out;
}

// ------------------------------------------------------------------ D1

// Answers the honesty check scored (question stratum) with no shadow pair yet for this test, or whose forecast moved
// (a new time or topic). y is read at report time, so a re-judged answer needs no new pair.
export const PENDING_SQL = `SELECT f.id, f.obs_key, f.slot, f.topic_id, f.at, f.day, f.m0 FROM forecasts f
  LEFT JOIN shadow_scores s ON s.user_id = f.user_id AND s.test_id = ?2 AND s.id = f.id
  WHERE f.user_id = ?1 AND f.retracted = 0 AND f.stratum = 'question' AND (s.id IS NULL OR s.at != f.at OR s.topic_id != f.topic_id)
  ORDER BY f.at LIMIT ?3`;
// The concept checks' rows (scored_on 'concepts'): their forecast id follows 'c|<concept>|'.
export const REPORT_CONCEPT_SQL = `SELECT s.day, s.at, s.phase, s.p_champion, s.p_challenger, s.c_champion, s.c_challenger, f.y FROM shadow_scores s
  JOIN forecasts f ON f.user_id = s.user_id AND f.id = substr(s.id, length(s.topic_id) + 4) AND f.retracted = 0 AND f.at = s.at
  WHERE s.user_id = ?1 AND s.test_id = ?2 AND s.id LIKE 'c|%' ORDER BY s.at`;
export const conceptCheckId = (conceptId, forecastId) => `c|${conceptId}|${forecastId}`;
export const scoredOnConcepts = set => !!set && set.scored_on === 'concepts';
export const REPORT_SQL = `SELECT s.day, s.at, s.phase, s.p_champion, s.p_challenger, s.c_champion, s.c_challenger, f.y FROM shadow_scores s
  JOIN forecasts f ON f.user_id = s.user_id AND f.id = s.id AND f.retracted = 0 AND f.at = s.at
  WHERE s.user_id = ?1 AND s.test_id = ?2 ORDER BY s.at`;
const TEST_SQL = 'SELECT * FROM shadow_tests WHERE user_id = ?1 AND id = ?2';
const SETTING_SQL = 'SELECT key, value FROM settings WHERE key IN (?1, ?2)';
const UPSERT_SCORE = `INSERT INTO shadow_scores (user_id, test_id, id, topic_id, at, day, phase, p_champion, p_challenger, c_champion, c_challenger, scored_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT (user_id, test_id, id) DO UPDATE SET topic_id = excluded.topic_id, at = excluded.at, day = excluded.day, phase = excluded.phase,
    p_champion = excluded.p_champion, p_challenger = excluded.p_challenger, c_champion = excluded.c_champion, c_challenger = excluded.c_challenger,
    scored_at = excluded.scored_at`;

function settingsOf(rows) {
  const by = new Map((rows || []).map(r => [r.key, parse(r.value, null)]));
  return { live: by.get(LIVE_KEY) || null, dropped: Array.isArray(by.get(DROPPED_KEY)) ? by.get(DROPPED_KEY) : [] };
}

/**
 * One page of the shadow test: scores up to `targets` answers (both sets), and when none are left, works out the
 * report, stores it, notes a Recent activity line when the verdict changes and switches by itself when that is set.
 * Returns {scored, pending, more, test_id, verdict?} or {skipped}.
 */
export async function shadowStep(env, user, { now = Date.now(), targets = SHADOW.targets, topics = SHADOW.topics, ms = SHADOW.ms } = {}) {
  const ch = challenger();
  if (!ch) return { skipped: 'no challenger' };
  if (user !== MO) return { skipped: 'the scoring rules are tested on Mo\'s answers' };
  const champ = champion(), testId = testIdOf(ch, champ);
  const start = Date.now();
  const DB = env.DB;
  const [t, p, s] = await DB.batch([
    DB.prepare(TEST_SQL).bind(user, testId),
    DB.prepare(PENDING_SQL).bind(user, testId, targets),
    DB.prepare(SETTING_SQL).bind(LIVE_KEY, DROPPED_KEY),
  ]);
  const st = settingsOf(s.results);
  if (st.dropped.includes(testId)) return { skipped: 'dropped', test_id: testId };
  let test = (t.results || [])[0] || null;
  if (!test) {
    test = { id: testId, started_at: now, backtest_done_at: null, verdict: 'collecting' };
    await DB.prepare(`INSERT INTO shadow_tests (user_id, id, champion, challenger, champion_version, challenger_version, started_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT (user_id, id) DO NOTHING`).bind(user, testId, champ.id, ch.id, champ.version, ch.version, now).run();
  }
  const pending = p.results || [];
  const out = { test_id: testId, scored: 0, pending: pending.length, more: pending.length >= targets };
  const byTopic = new Map();
  for (const f of pending) { if (!byTopic.has(f.topic_id)) byTopic.set(f.topic_id, []); byTopic.get(f.topic_id).push(f); }
  const ids = [...byTopic.keys()];
  for (let i = 0; i < ids.length; i += topics) {
    if (Date.now() - start > ms) { out.more = true; break; }
    const chunk = ids.slice(i, i + topics);
    if (scoredOnConcepts(ch)) {
      out.scored += await conceptChecks(env, user, { chunk, byTopic, testId, test, champ, ch, now });
      continue;
    }
    const data = await loadForScore(env, user, chunk);
    const rowsBy = new Map();
    for (const r of data.rows) { const k = String(r.topic_id); if (!rowsBy.has(k)) rowsBy.set(k, []); rowsBy.get(k).push(r); }
    const items = [];
    for (const topicId of chunk) {
      const rows = rowsBy.get(String(topicId)) || [];
      for (const f of byTopic.get(topicId)) {
        const target = rows.find(r => r.obs_key === f.obs_key && Number(r.slot) === Number(f.slot)) || { obs_key: f.obs_key, slot: f.slot, at: f.at };
        items.push({ f, target: { ...target, at: Number(f.at) }, before: beforeRows({ obs_key: f.obs_key, at: f.at }, rows), m0: Number(f.m0) });
      }
    }
    const pairs = predictPairs(items, data.model, { champion: champ, challenger: ch });
    const writes = items.map((it, k) => DB.prepare(UPSERT_SCORE).bind(user, testId, it.f.id, it.f.topic_id, Number(it.f.at), it.f.day,
      Number(it.f.at) < Number(test.started_at) ? 'backtest' : 'live', pairs[k].p_champion, pairs[k].p_challenger, pairs[k].c_champion, pairs[k].c_challenger, now));
    for (let k = 0; k < writes.length; k += SHADOW.write) await DB.batch(writes.slice(k, k + SHADOW.write));
    out.scored += items.length;
  }
  if (out.more) return out;
  // Every answer so far has its pair: the report, and the verdict.
  const rows = (await DB.prepare(scoredOnConcepts(ch) ? REPORT_CONCEPT_SQL : REPORT_SQL).bind(user, testId).all()).results || [];
  const doneAt = test.backtest_done_at ?? now;
  const rep = shadowReport(rows, { backtest_done: true, champion_id: champ.id, challenger_id: ch.id, what: scoredOnConcepts(ch) ? 'concept check' : 'answer' });
  const prev = test.verdict || 'collecting';
  const changed = rep.verdict !== prev;
  await DB.prepare(`UPDATE shadow_tests SET backtest_done_at = ?3, n = ?4, ll_champion = ?5, ll_challenger = ?6, brier_champion = ?7, brier_challenger = ?8,
      verdict = ?9, verdict_at = CASE WHEN verdict IS ?9 THEN verdict_at ELSE ?10 END, report_json = ?11, updated_at = ?10 WHERE user_id = ?1 AND id = ?2`)
    .bind(user, testId, doneAt, rep.n, rep.log_loss.champion, rep.log_loss.challenger, rep.brier.champion, rep.brier.challenger, rep.verdict, now, JSON.stringify(rep)).run();
  out.verdict = rep.verdict;
  out.report = rep;
  const switched = resolveLive(st.live).id === ch.id;
  let auto = null;
  if (rep.verdict === 'better' && !switched) {
    const settings = await getSettings(env).catch(() => ({}));
    if (settings.scoring_auto_switch === true) {
      const { applyChange } = await import('./change.js');
      auto = await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'scoring.switch', args: { to: ch.id }, via: 'cron:shadow' });
      out.switched = !!(auto && auto.ok);
    }
  }
  if (changed || out.switched) {
    await noteJob(env, { job: 'shadow', user, key: `${testId}:${rep.verdict}`, ref: ch.id, state: 'ok', at: now, detail: rep.text,
      counts: { verdict: rep.verdict, reason: rep.reason, n: rep.n, ll_champion: Math.round(1000 * (rep.log_loss.champion || 0)),
        ll_challenger: Math.round(1000 * (rep.log_loss.challenger || 0)), challenger: ch.id, champion: champ.id, ...(out.switched ? { auto: 1 } : {}),
        ...(switched ? { live: 1 } : {}) } });
  }
  return out;
}

/**
 * One page of concept checks (scored_on 'concepts'): for each pending answer, a pair per concept that underlies its topic,
 * then a marker under the answer's own id. Returns how many answers were scored.
 */
async function conceptChecks(env, user, { chunk, byTopic, testId, test, champ, ch, now }) {
  const DB = env.DB;
  const links = (await DB.prepare(CONCEPTS_OF_SQL).bind(user, JSON.stringify(chunk)).all()).results || [];
  const conceptsOf = new Map();
  for (const l of links) { const k = String(l.topic_id); if (!conceptsOf.has(k)) conceptsOf.set(k, []); conceptsOf.get(k).push(String(l.concept_id)); }
  const concepts = [...new Set(links.map(l => String(l.concept_id)))];
  const items = [];
  let pairs = [];
  if (concepts.length) {
    const [data, linked] = await Promise.all([loadForScore(env, user, concepts), DB.prepare(LINKED_RIGHTS_SQL).bind(user, JSON.stringify(concepts)).all()]);
    const own = new Map(concepts.map(c => [c, []])), rights = new Map(concepts.map(c => [c, []]));
    for (const r of data.rows) if (own.has(String(r.topic_id))) own.get(String(r.topic_id)).push(r);
    for (const r of linked.results || []) if (rights.has(String(r.concept_id))) rights.get(String(r.concept_id)).push(r);
    for (const topicId of chunk) for (const f of byTopic.get(topicId)) for (const c of conceptsOf.get(String(topicId)) || []) {
      const topic = data.topics.get(c), stored = data.stored.get(c);
      const m0 = Number(stored && stored.prior_mastery) || (topic && data.priors[topic.category_id]) || 0.6;
      const rows = [...own.get(c), ...heldRows(c, rights.get(c), { exclude: topicId })];
      items.push({ f, c, target: { obs_key: f.obs_key, slot: f.slot, at: Number(f.at) }, before: beforeRows({ obs_key: f.obs_key, at: f.at }, rows), m0 });
    }
    if (items.length) pairs = predictPairs(items, data.model, { champion: champ, challenger: ch });
  }
  const phaseOf = f => (Number(f.at) < Number(test.started_at) ? 'backtest' : 'live');
  const writes = items.map((it, k) => DB.prepare(UPSERT_SCORE).bind(user, testId, conceptCheckId(it.c, it.f.id), it.c, Number(it.f.at), it.f.day, phaseOf(it.f),
    pairs[k].p_champion, pairs[k].p_challenger, pairs[k].c_champion, pairs[k].c_challenger, now));
  let n = 0;
  for (const topicId of chunk) for (const f of byTopic.get(topicId)) {
    writes.push(DB.prepare(UPSERT_SCORE).bind(user, testId, f.id, f.topic_id, Number(f.at), f.day, phaseOf(f), 0, 0, 0, 0, now));
    n++;
  }
  for (let k = 0; k < writes.length; k += SHADOW.write) await DB.batch(writes.slice(k, k + SHADOW.write));
  return n;
}

/** The minute cron's job: one page, its state kept for the dispatcher, a failure on Recent activity. */
export async function shadowJob(env, user, { now = Date.now(), ms = SHADOW.ms } = {}) {
  if (!challenger()) return { skipped: 'no challenger' };
  try {
    const r = await shadowStep(env, user, { now, ms });
    if (r.skipped && r.skipped !== 'dropped') return r;
    await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, fails, lock_until) VALUES (?1, ?2, ?3, ?4, 0, 0)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`)
      .bind(user, SOURCE, JSON.stringify({ more: r.more ? 1 : 0, test_id: r.test_id || null, at: now }), now).run();
    if (r.more && r.scored) {
      await noteJob(env, { job: 'shadow', user, key: `${r.test_id}:replay:${londonDay(now)}`, ref: challenger().id, state: 'ok', add: true, at: now,
        counts: { scored: r.scored, replay: 1 } });
    }
    return r;
  } catch (e) {
    if (noTable(e)) return { skipped: 'no shadow tables yet' };
    await noteJob(env, { job: 'shadow', user, key: `failed:${londonDay(now)}`, state: 'failed', at: now, detail: e, add: true, counts: { n: 1 } });
    throw e;
  }
}

/**
 * When the minute cron runs the job (sync.js minuteJobsFor): 'off' with no challenger in WEIGHT_SETS; 'due' (each minute)
 * when its test has not started (no state, or a state for another test) or its backlog is not done; else 'idle' (02:09,
 * after the night's forecasts, and beside the honesty check while it has a backlog). cursor: sync_state's text for SOURCE.
 */
export function shadowMode(cursor) {
  const id = currentTestId();
  if (!id) return 'off';
  const c = parse(cursor, null);
  return !c || c.test_id !== id || Number(c.more) === 1 ? 'due' : 'idle';
}

// ------------------------------------------------------------------ what the hub shows

/**
 * The Tidy card for a state (pure): {kind: better | not_better | slipped, text, to?} or null. better: a winner not yet
 * live (Switch); not_better: a loser not dropped (Drop it); slipped: the live challenger no longer clearly better (Switch back).
 */
export function cardOf({ test, switched, dropped, champion_id }) {
  if (!test || dropped) return null;
  const ll = test.log_loss && test.log_loss.challenger != null ? pairWords(test.log_loss.challenger, test.log_loss.champion) : null;
  if (switched) {
    return test.verdict === 'better' || !ll ? null
      : { kind: 'slipped', to: champion_id, text: `The scoring rule you switched to is no longer clearly better (${ll} on ${plural(test.n, 'answer')}). Switch back?` };
  }
  if (test.verdict === 'better') return { kind: 'better', text: `New scoring rule predicts your answers better: ${ll}. Switch?`, sub: `On ${plural(test.n, 'answer')}; Undo puts the old one back.` };
  if (test.verdict === 'not_better') return { kind: 'not_better', text: `Shadow test: ${test.text.replace(/^The new scoring rule/, 'the new rule')}.` };
  return null;
}

/** GET /api/map/scoring's answer: the live rules, the sets, the test's report, the Tidy card. */
export async function scoringState(env, user) {
  const ch = challenger(), champ = champion();
  const live = await ensureLiveSet(env).catch(() => liveSet());
  const out = { live: { id: live.id, version: live.version }, champion: { id: champ.id, version: champ.version, note: champ.note },
    challenger: ch ? { id: ch.id, version: ch.version, note: ch.note, date: ch.date } : null, test: null, switched: false, dropped: false, card: null };
  let settings = {};
  try { settings = await getSettings(env); } catch { settings = {}; }
  out.auto_switch = settings.scoring_auto_switch === true;
  if (!ch) return out;
  const testId = testIdOf(ch, champ);
  try {
    const [t, s] = await env.DB.batch([env.DB.prepare(TEST_SQL).bind(user, testId), env.DB.prepare(SETTING_SQL).bind(LIVE_KEY, DROPPED_KEY)]);
    const st = settingsOf(s.results);
    const row = (t.results || [])[0] || null;
    out.switched = resolveLive(st.live).id === ch.id;
    out.dropped = st.dropped.includes(testId);
    if (row) {
      const rep = parse(row.report_json, {});
      out.test = { id: testId, started_at: row.started_at, backtest_done: row.backtest_done_at != null, n: row.n, verdict: row.verdict, verdict_at: row.verdict_at,
        reason: rep.reason || null, text: rep.text || null, log_loss: rep.log_loss || null, brier: rep.brier || null, diff: rep.diff || null,
        n_backtest: rep.n_backtest ?? null, n_live: rep.n_live ?? null, worst_decile: rep.worst_decile || null };
    } else out.test = { id: testId, n: 0, verdict: 'collecting', text: `Shadow test of rules ${ch.id}: starting` };
  } catch (e) { if (!noTable(e)) throw e; }
  out.card = cardOf({ test: out.test, switched: out.switched, dropped: out.dropped, champion_id: champ.id });
  return out;
}

// ------------------------------------------------------------------ the changes: scoring.switch and scoring.drop

const settingRow = (key, current, value) => (current
  ? { table: 'settings', op: 'update', key: { key }, before: { key, value: current }, after: { value: JSON.stringify(value) } }
  : { table: 'settings', op: 'insert', key: { key }, before: null, after: { key, value: JSON.stringify(value) } });

// Every stored colour not worked out under these rules goes to the recompute queue (drainDirty: 20 topics a minute).
export const dirtySql = `INSERT INTO topic_dirty (user_id, topic_id, reason, at) SELECT user_id, topic_id, 'rules', ?1 FROM topic_scores
  WHERE formula_version IS NOT ?2 ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`;

/**
 * op scoring.switch {to}: the hub setting scoring_set names the set to make live. To the challenger only once its test
 * says better; back to the champion always. One settings row, one event (target 'scoring', so undo recomputes too).
 */
export async function planSwitch(env, user, args) {
  if (user !== MO) return { refuse: 'The scoring rules are Mo\'s to switch.' };
  for (const k of Object.keys(args)) if (k !== 'to') return { refuse: `Unknown argument ${k}.` };
  const ch = challenger(), champ = champion();
  const to = setById(args.to);
  if (!to || (to.id !== champ.id && (!ch || to.id !== ch.id))) return { refuse: `There is no scoring rule ${args.to} to switch to.`, field: 'to' };
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(LIVE_KEY).first();
  const cur = r ? r.value : null;
  const was = resolveLive(parse(cur, null));
  if (was.id === to.id) return { noop: true, summary: `Rules ${to.id} are already in use.` };
  let ll = '';
  if (isChallenger(to)) {
    const t = await env.DB.prepare(TEST_SQL).bind(user, testIdOf(ch, champ)).first();
    if (!t || t.verdict !== 'better') return { refuse: 'The new scoring rule has not yet shown it predicts your answers better, so it stays in shadow.' };
    ll = ` (it predicts your answers better: ${pairWords(t.ll_challenger, t.ll_champion)})`;
  }
  const value = { id: to.id, version: to.version, ...(isChallenger(to) ? { test_id: testIdOf(ch, champ) } : {}) };
  const summary = `Scoring rules switched from ${was.id} to ${to.id}${ll}`.slice(0, 160);
  return { rows: [settingRow(LIVE_KEY, cur, value)], events: [{ target_type: 'scoring', target_id: LIVE_KEY, summary }], summary, count: 1,
    version: to.version, reply: { live: to.id } };
}

// The switch's own write: realtime's writer with the recompute queue in the same batch.
export async function applySwitch(env, user, plan, ctx) {
  const { writeBatch } = await import('./events.js');
  const w = await writeBatch(env, user, { batch_id: ctx.batch_id, actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said,
    request_id: ctx.request_id, rows: plan.rows, events: plan.events.map(e => ({ kind: 'setting.changed', undoable: true, ...e })), undoable: true,
    statements: [env.DB.prepare(dirtySql).bind(ctx.now || Date.now(), plan.version)] });
  await ensureLiveSet(env, { force: true });
  return { ok: true, batch_id: (w && w.batch_id) || ctx.batch_id, seq: w && w.seq, undo_hint: 'Say "undo that" to put the old rules back.', ...(plan.reply || {}) };
}

/** op scoring.drop {test_id?}: the current challenger's test stops; it is reported as dropped. Undoable. */
export async function planDrop(env, user, args) {
  if (user !== MO) return { refuse: 'The scoring rules are Mo\'s.' };
  for (const k of Object.keys(args)) if (k !== 'test_id') return { refuse: `Unknown argument ${k}.` };
  const ch = challenger();
  if (!ch) return { refuse: 'There is no new scoring rule in shadow.' };
  const testId = testIdOf(ch, champion());
  if (args.test_id != null && args.test_id !== testId) return { refuse: 'That shadow test is not the current one.', field: 'test_id' };
  const [s, t] = await env.DB.batch([env.DB.prepare(SETTING_SQL).bind(LIVE_KEY, DROPPED_KEY), env.DB.prepare(TEST_SQL).bind(user, testId)]);
  const st = settingsOf(s.results);
  if (resolveLive(st.live).id === ch.id) return { refuse: 'The new scoring rule is in use: switch back first.' };
  if (st.dropped.includes(testId)) return { noop: true, summary: 'That shadow test was already dropped.' };
  const cur = ((s.results || []).find(r => r.key === DROPPED_KEY) || {}).value ?? null;
  const row = (t.results || [])[0];
  const summary = `Shadow test of rules ${ch.id} dropped${row && row.verdict === 'not_better' ? ': it was not better' : ''}`;
  return { rows: [settingRow(DROPPED_KEY, cur, [...st.dropped, testId].slice(-20))], events: [{ target_type: 'setting', target_id: DROPPED_KEY, summary }], summary, count: 1 };
}

const sameValue = (a, b) => JSON.stringify(parse(a, a ?? null)) === JSON.stringify(parse(b, b ?? null));

/**
 * Undo of a switch (UNDO target:scoring): scoring_set back as it was, and every colour queued for a recompute under the
 * rules that are live again. Refused when the setting changed since.
 */
export async function undoScoring(env, user, e, ctx) {
  const before = parse(e.before_json, null), after = parse(e.after_json, null);
  const key = (after && after.key) || (before && before.key) || LIVE_KEY;
  const cur = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  const want = after && 'value' in after ? after.value : null;
  if (!sameValue(cur ? cur.value : null, want)) return { conflict: 'The scoring rules were switched again since, so this cannot be undone.' };
  const back = before && before.value != null ? before.value : null;
  const rows = back != null
    ? [cur ? { table: 'settings', op: 'update', key: { key }, before: { key, value: cur.value }, after: { value: back } }
      : { table: 'settings', op: 'insert', key: { key }, before: null, after: { key, value: back } }]
    : [{ table: 'settings', op: 'delete', key: { key }, before: cur ? { key, value: cur.value } : null, after: null }];
  // Every isolate reads the setting afresh within a minute (weight-sets.js LIVE_TTL_MS); a colour recomputed under the old
  // rules meanwhile carries the old formula_version, so repairScores sends it back to the queue.
  const version = resolveLive(parse(back, null)).version;
  return { rows, statements: [env.DB.prepare(dirtySql).bind((ctx && ctx.now) || Date.now(), version)] };
}

// ------------------------------------------------------------------ routes

// GET /api/map/scoring: the live rules, the shadow test and the Tidy card.
export async function scoringRoute(request, env, ctx, params, url, user) {
  return json(await scoringState(env, user));
}

// POST /api/map/scoring/run: one page of the shadow test now (the backtest without waiting for the cron), then the state.
export async function scoringRunRoute(request, env, ctx, params, url, user) {
  await readJson(request, 1_000).catch(() => ({}));
  const r = await shadowJob(env, user);
  return json({ run: { scored: r.scored || 0, more: !!r.more, verdict: r.verdict || null, skipped: r.skipped || null }, ...(await scoringState(env, user)) });
}

async function change(env, user, op, args) {
  const { applyChange, changeResponse } = await import('./change.js');
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op, args, via: `api:POST /api/map/scoring/${op.split('.')[1]}` });
  if (r && r.ok) await ensureLiveSet(env, { force: true });
  return changeResponse(r);
}

export async function scoringSwitchRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 1_000).catch(() => ({}));
  return change(env, user, 'scoring.switch', { to: body && body.to != null ? String(body.to) : (challenger() || champion()).id });
}

export async function scoringDropRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 1_000).catch(() => ({}));
  return change(env, user, 'scoring.drop', body && body.test_id ? { test_id: String(body.test_id) } : {});
}

