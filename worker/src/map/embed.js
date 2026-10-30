import { json, HttpError } from '../util.js';
import { EMBED_MODEL, EMBED_DIMS, EMBED_BATCH, embedText, textKey, quantise, dequantise, neighbourLists } from '../../../public/js/shared/similarity.js';
import { writeBatch } from './events.js';
import { layoutState, SEMANTIC_FROM } from './positions.js';

export const STEP_LIMIT = 400;          // topics checked per step (8 Workers AI calls at most)
export const JSON_ROWS = 100;           // rows per JSON parameter (a vector is about 520 characters)
export const SOURCE = 'embed';          // its sync_state row
export const MAX_BACKOFF_MS = 6 * 3600_000;
const LIVE = "('proposed', 'confirmed')";
const STATEMENT_KINDS = "('big_picture', 'need_to_know', 'recognise')";
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const nowMs = () => Date.now();

// Live topics with no vector, a vector from another model, or a topic or statement changed since it was checked
// (binds ?1 user, ?2 model, ?3 limit). New ones first. statement: the topic's first big-picture, need-to-know or
// recognise note.
export const STALE_SQL = `SELECT t.id, t.name, t.short_name, t.kind, t.updated_at,
    (SELECT n.body FROM topic_notes n WHERE n.user_id = t.user_id AND n.topic_id = t.id AND n.status = 'active' AND n.kind IN ${STATEMENT_KINDS}
      ORDER BY CASE n.kind WHEN 'big_picture' THEN 0 WHEN 'need_to_know' THEN 1 ELSE 2 END, n.ord, n.id LIMIT 1) AS statement,
    e.text_key, e.model
  FROM topics t LEFT JOIN topic_embeddings e ON e.user_id = t.user_id AND e.topic_id = t.id
  WHERE t.user_id = ?1 AND t.status IN ${LIVE}
    AND (e.topic_id IS NULL OR e.model != ?2 OR t.updated_at > e.topic_updated_at
      OR EXISTS (SELECT 1 FROM topic_notes n WHERE n.user_id = t.user_id AND n.topic_id = t.id AND n.kind IN ${STATEMENT_KINDS} AND n.updated_at > e.updated_at))
  ORDER BY (e.topic_id IS NULL) DESC, t.id LIMIT ?3`;

// Every live topic's vector (binds ?1 user, ?2 model), in id order.
const VECTORS_SQL = `SELECT e.topic_id AS id, e.vec, e.scale FROM topic_embeddings e
  JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id AND t.status IN ${LIVE}
  WHERE e.user_id = ?1 AND e.model = ?2 ORDER BY e.topic_id`;

const chunks = (list, n = JSON_ROWS) => { const out = []; for (let k = 0; k < list.length; k += n) out.push(list.slice(k, k + n)); return out; };

/** Vectors for these texts, EMBED_BATCH to a call. Throws when Workers AI fails or answers short. */
export async function embedTexts(ai, texts) {
  const out = [];
  for (const part of chunks(texts, EMBED_BATCH)) {
    const r = await ai.run(EMBED_MODEL, { text: part });
    const data = r && r.data;
    if (!Array.isArray(data) || data.length !== part.length || !data.every(v => Array.isArray(v) && v.length)) throw new Error('Workers AI returned no embeddings');
    out.push(...data);
  }
  return out;
}

/**
 * One step: up to `limit` stale topics checked, the changed texts embedded, every neighbour list refreshed when
 * any vector changed, all in one write. Returns {checked, embedded, more, n}. Throws when Workers AI fails
 * (nothing is written then, so the next step simply tries again).
 */
