// Shared helpers for the platform tests: an env with the platform on (D1 fake, fake Workers AI), a tiny
// browser that keeps the session cookie and CSRF token, and signedIn() for a ready account.
import assert from 'node:assert/strict';
import { createD1 } from './d1-fake.mjs';
import worker from '../../worker/src/index.js';

// workerd's crypto.subtle.timingSafeEqual, which node lacks.
if (!crypto.subtle.timingSafeEqual) {
  const { timingSafeEqual } = await import('node:crypto');
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export const HUB_KEY = 'test-hub-key-0123456789abcdef';
export const BASE = 'https://hub.test';

export function platformEnv(over = {}) {
  const d = createD1();
  const env = { ...d.env, HUB_KEY, PLATFORM: '1', PLATFORM_SECRET: 'test-platform-secret-0123456789abcdef-xyz',
    AI: { run: async () => ({ response: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5 } }) }, ...over };
  return { d, env };
}

// A tiny browser: keeps the session cookie and the CSRF token.
export function client(env) {
  const jar = { cookie: null, csrf: null };
  const call = async (method, path, body, { headers = {}, hubKey = false } = {}) => {
    const h = { 'CF-Connecting-IP': '5.6.7.8', ...headers };
    if (jar.cookie) h.Cookie = jar.cookie;
    if (jar.csrf && method !== 'GET') h['X-CSRF-Token'] = jar.csrf;
    if (hubKey) h['X-Hub-Key'] = HUB_KEY;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
    const set = res.headers.get('Set-Cookie');
    if (set) jar.cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (data && data.csrf) jar.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { call, jar };
}

export async function signedIn(env, name = 'Adam', body = {}) {
  const admin = client(env);
  const made = await admin.call('POST', '/api/admin/accounts', { name, ...body }, { hubKey: true });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const token = made.data.invite_link.split('#invite=')[1];
  const c = client(env);
  const password = `${name}-own-password`;
  const r = await c.call('POST', '/api/auth/invite', { token, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { c, id: made.data.id, password };
}
