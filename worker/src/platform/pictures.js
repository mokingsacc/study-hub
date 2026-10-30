// Pictures on a topic (docs/platform/v2-plan.md 8.1, WP3b): a biology or psychology topic gets its diagrams. Up to 12
// a topic, each a photo they add (kept in R2 under u/<user>/pictures/) or a page of a PDF in their own library (drawn
// in the browser by pdf.js, optionally cropped). Only their own uploads and their own library, never anyone else's.
// Adding and removing go through writeBatch, so either can be undone; a removed photo's R2 object stays until the
// account goes (me.js deletes the whole u/<user>/ prefix).
//   GET    /api/p/topics/:id/pictures        {pictures: [...], max}
//   PUT    /api/p/pictures?topic=&caption=   a photo, the raw image as the body (JPEG, PNG or WebP, up to 5 MB)
//   POST   /api/p/pictures                   {topic, doc_id, page, crop?, caption?}: a library page
//   PATCH  /api/p/pictures/:id               {caption}
//   DELETE /api/p/pictures/:id               undoable (POST /api/p/undo)
//   GET    /api/p/pictures/:id/file          the photo itself
//   tool   topic_picture                     pins a library page to a topic, or lists a topic's pictures
import { HttpError, json, readJson, now as nowMs } from '../util.js';
import { writeBatch, rand } from '../map/events.js';
import { LEARNER, requireModule } from './modules.js';
import { Plan, resolveTopic } from './subjects.js';
import * as store from '../library/store.js';

export const LIMITS = { per_topic: 12, per_user: 400, bytes: 5 * 1024 * 1024, caption: 120 };
const LIVE = "('proposed','confirmed')";
const st = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const COLS = 'id, topic_id, kind, mime, bytes, doc_id, page, crop_json, caption, status, sort, created_by, created_at';

