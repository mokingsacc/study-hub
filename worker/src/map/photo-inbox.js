import { json, HttpError } from '../util.js';
import { summaryOf, rand } from './events.js';
import { applyChange, changeResponse } from './change.js';
import { TYPES, SOURCES, MAX_BYTES, MAX_PHOTOS, topicName } from './photos.js';

export const INBOX_MAX = 100;          // waiting at once
export const THUMB_MAX_BYTES = 700_000;  // the small copy Claude looks at
export const ITEMS_MAX = 20;           // photos filed or discarded in one change
export const ID = /^pi_[a-z0-9]{12,40}$/;

const bucket = env => {
  if (!env.LIBRARY || typeof env.LIBRARY.put !== 'function') throw new HttpError(503, "The hub's file store (R2) is not set up, so photos can't be kept yet.");
  return env.LIBRARY;
};
const dim = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 20_000 ? n : null; };
export const inboxKey = (user, id, mime, thumb = false) => `u/${user}/photo-inbox/${id}${thumb ? '-thumb' : ''}.${TYPES[mime]}`;
export const inboxPath = (id, thumb = false) => `/api/map/photo-inbox/${encodeURIComponent(id)}${thumb ? '?size=thumb' : ''}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const WAITING = 'deleted_at IS NULL AND filed_at IS NULL';

// ---------------------------------------------------------------- reads

/** How many photos are waiting. */
export async function waitingCount(env, user) {
  const r = await env.DB.prepare(`SELECT count(*) AS n FROM photo_inbox WHERE user_id = ? AND ${WAITING}`).bind(user).first();
  return (r && Number(r.n)) || 0;
}

/** Rows as the page shows them: [{id, src, thumb, w, h, source, at}]. */
export function shapeInbox(rows) {
  return (rows || []).map(p => ({ id: p.id, src: inboxPath(p.id), thumb: inboxPath(p.id, !!p.thumb_key), w: dim(p.width), h: dim(p.height),
    source: p.source, at: Number(p.created_at) || null }));
}

/** The waiting photos, oldest first: [{id, r2_key, thumb_key, mime, width, height, bytes, source, created_at}]. */
export async function waitingRows(env, user, { after = null, limit = INBOX_MAX } = {}) {
  const lim = Math.max(1, Math.min(INBOX_MAX, Number(limit) || INBOX_MAX));
  const cols = 'id, r2_key, thumb_key, mime, width, height, bytes, source, created_at';
  if (after) {
    return (await env.DB.prepare(`SELECT ${cols} FROM photo_inbox WHERE user_id = ? AND ${WAITING} AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id LIMIT ${lim}`).bind(user, after.at, after.at, after.id).all()).results || [];
  }
  return (await env.DB.prepare(`SELECT ${cols} FROM photo_inbox WHERE user_id = ? AND ${WAITING} ORDER BY created_at, id LIMIT ${lim}`).bind(user).all()).results || [];
}

/** A list cursor: "<created_at>.<id>" of the last photo shown. */
export const cursorOf = row => `${Number(row.created_at)}.${row.id}`;
export function parseCursor(c) {
  const m = /^(\d{1,16})\.(pi_[a-z0-9]{12,40})$/.exec(String(c || ''));
  return m ? { at: Number(m[1]), id: m[2] } : null;
}

/**
 * One page of waiting photos with the small copy's bytes, for Claude to look at: {waiting, photos: [{id, at, source,
 * w, h, mime, data: Uint8Array|null}], next_cursor}. A photo with no small copy sends the full one when it is small.
 */
export async function inboxPage(env, user, { cursor = null, limit = 4 } = {}) {
  const after = cursor ? parseCursor(cursor) : null;
  const lim = Math.max(1, Math.min(6, Number(limit) || 4));
  const [waiting, rows] = await Promise.all([waitingCount(env, user), waitingRows(env, user, { after, limit: lim + 1 })]);
  const page = rows.slice(0, lim);
  const photos = [];
  for (const r of page) {
    let data = null, mime = 'image/jpeg';
    for (const [key, type, max] of [[r.thumb_key, 'image/jpeg', THUMB_MAX_BYTES], [r.r2_key, r.mime, THUMB_MAX_BYTES]]) {
      if (!key) continue;
      const obj = await bucket(env).get(key);
      if (!obj) continue;
      const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
      if (bytes.length && bytes.length <= max) { data = bytes; mime = type; break; }
    }
    photos.push({ id: r.id, at: Number(r.created_at), source: r.source, w: dim(r.width), h: dim(r.height), mime, data });
  }
  return { waiting, photos, next_cursor: rows.length > lim ? cursorOf(page[page.length - 1]) : null };
}

// ---------------------------------------------------------------- changes (registry media.js)

// photo_inbox.add {id, mime, width?, height?, bytes, source, thumb}: the route has put the bytes in R2 already.
export async function planInboxAdd(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['id', 'mime', 'width', 'height', 'bytes', 'source', 'thumb'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  if (typeof a.id !== 'string' || !ID.test(a.id)) return { refuse: 'id is the photo id the upload made.' };
  if (!TYPES[a.mime]) return { refuse: 'A photo is a JPEG, WebP or PNG.' };
  if (!SOURCES.includes(a.source)) return { refuse: `source is one of ${SOURCES.join(', ')}.` };
  const bytes = Number(a.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) return { refuse: 'bytes is the size of the stored photo.' };
  const summary = summaryOf('Photo added to the photo inbox');
  const after = { r2_key: inboxKey(user, a.id, a.mime), thumb_key: a.thumb === true ? inboxKey(user, a.id, 'image/jpeg', true) : null, mime: a.mime,
    width: dim(a.width), height: dim(a.height), bytes, source: a.source, created_at: ctx.now, filed_at: null, topic_id: null, photo_id: null, deleted_at: null };
  return {
    rows: [{ table: 'photo_inbox', op: 'insert', key: { id: a.id }, before: null, after }],
    events: [{ target_type: 'photo_inbox', target_id: a.id, summary }],
    summary, reply: { photo: shapeInbox([{ id: a.id, ...after }])[0] },
  };
}

// The inbox rows named, by id: Map id -> row (missing ids are absent).
async function inboxRows(env, user, ids) {
  const res = await env.DB.prepare(`SELECT id, r2_key, mime, width, height, bytes, source, filed_at, topic_id, deleted_at FROM photo_inbox
    WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all();
  return new Map(((res && res.results) || []).map(r => [r.id, r]));
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// photo_inbox.file {items: [{id, topic_id}]}: each photo goes on its topic as a topic_photos row on the same R2 object,
// and its inbox row is marked filed. One batch, so "undo that" takes them all off and back to the inbox.
export async function planInboxFile(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (k !== 'items') return { refuse: `Unknown argument ${k}.` };
  const items = Array.isArray(a.items) ? a.items : null;
  if (!items || !items.length || items.length > ITEMS_MAX) return { refuse: `items is 1 to ${ITEMS_MAX} photos, each {id, topic_id}.` };
  const seen = new Set();
  for (const it of items) {
    if (!isObj(it) || Object.keys(it).some(k => !['id', 'topic_id'].includes(k))) return { refuse: 'Each item is {id, topic_id}.' };
    if (typeof it.id !== 'string' || !ID.test(it.id)) return { refuse: 'Each id is a photo id from the inbox list.' };
    if (typeof it.topic_id !== 'string' || !it.topic_id.trim() || it.topic_id.length > 120) return { refuse: 'Each topic_id is the topic the photo goes on.' };
    if (seen.has(it.id)) return { refuse: 'A photo can go on one topic only.' };
    seen.add(it.id);
  }
  const rows = await inboxRows(env, user, [...seen]);
  const names = new Map();
  for (const it of items) {
    const r = rows.get(it.id);
    if (!r || r.deleted_at != null) return { refuse: `There is no photo ${it.id} in the inbox.` };
    if (r.filed_at != null) return { refuse: `Photo ${it.id} is already filed. Undo that change first to file it again.` };
    const t = it.topic_id.trim();
    if (!names.has(t)) {
      const name = await topicName(env, user, t);
      if (!name) return { refuse: `There is no topic ${t} on the map.` };
      names.set(t, name);
    }
  }
  // A topic shows up to MAX_PHOTOS photos.
  const per = new Map();
  for (const it of items) per.set(it.topic_id.trim(), (per.get(it.topic_id.trim()) || 0) + 1);
  for (const [t, n] of per) {
    const c = await env.DB.prepare(`SELECT count(*) AS n FROM topic_photos WHERE user_id = ? AND topic_id = ? AND deleted_at IS NULL`).bind(user, t).first();
    if (((c && Number(c.n)) || 0) + n > MAX_PHOTOS) return { refuse: `${names.get(t)} already has ${(c && c.n) || 0} photos; a topic shows ${MAX_PHOTOS} at most.` };
  }
  const outRows = [], events = [], filed = [];
  for (const it of items) {
    const r = rows.get(it.id), t = it.topic_id.trim(), name = names.get(t);
    const photoId = `ph_${rand().slice(0, 24)}`;
    const summary = summaryOf(`Photo from the inbox added to ${name}`);
    outRows.push({ table: 'topic_photos', op: 'insert', key: { id: photoId }, before: null,
      after: { topic_id: t, r2_key: r.r2_key, mime: r.mime, width: dim(r.width), height: dim(r.height), bytes: Number(r.bytes) || 1, source: r.source,
        created_at: ctx.now, deleted_at: null } });
    events.push({ target_type: 'topic_photos', target_id: photoId, topic_id: t, summary });
    outRows.push({ table: 'photo_inbox', op: 'update', key: { id: it.id }, before: { filed_at: null, topic_id: null, photo_id: null },
      after: { filed_at: ctx.now, topic_id: t, photo_id: photoId } });
    events.push({ target_type: 'photo_inbox', target_id: it.id, topic_id: t, summary });
    filed.push({ id: it.id, topic_id: t, topic: name, photo_id: photoId });
  }
  const topics = [...new Set(filed.map(f => f.topic))];
  const summary = summaryOf(items.length === 1 ? `Photo from the inbox added to ${topics[0]}`
    : `${plural(items.length, 'photo')} from the inbox added to ${topics.length === 1 ? topics[0] : `${plural(topics.length, 'topic')}: ${topics.join(', ')}`}`);
  // Recent activity words a batch by its first event: that one says the whole batch.
  events[0] = { ...events[0], summary };
  return { rows: outRows, events, summary, reply: { filed } };
}

