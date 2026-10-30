// Study Hub v2: a person's own galaxies (docs/platform/v2-plan.md 2.1). A galaxy is a named group of their topics
// ("Energy", "Mock 1"); each subject is a galaxy too. A topic sits in at most one of their galaxies and, there, leaves
// its subject's galaxy on the map only: papers, results, lessons, rings and Today still count it for its subject.
//
//   GET  /api/p/galaxies         their galaxies and the one order of galaxies and subjects
//   GET  /api/p/galaxies/:id     one galaxy with its topics, by subject
//   POST /api/p/galaxies {ops}   create, rename, add, remove, new_topics, delete, order: one change, one undo
//   GET  /api/p/topics           every live topic, with its galaxy (the app's topic picker)
//   tool galaxy_edit             the same, for their Claude
//
// Rows go through map/events.js writeBatch (tables galaxies and galaxy_topics, migration 0103), so POST /api/p/undo and
// undo_change put a whole change back, topics it made included. Any change but a rename clears their unpinned map
// positions so the map lays itself out once more (as custom.js does for a layout change). Clusters named through
// my_hub_change (custom.map.clusters, the first version of this) become galaxies the first time this is used.
import { HttpError, json, readJson, now as nowMs } from '../util.js';
import { writeBatch, rand } from '../map/events.js';
import { looksLikeStem } from '../map/guard.js';
import { norm } from '../../../public/js/shared/names.js';
import { LEARNER, requireModule } from './modules.js';
import { Plan, planTopics, parseSections, chipOf, ringOf } from './subjects.js';
import { getCustom, setCustom, applyPatch } from './custom.js';

export const LIMITS = { galaxies: 30, title: 40, ops: 10, refs: 100, names: 25 };
export const OPS = ['create', 'rename', 'add', 'remove', 'new_topics', 'delete', 'order'];
const LIVE = "('proposed','confirmed')";
const WEAK = new Set(['Weak', 'Very weak']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const st = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);

// ------------------------------------------------------------------ reading

/** Everything a change or a list needs, in one batch. */
async function readState(env, user) {
  const [g, m, s, t, a] = await env.DB.batch([
    st(env, 'SELECT id, title, sort, status, created_by, created_at, updated_at FROM galaxies WHERE user_id = ?1', user),
    st(env, 'SELECT topic_id, galaxy_id, created_by, created_at FROM galaxy_topics WHERE user_id = ?1', user),
    st(env, "SELECT id, name, subject, sort FROM subjects WHERE user_id = ?1 AND status = 'active' ORDER BY sort, id", user),
    st(env, `SELECT t.id, t.name, t.category_id AS subject_id, u.name AS section, sc.seen, sc.t, sc.band FROM topics t
      JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
      LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
      LEFT JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
      WHERE t.user_id = ?1 AND t.status IN ${LIVE} ORDER BY t.name LIMIT 3000`, user),
    st(env, `SELECT a.alias_key, a.topic_id FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ${LIVE}
      WHERE a.user_id = ?1 AND a.status = 'active'`, user),
  ]);
  const galaxies = new Map((g.results || []).map(r => [r.id, { ...r }]));
  const members = new Map((m.results || []).map(r => [r.topic_id, { ...r }]));
  const subjects = s.results || [];
  const topics = new Map((t.results || []).map(r => [r.id, r]));
  const aliases = new Map();
  for (const r of a.results || []) { if (!aliases.has(r.alias_key)) aliases.set(r.alias_key, new Set()); aliases.get(r.alias_key).add(r.topic_id); }
  return { galaxies, members, subjects, topics, aliases };
}

const activeGalaxies = S => [...S.galaxies.values()].filter(g => g.status === 'active').sort((a, b) => a.sort - b.sort || a.created_at - b.created_at);
/** The galaxy a topic is in now (active ones only), or null. */
const galaxyOf = (S, topicId) => { const m = S.members.get(topicId); const g = m && S.galaxies.get(m.galaxy_id); return g && g.status === 'active' ? g : null; };

