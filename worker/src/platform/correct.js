import { HttpError, json, readJson, now as nowMs } from '../util.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { applyChange } from '../map/change.js';
import { looksLikeStem } from '../map/guard.js';
import { requireModule, LEARNER } from './modules.js';

const WORDS_MAX = 200;
const clean = w => { const t = typeof w === 'string' ? w.replace(/\s+/g, ' ').trim() : ''; return t; };

export async function correct(env, user, b = {}) {
  const kind = b.kind, action = b.action, id = typeof b.id === 'string' ? b.id.slice(0, 160) : '';
  if (!['misconception', 'gap'].includes(kind)) throw new HttpError(400, 'Say what to correct: a mix-up or a gap note.');
  if (!['not_mine', 'words'].includes(action)) throw new HttpError(400, 'Say what was not right: not yours, or the words.');
  if (!id) throw new HttpError(400, 'Which one? The id is missing.');
  let words = null;
  if (action === 'words') {
    words = clean(b.words);
    if (!words) throw new HttpError(400, 'Write it the way it really is.');
    if (words.length > WORDS_MAX) throw new HttpError(400, `At most ${WORDS_MAX} characters.`);
    if (looksLikeStem(words)) throw new HttpError(400, 'Put it in your own words.');
  }
  const ctx = { actor: LEARNER, surface: 'web', via: 'platform:correct' };
  if (kind === 'misconception') {
    const row = await env.DB.prepare('SELECT id FROM misconceptions WHERE user_id = ? AND id = ?').bind(user, id).first();
    if (!row) throw new HttpError(404, 'That mix-up is not on your map.');
    const r = action === 'not_mine'
      ? await applyChange(env, user, { ...ctx, op: 'misconception.close', args: { id, note: 'They said this is not what they think' } })
      : await applyChange(env, user, { ...ctx, op: 'misconception.update', args: { id, belief: words } });
    if (!r.ok && !r.nothing) throw new HttpError(400, r.reason || 'That could not be changed.');
    return { ok: true, kind, id, action, batch_id: r.batch_id || null };
  }
  const g = await env.DB.prepare('SELECT * FROM gaps WHERE user_id = ? AND id = ?').bind(user, id).first();
  if (!g) throw new HttpError(404, 'That gap note is not on your map.');
  const t = nowMs();
  if (action === 'words') {
    const r = await writeBatch(env, user, { ...ctx, undoable: true,
      rows: [{ table: 'gaps', op: 'update', key: { id }, before: { gap: g.gap, said: g.said ?? null }, after: { gap: words, said: words } }],
      events: [{ kind: 'gap.corrected', target_type: 'gaps', target_id: id, topic_id: g.topic_id || null, summary: summaryOf(`Gap note corrected: ${words}`) }] });
    return { ok: true, kind, id, action, batch_id: r.batch_id };
  }
  const ev = ((await env.DB.prepare('SELECT obs_key FROM evidence WHERE user_id = ? AND gap_id = ?').bind(user, id).all()).results || []).map(r => r.obs_key);
  const r = await writeBatch(env, user, { ...ctx, undoable: true,
    rows: [{ table: 'gaps', op: 'delete', key: { id }, before: g, after: null }],
    ...(ev.length ? { evidence: { remove: ev } } : {}), recompute: g.topic_id ? [g.topic_id] : [],
    events: [{ kind: 'gap.corrected', target_type: 'gaps', target_id: id, topic_id: g.topic_id || null, summary: summaryOf(`Gap note removed as not right: ${g.gap || ''}`), at: t }] });
  return { ok: true, kind, id, action, batch_id: r.batch_id };
}

export const ROUTES = [
  ['POST', '/api/p/correct', async (rq, env, ctx, params, url, user, session) => {
    requireModule(session, 'map', env);
    return json(await correct(env, user, await readJson(rq, 2_000)));
  }],
];