/** The kind of image the bytes are, by their first bytes (the name and the header are not trusted), or null. */
export function imageType(buf) {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

// A crop is a box in fractions of the page: {x, y, w, h}, each 0 to 1.
function cleanCrop(c) {
  if (c == null) return null;
  const v = ['x', 'y', 'w', 'h'].map(k => Number(c[k]));
  if (v.some(n => !Number.isFinite(n) || n < 0 || n > 1) || v[2] < 0.05 || v[3] < 0.05 || v[0] + v[2] > 1.001 || v[1] + v[3] > 1.001) throw new HttpError(400, 'A crop is {x, y, w, h}, each between 0 and 1.');
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

const shape = r => ({ id: r.id, topic_id: r.topic_id, kind: r.kind, caption: r.caption || null, doc_id: r.doc_id || null, page: r.page ?? null,
  crop: r.crop_json ? JSON.parse(r.crop_json) : null, url: r.kind === 'photo' ? `/api/p/pictures/${encodeURIComponent(r.id)}/file` : null,
  doc_title: r.doc_title || null, created_by: r.created_by, created_at: r.created_at });

async function ownTopic(env, user, topicId) {
  const t = typeof topicId === 'string' && topicId.length <= 80 ? await st(env, `SELECT id, name FROM topics WHERE user_id = ?1 AND id = ?2 AND status IN ${LIVE}`, user, topicId).first() : null;
  if (!t) throw new HttpError(404, 'There is no such topic.');
  return t;
}

export async function listPictures(env, user, topicId) {
  await ownTopic(env, user, topicId);
  const { results } = await st(env, `SELECT p.${COLS.split(', ').join(', p.')}, d.title AS doc_title FROM study_pictures p
    LEFT JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
    WHERE p.user_id = ?1 AND p.topic_id = ?2 AND p.status = 'active' ORDER BY p.sort, p.created_at`, user, topicId).all();
  return { pictures: (results || []).map(shape), max: LIMITS.per_topic };
}

// Room for one more on this topic, and in their account.
async function roomFor(env, user, topicId) {
  const [a, b] = await env.DB.batch([
    st(env, "SELECT COUNT(*) AS n, COALESCE(MAX(sort), -1) AS top FROM study_pictures WHERE user_id = ?1 AND topic_id = ?2 AND status = 'active'", user, topicId),
    st(env, "SELECT COUNT(*) AS n FROM study_pictures WHERE user_id = ?1 AND status = 'active'", user),
  ]);
  const t = (a.results || [])[0] || {}, all = (b.results || [])[0] || {};
  if (Number(t.n) >= LIMITS.per_topic) throw new HttpError(400, `A topic can have ${LIMITS.per_topic} pictures. Remove one first.`);
  if (Number(all.n) >= LIMITS.per_user) throw new HttpError(400, `You have ${LIMITS.per_user} pictures, the most a hub can hold. Remove some first.`);
  return Number(t.top) + 1;
}

async function addRow(env, user, topic, row, { actor, surface, via }) {
  const sort = await roomFor(env, user, topic.id);
  const t = nowMs();
  const id = row.id || `pic_${rand().slice(0, 12)}`;
  const after = { topic_id: topic.id, kind: row.kind, r2_key: row.r2_key || null, mime: row.mime || null, bytes: row.bytes || null, doc_id: row.doc_id || null,
    page: row.page ?? null, crop_json: row.crop ? JSON.stringify(row.crop) : null, caption: row.caption || null, status: 'active', sort, created_by: actor, created_at: t, updated_at: t };
  const plan = new Plan().add({ table: 'study_pictures', op: 'insert', key: { id }, before: null, after },
    { kind: 'picture.added', target_type: 'study_pictures', target_id: id, topic_id: topic.id, summary: `Added a ${row.kind === 'photo' ? 'photo' : 'page'} to ${topic.name}` });
  const w = await writeBatch(env, user, { actor, surface, via, rows: plan.rows, events: plan.events, undoable: true });
  return { picture: shape({ id, ...after }), batch_id: w.batch_id };
}

/** A photo they took or chose: the raw image bytes. */
export async function addPhoto(env, user, topicId, buf, caption = null, ctx = { actor: LEARNER, surface: 'web', via: 'platform:pictures' }) {
  const topic = await ownTopic(env, user, topicId);
  if (!buf || !buf.byteLength) throw new HttpError(400, 'Choose a photo first.');
  if (buf.byteLength > LIMITS.bytes) throw new HttpError(413, 'That photo is over 5 MB. Try a smaller one.');
  const mime = imageType(buf);
  if (!mime) throw new HttpError(400, 'That is not a JPEG, PNG or WebP picture.');
  await roomFor(env, user, topic.id);
  const id = `pic_${rand().slice(0, 12)}`;
  const key = `u/${user}/pictures/${id}`;
  await store.bucket(env).put(key, buf, { httpMetadata: { contentType: mime } });
  try {
    return await addRow(env, user, topic, { id, kind: 'photo', r2_key: key, mime, bytes: buf.byteLength, caption: oneLine(caption, LIMITS.caption) || null }, ctx);
  } catch (e) { await env.LIBRARY.delete(key).catch(() => {}); throw e; }
}

/** A page of a PDF in their own library, pinned to a topic (optionally a box on the page). */
export async function addPage(env, user, topicId, { doc_id, page, crop = null, caption = null }, ctx = { actor: LEARNER, surface: 'web', via: 'platform:pictures' }) {
  const topic = await ownTopic(env, user, topicId);
  const doc = typeof doc_id === 'string' && doc_id.length <= 40 ? await store.getDoc(env, user, doc_id) : null;
  if (!doc || ['refused', 'failed'].includes(doc.status)) throw new HttpError(404, 'That document is not in your library.');
  const n = Math.round(Number(page));
  if (!(n >= 1) || (doc.page_count && n > doc.page_count)) throw new HttpError(400, `${doc.title} has ${doc.page_count || 'fewer'} pages.`);
  return addRow(env, user, topic, { kind: 'page', doc_id: doc.id, page: n, crop: cleanCrop(crop), caption: oneLine(caption, LIMITS.caption) || null }, ctx);
}

async function ownPicture(env, user, id) {
  const r = typeof id === 'string' && id.length <= 40 ? await st(env, `SELECT ${COLS}, r2_key, updated_at FROM study_pictures WHERE user_id = ?1 AND id = ?2 AND status = 'active'`, user, id).first() : null;
  if (!r) throw new HttpError(404, 'There is no such picture.');
  return r;
}

export async function removePicture(env, user, id, { actor = LEARNER, surface = 'web', via = 'platform:pictures' } = {}) {
  const r = await ownPicture(env, user, id);
  const t = nowMs();
  const plan = new Plan().add({ table: 'study_pictures', op: 'update', key: { id }, before: { status: 'active', updated_at: r.updated_at }, after: { status: 'deleted', updated_at: t } },
    { kind: 'picture.removed', target_type: 'study_pictures', target_id: id, topic_id: r.topic_id, summary: `Removed a ${r.kind === 'photo' ? 'photo' : 'page'} from a topic` });
  const w = await writeBatch(env, user, { actor, surface, via, rows: plan.rows, events: plan.events, undoable: true });
  return { ok: true, batch_id: w.batch_id };
}

// ------------------------------------------------------------------ routes

const gate = fn => async (request, env, ctx, params, url, user, session) => { requireModule(session, 'map', env); return fn(request, env, ctx, params, url, user, session); };

async function photoRoute(request, env, ctx, params, url, user) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > LIMITS.bytes) throw new HttpError(413, 'That photo is over 5 MB. Try a smaller one.');
  const out = await addPhoto(env, user, url.searchParams.get('topic') || '', await request.arrayBuffer(), url.searchParams.get('caption'));
  return json(out, 201);
}