function statsOf(S, ids) {
  let seen = 0, weak = 0;
  for (const id of ids) { const c = chipOf(S.topics.get(id)); if (c.seen) seen++; if (WEAK.has(c.band)) weak++; }
  return { n: ids.length, seen_n: seen, weak_n: weak, ring: ringOf(ids.length, seen, weak) };
}
const idsIn = (S, gid) => [...S.members.values()].filter(m => m.galaxy_id === gid && S.topics.has(m.topic_id)).map(m => m.topic_id);

/** The one order of their galaxies and subjects (galaxies.sort and subjects.sort share a space). */
function orderOf(S) {
  const items = [
    ...activeGalaxies(S).map(g => ({ kind: 'galaxy', id: g.id, title: g.title, sort: g.sort, at: g.created_at })),
    ...S.subjects.map((s, i) => ({ kind: 'subject', id: s.id, title: s.name, sort: s.sort ?? i, at: 0 })),
  ];
  return items.sort((a, b) => a.sort - b.sort || (a.kind === b.kind ? a.at - b.at : a.kind === 'subject' ? -1 : 1));
}

function listOf(S) {
  const inGalaxy = new Set([...S.members.values()].filter(m => galaxyOf(S, m.topic_id)).map(m => m.topic_id));
  const galaxies = activeGalaxies(S).map(g => ({ id: g.id, title: g.title, sort: g.sort, created_by: g.created_by, ...statsOf(S, idsIn(S, g.id)) }));
  const order = orderOf(S).map(x => x.kind === 'galaxy'
    ? { kind: 'galaxy', id: x.id, title: x.title, ...statsOf(S, idsIn(S, x.id)) }
    : { kind: 'subject', id: x.id, title: x.title, ...statsOf(S, [...S.topics.values()].filter(t => t.subject_id === x.id && !inGalaxy.has(t.id)).map(t => t.id)) });
  return { galaxies, order };
}

// ------------------------------------------------------------------ the map's view of them (platform/map.js)

/** {galaxies: [{id, title, topics: [ids]}] (non-empty, in order), ranks: {groupId: n}} for regroup(). */
export async function mapSpecOf(env, user) {
  const [g, m, s] = await env.DB.batch([
    st(env, "SELECT id, title, sort, created_at FROM galaxies WHERE user_id = ?1 AND status = 'active'", user),
    st(env, 'SELECT topic_id, galaxy_id FROM galaxy_topics WHERE user_id = ?1', user),
    st(env, "SELECT id, sort FROM subjects WHERE user_id = ?1 AND status = 'active'", user),
  ]);
  const gal = g.results || [];
  if (!gal.length) return null;
  const by = new Map(gal.map(x => [x.id, []]));
  for (const r of m.results || []) if (by.has(r.galaxy_id)) by.get(r.galaxy_id).push(r.topic_id);
  const S = { galaxies: new Map(gal.map(x => [x.id, { ...x, status: 'active' }])), subjects: s.results || [] };
  const ranks = {};
  orderOf(S).forEach((x, i) => { ranks[x.kind === 'galaxy' ? `mine~${x.id}` : x.id] = i; });
  return { galaxies: activeGalaxies(S).filter(x => by.get(x.id).length).map(x => ({ id: x.id, title: x.title, topics: by.get(x.id).sort() })), ranks };
}

/** Their galaxies for Today: [{id, title, n, weak_n, ring}], at most 8, in their order. */
export async function todayGalaxies(env, user) {
  const S = await readState(env, user);
  return listOf(S).galaxies.slice(0, 8).map(g => ({ id: g.id, title: g.title, n: g.n, weak_n: g.weak_n, ring: g.ring }));
}

/** The galaxy a topic is in, for the topic sheet and topic_detail: {id, title} or null. */
export async function galaxyOfTopic(env, user, topicId) {
  return st(env, `SELECT g.id, g.title FROM galaxy_topics m JOIN galaxies g ON g.user_id = m.user_id AND g.id = m.galaxy_id AND g.status = 'active'
    WHERE m.user_id = ?1 AND m.topic_id = ?2`, user, topicId).first();
}

