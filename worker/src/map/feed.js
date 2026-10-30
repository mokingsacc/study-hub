import { json, readJson } from '../util.js';
import { drainDirty } from './recompute.js';

export const WAIT_MAX = 20;          // seconds
export const POLL_MS = 500;
export const PAGE_MAX = 200;
export const RESYNC_GAP = 500;
export const ANKI_STALE_MS = 30_000;
export const PRESENCE_MS = 30_000;
export const DRAIN_EVERY_MS = 2_000;
export const PAGES = ['map', 'board', 'panel', 'changes', 'lesson', 'home', 'review'];
export const TICKET_MS = 60_000;

// The D1 queries one invocation may spend (Workers Free allows 50; Paid 1,000, set D1_QUERY_BUDGET to use more).
// The default leaves room for the Anki nudge, which runs in the same invocation.
export const queryBudget = env => Math.max(10, Number(env && env.D1_QUERY_BUDGET) || 40);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const noTable = e => /no such table/i.test(String(e && e.message));

// ------------------------------------------------------------------ pure parts

// kinds=csv -> {exact, prefixes}, or null for every kind. 'miss.' and 'miss.*' are prefixes.
export function parseKinds(csv) {
  if (csv == null || String(csv).trim() === '') return null;
  const exact = new Set(), prefixes = [];
  for (const raw of String(csv).split(',').slice(0, 40)) {
    const k = raw.trim().replace(/\*$/, '');
    if (!k || k.length > 40 || !/^[a-z_.]+$/.test(k)) continue;
    if (k.endsWith('.')) prefixes.push(k); else exact.add(k);
  }
  return exact.size || prefixes.length ? { exact, prefixes } : null;
}
export const kindMatches = (filter, kind) => !filter || filter.exact.has(kind) || filter.prefixes.some(p => kind.startsWith(p));

// One map_events row as the feed sends it: its after_json as the patch, and never before_json.
export function feedEvent(r) {
  let patch = null;
  if (r.after_json) { try { patch = JSON.parse(r.after_json); } catch (e) { patch = null; } }
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) delete patch.user_id;
  return { seq: r.seq, at: r.at, actor: r.actor, surface: r.surface, kind: r.kind, target_type: r.target_type, target_id: r.target_id,
    topic_id: r.topic_id, summary: r.summary, patch, batch_id: r.batch_id, undoable: !!r.undoable && !r.undone_by, undone: !!r.undone_by };
}

// Whether a page following from `after` must refetch everything: it is ahead of the log (a restore), behind
// events that were pruned (sync_state 'map_events:pruned' holds the first seq kept, set by whatever prunes), or
// over 500 events behind. seqs are shared by every user, so a user's first seq says nothing about pruning.
export const PRUNED = 'map_events:pruned';
export function needsResync(after, max, keptFrom = null) {
  if (after > max) return true;
  if (keptFrom != null && after < keptFrom - 1) return true;
  return max - after > RESYNC_GAP;
}

export function syncBlock(ankiRows, dirty, queue) {
  let ok_at = null, error = null, next_at = null, failing = null;
  for (const r of ankiRows || []) {
    if (!String(r.source || 'anki').startsWith('anki')) continue;
    if (r.last_ok_at != null && (ok_at == null || r.last_ok_at > ok_at)) ok_at = r.last_ok_at;
    if (r.fails > 0 && r.last_error && (!failing || (r.next_at || 0) > (failing.next_at || 0))) failing = r;
    if (r.next_at != null && (next_at == null || r.next_at < next_at)) next_at = r.next_at;
  }
  if (failing) error = String(failing.last_error).slice(0, 160);
  return { anki: { ok_at, error, next_at }, dirty: dirty || 0, queue: queue || 0 };
}

// ------------------------------------------------------------------ reads

// One read batch: the events after `after`, the counts and the Anki sync rows (and the lesson presence write).
async function readOnce(env, user, after, { presence = false, now = Date.now() } = {}) {
  const stmts = [
    env.DB.prepare(`SELECT seq, at, actor, surface, kind, target_type, target_id, topic_id, summary, after_json, batch_id, undoable, undone_by
      FROM map_events WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`).bind(user, after, PAGE_MAX + 1),
    env.DB.prepare(`SELECT (SELECT max(seq) FROM map_events WHERE user_id = ?1) AS max_seq,
      (SELECT count(*) FROM topic_dirty WHERE user_id = ?1) AS dirty,
      (SELECT count(*) FROM topic_queue WHERE user_id = ?1 AND status = 'open') AS queue`).bind(user),
    env.DB.prepare(`SELECT source, cursor, last_ok_at, next_at, fails, last_error FROM sync_state WHERE user_id = ?1
      AND (source LIKE 'anki%' OR source = ?2)`).bind(user, PRUNED),
  ];
  if (presence) {
    stmts.push(env.DB.prepare(`INSERT INTO sync_state (user_id, source, last_ok_at) VALUES (?1, 'presence:lesson', ?2)
      ON CONFLICT (user_id, source) DO UPDATE SET last_ok_at = excluded.last_ok_at WHERE coalesce(sync_state.last_ok_at, 0) <= excluded.last_ok_at - ?3`)
      .bind(user, now, PRESENCE_MS));
  }
  const res = await env.DB.batch(stmts);
  const c = res[1].results[0] || {};
  const pruned = (res[2].results || []).find(r => r.source === PRUNED);
  const keptFrom = pruned && /^\d+$/.test(String(pruned.cursor)) ? Number(pruned.cursor) : null;
  return { rows: res[0].results || [], max: c.max_seq || 0, keptFrom, sync: syncBlock(res[2].results, c.dirty, c.queue) };
}

