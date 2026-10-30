import { HttpError, json, readJson } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import { tree, readPage, search, blockText } from './store.js';
import * as one from './onenote-map.js';
import * as job from './import-job.js';

export const enabled = env => !!env && env.NOTES === 'on';
export function gate(env) { if (!enabled(env)) throw new HttpError(404, 'Not found'); }

export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const IMAGE_MAX = 8 * 1024 * 1024;
const bucket = env => { if (!env.LIBRARY) throw new HttpError(503, 'The picture store is not set up.'); return env.LIBRARY; };

export async function treeRoute(request, env, ctx, params, url, user) {
  gate(env);
  return json(await tree(env, user, url.searchParams.get('region')));
}

export async function pageRoute(request, env, ctx, params, url, user) {
  gate(env);
  const s = url.searchParams.get('since');
  const page = await readPage(env, user, params.id, s != null && /^\d+$/.test(s) ? Number(s) : null);
  if (!page) throw new HttpError(404, 'That page is not in your notes.');
  return json(page);
}

export async function searchRoute(request, env, ctx, params, url, user) {
  gate(env);
  return json({ hits: await search(env, user, url.searchParams.get('q'), url.searchParams.get('region')) });
}

export async function saveRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 2_000_000);
  const args = { changes: body.changes };
  if (typeof body.label === 'string') args.label = body.label;
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'note.save', args, via: 'api:POST /api/notes/save' }));
}

export async function imagePutRoute(request, env, ctx, params, url, user) {
  gate(env);
  const type = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new HttpError(415, 'Pictures only: PNG, JPEG, WebP or GIF.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'The picture is empty.');
  if (bytes.byteLength > IMAGE_MAX) throw new HttpError(413, 'That picture is over 8 MB.');
  const name = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  const r2_key = `u/${user}/notes/${name}`;
  await bucket(env).put(r2_key, bytes, { httpMetadata: { contentType: type } });
  return json({ r2_key, name, bytes: bytes.byteLength });
}

export async function imageGetRoute(request, env, ctx, params, url, user) {
  gate(env);
  if (!/^[a-z0-9]+\.(png|jpe?g|webp|gif)$/.test(params.name)) throw new HttpError(404, 'Not found');
  const obj = await bucket(env).get(`u/${user}/notes/${params.name}`);
  if (!obj) throw new HttpError(404, 'That picture is not in the store.');
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  return new Response(obj.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' } });
}

export async function reindexRoute(request, env, ctx, params, url, user) {
  gate(env);
  const [blocks, pages] = await env.DB.batch([
    env.DB.prepare("SELECT id, page_id, type, html, cells_json FROM note_blocks WHERE user_id = ?1 AND deleted_at IS NULL AND type IN ('text', 'table')").bind(user),
    env.DB.prepare("SELECT id, title FROM note_pages WHERE user_id = ?1 AND deleted_at IS NULL AND title != ''").bind(user),
  ]);
  const rows = [...(pages.results || []).map(p => ({ page_id: p.id, block_id: '', text: p.title })),
    ...(blocks.results || []).map(b => ({ page_id: b.page_id, block_id: b.id, text: blockText(b) })).filter(r => r.text)];
  const ins = [];
  const insert = part => ins.push(env.DB.prepare(`INSERT INTO note_fts (user_id, page_id, block_id, text) SELECT ?1, json_extract(value, '$.page_id'),
    json_extract(value, '$.block_id'), json_extract(value, '$.text') FROM json_each(?2)`).bind(user, JSON.stringify(part)));
  let part = [], bytes = 0;   // each JSON parameter well under D1's 2 MB a value
  for (const r of rows) {
    const n = r.text.length + 80;
    if (part.length && bytes + n > 800_000) { insert(part); part = []; bytes = 0; }
    part.push(r); bytes += n;
  }
  if (part.length) insert(part);
  await env.DB.batch([env.DB.prepare('DELETE FROM note_fts WHERE user_id = ?1').bind(user), ...ins]);
  return json({ ok: true, indexed: rows.length });
}

const oneId = v => { const s = String(v || ''); if (!s || s.length > 300) throw new HttpError(400, 'Which OneNote page? (onenote_id)'); return s; };

export async function oneBrowseRoute(request, env, ctx, params, url, user) {
  gate(env);
  return json(await one.browse(env));
}

export async function oneImportRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 10_000);
  const r = await one.importPage(env, user, oneId(body.onenote_id), { region: body.region === 'uk' ? 'uk' : 'us', actor: 'mo', via: 'api:POST /api/notes/onenote/import' });
  if (r.refused) throw new HttpError(400, r.reason);
  return json(r);
}

export async function onePicturesRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 10_000);
  return json(await one.storePictures(env, user, oneId(body.onenote_id), Array.isArray(body.pictures) ? body.pictures : []));
}

async function jobAnswer(env, ctx, user, extra = {}) {
  const st = await job.status(env, user);
  const started = job.kick(env, ctx, user, st);
  return json({ ...st, ...(started ? { working: true } : {}), ...extra });
}

export async function jobRoute(request, env, ctx, params, url, user) {
  gate(env);
  return jobAnswer(env, ctx, user);
}

export async function jobQueueRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 200_000);
  const r = await job.enqueue(env, user, body.pages, { region: body.region === 'uk' ? 'uk' : 'us' });
  return jobAnswer(env, ctx, user, { queued: r });
}

export async function jobRetryRoute(request, env, ctx, params, url, user) {
  gate(env);
  return jobAnswer(env, ctx, user, { retried: await job.retry(env, user) });
}

export async function jobClearRoute(request, env, ctx, params, url, user) {
  gate(env);
  return jobAnswer(env, ctx, user, await job.clear(env, user));
}
