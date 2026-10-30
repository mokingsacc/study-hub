import { json, readJson } from '../util.js';
import { norm } from '../../../public/js/shared/names.js';
import { fetchAliases, plan, decide, hintSystems, queueItem, ACCEPT } from './resolve.js';
import { labelAliasProblem, innerSpans } from './topics.js';
import { rawKey } from './ingest/map-fields.js';

const MAX_ALIASES = 200, MAX_MISSES = 400;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const uniq = list => [...new Set(list)];
const textsOf = m => uniq([m.condition_raw, m.topic_raw].filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()));

/** Every alias taught by a queue label (key and topic as the item was resolved), with its topic's name. */
async function learnedAliases(env, user) {
  return (await env.DB.prepare(`SELECT DISTINCT a.alias_key, a.topic_id, a.alias, a.kind, t.name AS topic_name, q.id AS queue_id
      FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ('proposed','confirmed')
      JOIN topic_queue q ON q.user_id = a.user_id AND q.label_norm = a.alias_key AND q.resolved_topic_id = a.topic_id AND q.kind IN ('label','lookalike')
      WHERE a.user_id = ? AND a.status = 'active' AND a.kind NOT IN ('name','abbrev','merge') AND a.alias_key != lower(t.name)
      ORDER BY a.topic_id, a.alias_key LIMIT ${MAX_ALIASES}`).bind(user).all()).results || [];
}

/**
 * What the clean-up would do, read only: {aliases: [{alias, topic_id, topic_name, why, key}], moves: [{miss, label,
 * from, to, to_name}], queued: [{miss, label, from, queue_id, reopen}], kept: [{miss, label, topic_id, by}],
 * rows, events, evidence, touched_topics} (rows and events ready for applyChange).
 */
