// Chat notes (30 Oct): what they and their Claude covered in a chat, so the next lesson starts from it. Their Claude
// saves a short summary as it goes, without asking (chat_save: at the end of a topic, when they finish, and about
// every 15 messages; one chat_key a chat, so later saves add to the same note), and they can paste a whole chat or a
// summary in the app (Paste from Claude). The hub keeps the words as written and does not analyse them (no AI, no
// cost); their Claude reads them (chat_notes, and topic_detail's chats) before teaching or testing a topic.
//   GET    /api/p/chats?topic=      {notes: [{id, title, source, topics, excerpt, saves, updated_at}]}
//   GET    /api/p/chats/:id         {note}
//   POST   /api/p/chats             {text, title?, topic_id?}: a paste
//   DELETE /api/p/chats/:id         undoable
//   tools  chat_save, chat_notes
import { HttpError, json, readJson, now as nowMs } from '../util.js';
import { writeBatch, rand } from '../map/events.js';
import { LEARNER, requireModule } from './modules.js';
import { Plan, resolveTopic } from './subjects.js';

export const LIMITS = { save: 4000, paste: 60000, note: 60000, title: 100, topics: 8, list: 30 };
const st = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const clean = (s, n) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const parse = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

async function topicNames(env, user, ids) {
  if (!ids.length) return new Map();
  const rows = (await st(env, `SELECT id, name FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(ids)).all()).results || [];
  return new Map(rows.map(r => [r.id, r.name]));
}
// Topic names or ids (theirs) to ids; unknown or shared names are left out and said back.
async function topicIdsOf(env, user, refs = []) {
  const ids = [], unknown = [];
  for (const ref of (Array.isArray(refs) ? refs : []).slice(0, LIMITS.topics)) {
    try { const r = await resolveTopic(env, user, String(ref)); if (r.id) ids.push(r.id); else unknown.push(String(ref).slice(0, 60)); }
    catch { unknown.push(String(ref).slice(0, 60)); }
  }
  return { ids: [...new Set(ids)], unknown };
}

const shapeNote = (r, names, full = false) => ({ id: r.id, title: r.title || null, source: r.source, saves: r.saves,
  topics: parse(r.topic_ids_json).map(id => ({ id, name: names.get(id) || null })).filter(t => t.name),
  ...(full ? { body: r.body } : { excerpt: r.body.length > 280 ? `${r.body.slice(0, 279)}…` : r.body }), created_at: r.created_at, updated_at: r.updated_at });

/** One save from their Claude: a new note, or more on the same chat's note (chat_key). */
export async function saveChat(env, user, { summary, chat_key = null, title = null, topics = [] }, { actor = 'claude', source = 'claude' } = {}) {
  const body = clean(summary, source === 'paste' ? LIMITS.paste : LIMITS.save);
  if (!body) throw new HttpError(400, source === 'paste' ? 'Paste the chat or its summary first.' : 'summary is what you covered, in your own words.');
  const key = chat_key ? oneLine(chat_key, 80) : null;
  const { ids, unknown } = await topicIdsOf(env, user, topics);
  const t = nowMs();
  const was = key ? await st(env, 'SELECT * FROM chat_notes WHERE user_id = ?1 AND chat_key = ?2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1', user, key).first() : null;
  const plan = new Plan();
  let id;
  if (was) {
    id = was.id;
    const joined = `${was.body}\n\n${body}`;
    const next = { body: joined.length > LIMITS.note ? joined.slice(joined.length - LIMITS.note) : joined,
      topic_ids_json: JSON.stringify([...new Set([...parse(was.topic_ids_json), ...ids])].slice(0, 20)), saves: was.saves + 1,
      title: was.title || oneLine(title, LIMITS.title) || null, updated_at: t };
    plan.add({ table: 'chat_notes', op: 'update', key: { id }, before: { body: was.body, topic_ids_json: was.topic_ids_json, saves: was.saves, title: was.title, updated_at: was.updated_at }, after: next },
      { kind: 'chat.saved', target_type: 'chat_notes', target_id: id, topic_id: ids[0] || null, summary: `Chat notes added to: ${next.title || 'a chat'}` });
  } else {
    id = `ch_${rand().slice(0, 12)}`;
    const ttl = oneLine(title, LIMITS.title) || oneLine(body, 60);
    plan.add({ table: 'chat_notes', op: 'insert', key: { id }, before: null,
      after: { chat_key: key, source, title: ttl, body, topic_ids_json: JSON.stringify(ids), saves: 1, created_at: t, updated_at: t, deleted_at: null } },
    { kind: 'chat.saved', target_type: 'chat_notes', target_id: id, topic_id: ids[0] || null, summary: source === 'paste' ? `Pasted from Claude: ${ttl}` : `Chat saved: ${ttl}` });
  }
  const w = await writeBatch(env, user, { actor, surface: actor === 'claude' ? 'chat' : 'web', via: `platform:chat.${source}`, rows: plan.rows, events: plan.events, undoable: true });
  return { id, added_to: !!was, topics: ids.length, ...(unknown.length ? { topics_not_found: unknown } : {}), batch_id: w.batch_id };
}

export async function listChats(env, user, { topic = null, q = '' } = {}) {
  const rows = (await st(env, `SELECT * FROM chat_notes WHERE user_id = ?1 AND deleted_at IS NULL ${topic ? 'AND EXISTS (SELECT 1 FROM json_each(topic_ids_json) j WHERE j.value = ?2)' : ''}
    ORDER BY updated_at DESC LIMIT ${LIMITS.list * 3}`, ...(topic ? [user, topic] : [user])).all()).results || [];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = rows.filter(r => words.every(w => `${r.title} ${r.body}`.toLowerCase().includes(w))).slice(0, LIMITS.list);
  const names = await topicNames(env, user, [...new Set(hits.flatMap(r => parse(r.topic_ids_json)))]);
  return hits.map(r => shapeNote(r, names));
}

async function oneChat(env, user, id) {
  const r = typeof id === 'string' && id.length <= 40 ? await st(env, 'SELECT * FROM chat_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL', user, id).first() : null;
  if (!r) throw new HttpError(404, 'There is no such chat note.');
  return shapeNote(r, await topicNames(env, user, parse(r.topic_ids_json)), true);
}

async function removeChat(env, user, id) {
  const r = await oneChat(env, user, id);
  const plan = new Plan().add({ table: 'chat_notes', op: 'update', key: { id }, before: { deleted_at: null }, after: { deleted_at: nowMs() } },
    { kind: 'chat.saved', target_type: 'chat_notes', target_id: id, summary: `Chat note removed: ${r.title || 'a chat'}` });
  const w = await writeBatch(env, user, { actor: LEARNER, surface: 'web', via: 'platform:chat.remove', rows: plan.rows, events: plan.events, undoable: true });
  return { ok: true, batch_id: w.batch_id };
}

const gate = fn => async (request, env, ctx, params, url, user, session) => { requireModule(session, 'map', env); return fn(request, env, ctx, params, url, user, session); };

export const ROUTES = [
  ['GET', '/api/p/chats', gate(async (rq, env, ctx, params, url, user) => json({ notes: await listChats(env, user, { topic: url.searchParams.get('topic'), q: url.searchParams.get('q') || '' }) }))],
  ['GET', '/api/p/chats/:id', gate(async (rq, env, ctx, params, url, user) => json({ note: await oneChat(env, user, params.id) }))],
  ['POST', '/api/p/chats', gate(async (rq, env, ctx, params, url, user) => {
    const b = await readJson(rq, 200_000);
    return json(await saveChat(env, user, { summary: b.text, title: b.title, topics: b.topic_id ? [b.topic_id] : [] }, { actor: LEARNER, source: 'paste' }), 201);
  })],
  ['DELETE', '/api/p/chats/:id', gate((rq, env, ctx, params, url, user) => removeChat(env, user, params.id).then(json))],
];

export const TOOLS = [
  {
    name: 'chat_save', module: 'map',
    description: 'Saves what you and the student covered in this chat, so the next lesson starts from it. Do it as you go without asking: at the end of a topic, when they finish, and about every 15 messages. '
      + 'summary: a short note in your own words (what they understood, what they mixed up, what is still to do); topics: the topics it covered (names or ids); chat_key: the same short key for every save in this chat, so they add to one note.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: {
      summary: { type: 'string', maxLength: LIMITS.save }, topics: { type: 'array', maxItems: LIMITS.topics, items: { type: 'string' } },
      chat_key: { type: 'string', maxLength: 80 }, title: { type: 'string', maxLength: LIMITS.title } } },
    run: (env, user, a) => saveChat(env, user, a, { actor: 'claude', source: 'claude' }),
  },
  {
    name: 'chat_notes', module: 'map',
    description: 'The student\'s saved chat notes (yours from earlier chats, and chats they pasted in): newest first, for one topic or matching words; with id, one note in full. Read them before teaching or testing a topic.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { topic: { type: 'string' }, query: { type: 'string' }, id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    async run(env, user, a) {
      if (a.id) return { note: await oneChat(env, user, a.id) };
      let topic = null;
      if (a.topic) { const r = await resolveTopic(env, user, a.topic).catch(() => null); if (r && r.ambiguous) return r; topic = r && r.id; if (!topic) return { notes: [], note: `No topic of theirs is called ${String(a.topic).slice(0, 60)}.` }; }
      return { notes: await listChats(env, user, { topic, q: a.query || '' }) };
    },
  },
];
