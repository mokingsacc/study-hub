import { json, readJson, HttpError } from '../util.js';
import { writeBatch } from './events.js';

export const R0 = 600;                       // the first-load circle of category centres
export const GAP = 2.5;                      // world units between two discs
export const RING0 = 10, RING_STEP = 9;      // candidate rings: 10 + 9k
export const RINGS = 40;                     // rings tried before settling for the clearest spot
export const NEIGHBOURS = 12;                // linked neighbours averaged for an anchor
export const MAX_PUT = 2500, MAX_PUT_BYTES = 200_000, MAX_COORD = 100_000;
const CELL = 26;                             // grid cell: two of the largest discs (A+, 11.25) plus the gap

/** World radius from yield (0..1). The page draws the same (data.js radiusOf). */
export const radiusOf = y => 2.5 + 6.5 * Math.sqrt(Math.min(1, Math.max(0, Number(y) || 0)));
/** The page's dot radius by checklist lane (data.js tierRadius), Lane A taken as A+ (the Worker has no ranks here). */
export const TIER_R = Object.freeze({ A: 11.25, B: 6.75, C: 4.5 });
/** The radius a topic is placed with: never smaller than the page draws it. */
export const placeRadius = t => Math.max(radiusOf(t.yield), TIER_R[t && t.lane] || 0);

/** FNV-1a 32-bit, so every page and the Worker agree on a topic's starting angle. */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const round1 = v => Math.round(v * 10) / 10;

/** The deterministic first-load centre of the k-th of n categories (sorted by categories.sort, then id). */
export function circleCentre(k, n) {
  const th = (2 * Math.PI * k) / Math.max(1, n) - Math.PI / 2;
  return { x: round1(R0 * Math.cos(th)), y: round1(R0 * Math.sin(th)) };
}

// A uniform grid over placed discs, for the clearance test.
function grid() {
  const cells = new Map();
  const key = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);   // cells stay within ±32k (coords ≤ 100,000 / 24)
  return {
    add(x, y, r) {
      const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
      const list = cells.get(k);
      if (list) list.push(x, y, r); else cells.set(k, [x, y, r]);
    },
    // The smallest gap between a disc at (x, y, r) and any placed disc (Infinity when none is near).
    clearance(x, y, r) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      let best = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = cells.get(key(cx + i, cy + j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 3) {
          const d = Math.hypot(list[k] - x, list[k + 1] - y) - r - list[k + 2];
          if (d < best) best = d;
        }
      }
      return best;
    },
  };
}

/**
 * Positions for new topics, in order, each placed against everything placed before it (this batch included).
 * news: [{id, category_id, unit_id, yield, lane?}]. ctx:
 *   placed: [{id, x, y, yield, lane?, unit_id, category_id}]   every topic that already has a position
 *   categories: {id: {x, y}}                             category centres already stored
 *   order: [category ids by sort]                        for the first-load circle
 *   neighbours: {topic_id: [topic_id]}                   active links of the new topics
 * Returns {topics: [{id, x, y}], categories: [{id, x, y}]} (categories: centres made here by the circle rule).
 */
