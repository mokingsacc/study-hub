import { londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { AUDIT_SPECS, checkItem, recordAudit, auditCounts, summarise } from '../ai-audit.js';
import { CLUSTERS, findClusters, shapeRow, codeName } from './clusters.js';

const DAY_MS = 86_400_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const pending = e => !!(e && e.pending === true && e.batch === true);
const capped = e => Number(e && e.status) === 429;
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const LIVE = "('proposed', 'confirmed')";

export const TOPICS_SQL = `WITH ids(id) AS (
    SELECT from_id FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active', 'proposed')
    UNION SELECT to_id FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active', 'proposed')
    UNION SELECT topic_id FROM evidence WHERE user_id = ?1 AND kind = 'concept_miss' AND held = 0 AND topic_id IS NOT NULL
    UNION SELECT json_extract(detail_json, '$.from_topic') FROM evidence WHERE user_id = ?1 AND kind = 'concept_miss' AND held = 0)
  SELECT t.id, t.name, t.kind, t.category_id, t.yield, coalesce(s.seen, 0) AS seen, s.band, s.weakness_raw,
    (SELECT count(*) FROM evidence e WHERE e.user_id = ?1 AND e.topic_id = t.id AND e.slot = 0 AND e.held = 0 AND e.at >= ?2
      AND ((e.kind = 'question' AND e.result IN ('wrong', 'flawed', 'omitted')) OR e.kind = 'gap_stated' OR e.kind = 'concept_miss')) AS fails
  FROM topics t JOIN ids ON ids.id = t.id LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
  WHERE t.user_id = ?1 AND t.status IN ${LIVE}`;
export const VERSUS_SQL = `SELECT l.id, l.from_id, l.to_id, l.strength, l.confusion,
    coalesce(sum(CASE WHEN s.held = 0 AND s.cw > 0 THEN s.cw ELSE 0 END), 0) AS cw_sum, coalesce(sum(s.held = 0 AND s.cw > 0), 0) AS conf_n
  FROM links l LEFT JOIN link_support s ON s.user_id = l.user_id AND s.link_id = l.id
  WHERE l.user_id = ? AND l.type = 'versus' AND l.status IN ('active', 'proposed') GROUP BY l.id`;
// The concept rows (concepts.js): which clinical topic each came from.
export const CONCEPTS_SQL = `SELECT topic_id AS concept_id, json_extract(detail_json, '$.from_topic') AS from_topic, count(*) AS n FROM evidence
  WHERE user_id = ? AND kind = 'concept_miss' AND held = 0 AND topic_id IS NOT NULL GROUP BY topic_id, json_extract(detail_json, '$.from_topic')`;

export async function readRaw(env, user, now = Date.now()) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [t, v, c, p] = await env.DB.batch([
    q(TOPICS_SQL, user, now - 60 * DAY_MS),
    q(VERSUS_SQL, user),
    q(CONCEPTS_SQL, user),
    q("SELECT * FROM clusters WHERE user_id = ? AND status = 'active'", user),
  ]);
  return { topics: t.results || [], versus: v.results || [], concepts: c.results || [], previous: (p.results || []).map(shapeRow) };
}

/** The rows the night's clusters write (pure): upserts for the clusters found and 'gone' for the old ones not found. */
export function writeRows(found, previous, now, { naming = true } = {}) {
  const byId = new Map((previous || []).map(p => [p.id, p]));
  const keep = new Set(found.map(c => c.id));
  const upserts = found.map(c => {
    const old = byId.get(c.id);
    const named = old && old.name_by === 'claude' && old.root && old.root.id === c.root.id;
    return {
      id: c.id, kept: !!old, name: named ? old.name : c.name, name_by: named ? 'claude' : 'code',
      name_status: named ? 'done' : naming ? 'pending' : 'done', root_id: c.root.id, root_kind: c.root.kind,
      members_json: JSON.stringify(c.members), pairs_json: JSON.stringify(c.pairs.slice(0, 12)), cost: c.cost,
      detail_json: JSON.stringify({ root_name: c.root.name, root_in_cluster: c.root.in_cluster, edges: c.edges, weight: c.weight, code_name: c.name }),
      first_seen: old ? old.first_seen : now,
    };
  });
  const gone = (previous || []).filter(p => !keep.has(p.id)).map(p => p.id);
  return { upserts, gone };
}

/**
 * The night's run. Never throws (its error is its own Recent activity line). Returns {found, new, kept, gone, top,
 * named, held} or {error}. opts.call: the naming call (tests); opts.naming: false skips it.
 */
