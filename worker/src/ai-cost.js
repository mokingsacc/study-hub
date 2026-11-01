import { londonDay } from './util.js';
import { noteJob } from './job-log.js';

export const WEEK_DAYS = 7;
const DAY = 86_400_000;
export const ROLE_WORDS = { judge: 'exam judge', checker: 'Anki and exam checks', mehlman: 'Mehlman notes', reader: 'reading pages', labeller: 'labelling',
  explainer: 'Cards Ask', summariser: 'Mehlman summaries', analyst: 'Ask the data', reviewer: 'UWorld judge and reviews', learner: 'Learn', asker: 'Learn Ask',
  corrector: 'spelling check', retester: 'cards from misses', patterner: 'pattern review', tabler: 'AnKing tables', examiner: 'viva', picturer: 'picture checks' };

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/** The week from claude_usage rows (pure): {days, usd, calls, input, read, write, output, hit, batch_usd, roles: [...]}. */
export function weekFrom(rows) {
  const roles = new Map();
  const tot = { usd: 0, calls: 0, input: 0, read: 0, write: 0, output: 0, batch_usd: 0, batch_calls: 0 };
  for (const r of rows || []) {
    const k = r.role || 'unknown';
    const x = roles.get(k) || { role: k, words: ROLE_WORDS[k] || k, usd: 0, calls: 0, input: 0, read: 0, write: 0, output: 0, batch_calls: 0 };
    for (const [f, col] of [['usd', 'usd'], ['calls', 'calls'], ['input', 'input'], ['read', 'cache_read'], ['write', 'cache_write'], ['output', 'output']]) {
      x[f] += Number(r[col]) || 0;
      tot[f] += Number(r[col]) || 0;
    }
    if (r.mode === 'batch') { x.batch_calls += Number(r.calls) || 0; tot.batch_calls += Number(r.calls) || 0; tot.batch_usd += Number(r.usd) || 0; }
    roles.set(k, x);
  }
  const list = [...roles.values()].map(x => ({ ...x, usd: r2(x.usd), hit: pct(x.read, x.input + x.read + x.write) })).sort((a, b) => b.usd - a.usd);
  return { days: WEEK_DAYS, usd: r2(tot.usd), calls: tot.calls, input: tot.input, read: tot.read, write: tot.write, output: tot.output,
    hit: pct(tot.read, tot.input + tot.read + tot.write), batch_usd: r2(tot.batch_usd), batch_calls: tot.batch_calls, roles: list };
}

/** The last 7 London days (today included), or null before 0064. */
export async function costWeek(env, { now = Date.now() } = {}) {
  try {
    const since = londonDay(now - (WEEK_DAYS - 1) * DAY);
    const rows = (await env.DB.prepare(`SELECT role, mode, sum(calls) AS calls, sum(input) AS input, sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
        sum(output) AS output, sum(usd) AS usd FROM claude_usage WHERE user_id = 'mo' AND day >= ? GROUP BY role, mode`).bind(since).all()).results || [];
    return { since, ...weekFrom(rows) };
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

/** The week in one line (pure). Batch calls cost half, so what they saved equals what they cost. */
export function costLine(w) {
  if (!w || !w.calls) return 'AI last 7 days: no calls.';
  const top = w.roles.slice(0, 3).map(r => `${r.words} $${r.usd.toFixed(2)} (${r.hit}% cached)`).join(', ');
  const batch = w.batch_calls ? `; ${w.batch_calls} by batch at half price, saving $${w.batch_usd.toFixed(2)}` : '';
  return `AI last 7 days: $${w.usd.toFixed(2)} over ${w.calls} calls, ${w.hit}% of input read from the cache${batch}. Most: ${top}.`;
}

/**
 * The weekly Recent activity line: once a week, on Monday from 07:00 London (or the first run after), from the
 * usage rows. Never throws. Returns {noted} or {skipped}.
 */
export async function costWeekJob(env, { now = Date.now() } = {}) {
  try {
    if (!env || !env.DB) return { skipped: 'no database' };
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(now)).map(p => [p.type, p.value]));
    if (parts.weekday !== 'Mon' || Number(parts.hour) < 7) return { skipped: 'not Monday morning' };
    const key = londonDay(now);
    const had = await env.DB.prepare(`SELECT 1 FROM job_runs WHERE user_id = 'mo' AND id = ?`).bind(`ai_cost:${key}`).first().catch(() => null);
    if (had) return { skipped: 'noted this week' };
    const w = await costWeek(env, { now });
    if (!w) return { skipped: 'no usage table yet' };
    const top = w.roles[0] ? `${w.roles[0].words} $${w.roles[0].usd.toFixed(2)}`.slice(0, 40) : 'none';
    await noteJob(env, { job: 'ai_cost', key, ref: 'week', state: 'ok', at: now,
      counts: { cents: Math.round(w.usd * 100), calls: w.calls, hit: w.hit, batch: w.batch_calls, saved_cents: Math.round(w.batch_usd * 100), top } });
    return { noted: true, line: costLine(w) };
  } catch (e) {
    console.error('ai cost line failed', e && e.message);
    await noteJob(env, { job: 'ai_cost', key: `failed:${londonDay(now)}`, ref: 'week', state: 'failed', at: now, counts: {}, detail: e });
    return { error: (e && e.message) || String(e) };
  }
}