// photo_inbox.discard {ids}: soft, so Undo brings the same photos back to the inbox.
export async function planInboxDiscard(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (k !== 'ids') return { refuse: `Unknown argument ${k}.` };
  const ids = Array.isArray(a.ids) ? [...new Set(a.ids)] : null;
  if (!ids || !ids.length || ids.length > ITEMS_MAX || ids.some(id => typeof id !== 'string' || !ID.test(id))) return { refuse: `ids is 1 to ${ITEMS_MAX} photo ids from the inbox.` };
  const rows = await inboxRows(env, user, ids);
  const live = ids.filter(id => { const r = rows.get(id); return r && r.deleted_at == null && r.filed_at == null; });
  const missing = ids.find(id => !rows.has(id));
  if (missing) return { refuse: `There is no photo ${missing} in the inbox.` };
  if (!live.length) return { noop: true, summary: 'Those photos are no longer waiting in the inbox.' };
  const summary = summaryOf(live.length === 1 ? 'Photo taken out of the photo inbox' : `${plural(live.length, 'photo')} taken out of the photo inbox`);
  return {
    rows: live.map(id => ({ table: 'photo_inbox', op: 'soft_delete', key: { id }, before: { deleted_at: null }, after: { deleted_at: ctx.now } })),
    events: live.map(id => ({ target_type: 'photo_inbox', target_id: id, summary })),
    summary, reply: { discarded: live },
  };
}