// ------------------------------------------------------------------ the first version: clusters in Make it mine

/** Clusters named through my_hub_change become galaxies (once); the map looks the same afterwards. */
export async function adoptLegacy(env, user) {
  const custom = await getCustom(env, user).catch(() => null);
  const m = custom && custom.map;
  if (!m || !(Array.isArray(m.clusters) && m.clusters.length)) return false;
  const ops = [];
  for (const cl of m.clusters) ops.push({ op: 'create', title: cl.title, topics: cl.topics, _legacy: true });
  if (Array.isArray(m.order) && m.order.length) ops.push({ op: 'order', order: m.order });
  await editGalaxies(env, user, ops, { actor: 'code', surface: null, via: 'platform:galaxies-adopt', undoable: false, adopting: true });
  const next = applyPatch(custom, { map: { clusters: null, order: null, group_by: m.group_by === 'subject' ? 'subject' : null } });
  await setCustom(env, user, next, 'code');
  return true;
}

// ------------------------------------------------------------------ changing them

function titleOf(raw, S, { except = null } = {}) {
  const title = oneLine(raw, 200);
  if (!title) throw new HttpError(400, 'A galaxy needs a name.');
  if (title.length > LIMITS.title) throw new HttpError(400, `A galaxy's name is ${LIMITS.title} characters at most.`);
  if (looksLikeStem(title)) throw new HttpError(400, 'That reads like an exam question. Give the galaxy a short name, like "Energy" or "Mock 1".');
  const key = norm(title) || title.toLowerCase();
  if (S.subjects.some(s => (norm(s.name) || s.name.toLowerCase()) === key)) throw new HttpError(400, `${title} is one of your subjects already. Pick another name.`);
  if (activeGalaxies(S).some(g => g.id !== except && (norm(g.title) || g.title.toLowerCase()) === key)) throw new HttpError(400, `You already have a galaxy called ${title}.`);
  return title;
}

function findGalaxy(S, ref) {
  const want = oneLine(ref, 200);
  if (!want) throw new HttpError(400, 'Say which galaxy, by name.');
  const live = activeGalaxies(S);
  const hit = live.find(g => g.id === want) || live.find(g => (norm(g.title) || g.title.toLowerCase()) === (norm(want) || want.toLowerCase()));
  if (!hit) throw new HttpError(404, `There is no galaxy called ${want.slice(0, 60)}.${live.length ? ` Your galaxies: ${live.map(g => g.title).join(', ')}.` : ' You have no galaxies of your own yet.'}`);
  return hit;
}

function findSubjectIn(S, ref) {
  const want = oneLine(ref, 120);
  const hit = S.subjects.find(s => s.id === want) || S.subjects.find(s => norm(s.name) === norm(want)) || S.subjects.find(s => s.subject === want.toLowerCase().replace(/\s+/g, '_'));
  if (!hit) throw new HttpError(404, `You have no subject called ${want.slice(0, 60)}. Your subjects: ${S.subjects.map(s => s.name).join(', ') || 'none yet'}.`);
  return hit;
}

/** Topics by id or name: {ids, not_found, ambiguous}. */
function resolveTopics(S, refs) {
  if (!Array.isArray(refs) || !refs.length) throw new HttpError(400, 'Say which topics, by name or id.');
  if (refs.length > LIMITS.refs) throw new HttpError(400, `At most ${LIMITS.refs} topics in one step.`);
  const ids = [], not_found = [], ambiguous = [];
  for (const raw of refs) {
    const want = oneLine(raw, 200);
    if (!want) continue;
    if (S.topics.has(want)) { ids.push(want); continue; }
    const hits = [...(S.aliases.get(norm(want)) || [])].filter(id => S.topics.has(id));
    if (!hits.length) not_found.push(want.slice(0, 80));
    else if (hits.length > 1) {
      const names = new Map(S.subjects.map(s => [s.id, s.name]));
      ambiguous.push({ asked: want.slice(0, 80), candidates: hits.slice(0, 6).map(id => ({ id, name: S.topics.get(id).name, subject: names.get(S.topics.get(id).subject_id) })) });
    } else ids.push(hits[0]);
  }
  return { ids: [...new Set(ids)], not_found, ambiguous };
}

