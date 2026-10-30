import { claimSource } from '../map/sync.js';
import { writeBatch } from '../map/events.js';
import { MO, activeUsers } from '../users.js';
import { embedMany, EMBED_MODEL, EMBED_CHARS } from '../library/vectors.js';
import { quantise, textKey } from '../../../public/js/shared/similarity.js';
import { WATERMARK, BLOCK_SQL, REVIEWS_SQL, SESSION_SQL, CARDS_SQL, GAPS_LIVE_SQL, GONE_SQL, blockItems, cardItem, gapItem } from './items.js';

export const SOURCE = 'history';
export const ROWS_PER_KIND = 200, BLOCKS_PER_RUN = 3, SESSIONS_PER_RUN = 10, EMBED_PER_RUN = 200;
export const EVERY_MS = 3 * 60_000, RECONCILE_MS = 10 * 60_000, LINE_EVERY_MS = 30 * 60_000, LOCK_MS = 5 * 60_000, MAX_BACKOFF_MS = 6 * 3600_000;
const JSON_CHARS = 60_000;   // characters of items per JSON parameter
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** The stored cursor: {w: {kind: [stamp, id]}, built, rec_at, line_at, pend}. */
export function readCursor(text) {
  let c = {};
  try { c = JSON.parse(text || '{}') || {}; } catch { c = {}; }
  return { w: c.w && typeof c.w === 'object' ? c.w : {}, built: !!c.built, rec_at: Number(c.rec_at) || 0, line_at: Number(c.line_at) || 0, pend: Number(c.pend) || 0 };
}

/** An item as stored: its fingerprints added. */
export function stored(it) {
  const meta = [it.kind, it.src_id, it.day, it.at, it.source, it.label, it.topic_id, it.topic, it.category_id, it.system, it.open];
  return { ...it, sig: textKey(JSON.stringify([it.text, ...meta])), text_key: textKey(it.text) };
}

// ------------------------------------------------------------------ writes

const UPSERT_SQL = `INSERT INTO history_items (user_id, key, kind, src_id, day, at, source, label, topic_id, topic, category_id, system, text, open, sig, text_key, updated_at)
  SELECT ?1, json_extract(j.value, '$.key'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.src_id'), json_extract(j.value, '$.day'),
    json_extract(j.value, '$.at'), json_extract(j.value, '$.source'), json_extract(j.value, '$.label'), json_extract(j.value, '$.topic_id'),
    json_extract(j.value, '$.topic'), json_extract(j.value, '$.category_id'), json_extract(j.value, '$.system'), json_extract(j.value, '$.text'),
    json_extract(j.value, '$.open'), json_extract(j.value, '$.sig'), json_extract(j.value, '$.text_key'), ?2 FROM json_each(?3) j WHERE true
  ON CONFLICT (user_id, key) DO UPDATE SET kind = excluded.kind, src_id = excluded.src_id, day = excluded.day, at = excluded.at, source = excluded.source,
    label = excluded.label, topic_id = excluded.topic_id, topic = excluded.topic, category_id = excluded.category_id, system = excluded.system,
    text = excluded.text, open = excluded.open, sig = excluded.sig,
    vec = CASE WHEN history_items.text_key = excluded.text_key THEN history_items.vec END,
    vec_scale = CASE WHEN history_items.text_key = excluded.text_key THEN history_items.vec_scale END,
    model = CASE WHEN history_items.text_key = excluded.text_key THEN history_items.model END,
    text_key = excluded.text_key, updated_at = excluded.updated_at
  WHERE history_items.sig != excluded.sig`;

