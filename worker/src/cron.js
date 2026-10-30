import { flushOutbox } from './outbox.js';
import { sweepImages } from './images.js';
import { sweep as sweepAnki } from './spoken.js';
import { minuteJobs } from './map/registry/index.js';
import { sweepReviews } from './uworld-review.js';
import { tidySystems } from './uworld-systems.js';
import { embedPending } from './exam-bank.js';
import { cronTick as notesImport } from './notes/import-job.js';
import { tick as backfillSignals } from './backfill-signals.js';
import { historyCron } from './history/sweep.js';
import { noteJob } from './job-log.js';
import { londonDay } from './util.js';
import { patternJob } from './map/patterns.js';

export const EVERY_MINUTE = '* * * * *';

export function cronJobs(cron, scheduledTime) {
  if (cron !== EVERY_MINUTE) return ['flush', 'images', 'anki'];
  const m = new Date(scheduledTime).getUTCMinutes() % 15;
  if (m === 0) return ['flush', 'images', 'minute', 'notes'];
  if (m === 1) return ['anki'];
  return ['minute', 'uworld', 'exambank', 'notes', 'backfill', 'history', 'patterns'];
}

const JOBS = {
  flush: env => flushOutbox(env),
  images: env => sweepImages(env),
  anki: env => sweepAnki(env),
  uworld: async (env, ctx) => {
    await tidySystems(env).then(r => r && noteJob(env, { job: 'systems_tidy', key: 'v1', counts: { blocks: r.blocks, labels: r.misses_labels } }),
      e => { console.error('system labels tidy failed', e && e.message); return noteJob(env, { job: 'systems_tidy', state: 'failed', detail: e }); });
    return sweepReviews(env, ctx);
  },
  // The exam bank's meaning-search vectors: 300 a minute until every question has one, then one count a minute.
  exambank: env => embedPending(env),
  notes: env => notesImport(env),
  // The one-off catch-up of mixed_with, step and confidence (backfill-signals.js): nothing unless it was started.
  backfill: (env, ctx) => backfillSignals(env, ctx),
  history: (env, ctx, at) => historyCron(env, ctx, at),
  // The pattern review: the queued batches, the daily run at 23:10 London and the profile's refresh (map/patterns.js).
  patterns: (env, ctx, at) => patternJob(env, 'mo', { at }),
  minute: (env, ctx, at) => Promise.all(minuteJobs().map(j => j.run(env, ctx, at))),
};

// Starts each job under ctx.waitUntil; a failing job is logged and never stops the others.
// Returns the names started (for the tests).
export function runScheduled(event, env, ctx, jobs = JOBS) {
  const names = cronJobs(event.cron, event.scheduledTime);
  for (const name of names) {
    ctx.waitUntil(Promise.resolve().then(() => jobs[name](env, ctx, event.scheduledTime))
      .catch(e => {
        console.error(`cron ${name} failed`, e && e.stack || e);
        // A job that stops with an error says so on Recent activity, one line a job a day with how often.
        if (!/no such table/i.test(String(e && e.message))) return noteJob(env, { job: 'cron', key: `${name}:${londonDay(event.scheduledTime || Date.now())}`, ref: name, state: 'failed', add: true, counts: { n: 1 }, detail: e });
      }));
  }
  return names;
}
