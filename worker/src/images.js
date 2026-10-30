// Pictures for questions (cut out of uploaded PDF pages in the browser). Stored as base64 text in D1, one
// row each, so a picture can go straight into a Claude image block and into the JSON export.
import { HttpError, json, readJson, uuid, now } from './util.js';
import { all, first, run } from './db.js';

export const MAX_IMAGE_B64 = 1_500_000; // D1 keeps a value up to 2 MB
export const MIMES = ['image/jpeg', 'image/png'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const STALE_MS = 24 * 3600_000;

export async function upload(request, env) {
  const body = await readJson(request, MAX_IMAGE_B64 + 10_000);
  const mime = MIMES.includes(body.mime) ? body.mime : null;
  const data = typeof body.data === 'string' ? body.data : '';
  if (!mime) throw new HttpError(400, 'A picture must be a JPEG or PNG.');
  if (!data || data.length > MAX_IMAGE_B64 || !BASE64.test(data)) throw new HttpError(400, 'That picture is empty or too large (limit about 1 MB).');
  const id = uuid();
  await run(env, 'INSERT INTO exam_images (id, exam_id, mime, data, bytes, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    id, mime, data, Math.floor(data.length * 3 / 4), now());
  return json({ id });
}

// Base64 to bytes in as little Worker CPU as possible: the built-in where the runtime has it, else a plain loop.
export function fromBase64(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function get(request, env, ctx, { id }) {
  const row = await first(env, 'SELECT mime, data FROM exam_images WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'That picture was not found.');
  const bin = fromBase64(row.data);
  return new Response(bin, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' } });
}

/** Ids of the pictures a question list refers to. */
export function figIds(questions) {
  const ids = new Set();
  for (const q of questions) for (const f of q.figs || []) ids.add(f.id);
  return [...ids];
}

/** Statements that attach uploaded pictures to a new exam; refuses ids that are missing or already used. */
export async function attachStatements(env, examId, ids) {
  if (!ids.length) return [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    rows.push(...await all(env, `SELECT id, exam_id FROM exam_images WHERE id IN (${part.map(() => '?').join(',')})`, ...part));
  }
  const free = new Set(rows.filter(r => r.exam_id == null).map(r => r.id));
  const bad = ids.filter(id => !free.has(id));
  if (bad.length) throw new HttpError(400, `${bad.length} picture${bad.length === 1 ? ' was' : 's were'} not uploaded properly. Upload the PDFs again.`);
  return ids.map(id => env.DB.prepare('UPDATE exam_images SET exam_id = ? WHERE id = ? AND exam_id IS NULL').bind(examId, id));
}

/** Pictures for Claude: {id: {mime, data}}. */
export async function imageData(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    for (const r of await all(env, `SELECT id, mime, data FROM exam_images WHERE id IN (${part.map(() => '?').join(',')})`, ...part)) out[r.id] = r;
  }
  return out;
}

/** Cron: pictures uploaded for an exam that was never saved. */
export async function sweepImages(env) {
  await run(env, 'DELETE FROM exam_images WHERE exam_id IS NULL AND created_at < ?', now() - STALE_MS);
}