export async function clustersJob(env, user, { now = Date.now(), call = null, naming = true } = {}) {
  let raw;
  try { raw = await readRaw(env, user, now); } catch (e) {
    if (noTable(e)) return { skipped: 'no clusters table yet' };
    await noteJob(env, { job: 'clusters', user, key: `night:${londonDay(now)}`, ref: 'night', state: 'failed', at: now, detail: e });
    return { error: (e && e.message) || String(e) };
  }
  try {
    const { clusters, q, graph } = findClusters(raw, raw.previous, CLUSTERS, { salt: londonDay(now) });
    const { upserts, gone } = writeRows(clusters, raw.previous, now, { naming });
    const st = [];
    for (const u of upserts) {
      st.push(env.DB.prepare(`INSERT INTO clusters (user_id, id, status, name, name_by, name_status, root_id, root_kind, members_json, pairs_json, cost, detail_json,
          first_seen, last_seen, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13)
        ON CONFLICT (user_id, id) DO UPDATE SET status = 'active', name = excluded.name, name_by = excluded.name_by, name_status = excluded.name_status,
          root_id = excluded.root_id, root_kind = excluded.root_kind, members_json = excluded.members_json, pairs_json = excluded.pairs_json, cost = excluded.cost,
          detail_json = excluded.detail_json, last_seen = excluded.last_seen, updated_at = excluded.updated_at`)
        .bind(user, u.id, u.name, u.name_by, u.name_status, u.root_id, u.root_kind, u.members_json, u.pairs_json, u.cost, u.detail_json, u.first_seen, now));
    }
    if (gone.length) st.push(env.DB.prepare(`UPDATE clusters SET status = 'gone', updated_at = ?3 WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(gone), now));
    if (st.length) await env.DB.batch(st);
    const fresh = upserts.filter(u => !u.kept);
    let named = { named: 0, held: false };
    if (naming && upserts.some(u => u.name_status === 'pending')) named = await nameClusters(env, user, null, { now, call });
    const top = upserts[0] ? (named.names && named.names.get(upserts[0].id)) || upserts[0].name : null;
    const newest = fresh.length ? (named.names && named.names.get(fresh[0].id)) || fresh[0].name : null;
    // The line's names ride in its detail, "<newest new> | <costliest>" (recent.js words them); a name waiting for its
    // batch says so in its counts, and the hourly retry posts the names when they come.
    await noteJob(env, { job: 'clusters', user, key: `night:${londonDay(now)}`, ref: 'night', state: 'ok', at: now,
      detail: upserts.length ? cut(`${(newest || '').replace(/\|/g, '/')} | ${(top || '').replace(/\|/g, '/')}`, 140) : null,
      counts: { found: upserts.length, fresh: fresh.length, kept: upserts.length - fresh.length, gone: gone.length, topics: graph.nodes.length, named: named.named,
        top_new: fresh.length && fresh[0].id === (upserts[0] || {}).id ? 1 : 0, naming: named.held ? 1 : 0, ...(named.counts || {}) } });
    return { found: upserts.length, new: fresh.length, kept: upserts.length - fresh.length, gone: gone.length, q, top, newest, named: named.named, held: named.held };
  } catch (e) {
    await noteJob(env, { job: 'clusters', user, key: `night:${londonDay(now)}`, ref: 'night', state: 'failed', at: now, detail: e });
    return { error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- the naming call

export const NAME_SYSTEM = `You name groups of USMLE Step 2 CK topics that one student, Mo, keeps getting wrong together. Each group has a root (the shared idea, or the topic most of his errors run through) and its member topics, with the pairs he mixes up.

Give each group one short name in plain words, at most 7 words, in the form "<area>: <the shared skill or idea>", for example "Thyroid: reading the uptake scan" or "Chest pain: telling the emergencies apart". Name what ties the group together, not a list of its topics. Standard abbreviations only (ECG, CT, TSH). Never copy question-bank text.`;
export const NAME_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['clusters'],
  properties: { clusters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } } },
};

/** The naming call's user turn (pure; the same clusters always give the same text, so a batch answer is found again). */
export function nameMessage(rows) {
  return rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => {
    const name = id => (c.members.find(m => m.id === id) || {}).name || id;
    const members = c.members.filter(m => m.id !== c.root.id).map(m => m.name);
    const pairs = (c.pairs || []).slice(0, 4).map(p => `${name(p.a)} versus ${name(p.b)}`);
    return [`Group ${c.id}`, `Root: ${c.root.name || name(c.root.id)} (${c.root.kind === 'concept' ? 'a foundation concept' : 'a topic'})`,
      `Members: ${members.join('; ')}`, ...(pairs.length ? [`Mixed up: ${pairs.join('; ')}`] : [])].join('\n');
  }).join('\n\n');
}

/** The names the call gave, checked (pure): a known id, a name of 3 to CLUSTERS.name_max characters; others are dropped. */
export function cleanNames(data, ids) {
  const known = new Set(ids), out = new Map();
  for (const x of (data && Array.isArray(data.clusters) ? data.clusters : [])) {
    const name = cut(String((x && x.name) || '').replace(/["“”|]/g, '').replace(/[.;]+$/, ''), CLUSTERS.name_max);
    if (x && known.has(x.id) && name.length >= 3 && !out.has(x.id)) out.set(x.id, name);
  }
  return out;
}

async function callNamer(env, { system, schema, content }) {
  const [{ callJson }, { reserveSpend, spendCap }] = await Promise.all([import('../claude.js'), import('../db.js')]);
  const release = await reserveSpend(env, 0.1, await spendCap(env));
  try {
    const r = await callJson(env, { role: 'labeller', use: 'cluster', system, schema, effort: 'low', maxTokens: 2000, messages: [{ role: 'user', content }] });
    return { data: r.data, usd: r.usd || 0 };
  } finally { await release(0); }
}

/**
 * Names the clusters waiting for one (rows, or every active one with name_status pending): one call; until it answers
 * (a Message Batch, or the daily cap) they keep their code names. Returns {named, held, names: Map, counts}.
 */
export async function nameClusters(env, user, rows = null, { now = Date.now(), call = null } = {}) {
  let list = rows;
  if (!list) {
    try { list = ((await env.DB.prepare("SELECT * FROM clusters WHERE user_id = ? AND status = 'active' AND name_status = 'pending'").bind(user).all()).results || []).map(shapeRow); } catch (e) { if (noTable(e)) return { named: 0, held: false }; throw e; }
  }
  if (!list.length) return { named: 0, held: false };
  const content = nameMessage(list);
  let data;
  try {
    data = (await (call || callNamer)(env, { system: NAME_SYSTEM, schema: NAME_SCHEMA, content })).data;
  } catch (e) {
    if (pending(e) || capped(e)) return { named: 0, held: true };
    // A failed call leaves the code names in place for good (no retry loop): the next night asks again for new ones only.
    await env.DB.prepare(`UPDATE clusters SET name_status = 'done', updated_at = ?3 WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
      .bind(user, JSON.stringify(list.map(c => c.id)), now).run().catch(() => {});
    await noteJob(env, { job: 'clusters', user, key: `names:${londonDay(now)}`, ref: 'names', state: 'failed', at: now, detail: e });
    return { named: 0, held: false, failed: true };
  }
  const names = cleanNames(data, list.map(c => c.id));
  const rowsChecked = list.map(c => checkItem({ id: c.id, name: names.get(c.id) || '' }, { id: c.id, ...AUDIT_SPECS.cluster_name() }));
  const check = await recordAudit(env, { job: 'clusters', key: `names:${londonDay(now)}`, ref: 'names', user, rows: rowsChecked, at: now }).catch(() => summarise(rowsChecked));
  const st = list.map(c => env.DB.prepare(`UPDATE clusters SET name = ?3, name_by = ?4, name_status = 'done', updated_at = ?5 WHERE user_id = ?1 AND id = ?2`)
    .bind(user, c.id, names.get(c.id) || c.name || codeName(c.root, c.members), names.has(c.id) ? 'claude' : 'code', now));
  if (st.length) await env.DB.batch(st);
  return { named: names.size, held: false, names, counts: auditCounts(check) };
}

/** The hourly retry: names still waiting for their batch. One read when none wait. Never throws. */
export async function clusterNamesJob(env, user, { now = Date.now(), call = null } = {}) {
  try {
    const r = await nameClusters(env, user, null, { now, call });
    if (r.named) await noteJob(env, { job: 'clusters', user, key: `names:${londonDay(now)}`, ref: 'names', state: 'ok', at: now, counts: { named: r.named, ...(r.counts || {}) },
      detail: cut([...r.names.values()].join('; '), 140) });
    return r;
  } catch (e) { return { error: (e && e.message) || String(e) }; }
}
