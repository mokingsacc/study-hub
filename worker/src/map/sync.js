import { now as nowMs, londonDay } from '../util.js';
import { activeUsers, MO } from '../users.js';
import { JOBS as MISTAKE_JOBS } from './ingest/anki.js';
import { REVIEW_JOBS } from './ingest/anki-reviews.js';
import { sweepGaps } from './ingest/gaps.js';
import { commit, LOADERS, sweepReleases } from './ingest/hub.js';
import { countingEnv, withBudget } from './d1-count.js';
import { noteJob } from '../job-log.js';

export const LOCK_MS = 60_000, KICK_MS = 15_000, MAX_BACKOFF_MS = 15 * 60_000, STALE_MS = 20_000;
// How long after a good run each source is due again (slot jobs are due whenever their minute comes).
const EVERY = { 'anki.new': 50_000, 'anki.recent': 0, 'anki.due': 0, 'anki.full': 0, 'anki.reviews': 0, 'anki.fsrs': 0 };
// Every Anki source a run can claim: the mistake log's (anki.js) and the review log's (anki-reviews.js).
export const JOBS = { ...MISTAKE_JOBS, ...REVIEW_JOBS };

const NOTE_FAILS = 3;   // as recent.js SYNC_FAILS: backoff starts at once, so three misses in a row is a source not working
export const backoffMs = fails => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, fails));

const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** {hour, minute} in London for an epoch ms. */
export function londonClock(ms) {
  const [h, m] = LONDON.format(new Date(ms)).split(':').map(Number);
  return { hour: h, minute: m };
}

/** The jobs for one London minute (pure; fullRunning: the nightly pass has more pages; reviewsRunning: so has the review log). */
export function minuteJobsFor({ hour, minute }, { fullRunning = false, reviewsRunning = false } = {}) {
  const jobs = ['anki.new'];
  if (minute % 10 === 7) jobs.push('cards.due'); if (minute === 29) jobs.push('orbits.daily');   // map orbits (I33): due counts; 04:10 reconcile and 04:20 re-place run in the 04:29 hourly slot
  if (minute % 5 === 2) jobs.push('anki.due');
  if (minute % 5 === 3) jobs.push('anki.recent');
  if ((hour === 3 && minute === 47) || fullRunning) jobs.push('anki.full');
  if (minute % 15 === 12 || reviewsRunning) jobs.push('anki.reviews');
  if (minute % 15 === 12) jobs.push('anki.fsrs');
  jobs.push('dirty', 'rebuild', 'gaps', 'release');
  if ([4, 9, 14, 19].includes(minute)) jobs.push('scores');
  if ([24, 54].includes(minute)) jobs.push('repair');
  if (minute === 29) jobs.push('hourly');
  if (hour === 3 && minute === 44) jobs.push('priors');
  if (hour === 3 && minute === 53) jobs.push('lessonCards');
  if (minute % 5 === 0) jobs.push('embed');   // topic embeddings for the semantic layout (embed.js; resumable)
  if (minute % 5 === 1) jobs.push('cardReviews');
  if (minute % 10 === 6) jobs.push('labeller');
  if (minute % 5 === 4) jobs.push('library');   // the study Library: index, OCR, embed, link, topic coverage (library/jobs.js)
  if (hour === 6 && minute < 15 && minute % 5 === 0) jobs.push('morning');
  if (minute % 15 === 11) jobs.push('learn');   // Learn's living updates (learn/sweep.js; nothing unless LEARN is on)
  if (minute % 5 === 4) jobs.push('retests');
  if (minute % 15 === 13) jobs.push('retestCards');
  return jobs;
}

// ---------------------------------------------------------------- sync_state
/**
 * Claim a source for one run, in one batch: its row is made if missing, then locked when it is not locked and
 * is due (force: due or not). Returns the row (with the fails before this run), or null when not claimed.
 */