/**
 * ops run in order as ONE writeBatch. Returns {ok, batch_id, changed, created, not_found, ambiguous, galaxies, order}.
 * Op shapes: create {title, topics?, at?: 'start'}, rename {galaxy, title}, add {galaxy, topics}, remove {topics,
 * galaxy?}, new_topics {galaxy, subject, section?, names}, delete {galaxy}, order {order: [galaxy or subject names]}.
 */
export async function editGalaxies(env, user, ops, { actor = LEARNER, surface = 'web', via = 'platform:galaxies', undoable = true, adopting = false } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new HttpError(400, 'Say what to change.');
  if (ops.length > LIMITS.ops) throw new HttpError(400, `At most ${LIMITS.ops} steps in one change.`);
  if (!adopting) await adoptLegacy(env, user);
  const S = await readState(env, user);
  const plan = new Plan();
  const t = nowMs();
  const by = actor === 'claude' ? 'claude' : actor === 'code' ? 'code' : LEARNER;
  const changed = [], not_found = [], ambiguous = [];
  let created = null, relayout = false;
  const newSubjects = new Set();
  const maxSort = () => Math.max(-1, ...S.subjects.map(s => s.sort ?? 0), ...[...S.galaxies.values()].map(g => g.sort));
  const minSort = () => Math.min(0, ...S.subjects.map(s => s.sort ?? 0), ...activeGalaxies(S).map(g => g.sort));

  const moveIn = (g, ids) => {
    const moved = [];
    for (const id of ids) {
      const cur = S.members.get(id);
      if (cur && cur.galaxy_id === g.id) continue;
      if (cur) {
        plan.add({ table: 'galaxy_topics', op: 'update', key: { topic_id: id }, before: { galaxy_id: cur.galaxy_id, created_by: cur.created_by, created_at: cur.created_at }, after: { galaxy_id: g.id, created_by: by, created_at: t } },
          { kind: 'galaxy.updated', target_type: 'galaxy_topics', target_id: id, topic_id: id, summary: `${(S.topics.get(id) || { name: id }).name} moved into ${g.title}` });
      } else {
        plan.add({ table: 'galaxy_topics', op: 'insert', key: { topic_id: id }, before: null, after: { galaxy_id: g.id, created_by: by, created_at: t } },
          { kind: 'galaxy.updated', target_type: 'galaxy_topics', target_id: id, topic_id: id, summary: `${(S.topics.get(id) || { name: id }).name} put in ${g.title}` });
      }
      S.members.set(id, { topic_id: id, galaxy_id: g.id, created_by: by, created_at: t });
      moved.push(id);
    }
    return moved;
  };
  const named = ids => ids.map(id => (S.topics.get(id) || { name: id }).name);
  const say = (verb, ids, where) => (ids.length ? `${verb} ${ids.length > 3 ? `${ids.length} topics` : named(ids).join(', ')} ${where}` : null);

  for (const raw of ops) {
    if (!isObj(raw)) throw new HttpError(400, 'Each step needs an op.');
    const op = raw.op;
    if (!OPS.includes(op)) throw new HttpError(400, `op is one of: ${OPS.join(', ')}.`);
    if (op === 'create') {
      if (activeGalaxies(S).length >= LIMITS.galaxies) throw new HttpError(400, `You can have ${LIMITS.galaxies} galaxies. Delete one first.`);
      let title;
      try { title = titleOf(raw.title, S); } catch (e) { if (raw._legacy && /already have a galaxy/.test(e.message)) continue; throw e; }
      const id = `g_${rand().slice(0, 12)}`;
      const sort = raw.at === 'start' ? minSort() - 1 : maxSort() + 1;
      const g = { id, title, sort, status: 'active', created_by: by, created_at: t, updated_at: t };
      plan.add({ table: 'galaxies', op: 'insert', key: { id }, before: null, after: { title, sort, status: 'active', created_by: by, created_at: t, updated_at: t } },
        { kind: 'galaxy.added', target_type: 'galaxies', target_id: id, summary: `New galaxy ${title}` });
      S.galaxies.set(id, g);
      created = created || { id, title };
      changed.push(`made ${title}`);
      relayout = true;
      if (Array.isArray(raw.topics) && raw.topics.length) {
        const r = resolveTopics(S, raw.topics);
        not_found.push(...r.not_found); ambiguous.push(...r.ambiguous);
        const moved = moveIn(g, r.ids);
        if (moved.length) changed.push(say('put', moved, `in ${title}`));
      }
    } else if (op === 'rename') {
      const g = findGalaxy(S, raw.galaxy);
      const title = titleOf(raw.title, S, { except: g.id });
      if (title === g.title) continue;
      plan.add({ table: 'galaxies', op: 'update', key: { id: g.id }, before: { title: g.title, updated_at: g.updated_at }, after: { title, updated_at: t } },
        { kind: 'galaxy.updated', target_type: 'galaxies', target_id: g.id, summary: `${g.title} renamed ${title}` });
      changed.push(`renamed ${g.title} to ${title}`);
      g.title = title;
    } else if (op === 'add') {
      const g = findGalaxy(S, raw.galaxy);
      const r = resolveTopics(S, raw.topics);
      not_found.push(...r.not_found); ambiguous.push(...r.ambiguous);
      const moved = moveIn(g, r.ids);
      if (moved.length) { changed.push(say('moved', moved, `into ${g.title}`)); relayout = true; }
    } else if (op === 'remove') {
      const only = raw.galaxy ? findGalaxy(S, raw.galaxy) : null;
      const r = resolveTopics(S, raw.topics);
      not_found.push(...r.not_found); ambiguous.push(...r.ambiguous);
      const out = [];
      for (const id of r.ids) {
        const cur = S.members.get(id);
        if (!cur || (only && cur.galaxy_id !== only.id)) continue;
        const subj = S.subjects.find(s => s.id === (S.topics.get(id) || {}).subject_id);
        plan.add({ table: 'galaxy_topics', op: 'delete', key: { topic_id: id }, before: { galaxy_id: cur.galaxy_id, created_by: cur.created_by, created_at: cur.created_at }, after: null },
          { kind: 'galaxy.updated', target_type: 'galaxy_topics', target_id: id, topic_id: id, summary: `${(S.topics.get(id) || { name: id }).name} back in ${subj ? subj.name : 'its subject'}` });
        S.members.delete(id);
        out.push(id);
      }
      if (out.length) { changed.push(say('took', out, out.length === 1 ? 'back to its subject' : 'back to their subjects')); relayout = true; }
    } else if (op === 'new_topics') {
      const g = findGalaxy(S, raw.galaxy);
      const subj = findSubjectIn(S, raw.subject);
      if (newSubjects.has(subj.id)) throw new HttpError(400, `Put all the new ${subj.name} topics in one new_topics step.`);
      newSubjects.add(subj.id);
      const names = Array.isArray(raw.names) ? raw.names : [];
      if (!names.length || names.length > LIMITS.names) throw new HttpError(400, `Give 1 to ${LIMITS.names} new topic names.`);
      const sections = parseSections([{ name: oneLine(raw.section, 80) || 'Other', topics: names }]);
      const p = await planTopics(env, user, subj.id, sections, { actor: by === 'code' ? LEARNER : by, plan });
      const ids = [...new Set(sections[0].topics.map(n => p.ids.get(norm(n))).filter(Boolean))];
      for (const sec of sections) for (const n of sec.topics) { const id = p.ids.get(norm(n)); if (id && !S.topics.has(id)) S.topics.set(id, { id, name: n, subject_id: subj.id, section: sec.name, seen: 0 }); }
      const moved = moveIn(g, ids);
      if (p.added) changed.push(`added ${p.added} new ${subj.name} topic${p.added === 1 ? '' : 's'}`);
      if (moved.length) changed.push(say('put', moved, `in ${g.title}`));
      relayout = true;
    } else if (op === 'delete') {
      const g = findGalaxy(S, raw.galaxy);
      plan.add({ table: 'galaxies', op: 'update', key: { id: g.id }, before: { status: 'active', updated_at: g.updated_at }, after: { status: 'deleted', updated_at: t } },
        { kind: 'galaxy.removed', target_type: 'galaxies', target_id: g.id, summary: `${g.title} deleted (its topics are back in their subjects)` });
      g.status = 'deleted';
      changed.push(`deleted ${g.title}`);
      relayout = true;
    } else if (op === 'order') {
      const list = Array.isArray(raw.order) ? raw.order : [];
      if (!list.length || list.length > 60) throw new HttpError(400, 'order is a list of galaxy and subject names, first to last.');
      const cur = orderOf(S);
      const pick = ref => {
        const w = oneLine(ref, 120), k = norm(w) || w.toLowerCase();
        return cur.find(x => x.id === w || (norm(x.title) || x.title.toLowerCase()) === k);
      };
      const first = [];
      for (const ref of list) { const x = pick(ref); if (x && !first.includes(x)) first.push(x); else if (!x) not_found.push(oneLine(ref, 80)); }
      const next = [...first, ...cur.filter(x => !first.includes(x))];
      let moved = false;
      next.forEach((x, i) => {
        if (x.sort === i) return;
        moved = true;
        if (x.kind === 'galaxy') {
          const g = S.galaxies.get(x.id);
          plan.add({ table: 'galaxies', op: 'update', key: { id: x.id }, before: { sort: g.sort }, after: { sort: i } },
            { kind: 'galaxy.updated', target_type: 'galaxies', target_id: x.id, summary: `${g.title} now ${i + 1}${i === 0 ? 'st' : ''} in the order` });
          g.sort = i;
        } else {
          const s = S.subjects.find(y => y.id === x.id);
          plan.add({ table: 'subjects', op: 'update', key: { id: x.id }, before: { sort: s.sort }, after: { sort: i } },
            { kind: 'galaxy.updated', target_type: 'subjects', target_id: x.id, summary: `${s.name} now ${i + 1}${i === 0 ? 'st' : ''} in the order` });
          s.sort = i;
        }
      });
      if (moved) { changed.push(`order: ${next.slice(0, 6).map(x => x.title).join(', ')}${next.length > 6 ? '…' : ''}`); relayout = true; }
    }
  }
  const out = { ok: true, batch_id: null, changed: changed.filter(Boolean).join('; ') || 'no change', created, not_found, ambiguous, ...listOf(S) };
  if (!plan.rows.length) return out;
  const statements = relayout ? [st(env, 'DELETE FROM topic_positions WHERE user_id = ?1 AND pinned = 0', user)] : [];
  const w = await writeBatch(env, user, { actor, surface, via, rows: plan.rows, events: plan.events, statements, undoable });
  return { ...out, batch_id: w.batch_id };
}