export function placeAll(news, { placed = [], categories = {}, order = [], neighbours = {} } = {}) {
  const g = grid();
  const at = new Map();
  const units = new Map(), members = new Map();
  const addTo = (m, k, x, y) => { if (!k) return; const s = m.get(k) || { x: 0, y: 0, n: 0 }; s.x += x; s.y += y; s.n++; m.set(k, s); };
  const addUnit = (u, x, y) => addTo(units, u, x, y);
  for (const p of placed) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    g.add(p.x, p.y, placeRadius(p));
    at.set(p.id, p);
    addUnit(p.unit_id, p.x, p.y);
    addTo(members, p.category_id || '_none', p.x, p.y);
  }
  const cats = { ...categories };
  const madeCats = [];
  const catOrder = order.slice();
  const centreOf = cid => {
    if (cats[cid]) return cats[cid];
    if (!catOrder.includes(cid)) catOrder.push(cid);
    const c = circleCentre(catOrder.indexOf(cid), catOrder.length);
    cats[cid] = c;
    madeCats.push({ id: cid, ...c });
    return c;
  };

  const out = [];
  // Rings already full around an anchor are skipped next time (the inner rings only ever fill up), so a seed
  // of hundreds of topics around one centre stays linear.
  const fromRing = new Map();
  for (const t of news) {
    const r = placeRadius(t);
    let anchor = null;
    const cat = t.category_id || '_none';
    const nb = (neighbours[t.id] || []).map(id => at.get(id)).filter(p => p && (p.category_id || '_none') === cat).slice(0, NEIGHBOURS);
    if (nb.length) anchor = { x: nb.reduce((a, p) => a + p.x, 0) / nb.length, y: nb.reduce((a, p) => a + p.y, 0) / nb.length };
    else if (t.unit_id && units.get(t.unit_id)) { const u = units.get(t.unit_id); anchor = { x: u.x / u.n, y: u.y / u.n }; }
    else if (cats[cat] || !members.get(cat)) anchor = centreOf(cat);
    else { const s = members.get(cat); anchor = { x: s.x / s.n, y: s.y / s.n }; }

    // Candidates on rings 10 + 9k, 8 angles on the first rings and more further out, starting from the
    // topic's own hashed angle. The first clear spot wins; failing that, the clearest one tried.
    const start = (fnv1a(t.id) % 360) * Math.PI / 180;
    const akey = `${Math.round(anchor.x)},${Math.round(anchor.y)}`;
    const k0 = fromRing.get(akey) || 1;
    let best = k0 === 1 && g.clearance(anchor.x, anchor.y, r) >= GAP ? { x: anchor.x, y: anchor.y } : null;
    let fallback = null, fallbackGap = -Infinity, ring = 1;
    for (let k = k0; !best && k <= RINGS; k++) {
      ring = k;
      const R = RING0 + RING_STEP * k;
      const n = Math.max(8, Math.round((2 * Math.PI * R) / 12));
      for (let a = 0; a < n; a++) {
        const th = start + (2 * Math.PI * a) / n;
        const x = anchor.x + R * Math.cos(th), y = anchor.y + R * Math.sin(th);
        const c = g.clearance(x, y, r);
        if (c >= GAP) { best = { x, y }; break; }
        if (c > fallbackGap) { fallbackGap = c; fallback = { x, y }; }
      }
    }
    if (best && ring > 1) fromRing.set(akey, ring);
    else if (!best) fromRing.set(akey, RINGS);
    const pos = best || fallback || anchor;
    const p = { id: t.id, x: round1(pos.x), y: round1(pos.y) };
    out.push(p);
    g.add(p.x, p.y, r);
    at.set(t.id, { ...p, yield: t.yield, lane: t.lane, unit_id: t.unit_id, category_id: t.category_id });
    addUnit(t.unit_id, p.x, p.y);
    addTo(members, cat, p.x, p.y);
  }
  return { topics: out, categories: madeCats.filter(c => c.id !== '_none') };
}

// A topic's checklist lane (its primary unit's), for placeRadius.
const LANE_SQL = '(SELECT u.lane FROM units u WHERE u.user_id = t.user_id AND u.id = t.unit_id) AS lane';
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const LIVE = "('proposed', 'confirmed')";

export const SEMANTIC_FROM = 3;              // the first semantic layout version (embeddings count from here)
/** The signature SQL of topic alias t and embedding alias e (LEFT JOINed: e.topic_id NULL when none). */
export const signatureSql = (t = 't', e = 'e') => `${t}.category_id || '|' || coalesce(${t}.unit_id, '') || '|' || CASE WHEN ${e}.topic_id IS NULL THEN '' ELSE 'e' END`;
// Binds ?1 user.
export const LAYOUT_STATE_SQL = `SELECT count(*) AS n,
    coalesce(sum(CASE WHEN p.ref_id IS NULL OR p.placed_by = 'rule' THEN 1
      WHEN p.placed_by = 'layout' AND coalesce(p.source, '') != (${signatureSql()}) THEN 1 ELSE 0 END), 0) AS stale,
    coalesce(sum(CASE WHEN e.topic_id IS NULL THEN 0 ELSE 1 END), 0) AS embedded,
    (SELECT max(layout_version) FROM topic_positions WHERE user_id = ?1 AND kind = 'category') AS version,
    (SELECT fails FROM sync_state WHERE user_id = ?1 AND source = 'embed') AS embed_fails
  FROM topics t LEFT JOIN topic_positions p ON p.user_id = t.user_id AND p.kind = 'topic' AND p.ref_id = t.id
  LEFT JOIN topic_embeddings e ON e.user_id = t.user_id AND e.topic_id = t.id
  WHERE t.user_id = ?1 AND t.status IN ${LIVE}`;

