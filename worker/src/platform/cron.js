import { minuteJobs } from '../map/registry/index.js';
import { activeUsers } from '../users.js';
import { countingEnv } from '../map/d1-count.js';

const DAY = 86_400_000;

export async function housekeeping(env, at = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users) AND (expires_at < ? OR revoked_at < ?)').bind(at, at - DAY),
    env.DB.prepare('DELETE FROM auth_codes WHERE user_id IN (SELECT id FROM users) AND (expires_at < ? OR used_at < ?)').bind(at - DAY, at - DAY),
    env.DB.prepare('DELETE FROM rate_limits WHERE user_id IS NOT NULL AND window_start < ? AND (locked_until IS NULL OR locked_until < ?)').bind(at - DAY, at),
    env.DB.prepare('DELETE FROM ai_usage WHERE user_id IS NOT NULL AND day < ?').bind(new Date(at - 400 * DAY).toISOString().slice(0, 10)),
  ]);
  return { ok: true };
}

// Optional jobs from the feature files, looked up at run time so a missing export never breaks the cron.
async function featureJob(file, name, ...args) {
  const mod = await import(`./${file}.js`);
  return typeof mod[name] === 'function' ? mod[name](...args) : { skipped: `${file}.${name} not built` };
}

export function platformJobs(at) {
  const minute = new Date(at).getUTCMinutes();
  const jobs = ['map'];
  if (minute === 7) jobs.push('housekeeping', 'purge', 'library');
  return jobs;
}

const JOBS = {
  map: (env, ctx, at) => Promise.all(minuteJobs().map(j => j.run(env, ctx, at))),
  housekeeping: (env, ctx, at) => housekeeping(env, at),
  purge: env => featureJob('me', 'purgeDeleted', env),
  library: async env => {
    const out = {};
    for (const user of await activeUsers(env)) out[user] = await featureJob('library', 'retryExtraction', env, user);
    return out;
  },
};

export function runPlatformCron(event, env, ctx, jobs = JOBS) {
  const names = platformJobs(event.scheduledTime);
  const budget = Number(env.D1_QUERY_BUDGET) || 45;
  const shared = countingEnv(env, { max: budget }).env;
  for (const name of names) {
    ctx.waitUntil(Promise.resolve().then(() => jobs[name](shared, ctx, event.scheduledTime))
      .catch(e => console.error(`platform cron ${name} failed`, e && e.stack || e)));
  }
  return names;
}
