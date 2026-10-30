// D1 helpers: settings with defaults, today's usage, and small query wrappers.
import { HttpError, londonDay, londonDayStart, safeParse } from './util.js';
import { noteJob } from './job-log.js';

export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

export const CHECK_MODES = ['desktop', 'api'];
export const PUBLIC_SETTINGS = ['daily_cap_usd', 'monthly_cap_usd', 'default_voice_mode', 'onenote_section', 'cards_per_day_cap', 'deck', 'check_mode',
  'target_score', 'uworld_total_left', 'uworld_as_of', 'exam_date', 'rest_days', 'light_days', 'off_weekdays', 'plan_daily',
  'plan_start', 'uworld_finish_date', 'phase2_end', 'cms_early_by', 'cms_weak_pct', 'cards_minutes'];

export function defaultSettings(day = londonDay()) {
  return {
    daily_cap_usd: 30,
    monthly_cap_usd: 190,
    default_voice_mode: 'quick',
    onenote_section: 'Review',
    cards_per_day_cap: 100,
    deck: 'Step 2 — My Cards',
    cards_minutes: 20,
    check_mode: 'desktop',
    target_score: 250,
    uworld_total_left: 2000,
    uworld_as_of: '2027-04-29', // first-pass questions count down from this day
    exam_date: '2027-06-30',
    plan_start: '2027-04-29',
    uworld_finish_date: '2027-05-29',
    phase2_end: '2027-06-25',
    cms_early_by: '2027-05-15',
    cms_weak_pct: 75,
    rest_days: ['2027-06-28', '2027-06-29'],
    light_days: ['2027-06-26', '2027-06-27'],
    off_weekdays: [6, 0],
    plan_daily: { uworld: 100, cms: 37, incorrects: 40 },
  };
}

export async function getSettings(env) {
  const rows = await all(env, `SELECT key, value FROM settings WHERE key IN (${PUBLIC_SETTINGS.map(() => '?').join(',')})`, ...PUBLIC_SETTINGS);
  const out = defaultSettings();
  for (const r of rows) {
    const v = safeParse(r.value, r.value);
    if (v !== null && v !== undefined) out[r.key] = v;
  }
  const cap = Number(out.daily_cap_usd);
  out.daily_cap_usd = Math.min(Number.isFinite(cap) && cap >= 0 ? cap : 30, hardCap(env));
  out.hard_cap_usd = hardCap(env);
  const month = Number(out.monthly_cap_usd);
  out.monthly_cap_usd = Number.isFinite(month) && month >= 0 ? month : 190;
  if (!CHECK_MODES.includes(out.check_mode)) out.check_mode = 'desktop';
  return out;
}

