import { FIT, REVIEW_W, TREND_WORDS, gradeOf, reviewOf } from './fsrs.js';
import { WEIGHTS_VERSION, DAY_MS, GATES, confidenceOf, errorKeyOf } from './weights.js';
import { buildState, readScore, loadForScore, m0For, guessM0 } from './weakness.js';
import { readVersions, versionAt, dryComparison, startingGuessJob, SG } from './starting-guess.js';
import { report as buildReport, selfCalibration, gateLiftLine } from './honesty-stats.js';
import { loadFacetData, facetForecast, FACETS } from './facets.js';
import { MO } from '../users.js';
import { json, readJson, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';

export const SOURCE = 'map.honesty';          // sync_state: {more} while a backlog lasts
export const REPORT_SOURCE = 'map.honesty.report';   // sync_state: the last finished run's report
// One step's reach: answers looked at, topics per read, the time it may take (the minute cron shares its invocation), statements per write.
export const STEP = { targets: 1500, topics: 20, ms: 10_000, write: 80 };

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const lower = v => (v == null ? null : String(v).trim().toLowerCase() || null);
const r6 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
export const forecastId = (obsKey, slot) => `${obsKey}#${Number(slot) || 0}`;

// ------------------------------------------------------------------ pure parts

/** What happened, 1 or 0 (null: the row says nothing). A right answer for a flawed reason is still right. */
export function yOf(row) {
  if (!row) return null;
  if (row.kind === 'question') {
    const r = lower(row.result);
    return r === 'right' || r === 'flawed' ? 1 : r === 'wrong' || r === 'omitted' ? 0 : null;
  }
  if (row.kind === 'retest') {
    const r = lower(row.outcome) || lower(row.result);
    return r === 'got_it' || r === 'right' ? 1 : r === 'missed_again' || r === 'missed' || r === 'wrong' ? 0 : null;
  }
  if (row.kind === 'card_review') {
    const g = gradeOf(row.rating) ?? gradeOf(row.amount);
    return g == null ? null : g >= 2 ? 1 : 0;
  }
  return null;
}

// FNV-1a, so the model's id is the same string on every run with the same settings.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
/** The settings that make a forecast, and their hash (FIT, REVIEW_W, WEIGHTS_VERSION and the FSRS weights in use). */
export function modelParams(model) {
  return { fit: FIT, review_w: REVIEW_W, weights_version: WEIGHTS_VERSION, w: model && model.w ? [...model.w] : null };
}
export const modelId = model => `m${fnv(JSON.stringify(modelParams(model)))}`;

function groupOf(row) {
  if (row.sitting_id) return `s:${row.sitting_id}`;
  const ref = String(row.source_ref || '');
  const m = /^uworld:(.+):q\d+$/.exec(ref);
  if (m) return `uw:${m[1]}`;
  if (row.kind && row.kind.startsWith('card') && row.card_id != null) return `c:${row.card_id}`;
  return `k:${row.obs_key}`;
}

/**
 * One answer's forecast from its topic's live evidence rows. Only rows strictly before the answer count, and none with
 * the answer's own obs_key. ctx: {m0, model, category_id, source, stratum, model_id, now, stored?}. Returns the
 * forecasts row (without user_id), or null when the answer says nothing (no y).
 */
export function forecastFor(target, rows, ctx) {
  const y = yOf(target);
  if (y == null) return null;
  const at = Number(target.at);
  const before = (rows || []).filter(r => r && Number(r.held) !== 1 && r.obs_key !== target.obs_key && Number(r.at) < at);
  const { state } = buildState(before, at, ctx.model);
  const s = readScore(state, at, ctx.m0);
  const p = 1 - Number(s.weakness_raw);
  const real = before.filter(r => { const rv = reviewOf(r); return rv && rv.real && yOf(r) != null; }).sort((a, b) => Number(a.at) - Number(b.at));
  const last = real[real.length - 1] || null;
  const fs = state.fsrs;
  const neff = fs ? fs.n * (ctx.model.cfg.fade_days ? Math.pow(2, -Math.max(0, (at - fs.at) / DAY_MS) / ctx.model.cfg.fade_days) : 1) : 0;
  const g = groupOf(target);
  const feedback = before.some(r => r.day === target.day && groupOf(r) !== g);
  // The stored score's p, when the score was last worked out before this answer reached the map (rare after the fact).
  const st = ctx.stored;
  const shown = st && Number(st.computed_at) < Number(target.created_at) && st.weakness_raw != null ? 1 - Number(st.weakness_raw) : null;
  return {
    id: forecastId(target.obs_key, target.slot), obs_key: target.obs_key, slot: Number(target.slot) || 0, topic_id: target.topic_id,
    category_id: ctx.category_id ?? null, source: ctx.source, stratum: ctx.stratum, kind: target.kind, at, day: target.day,
    p: r6(p), mastery: s.mastery == null ? null : r6(Number(s.mastery)), band: s.band || 'unseen', cert: r6(Number(s.certainty) || 0), n_eff: r6(neff),
    m0: r6(ctx.m0), prior_real_n: real.length, prior_right_n: real.filter(r => yOf(r) === 1).length,
    last_y: last ? yOf(last) : null, days_since_last: last ? r6((at - Number(last.at)) / DAY_MS) : null,
    same_day_feedback: feedback ? 1 : 0, error_type: errorKeyOf(target.error_type), conf: confidenceOf(target.confidence),
    trend_label: state.trend == null ? null : TREND_WORDS[state.trend], y, p_shown: shown == null ? null : r6(shown),
    model_id: ctx.model_id, scored_at: ctx.now, retracted: 0,
    // 0062: the gate a strong viva or right card days had lifted on the topic just before this answer (WEIGHTS_VERSION 8).
    gate_lift: s.gate_lift || null,
  };
}

// ------------------------------------------------------------------ SQL

export const FORECAST_COLS = ['user_id', 'id', 'obs_key', 'slot', 'topic_id', 'category_id', 'source', 'stratum', 'kind', 'at', 'day', 'p', 'mastery',
  'band', 'cert', 'n_eff', 'm0', 'prior_real_n', 'prior_right_n', 'last_y', 'days_since_last', 'same_day_feedback', 'error_type', 'conf',
  'trend_label', 'y', 'p_shown', 'model_id', 'scored_at', 'retracted', 'gate_lift'];
// The Diagnose / Manage split's columns (0058, wave 3): written once the migration is in.
export const FACET_COLS = ['facet', 'p_facet'];
const upsertSql = cols => `INSERT INTO forecasts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})
  ON CONFLICT (user_id, id) DO UPDATE SET ${cols.filter(c => c !== 'user_id' && c !== 'id').map(c => `${c} = excluded.${c}`).join(', ')}`;
const hasFacetCols = env => env.DB.prepare('SELECT facet, p_facet FROM forecasts WHERE user_id = ?1 LIMIT 0').bind('').all().then(() => true, () => false);

/**
 * The answer's facet (pure): the one facet its facet answers name (a question or re-test with a step, a card whose
 * parts all ask one part), else null. fobs: facets.js answers [{obs_key, topic_id, facet}].
 */
export function targetFacet(target, fobs) {
  const fs = new Set((fobs || []).filter(o => o.obs_key === target.obs_key && o.topic_id === target.topic_id).map(o => o.facet));
  return fs.size === 1 ? [...fs][0] : null;
}

const blocksSql = flag => `SELECT id, day, count, ${flag ? 'complete' : 'NULL AS complete'}, (SELECT count(DISTINCT json_extract(j.value, '$.q'))
    FROM json_each(CASE WHEN json_valid(b.questions_json) THEN b.questions_json ELSE '[]' END) j
    WHERE json_extract(j.value, '$.result') IN ('right', 'wrong', 'omitted') OR json_extract(j.value, '$.verdict') IN ('wrong', 'right_flawed', 'sound')) AS answered
  FROM uworld_blocks b`;
export const BLOCKS_SQL = blocksSql(true);
async function readBlocks(env) {
  try { return (await env.DB.prepare(BLOCKS_SQL).all()).results || []; } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    return (await env.DB.prepare(blocksSql(false)).all()).results || [];   // before 0054
  }
}