async function fileRoute(request, env, ctx, params, url, user) {
  const r = await ownPicture(env, user, params.id);
  if (r.kind !== 'photo' || !r.r2_key) throw new HttpError(404, 'That picture is a page of a document.');
  const obj = await store.bucket(env).get(r.r2_key);
  if (!obj) throw new HttpError(404, 'That photo is missing.');
  return new Response(obj.body, { headers: { 'Content-Type': r.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' } });
}

async function captionRoute(request, env, ctx, params, url, user) {
  const r = await ownPicture(env, user, params.id);
  const caption = oneLine((await readJson(request, 2_000)).caption, LIMITS.caption) || null;
  await st(env, 'UPDATE study_pictures SET caption = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2', user, r.id, caption, nowMs()).run();
  return json({ picture: shape({ ...r, caption }) });
}

export const ROUTES = [
  ['GET', '/api/p/topics/:id/pictures', gate((rq, env, ctx, params, url, user) => listPictures(env, user, params.id).then(json))],
  ['PUT', '/api/p/pictures', gate(photoRoute)],
  ['POST', '/api/p/pictures', gate(async (rq, env, ctx, params, url, user) => { const b = await readJson(rq, 4_000); return json(await addPage(env, user, b.topic, b), 201); })],
  ['PATCH', '/api/p/pictures/:id', gate(captionRoute)],
  ['DELETE', '/api/p/pictures/:id', gate((rq, env, ctx, params, url, user) => removePicture(env, user, params.id).then(json))],
  ['GET', '/api/p/pictures/:id/file', gate(fileRoute)],
];

// ------------------------------------------------------------------ the tool

export const TOOLS = [{
  name: 'topic_picture',
  module: 'library',
  description: 'Pictures on one of the student\'s topics (up to 12): pins a page of a PDF in THEIR OWN library to a topic, for example "put the heart diagram from my notes on Cardiac cycle" (library_search finds the doc_id and page). '
    + 'With no doc_id it lists the topic\'s pictures. crop {x, y, w, h} (fractions of the page) keeps just the diagram. Photos they add in the app. They can say "undo that" (undo_change).',
  inputSchema: { type: 'object', additionalProperties: false, required: ['topic'], properties: {
    topic: { type: 'string' }, subject: { type: 'string' }, doc_id: { type: 'string' }, page: { type: 'integer' },
    crop: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } }, caption: { type: 'string' } } },
  async run(env, user, a) {
    const r = await resolveTopic(env, user, a.topic, a.subject || null);
    if (r.ambiguous) return r;
    if (!a.doc_id) return listPictures(env, user, r.id);
    const out = await addPage(env, user, r.id, a, { actor: 'claude', surface: 'chat', via: 'platform:topic_picture' });
    return { ...out, undo: 'They can say "undo that" (undo_change).' };
  },
}];
