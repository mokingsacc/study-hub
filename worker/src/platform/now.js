import { HttpError, json, readJson, londonDay, safeParse, now as nowMs } from '../util.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { requireModule, LEARNER, sessionModules } from './modules.js';
import { dueCount, cardsToFix } from './cards.js';
import { weakGroups } from './teach.js';

export const SURE = { guess: { grade: 'again', word: 'Guess' }, lean: { grade: 'hard', word: 'Lean' }, sure: { grade: 'good', word: 'Sure' } };
const DAY_MS = 86_400_000;

export async function nextSteps(env, user, mods = {}, { t = nowMs() } = {}) {
  const on = m => mods[m] !== false;
  const [due, groups, weakest, row, fix] = await Promise.all([
    on('cards') ? dueCount(env, user).catch(() => 0) : 0,
    weakGroups(env, user, { limit: 1 }).catch(() => []),
    env.DB.prepare(`SELECT t.id, t.name FROM topics t JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
      JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
      WHERE t.user_id = ? AND t.status IN ('proposed','confirmed') AND sc.seen = 1 ORDER BY sc.t DESC LIMIT 1`).bind(user).first().catch(() => null),
    env.DB.prepare('SELECT profile_json FROM users WHERE id = ?').bind(user).first(),
    on('cards') ? cardsToFix(env, user, { limit: 50 }).catch(() => []) : [],
  ]);
  const steps = [];
  if (due) steps.push({ kind: 'cards', title: `Review ${due} card${due === 1 ? '' : 's'}`, why: 'Due now: a few minutes keeps them from piling up.', minutes: Math.max(2, Math.ceil(due / 4)), href: '#cards/review' });
  const g = groups[0];
  if (g) steps.push({ kind: 'group', title: `The big picture: ${g.section}`, why: `${g.topics.length} topics here are weak; one lesson on what connects them.`, minutes: 20,
    prompt: `Teach me the big picture of ${g.section}: ${g.topics.map(x => x.name).join(', ')}` });
  else if (weakest) steps.push({ kind: 'teach', title: `Teach me ${weakest.name}`, why: 'Your weakest topic right now.', minutes: 15, prompt: `Teach me ${weakest.name}` });
  const exam = (safeParse(row && row.profile_json, {}) || {}).exam_date;
  const days = exam ? Math.round((Date.parse(`${exam}T12:00:00Z`) - Date.parse(`${londonDay(t)}T12:00:00Z`)) / DAY_MS) : null;
  if (days != null && days >= 0 && days <= 21 && (on('papers') || on('exams'))) {
    steps.push({ kind: 'paper', title: 'A practice paper', why: `Your exam is in ${days} day${days === 1 ? '' : 's'}: practise under time.`, minutes: 45, prompt: 'Make me a practice paper on my weakest topics, timed like the real thing' });
  }
  if (fix.length) steps.push({ kind: 'fix', title: `Fix ${fix.length} card${fix.length === 1 ? '' : 's'}`, why: 'Ones you skipped or keep forgetting: your Claude rewrites them.', minutes: 5, prompt: 'Fix my flagged flashcards in my Study Hub' });
  return { steps: steps.slice(0, 3) };
}

export async function rateTopic(env, user, topicId, level, { t = nowMs() } = {}) {
  if (level != null && !SURE[level]) throw new HttpError(400, 'How sure is guess, lean or sure.');
  const topic = await env.DB.prepare(`SELECT id, name, category_id FROM topics WHERE user_id = ? AND id = ? AND status IN ('proposed','confirmed')`).bind(user, topicId).first();
  if (!topic) throw new HttpError(404, 'That topic is not on your map.');
  const day = londonDay(t), obs_key = `self:${topic.id}:topic:${day}`;
  const prev = await env.DB.prepare('SELECT rating FROM evidence WHERE user_id = ? AND obs_key = ? AND slot = 0').bind(user, obs_key).first();
  const prevLevel = prev ? Object.keys(SURE).find(k => SURE[k].grade === prev.rating) : null;
  const ctx = { actor: LEARNER, surface: 'web', via: 'platform:sure', undoable: false };
  if (level == null || prevLevel === level) {
    if (!prev) return { level: null };
    await writeBatch(env, user, { ...ctx, evidence: { remove: [{ obs_key, slot: 0 }] }, recompute: [topic.id],
      events: [{ kind: 'self.rated', target_type: 'topic', target_id: topic.id, topic_id: topic.id, summary: summaryOf(`Rating taken off: ${topic.name}`) }] });
    return { level: null };
  }
  await writeBatch(env, user, { ...ctx, evidence: { upsert: [{ obs_key, slot: 0, topic_id: topic.id, category_id: topic.category_id || null, kind: 'self_rating',
    rating: SURE[level].grade, amount: 1, at: t, day, source: 'self', source_ref: 'topic', created_by: LEARNER,
    detail_json: JSON.stringify({ label: 'self-rating', step: 'recognise', level, part: 'topic' }) }] },
    events: [{ kind: 'self.rated', target_type: 'topic', target_id: topic.id, topic_id: topic.id, summary: summaryOf(`You rated ${topic.name}: ${SURE[level].word}`) }] });
  return { level };
}

export async function todaysRating(env, user, topicId, t = nowMs()) {
  const r = await env.DB.prepare('SELECT rating FROM evidence WHERE user_id = ? AND obs_key = ? AND slot = 0').bind(user, `self:${topicId}:topic:${londonDay(t)}`).first().catch(() => null);
  return r ? Object.keys(SURE).find(k => SURE[k].grade === r.rating) || null : null;
}

export const ROUTES = [
  ['GET', '/api/p/next', async (rq, env, ctx, params, url, user, session) => {
    requireModule(session, 'map', env);
    return json(await nextSteps(env, user, sessionModules(session, env)));
  }],
  ['GET', '/api/p/topics/:id/sure', async (rq, env, ctx, params, url, user, session) => { requireModule(session, 'map', env); return json({ level: await todaysRating(env, user, params.id) }); }],
  ['POST', '/api/p/topics/:id/sure', async (rq, env, ctx, params, url, user, session) => {
    requireModule(session, 'map', env);
    return json(await rateTopic(env, user, params.id, (await readJson(rq, 500)).level ?? null));
  }],
];
