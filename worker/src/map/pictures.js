import { json, HttpError } from '../util.js';
import { ankiCall, ankiCallFull, AnkiError } from '../anki.js';
import { summaryOf } from './events.js';
import { applyChange, changeResponse } from './change.js';
import { norm } from '../../../public/js/shared/names.js';

export const PICTURES_MAX = 12;
const REF = /^[a-z0-9_]{3,60}$/;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** picture_catalogue's reply as [{ref, title}]. */
export function catalogueEntries(cat) {
  const out = [];
  for (const list of Object.values((cat && cat.subjects) || {})) {
    for (const e of Array.isArray(list) ? list : []) if (e && typeof e.library === 'string' && REF.test(e.library) && e.title) out.push({ ref: e.library, title: String(e.title).slice(0, 200) });
  }
  return out;
}

/** The names a title offers, as resolver keys: the whole title and each side ("A vs B", "A and B", "A / B", "(B)"). */
export function titleKeys(title) {
  const t = String(title).replace(/\s+/g, ' ').trim();
  const parts = new Set([t, ...t.split(/\s+(?:vs\.?|versus|and|&)\s+|\s*[/,:;]\s*|\s+-\s+/i)]);
  for (const m of t.matchAll(/\(([^)]{2,60})\)/g)) parts.add(m[1]);
  for (const p of [...parts]) parts.add(p.replace(/\s*\([^)]*\)\s*/g, ' '));
  return [...new Set([...parts].map(norm).filter(k => k.length >= 3))];
}

/**
 * Rows {topic_id, ref, title} for the entries whose title names a topic (names: Map key -> Set of topic ids): a side
 * of the title is the topic's name or alias, or a name of two words or more stands whole inside the title
 * ("Alcohol withdrawal timeline" -> Alcohol withdrawal; one-word names only match a whole side, so "Anemia" does not
 * catch every anaemia table).
 */
export function matchEntries(entries, names) {
  const rows = [];
  const long = [...names.keys()].filter(k => k.includes(' '));
  for (const e of entries) {
    const ids = new Set();
    for (const k of titleKeys(e.title)) for (const id of names.get(k) || []) ids.add(id);
    const whole = ` ${norm(e.title)} `;
    for (const k of long) if (whole.includes(` ${k} `)) for (const id of names.get(k)) ids.add(id);
    for (const id of ids) rows.push({ topic_id: id, ref: e.ref, title: e.title });
  }
  return rows;
}

// The live topics' names and aliases as resolver keys (one query), optionally for one topic.
async function topicNames(env, user, topicId = null) {
  const rows = (await env.DB.prepare(`SELECT t.id, t.name, a.alias_key FROM topics t
      LEFT JOIN topic_aliases a ON a.user_id = t.user_id AND a.topic_id = t.id AND a.status = 'active' AND a.kind NOT IN ('typo', 'truncated')
    WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed') AND (?2 IS NULL OR t.id = ?2)`).bind(user, topicId).all()).results || [];
  const names = new Map();
  const add = (k, id) => { if (!k || k.length < 3) return; if (!names.has(k)) names.set(k, new Set()); names.get(k).add(id); };
  for (const r of rows) { add(norm(r.name), r.id); add(r.alias_key, r.id); }
  return names;
}

const insertRows = (env, user, rows, now) => rows.map(r => env.DB.prepare(`INSERT OR IGNORE INTO topic_pictures (user_id, topic_id, source, ref, title, matched_by, created_at)
  VALUES (?, ?, 'anking', ?, ?, ?, ?)`).bind(user, r.topic_id, r.ref, r.title, r.by || 'title', now));
const checkedRow = (env, user, topicId, n, now) => env.DB.prepare(`INSERT INTO source_fetches (user_id, topic_id, kind, fetched_at, n, status) VALUES (?, ?, 'pictures', ?, ?, 'ok')
  ON CONFLICT (user_id, topic_id, kind) DO UPDATE SET fetched_at = excluded.fetched_at, n = excluded.n, status = 'ok'`).bind(user, topicId, now, n);

async function linkRows(env, user, entries, topicId = null) {
  const titles = new Map(entries.map(e => [e.ref, e.title]));
  const rows = (await env.DB.prepare(`SELECT from_id, to_id, picture FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active', 'proposed')
    AND picture IS NOT NULL AND (?2 IS NULL OR from_id = ?2 OR to_id = ?2)`).bind(user, topicId).all()).results || [];
  return rows.filter(l => titles.has(l.picture)).flatMap(l => [l.from_id, l.to_id].filter(id => !topicId || id === topicId)
    .map(id => ({ topic_id: id, ref: l.picture, title: titles.get(l.picture), by: 'link' })));
}

