import { json, readJson, londonDay, HttpError } from '../util.js';
import { BANDS, BAND_CODES, STOPS_DARK, STOPS_LIGHT, EDGES_LIGHT, UNSEEN, GLOW } from '../../../public/js/map/scale.js';
import { rankJoin, RANK_COLS } from '../exam-ranks.js';
import { TYPE_NAMES, LINK_TYPES, FLAGS as LINK_FLAGS } from '../../../public/js/shared/link-rank.js';
import { CATEGORY_SUMMARY_SQL, summaryFromSql } from './weakness.js';
import { topicFlagsSql, flagParams, TEACHING_MS } from './flags.js';
import { ensurePositions, MISSING_SQL, LAYOUT_STATE_SQL, layoutFromRow } from './positions.js';
import { buildProfile } from '../profiles.js';
import { DISCIPLINES } from './systems.js';
import { applyChange, changeResponse } from './change.js';

export const PAYLOAD_VERSION = 2;
export const MAX_IDS = 200;
const LIVE = "('proposed', 'confirmed')";
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

// The band index of a stored band code (scale.js order: strong … very_weak, then unseen). One CASE, made from
// BAND_CODES at load, so there is no second copy of the band list.
const BAND_INDEX_SQL = `CASE WHEN coalesce(s.seen, 0) = 0 THEN ${BAND_CODES.indexOf('unseen')} `
  + BANDS.map((b, i) => `WHEN s.band = '${b.code}' THEN ${i}`).join(' ') + ` ELSE ${BAND_CODES.indexOf('unseen')} END`;
const TYPE_CODE_SQL = 'CASE l.type ' + TYPE_NAMES.map(t => `WHEN '${t}' THEN ${LINK_TYPES[t].code}`).join(' ') + ' ELSE 0 END';
const LINK_FLAGS_SQL = `((CASE WHEN l.directed = 1 THEN ${LINK_FLAGS.directed} ELSE 0 END)
  | (CASE WHEN l.status = 'proposed' THEN ${LINK_FLAGS.proposed} ELSE 0 END)
  | (CASE WHEN l.picture IS NOT NULL AND l.picture != '' THEN ${LINK_FLAGS.picture} ELSE 0 END))`;
const STRENGTH_SQL = 'CAST(round(max(0, min(1, coalesce(l.strength, 0))) * 100) AS INTEGER)';
const CONFUSION_SQL = 'CAST(round(max(0, min(2.55, coalesce(l.confusion, 0))) * 100) AS INTEGER)';
const T1000_SQL = 'CASE WHEN s.seen = 1 AND s.t IS NOT NULL THEN CAST(round(s.t * 1000) AS INTEGER) END';
const CERT_SQL = 'CAST(round(coalesce(s.certainty, 0) * 100) AS INTEGER)';
const YIELD_SQL = 'CAST(round(max(0, min(1, coalesce(t.yield, 0))) * 100) AS INTEGER)';

// The numbered lists every full build shares (binds ?1 user). Indices follow ids, so they are stable between
// two builds of the same map, and categories follow their sort.
const CTES = `live AS (SELECT t.id, t.name, t.short_name, t.category_id, t.unit_id, t.yield, t.status, t.oncology, t.disciplines,
      ROW_NUMBER() OVER (ORDER BY t.id) - 1 AS i FROM topics t WHERE t.user_id = ?1 AND t.status IN ${LIVE}),
  cat AS (SELECT c.id, c.name, c.short_name, ROW_NUMBER() OVER (ORDER BY c.sort, c.id) - 1 AS i FROM categories c
      WHERE c.user_id = ?1 AND (c.status = 'active'
        OR EXISTS (SELECT 1 FROM topics t WHERE t.user_id = ?1 AND t.category_id = c.id AND t.status IN ${LIVE}))),
  un AS (SELECT u.id, u.name, u.category_id, u.lane, u.mehlman_rank, ROW_NUMBER() OVER (ORDER BY u.id) - 1 AS i FROM units u
      WHERE u.user_id = ?1 AND u.id IN (SELECT unit_id FROM live WHERE unit_id IS NOT NULL))`;

