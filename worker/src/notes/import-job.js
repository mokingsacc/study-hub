import { HttpError } from '../util.js';
import { MO } from '../users.js';
import * as one from './onenote-map.js';
import { ACTIVE, PREFIX, rowsOf, summarise } from './import-summary.js';

export { summarise, chipJob, rowsOf } from './import-summary.js';

export const LOCK = 'notes.import';
export { PREFIX };
export const KICK_UNITS = 12, KICK_MS = 20_000, CRON_UNITS = 30, CRON_MS = 40_000, LOCK_SLACK_MS = 30_000;
export const MAX_TRIES = 3, MAX_PAGES = 400, CHECK_MAX = 36;
const range = env => [`${PREFIX}`, `${PREFIX.slice(0, -1)};`];   // 'notes.import:' <= source < 'notes.import;'

async function rows(env, user) {
  const [lo, hi] = range(env);
  const r = await env.DB.prepare('SELECT source, cursor, next_at, last_ok_at FROM sync_state WHERE user_id = ?1 AND source >= ?2 AND source < ?3 ORDER BY next_at, source')
    .bind(user, lo, hi).all();
  return rowsOf(r.results);
}
const pack = p => JSON.stringify({ t: p.t, r: p.r, st: p.st, pid: p.pid || null, left: p.left || [], tot: p.tot || 0, got: p.got || 0, miss: p.miss || [],
  ...(p.chk ? { chk: 1 } : {}), ...(p.err ? { err: String(p.err).slice(0, 200) } : {}), tries: p.tries || 0, ...(p.nx ? { nx: p.nx } : {}) });

