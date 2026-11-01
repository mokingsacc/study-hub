// Study Hub API client (docs/platform/api.md): same-origin fetch with the session cookie; the CSRF token lives in this
// module's memory and goes out on writes. GET replies are kept in memory; a write clears them. Demo mode answers from demo.js.

let csrf = null;
let uploadToken = null;   // a one-time upload link from their Claude (#up/<token>): sent instead of a session
let demoMod = null;
const cache = new Map();
let onSignedOut = () => {};

function demoWanted() {
  try {
    if (new URLSearchParams(location.search).get('demo') === '1' || location.hash === '#demo') { sessionStorage.setItem('sh-demo', '1'); return true; }
    return sessionStorage.getItem('sh-demo') === '1';
  } catch { return /[?&]demo=1/.test(location.search); }
}
export const DEMO = demoWanted();

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const PLAIN = {
  400: 'That did not look right. Please check and try again.',
  401: 'Please sign in again.',
  403: 'That is not allowed. Try reloading the page.',
  404: 'That could not be found. It may have been removed.',
  409: 'That changed somewhere else. Reload and try again.',
  413: 'That file is too big.',
  429: 'Too many tries just now. Please wait a minute and try again.',
};
const plain = s => PLAIN[s] || (s >= 500 ? 'Something went wrong on our side. Please try again in a moment.' : 'Something went wrong. Please try again.');

export function setCsrf(token) { if (token) csrf = token; }
export function setUploadToken(token) { uploadToken = token || null; }
export const uploadHeaders = () => (uploadToken ? { 'X-Upload-Token': uploadToken } : null);
export function clearSession() { csrf = null; cache.clear(); }
export function onAuthLost(fn) { onSignedOut = fn; }

async function send(method, path, body, opts = {}) {
  if (DEMO) {
    demoMod = demoMod || await import('./demo.js');
    const r = await demoMod.handle(method, path, body);
    return { status: r.status, data: r.data };
  }
  const headers = { Accept: 'application/json' };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (opts.raw) { headers['Content-Type'] = 'application/octet-stream'; payload = body; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (uploadToken) headers['X-Upload-Token'] = uploadToken;
  else if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf || '';
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  let r;
  try {
    r = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', keepalive: !!opts.keepalive });
  } catch {
    throw new ApiError(0, 'Cannot reach Study Hub. Check your connection and try again.');
  }
  let data = null;
  if (r.status !== 304) try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, etag: r.headers.get('ETag') };
}

function fail(status, data, path) {
  const msg = (data && typeof data.error === 'string' && data.error) || plain(status);
  (globalThis.shTrail ||= []).push([Date.now(), status, path, msg]);   // for Report a problem (report.js)
  if (status === 401 && !path.startsWith('/api/auth/') && !uploadToken) { clearSession(); onSignedOut(); }
  return new ApiError(status, msg, data);
}

// The one call every screen uses. Throws ApiError with plain words; a 401 outside sign-in sends the person to #login.
// opts.keepalive: a tap that must land even when the Claude app takes over at once.
export async function api(method, path, body, opts) {
  const { status, data } = await send(method, path, body, opts);
  if (status < 200 || status >= 300) throw fail(status, data, path);
  if (data && typeof data.csrf === 'string') csrf = data.csrf;
  if (method === 'GET') cache.set(path, data);
  else cache.clear();
  return data;
}

// A GET with the ETag of the copy the page holds: {data, etag} or {notModified: true, etag}. Not kept in memory.
export async function getTagged(path, etag) {
  if (DEMO) return { data: await api('GET', path), etag: null };
  const { status, data, etag: tag } = await send('GET', path, undefined, { etag });
  if (status === 304) return { notModified: true, etag: tag || etag };
  if (status < 200 || status >= 300) throw fail(status, data, path);
  return { data, etag: tag };
}

export const get = path => api('GET', path);
export const post = (path, body = {}, opts) => api('POST', path, body, opts);
export const put = (path, body = {}, opts) => api('PUT', path, body, opts);   // opts.raw: an ArrayBuffer or Blob as it is
export const patch = (path, body = {}) => api('PATCH', path, body);
export const del = path => api('DELETE', path);

// The last reply for a GET, or undefined: lets a screen paint instantly and refresh after.
export const cached = path => cache.get(path);

// Paint from memory first (if any), then from the server; onData runs once or twice, onError only when nothing painted.
export async function load(path, onData, onError) {
  const had = cache.get(path);
  if (had !== undefined) onData(had, true);
  try {
    const fresh = await get(path);
    if (had === undefined || JSON.stringify(had) !== JSON.stringify(fresh)) onData(fresh, false);
  } catch (e) {
    if (e.status === 401) return;
    if (had === undefined) onError(e);
  }
}

// The URL a library file is read from (same-origin, cookie-authenticated).
export const fileUrl = id => `/api/p/library/docs/${encodeURIComponent(id)}/file`;
export const qs = obj => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