export async function getSetting(env, key) {
  const row = await first(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? safeParse(row.value, row.value) : null;
}

export function setSetting(env, key, value) {
  return run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export async function usageToday(env) {
  const row = await first(env, 'SELECT usd, calls, input_tokens, output_tokens, whisper_seconds FROM usage WHERE day = ?', londonDay());
  return row || { usd: 0, calls: 0, input_tokens: 0, output_tokens: 0, whisper_seconds: 0 };
}

export function addUsage(env, { usd = 0, calls = 0, input = 0, output = 0, whisper = 0 }) {
  return run(env,
    `INSERT INTO usage (day, usd, calls, input_tokens, output_tokens, whisper_seconds) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + excluded.calls,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
       whisper_seconds = whisper_seconds + excluded.whisper_seconds`,
    londonDay(), usd, calls, input, output, whisper);
}

export async function cardsToday(env, except = null) {
  const row = await first(env,
    `SELECT count(*) AS n FROM analyses WHERE card_decision IN ('yes', 'edited') AND decided_at >= ?
       AND NOT (block_id = ? AND q_index = ?)`, londonDayStart(), except ? except.block_id : '', except ? except.q_index : -1);
  return row ? row.n : 0;
}

// Ceiling no setting can lift (wrangler.toml var HARD_CAP_USD, default 25). Applies to Claude and Whisper.
export const hardCap = env => {
  const v = Number(env.HARD_CAP_USD);
  return Number.isFinite(v) && v >= 0 ? v : 25;
};

export async function spendCap(env) {
  const s = await getSettings(env);
  const cap = Number(s.daily_cap_usd);
  return Math.min(Number.isFinite(cap) ? cap : 15, hardCap(env));
}

// The credit renews on this day of the month; a month runs from one reset day up to the day before the next.
export const MONTH_RESET_DAY = 5;

/** First London day (YYYY-MM-DD) of the credit month holding `day`. */
export function monthStart(day = londonDay(), resetDay = MONTH_RESET_DAY) {
  let [y, m, d] = day.split('-').map(Number);
  if (d < resetDay) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
  return `${y}-${String(m).padStart(2, '0')}-${String(resetDay).padStart(2, '0')}`;
}

export async function usageMonth(env) {
  const since = monthStart();
  const row = await first(env, 'SELECT coalesce(sum(usd), 0) AS usd FROM usage WHERE day >= ?', since);
  return { usd: row ? row.usd : 0, since };
}

/**
 * Reserve `usd` of today's spend in one statement, so two requests can never both slip under a cap.
 * Refuses with 429 when today's usd + usd would pass `cap`, or this month's would pass the monthly cap
 * (monthly: false skips that: Whisper runs on Cloudflare, not on the Anthropic credit).
 * Returns release(actual) to settle the reservation later (adds actual - usd; pass 0 when the real costs
 * were added separately).
 */
export async function reserveSpend(env, usd, cap, { monthly = true } = {}) {
  const day = londonDay();
  const since = monthStart(day);
  const monthCap = monthly ? (await getSettings(env)).monthly_cap_usd : 1e9;
  const r = await run(env,
    `INSERT INTO usage (day, usd) SELECT ?1, ?2 WHERE ?2 <= ?3 AND (SELECT coalesce(sum(usd), 0) FROM usage WHERE day >= ?4) + ?2 <= ?5
     ON CONFLICT(day) DO UPDATE SET usd = usage.usd + excluded.usd
       WHERE usage.usd + excluded.usd <= ?3 AND (SELECT coalesce(sum(m.usd), 0) FROM usage m WHERE m.day >= ?4) + excluded.usd <= ?5`,
    day, usd, cap, since, monthCap);
  if (!r.meta || !r.meta.changes) {
    const m = await usageMonth(env);
    const monthly = m.usd + usd > monthCap;
    await noteJob(env, { job: 'spend', key: `${monthly ? 'monthly' : 'daily'}:${day}`, ref: monthly ? 'monthly' : 'daily', state: 'held', add: true,
      counts: { n: 1, cap: String(monthly ? monthCap : cap) } });   // a word, so add never sums it
    if (monthly) throw new HttpError(429, `Monthly spend limit reached ($${monthCap} since ${since})`);
    throw new HttpError(429, 'Daily spend cap reached');
  }
  let settled = false;
  return async (actual = 0) => {
    if (settled) return;
    settled = true;
    // Settle on the day it was reserved, so a reservation made before midnight is not taken off tomorrow.
    await run(env, 'UPDATE usage SET usd = max(0, usd + ?) WHERE day = ?', actual - usd, day);
  };
}

export async function assertUnderCap(env) {
  const [u, cap, m, s] = await Promise.all([usageToday(env), spendCap(env), usageMonth(env), getSettings(env)]);
  if (m.usd >= s.monthly_cap_usd) throw new HttpError(429, `Monthly spend limit reached ($${s.monthly_cap_usd} since ${m.since})`);
  if (u.usd >= cap) throw new HttpError(429, 'Daily spend cap reached');
}

export async function getSitting(env, id) {
  const s = await first(env, 'SELECT * FROM sittings WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'That sitting was not found.');
  return s;
}

export async function getBlock(env, id) {
  const b = await first(env, 'SELECT * FROM blocks WHERE id = ?', id);
  if (!b) throw new HttpError(404, 'That block was not found.');
  return b;
}

// One question from the exam's JSON, extracted by D1 so the Worker never parses the whole array.
export async function getQuestion(env, examId, qIndex) {
  // D1 binds JS numbers as REAL, so the path is built here from the validated integer.
  const row = await first(env, 'SELECT json_extract(questions_json, ?) AS q FROM exams WHERE id = ?', `$[${Math.trunc(qIndex)}]`, examId);
  if (!row) throw new HttpError(404, 'The exam for this sitting was not found.');
  if (row.q == null) throw new HttpError(404, 'That question is not in the exam.');
  return JSON.parse(row.q);
}

// Several questions at once: {qIndex: question}. The indexes go in as one JSON list, because D1 binds at most
// 100 parameters a query and a full sitting can have more than 100 mistakes.
export async function getQuestions(env, examId, indexes) {
  if (!indexes.length) return {};
  const rows = await all(env,
    `SELECT CAST(j.key AS INTEGER) AS k, j.value AS q FROM exams e, json_each(e.questions_json) j
     WHERE e.id = ? AND j.key IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`, examId, JSON.stringify(indexes.map(i => Math.trunc(Number(i)))));
  const out = {};
  for (const r of rows) out[r.k] = JSON.parse(r.q);
  return out;
}
