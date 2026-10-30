import { json } from '../util.js';
import { QUIET, RECENT_HOURS, recentTopics } from '../map/recent.js';
import { requireModule } from './modules.js';

const DAY_MS = 86_400_000, MAX = 30;
const WHO = { mo: 'You', claude: 'Your Claude', code: 'The hub', cron: 'The hub', extractor: 'The hub', anki: 'Anki' };
const SKIP_SQL = `(${[...QUIET, 'undo'].map(k => `'${k}'`).join(', ')})`;

export async function recentChanges(env, user, { days = 7, now = Date.now() } = {}) {
  const since = now - days * DAY_MS;
  // Each batch once: its first telling summary (sections and aliases made on the way come last), who made it, how
  // many more lines, and whether it can still be undone.
  const { results } = await env.DB.prepare(`SELECT batch_id, MAX(seq) AS seq, MIN(at) AS at, MIN(actor) AS actor, COUNT(*) AS n,
      MAX(undoable) AS undoable, MAX(CASE WHEN undone_by IS NOT NULL THEN 1 ELSE 0 END) AS undone,
      (SELECT f.summary FROM map_events f WHERE f.user_id = e.user_id AND f.batch_id = e.batch_id AND f.kind NOT IN ${SKIP_SQL}
        ORDER BY (f.kind LIKE 'unit.%' OR f.kind LIKE 'alias.%'), f.seq LIMIT 1) AS what
    FROM map_events e WHERE user_id = ?1 AND at >= ?2 AND kind NOT IN ${SKIP_SQL}
    GROUP BY batch_id ORDER BY seq DESC LIMIT ${MAX}`).bind(user, since).all();
  return { days, items: (results || []).map(r => ({ batch_id: r.batch_id, at: r.at, who: WHO[r.actor] || 'The hub', what: r.what, more: Math.max(0, (Number(r.n) || 1) - 1),
    undoable: !!r.undoable, undone: !!r.undone })) };
}

async function recentRoute(request, env, ctx, params, url, user, session) {
  requireModule(session, 'map', env);
  const d = Number(url.searchParams.get('days') || 7);
  return json(await recentChanges(env, user, { days: Number.isInteger(d) && d >= 1 && d <= 30 ? d : 7 }));
}

async function mapRecentRoute(request, env, ctx, params, url, user, session) {
  requireModule(session, 'map', env);
  const h = Number(url.searchParams.get('hours') || 24);
  return json(await recentTopics(env, user, { hours: RECENT_HOURS.includes(h) ? h : 24 }));
}

export const ROUTES = [
  ['GET', '/api/p/recent', recentRoute],
  ['GET', '/api/p/map/recent', mapRecentRoute],
];