const UW_ELIGIBLE = `(CASE
    WHEN e.source_ref LIKE 'uworld:%:q%' THEN substr(e.source_ref, 8, instr(substr(e.source_ref, 8), ':q') - 1) IN (SELECT value FROM json_each(?2))
    WHEN m.uworld_block_id IS NOT NULL THEN m.uworld_block_id IN (SELECT value FROM json_each(?2))
    WHEN e.source = 'uworld' OR json_extract(e.detail_json, '$.from_block') = 1 THEN e.day IN (SELECT value FROM json_each(?3))
    ELSE 0 END) = 1`;

// New answers, and answers whose forecast is out of date (moved topic, new time, re-judged, back from held or deleted).
export const PENDING_SQL = `SELECT e.obs_key, e.slot, e.topic_id, e.at, e.kind, f.id AS f_id, f.topic_id AS f_topic, f.at AS f_at, f.retracted AS f_retracted,
    CASE WHEN e.kind = 'card_review' THEN 'card' WHEN e.kind = 'retest' THEN 'retest' WHEN e.obs_key LIKE 'hub:%' THEN 'hub' ELSE 'uworld' END AS hsrc
  FROM evidence e
  LEFT JOIN misses m ON m.user_id = e.user_id AND m.id = e.miss_id
  LEFT JOIN forecasts f ON f.user_id = e.user_id AND f.id = e.obs_key || '#' || e.slot
  WHERE e.user_id = ?1 AND e.held = 0 AND e.topic_id IS NOT NULL
    AND ((e.kind = 'card_review' AND (lower(e.rating) IN ('again', 'hard', 'good', 'easy', '1', '2', '3', '4') OR e.amount IN (1, 2, 3, 4)))
      OR (e.slot = 0 AND e.kind = 'retest' AND lower(coalesce(e.outcome, e.result)) IN ('got_it', 'right', 'missed_again', 'missed', 'wrong'))
      OR (e.slot = 0 AND e.kind = 'question' AND lower(e.result) IN ('right', 'flawed', 'wrong', 'omitted') AND (e.obs_key LIKE 'hub:%' OR ${UW_ELIGIBLE})))
    AND (f.id IS NULL OR f.retracted = 1 OR f.topic_id IS NOT e.topic_id OR f.at != e.at OR e.updated_at > f.scored_at)
  ORDER BY e.at LIMIT ?4`;

