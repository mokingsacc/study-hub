import { HttpError, json, readJson, safeParse } from '../util.js';
import { prefsStatement } from '../users.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { LEARNER } from './modules.js';
import { ringOf, chipOf } from './subjects.js';
import { cardStats } from './cards.js';
import { lastResults } from './results.js';
import { BANKS } from './banks.js';

const ok = (data, status = 200) => json(data, status);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const SHOWS = [
  'A ring for each subject (how much of it you know)',
  'Your five weakest topics',
  'How many flashcards are due',
  'The scores of your last five results',
  'Your streak',
];

/** Has this person switched sharing on? Anything but a literal true is off. */
export async function isSharing(env, user) {
  const u = await env.DB.prepare('SELECT prefs_json FROM users WHERE id = ?').bind(user).first();
  const prefs = safeParse(u && u.prefs_json, {});
  return !!(isObj(prefs) && isObj(prefs.sharing) && prefs.sharing.progress === true);
}


export async function sharedSummary(env, user) {
  const [subj, weak, results, stats] = await Promise.all([
    env.DB.prepare(`SELECT s.id, s.name,
        COUNT(t.id) AS topics_n,
        COALESCE(SUM(CASE WHEN sc.seen = 1 THEN 1 ELSE 0 END), 0) AS seen_n,
        COALESCE(SUM(CASE WHEN sc.seen = 1 AND sc.band IN ('weak','very_weak') THEN 1 ELSE 0 END), 0) AS weak_n
      FROM subjects s
      LEFT JOIN topics t ON t.user_id = s.user_id AND t.category_id = s.id AND t.status IN ('proposed','confirmed')
      LEFT JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
      WHERE s.user_id = ?1 AND s.status = 'active' GROUP BY s.id ORDER BY s.sort, s.created_at`).bind(user).all(),
    env.DB.prepare(`SELECT t.id, t.name, s.name AS subject_name, sc.seen, sc.t, sc.band
      FROM topic_scores sc
      JOIN topics t ON t.user_id = sc.user_id AND t.id = sc.topic_id AND t.status IN ('proposed','confirmed')
      JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
      WHERE sc.user_id = ?1 AND sc.seen = 1 ORDER BY sc.t DESC, t.name LIMIT 5`).bind(user).all(),
    lastResults(env, user, 5).catch(() => []),
    cardStats(env, user).catch(() => ({ due_now: 0, streak_days: 0 })),
  ]);
  const names = new Map(((await env.DB.prepare('SELECT id, name FROM subjects WHERE user_id = ?').bind(user).all()).results || []).map(s => [s.id, s.name]));
  return {
    rings: (subj.results || []).map(s => ({ subject: s.name, ring: ringOf(Number(s.topics_n) || 0, Number(s.seen_n) || 0, Number(s.weak_n) || 0),
      topics: Number(s.topics_n) || 0, seen: Number(s.seen_n) || 0, weak: Number(s.weak_n) || 0 })),
    weakest: (weak.results || []).map(w => ({ topic: w.name, subject: w.subject_name, band: chipOf(w).band })),
    cards_due: Number(stats.due_now) || 0,
    last_results: (results || []).slice(0, 5).map(r => ({
      subject: names.get(r.subject_id) || null, source: (BANKS[r.bank] || {}).name || r.bank, day: r.day,
      marks: r.marks ?? null, out_of: r.out_of ?? null, right_n: r.right_n ?? null, total_n: r.total_n ?? null,
      percent: r.out_of ? Math.round(100 * (r.marks || 0) / r.out_of) : r.total_n ? Math.round(100 * (r.right_n || 0) / r.total_n) : null,
    })),
    streak_days: Number(stats.streak_days) || 0,
  };
}

/** sharedSummary, or null when the person has not switched sharing on. */
export async function sharedSummaryIfOn(env, user) {
  return (await isSharing(env, user)) ? sharedSummary(env, user) : null;
}

// ------------------------------------------------------------------ routes

async function view(env, user) {
  return { share: await isSharing(env, user), shows: SHOWS,
    never: 'Your library, notes, "gap:" notes, flashcards, paper answers and result labels are never shared.',
    preview: await sharedSummary(env, user) };
}

async function getSharing(request, env, ctx, params, url, user) {
  return ok(await view(env, user));
}

async function putSharing(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000);
  if (typeof body.share !== 'boolean') throw new HttpError(400, 'Say share: true or false.');
  const was = await isSharing(env, user);
  if (was !== body.share) {
    await writeBatch(env, user, {
      actor: LEARNER, surface: 'web', via: 'sharing', undoable: false,
      statements: [prefsStatement(env, user, 'sharing.progress', body.share)],
      events: [{ kind: 'pref.changed', target_type: 'pref', target_id: 'sharing.progress', summary: summaryOf(`Sharing progress with Mo switched ${body.share ? 'on' : 'off'}`), before: { on: was }, after: { on: body.share } }],
    });
  }
  return ok(await view(env, user));
}

export const ROUTES = [
  ['GET', '/api/p/sharing', getSharing],
  ['PUT', '/api/p/sharing', putSharing],
];
export const TOOLS = [];
