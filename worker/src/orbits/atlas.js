// Megan Lane's diagram pages (I33 §5.2), private: R2 key u/<user>/atlas/<deck>/p<page>-<thumb|md|xl>.jpg in the
// LIBRARY bucket, read and written only behind the hub key, served with private caching. Never in git, never in the
// public assets. PUT takes a JPEG of at most 3 MB (magic bytes checked) and records the size in atlas_pages.
import { HttpError, json } from '../util.js';
import { needOrbits } from './common.js';

export const SIZES = ['thumb', 'md', 'xl'];
export const MAX_BYTES = 3 * 1024 * 1024;
const DECKS = ['pharm', 'pathogens'];

function where(params, user) {
  const deck = String(params.deck || ''), size = String(params.size || ''), page = Number(params.page);
  if (!DECKS.includes(deck) || !SIZES.includes(size) || !Number.isSafeInteger(page) || page < 1 || page > 200) throw new HttpError(404, 'Not found.');
  return { deck, size, page, key: `u/${user}/atlas/${deck}/p${page}-${size}.jpg` };
}

/** The width and height in a JPEG's first SOF marker, or null. */
export function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

export async function getRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const w = where(params, user);
  if (!env.LIBRARY) throw new HttpError(404, 'Diagram not uploaded yet.');
  const obj = await env.LIBRARY.get(w.key);
  if (!obj) throw new HttpError(404, 'Diagram not uploaded yet.');
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Robots-Tag': 'noindex',
    ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}) } });
}

export async function putRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const w = where(params, user);
  if (!env.LIBRARY) throw new HttpError(503, 'The image store is not set up.');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES) throw new HttpError(413, 'A diagram page is at most 3 MB.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'A diagram page is at most 3 MB.');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new HttpError(415, 'Only JPEG pages are taken.');
  await env.LIBRARY.put(w.key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  const dim = w.size === 'md' ? jpegSize(bytes) : null;
  const title = String(url.searchParams.get('title') || '').slice(0, 80) || `Page ${w.page}`;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO atlas_pages (user_id, deck, page, title, md_w, md_h, sizes, uploaded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (user_id, deck, page) DO UPDATE SET uploaded_at = ?8,
      sizes = CASE WHEN (',' || atlas_pages.sizes || ',') LIKE ('%,' || ?7 || ',%') THEN atlas_pages.sizes WHEN atlas_pages.sizes = '' THEN ?7 ELSE atlas_pages.sizes || ',' || ?7 END,
      md_w = CASE WHEN ?9 THEN ?5 ELSE atlas_pages.md_w END, md_h = CASE WHEN ?9 THEN ?6 ELSE atlas_pages.md_h END`)
    .bind(user, w.deck, w.page, title, dim ? dim.w : 1224, dim ? dim.h : 1607, w.size, now, dim ? 1 : 0).run();
  return json({ ok: true, deck: w.deck, page: w.page, size: w.size, bytes: bytes.length, ...(dim ? { w: dim.w, h: dim.h } : {}) });
}