// An answer whose evidence row is gone, held or off the map drops out of every metric.
const RETRACT_SQL = `UPDATE forecasts SET retracted = 1, scored_at = ?2 WHERE user_id = ?1 AND retracted = 0 AND NOT EXISTS (SELECT 1 FROM evidence e
  WHERE e.user_id = ?1 AND e.obs_key = forecasts.obs_key AND e.slot = forecasts.slot AND e.held = 0 AND e.topic_id IS NOT NULL)`;

const REPORT_ROWS_SQL = `SELECT stratum, at, day, p, y, band, m0, cert, category_id, prior_real_n, prior_right_n, model_id FROM forecasts
  WHERE user_id = ?1 AND retracted = 0 ORDER BY at`;

export function completeBlocks(rows) {
  const blocks = [], byDay = new Map();
  for (const b of rows || []) {
    const ok = b.complete != null ? Number(b.complete) === 1
      : Number.isInteger(Number(b.count)) && b.count != null && Number(b.count) > 0 && Number(b.answered) >= Number(b.count);
    if (ok) blocks.push(String(b.id));
    byDay.set(b.day, (byDay.get(b.day) ?? true) && ok);
  }
  return { blocks, days: [...byDay].filter(([, ok]) => ok).map(([d]) => d) };
}

async function setState(env, user, source, cursor, now) {
  await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, fails, lock_until) VALUES (?1, ?2, ?3, ?4, 0, 0)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, source, JSON.stringify(cursor), now).run();
}