export async function claimSource(env, user, source, { force = false, now = nowMs(), lockMs = LOCK_MS } = {}) {
  const [, r] = await env.DB.batch([
    env.DB.prepare('INSERT INTO sync_state (user_id, source, fails, lock_until) VALUES (?, ?, 0, 0) ON CONFLICT(user_id, source) DO NOTHING').bind(user, source),
    env.DB.prepare(`UPDATE sync_state SET lock_until = ? WHERE user_id = ? AND source = ? AND lock_until < ? AND (? = 1 OR next_at IS NULL OR next_at <= ?)
      RETURNING user_id, source, cursor, last_ok_at, next_at, fails, last_error`).bind(now + lockMs, user, source, now, force ? 1 : 0, now),
  ]);
  return (r.results || [])[0] || null;
}

/** Record a run's end, and say so on the feed when the source turned from ok to failing or back. */
export async function finishSource(env, user, row, { ok, cursor, error = null, nextAt = null, now = nowMs() }) {
  const fails = ok ? 0 : (row.fails || 0) + 1;
  const next = ok ? nextAt ?? now + (EVERY[row.source] ?? 0) : now + backoffMs(fails);
  const statements = [env.DB.prepare(`UPDATE sync_state SET lock_until = 0, fails = ?, next_at = ?, last_error = ?, cursor = ?,
    last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END WHERE user_id = ? AND source = ?`)
    .bind(fails, next, ok ? null : String(error || 'failed').slice(0, 300), cursor === undefined ? row.cursor ?? null : cursor, ok ? 1 : 0, now, user, row.source)];
  if (!ok && fails === NOTE_FAILS) await noteJob(env, { job: 'sync', user, key: `${row.source}:${now}:failed`, ref: row.source, state: 'failed', at: now, detail: error });
  if (ok && (row.fails || 0) >= NOTE_FAILS) await noteJob(env, { job: 'sync', user, key: `${row.source}:${now}:ok`, ref: row.source, at: now, counts: { fails: row.fails } });
  const turned = ok ? (row.fails || 0) > 0 : (row.fails || 0) === 0;
  if (!turned) return env.DB.batch(statements);
  const label = row.source.startsWith('anki') ? 'Anki' : row.source;
  return commit(env, user, { via: `cron:${row.source}`, surface: 'cron', statements, events: [{ kind: 'sync.status', target_type: 'sync', target_id: row.source,
    summary: ok ? `${label} is syncing again` : `${label} could not be reached; trying again soon`, before: null, after: { source: row.source, ok, error: ok ? null : String(error || '').slice(0, 120) } }] });
}