export async function readCleanup(env, user, now = Date.now()) {
  const learned = await learnedAliases(env, user);
  const spanData = await fetchAliases(env, user, uniq(learned.flatMap(a => innerSpans(a.alias_key))));
  const bad = [];
  for (const a of learned) {
    const why = labelAliasProblem(spanData.byKey, a.alias, a.alias_key, a.topic_id);
    if (why) bad.push({ ...a, why });
  }
  const out = { aliases: bad.map(a => ({ alias: a.alias, key: a.alias_key, topic_id: a.topic_id, topic_name: a.topic_name, why: a.why })), moves: [], queued: [], kept: [],
    rows: [], events: [], evidence: { repoint: [], upsert: [] }, touched_topics: new Set() };
  if (!bad.length) return out;
  const badPair = new Set(bad.map(a => `${a.alias_key}|${a.topic_id}`));
  const badTopics = uniq(bad.map(a => a.topic_id));
  for (const a of bad) {
    out.rows.push({ table: 'topic_aliases', op: 'update', key: { alias_key: a.alias_key, topic_id: a.topic_id }, before: { status: 'active' }, after: { status: 'removed' } });
    out.events.push({ kind: 'alias.removed', target_type: 'alias', target_id: `${a.alias_key}|${a.topic_id}`, topic_id: a.topic_id,
      summary: `"${a.alias}" no longer names ${a.topic_name}: it reads as a description`.slice(0, 160) });
    out.touched_topics.add(a.topic_id);
  }

  // The misses on those topics, and how their own words decide with and without the removed names.
  const misses = (await env.DB.prepare(`SELECT id, label, topic_id, category_id, match_status, match_method, label_norm, condition_raw, topic_raw, system_raw, queue_id
      FROM misses WHERE user_id = ? AND topic_id IN (SELECT value FROM json_each(?)) AND held = 0 AND deleted_at IS NULL LIMIT ${MAX_MISSES}`)
    .bind(user, JSON.stringify(badTopics)).all()).results || [];
  const plans = new Map(misses.map(m => [m.id, plan(textsOf(m))]));
  const all = [...plans.values()];
  const data = await fetchAliases(env, user, uniq(all.flatMap(p => p.keys)), uniq(all.flatMap(p => p.cutKeys)));
  const without = { byKey: new Map([...data.byKey].map(([k, hits]) => [k, hits.filter(h => !badPair.has(`${k}|${h.id}`))])),
    prefix: new Map([...data.prefix].map(([k, hits]) => [k, hits.filter(h => !badPair.has(`${h.key}|${h.id}`))])) };
  const badKeysOf = new Map();
  for (const a of bad) { if (!badKeysOf.has(a.topic_id)) badKeysOf.set(a.topic_id, new Set()); badKeysOf.get(a.topic_id).add(a.alias_key); }

  const through = [];
  for (const m of misses) {
    const keys = badKeysOf.get(m.topic_id) || new Set();
    const p = plans.get(m.id);
    const hint = hintSystems(null, m.system_raw || null);
    const withAll = textsOf(m).length ? decide(p, data, hint) : { topic_id: null };
    const named = [m.label_norm, ...textsOf(m).map(norm)].some(k => k && keys.has(k));
    const came = named || (withAll.topic_id === m.topic_id && (decide(p, without, hint).topic_id || null) !== m.topic_id);
    if (!came) continue;
    if (!['alias', 'label'].includes(m.match_method)) { out.kept.push({ miss: m.id, label: m.label, topic_id: m.topic_id, by: m.match_method || 'unknown' }); continue; }
    through.push({ m, d: textsOf(m).length ? decide(p, without, hint) : { topic_id: null } });
  }

  // Misses that wait in the queue: their label item is reopened when it exists, made when it does not.
  const items = through.filter(x => !(x.d.topic_id && x.d.confidence >= ACCEPT && x.d.topic_id !== x.m.topic_id))
    .map(x => ({ x, q: textsOf(x.m).length ? queueItem(user, { texts: textsOf(x.m), source: 'alias_cleanup', system: x.m.system_raw || null }) : null }));
  const qids = uniq(items.map(i => i.q && i.q.id).filter(Boolean));
  const have = new Map(qids.length ? ((await env.DB.prepare(`SELECT id, status, resolved_topic_id, resolved_by FROM topic_queue WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(qids)).all()).results || []).map(r => [r.id, r]) : []);
  const evRows = items.length ? (await env.DB.prepare(`SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND miss_id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(items.map(i => i.x.m.id))).all()).results || [] : [];
  const topicName = new Map(bad.map(a => [a.topic_id, a.topic_name]));
  const name = id => topicName.get(id) || id;
  const opened = new Set();

  for (const { m, d } of through) {
    if (!(d.topic_id && d.confidence >= ACCEPT && d.topic_id !== m.topic_id)) continue;
    // A confident other topic: the miss moves there, as a queue placement that unplace (undo) sends back (B4-3 shape).
    out.rows.push({ table: 'misses', op: 'update', key: { id: m.id },
      before: { topic_id: m.topic_id, category_id: m.category_id, match_status: m.match_status, match_method: m.match_method, label_norm: m.label_norm },
      after: { topic_id: d.topic_id, category_id: d.category_id || m.category_id, match_status: 'matched', match_method: 'alias', label_norm: m.label_norm } });
    out.events.push({ kind: 'queue.resolved', target_type: 'miss', target_id: m.id, topic_id: d.topic_id, summary: `${m.label} moved to ${d.name || d.topic_id}`.slice(0, 160) });
    out.evidence.repoint.push({ obs_keys: [rawKey(user, m.id)], slot: 0, to_topic: d.topic_id });
    out.touched_topics.add(d.topic_id);
    out.moves.push({ miss: m.id, label: m.label, from: m.topic_id, to: d.topic_id, to_name: d.name || null });
  }
  for (const { x: { m }, q } of items) {
    const qid = q ? q.id : null;
    if (qid && !opened.has(qid)) {
      opened.add(qid);
      const cur = have.get(qid);
      if (cur && cur.status !== 'open') {
        out.rows.push({ table: 'topic_queue', op: 'update', key: { id: qid }, before: { status: cur.status, resolved_topic_id: cur.resolved_topic_id ?? null, resolved_by: cur.resolved_by ?? null },
          after: { status: 'open', resolved_topic_id: null, resolved_by: null } });
        out.events.push({ kind: 'topic.updated', target_type: 'queue', target_id: qid, topic_id: m.topic_id, summary: `Reopened for placing: ${q.label_raw}`.slice(0, 160) });
      } else if (!cur) {
        out.rows.push({ table: 'topic_queue', op: 'insert', key: { id: qid }, before: null,
          after: { kind: q.kind, label_norm: q.label_norm, label_raw: q.label_raw, context_json: JSON.stringify(q.context || {}), candidates_json: JSON.stringify(q.candidates || []),
            refs: 1, first_seen_at: now, last_seen_at: now, status: 'open' } });
        out.events.push({ kind: 'topic.updated', target_type: 'queue', target_id: qid, topic_id: null, summary: `Waiting to be placed: ${q.label_raw}`.slice(0, 160) });
      }
    }
    // The miss leaves the topic and waits on its item; undo (undoRetiredRow) puts it and its evidence back.
    out.rows.push({ table: 'misses', op: 'update', key: { id: m.id }, before: { topic_id: m.topic_id, match_status: m.match_status, match_method: m.match_method, queue_id: m.queue_id ?? null },
      after: { topic_id: null, match_status: qid ? 'queued' : 'open', match_method: null, queue_id: qid } });
    out.events.push({ kind: 'miss.placed', target_type: 'retired_miss', target_id: m.id, topic_id: m.topic_id, summary: `${m.label} leaves ${name(m.topic_id)} for the queue`.slice(0, 160) });
    // Its answer's evidence leaves the topic and waits on the same item, so placing the item moves it too (placeRows'
    // repoint by queue_id). Only the key and the two moved columns are written: code's own marks stay as they are.
    for (const r of evRows.filter(e => e.miss_id === m.id && e.topic_id === m.topic_id)) {
      out.evidence.upsert.push({ obs_key: r.obs_key, slot: 0, kind: r.kind, at: r.at, day: r.day, source: r.source, topic_id: null, queue_id: qid });
    }
    out.queued.push({ miss: m.id, label: m.label, from: m.topic_id, queue_id: qid, reopen: !!(qid && have.has(qid)) });
  }
  return out;
}

/** Planner for alias.cleanup (code only): the rows readCleanup builds, as one undoable change. */
export async function planAliasCleanup(env, user, args, ctx) {
  let r;
  try { r = await readCleanup(env, user, ctx.now); } catch (e) { if (noTable(e)) return { noop: true, summary: 'The map is not set up yet.' }; throw e; }
  if (!r.rows.length) return { noop: true, summary: 'No learned label names to remove.' };
  const ev = r.evidence.repoint.length || r.evidence.upsert.length ? r.evidence : null;
  return { rows: r.rows, events: r.events, evidence: ev, touched_topics: [...r.touched_topics], count: r.rows.length,
    summary: `Removed ${r.aliases.length} name${r.aliases.length === 1 ? '' : 's'} learned from labels; ${r.moves.length} moved, ${r.queued.length} back in the queue`,
    reply: report(r) };
}

const report = r => ({ aliases: r.aliases, moves: r.moves, queued: r.queued, kept_for_review: r.kept });

/** POST /api/map/alias-cleanup {apply?}: the dry run by default; apply: true makes the change (as code). */
export async function aliasCleanupRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  const apply = !!(body && body.apply === true);
  if (!apply) {
    let r;
    try { r = await readCleanup(env, user); } catch (e) { if (noTable(e)) return json({ dry_run: true, nothing_to_do: true }); throw e; }
    return json({ dry_run: true, nothing_to_do: !r.rows.length, ...report(r) });
  }
  const { applyChange, changeResponse } = await import('./change.js');
  const r = await applyChange(env, user, { actor: 'code', surface: 'code', op: 'alias.cleanup', args: {}, via: 'api:POST /api/map/alias-cleanup' });
  if (r.refused || r.needs_confirm) return changeResponse(r);
  return json({ dry_run: false, ...r });
}