/** The back-fill (and one topic when topicId is given): {entries, rows}. Writes in batches within D1's limits. */
export async function matchPictures(env, user, { catalogue = null, topicId = null, now = Date.now() } = {}) {
  const cat = catalogue || await ankiCall(env, 'picture_catalogue', {}, { timeoutMs: 20_000 });
  const entries = catalogueEntries(cat);
  const rows = [...matchEntries(entries, await topicNames(env, user, topicId)), ...await linkRows(env, user, entries, topicId)];
  const statements = insertRows(env, user, rows, now);
  if (topicId) statements.push(checkedRow(env, user, topicId, rows.length, now));
  // The back-fill marks every live topic as matched, so a first open after it never asks Anki again.
  else statements.push(env.DB.prepare(`INSERT INTO source_fetches (user_id, topic_id, kind, fetched_at, n, status)
    SELECT t.user_id, t.id, 'pictures', ?2, (SELECT count(*) FROM topic_pictures p WHERE p.user_id = t.user_id AND p.topic_id = t.id), 'ok'
    FROM topics t WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed') AND true
    ON CONFLICT (user_id, topic_id, kind) DO UPDATE SET fetched_at = excluded.fetched_at, n = excluded.n, status = 'ok'`).bind(user, now));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { pictures: entries.length, matched: rows.length, topics: new Set(rows.map(r => r.topic_id)).size };
}

/** topicDetail's hook: a topic never matched gets its pictures in the background (quietly: Anki may be down). */
export function attachOnOpen(env, user, topicId) {
  return matchPictures(env, user, { topicId }).catch(e => { if (!(e instanceof AnkiError) && !noTable(e)) console.error('pictures on open failed', e && e.message); return null; });
}

/** topicDetail's read: the topic's pictures that are not hidden. */
export function pictureStatement(env, user, topicId) {
  return env.DB.prepare(`SELECT source, ref, title FROM topic_pictures WHERE user_id = ? AND topic_id = ? AND hidden_at IS NULL ORDER BY created_at, ref LIMIT ${PICTURES_MAX}`)
    .bind(user, topicId);
}
export const shapePictures = rows => (rows || []).map(p => ({ id: `pic_${p.source}_${p.ref}`, src: `/api/map/pictures/${encodeURIComponent(p.ref)}`, source: p.source, ref: p.ref, title: p.title || null }));

// ---------------------------------------------------------------- hiding (op topic_picture.hide)

export async function planPictureHide(env, user, args, ctx) {
  const a = args || {};
  for (const k of Object.keys(a)) if (!['topic_id', 'ref'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  if (typeof a.topic_id !== 'string' || !a.topic_id || typeof a.ref !== 'string' || !REF.test(a.ref)) return { refuse: 'topic_id and ref name the picture to hide.' };
  const p = await env.DB.prepare(`SELECT p.hidden_at, p.title, t.name FROM topic_pictures p LEFT JOIN topics t ON t.user_id = p.user_id AND t.id = p.topic_id
    WHERE p.user_id = ? AND p.topic_id = ? AND p.source = 'anking' AND p.ref = ?`).bind(user, a.topic_id, a.ref).first();
  if (!p) return { refuse: 'That picture is not on this topic.' };
  if (p.hidden_at != null) return { noop: true, summary: 'That picture is already hidden here.' };
  const summary = summaryOf(`AnKing picture hidden on ${p.name || a.topic_id}`);
  return {
    rows: [{ table: 'topic_pictures', op: 'soft_delete', key: { topic_id: a.topic_id, source: 'anking', ref: a.ref }, before: { hidden_at: null }, after: { hidden_at: ctx.now } }],
    events: [{ target_type: 'topic_pictures', target_id: a.ref, topic_id: a.topic_id, summary }], summary, reply: { topic_id: a.topic_id, ref: a.ref },
  };
}

// ---------------------------------------------------------------- routes

// POST /api/map/seed/pictures {catalogue?}
export async function seedRoute(request, env, ctx, params, url, user) {
  const body = await request.json().catch(() => ({}));
  if (body.catalogue != null && (typeof body.catalogue !== 'object' || !body.catalogue.subjects)) return json({ error: "catalogue is picture_catalogue's reply: {subjects: {...}}." }, 400);
  if (!body.catalogue && !env.ANKI_MCP_URL) return json({ error: 'Anki is not connected, so the picture library cannot be read.' }, 503);
  try { return json(await matchPictures(env, user, { catalogue: body.catalogue || null })); } catch (e) {
    if (e instanceof AnkiError) throw new HttpError(502, 'The Anki server could not be reached for the picture library.');
    throw e;
  }
}

// DELETE /api/map/topic/:id/pictures/:ref
export async function hideRoute(request, env, ctx, params, url, user) {
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'topic_picture.hide', via: 'api:DELETE /api/map/topic/:id/pictures/:ref',
    args: { topic_id: String(params.id || ''), ref: String(params.ref || '') } }));
}

// GET /api/map/pictures/:ref: from the Anki server (show_picture), never stored here.
export async function pictureRoute(request, env, ctx, params, url, user) {
  const ref = String(params.ref || '');
  if (!REF.test(ref)) return json({ error: 'There is no picture with that name.' }, 404);
  let r;
  try { r = await ankiCallFull(env, 'show_picture', { names: [ref] }, { timeoutMs: 15_000 }); } catch (e) {
    if (e instanceof AnkiError) return json({ error: 'The Anki server could not be reached for that picture.' }, 502);
    throw e;
  }
  const img = (r.images || [])[0];
  if (!img || !img.data) return json({ error: 'There is no picture with that name.' }, 404);
  const bin = atob(img.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': img.mimeType || 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' } });
}