/** Run one Anki source under its lock. Returns the job's result, {skipped} when not claimed, or {error}. */
export async function runSource(env, user, source, { force = false } = {}) {
  const job = JOBS[source];
  if (!job) throw new Error(`no job ${source}`);
  const row = await claimSource(env, user, source, { force });
  if (!row) return { skipped: true };
  try {
    const r = await job(env, user, row.cursor);
    // A source with more pages is due again at once; one that says when to come back (a tool the server lacks) waits.
    await finishSource(env, user, row, { ok: true, cursor: r.cursor === undefined ? row.cursor : r.cursor,
      nextAt: r.more ? nowMs() : Number.isFinite(r.next_at) ? r.next_at : null });
    return r;
  } catch (e) {
    await finishSource(env, user, row, { ok: false, error: e && e.message }).catch(err => console.error('sync_state write failed', err && err.message));
    return { error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- nudges
/**
 * Pull new Anki misses soon, at most once every 15 s and one at a time (every hub MCP call, the feed while
 * Anki is stale, POST /api/map/sync). Runs in waitUntil; returns whether a pull was started.
 */
export async function kickAnkiPull(env, ctx, reason = 'kick') {
  try {
    const row = await claimSource(env, MO, 'anki.kick', { force: true, lockMs: KICK_MS });
    if (!row) return false;
    const p = runSource(env, MO, 'anki.new', { force: true }).catch(e => console.error('anki pull failed', reason, e && e.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
    return true;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) console.error('kickAnkiPull failed', e && e.message);
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
export function pullForUworld(env, ctx, user, qids, { delays = [3000, 10_000, 25_000] } = {}) {
  const ids = [...new Set((qids || []).filter(Boolean).map(String))];
  if (!ids.length || !ctx || typeof ctx.waitUntil !== 'function') return false;
  ctx.waitUntil((async () => {
    const start = nowMs();
    for (const d of delays) {
      await sleep(Math.max(0, d - (nowMs() - start)));
      const r = await env.DB.prepare(`SELECT count(DISTINCT uw_qid) AS n FROM misses WHERE user_id = ? AND anki_mistake_id IS NOT NULL
        AND uw_qid IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).first();
      if (r && r.n >= ids.length) return;
      await runSource(env, user, 'anki.new', { force: true });
    }
  })().catch(e => console.error('uworld pull failed', e && e.message)));
  return true;
}

/**
 * teach_next and map_overview: run anki.new now when its last good pull is over 20 s old, for at most maxMs.
 * Returns {ran, ok, timed_out, ok_at, added}: a timeout still lets the pull finish in the background.
 */
export async function pullNewIfStale(env, user, { maxMs = 1500, ctx = null } = {}) {
  let st = null;
  try {
    st = await env.DB.prepare("SELECT last_ok_at, lock_until FROM sync_state WHERE user_id = ? AND source = 'anki.new'").bind(user).first();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return { ran: false, ok: false, ok_at: null };
    throw e;
  }
  const t = nowMs();
  if (user !== MO || (st && st.last_ok_at && t - st.last_ok_at < STALE_MS) || (st && st.lock_until > t)) {
    return { ran: false, ok: true, ok_at: st ? st.last_ok_at : null };
  }
  const run = runSource(env, user, 'anki.new', { force: true });
  let timer;
  const timeout = new Promise(r => { timer = setTimeout(() => r({ timed_out: true }), maxMs); });
  const r = await Promise.race([run, timeout]);
  clearTimeout(timer);
  if (r.timed_out && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run.catch(() => {}));
  return { ran: !r.skipped, ok: !r.error && !r.timed_out, timed_out: !!r.timed_out, ok_at: r.error || r.timed_out ? st && st.last_ok_at : t, added: r.added || 0 };
}

// ---------------------------------------------------------------- the dispatcher
// Other areas' minute jobs, found when they have landed (a missing module or function is skipped quietly).
async function optional(mod, fn, ...args) {
  let m;
  try { m = await LOADERS[mod](); } catch { return { missing: `${mod}.js` }; }
  if (typeof m[fn] !== 'function') return { missing: `${mod}.${fn}` };
  return m[fn](...args);
}

const anki = (source, opts) => (env, user) => (user !== MO ? null : !env.ANKI_MCP_URL ? { skipped: 'Anki is not connected' } : runSource(env, user, source, opts));
const RUN = {
  'anki.new': anki('anki.new'),
  'anki.due': anki('anki.due'),
  'cards.due': async (env, user) => ((env.DUE_ORBS === 'on' || env.DUE_ORBS === 'sync') && user === MO && env.ANKI_MCP_URL ? (await import('../orbits/due.js')).dueJob(env, user) : null),
  'orbits.daily': async (env, user) => (user === MO && londonClock(Date.now()).hour === 4 ? (await import('../orbits/place.js')).dailyJob(env, user) : null),
  'anki.recent': anki('anki.recent'),
  'anki.full': anki('anki.full', { force: true }),
  'anki.reviews': anki('anki.reviews'),
  'anki.fsrs': anki('anki.fsrs'),
  dirty: (env, user) => optional('recompute', 'drainDirty', env, user, { limit: 20 }),
  rebuild: (env, user) => optional('rebuild', 'rebuildTick', env, user),
  gaps: (env, user) => sweepGaps(env, user, 10),
  release: (env, user) => sweepReleases(env, user),
  scores: (env, user) => optional('recompute', 'hourlyRefresh', env, user, { limit: 500 }),
  repair: (env, user) => optional('weakness', 'repairScores', env, user, { limit: 30 }),
  hourly: async (env, user) => ({
    taxonomy: await optional('topics', 'taxonomyHourly', env, user),   // refreshYield and autoConfirm
    links: await optional('links', 'decayLinks', env, user),
    lessons: await optional('teach', 'staleLessons', env, user),
    priors: await optional('weakness', 'priorsIfMissing', env, user),   // first run after release: no wait for 03:44
  }),
  priors: (env, user) => optional('weakness', 'refreshPriors', env, user),
  lessonCards: (env, user) => (user !== MO ? null : !env.ANKI_MCP_URL ? { skipped: 'Anki is not connected' } : optional('sources', 'refreshLessonCards', env, user)),
  embed: async (env, user) => (await import('./embed.js')).embedJob(env, user),
  cardReviews: async (env, user) => (await import('./ingest/card-reviews.js')).ingestCardReviews(env, user),
  // labeller.js calls the API; the minute cron runs with the hub's own env (never the connector's).
  labeller: async (env, user) => (await import('./labeller.js')).labellerJob(env, user),
  morning: async (env, user) => (await import('./morning.js')).morningJob(env, user),
  learn: async (env, user) => (env.LEARN === 'on' && user === MO ? (await import('../learn/sweep.js')).sweepLearn(env, user) : null),
  library: async (env, user) => (await import('../library/jobs.js')).libraryJob(env, user),
  retests: async (env, user) => (await import('./retests.js')).bookRetests(env, user),
  retestCards: async (env, user) => (user === MO ? (await import('./retests.js')).retestCards(env, user) : null),
};

/**
 * The minute cron (registered as ingest's MINUTE). Each job runs on its own; one failing never stops the
 * others. Returns {user: {job: result | {error}}} for the tests and the logs.
 */
// The minute's D1 queries are one invocation's (Workers Paid: 1,000; D1_QUERY_BUDGET keeps a margin): each job
// runs on what the jobs before it left (B2-1). An Anki job takes at most ANKI_JOB_SHARE of the budget, and the
// Anki jobs and the rebuild leave TAIL for the jobs after them; a job with under MIN_JOB left waits a minute.
export const ANKI_JOB_SHARE = 0.45, MIN_JOB = 8;
const tailOf = total => Math.min(120, Math.floor(total * 0.25));
export function jobAllowance(name, left, total) {
  if (name.startsWith('anki.')) return Math.min(Math.floor(total * ANKI_JOB_SHARE), left - tailOf(total));
  if (name === 'rebuild') return left - tailOf(total);
  return left;
}

export async function dispatchMinute(env, ctx, scheduledTime, { run = RUN } = {}) {
  const at = Number(scheduledTime) || nowMs();
  const total = Math.max(10, Number(env && env.D1_QUERY_BUDGET) || 40);
  const counted = countingEnv(env);
  const cenv = counted.env;
  const clock = londonClock(at);
  let fullRunning = false, reviewsRunning = false;
  try {
    const rows = (await env.DB.prepare("SELECT source, cursor FROM sync_state WHERE user_id = ? AND source IN ('anki.full', 'anki.reviews')")
      .bind(MO).all()).results || [];
    const cur = src => (rows.find(r => r.source === src) || {}).cursor;
    fullRunning = !!cur('anki.full');
    reviewsRunning = (() => { try { return Number(JSON.parse(cur('anki.reviews') || '{}').more) === 1; } catch { return false; } })();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return {}; // before 0010: no map yet
    throw e;
  }
  const jobs = minuteJobsFor(clock, { fullRunning, reviewsRunning });
  const out = {};
  for (const user of await activeUsers(env)) {
    out[user] = {};
    for (const name of jobs) {
      const allow = jobAllowance(name, total - counted.counter.n, total);
      if (allow < MIN_JOB) { out[user][name] = { skipped: 'query budget' }; continue; }
      const jenv = name.startsWith('anki.') ? { ...cenv, D1_JOB_QUERIES: String(allow) } : name === 'rebuild' ? withBudget(cenv, allow) : cenv;
      try {
        out[user][name] = (await run[name](jenv, user)) ?? null;
      } catch (e) {
        out[user][name] = { error: (e && e.message) || String(e) };
        if (!/no such table/i.test(String(e && e.message))) {
          console.error(`minute job ${name} failed`, (e && e.stack) || e);
          await noteJob(env, { job: 'minute', user, key: `${name}:${londonDay(at)}`, ref: name, state: 'failed', add: true, counts: { n: 1 }, detail: e });
        }
      }
    }
  }
  return out;
}