// ------------------------------------------------------------------ routes

const gate = fn => async (request, env, ctx, params, url, user, session) => { requireModule(session, 'map', env); return fn(request, env, ctx, params, url, user, session); };

async function listRoute(request, env, ctx, params, url, user) {
  await adoptLegacy(env, user);
  const S = await readState(env, user);
  const custom = await getCustom(env, user).catch(() => null);
  return json({ ...listOf(S), layout: custom && custom.map && custom.map.group_by === 'subject' ? 'subject' : 'section', max: LIMITS.galaxies });
}

async function oneRoute(request, env, ctx, params, url, user) {
  await adoptLegacy(env, user);
  const S = await readState(env, user);
  const g = S.galaxies.get(params.id);
  if (!g || g.status !== 'active') throw new HttpError(404, 'There is no such galaxy.');
  const ids = idsIn(S, g.id);
  const subjects = S.subjects.map(s => ({ id: s.id, name: s.name, topics: ids.map(id => S.topics.get(id)).filter(x => x.subject_id === s.id)
    .map(x => ({ ...chipOf(x), subject_id: x.subject_id, section: x.section ?? null })) })).filter(s => s.topics.length);
  return json({ galaxy: { id: g.id, title: g.title, created_by: g.created_by, created_at: g.created_at, ...statsOf(S, ids) }, subjects });
}