// ------------------------------------------------------------------ the job

/**
 * One batch. Returns {written, y_updated, retracted, pending, more}. opts: {now, targets, topics, ms} (how many answers
 * it looks at, topics per read, and the time it may take).
 */
export async function honestyStep(env, user, { now = Date.now(), targets = STEP.targets, topics = STEP.topics, ms = STEP.ms } = {}) {
  const start = Date.now();
  const DB = env.DB;
  const retract = await DB.prepare(RETRACT_SQL).bind(user, now).run();
  const blocks = user === MO ? completeBlocks(await readBlocks(env)) : { blocks: [], days: [] };
  const pending = (await DB.prepare(PENDING_SQL).bind(user, JSON.stringify(blocks.blocks), JSON.stringify(blocks.days), targets).all()).results || [];
  const out = { written: 0, y_updated: 0, retracted: (retract && retract.meta && retract.meta.changes) || 0, pending: pending.length, more: pending.length >= targets };
  if (!pending.length) return out;
  const byTopic = new Map();
  for (const t of pending) {
    if (!byTopic.has(t.topic_id)) byTopic.set(t.topic_id, []);
    byTopic.get(t.topic_id).push(t);
  }
  const ids = [...byTopic.keys()];
  let mid = null, modelSeen = false;
  // The starting guesses adopted so far (oldest first): each answer is replayed with the one in use before it.
  const guesses = await readVersions(env, user);
  // The facet answers, once a step (wave 3): each new forecast with one facet also gets the facet model's p.
  const facetOn = await hasFacetCols(env);
  const cols = facetOn ? [...FORECAST_COLS, ...FACET_COLS] : FORECAST_COLS;
  const UPSERT_SQL = upsertSql(cols);
  let fdata = null;
  if (facetOn) {
    try {
      const d = await loadFacetData(env, user);
      fdata = { obs: d.obs.map(o => ({ ...o, p: (d.levels.get(o.topic_id) || {}).p, system: (d.levels.get(o.topic_id) || {}).system || '' }))
        .filter(o => Number.isFinite(o.p)), levels: d.levels };
    } catch (e) { if (!noTable(e)) throw e; }
  }
  for (let i = 0; i < ids.length; i += topics) {
    if (Date.now() - start > ms) { out.more = true; break; }
    const chunk = ids.slice(i, i + topics);
    const data = await loadForScore(env, user, chunk);
    if (!modelSeen) {
      mid = modelId(data.model);
      modelSeen = true;
      await DB.prepare(`INSERT INTO model_versions (user_id, id, created_at, model_id, params_json, adopted_at, note) VALUES (?1, ?2, ?3, ?2, ?4, ?3, ?5)
        ON CONFLICT (user_id, id) DO NOTHING`).bind(user, mid, now, JSON.stringify(modelParams(data.model)), 'the model the map was using when the honesty check first saw it').run();
    }
    const rowsBy = new Map();
    for (const r of data.rows) {
      const k = String(r.topic_id);
      if (!rowsBy.has(k)) rowsBy.set(k, []);
      rowsBy.get(k).push(r);
    }
    const writes = [];
    for (const topicId of chunk) {
      const rows = rowsBy.get(String(topicId)) || [];
      const topic = data.topics.get(topicId) || null;
      const category_id = topic ? topic.category_id : (data.stored.get(topicId) || {}).category_id ?? null;
      const m0Now = m0For(category_id, data.priors, data.g);
      for (const t of byTopic.get(topicId)) {
        const v = versionAt(guesses, Number(t.at));
        const m0 = (v && guessM0(v, category_id)) ?? m0Now;
        const row = rows.find(r => r.obs_key === t.obs_key && Number(r.slot) === Number(t.slot));
        if (!row) continue;
        // Same answer, same topic, same time: only its result or words changed, so p stays as it was forecast.
        if (t.f_id && !Number(t.f_retracted) && t.f_topic === t.topic_id && Number(t.f_at) === Number(t.at)) {
          const y = yOf(row);
          if (y == null) continue;
          writes.push(DB.prepare('UPDATE forecasts SET y = ?3, error_type = ?4, conf = ?5, scored_at = ?6 WHERE user_id = ?1 AND id = ?2')
            .bind(user, t.f_id, y, errorKeyOf(row.error_type), confidenceOf(row.confidence), now));
          out.y_updated++;
          continue;
        }
        const f = forecastFor(row, rows, { m0, model: data.model, category_id, source: t.hsrc, stratum: t.hsrc === 'card' ? 'card' : 'question',
          model_id: mid, now, stored: data.stored.get(topicId) || null });
        if (!f) continue;
        if (fdata) {
          const facet = targetFacet(row, fdata.obs);
          if (FACETS.includes(facet)) {
            const system = (fdata.levels.get(topicId) || {}).system ?? (category_id || '');
            f.facet = facet;
            f.p_facet = facetForecast({ ...row, at: Number(row.at), facet }, f.p, system, fdata.obs);
          }
        }
        writes.push(DB.prepare(UPSERT_SQL).bind(...cols.map(c => (c === 'user_id' ? user : f[c] ?? null))));
        out.written++;
      }
    }
    for (let k = 0; k < writes.length; k += STEP.write) await DB.batch(writes.slice(k, k + STEP.write));
  }
  return out;
}

