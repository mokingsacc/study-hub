import { additive } from './annotations.js';
import { jsonResult, londonStamp } from './reply.js';
import { claudeChange, findTopic, MO_SAID } from './map.js';
import { inboxPage, ITEMS_MAX } from '../map/photo-inbox.js';

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
export const inboxUrl = env => `${env && env.HUB_ORIGIN ? env.HUB_ORIGIN : ''}/#map?photos=1`;
const CAP = 6000;

async function list(env, user, args) {
  const r = await inboxPage(env, user, { cursor: args.cursor || null, limit: 4 });
  if (!r.waiting) {
    const out = { waiting: 0, photos: [], next_step: `The inbox is empty. Photos pasted into this chat cannot reach the hub from here: ask Mo to paste them into the hub's Photo inbox (${inboxUrl(env)}), then call list again.` };
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false };
  }
  const head = {
    waiting: r.waiting,
    photos: r.photos.map((p, i) => ({ n: i + 1, id: p.id, added: londonStamp(p.at), ...(p.data ? {} : { note: 'Too large to show here.' }) })),
    ...(r.next_cursor ? { next_cursor: r.next_cursor } : {}),
    next_step: `Look at each picture and pick its topic (map_search if unsure; ask Mo when two fit). Then file {items: [{id, topic}]} (up to ${ITEMS_MAX}).${r.next_cursor ? ' More are waiting: list with next_cursor.' : ''}`,
  };
  const content = [{ type: 'text', text: JSON.stringify(head) }];
  r.photos.forEach((p, i) => {
    if (!p.data) return;
    content.push({ type: 'text', text: `Photo ${i + 1}: ${p.id}` });
    content.push({ type: 'image', data: b64(p.data), mimeType: p.mime });
  });
  return { content, structuredContent: head, isError: false };
}

async function file(env, user, args, ctx) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) return { refused: true, reason: 'Send items: [{id, topic}], one per photo.' };
  const resolved = [], unclear = [];
  for (const it of items) {
    const f = await findTopic(env, user, it.topic);
    if (f.topic) resolved.push({ id: it.id, topic_id: f.topic.id });
    else unclear.push({ id: it.id, topic: it.topic, candidates: f.candidates || [] });
  }
  // Nothing is filed until every topic is clear, so one change holds them all (one "undo that").
  if (unclear.length) return { filed: [], unclear, next_step: 'Nothing filed yet. Pick from the candidates (ask Mo if two fit), or map_search, then call file again with topic ids.' };
  return claudeChange(env, user, 'photo_inbox.file', { items: resolved, mo_said: args.mo_said }, ctx);
}

export const PHOTO_TOOLS = [
  {
    name: 'map_photo_inbox', title: 'Photo inbox', annotations: additive('Photo inbox'), raw: true,
    description: 'Photos Mo pasted into the hub\'s Photo inbox, to file on topics. list: a few as images (cursor: more); file {items: [{id, topic}]}; discard {ids}.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'file', 'discard'] }, cursor: { type: 'string', maxLength: 80 },
      items: { type: 'array', minItems: 1, maxItems: ITEMS_MAX, items: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, topic: { type: 'string', minLength: 1, maxLength: 120 } },
        required: ['id', 'topic'], additionalProperties: false } },
      ids: { type: 'array', minItems: 1, maxItems: ITEMS_MAX, items: { type: 'string', maxLength: 64 } }, mo_said: MO_SAID }, required: ['action'], additionalProperties: false },
    run: async (env, user, args, rawCtx = {}) => {
      const ctx = { surface: 'chat', via: 'mcp:map_photo_inbox', request_id: rawCtx.request_id || null };
      // A failure is said by the transport (mcp.js failure): refusals plainly, the database's own words never.
      if (args.action === 'list') return list(env, user, args);
      const payload = args.action === 'file' ? await file(env, user, args, ctx)
        : Array.isArray(args.ids) && args.ids.length ? await claudeChange(env, user, 'photo_inbox.discard', { ids: args.ids, mo_said: args.mo_said }, ctx)
          : { refused: true, reason: 'Send ids: the photos to take out of the inbox.' };
      return jsonResult({ as_of: londonStamp(), ...payload }, { cap: CAP });
    },
  },
];
