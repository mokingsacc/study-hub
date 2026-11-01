
const KEY = 'MAP_TOUCHED';
// Whether the database has topic_facets (0058): one statement a caller adds to a read batch it already runs, so the
// parts' reads can then ride at the end of its write batch without risking that write (recompute.js, events.js).
export const FACETS_READY_SQL = "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'topic_facets'";
export const readyFrom = result => Number((((result && result.results) || [])[0] || {}).n) > 0;

/** An env (a copy) that collects touched topics instead of recomputing after each write. */
export function deferUpdates(env) {
  return { ...env, [KEY]: new Map() };
}

const pending = env => (env && env[KEY] instanceof Map ? env[KEY] : null);
/** Whether env collects its topics for one flush (deferUpdates). */
export const isDeferred = env => !!pending(env);

/**
 * The parts' reads for some topics, to put at the end of a write batch (facets.js facetReadStatements): none when env
 * collects for a flush, when the database has no topic_facets, or when facets.js cannot load.
 */
export async function readStatements(env, user, topics, { ready = true } = {}) {
  if (!ready || isDeferred(env) || !topics || !topics.length) return [];
  try { return (await import('./facets.js')).facetReadStatements(env.DB, user, topics); } catch (e) {
    console.error('parts reads not built', e && e.message);
    return [];
  }
}

/**
 * The parts of topics whose colour a write just worked out again. With a batch open (deferUpdates) they are only
 * collected; otherwise they are recomputed now. Returns facets.js's answer, {deferred: n} or null.
 */
export async function afterScores(env, user, topics, { now = Date.now(), reads = null } = {}) {
  const ids = [...new Set([...(topics || [])].filter(x => x != null && x !== '').map(String))];
  if (!ids.length || !env || !env.DB) return null;
  const open = pending(env);
  if (open) {
    if (!open.has(user)) open.set(user, new Set());
    for (const id of ids) open.get(user).add(id);
    return { deferred: ids.length };
  }
  return recompute(env, user, ids, now, reads);
}

/** Everything collected under deferUpdates for `user` (null: every user), de-duplicated. Returns {user: result}. */
export async function flushUpdates(env, user = null, { now = Date.now() } = {}) {
  const open = pending(env);
  const out = {};
  if (!open) return out;
  const plain = { ...env, [KEY]: undefined };
  for (const [u, set] of [...open]) {
    if (user != null && u !== user) continue;
    open.delete(u);
    if (set.size) out[u] = await recompute(plain, u, [...set], now);
  }
  return out;
}

async function recompute(env, user, ids, now, reads = null) {
  try {
    const f = await import('./facets.js');
    return await f.recomputeTopicFacets(env, user, ids, { now, reads });
  } catch (e) {
    console.error('parts not updated straight away; the hourly run catches up', e && e.message);
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}