/** The report from the stored forecasts, worked out now. */
export async function computeReport(env, user, { now = Date.now() } = {}) {
  const facetOn = await hasFacetCols(env);
  const sql = facetOn ? REPORT_ROWS_SQL.replace('model_id FROM forecasts', 'model_id, facet, p_facet FROM forecasts') : REPORT_ROWS_SQL;
  const rows = (await env.DB.prepare(sql).bind(user).all()).results || [];
  const rep = buildReport(rows, { now });
  // The starting guess in use now on these same answers (in-sample, a description beside the test, never the test).
  const guesses = (await readVersions(env, user)).filter(v => v.id !== SG.base_id);
  const sg = guesses.length ? dryComparison(rows, guesses[guesses.length - 1].params, { now }) : null;
  if (sg) rep.starting_guess = sg;
  try {
    const [l, a, sr] = await env.DB.batch([
      env.DB.prepare("SELECT topic_id, mo_rating, ended_at FROM lessons WHERE user_id = ?1 AND status = 'done' AND mo_rating IS NOT NULL AND topic_id IS NOT NULL").bind(user),
      env.DB.prepare(`SELECT topic_id, at, y${facetOn ? ', facet' : ''} FROM forecasts WHERE user_id = ?1 AND retracted = 0 AND stratum = 'question'`).bind(user),
      env.DB.prepare("SELECT topic_id, at, rating, detail_json FROM evidence WHERE user_id = ?1 AND held = 0 AND kind = 'self_rating' AND obs_key LIKE 'self:%'").bind(user),
    ]);
    rep.self_calibration = selfCalibration(l.results || [], a.results || [], sr.results || []);
  } catch (e) { if (!noTable(e)) throw e; }
  try {
    const [t, a] = await env.DB.batch([
      env.DB.prepare('SELECT count(*) AS n FROM topic_scores WHERE user_id = ?1 AND seen = 1 AND q_pass < ?2 AND mastery > ?3').bind(user, GATES.blue.q_pass, GATES.blue.max),
      env.DB.prepare("SELECT y, gate_lift FROM forecasts WHERE user_id = ?1 AND retracted = 0 AND stratum = 'question' AND gate_lift IS NOT NULL").bind(user),
    ]);
    rep.gate_lift = gateLiftLine(((t.results || [])[0] || {}).n, a.results || []);
  } catch (e) { if (!noTable(e)) throw e; }
  return rep;
}