/** layoutState from one LAYOUT_STATE_SQL row (the payload runs the SQL in its own batch). */
export function layoutFromRow(r, { ai = false } = {}) {
  return { n: Number(r && r.n) || 0, stale: Number(r && r.stale) || 0, embedded: Number(r && r.embedded) || 0, version: Number(r && r.version) || 0,
    embedding: !!ai && (Number(r && r.embed_fails) || 0) < 3 };
}

/**
 * {n, stale, embedded, embedding, version}, or null before 0011 (no embeddings table). embedding: the
 * embeddings are being made (Workers AI bound and the job not failing), so a first semantic layout may wait for
 * them. ai: whether Workers AI is bound (the payload passes !!env.AI).
 */
export async function layoutState(env, user, { ai = !!(env && env.AI) } = {}) {
  try {
    return layoutFromRow(await env.DB.prepare(LAYOUT_STATE_SQL).bind(user).first(), { ai });
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

/** The highest layout_version on the user's category rows (0 before the first layout). */
export async function layoutVersion(env, user) {
  const r = await env.DB.prepare(`SELECT max(layout_version) AS v FROM topic_positions WHERE user_id = ?1 AND kind = 'category'`).bind(user).first();
  return Number(r && r.v) || 0;
}

/**
 * The statements that place these topics (live ones without a position), and what they would place. One read
 * batch; nothing is written. A topic that already has a position keeps it (ON CONFLICT DO NOTHING).
 */
export async function positionStatements(env, user, ids, { now = Date.now() } = {}) {
  const want = JSON.stringify([...new Set((ids || []).filter(x => typeof x === 'string' && x))].slice(0, MAX_PUT));
  if (want === '[]') return { statements: [], placed: [], categories: [] };
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [news, placed, cats, links, ver] = await env.DB.batch([
    q(`SELECT t.id, t.category_id, t.unit_id, t.yield, ${LANE_SQL} FROM topics t WHERE t.user_id = ?1 AND t.status IN ${LIVE}
        AND t.id IN (SELECT value FROM json_each(?2))
        AND NOT EXISTS (SELECT 1 FROM topic_positions p WHERE p.user_id = t.user_id AND p.kind = 'topic' AND p.ref_id = t.id)
        ORDER BY t.category_id, t.unit_id, t.id`, user, want),
    q(`SELECT p.ref_id AS id, p.x, p.y, t.yield, t.unit_id, t.category_id, ${LANE_SQL} FROM topic_positions p
        JOIN topics t ON t.user_id = p.user_id AND t.id = p.ref_id WHERE p.user_id = ?1 AND p.kind = 'topic'`, user),
    q(`SELECT c.id, c.sort, p.x, p.y FROM categories c LEFT JOIN topic_positions p ON p.user_id = c.user_id AND p.kind = 'category' AND p.ref_id = c.id
        WHERE c.user_id = ?1 ORDER BY c.sort, c.id`, user),
    q(`SELECT from_id, to_id FROM links WHERE user_id = ?1 AND status = 'active'
        AND (from_id IN (SELECT value FROM json_each(?2)) OR to_id IN (SELECT value FROM json_each(?2)))`, user, want),
    q(`SELECT max(layout_version) AS v FROM topic_positions WHERE user_id = ?1 AND kind = 'category'`, user),
  ]);
  const newRows = news.results || [];
  if (!newRows.length) return { statements: [], placed: [], categories: [] };
  const neighbours = {};
  const add = (a, b) => { (neighbours[a] = neighbours[a] || []).push(b); };
  for (const l of links.results || []) { add(l.from_id, l.to_id); add(l.to_id, l.from_id); }
  const categories = {};
  for (const c of cats.results || []) if (c.x != null && c.y != null) categories[c.id] = { x: c.x, y: c.y };
  const res = placeAll(newRows, { placed: placed.results || [], categories, order: (cats.results || []).map(c => c.id), neighbours });
  const v = Number(ver.results && ver.results[0] && ver.results[0].v) || 0;
  const rows = [
    ...res.topics.map(p => ({ kind: 'topic', ref_id: p.id, x: p.x, y: p.y })),
    ...res.categories.map(c => ({ kind: 'category', ref_id: c.id, x: c.x, y: c.y })),
  ];
  // One INSERT for everything, rows in one JSON parameter: an existing position is never moved.
  const st = env.DB.prepare(`INSERT INTO topic_positions (user_id, kind, ref_id, x, y, placed_by, pinned, layout_version, created_by, updated_at)
      SELECT ?1, json_extract(j.value, '$.kind'), json_extract(j.value, '$.ref_id'), json_extract(j.value, '$.x'), json_extract(j.value, '$.y'),
        'rule', 0, ?3, 'code', ?4 FROM json_each(?2) j WHERE true
      ON CONFLICT (user_id, kind, ref_id) DO NOTHING`).bind(user, JSON.stringify(rows), v, now);
  return { statements: [st], placed: res.topics, categories: res.categories };
}

/** Places these topics now (two queries: the read batch and the write). Returns {placed, categories}. */
export async function placeTopics(env, user, ids, { now = Date.now() } = {}) {
  try {
    const p = await positionStatements(env, user, ids, { now });
    if (p.statements.length) await env.DB.batch(p.statements);
    return { placed: p.placed, categories: p.categories };
  } catch (e) {
    if (noTable(e)) return { placed: [], categories: [] };
    throw e;
  }
}

/**
 * Places every live topic that has no position yet (all of them, or only ids). Taxonomy's insert paths need
 * not call anything: the payload calls this before it builds, so the map never has a hole. Fails soft.
 */
export async function ensurePositions(env, user, { ids = null, limit = MAX_PUT, now = Date.now() } = {}) {
  try {
    const st = ids
      ? env.DB.prepare(`SELECT t.id FROM topics t WHERE t.user_id = ?1 AND t.status IN ${LIVE} AND t.id IN (SELECT value FROM json_each(?2))
          AND NOT EXISTS (SELECT 1 FROM topic_positions p WHERE p.user_id = t.user_id AND p.kind = 'topic' AND p.ref_id = t.id) LIMIT ?3`)
        .bind(user, JSON.stringify(ids), limit)
      : env.DB.prepare(MISSING_SQL).bind(user, limit);
    const { results } = await st.all();
    const missing = (results || []).map(r => r.id);
    if (!missing.length) return { placed: [] };
    return await placeTopics(env, user, missing, { now });
  } catch (e) {
    if (noTable(e)) return { placed: [] };
    console.error('ensurePositions failed', e && e.message);
    return { placed: [], error: e && e.message };
  }
}

// Live topics with no position, for the payload's first read batch (binds ?1 user, ?2 limit).
export const MISSING_SQL = `SELECT t.id FROM topics t WHERE t.user_id = ?1 AND t.status IN ${LIVE}
  AND NOT EXISTS (SELECT 1 FROM topic_positions p WHERE p.user_id = t.user_id AND p.kind = 'topic' AND p.ref_id = t.id) LIMIT ?2`;

// ------------------------------------------------------------------ PUT /api/map/positions

const okId = s => typeof s === 'string' && s.length > 0 && s.length <= 120;
const okXY = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

/** Checks the body; returns {layout_version, rows: [{kind, ref_id, x, y}]} or throws HttpError(400). */
export function checkPositions(body) {
  const v = body && body.layout_version;
  if (!Number.isInteger(v) || v < 1 || v > 10_000) throw new HttpError(400, 'layout_version must be a whole number from 1.');
  const rows = [];
  for (const [kind, list] of [['topic', body.topics], ['category', body.categories || []]]) {
    if (!Array.isArray(list)) throw new HttpError(400, 'topics must be a list of [id, x, y].');
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 3 || !okId(r[0]) || !okXY(r[1]) || !okXY(r[2])) throw new HttpError(400, 'Each position is [id, x, y] with plain numbers.');
      rows.push({ kind, ref_id: r[0], x: round1(r[1]), y: round1(r[2]) });
    }
  }
  if (!rows.length) throw new HttpError(400, 'There are no positions in that request.');
  if (rows.length > MAX_PUT + 200) throw new HttpError(413, `At most ${MAX_PUT} positions in one request.`);
  return { layout_version: v, rows };
}