export const BODY_SQL = `WITH live AS (SELECT t.id, t.name, t.short_name, t.category_id, t.unit_id, t.oncology, t.disciplines, t.yield, t.status
      FROM topics t WHERE t.user_id = ?1 AND t.status IN ${LIVE})
SELECT json_object(
  'units', (SELECT json_group_array(json_array(u.id, u.name, u.category_id, u.lane, u.mehlman_rank, xrn.rank, xrc.rank)) FROM units u ${rankJoin('u')}
      WHERE u.user_id = ?1 AND u.id IN (SELECT unit_id FROM live WHERE unit_id IS NOT NULL)),
  'topics', (SELECT json_group_array(json_array(t.id, t.name, t.short_name, t.category_id, t.unit_id,
        CASE WHEN p.x IS NULL THEN NULL ELSE round(p.x, 1) END, CASE WHEN p.y IS NULL THEN NULL ELSE round(p.y, 1) END,
        ${YIELD_SQL}, ${T1000_SQL}, ${CERT_SQL}, ${BAND_INDEX_SQL},
        coalesce(s.misses_n, 0), coalesce(s.cards_n, 0), s.last_miss_at, ${topicFlagsSql({ t: 't', s: 's' })},
        coalesce(t.oncology, 0), coalesce(t.disciplines, 0), s.trend))
      FROM live t LEFT JOIN topic_positions p ON p.user_id = ?1 AND p.kind = 'topic' AND p.ref_id = t.id
      LEFT JOIN topic_scores s ON s.user_id = ?1 AND s.topic_id = t.id),
  'links', (SELECT json_group_array(json_array(l.from_id, l.to_id, ${TYPE_CODE_SQL}, ${STRENGTH_SQL}, ${CONFUSION_SQL}, ${LINK_FLAGS_SQL}))
      FROM links l JOIN topics a ON a.user_id = l.user_id AND a.id = l.from_id AND a.status IN ${LIVE}
      JOIN topics b ON b.user_id = l.user_id AND b.id = l.to_id AND b.status IN ${LIVE}
      WHERE l.user_id = ?1 AND l.status IN ('active', 'proposed') AND l.from_id != l.to_id)
) AS body`;