/**
 * The minute cron's job: one step; when nothing is left, the report is worked out and stored (the hub's line and
 * map_overview read it). Returns the step's counts.
 */
export async function honestyJob(env, user, { now = Date.now(), ms = STEP.ms } = {}) {
  try {
    const r = await honestyStep(env, user, { now, ms });
    await setState(env, user, SOURCE, { more: r.more ? 1 : 0, at: now, written: r.written }, now);
    const key = londonDay(now);
    if (!r.more) {
      // The starting guess learned from every first answer so far (starting-guess.js), before the report reads it.
      r.starting_guess = await startingGuessJob(env, user, { now });
      const rep = await computeReport(env, user, { now });
      await setState(env, user, REPORT_SOURCE, rep, now);
      r.verdict = rep.verdict;
      const line = rep.line || {};
      await noteJob(env, { job: 'honesty', user, key, state: 'ok', add: true, at: now,
        counts: { written: r.written || 0, n: line.n || 0, verdict: rep.verdict || null, ...(rep.gate_lift ? { blue_nq: rep.gate_lift.topics,
          blue_nq_n: rep.gate_lift.blue.n, blue_nq_right: rep.gate_lift.blue.right } : {}) }, detail: line.text || null });
    } else if (r.written) {
      await noteJob(env, { job: 'honesty', user, key, state: 'ok', add: true, at: now, counts: { written: r.written } });
    }
    return r;
  } catch (e) {
    if (noTable(e)) return { skipped: 'no forecasts table yet' };
    await noteJob(env, { job: 'honesty', user, key: londonDay(now), state: 'failed', at: now, detail: e });
    throw e;
  }
}

async function storedReport(env, user) {
  const row = await env.DB.prepare('SELECT cursor, last_ok_at FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, REPORT_SOURCE).first();
  if (!row || !row.cursor) return null;
  try { return JSON.parse(row.cursor); } catch { return null; }
}

/** The report: the last finished run's, or worked out now (fresh, or when no run has finished yet). */
export async function honestyReport(env, user, { fresh = false, now = Date.now() } = {}) {
  try {
    const job = await env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, SOURCE).first();
    let state = null;
    try { state = job && job.cursor ? JSON.parse(job.cursor) : null; } catch { state = null; }
    const rep = (!fresh && await storedReport(env, user)) || await computeReport(env, user, { now });
    // The viva self-audit (wave 4, viva.js): this week's vivas against the colours, and the surprise by what each colour
    // rested on, for the refit of the evidence weights.
    const { auditSummary } = await import('./viva.js');
    const audit = await auditSummary(env, user, { now }).catch(() => null);
    return { ...rep, ...(audit ? { audit } : {}), backfill: state ? { more: !!state.more, last_run: new Date(Number(state.at)).toISOString() } : { more: true, last_run: null } };
  } catch (e) {
    if (noTable(e)) return { line: { text: 'Map honesty: not set up yet.', verdict: 'not enough answers yet', window: null, n: 0 }, verdict: 'not enough answers yet' };
    throw e;
  }
}

/** The stored line's text (null before the first finished run, or before the table exists). */
export async function honestyLineStored(env, user) {
  try {
    const rep = await storedReport(env, user);
    return rep && rep.line ? rep.line.text : null;
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

// ------------------------------------------------------------------ routes

// GET /api/map/honesty: the report. ?fresh=1 works it out from the forecasts now; ?line=1 is the line alone.
export async function honestyRoute(request, env, ctx, params, url, user) {
  const rep = await honestyReport(env, user, { fresh: url.searchParams.get('fresh') === '1' });
  return json(url.searchParams.get('line') === '1' ? { line: rep.line, verdict: rep.verdict } : rep);
}

// POST /api/map/honesty/run: one batch now (the backfill without waiting for the cron), then the report if it is done.
export async function honestyRunRoute(request, env, ctx, params, url, user) {
  await readJson(request, 1_000).catch(() => ({}));
  return json(await honestyJob(env, user));
}
