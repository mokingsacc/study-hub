import { londonDay } from './util.js';

const MO = 'mo';

export const JOB_STATES = ['ok', 'fallback', 'held', 'failed'];
// Every job that notes lines (recent.js has the words for each).
export const JOBS = ['transcribe', 'anki_check', 'anki_echo', 'uworld_judge', 'retest_book', 'retest_cards', 'catchup_signals', 'catchup_audit',
  'systems_tidy', 'sync', 'outbox', 'anki_voice_gaps', 'spend', 'minute', 'cron'];
export const KEEP_MS = 30 * 86_400_000, DETAIL_MAX = 140;
const KEY_RE = /^[a-z_]{1,24}$/;
const RANK = "'ok,held,fallback,failed'";   // instr() of each state in this string orders them, worst last

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
/** An error (or a reason) as a short line: its message, whitespace collapsed, cut to DETAIL_MAX. */
export function detailOf(e) {
  if (e == null || e === '') return null;
  const s = String(typeof e === 'object' && 'message' in e ? e.message : e).replace(/\s+/g, ' ').trim();
  return !s ? null : s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/**
 * The upsert for one run (pure, for the tests): {sql, binds}. counts: numbers (or a short word) the line is built
 * from, keys a-z and _ only.
 */
export function noteSql({ job, key = null, ref = null, state = 'ok', counts = {}, detail = null, add = false, runMs = 0, at = Date.now(), user = MO }) {
  if (!JOBS.includes(job)) throw new Error(`job-log: unknown job ${job}`);
  if (!JOB_STATES.includes(state)) throw new Error(`job-log: unknown state ${state}`);
  const clean = Object.fromEntries(Object.entries(counts || {}).filter(([k, v]) => KEY_RE.test(k) && v != null
    && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 40) || typeof v === 'boolean')));
  const id = `${job}:${key ?? londonDay(at)}`.slice(0, 200);
  const binds = [user, id, job, ref == null ? null : String(ref).slice(0, 120), state, JSON.stringify(clean), detailOf(detail), Number(at)];
  const idExpr = runMs > 0
    ? `coalesce((SELECT id FROM job_runs WHERE user_id = ?1 AND job = ?3 AND ref IS ?4 AND at >= ?9 ORDER BY at DESC LIMIT 1), ?2)` : '?2';
  if (runMs > 0) binds.push(Number(at) - runMs);
  let counted = 'excluded.counts_json';
  if (add && Object.keys(clean).length) {
    const parts = [];
    for (const [k, v] of Object.entries(clean)) {
      binds.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      const p = `?${binds.length}`;
      parts.push(typeof v === 'number' ? `'$.${k}', coalesce(json_extract(job_runs.counts_json, '$.${k}'), 0) + ${p}` : `'$.${k}', ${p}`);
    }
    counted = `json_set(job_runs.counts_json, ${parts.join(', ')})`;
  } else if (add) counted = 'job_runs.counts_json';
  const stateExpr = add ? `CASE WHEN instr(${RANK}, excluded.state) > instr(${RANK}, job_runs.state) THEN excluded.state ELSE job_runs.state END` : 'excluded.state';
  const sql = `INSERT INTO job_runs (user_id, id, job, ref, state, counts_json, detail, at, created_at) VALUES (?1, ${idExpr}, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    ON CONFLICT (user_id, id) DO UPDATE SET at = excluded.at, ref = coalesce(excluded.ref, job_runs.ref), state = ${stateExpr},
      counts_json = ${counted}, detail = ${add ? 'coalesce(excluded.detail, job_runs.detail)' : 'excluded.detail'}`;
  return { sql, binds };
}

/**
 * Note one run of a background job for Recent activity. Never throws.
 *   job: one of JOBS; key: the run's id within the job (default the London day, so one line a day); ref: what it is
 *   about; state: ok | fallback | held | failed; counts, detail: what recent.js words the line from;
 *   add: sum counts into the line's own and keep its worst state (the day's bookings, a recording's clips);
 *   runMs: join the newest line of this job and ref noted within runMs, else start a new one keyed key.
 */
export async function noteJob(env, opts) {
  try {
    if (!env || !env.DB) return false;
    const { sql, binds } = noteSql(opts);
    const at = Number(opts.at ?? Date.now());
    await env.DB.batch([
      env.DB.prepare(sql).bind(...binds),
      env.DB.prepare('DELETE FROM job_runs WHERE user_id = ? AND at < ?').bind(opts.user || MO, at - KEEP_MS),
    ]);
    return true;
  } catch (e) {
    if (!noTable(e)) console.error('job line not noted', opts && opts.job, e && e.message);
    return false;
  }
}