const byId = (x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
/**
 * BODY_SQL's answer with its ids turned into the payload's indices: topics and units numbered by id (as ROW_NUMBER()
 * OVER (ORDER BY id) did), categories by their tuples' own index (cats: categoryTuple rows). Pure, for the tests.
 */
export function numberBody(raw, cats) {
  const b = JSON.parse(raw || '{}');
  const catI = new Map((cats || []).map(c => [c[1], c[0]]));
  const units = (b.units || []).slice().sort(byId);
  const unitI = new Map(units.map((u, i) => [u[0], i]));
  const topics = (b.topics || []).slice().sort(byId);
  const topicI = new Map(topics.map((t, i) => [t[0], i]));
  return {
    units: units.map((u, i) => [i, u[0], u[1], catI.get(u[2]) ?? null, u[3], u[4], u[5] ?? null, u[6] ?? null]),
    topics: topics.map((t, i) => [i, t[0], t[1], t[2], catI.get(t[3]) ?? null, unitI.get(t[4]) ?? null, ...t.slice(5)]),
    links: (b.links || []).filter(l => topicI.has(l[0]) && topicI.has(l[1])).map(l => [topicI.get(l[0]), topicI.get(l[1]), ...l.slice(2)]),
  };
}

// Before 0012 (taxonomy v2) topics have no oncology or disciplines: the same SQL with both read as 0.
const TAGS = 't.oncology, t.disciplines,';
const untagged = sql => sql.replace(TAGS, '0 AS oncology, 0 AS disciplines,');
export const BODY_SQL_UNTAGGED = untagged(BODY_SQL);
const isTagError = e => /no such column/i.test(String(e && e.message)) && /oncology|disciplines/.test(String(e && e.message));
// Before 0013 (weakness model v2) topic_scores has no trend: the same SQL with it read as null.
const noTrend = sql => sql.replace(', s.trend))', ', NULL))').replace('s.trend AS trend', 'NULL AS trend');
const isTrendError = e => /no such column/i.test(String(e && e.message)) && /trend/.test(String(e && e.message));
const RANK_JOIN_U = rankJoin('u');
const noRanks = sql => sql.split(RANK_JOIN_U).join('').replace('u.mehlman_rank, xrn.rank, xrc.rank)', 'u.mehlman_rank, NULL, NULL)').replace(`, ${RANK_COLS} FROM`, ', NULL AS nbme_rank, NULL AS cms_rank FROM');
const isRankError = e => /xq_rank/.test(String(e && e.message));

// The categories with their summary columns (binds ?1 user): turned into rows by summaryFromSql, weakness's
// own reading of CATEGORY_SUMMARY_SQL, so the halo tint can never drift from weakness's categorySummary.
export const CATEGORIES_SQL = `WITH ${CTES}, cs AS (${CATEGORY_SUMMARY_SQL})
SELECT cat.i, cat.id, cat.name, cat.short_name, cs.* FROM cat LEFT JOIN cs ON cs.category_id = cat.id ORDER BY cat.i`;
const CATEGORIES_SQL_UNTAGGED = untagged(CATEGORIES_SQL);

// Everything meta needs (binds ?1 user, ?3 now): the seq, the layout version, the lesson being taught, the profile.
export const META_SQL = `SELECT (SELECT max(seq) FROM map_events WHERE user_id = ?1) AS seq,
  (SELECT max(layout_version) FROM topic_positions WHERE user_id = ?1 AND kind = 'category') AS layout_version,
  (SELECT topic_id FROM lessons WHERE user_id = ?1 AND status = 'in_progress' AND coalesce(started_at, 0) >= ?3 - ${TEACHING_MS}
     AND topic_id IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS teaching_now,
  (SELECT profile FROM users WHERE id = ?1) AS profile, (SELECT profile_json FROM users WHERE id = ?1) AS profile_json`;

/** One category tuple from a CATEGORIES_SQL row. */
export function categoryTuple(r) {
  const s = summaryFromSql(r);
  return [r.i, r.id, r.name, r.short_name || r.name, s.t1000, Math.round(100 * s.coverage), s.n_weak, s.n_unseen, s.n_topics];
}

/** The ETag of a build: the user's newest seq and the London day (the day-bound marks change at midnight). */
export function etagOf(user, seq, now = Date.now()) {
  return `W/"m3-${user === 'mo' ? '' : user + '.'}${Number(seq) || 0}-${londonDay(now)}"`;
}
export const aliasEtag = (user, seq) => `W/"a1-${user === 'mo' ? '' : user + '.'}${Number(seq) || 0}"`;

/**
 * meta for a build: the scale's colours and bands (from scale.js, never copied), link types and the profile.
 * layout (positions.js layoutState, when known): {n, stale, embedded, embedding}, so the page knows whether a first
 * semantic layout should wait for the embeddings.
 */
export function metaOf(row, { user, now = Date.now(), ready = true, layout = null } = {}) {
  let profile;
  try { profile = buildProfile(row && row.profile, row && row.profile_json ? JSON.parse(row.profile_json) : {}); } catch { profile = buildProfile('step2', {}); }
  const lanes = (profile.checklist && profile.checklist.lanes) || [];
  return {
    seq: Number(row && row.seq) || 0, layout_version: Number(row && row.layout_version) || 0, user, built_at: now, ready,
    stops: STOPS_DARK, stops_light: STOPS_LIGHT, edges_light: EDGES_LIGHT,
    unseen: { hex: UNSEEN.dark, light: UNSEEN.light, width: UNSEEN.width, radiusScale: UNSEEN.radiusScale },
    glow: GLOW,
    bands: [...BANDS.map(b => [b.code, b.word, b.from]), [UNSEEN.code, UNSEEN.word, null]],
    weak_from: BAND_CODES.indexOf('weak'),
    link_types: TYPE_NAMES,
    profile: { id: profile.id, lanes, rank_label: (profile.sources || []).includes('mehlman') ? 'Mehlman' : 'Rank' },
    teaching_now: (row && row.teaching_now) || null,
    disciplines: DISCIPLINES.map(([key, word, bit]) => [key, word, bit]),
    ...(layout ? { layout: { n: layout.n, stale: layout.stale, embedded: layout.embedded, embedding: layout.embedding } } : {}),
  };
}

const emptyPayload = (user, now) => JSON.stringify({ v: PAYLOAD_VERSION, meta: metaOf(null, { user, now, ready: false }), categories: [], units: [], topics: [], links: [] });

/**
 * The full payload as a JSON string, plus its seq. One D1 batch in the usual case; when a live topic has no
 * position yet it is placed first (two more queries) and the batch runs again.
 */
export async function buildMapPayload(env, user, { now = Date.now() } = {}) {
  const [, today, , dayStart] = flagParams(user, now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  // The layout's state rides in the same batch; before 0011 (no embeddings table) the batch runs without it.
  // Likewise before 0012 the topics carry no tags (read as 0).
  let withLayout = true, withTags = true, withTrend = true, withRanks = true;
  const bodySql = () => { const b = withTags ? BODY_SQL : BODY_SQL_UNTAGGED; const t = withTrend ? b : noTrend(b); return withRanks ? t : noRanks(t); };
  const run = () => env.DB.batch([
    q(META_SQL, user, today, now),
    q(MISSING_SQL, user, 1),
    q(withTags ? CATEGORIES_SQL : CATEGORIES_SQL_UNTAGGED, user),
    q(bodySql(), user, today, now, dayStart),
    ...(withLayout ? [q(LAYOUT_STATE_SQL, user)] : []),
  ]);
  const attempt = async () => {
    for (;;) {
      try { return await run(); } catch (e) {
        if (!noTable(e)) throw e;
        if (withTags && isTagError(e)) { withTags = false; continue; }
        if (withTrend && isTrendError(e)) { withTrend = false; continue; }
        if (withRanks && isRankError(e)) { withRanks = false; continue; }
        if (!withLayout) throw e;
        withLayout = false;
      }
    }
  };
  let res;
  try {
    res = await attempt();
    if ((res[1].results || []).length) {
      await ensurePositions(env, user, { now });
      res = await attempt();
    }
  } catch (e) {
    if (noTable(e)) return { text: emptyPayload(user, now), seq: 0, ready: false };
    throw e;
  }
  const metaRow = (res[0].results || [])[0] || {};
  const layout = withLayout && res[4] ? layoutFromRow((res[4].results || [])[0], { ai: !!env.AI }) : null;
  const meta = metaOf(metaRow, { user, now, layout });
  const cats = (res[2].results || []).map(categoryTuple);
  const body = numberBody(String(((res[3].results || [])[0] || {}).body || '{"units":[],"topics":[],"links":[]}'), cats);
  const text = `{"v":${PAYLOAD_VERSION},"meta":${JSON.stringify(meta)},"categories":${JSON.stringify(cats)},"units":${JSON.stringify(body.units)},`
    + `"topics":${JSON.stringify(body.topics)},"links":${JSON.stringify(body.links)}}`;
  return { text, seq: meta.seq, ready: true };
}

// ------------------------------------------------------------------ ?ids: only the changed topics

/** Topics by id with everything a full row has, keyed by ids (binds ?1 user, ?2 today, ?3 now, ?4 dayStart, ?5 ids). */
const IDS_SQL = `SELECT t.id, t.name, t.short_name, t.category_id, t.unit_id, t.status,
    CASE WHEN p.x IS NULL THEN NULL ELSE round(p.x, 1) END AS x, CASE WHEN p.y IS NULL THEN NULL ELSE round(p.y, 1) END AS y,
    ${YIELD_SQL} AS yield100, ${T1000_SQL} AS t1000, ${CERT_SQL} AS cert100, ${BAND_INDEX_SQL} AS band_i,
    coalesce(s.misses_n, 0) AS misses, coalesce(s.cards_n, 0) AS cards, s.last_miss_at, ${topicFlagsSql({ t: 't', s: 's' })} AS flags,
    coalesce(t.oncology, 0) AS oncology, coalesce(t.disciplines, 0) AS disciplines, s.trend AS trend
  FROM topics t LEFT JOIN topic_positions p ON p.user_id = t.user_id AND p.kind = 'topic' AND p.ref_id = t.id
  LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
  WHERE t.user_id = ?1 AND t.id IN (SELECT value FROM json_each(?5))`;
const IDS_SQL_UNTAGGED = IDS_SQL.replace('coalesce(t.oncology, 0) AS oncology, coalesce(t.disciplines, 0) AS disciplines', '0 AS oncology, 0 AS disciplines');
const IDS_LINKS_SQL = `SELECT l.from_id, l.to_id, ${TYPE_CODE_SQL} AS type_code, ${STRENGTH_SQL} AS s100, ${CONFUSION_SQL} AS c100, ${LINK_FLAGS_SQL} AS flags
  FROM links l JOIN topics a ON a.user_id = l.user_id AND a.id = l.from_id AND a.status IN ${LIVE}
  JOIN topics b ON b.user_id = l.user_id AND b.id = l.to_id AND b.status IN ${LIVE}
  WHERE l.user_id = ?1 AND l.status IN ('active', 'proposed') AND l.from_id != l.to_id
    AND (l.from_id IN (SELECT value FROM json_each(?3)) OR l.to_id IN (SELECT value FROM json_each(?3)))`;
const IDS_UNITS_SQL = `SELECT u.id, u.name, u.category_id, u.lane, u.mehlman_rank, ${RANK_COLS} FROM units u ${rankJoin('u')} WHERE u.user_id = ?1
  AND u.id IN (SELECT t.unit_id FROM topics t WHERE t.user_id = ?1 AND t.id IN (SELECT value FROM json_each(?2)))`;

/** The rows for some topics (≤ 200), keyed by ids: what live.js needs to update a map already on screen. */
export async function buildIdsPayload(env, user, ids, { now = Date.now() } = {}) {
  const want = [...new Set(ids)].slice(0, MAX_IDS);
  const list = JSON.stringify(want);
  const [, today, , dayStart] = flagParams(user, now);
  await ensurePositions(env, user, { ids: want, now });
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let trend = true, ranks = true;
  const batch0 = tags => env.DB.batch([
    q(META_SQL, user, today, now),
    q((s => (trend ? s : noTrend(s)))(tags ? IDS_SQL : IDS_SQL_UNTAGGED), user, today, now, dayStart, list),
    q(IDS_LINKS_SQL, user, today, list),
    q(ranks ? IDS_UNITS_SQL : noRanks(IDS_UNITS_SQL), user, list),
    q(tags ? CATEGORIES_SQL : CATEGORIES_SQL_UNTAGGED, user),
  ]);
  const batch = async tags => { try { return await batch0(tags); } catch (e) { if (ranks && isRankError(e)) { ranks = false; return batch0(tags); } throw e; } };
  let res;
  try { res = await batch(true); } catch (e) {
    if (isTrendError(e)) { trend = false; try { res = await batch(true); } catch (e2) { if (!isTagError(e2)) throw e2; res = await batch(false); } }
    else if (!isTagError(e)) throw e;
    else { trend = false; res = await batch(false); }
  }
  const meta = metaOf((res[0].results || [])[0] || {}, { user, now });
  const rows = res[1].results || [];
  const live = rows.filter(r => r.status === 'proposed' || r.status === 'confirmed');
  const liveIds = new Set(live.map(r => r.id));
  return {
    v: PAYLOAD_VERSION, partial: true, seq: meta.seq, layout_version: meta.layout_version, teaching_now: meta.teaching_now,
    categories: (res[4].results || []).map(categoryTuple),
    units: (res[3].results || []).map(u => [u.id, u.name, u.category_id, u.lane, u.mehlman_rank, u.nbme_rank ?? null, u.cms_rank ?? null]),
    topics: live.map(r => [r.id, r.name, r.short_name, r.category_id, r.unit_id, r.x, r.y, r.yield100, r.t1000, r.cert100, r.band_i,
      r.misses, r.cards, r.last_miss_at, r.flags, r.oncology, r.disciplines, r.trend ?? null]),
    links: (res[2].results || []).map(l => [l.from_id, l.to_id, l.type_code, l.s100, l.c100, l.flags]),
    gone: want.filter(id => !liveIds.has(id)),
  };
}

// ------------------------------------------------------------------ routes

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };

async function seqOf(env, user) {
  try {
    const r = await env.DB.prepare('SELECT max(seq) AS seq FROM map_events WHERE user_id = ?1').bind(user).first();
    return Number(r && r.seq) || 0;
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

// If-None-Match may list several tags; a weak comparison is enough.
export const tagMatches = (header, tag) => !!header && String(header).split(',').map(s => s.trim()).some(s => s === tag || s === '*');

export function parseIds(raw) {
  const ids = String(raw || '').split(',').map(s => s.trim()).filter(s => s && s.length <= 120);
  if (ids.length > MAX_IDS) throw new HttpError(400, `At most ${MAX_IDS} topics at a time.`);
  return ids;
}

/** GET /api/map and GET /api/map?ids=… */
export async function mapRoute(request, env, ctx, params, url, user) {
  const now = Date.now();
  if (url.searchParams.has('ids')) {
    const ids = parseIds(url.searchParams.get('ids'));
    if (!ids.length) return json({ v: PAYLOAD_VERSION, partial: true, seq: await seqOf(env, user), categories: [], units: [], topics: [], links: [], gone: [] });
    try { return json(await buildIdsPayload(env, user, ids, { now })); } catch (e) {
      if (noTable(e)) return json({ v: PAYLOAD_VERSION, partial: true, seq: 0, categories: [], units: [], topics: [], links: [], gone: ids });
      throw e;
    }
  }
  const inm = request.headers.get('If-None-Match');
  if (inm) {
    const seq = await seqOf(env, user);
    if (seq != null && tagMatches(inm, etagOf(user, seq, now))) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etagOf(user, seq, now) } });
  }
  const built = await buildMapPayload(env, user, { now });
  const headers = { ...HEADERS };
  if (built.ready) headers.ETag = etagOf(user, built.seq, now);
  return new Response(built.text, { status: 200, headers });
}

export const ALIASES_SQL = `SELECT json_group_array(json_array(a.topic_id, a.alias)) AS body FROM topic_aliases a
  JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ${LIVE}
  WHERE a.user_id = ?1 AND a.status = 'active'`;

/** GET /api/map/aliases: every live topic's active aliases, for the map's search (loaded on first focus). */
export async function aliasesRoute(request, env, ctx, params, url, user) {
  const seq = await seqOf(env, user);
  if (seq == null) return json({ seq: 0, aliases: [] });
  const tag = aliasEtag(user, seq);
  if (tagMatches(request.headers.get('If-None-Match'), tag)) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: tag } });
  const r = await env.DB.prepare(ALIASES_SQL).bind(user).first();
  return new Response(`{"seq":${seq},"aliases":${(r && r.body) || '[]'}}`, { status: 200, headers: { ...HEADERS, ETag: tag } });
}

export async function prefsRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const values = body && body.values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) throw new HttpError(400, 'Say which map setting to change.');
  if (Object.keys(values).some(k => !k.startsWith('map.'))) throw new HttpError(400, 'Only the map\'s own settings can be changed here.');
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'pref.set', args: { values }, via: 'api:PATCH /api/map/prefs' }));
}