// The sync block alone (GET /api/map/sync and Claude's sources_status).
export async function readSync(env, user) {
  const res = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT count(*) FROM topic_dirty WHERE user_id = ?1) AS dirty,
      (SELECT count(*) FROM topic_queue WHERE user_id = ?1 AND status = 'open') AS queue`).bind(user),
    env.DB.prepare("SELECT source, last_ok_at, next_at, fails, last_error FROM sync_state WHERE user_id = ? AND source LIKE 'anki%'").bind(user),
  ]);
  const c = res[0].results[0] || {};
  return syncBlock(res[1].results, c.dirty, c.queue);
}

// ingest's nudge (sync.js kickAnkiPull), loaded when first used; never fails a feed request.
let kick;
export function _setKick(fn) { const prev = kick; kick = fn; return () => { kick = prev; }; }
async function nudgeAnki(env, ctx, reason) {
  try {
    if (kick === undefined) { try { kick = (await import('./sync.js')).kickAnkiPull || null; } catch (e) { kick = null; } }
    if (typeof kick !== 'function') return false;
    const p = Promise.resolve(kick(env, ctx, reason)).catch(e => console.error('kickAnkiPull failed', e && e.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
    return true;
  } catch (e) {
    console.error('anki nudge failed', e && e.message);
    return false;
  }
}

/**
 * The long-poll. Returns the response body; waits up to `wait` seconds for a matching event, checking every
 * pollMs with one indexed read, within the invocation's query budget.
 */
export async function readChanges(env, user, { after = null, wait = 0, kinds = null, page = null, ctx = null, signal = null, pollMs = POLL_MS, now = Date.now } = {}) {
  const filter = typeof kinds === 'string' || kinds == null ? parseKinds(kinds) : kinds;
  const budget = queryBudget(env);
  let used = 0;
  const deadline = now() + Math.max(0, Math.min(WAIT_MAX, Number(wait) || 0)) * 1000;
  const aborted = () => !!(signal && signal.aborted);
  let presence = page === 'lesson';
  let first = true;

  if (after == null) {
    const r = await readOnce(env, user, Number.MAX_SAFE_INTEGER, { presence });
    return { seq: r.max, events: [], more: false, resync: false, sync: r.sync };
  }
  let cursor = after;
  let lastDrain = 0;
  for (;;) {
    const r = await readOnce(env, user, cursor, { presence });
    used++;
    presence = false;
    if (first && needsResync(after, r.max, r.keptFrom)) return { seq: r.max, events: [], more: false, resync: true, sync: r.sync };
    if (first && (r.sync.anki.ok_at == null || now() - r.sync.anki.ok_at > ANKI_STALE_MS)) await nudgeAnki(env, ctx, 'feed');
    first = false;

    const more = r.rows.length > PAGE_MAX;
    const scanned = r.rows.slice(0, PAGE_MAX);
    if (scanned.some(e => e.kind === 'map.resync')) return { seq: r.max, events: [], more: false, resync: true, sync: r.sync };
    const events = scanned.filter(e => kindMatches(filter, e.kind)).map(feedEvent);
    if (scanned.length) cursor = scanned[scanned.length - 1].seq;

    // Dirty topics: recompute up to 20 now (their score.changed events come back on the next read).
    if (r.sync.dirty > 0 && now() - lastDrain >= DRAIN_EVERY_MS && used + 4 < budget && !events.length) {
      lastDrain = now();
      used += 3;
      const d = await drainDirty(env, user, { limit: 20 }).catch(e => { console.error('feed drain failed', e && e.message); return null; });
      if (d && d.n > 0) continue;
    }
    if (events.length || more || now() >= deadline || aborted() || used + 2 >= budget) {
      return { seq: cursor, events, more, resync: false, sync: r.sync };
    }
    // Nothing for this page yet: cheap checks until something newer lands, a drain is due, or time is up.
    for (;;) {
      if (now() >= deadline || aborted() || used + 2 >= budget) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      if (aborted()) break;
      let m;
      try { m = await env.DB.prepare('SELECT max(seq) AS seq FROM map_events WHERE user_id = ?').bind(user).first(); } catch (e) {
        // Out of queries or a D1 blip mid-wait: answer with what is known; the page simply asks again.
        console.error('feed wait check failed', e && e.message);
        return { seq: cursor, events: [], more: false, resync: false, sync: r.sync };
      }
      used++;
      if (((m && m.seq) || 0) > cursor) break;
      if (r.sync.dirty > 0 && now() - lastDrain >= DRAIN_EVERY_MS) break;
    }
    if (aborted() || used + 2 >= budget) return { seq: cursor, events: [], more: false, resync: false, sync: r.sync };
  }
}

const int = (v, d = null) => (v == null || v === '' || !/^\d{1,15}$/.test(String(v)) ? d : Number(v));

// GET /api/map/changes
export async function changesRoute(request, env, ctx, params, url, user) {
  const q = url.searchParams;
  const after = int(q.get('after'));
  if (q.get('after') != null && q.get('after') !== '' && after == null) return json({ error: 'after is a change number.' }, 400);
  const page = PAGES.includes(q.get('page')) ? q.get('page') : null;
  try {
    return json(await readChanges(env, user, { after, wait: int(q.get('wait'), 0), kinds: q.get('kinds'), page, ctx, signal: request.signal || null }));
  } catch (e) {
    if (noTable(e)) return json({ seq: 0, events: [], more: false, resync: false, sync: syncBlock([], 0, 0), not_ready: true });
    throw e;
  }
}

// GET /api/map/sync
export async function syncStatusRoute(request, env, ctx, params, url, user) {
  try { return json({ sync: await readSync(env, user) }); } catch (e) {
    if (noTable(e)) return json({ sync: syncBlock([], 0, 0), not_ready: true });
    throw e;
  }
}

// POST /api/map/sync: pull from Anki now (single flight inside kickAnkiPull), answer at once.
export async function syncKickRoute(request, env, ctx, params, url, user) {
  await readJson(request, 2_000);
  const started = await nudgeAnki(env, ctx, 'manual');
  let sync = null;
  try { sync = await readSync(env, user); } catch (e) { if (!noTable(e)) throw e; }
  return json({ ok: true, started, sync });
}

// ------------------------------------------------------------------ live push (Durable Object)

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function mac(env, text) {
  const k = await crypto.subtle.digest('SHA-256', enc.encode('practice-hub-live:' + env.HUB_KEY));
  const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// A ticket naming the user, good for 60 s: <user>.<exp36>.<mac>.
export async function liveTicket(env, user, now = Date.now()) {
  const exp = (now + TICKET_MS).toString(36);
  return `${user}.${exp}.${(await mac(env, `${user}|${exp}`)).slice(0, 32)}`;
}

// The user a ticket names, or null when it is malformed, forged or expired.
export async function checkTicket(ticket, env, now = Date.now()) {
  const m = /^([a-z0-9_-]{1,40})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(ticket || ''));
  if (!m || !env.HUB_KEY) return null;
  if (parseInt(m[2], 36) < now) return null;
  const want = (await mac(env, `${m[1]}|${m[2]}`)).slice(0, 32);
  if (want.length !== m[3].length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

// GET /api/map/live-ticket
export async function liveTicketRoute(request, env, ctx, params, url, user) {
  if (!env.MAP_LIVE || !env.HUB_KEY) return json({ live: false });
  return json({ live: true, path: '/live/map', ticket: await liveTicket(env, user) });
}

// /live/map?ticket=...: the WebSocket upgrade, outside /api/* (index.js mounts it before the key gate).
export function handleLive(request, env, url) {
  return (async () => {
    if (!env.MAP_LIVE) return new Response('Live updates are not set up.', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const user = await checkTicket(url.searchParams.get('ticket'), env);
    if (!user) return new Response('This live link has expired; the page asks for a new one.', { status: 401 });
    const stub = env.MAP_LIVE.get(env.MAP_LIVE.idFromName(user));
    return stub.fetch(new Request('https://live/connect', request));
  })();
}

// One per user (idFromName(user)): holds the open pages' WebSockets with hibernation, and on /notify sends each
// one {seq}. Pages then fetch /api/map/changes, so the socket carries no data, only "something changed".
export class MapLive {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) { /* older runtime: pings reach webSocketMessage */ }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      let seq = null;
      try { seq = (await request.json()).seq; } catch (e) { /* empty body: still a nudge */ }
      const msg = JSON.stringify({ seq: Number.isInteger(seq) ? seq : null });
      let n = 0;
      for (const ws of this.state.getWebSockets()) { try { ws.send(msg); n++; } catch (e) { /* closing */ } }
      return new Response(JSON.stringify({ sent: n }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/connect') {
      if (this.state.getWebSockets().length >= 20) return new Response('Too many open pages.', { status: 429 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ hello: true }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (message === 'ping') { try { ws.send('pong'); } catch (e) { /* closing */ } }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* already closed */ }
  }

  webSocketError() { /* the page reconnects by itself */ }
}