// The write of a layout run (binds ?1 user, ?2 rows, ?3 version, ?4 now, ?5 rerun 0|1). Each topic row records its
// signature (see layoutState); before 0011 (no embeddings table) withSig is false and source stays empty.
function layoutWrite(env, user, rows, layout_version, now, rerun, withSig) {
  const sig = withSig ? `(SELECT ${signatureSql('t', 'e')} FROM topics t LEFT JOIN topic_embeddings e ON e.user_id = t.user_id AND e.topic_id = t.id
        WHERE t.user_id = ?1 AND t.id = json_extract(j.value, '$.ref_id'))` : 'NULL';
  return env.DB.prepare(`INSERT INTO topic_positions (user_id, kind, ref_id, x, y, placed_by, pinned, layout_version, source, created_by, updated_at)
      SELECT ?1, json_extract(j.value, '$.kind'), json_extract(j.value, '$.ref_id'), json_extract(j.value, '$.x'), json_extract(j.value, '$.y'),
        'layout', 0, ?3, CASE WHEN json_extract(j.value, '$.kind') = 'topic' THEN ${sig} END, 'code', ?4 FROM json_each(?2) j
      WHERE json_extract(j.value, '$.kind') = 'category'
         OR EXISTS (SELECT 1 FROM topics t WHERE t.user_id = ?1 AND t.id = json_extract(j.value, '$.ref_id'))
      ON CONFLICT (user_id, kind, ref_id) DO UPDATE SET x = excluded.x, y = excluded.y, placed_by = 'layout',
        layout_version = excluded.layout_version, source = excluded.source, updated_at = excluded.updated_at
      WHERE topic_positions.pinned = 0 AND (topic_positions.layout_version < excluded.layout_version
        OR (?5 = 1 AND topic_positions.layout_version = excluded.layout_version))`)
    .bind(user, JSON.stringify(rows), layout_version, now, rerun ? 1 : 0);
}

