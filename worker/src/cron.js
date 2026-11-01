import { flushOutbox } from './outbox.js';
import { sweepImages } from './images.js';
import { sweep as sweepAnki } from './spoken.js';
import { minuteJobs } from './map/registry/index.js';
import { sweepReviews } from './uworld-review.js';
import { sweepTalks } from './uworld-review-talk.js';
import { tidySystems } from './uworld-systems.js';
import { embedPending } from './exam-bank.js';
import { cronTick as notesImport } from './notes/import-job.js';
import { tick as backfillSignals } from './backfill-signals.js';
import { historyCron } from './history/sweep.js';
import { noteJob } from './job-log.js';
import { londonDay } from './util.js';
import { patternJob } from './map/patterns.js';
import { vivaJob } from './map/viva-job.js';
import { pictureJob } from './map/auto-pictures.js';
import { batchTick } from './claude.js';
import { sweepBatched } from './analyze.js';
import { costWeekJob } from './ai-cost.js';
import { traceJob, settleTrace, pruneTraces } from './debug/trace.js';
import { cardFixNight } from './card-fix.js';
import { countingEnv, withBudget } from './map/d1-count.js';

export const EVERY_MINUTE = '* * * * *';

export function cronJobs(cron, scheduledTime) {
  if (cron !== EVERY_MINUTE) return ['flush', 'images', 'anki'];
  const m = new Date(scheduledTime).getUTCMinutes() % 15;
  if (m === 0) return ['flush', 'images', 'minute', 'notes', 'batches'];
  if (m === 1) return ['anki'];
  return ['minute', 'uworld', 'exambank', 'notes', 'backfill', 'history', 'patterns', 'viva', 'pictures', 'batches', 'cardfix'];
}

const JOBS = {
  flush: env => flushOutbox(env),
  // The image sweep, and once a night (03:00 UTC) the request traces past their 7 days or the row cap (debug/trace.js).
  images: async (env, ctx, at) => { await sweepImages(env); const d = new Date(Number(at) || Date.now()); if (d.getUTCHours() === 3 && d.getUTCMinutes() < 15) await pruneTraces(env.DB); },
  anki: env => sweepAnki(env),
  uworld: async (env, ctx) => {
    await tidySystems(env).then(r => r && noteJob(env, { job: 'systems_tidy', key: 'v1', counts: { blocks: r.blocks, labels: r.misses_labels } }),
      e => { console.error('system labels tidy failed', e && e.message); return noteJob(env, { job: 'systems_tidy', state: 'failed', detail: e }); });
    try { return await sweepReviews(env, ctx); } finally { await sweepTalks(env, ctx); }
  },
  // The exam bank's meaning-search vectors: 300 a minute until every question has one, then one count a minute.
  exambank: env => embedPending(env),
  notes: env => notesImport(env),
  // The one-off catch-up of mixed_with, step and confidence (backfill-signals.js): nothing unless it was started.
  backfill: (env, ctx) => backfillSignals(env, ctx),
  history: (env, ctx, at) => historyCron(env, ctx, at),
  // The pattern review: the queued batches, the daily run at 23:10 London and the profile's refresh (map/patterns.js).
  patterns: (env, ctx, at) => patternJob(env, 'mo', { at }),
  // The viva (map/viva-job.js, wave 4): one call a minute, a viva graded or a rubric built, nothing when none waits.
  viva: (env, ctx, at) => vivaJob(env, 'mo', { at }),
  // A picture on every topic (map/auto-pictures.js, 31 Oct): 3 topics a minute, new topics first, nothing when none waits.
  pictures: (env, ctx, at) => pictureJob(env, 'mo', { at }),
  minute: (env, ctx, at) => Promise.all(minuteJobs().map(j => j.run(env, ctx, at))),
  batches: async (env, ctx, at) => { await batchTick(env, { now: Number(at) || Date.now() }); await sweepBatched(env); await costWeekJob(env, { now: Number(at) || Date.now() }); },
  cardfix: (env, ctx, at) => cardFixNight(env, 'mo', { at: Number(at) || Date.now() }),
};

export const SHARE = { flush: 20, images: 10, uworld: 120, exambank: 5, notes: 10, backfill: 10, history: 10, patterns: 40, viva: 30, pictures: 30, batches: 30, cardfix: 10 };
/** The minute's budget (D1_QUERY_BUDGET, at most 900 under Cloudflare's 1,000) and the dispatcher's part of it for these jobs. */
export function minuteBudget(names, env) {
  const total = Math.max(10, Number(env && env.D1_QUERY_BUDGET) || 40);
  return { total, minute: Math.max(10, total - names.reduce((n, j) => n + (SHARE[j] || 0), 0)) };
}

// Starts each job under ctx.waitUntil; a failing job is logged and never stops the others.
// traced (index.js, the debug_capture setting): each job runs in its own trace, kept when it fails or runs past 25 s,
// and the failure's Recent activity line carries the trace's id (counts.trace) for bug_get and Claude Code.
// Returns the names started (for the tests).
export function runScheduled(event, env, ctx, jobs = JOBS, traced = false) {
  const names = cronJobs(event.cron, event.scheduledTime);
  const budget = minuteBudget(names, env);
  const shared = countingEnv(env, { max: budget.total }).env;   // one counter, one limit, for every job of this firing
  const envFor = name => (name === 'minute' ? withBudget(shared, budget.minute) : shared);
  for (const name of names) {
    const { trace, promise } = traceJob(name, event, () => jobs[name](envFor(name), ctx, event.scheduledTime), traced);
    ctx.waitUntil(promise
      .catch(e => {
        console.error(`cron ${name} failed`, e && e.stack || e);
        if (trace) trace.fail(e);
        // A job that stops with an error says so on Recent activity, one line a job a day with how often.
        if (!/no such table/i.test(String(e && e.message))) return noteJob(env, { job: 'cron', key: `${name}:${londonDay(event.scheduledTime || Date.now())}`, ref: name, state: 'failed', add: true, counts: { n: 1, ...(trace ? { trace: trace.id } : {}) }, detail: e });
      })
      .finally(() => { if (trace) return settleTrace(trace, env, null, { ring: false }); }));
  }
  return names;
}
