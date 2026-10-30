// The daily tracker (30 Oct): which days they used the Study Hub and for how long, for a year's grid like Anki's
// (Today's tile and #progress). The page sends a beat a minute while it is open and in front of them (POST
// /api/p/activity); what they did each day (cards, tests, papers, lessons, mnemonics) is counted from their events.
//   POST /api/p/activity        {seconds}  one beat (at most 2 minutes counted)
//   GET  /api/p/activity?days=  {days: [{day, minutes, actions}], stats: {daily_minutes, days_pct, longest, current, total_days}}
import { json, readJson, londonDay, now as nowMs } from '../util.js';
import { requireModule } from './modules.js';

const DAY_MS = 86_400_000;
// What counts as doing something on a day (map_events kinds), the bookkeeping left out.
const DOING = ['card.reviewed', 'results.logged', 'mnemonic.reviewed', 'lesson.saved', 'lesson.started', 'gap.added', 'chat.saved'];

export async function beat(env, user, seconds, t = nowMs()) {
  const s = Math.max(0, Math.min(120, Math.round(Number(seconds) || 0)));
  const day = londonDay(t);
  await env.DB.prepare(`INSERT INTO activity_days (user_id, day, seconds, beats, first_at, last_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)
    ON CONFLICT (user_id, day) DO UPDATE SET seconds = seconds + ?3, beats = beats + 1, last_at = ?4`).bind(user, day, s, t).run();
  return { ok: true, day };
}

/** Longest and current runs of days in a sorted list of 'YYYY-MM-DD' (current: up to today or yesterday). Pure. */
export function streaks(days, today) {
  const num = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS;
  let longest = 0, run = 0, prev = null;
  for (const d of days) { const n = num(d); run = prev != null && n === prev + 1 ? run + 1 : 1; prev = n; longest = Math.max(longest, run); }
  const t = num(today);
  const last = days.length ? num(days[days.length - 1]) : null;
  return { longest, current: last != null && t - last <= 1 ? run : 0 };
}

export async function activity(env, user, { days = 365, t = nowMs() } = {}) {
  const since = t - days * DAY_MS, sinceDay = londonDay(since);
  const [a, e] = await env.DB.batch([
    env.DB.prepare('SELECT day, seconds FROM activity_days WHERE user_id = ?1 AND day >= ?2 ORDER BY day').bind(user, sinceDay),
    env.DB.prepare(`SELECT at FROM map_events WHERE user_id = ?1 AND at >= ?2 AND kind IN (${DOING.map(k => `'${k}'`).join(', ')}) LIMIT 50000`).bind(user, since),
  ]);
  const by = new Map();
  for (const r of a.results || []) by.set(r.day, { day: r.day, minutes: Math.round((Number(r.seconds) || 0) / 60), actions: 0 });
  for (const r of e.results || []) { const d = londonDay(r.at); const x = by.get(d) || by.set(d, { day: d, minutes: 0, actions: 0 }).get(d); x.actions += 1; }
  const list = [...by.values()].filter(x => x.minutes > 0 || x.actions > 0).sort((p, q) => (p.day < q.day ? -1 : 1));
  const today = londonDay(t);
  const s = streaks(list.map(x => x.day), today);
  const first = list.length ? list[0].day : today;
  const span = Math.max(1, Math.round((Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - Date.UTC(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10))) / DAY_MS) + 1);
  const minutes = list.reduce((m, x) => m + x.minutes, 0);
  return { days: list, today, stats: { daily_minutes: list.length ? Math.round(minutes / list.length) : 0, days_pct: Math.round((100 * list.length) / span),
    longest: s.longest, current: s.current, total_days: list.length, total_minutes: minutes } };
}

const gate = fn => async (request, env, ctx, params, url, user, session) => { requireModule(session, 'map', env); return fn(request, env, ctx, params, url, user, session); };

export const ROUTES = [
  ['POST', '/api/p/activity', gate(async (rq, env, ctx, params, url, user) => json(await beat(env, user, (await readJson(rq, 1_000)).seconds)))],
  ['GET', '/api/p/activity', gate(async (rq, env, ctx, params, url, user) => {
    const d = Number(url.searchParams.get('days') || 365);
    return json(await activity(env, user, { days: Number.isInteger(d) && d >= 7 && d <= 731 ? d : 365 }));
  })],
];
