import { json, HttpError, readJson } from '../util.js';
import { summaryOf, rand } from './events.js';
import { applyChange, changeResponse } from './change.js';

export const MAX_PHOTOS = 40;                        // shown on one topic
export const MAX_BYTES = 8_000_000;                  // one photo after the browser shrank it
export const SOURCES = ['paste', 'drop', 'file', 'camera'];
export const TYPES = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
const ID = /^ph_[a-z0-9]{12,40}$/;

const bucket = env => {
  if (!env.LIBRARY || typeof env.LIBRARY.put !== 'function') throw new HttpError(503, "The hub's file store (R2) is not set up, so photos can't be kept yet.");
  return env.LIBRARY;
};
const dim = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 20_000 ? n : null; };
export const photoKey = (user, topicId, id, mime) => `u/${user}/photos/${encodeURIComponent(topicId)}/${id}.${TYPES[mime]}`;
export const photoPath = id => `/api/map/photos/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- reads (topicDetail's batch)

export const PHOTO_ORDER = 'sort IS NULL, sort, created_at, id';

export function photoStatement(env, user, topicId) {
  return env.DB.prepare(`SELECT id, mime, width, height, source, created_at FROM topic_photos WHERE user_id = ? AND topic_id = ? AND deleted_at IS NULL
    ORDER BY ${PHOTO_ORDER} LIMIT ${MAX_PHOTOS}`).bind(user, topicId);
}

/** Rows as the panel's d.photos: [{id, src, w, h, source, at}]. */
export function shapePhotos(rows) {
  return (rows || []).map(p => ({ id: p.id, src: photoPath(p.id), w: dim(p.width), h: dim(p.height), source: p.source, at: Number(p.created_at) || null }));
}

// ---------------------------------------------------------------- changes (registry media.js)

/** A live topic's name, or null (retired, merged or not there). The photo inbox files on it too. */
export async function topicName(env, user, topicId) {
  const t = await env.DB.prepare(`SELECT name, status FROM topics WHERE user_id = ? AND id = ?`).bind(user, topicId).first();
  return t && !['retired', 'merged'].includes(t.status) ? t.name : null;
}

// topic_photo.add {topic_id, id, mime, width?, height?, bytes, source}: the route has put the bytes in R2 already.
export async function planPhotoAdd(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['topic_id', 'id', 'mime', 'width', 'height', 'bytes', 'source'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  const topicId = typeof a.topic_id === 'string' ? a.topic_id.trim() : '';
  if (!topicId || topicId.length > 120) return { refuse: 'topic_id is the topic the photo belongs to.' };
  if (typeof a.id !== 'string' || !ID.test(a.id)) return { refuse: 'id is the photo id the upload made.' };
  if (!TYPES[a.mime]) return { refuse: 'A photo is a JPEG, WebP or PNG.' };
  if (!SOURCES.includes(a.source)) return { refuse: `source is one of ${SOURCES.join(', ')}.` };
  const bytes = Number(a.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) return { refuse: 'bytes is the size of the stored photo.' };
  const name = await topicName(env, user, topicId);
  if (!name) return { refuse: 'There is no topic with that id on the map.' };
  const summary = summaryOf(`Photo added to ${name}`);
  const after = { topic_id: topicId, r2_key: photoKey(user, topicId, a.id, a.mime), mime: a.mime, width: dim(a.width), height: dim(a.height), bytes,
    source: a.source, created_at: ctx.now, deleted_at: null };
  return {
    rows: [{ table: 'topic_photos', op: 'insert', key: { id: a.id }, before: null, after }],
    events: [{ target_type: 'topic_photos', target_id: a.id, topic_id: topicId, summary }],
    summary, reply: { photo: shapePhotos([{ id: a.id, ...after }])[0] },
  };
}

// topic_photo.remove {photo_id}: soft, so Undo brings the same photo back.
export async function planPhotoRemove(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (k !== 'photo_id') return { refuse: `Unknown argument ${k}.` };
  if (typeof a.photo_id !== 'string' || !ID.test(a.photo_id)) return { refuse: 'photo_id is the photo to take off.' };
  const p = await env.DB.prepare(`SELECT p.topic_id, p.deleted_at, t.name FROM topic_photos p LEFT JOIN topics t ON t.user_id = p.user_id AND t.id = p.topic_id
    WHERE p.user_id = ? AND p.id = ?`).bind(user, a.photo_id).first();
  if (!p) return { refuse: 'There is no photo with that id.' };
  if (p.deleted_at != null) return { noop: true, summary: 'That photo is already off the topic.' };
  const summary = summaryOf(`Photo removed from ${p.name || p.topic_id}`);
  return {
    rows: [{ table: 'topic_photos', op: 'soft_delete', key: { id: a.photo_id }, before: { deleted_at: null }, after: { deleted_at: ctx.now } }],
    events: [{ target_type: 'topic_photos', target_id: a.photo_id, topic_id: p.topic_id, summary }],
    summary, reply: { photo_id: a.photo_id, topic_id: p.topic_id },
  };
}

export async function planPhotoReorder(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['topic_id', 'ids'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  const topicId = typeof a.topic_id === 'string' ? a.topic_id.trim() : '';
  if (!topicId || topicId.length > 120) return { refuse: 'topic_id is the topic whose photos move.' };
  const ids = Array.isArray(a.ids) ? a.ids : null;
  if (!ids || !ids.length || ids.length > MAX_PHOTOS || ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(ids).size !== ids.length) {
    return { refuse: 'ids is every photo on the topic, once each, first first.' };
  }
  const name = await topicName(env, user, topicId);
  if (!name) return { refuse: 'There is no topic with that id on the map.' };
  const res = await env.DB.prepare(`SELECT id, sort FROM topic_photos WHERE user_id = ? AND topic_id = ? AND deleted_at IS NULL ORDER BY ${PHOTO_ORDER}`)
    .bind(user, topicId).all();
  const live = (res && res.results) || [];
  const have = new Set(live.map(r => r.id));
  if (live.length !== ids.length || ids.some(id => !have.has(id))) return { refuse: 'The photos on this topic changed. Reload and move them again.' };
  const sortOf = new Map(live.map(r => [r.id, r.sort == null ? null : Number(r.sort)]));
  const moved = ids.map((id, i) => ({ id, i })).filter(x => sortOf.get(x.id) !== x.i);
  if (!moved.length) return { noop: true, summary: 'The photos are already in that order.' };
  const summary = summaryOf(`Photos put in a new order on ${name}`);
  return {
    rows: moved.map(x => ({ table: 'topic_photos', op: 'update', key: { id: x.id }, before: { sort: sortOf.get(x.id) }, after: { sort: x.i } })),
    events: moved.map(x => ({ target_type: 'topic_photos', target_id: x.id, topic_id: topicId, summary })),
    summary, reply: { order: ids },
  };
}

// ---------------------------------------------------------------- routes

// POST /api/map/topic/:id/photos (multipart: file, source, width, height). One photo a request: the page sends a
// paste or a drop of several one after another, so each is small and a failure loses only that one.
export async function addRoute(request, env, ctx, params, url, user) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BYTES + 64_000) return json({ error: 'That photo is too large, even after shrinking.' }, 413);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Send the photo as a form with a file.' }, 400); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Send the photo as a form with a file.' }, 400);
  const mime = String(file.type || '').toLowerCase();
  if (!TYPES[mime]) return json({ error: 'A photo is a JPEG, WebP or PNG.' }, 415);
  const data = await file.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_BYTES) return json({ error: 'That photo is too large, even after shrinking.' }, 413);
  const topicId = String(params.id || '');
  if (!(await topicName(env, user, topicId))) return json({ error: 'There is no topic with that id on the map.' }, 404);
  const id = `ph_${rand().slice(0, 24)}`;
  await bucket(env).put(photoKey(user, topicId, id, mime), data, { httpMetadata: { contentType: mime } });
  const source = SOURCES.includes(form.get('source')) ? form.get('source') : 'file';
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'topic_photo.add', via: 'api:POST /api/map/topic/:id/photos',
    args: { topic_id: topicId, id, mime, width: dim(form.get('width')), height: dim(form.get('height')), bytes: data.byteLength, source } }));
}

// POST /api/map/topic/:id/photos/order {ids}
export async function orderRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 20_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'topic_photo.reorder', via: 'api:POST /api/map/topic/:id/photos/order',
    args: { topic_id: String(params.id || ''), ids: Array.isArray(body && body.ids) ? body.ids : [] } }));
}

// DELETE /api/map/topic/:id/photos/:photo_id
export async function removeRoute(request, env, ctx, params, url, user) {
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'topic_photo.remove', via: 'api:DELETE /api/map/topic/:id/photos/:photo_id',
    args: { photo_id: String(params.photo_id || '') } }));
}

// GET /api/map/photos/:id: a removed photo still serves (Undo, and a lightbox already open), from the same key.
export async function photoRoute(request, env, ctx, params, url, user) {
  const id = String(params.id || '');
  if (!ID.test(id)) return json({ error: 'There is no photo with that id.' }, 404);
  const row = await env.DB.prepare(`SELECT r2_key, mime FROM topic_photos WHERE user_id = ? AND id = ?`).bind(user, id).first();
  const obj = row ? await bucket(env).get(row.r2_key) : null;
  if (!obj) return json({ error: 'There is no photo with that id.' }, 404);
  return new Response(obj.body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' } });
}