function chunkByChars(list) {
  const out = [];
  let cur = [], size = 0;
  for (const x of list) {
    const n = JSON.stringify(x).length;
    if (cur.length && size + n > JSON_CHARS) { out.push(cur); cur = []; size = 0; }
    cur.push(x);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The statements for one step's changes: upserts, removals by key, and for a re-indexed block or session its old
 * items that are no longer made ({kind, src_id, keep: [keys]}).
 */
export function writeStatements(env, user, { upserts = [], removes = [], replaced = [] }, now) {
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const out = [];
  for (const part of chunkByChars(upserts.map(stored))) out.push(P(UPSERT_SQL, user, now, JSON.stringify(part)));
  for (let k = 0; k < removes.length; k += 400) out.push(P(`DELETE FROM history_items WHERE user_id = ?1 AND key IN (SELECT value FROM json_each(?2))`, user, JSON.stringify(removes.slice(k, k + 400))));
  for (const r of replaced) {
    out.push(P(`DELETE FROM history_items WHERE user_id = ?1 AND kind = ?2 AND src_id = ?3 AND key NOT IN (SELECT value FROM json_each(?4))`, user, r.kind, r.src_id, JSON.stringify(r.keep)));
  }
  return out;
}

const changesOf = results => (results || []).reduce((n, r) => n + (Number(r && r.meta && r.meta.changes) || 0), 0);

// ------------------------------------------------------------------ 1. collect

/** What changed since the watermarks: {upserts, removes, replaced, w (the new watermarks), done}. Reads only. */
export async function collect(env, user, w = {}, { rows = ROWS_PER_KIND, blocks = BLOCKS_PER_RUN, sessions = SESSIONS_PER_RUN } = {}) {
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const next = { ...w };
  const upserts = [], removes = [], replaced = [];
  let done = true;
  const mark = k => (Array.isArray(w[k]) ? w[k] : [0, '']);
  const res = await env.DB.batch(WATERMARK.map(s => P(s.sql, user, mark(s.kind)[0], mark(s.kind)[1], rows)));
  WATERMARK.forEach((s, i) => {
    const list = (res[i] && res[i].results) || [];
    for (const r of list) (s.live(r) ? upserts.push(s.item(r)) : removes.push(`${s.kind}:${r.id}`));
    if (list.length) { const last = list[list.length - 1]; next[s.kind] = [last.stamp, last.id]; }
    if (list.length >= rows) done = false;
  });
  if (user === MO) {
    const bw = mark('uworld_words');
    const bl = (await P(BLOCK_SQL, user, bw[0], bw[1], blocks).all()).results || [];
    if (bl.length) {
      const rv = (await P(REVIEWS_SQL, user, JSON.stringify(bl.map(b => b.id))).all()).results || [];
      for (const b of bl) {
        const items = blockItems(b, rv.filter(r => r.block_id === b.id));
        upserts.push(...items);
        replaced.push({ kind: 'uworld_words', src_id: b.id, keep: items.map(x => x.key) });
      }
      const last = bl[bl.length - 1];
      next.uworld_words = [last.stamp, last.id];
      if (bl.length >= blocks) done = false;
    }
    const sw = mark('anki_words');
    const ss = (await P(SESSION_SQL, sw[0], sw[1], sessions).all()).results || [];
    const closed = ss.filter(s => s.status !== 'open');
    const cards = closed.length ? (await P(CARDS_SQL, JSON.stringify(closed.map(s => s.id))).all()).results || [] : [];
    for (const s of ss) {
      // An open session is still being recorded: it is read again once it ends (ending moves its updated_at).
      if (s.status === 'open') continue;
      const items = cards.filter(c => c.session_id === s.id).map(c => cardItem(c, s));
      upserts.push(...items);
      replaced.push({ kind: 'anki_words', src_id: s.id, keep: items.map(x => x.key) });
    }
    if (ss.length) { const last = ss[ss.length - 1]; next.anki_words = [last.stamp, last.id]; }
    if (ss.length >= sessions) done = false;
  }
  return { upserts, removes, replaced, w: next, done };
}

// ------------------------------------------------------------------ 2. reconcile

/** Items whose source has gone leave, and every live gap is checked against its item. Returns the rows changed. */
export async function reconcile(env, user, { now = Date.now() } = {}) {
  const P = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const kinds = Object.keys(GONE_SQL).filter(k => user === MO || (k !== 'uworld_words' && k !== 'anki_words'));
  const [gaps, have, ...gone] = await env.DB.batch([
    P(GAPS_LIVE_SQL, user),
    P(`SELECT key, sig FROM history_items WHERE user_id = ?1 AND kind = 'gap'`, user),
    ...kinds.map(k => P(GONE_SQL[k], user)),
  ]);
  const sigs = new Map(((have && have.results) || []).map(r => [r.key, r.sig]));
  const fresh = ((gaps && gaps.results) || []).map(r => gapItem(r)).filter(it => sigs.get(it.key) !== stored(it).sig);
  let changed = changesOf(gone);
  if (fresh.length) changed += changesOf(await env.DB.batch(writeStatements(env, user, { upserts: fresh }, now)));
  return changed;
}

// ------------------------------------------------------------------ 3. embed

/** Up to `limit` items with no vector (newest first) embedded. Returns {embedded, more}. Throws when Workers AI fails. */
export async function embedStep(env, user, { ai = env.AI, limit = EMBED_PER_RUN, now = Date.now() } = {}) {
  const rows = (await env.DB.prepare(`SELECT rid, text, text_key FROM history_items WHERE user_id = ?1 AND (model IS NULL OR model != ?2)
      ORDER BY at DESC, rid DESC LIMIT ?3`).bind(user, EMBED_MODEL, limit).all()).results || [];
  if (!rows.length) return { embedded: 0, more: false };
  const vecs = await embedMany(ai, rows.map(r => String(r.text).slice(0, EMBED_CHARS)));
  // Only a row whose text is still the one embedded takes the vector (a change since is embedded next time).
  const stmts = rows.map((r, i) => { const { q, scale } = quantise(vecs[i]); return env.DB.prepare(`UPDATE history_items SET vec = ?1, vec_scale = ?2, model = ?3, updated_at = ?4
      WHERE user_id = ?5 AND rid = ?6 AND text_key = ?7`).bind(q, scale, EMBED_MODEL, now, user, r.rid, r.text_key); });
  await env.DB.batch(stmts);
  return { embedded: rows.length, more: rows.length >= limit };
}

// ------------------------------------------------------------------ one step, and the cron's share

/**
 * One step for one user: collect, write, reconcile when due, embed. Returns {cursor, changed, embedded, done, embedError?}.
 * A failed read or write throws (nothing advances); a failed embedding is returned, the written items kept.
 */
export async function sweepStep(env, user, cursor, { now = Date.now(), ai = env.AI, limits = {} } = {}) {
  const c = { ...cursor };
  const got = await collect(env, user, c.w, limits);
  const stmts = writeStatements(env, user, got, now);
  let changed = stmts.length ? changesOf(await env.DB.batch(stmts)) : 0;
  c.w = got.w;
  if (now - c.rec_at >= RECONCILE_MS) { changed += await reconcile(env, user, { now }); c.rec_at = now; }
  let embedded = 0, more = false, embedError = null;
  if (ai && typeof ai.run === 'function') {
    try { ({ embedded, more } = await embedStep(env, user, { ai, now, limit: limits.embed || EMBED_PER_RUN })); }
    catch (e) { embedError = (e && e.message) || String(e); }
  }
  return { cursor: c, changed, embedded, done: got.done && !more && !embedError, embedError };
}

const countItems = async (env, user) => Number((await env.DB.prepare(`SELECT count(*) AS n FROM history_items WHERE user_id = ?1`).bind(user).first())?.n) || 0;

async function line(env, user, summary, after) {
  await writeBatch(env, user, { actor: 'code', surface: 'cron', via: 'cron:history', undoable: false,
    events: [{ kind: 'search.indexed', target_type: 'search', target_id: 'history', summary: summary.slice(0, 160), undoable: false, after }] });
}

/**
 * The cron's share for one user: one step when it is due, then its line in Recent activity if one is owed. Never throws.
 * While the first build runs it is due every minute; then every EVERY_MS; after a failure it backs off.
 */
export async function historyJob(env, user, { now = Date.now(), ai = env.AI, limits } = {}) {
  let row;
  try { row = await claimSource(env, user, SOURCE, { now, lockMs: LOCK_MS }); } catch (e) {
    if (noTable(e)) return { skipped: 'no map yet' };
    return { error: (e && e.message) || String(e) };
  }
  if (!row) return { skipped: 'not due' };
  const cur = readCursor(row.cursor);
  const fails = Number(row.fails) || 0;
  const finish = (cursor, ok, error, nextAt) => env.DB.prepare(`UPDATE sync_state SET lock_until = 0, cursor = ?1, fails = ?2, last_error = ?3, next_at = ?4,
      last_ok_at = CASE WHEN ?5 = 1 THEN ?6 ELSE last_ok_at END WHERE user_id = ?7 AND source = ?8`)
    .bind(JSON.stringify(cursor), ok ? 0 : fails + 1, ok ? null : String(error).slice(0, 300), nextAt, ok ? 1 : 0, now, user, SOURCE).run();
  const backoff = () => now + Math.min(MAX_BACKOFF_MS, 120_000 * 2 ** fails);
  let r;
  try { r = await sweepStep(env, user, cur, { now, ai, limits }); } catch (e) {
    if (noTable(e)) { await finish(cur, true, null, now + 30 * 60_000).catch(() => {}); return { skipped: 'no search index yet (migration 0041)' }; }
    console.error('history index failed', e && e.message);
    await finish(cur, false, (e && e.message) || e, backoff()).catch(() => {});
    if (!fails) await line(env, user, 'Search index: update failed, will retry', { ok: false }).catch(() => {});
    return { error: (e && e.message) || String(e) };
  }
  const c = r.cursor;
  const lines = [];
  if (r.embedError) {
    if (!fails) lines.push(['Search index: embedding failed, will retry', { ok: false }]);
  } else if (fails) {
    lines.push([`Search index: working again, ${plural(await countItems(env, user), 'item')} ready`, { ok: true }]);
    c.line_at = now; c.pend = 0;
  }
  if (!c.built && r.done) {
    c.built = true;
    lines.push([`Search index: ${plural(await countItems(env, user), 'item')} ready`, { built: true }]);
    c.line_at = now; c.pend = 0;
  } else if (c.built) {
    c.pend += r.changed;
    if (c.pend > 0 && now - c.line_at >= LINE_EVERY_MS && !lines.length) {
      lines.push([`Search index: ${plural(c.pend, 'item')} updated, ${plural(await countItems(env, user), 'item')} ready`, { changed: c.pend }]);
      c.line_at = now; c.pend = 0;
    }
  }
  const ok = !r.embedError;
  await finish(c, ok, r.embedError, ok ? (r.done && c.built ? now + EVERY_MS : now) : backoff());
  for (const [s, after] of lines) await line(env, user, s, after).catch(e => console.error('history line failed', e && e.message));
  return { changed: r.changed, embedded: r.embedded, done: r.done, built: c.built, ...(r.embedError ? { error: r.embedError } : {}) };
}

/** cron.js's job: every active user's share. */
export async function historyCron(env, ctx, at) {
  const out = {};
  for (const user of await activeUsers(env)) out[user] = await historyJob(env, user, { now: Number(at) || Date.now() });
  return out;
}
