import { norm } from './common.js';
import { chunks } from '../map/events.js';
import { orbitsOn, dueOn } from './common.js';

/** {byName: Map(norm -> topic id), live: Map(id -> live id)} for one user. */
export async function topicIndex(env, user) {
  const [t, a] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, status, merged_into FROM topics WHERE user_id = ?").bind(user),
    env.DB.prepare("SELECT alias, alias_key, topic_id FROM topic_aliases WHERE user_id = ? AND (status IS NULL OR status = 'active')").bind(user),
  ]);
  const rows = t.results || [];
  const byId = new Map(rows.map(r => [r.id, r]));
  // a merged topic resolves to the topic it went into (at most 5 hops); a retired one to nothing
  const live = id => {
    for (let i = 0, cur = byId.get(id); cur && i < 5; i++) {
      if (cur.status === 'merged' && cur.merged_into) { cur = byId.get(cur.merged_into); continue; }
      return cur.status === 'retired' ? null : cur.id;
    }
    return null;
  };
  const byName = new Map();
  for (const r of rows) { const id = live(r.id); if (id && !byName.has(norm(r.name))) byName.set(norm(r.name), id); }
  for (const r of a.results || []) {
    const id = live(r.topic_id);
    if (!id) continue;
    for (const k of [norm(r.alias || ''), norm(r.alias_key || '')]) if (k && !byName.has(k)) byName.set(k, id);
  }
  return { byName, live };
}

export const placeName = (idx, name) => idx.byName.get(norm(name)) || null;

/**
 * Re-place links: every link whose topic is missing, merged or retired is looked up again by its to_name, and every
 * item by its name. Writes only topic_id (and updated_at); never status. Returns {placed, unplaced, changed}.
 */
export async function replace(env, user, now = Date.now()) {
  const idx = await topicIndex(env, user);
  const [l, it] = await env.DB.batch([
    env.DB.prepare('SELECT id, topic_id, to_name FROM orbit_links WHERE user_id = ?').bind(user),
    env.DB.prepare('SELECT id, topic_id, name FROM orbit_items WHERE user_id = ?').bind(user),
  ]);
  const linkRows = [], itemRows = [];
  let placed = 0, unplaced = 0;
  for (const r of l.results || []) {
    const want = (r.topic_id && idx.live(r.topic_id)) || placeName(idx, r.to_name);
    if (want) placed++; else unplaced++;
    if ((want || null) !== (r.topic_id || null)) linkRows.push({ user_id: user, id: r.id, topic_id: want || null, updated_at: now });
  }
  for (const r of it.results || []) {
    const want = (r.topic_id && idx.live(r.topic_id)) || placeName(idx, r.name);
    if ((want || null) !== (r.topic_id || null)) itemRows.push({ user_id: user, id: r.id, topic_id: want || null, updated_at: now });
  }
  const st = [...setTopicIds(env, 'orbit_links', user, linkRows, now), ...setTopicIds(env, 'orbit_items', user, itemRows, now)];
  if (st.length) await env.DB.batch(st);
  return { placed, unplaced, changed: linkRows.length + itemRows.length };
}

// topic_id for many rows of one table, one JSON parameter per 150 rows (an UPDATE: never half a row).
function setTopicIds(env, table, user, rows, now) {
  return chunks(rows).map(part => env.DB.prepare(`UPDATE ${table} SET updated_at = ?2,
      topic_id = (SELECT json_extract(j.value, '$.topic_id') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = ${table}.id)
    WHERE user_id = ?3 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`).bind(JSON.stringify(part.map(r => ({ id: r.id, topic_id: r.topic_id }))), now, user));
}

/** sync.js 'orbits.daily', in the 04:xx hour only: the due reconcile (04:10 in the design), then the re-place (04:20). */
export async function dailyJob(env, user) {
  const out = {};
  if ((dueOn(env) || env.DUE_ORBS === 'sync') && env.ANKI_MCP_URL) out.reconcile = await (await import('./due.js')).reconcile(env, user).catch(e => ({ error: e.message }));
  if (orbitsOn(env)) out.replace = await replace(env, user).catch(e => ({ error: e.message }));
  return out;
}
