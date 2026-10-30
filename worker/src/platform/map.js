import { HttpError } from '../util.js';
import { MO, prefsStatement } from '../users.js';
import { safeParse } from '../util.js';
import { mapRoute } from '../map/payload.js';
import { putPositionsRoute } from '../map/positions.js';
import { getCustom } from './custom.js';
import { mapSpecOf } from './galaxies.js';
import { norm } from '../../../public/js/shared/names.js';
import { requireModule, sessionModules } from './modules.js';
import { countsOf } from '../mnemonics/store.js';

function mine(user, session, env) {
  if (!user || user === MO || !session || session.user !== user) throw new HttpError(401, 'Please sign in again.');
  requireModule(session, 'map', env);
}

// ------------------------------------------------------------------ their own layout (Make it mine: custom.map)

// Topic tuple fields (payload.js numberBody): [i, id, name, short, cat, unit, x, y, yield100, t1000, cert, band, ...];
// category tuple: [i, id, name, short, t1000, coverage%, n_weak, n_unseen, n_topics]; unit: [i, id, name, cat, lane, rank].
const T = { CAT: 4, UNIT: 5, T1000: 9, BAND: 11 };
const WEAK_BANDS = new Set([3, 4]);   // Weak, Very weak (5 = not seen yet)

function summary(topics) {
  const seen = topics.filter(t => t[T.T1000] != null);
  const weak = topics.filter(t => WEAK_BANDS.has(t[T.BAND])).length;
  const t1000 = seen.length ? Math.round(seen.reduce((a, t) => a + Number(t[T.T1000]), 0) / seen.length) : null;
  return { t1000, coverage: topics.length ? Math.round(100 * (seen.length - weak) / topics.length) : 0, weak, unseen: topics.length - seen.length, n: topics.length };
}

/**
 * The person's own grouping of their map (pure): 'subject' as built, 'section' with every section its own cluster,
 * or 'custom' with the clusters they named (topics matched by id or name; the rest stay in their subject). order
 * puts named clusters or subjects first. Returns a new payload with categories, units and topics renumbered.
 */
export function regroup(p, spec) {
  if (!spec || !p || !Array.isArray(p.topics) || !Array.isArray(p.categories)) return p;
  const group = spec.group_by || (spec.clusters && spec.clusters.length ? 'custom' : 'subject');
  const galaxies = Array.isArray(spec.galaxies) ? spec.galaxies : [];
  if (group === 'subject' && !(spec.order || []).length && !galaxies.length && !spec.ranks) return p;
  const cats = p.categories, units = p.units || [];
  const groups = [];   // {id, name, short, topics: [tuple], unitOf: Map(oldUnit -> newUnit) | null}
  const byKey = new Map();
  const groupFor = (id, name, short, keepUnits, meta = {}) => {
    if (!byKey.has(id)) { const g = { id, name, short, topics: [], keepUnits, ...meta }; byKey.set(id, g); groups.push(g); }
    return byKey.get(id);
  };
  const subjectGroup = ci => { const c = cats[ci]; return c ? groupFor(c[1], c[2], c[3], true, { kind: 'subject', ref: c[1] }) : groupFor('other', 'Other', 'Other', false, { kind: 'subject', ref: null }); };
  // Their own galaxies (galaxies.js) come first: a topic in one is drawn there, out of its subject's galaxy.
  const inGalaxy = new Map();
  for (const gx of galaxies) for (const id of gx.topics || []) inGalaxy.set(id, gx);
  let custom = null;
  if (group === 'custom') {
    custom = (spec.clusters || []).map(cl => ({ g: groupFor(`mine~${norm(cl.title) || cl.title}`, cl.title, cl.title, false, { kind: 'cluster', ref: cl.title }), keys: new Set(cl.topics.map(x => norm(x))), ids: new Set(cl.topics) }));
  }
  const home = {};
  for (const t of p.topics) {
    let g = null;
    const gx = inGalaxy.get(t[1]);
    if (gx) g = groupFor(`mine~${gx.id}`, gx.title, gx.title, false, { kind: 'galaxy', ref: gx.id });
    if (!g && custom) { const hit = custom.find(c => c.ids.has(t[1]) || c.keys.has(norm(t[2]))); if (hit) g = hit.g; }
    if (!g && group === 'section' && t[T.UNIT] != null && units[t[T.UNIT]]) {
      const u = units[t[T.UNIT]], c = cats[u[3]];
      g = groupFor(`${c ? c[1] : 'x'}~${u[1]}`, c ? `${c[3] || c[2]}: ${u[2]}` : u[2], u[2], false, { kind: 'section', ref: u[1], parent: c ? c[1] : null });
    }
    if (!g) g = subjectGroup(t[T.CAT]);
    if (g.kind === 'galaxy' || g.kind === 'cluster') { const c = cats[t[T.CAT]]; if (c) home[t[1]] = [c[1], c[2]]; }
    g.topics.push(t);
  }
  // Order: the named ones first (by title, subject name or id), then the rest as built.
  const order = (spec.order || []).map(x => norm(x));
  // ranks (galaxies.js: their galaxies and subjects in one order): a section follows its subject's place.
  const ranks = spec.ranks || null;
  const rank = ranks
    ? g => ranks[g.id] ?? ranks[g.parent] ?? (order.findIndex(o => o === norm(g.name)) >= 0 ? -1 : 1e6)
    : g => { const k = order.findIndex(o => o === norm(g.name) || o === norm(g.short) || o === norm(g.id)); return k < 0 ? order.length : k; };
  const live = groups.filter(g => g.topics.length).map((g, k) => ({ g, k })).sort((a, b) => rank(a.g) - rank(b.g) || a.k - b.k).map(x => x.g);
  const outCats = live.map((g, i) => { const s = summary(g.topics); return [i, g.id, g.name, g.short, s.t1000, s.coverage, s.weak, s.unseen, s.n]; });
  const outUnits = [];
  const unitMap = new Map();
  const topics = [];
  live.forEach((g, i) => {
    for (const t of g.topics) {
      let u = null;
      if (g.keepUnits && t[T.UNIT] != null && units[t[T.UNIT]]) {
        if (!unitMap.has(t[T.UNIT])) { const ou = units[t[T.UNIT]]; unitMap.set(t[T.UNIT], outUnits.length); outUnits.push([outUnits.length, ou[1], ou[2], i, ou[4], ou[5]]); }
        u = unitMap.get(t[T.UNIT]);
      }
      const nt = t.slice();
      nt[T.CAT] = i;
      nt[T.UNIT] = u;
      topics.push(nt);
    }
  });
  // Topic indices stay as they were (links refer to them); only the category and unit fields change.
  topics.sort((a, b) => a[0] - b[0]);
  const outGroups = live.map(g => ({ id: g.id, kind: g.kind || 'subject', ref: g.ref ?? null, ...(g.parent ? { parent: g.parent } : {}) }));
  const subjName = new Map(cats.map(c => [c[1], c[2]]));
  const fams = new Map();
  for (const g of live) {
    const [fid, fname] = g.kind === 'galaxy' || g.kind === 'cluster' ? ['mine', 'Your galaxies'] : g.kind === 'section' ? [g.parent || 'other', subjName.get(g.parent) || 'Other'] : [g.id, g.name];
    if (!fams.has(fid)) fams.set(fid, { id: fid, name: fname, members: [] });
    fams.get(fid).members.push(g.id);
  }
  return { ...p, categories: outCats, units: outUnits, topics, groups: outGroups, home, families: [...fams.values()] };
}

