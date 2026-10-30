import { json } from '../util.js';
import { rankTopicsFor, choose } from './teach-priority.js';

/** How many topics after Learn next carry the High-priority teaching mark (one place to change it). */
export const HIGH_PRIORITY_N = 10;

export function teachMarks(data, { n = HIGH_PRIORITY_N, now } = {}) {
  if (!data || !data.ok) return { next: [], high: [] };
  const pick = choose(data, { now: now ?? data.now });
  const next = pick && pick.topic_id && !pick.rest && !pick.none ? [pick.topic_id, ...(pick.pair && pick.pair.topic_id ? [pick.pair.topic_id] : [])] : [];
  const high = [];
  for (const r of data.ranked || []) {
    if (high.length >= n) break;
    if (!next.includes(r.topic_id) && !high.includes(r.topic_id)) high.push(r.topic_id);
  }
  return { next, high };
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));

// GET /api/map/teach-marks: {next, high, n}. A map not set up yet answers both empty.
export async function teachMarksRoute(request, env, ctx, params, url, user) {
  let data = null;
  try { data = await rankTopicsFor(env, user, {}); } catch (e) { if (!noTable(e)) throw e; }
  return json({ ...teachMarks(data), n: HIGH_PRIORITY_N });
}
