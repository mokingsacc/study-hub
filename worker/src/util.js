// Small shared helpers: JSON responses, plain-English errors, body parsing, London dates.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// For bodies already serialised (raw JSON columns spliced in), so nothing is parsed twice.
export function rawJson(text, status = 200) {
  return new Response(text, { status, headers: JSON_HEADERS });
}

export function errorResponse(status, message) {
  return json({ error: message }, status);
}

export async function readJson(request, maxBytes = 1_000_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, `That is too large for the hub (limit ${Math.round(maxBytes / 1e6)} MB).`);
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, `That is too large for the hub (limit ${Math.round(maxBytes / 1e6)} MB).`);
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'That request was not valid JSON.');
  }
}

export function questionLink(origin, sittingId, qIndex) {
  const i = Number(qIndex);
  if (!origin || !sittingId || !Number.isInteger(i) || i < 0) return null;
  return `${String(origin).replace(/\/+$/, '')}/#q=${encodeURIComponent(sittingId)}:${i + 1}`;
}

export function hubQuestionLabel(sittingName, num, qIndex, blockIdx) {
  const n = Number(num), i = Number(qIndex);
  const printed = Number.isInteger(n) && n > 0 ? n : i + 1;
  const restarted = Number.isInteger(i) && printed !== i + 1 && Number.isInteger(Number(blockIdx));
  return restarted ? `${sittingName} B${Number(blockIdx) + 1} Q${printed}` : `${sittingName} Q${printed}`;
}

export const uuid = () => crypto.randomUUID();
export const now = () => Date.now();

const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
export const londonDay = (ms = Date.now()) => LONDON.format(new Date(ms));

// Epoch ms of the start of today in London (for "today" counts).
export function londonDayStart(ms = Date.now()) {
  const day = londonDay(ms);
  // London is UTC or UTC+1; try both offsets and keep the one that maps back to the same day at 00:00.
  for (const off of [0, -3600_000]) {
    const t = Date.parse(day + 'T00:00:00Z') + off;
    if (londonDay(t) === day && londonDay(t - 1) !== day) return t;
  }
  return Date.parse(day + 'T00:00:00Z');
}

// Build a JSON object string from a row, splicing JSON-text columns in raw (no parse/stringify).
// raw: {columnName: outputKey}; drop: columns to leave out.
export function rowJson(row, raw = {}, drop = []) {
  const parts = [];
  for (const k of Object.keys(row)) {
    if (drop.includes(k)) continue;
    if (k in raw) {
      const v = row[k];
      parts.push(JSON.stringify(raw[k]) + ':' + (v == null || v === '' ? 'null' : v));
    } else {
      parts.push(JSON.stringify(k) + ':' + JSON.stringify(row[k] ?? null));
    }
  }
  return '{' + parts.join(',') + '}';
}

export function str(v, max = 2000) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

export function int(v, name, { min = -Infinity, max = Infinity, optional = true } = {}) {
  if (v == null || v === '') {
    if (optional) return null;
    throw new HttpError(400, `Please give ${name}.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}.`);
  return n;
}

export function safeParse(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