export async function status(env, user, { now = Date.now() } = {}) {
  const [list, lock] = await Promise.all([rows(env, user),
    env.DB.prepare('SELECT lock_until FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, LOCK).first()]);
  return summarise(list, { now, lockUntil: Number(lock && lock.lock_until) || 0 });
}

// ---------------------------------------------------------------- queueing, Retry, Clear
export async function enqueue(env, user, pages, { region = 'us', now = Date.now() } = {}) {
  const want = [];
  const seen = new Set();
  for (const p of Array.isArray(pages) ? pages : []) {
    const id = String((p && (p.onenote_id || p.id)) || '');
    if (!id || id.length > 300 || seen.has(id)) continue;
    seen.add(id);
    want.push({ id, t: String((p && p.title) || 'Untitled page').slice(0, 200) });
  }
  if (!want.length) throw new HttpError(400, 'Which OneNote pages? (pages: [{onenote_id, title}])');
  if (want.length > MAX_PAGES) throw new HttpError(400, `At most ${MAX_PAGES} pages at a time.`);
  const list = await rows(env, user);
  const idle = !list.some(p => ACTIVE.includes(p.st));
  const by = new Map(list.map(p => [p.id, p]));
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const stmts = [];
  if (idle) {
    for (const p of list) if (p.st === 'done' && !(p.miss || []).length && !want.some(w => w.id === p.id)) stmts.push(P('DELETE FROM sync_state WHERE user_id = ?1 AND source = ?2', user, p.source));
  }
  let order = Math.max(now * 1000, ...list.map(p => p.order + 1));
  let added = 0, already = 0;
  for (const w of want) {
    const had = by.get(w.id);
    if (had && ACTIVE.includes(had.st)) { already++; continue; }
    const cur = pack({ t: w.t, r: region === 'uk' ? 'uk' : 'us', st: 'wait' });
    // A done or failed row goes back in; the WHERE keeps a row a run has just picked up as it is.
    stmts.push(P(`INSERT INTO sync_state (user_id, source, cursor, next_at, last_ok_at, fails, lock_until) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, next_at = excluded.next_at, last_ok_at = excluded.last_ok_at
      WHERE json_extract(sync_state.cursor, '$.st') NOT IN ('wait', 'pics')`, user, PREFIX + w.id, cur, order++, now));
    added++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { added, already };
}

/** Failed pages go back in the queue; pages whose pictures failed fetch those pictures again. */
export async function retry(env, user, { now = Date.now() } = {}) {
  const list = await rows(env, user);
  const stmts = [];
  let pages = 0, pictures = 0;
  for (const p of list) {
    if (ACTIVE.includes(p.st)) continue;
    let next = null;
    if (p.st === 'failed') { next = { ...p, st: 'wait', err: null, tries: 0, nx: 0, left: [], miss: [], got: 0, tot: 0 }; pages++; }
    else if ((p.miss || []).length) { next = { ...p, st: 'pics', left: [...p.miss], miss: [], err: null, tries: 0, nx: 0, got: p.got || 0 }; pictures += p.miss.length; }
    if (next) stmts.push(env.DB.prepare(`UPDATE sync_state SET cursor = ?1, last_ok_at = ?2 WHERE user_id = ?3 AND source = ?4
      AND json_extract(cursor, '$.st') NOT IN ('wait', 'pics')`).bind(pack(next), now, user, p.source));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { pages, pictures };
}

/** The finished pages leave the list (the sidebar's "Done" and the dismiss on a list with failures). */
export async function clear(env, user) {
  const list = await rows(env, user);
  const stmts = list.filter(p => !ACTIVE.includes(p.st)).map(p => env.DB.prepare('DELETE FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, p.source));
  if (stmts.length) await env.DB.batch(stmts);
  return { cleared: stmts.length };
}

export const LEASE_MS = 75_000;
const token = () => crypto.randomUUID();
class Lost extends Error { constructor() { super('Another run has this import now.'); this.lost = true; } }
const P = (env, sql, ...a) => env.DB.prepare(sql).bind(...a);
const any = r => !!(r && (r.results || []).length);

async function claim(env, user, source, tok, at) {
  const r = await P(env, `UPDATE sync_state SET lock_until = ?1, cursor = json_set(cursor, '$.own', ?2)
    WHERE user_id = ?3 AND source = ?4 AND json_extract(cursor, '$.st') IN ('wait', 'pics') AND (lock_until < ?5 OR json_extract(cursor, '$.own') = ?2)
    RETURNING source, cursor, next_at, last_ok_at`, at + LEASE_MS, tok, user, source, at).all();
  return rowsOf(r.results)[0] || null;
}
/** Renews the page claim (and the run's lock, when the step runs under one); throws Lost when either is gone. */
async function renew(env, user, source, tok, lockTok, at) {
  const stmts = [P(env, `UPDATE sync_state SET lock_until = ?1 WHERE user_id = ?2 AND source = ?3 AND json_extract(cursor, '$.own') = ?4 RETURNING source`, at + LEASE_MS, user, source, tok)];
  if (lockTok) stmts.push(P(env, 'UPDATE sync_state SET lock_until = ?1 WHERE user_id = ?2 AND source = ?3 AND cursor = ?4 RETURNING source', at + LEASE_MS, user, LOCK, lockTok));
  const rs = await env.DB.batch(stmts);
  if (!rs.every(any)) throw new Lost();
}
/** Saves the page row and lets go of its claim, only while the claim is still this step's. */
async function saveOwned(env, user, p, tok, at) {
  const r = await P(env, `UPDATE sync_state SET cursor = ?1, last_ok_at = ?2, lock_until = 0 WHERE user_id = ?3 AND source = ?4 AND json_extract(cursor, '$.own') = ?5
    RETURNING source`, pack(p), at, user, p.source, tok).all();
  if (!any(r)) throw new Lost();
}

export const MAX_DOWN_TRIES = 6;
export const waitAfter = (tries, down) => (down ? Math.min(30_000 * 2 ** Math.max(0, tries - 1), 600_000) : 10_000 * tries);

// ---------------------------------------------------------------- one step
/**
 * One unit of work on the first page still in the queue, under that page's claim. Returns {idle} | {later: at} (the
 * page waits after a failed try) | {busy} (another run holds the page) | {lost} (another run took it over mid-step; this
 * step saved nothing) | {page, did} | {page, error}.
 */
export async function step(env, user, { now = () => Date.now(), lock = null } = {}) {
  const list = await rows(env, user);
  const first = list.find(x => ACTIVE.includes(x.st));
  if (!first) return { idle: true };
  if (first.nx && first.nx > now()) return { later: first.nx };
  const tok = token();
  const p = await claim(env, user, first.source, tok, now());
  if (!p || !ACTIVE.includes(p.st)) return { busy: true };
  const beat = () => renew(env, user, p.source, tok, lock, now());
  delete p.nx;
  let batch = [], fetched = 0;
  try {
    if (p.st === 'wait') {
      const r = await one.importPage(env, user, p.id, { region: p.r === 'uk' ? 'uk' : 'us', actor: 'mo', via: 'job:notes.import', beat });
      if (r.refused || r.needs_confirm) { Object.assign(p, { st: 'failed', err: r.reason || 'Notes would not take this page.' }); await saveOwned(env, user, p, tok, now()); return { page: p.id, did: 'failed' }; }
      const pics = [...new Set(r.pictures || [])];
      Object.assign(p, { pid: r.page_id, t: r.title || p.t, left: pics, tot: pics.length, got: 0, miss: [], tries: 0, chk: r.unchanged ? 1 : 0, st: pics.length ? 'pics' : 'done', err: null });
      await saveOwned(env, user, p, tok, now());
      return { page: p.id, did: r.unchanged ? 'unchanged' : 'page' };
    }
    // pics: an unchanged page first asks R2 which of its pictures are already there (at most CHECK_MAX a step). A
    // picture R2 could not answer for is fetched again (storing it twice is harmless), never dropped.
    let checked = 0;
    if (p.chk && env.LIBRARY && typeof env.LIBRARY.head === 'function') {
      const left = [...p.left];
      while (left.length && batch.length < one.PICS_PER_CALL && checked < CHECK_MAX) {
        const n = left.shift();
        checked++;
        let has = null;
        try { has = await env.LIBRARY.head(await one.picKey(user, p.id, n)); } catch (e) { console.error('notes import: R2 head failed', e && e.message); }
        if (has) p.got = (p.got || 0) + 1;
        else batch.push(n);
      }
      p.left = left;
    } else batch = p.left.splice(0, one.PICS_PER_CALL);
    if (batch.length) {
      const r = await one.storePictures(env, user, p.id, batch);
      p.got = (p.got || 0) + r.stored.length;
      p.miss = [...(p.miss || []), ...r.missing];
      fetched = batch.length;
      batch = [];
    }
    p.tries = 0;
    p.err = null;
    if (!p.left.length) p.st = 'done';
    await saveOwned(env, user, p, tok, now());
    return { page: p.id, did: 'pictures', n: fetched };
  } catch (e) {
    if (e && e.lost) return { lost: true, page: p.id };
    if (batch.length) p.left.unshift(...batch);
    p.tries = (p.tries || 0) + 1;
    p.err = (e && e.message) || String(e);
    const down = !!(e && e.down);
    if (p.tries >= (down ? MAX_DOWN_TRIES : MAX_TRIES)) {
      // A page that never came in fails; a page whose pictures keep failing keeps what came and lists the rest.
      if (p.st === 'wait') p.st = 'failed';
      else { p.miss = [...(p.miss || []), ...p.left.splice(0, one.PICS_PER_CALL)]; p.tries = 0; if (!p.left.length) p.st = 'done'; }
    }
    if (ACTIVE.includes(p.st)) p.nx = now() + waitAfter(p.tries || 1, down);
    try { await saveOwned(env, user, p, tok, now()); } catch (e2) { if (e2 && e2.lost) return { lost: true, page: p.id }; throw e2; }
    return { page: p.id, error: p.err, ...(p.nx ? { later: p.nx } : {}) };
  }
}

// ---------------------------------------------------------------- a run
/**
 * Steps under the lock until the queue is empty, the budget is spent, a step fails or must wait (the next run, a few
 * seconds or a minute later, tries again), or another run took over. Returns {skipped} when another run holds the lock.
 */
export async function run(env, user, { units = KICK_UNITS, ms = KICK_MS, now = () => Date.now() } = {}) {
  const start = now();
  const tok = token();
  const [, got] = await env.DB.batch([
    P(env, 'INSERT INTO sync_state (user_id, source, fails, lock_until) VALUES (?1, ?2, 0, 0) ON CONFLICT (user_id, source) DO NOTHING', user, LOCK),
    P(env, 'UPDATE sync_state SET lock_until = ?1, cursor = ?2 WHERE user_id = ?3 AND source = ?4 AND lock_until < ?5 RETURNING source', start + LEASE_MS, tok, user, LOCK, start),
  ]);
  if (!any(got)) return { skipped: true };
  const out = { steps: 0, errors: 0 };
  try {
    while (out.steps < units && now() - start < ms) {
      const kept = await P(env, 'UPDATE sync_state SET lock_until = ?1 WHERE user_id = ?2 AND source = ?3 AND cursor = ?4 RETURNING source', now() + LEASE_MS, user, LOCK, tok).all();
      if (!any(kept)) { out.lost = true; break; }
      const r = await step(env, user, { now, lock: tok });
      if (r.idle) { out.idle = true; break; }
      if (r.lost || r.busy) { out.lost = true; break; }
      if (r.later && !r.error) { out.later = r.later; break; }
      out.steps++;
      if (r.error) { out.errors++; out.error = r.error; if (r.later) out.later = r.later; break; }
    }
  } finally {
    // Let go of the lock only while it is still this run's.
    await P(env, 'UPDATE sync_state SET lock_until = 0, cursor = NULL, last_ok_at = ?1 WHERE user_id = ?2 AND source = ?3 AND cursor = ?4', now(), user, LOCK, tok).run()
      .catch(e => console.error('notes import unlock failed', e && e.message));
  }
  return out;
}

/** Start a run in the background when the queue has work and no run holds the lock. Returns whether one started. */
export function kick(env, ctx, user, st) {
  if (!st || !st.running || st.working || !ctx || typeof ctx.waitUntil !== 'function') return false;
  if (st.current && st.current.retry_at) return false;   // the page waits after a failed try (the Anki server may be down)
  ctx.waitUntil(run(env, user).catch(e => console.error('notes import run failed', e && e.message)));
  return true;
}

export async function cronTick(env) {
  if (!env || env.NOTES !== 'on' || !env.ANKI_MCP_URL) return null;
  try {
    const st = await status(env, MO);
    if (!st.running) return { idle: true };
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
  return run(env, MO, { units: CRON_UNITS, ms: CRON_MS });
}