// ---------------------------------------------------------------- routes

// GET /api/map/photo-inbox (?count=1: the count alone, for the map's Photos button)
export async function listRoute(request, env, ctx, params, url, user) {
  if (url && url.searchParams && url.searchParams.get('count') === '1') return json({ count: await waitingCount(env, user) });
  const rows = await waitingRows(env, user);
  return json({ count: await waitingCount(env, user), photos: shapeInbox(rows) });
}

// POST /api/map/photo-inbox (multipart: file, thumb, source, width, height). One photo a request, like the panel.
export async function addRoute(request, env, ctx, params, url, user) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BYTES + THUMB_MAX_BYTES + 64_000) return json({ error: 'That photo is too large, even after shrinking.' }, 413);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the photo as a form with a file.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Send the photo as a form with a file.' }, 400);
  const mime = String(file.type || '').toLowerCase();
  if (!TYPES[mime]) return json({ error: 'A photo is a JPEG, WebP or PNG.' }, 415);
  const data = await file.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_BYTES) return json({ error: 'That photo is too large, even after shrinking.' }, 413);
  if ((await waitingCount(env, user)) >= INBOX_MAX) return json({ error: `The inbox holds ${INBOX_MAX} photos. Ask Claude to file some first.` }, 409);
  const thumbFile = form.get('thumb');
  const thumb = thumbFile && typeof thumbFile.arrayBuffer === 'function' && String(thumbFile.type || '').toLowerCase() === 'image/jpeg' ? await thumbFile.arrayBuffer() : null;
  const id = `pi_${rand().slice(0, 24)}`;
  const r2 = bucket(env);
  await r2.put(inboxKey(user, id, mime), data, { httpMetadata: { contentType: mime } });
  const hasThumb = !!(thumb && thumb.byteLength && thumb.byteLength <= THUMB_MAX_BYTES);
  if (hasThumb) await r2.put(inboxKey(user, id, 'image/jpeg', true), thumb, { httpMetadata: { contentType: 'image/jpeg' } });
  const source = SOURCES.includes(form.get('source')) ? form.get('source') : 'file';
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'photo_inbox.add', via: 'api:POST /api/map/photo-inbox',
    args: { id, mime, width: dim(form.get('width')), height: dim(form.get('height')), bytes: data.byteLength, source, thumb: hasThumb } });
  if (r && r.ok) r.count = await waitingCount(env, user);
  return changeResponse(r);
}

// DELETE /api/map/photo-inbox/:id
export async function discardRoute(request, env, ctx, params, url, user) {
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'photo_inbox.discard', via: 'api:DELETE /api/map/photo-inbox/:id',
    args: { ids: [String(params.id || '')] } }));
}

// GET /api/map/photo-inbox/:id (?size=thumb): a discarded or filed photo still serves (Undo, a page already open).
export async function imageRoute(request, env, ctx, params, url, user) {
  const id = String(params.id || '');
  if (!ID.test(id)) return json({ error: 'There is no photo with that id.' }, 404);
  const row = await env.DB.prepare(`SELECT r2_key, thumb_key, mime FROM photo_inbox WHERE user_id = ? AND id = ?`).bind(user, id).first();
  const small = url && url.searchParams && url.searchParams.get('size') === 'thumb' && row && row.thumb_key;
  const obj = row ? await bucket(env).get(small ? row.thumb_key : row.r2_key) : null;
  if (!obj) return json({ error: 'There is no photo with that id.' }, 404);
  return new Response(obj.body, { headers: { 'Content-Type': small ? 'image/jpeg' : row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' } });
}
