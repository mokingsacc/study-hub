// A D1 binding that counts queries the way Cloudflare does (a batch is one query), so a job can stop before the
// per-invocation limit (1,000 on Workers Paid; D1_QUERY_BUDGET keeps a margin under it). Wrappers nest: a
// counting env inside another counts in both. With max, a query past it is refused (a rejected promise, as D1 does) instead
// of running: the cron's one budget for a whole minute (cron.js), so the minute never reaches Cloudflare's own limit.
export const BUDGET_USED = "This minute's database budget is used up; it carries on next minute.";
export function countingEnv(env, { counter = { n: 0 }, max = 0 } = {}) {
  const go = f => { if (max && counter.n >= max) return Promise.reject(new Error(BUDGET_USED)); counter.n++; return f(); };
  const wrap = st => ({
    _real: st,
    bind: (...a) => wrap(st.bind(...a)),
    first: (...a) => go(() => st.first(...a)),
    all: () => go(() => st.all()),
    run: () => go(() => st.run()),
    raw: (...a) => go(() => st.raw(...a)),
  });
  const DB = {
    prepare: sql => wrap(env.DB.prepare(sql)),
    batch: list => go(() => env.DB.batch(list.map(s => (s && s._real) || s))),
    exec: sql => go(() => env.DB.exec(sql)),
  };
  return { env: { ...env, DB }, counter };
}

/** env with D1_QUERY_BUDGET set to n (what is left of this invocation's budget for one job). */
export const withBudget = (env, n) => ({ ...env, D1_QUERY_BUDGET: String(Math.max(0, Math.floor(n))) });