export async function embedStep(env, user, { limit = STEP_LIMIT, now = nowMs(), ai = env.AI } = {}) {
  if (!ai || typeof ai.run !== 'function') throw new HttpError(503, 'Workers AI is not bound, so topics cannot be embedded.');
  const { results } = await env.DB.prepare(STALE_SQL).bind(user, EMBED_MODEL, Math.max(1, Math.min(2000, limit))).all();
  const rows = results || [];
  if (!rows.length) return { checked: 0, embedded: 0, more: false };
  const texts = rows.map(r => embedText(r));
  const keys = texts.map(textKey);
  const changed = [], touched = [];
  rows.forEach((r, k) => (r.text_key === keys[k] && r.model === EMBED_MODEL ? touched : changed).push(k));
  const vectors = changed.length ? await embedTexts(ai, changed.map(k => texts[k])) : [];
  const fresh = new Map(changed.map((k, q) => [rows[k].id, quantise(vectors[q])]));
  const statements = [];
  for (const part of chunks(changed.map((k, q) => ({ id: rows[k].id, key: keys[k], at: rows[k].updated_at || 0, dims: vectors[q].length, ...fresh.get(rows[k].id) })))) {
    statements.push(env.DB.prepare(`INSERT INTO topic_embeddings (user_id, topic_id, model, dims, vec, scale, text_key, topic_updated_at, neighbours, updated_at)
      SELECT ?1, json_extract(j.value, '$.id'), ?2, json_extract(j.value, '$.dims'), json_extract(j.value, '$.q'), json_extract(j.value, '$.scale'),
        json_extract(j.value, '$.key'), json_extract(j.value, '$.at'), '[]', ?3 FROM json_each(?4) j WHERE true
      ON CONFLICT (user_id, topic_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vec = excluded.vec, scale = excluded.scale,
        text_key = excluded.text_key, topic_updated_at = excluded.topic_updated_at, updated_at = excluded.updated_at`)
      .bind(user, EMBED_MODEL, now, JSON.stringify(part)));
  }
  for (const part of chunks(touched.map(k => ({ id: rows[k].id, at: rows[k].updated_at || 0 })))) {
    statements.push(env.DB.prepare(`UPDATE topic_embeddings SET updated_at = ?2,
        topic_updated_at = (SELECT json_extract(j.value, '$.at') FROM json_each(?3) j WHERE json_extract(j.value, '$.id') = topic_embeddings.topic_id)
      WHERE user_id = ?1 AND topic_id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`).bind(user, now, JSON.stringify(part)));
  }
  let n = null;
  if (changed.length) {
    // Every live vector (the new ones over what is stored), then every neighbour list at once.
    const stored = (await env.DB.prepare(VECTORS_SQL).bind(user, EMBED_MODEL).all()).results || [];
    const byId = new Map(stored.map(r => [r.id, r]));
    for (const [id, q] of fresh) byId.set(id, { id, vec: q.q, scale: q.scale });
    const ids = [...byId.keys()].sort();
    const vecs = ids.map(id => { const r = byId.get(id); return dequantise(r.vec, r.scale); });
    const { lists } = neighbourLists(vecs);
    n = ids.length;
    const nb = ids.map((id, i) => ({ id, nb: lists[i].map(([j, s]) => [ids[j], s]) }));
    for (const part of chunks(nb, 150)) {
      statements.push(env.DB.prepare(`UPDATE topic_embeddings SET
          neighbours = (SELECT json_extract(j.value, '$.nb') FROM json_each(?2) j WHERE json_extract(j.value, '$.id') = topic_embeddings.topic_id)
        WHERE user_id = ?1 AND topic_id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`).bind(user, JSON.stringify(part)));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  // Open pages look again when this step brought the embeddings past half the map while the saved layout is older
  // than the semantic one (the page waits for them before its first semantic layout).
  if (changed.length) {
    const st = await layoutState(env, user, { ai: true });
    const added = changed.filter(k => !rows[k].text_key).length;
    const half = st ? 0.5 * st.n : Infinity;
    const crossed = !!st && st.version < SEMANTIC_FROM && st.embedded >= half && st.embedded - added < half;
    if (crossed) {
      await writeBatch(env, user, { actor: 'code', surface: 'cron', via: 'cron:embed', undoable: false,
        events: [{ kind: 'map.resync', target_type: 'map', target_id: 'layout', summary: 'Topic similarities updated; the map can be arranged by them', undoable: false,
          after: { reason: 'embeddings', embedded: changed.length } }] });
    }
  }
  return { checked: rows.length, embedded: changed.length, more: rows.length >= limit, n };
}

/** The cron's share: one step when Workers AI is bound and not backing off. Never throws. */
export async function embedJob(env, user, { now = nowMs(), limit = STEP_LIMIT } = {}) {
  if (!env.AI || typeof env.AI.run !== 'function') return { skipped: 'Workers AI is not bound' };
  let st = null;
  try {
    st = await env.DB.prepare(`SELECT next_at, fails FROM sync_state WHERE user_id = ?1 AND source = '${SOURCE}'`).bind(user).first();
  } catch (e) {
    if (noTable(e)) return { skipped: 'no map yet' };
    throw e;
  }
  if (st && st.next_at && st.next_at > now) return { skipped: 'backing off' };
  const fails = Number(st && st.fails) || 0;
  const record = (ok, error = null) => env.DB.prepare(`INSERT INTO sync_state (user_id, source, last_ok_at, next_at, fails, last_error) VALUES (?1, '${SOURCE}', ?2, ?3, ?4, ?5)
      ON CONFLICT (user_id, source) DO UPDATE SET last_ok_at = coalesce(excluded.last_ok_at, sync_state.last_ok_at), next_at = excluded.next_at,
        fails = excluded.fails, last_error = excluded.last_error`)
    .bind(user, ok ? now : null, ok ? null : now + Math.min(MAX_BACKOFF_MS, 120_000 * 2 ** fails), ok ? 0 : fails + 1, error ? String(error).slice(0, 300) : null).run();
  try {
    const r = await embedStep(env, user, { now, limit });
    if (fails || (r.embedded && !st)) await record(true);
    return r;
  } catch (e) {
    if (noTable(e)) return { skipped: 'no embeddings table yet' };
    console.error('embedding failed', e && e.message);
    await record(false, e && e.message).catch(() => {});
    return { error: (e && e.message) || String(e) };
  }
}

// ------------------------------------------------------------------ routes

// Each live topic's neighbours that are live too (binds ?1 user, ?2 model): one JSON string, built by SQLite.
// CROSS JOIN pins the order: each neighbour is looked up by its id after json_each. Without it, and with no
// statistics (live D1 never runs ANALYZE), SQLite scanned the live topics by status for every neighbour, which
// took 8 to 46 s on 1,106 topics and held up every other request (release-2 review RP-2).
export const LAYOUT_INPUT_SQL = `SELECT count(DISTINCT e.topic_id) AS n,
    coalesce(json_group_array(json_array(e.topic_id, json_extract(nb.value, '$[0]'), json_extract(nb.value, '$[1]'))), '[]') AS body
  FROM topic_embeddings e JOIN topics a ON a.user_id = e.user_id AND a.id = e.topic_id AND a.status IN ${LIVE}
  JOIN json_each(e.neighbours) nb
  CROSS JOIN topics b ON b.user_id = e.user_id AND b.id = json_extract(nb.value, '$[0]') AND b.status IN ${LIVE}
  WHERE e.user_id = ?1 AND e.model = ?2 AND json_extract(nb.value, '$[0]') != e.topic_id`;

/** GET /api/map/layout-input: what the layout needs beyond GET /api/map (the embedding neighbours). Fails soft. */
export async function layoutInputRoute(request, env, ctx, params, url, user) {
  let r = null;
  try { r = await env.DB.prepare(LAYOUT_INPUT_SQL).bind(user, EMBED_MODEL).first(); } catch (e) {
    if (!noTable(e)) throw e;
  }
  const n = Number(r && r.n) || 0;
  const body = n && r.body ? r.body : '[]';
  return new Response(`{"v":1,"model":${JSON.stringify(EMBED_MODEL)},"dims":${EMBED_DIMS},"n":${n},"sim":${body}}`,
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

/** POST /api/map/embeddings/run {limit?}: one step now (the backfill after a release, or a check). */
export async function embedRunRoute(request, env, ctx, params, url, user) {
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const limit = Number.isInteger(body && body.limit) ? Math.max(1, Math.min(2000, body.limit)) : STEP_LIMIT;
  try {
    return json({ ok: true, ...(await embedStep(env, user, { limit })) });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (noTable(e)) throw new HttpError(503, 'The embeddings table arrives with the next hub update.');
    throw new HttpError(502, `Workers AI could not embed the topics: ${String((e && e.message) || e).slice(0, 160)}`);
  }
}