async function editRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 50_000);
  const r = await editGalaxies(env, user, body.ops);
  return json(r, r.created ? 201 : 200);
}

async function topicsRoute(request, env, ctx, params, url, user) {
  const S = await readState(env, user);
  const names = new Map(S.subjects.map(s => [s.id, s.name]));
  return json({ topics: [...S.topics.values()].map(t => {
    const g = galaxyOf(S, t.id);
    return { ...chipOf(t), subject_id: t.subject_id, subject_name: names.get(t.subject_id) || null, section: t.section ?? null, galaxy: g ? { id: g.id, title: g.title } : null };
  }) });
}

export const ROUTES = [
  ['GET', '/api/p/galaxies', gate(listRoute)],
  ['GET', '/api/p/galaxies/:id', gate(oneRoute)],
  ['POST', '/api/p/galaxies', gate(editRoute)],
  ['GET', '/api/p/topics', gate(topicsRoute)],
];

// ------------------------------------------------------------------ the tool

export const TOOLS = [{
  name: 'galaxy_edit',
  module: 'map',
  description: 'The student\'s own galaxies: named groups of topics on their map ("Energy", "Mock 1"). Each subject is a galaxy too. A topic in one of their galaxies leaves its subject\'s galaxy on the map, but stays in its subject for papers, results and lessons. '
    + 'With no ops: lists them. ops run in order as ONE change they can undo (undo_change with batch_id): create {title, topics?}, rename {galaxy, title}, add {galaxy, topics} (moves them), remove {topics} (back to their subject), '
    + 'new_topics {galaxy, subject, section?, names} (new topics made there), delete {galaxy} (topics go back), order {order: galaxy or subject names, first to last}. topics are names or ids; ambiguous names come back to ask.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    ops: { type: 'array', maxItems: LIMITS.ops, items: { type: 'object', additionalProperties: false, required: ['op'], properties: {
      op: { type: 'string', enum: OPS }, galaxy: { type: 'string' }, title: { type: 'string', maxLength: LIMITS.title },
      topics: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.refs }, subject: { type: 'string' }, section: { type: 'string' },
      names: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.names }, order: { type: 'array', items: { type: 'string' } } } } } } },
  annotations: { readOnlyHint: false, destructiveHint: false },
  async run(env, user, args) {
    const shape = (r, S) => ({ galaxies: r.galaxies.map(g => ({ title: g.title, n: g.n, weak: g.weak_n,
      topics: idsIn(S, g.id).slice(0, 40).map(id => ({ name: S.topics.get(id).name, band: chipOf(S.topics.get(id)).band || 'not seen' })) })),
      order: r.order.map(x => x.title) });
    if (!Array.isArray(args.ops) || !args.ops.length) {
      await adoptLegacy(env, user);
      const S = await readState(env, user);
      return { ...shape(listOf(S), S), note: 'Their galaxies first, then the whole order (galaxies and subjects).' };
    }
    const r = await editGalaxies(env, user, args.ops, { actor: 'claude', surface: 'chat', via: 'platform:galaxy_edit' });
    const S = await readState(env, user);
    return { changed: r.changed, batch_id: r.batch_id, ...(r.not_found.length ? { not_found: r.not_found } : {}), ...(r.ambiguous.length ? { ambiguous: r.ambiguous } : {}),
      ...shape(r, S), ...(r.batch_id ? { undo: 'undo_change with this batch_id puts it all back.' } : {}) };
  },
}];