export async function putPositionsRoute(request, env, ctx, params, url, user) {
  const raw = await readJson(request, MAX_PUT_BYTES);
  const { layout_version, rows } = checkPositions(raw);
  let current;
  try { current = await layoutVersion(env, user); } catch (e) {
    if (noTable(e)) throw new HttpError(503, 'The map arrives with the next hub update.');
    throw e;
  }
  let rerun = false;
  if (current > layout_version) return json({ ok: true, applied: false, layout_version: current });
  if (current === layout_version) {
    if (!raw || raw.rerun !== true) return json({ ok: true, applied: false, layout_version: current });
    rerun = true;
  }
  const now = Date.now();
  const n = rows.filter(r => r.kind === 'topic').length;
  const commit = withSig => writeBatch(env, user, {
    actor: 'code', surface: 'web', via: 'api:PUT /api/map/positions', statements: [layoutWrite(env, user, rows, layout_version, now, rerun, withSig)], undoable: false,
    events: [{ kind: 'positions.changed', target_type: 'position', target_id: null,
      summary: `The map was ${rerun ? 'arranged again' : 'arranged'}: ${n} topic${n === 1 ? '' : 's'} laid out`, after: { layout_version, n, ...(rerun ? { rerun: true } : {}) } }],
  });
  let res;
  try { res = await commit(true); } catch (e) {
    if (!noTable(e)) throw e;
    res = await commit(false);
  }
  return json({ ok: true, applied: true, layout_version, n, seq: res.seq, ...(rerun ? { rerun: true } : {}) });
}
