// A D1 binding that counts queries the way Cloudflare does (a batch is one query), so a job can stop before the
// per-invocation limit (1,000 on Workers Paid; D1_QUERY_BUDGET keeps a margin under it). Wrappers nest: a
// counting env inside another counts in both.
export function countingEnv(env) {
  const counter = { n: 0 };
  const wrap = st => ({
    _real: st,
    bind: (...a) => wrap(st.bind(...a)),
    first: (...a) => { counter.n++; return st.first(...a); },
    all: () => { counter.n++; return st.all(); },
    run: () => { counter.n++; return st.run(); },
    raw: (...a) => { counter.n++; return st.raw(...a); },
  });
  const DB = {
    prepare: sql => wrap(env.DB.prepare(sql)),
    batch: list => { counter.n++; return env.DB.batch(list.map(s => (s && s._real) || s)); },
    exec: sql => { counter.n++; return env.DB.exec(sql); },
  };
  return { env: { ...env, DB }, counter };
}

/** env with D1_QUERY_BUDGET set to n (what is left of this invocation's budget for one job). */
export const withBudget = (env, n) => ({ ...env, D1_QUERY_BUDGET: String(Math.max(0, Math.floor(n))) });