const hashOf = spec => { let h = 2166136261; for (const ch of JSON.stringify(spec || null)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };

export async function getMap(request, env, ctx, params, url, user, session) {
  mine(user, session, env);
  let spec = null;
  if (!url.searchParams.has('ids')) {
    const [custom, mineSpec] = await Promise.all([getCustom(env, user).catch(() => null), mapSpecOf(env, user)]);
    const own = (custom && custom.map) || {};
    spec = { ...own, group_by: own.group_by || (own.clusters && own.clusters.length ? 'custom' : 'section'), ...(mineSpec || {}) };
    await toMapV3(env, user);
  }
  if (!spec) return mapRoute(request, env, ctx, params, url, user);
  const tag = `-l${hashOf(spec)}`;
  const inm = request.headers.get('If-None-Match') || '';
  const headers = new Headers(request.headers);
  if (inm.includes(tag)) headers.set('If-None-Match', inm.replace(tag, '')); else headers.delete('If-None-Match');
  const res = await mapRoute(new Request(request, { headers }), env, ctx, params, url, user);
  const etag = res.headers.get('ETag');
  const out = res.status === 304 ? new Response(null, res) : new Response(JSON.stringify(regroup(await res.json(), spec)), res);
  out.headers.delete('Content-Length');
  if (etag) out.headers.set('ETag', etag.replace(/"$/, `${tag}"`));
  return out;
}

async function beadsRoute(request, env, ctx, params, url, user, session) {
  mine(user, session, env);
  const mods = sessionModules(session, env), now = Date.now();
  const [c, m] = await Promise.all([
    mods.cards ? env.DB.prepare(`SELECT topic_id, COUNT(*) AS n FROM cards WHERE user_id = ?1 AND deleted_at IS NULL AND suspended = 0 AND due_at <= ?2 AND topic_id IS NOT NULL
      GROUP BY topic_id`).bind(user, now).all().then(r => r.results || []) : [],
    mods.mnemonics ? env.DB.prepare(`SELECT m.category_id,
        (SELECT due FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'fwd') AS fwd_due,
        (SELECT first_at FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'fwd') AS fwd_first,
        (SELECT due FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'rev') AS rev_due
      FROM mnemonics m WHERE m.user_id = ?1 AND m.deleted_at IS NULL`).bind(user).all().then(r => r.results || []) : [],
  ]);
  const counts = countsOf(m, now);
  return new Response(JSON.stringify({ cards: Object.fromEntries(c.map(r => [r.topic_id, Number(r.n) || 0])),
    mnemonics: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, { due: v.due, new: v.new, total: v.total }])) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// 30 Oct: sections became the galaxies, so each person's positions from the subject layout are cleared once and their
// map lays itself out again (users.prefs_json.map_epoch marks it done).
export const MAP_EPOCH = 3;
async function toMapV3(env, user) {
  const row = await env.DB.prepare('SELECT prefs_json FROM users WHERE id = ?').bind(user).first();
  if (Number((safeParse(row && row.prefs_json, {}) || {}).map_epoch) >= MAP_EPOCH) return;
  await env.DB.batch([env.DB.prepare('DELETE FROM topic_positions WHERE user_id = ? AND pinned = 0').bind(user), prefsStatement(env, user, 'map_epoch', MAP_EPOCH)]);
}

export async function putPositions(request, env, ctx, params, url, user, session) {
  mine(user, session, env);
  return putPositionsRoute(request, env, ctx, params, url, user);
}

export const ROUTES = [
  ['GET', '/api/p/map', getMap],
  ['GET', '/api/p/map/beads', beadsRoute],
  ['PUT', '/api/p/map/positions', putPositions],
];
