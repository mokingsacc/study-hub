import { HttpError, readJson } from '../util.js';
import { applyChange, changeResponse } from './change.js';
import { liveTopic, searchTopics } from './resolve.js';
import { rawKey } from './ingest/map-fields.js';
import { summaryOf } from './events.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEYS = ['miss_id', 'id', 'to', 'topic_id', 'reason'];
export const MOVE_KIND = 'miss.placed', MOVE_TARGET = 'moved_miss';

// The target topic by id, or by a name or alias that is clear (score 0.9, no tie).
async function targetTopic(env, user, ref) {
  const s = String(ref || '').trim();
  if (!s) return { refuse: 'Which topic? (to is missing)', field: 'to' };
  if (/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    const t = await liveTopic(env, user, s);
    if (t) return { topic: t };
  }
  const hits = await searchTopics(env, user, { q: s, limit: 5 });
  if (hits.length && hits[0].score >= 0.9 && !(hits[1] && hits[1].score >= hits[0].score)) {
    const t = await liveTopic(env, user, hits[0].id);
    if (t) return { topic: t };
  }
  const names = hits.slice(0, 3).map(h => `${h.name} (${h.id})`).join(', ');
  return { refuse: names ? `"${s}" is not clear: ${names}. Send the topic id.` : `No topic on the map is called "${s}".`, field: 'to' };
}

/**
 * Planner for miss.move {miss_id, to, reason?}: one live miss onto another live topic. Refuses an unknown or held
 * miss, an unknown or unclear topic, and a move onto the topic it is already on.
 */
export async function planMissMove(env, user, args, ctx = {}) {
  const a = isObj(args) ? args : {};
  for (const k of Object.keys(a)) if (!KEYS.includes(k)) return { refuse: `Unknown field ${k}.`, field: k };
  const id = String(a.miss_id ?? a.id ?? '').trim();
  if (!id || id.length > 120) return { refuse: 'Which miss? (miss_id is missing)', field: 'miss_id' };
  const m = await env.DB.prepare(`SELECT id, label, topic_id, category_id, match_status, match_method, held, deleted_at FROM misses
      WHERE user_id = ? AND id = ?`).bind(user, id).first();
  if (!m || m.deleted_at != null) return { refuse: 'There is no miss with that id.', field: 'miss_id' };
  if (Number(m.held) === 1) return { refuse: "That miss is from a sitting that is not finished, so it is not on the map yet.", field: 'miss_id' };
  const t = await targetTopic(env, user, a.to ?? a.topic_id);
  if (t.refuse) return t;
  const to = t.topic;
  if (m.topic_id === to.id) return { noop: true, summary: `${m.label} is already on ${to.name}.` };
  const actor = ctx.actor === 'mo' ? 'mo' : 'claude';
  const from = m.topic_id ? await env.DB.prepare('SELECT id, name FROM topics WHERE user_id = ? AND id = ?').bind(user, m.topic_id).first() : null;
  const rows = [{
    table: 'misses', op: 'update', key: { id: m.id },
    before: { topic_id: m.topic_id ?? null, category_id: m.category_id ?? null, match_status: m.match_status ?? null, match_method: m.match_method ?? null },
    after: { topic_id: to.id, category_id: to.category_id ?? m.category_id ?? null, match_status: 'matched', match_method: actor },
  }];
  const summary = summaryOf(`${m.label} moved to ${to.name}${from ? ` (was ${from.name})` : ''}`);
  // A look-alike row (slot 1 or 2) already on the target would put the miss and its own look-alike on one topic
  // (counted twice there, the pair's mix-up lost), so it swaps onto the topic the miss leaves; undo swaps it back.
  const key = rawKey(user, m.id);
  const swap = m.topic_id ? ((await env.DB.prepare('SELECT slot FROM evidence WHERE user_id = ? AND obs_key = ? AND slot > 0 AND topic_id = ?')
    .bind(user, key, to.id).all()).results || []).map(r => Number(r.slot)) : [];
  const events = [{ kind: MOVE_KIND, target_type: MOVE_TARGET, target_id: m.id, topic_id: to.id, summary,
    ...(swap.length ? { before: { ...rows[0].key, ...rows[0].before, lookalike_slots: swap } } : {}) }];
  // Look-alike support the miss gave on its old topic goes with it (B3-8), as when a placement moves a row.
  if (m.topic_id) {
    const { staleSupportParts } = await import('./ingest/hub.js');
    const stale = await staleSupportParts(env, user, [{ id: m.id, topic_id: to.id }]);
    rows.push(...stale.rows);
    // Undoable with the move, so undo gives the old pair its look-alike support back (links' undoLinkEvent).
    events.push(...stale.events.map(e => ({ ...e, undoable: true })));
  }
  return {
    rows, events, evidence: { repoint: [{ obs_keys: [key], slot: 0, to_topic: to.id },
      ...swap.map(slot => ({ obs_keys: [key], slot, to_topic: m.topic_id }))] },
    touched_topics: [m.topic_id, to.id].filter(Boolean), count: 1, summary,
    reply: { miss_id: m.id, from: from ? { id: from.id, name: from.name } : null, to: { id: to.id, name: to.name } },
  };
}

const parse = v => { if (v == null || typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };

/**
 * UNDO['target:moved_miss']: the miss goes back to the topic it was on, and its own answer with it. A miss moved
 * again since is a conflict. Returns {rows, evidence: {upsert}, recompute} or {conflict}.
 */
export async function undoMissMove(env, user, ev) {
  const before = parse(ev.before_json) || {};
  const [cur, evs] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND id = ?').bind(user, ev.target_id),
    env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND obs_key = ?').bind(user, rawKey(user, ev.target_id)),
  ]);
  const row = (cur.results || [])[0];
  if (!row) return { conflict: 'That miss is no longer there.' };
  if (row.topic_id !== ev.topic_id) return { conflict: 'That miss was moved again since; undo the later change first.' };
  const back = { topic_id: before.topic_id ?? null, category_id: before.category_id ?? row.category_id, match_status: before.match_status ?? row.match_status,
    match_method: before.match_method ?? null };
  const was = Object.fromEntries(Object.keys(back).map(k => [k, row[k] ?? null]));
  // Its own answer (slot 0) goes back; a look-alike row the move swapped onto the old topic returns to the target.
  const swapped = new Set((Array.isArray(before.lookalike_slots) ? before.lookalike_slots : []).map(Number));
  const toCat = (parse(ev.after_json) || {}).category_id ?? null;
  const strip = r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v;
    return o;
  };
  const upsert = (evs.results || []).flatMap(r => {
    const o = strip(r), slot = Number(r.slot);
    if (slot === 0) return [{ ...o, topic_id: back.topic_id, category_id: back.topic_id ? back.category_id ?? o.category_id : o.category_id }];
    if (swapped.has(slot) && back.topic_id && r.topic_id === back.topic_id) return [{ ...o, topic_id: ev.topic_id, category_id: toCat ?? o.category_id }];
    return [];
  });
  return { rows: [{ table: 'misses', op: 'update', key: { id: ev.target_id }, before: was, after: back }], evidence: { upsert },
    recompute: [ev.topic_id, back.topic_id].filter(Boolean) };
}

export async function moveRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  if (!isObj(body)) throw new HttpError(400, 'Send {to}.');
  for (const k of Object.keys(body)) if (!['to', 'topic_id', 'reason'].includes(k)) throw new HttpError(400, `Unknown field ${k}.`);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'miss.move', args: { miss_id: params.id, ...body },
    via: 'api:POST /api/map/misses/:id/move' }));
}
