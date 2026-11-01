import { fnv1a, yieldOf, CLUSTERS_READ } from './teach-priority.js';

export const CLUSTERS = {
  // Edge weights: one confusion mark (its cw, up to 1 each) counts most; a concept row ties a topic to its concept; two
  // topics resting on the same concept share min(their rows) x w_shared; a versus link adds w_versus x its strength.
  w_confusion: 1.0, w_concept: 0.6, w_shared: 0.3, w_versus: 0.4, min_edge: 0.05,
  min_size: 3, max_size: 8, keep_max: 12, jaccard_keep: 0.5,
  resolution: 1.0, split_factor: 2, split_depth: 3, seed: 'clusters-v1', max_levels: 12, max_passes: 60,
  alpha: 0.85, iters: 80,
  // An unseen topic's chance of a wrong answer (1 - the starting guess).
  unseen_wrong: 0.38,
  name_max: 60,
};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (s, d) => { if (s == null) return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };
const num = v => Number(v) || 0;
const r3 = x => Math.round(x * 1000) / 1000;
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const isConcept = t => !!t && (t.kind === 'concept' || String(t.category_id || '').startsWith('foundation-'));

// ---------------------------------------------------------------- 1. the error graph (pure)

export function buildGraph({ topics, versus = [], concepts = [] }, W = CLUSTERS) {
  const live = topics instanceof Map ? topics : new Map((topics || []).map(t => [t.id, t]));
  const edges = new Map();
  const add = (a, b, part, w, linkId = null) => {
    if (!a || !b || a === b || !live.has(a) || !live.has(b) || !(w > 0)) return;
    const k = pairKey(a, b);
    if (!edges.has(k)) { const [x, y] = a < b ? [a, b] : [b, a]; edges.set(k, { a: x, b: y, w: 0, parts: { confusion: 0, versus: 0, concept: 0, shared: 0 } }); }
    const e = edges.get(k);
    e.parts[part] += w;
    e.w += w;
    if (linkId && !e.link_id) e.link_id = linkId;
  };
  for (const l of versus || []) {
    add(l.from_id, l.to_id, 'confusion', W.w_confusion * Math.max(0, num(l.cw_sum)), l.id);
    add(l.from_id, l.to_id, 'versus', W.w_versus * Math.max(0, Math.min(1, num(l.strength))), l.id);
  }
  // Concept rows: concept -> each clinical topic its misses came from; and each pair of those topics shares it.
  const byConcept = new Map();
  for (const c of concepts || []) {
    if (!live.has(c.concept_id) || !live.has(c.from_topic) || !(num(c.n) > 0)) continue;
    add(c.concept_id, c.from_topic, 'concept', W.w_concept * num(c.n));
    if (!byConcept.has(c.concept_id)) byConcept.set(c.concept_id, new Map());
    const m = byConcept.get(c.concept_id);
    m.set(c.from_topic, (m.get(c.from_topic) || 0) + num(c.n));
  }
  for (const m of byConcept.values()) {
    const list = [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i][0], list[j][0], 'shared', W.w_shared * Math.min(list[i][1], list[j][1]));
  }
  const out = [...edges.values()].filter(e => e.w >= W.min_edge).map(e => ({ ...e, w: r3(e.w), parts: Object.fromEntries(Object.entries(e.parts).map(([k, v]) => [k, r3(v)])) }))
    .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
  const nodes = [...new Set(out.flatMap(e => [e.a, e.b]))].sort();
  return { nodes, edges: out };
}

// ---------------------------------------------------------------- 2. Louvain (pure, deterministic)

// A node's place in the visiting order: a hash of the seed and its own id, so adding a topic never reorders the others.
const orderKey = (id, seed) => `${fnv1a(`${seed}|${id}`)}|${id}`;

/**
 * Louvain community detection on an undirected weighted graph (pure). Nodes are visited in a seeded hash order and
 * candidate communities in index order, ties kept where they are, so the same graph always gives the same answer.
 * Returns [[id, ...], ...]: each community's ids sorted, communities by size then first id.
 */
export function louvain(nodes, edges, { resolution = CLUSTERS.resolution, seed = CLUSTERS.seed, maxLevels = CLUSTERS.max_levels, maxPasses = CLUSTERS.max_passes } = {}) {
  const ids = [...new Set(nodes)].sort((x, y) => (orderKey(x, seed) < orderKey(y, seed) ? -1 : 1));
  const ix = new Map(ids.map((id, i) => [id, i]));
  let n = ids.length;
  let adj = Array.from({ length: n }, () => new Map());
  for (const e of edges || []) {
    const i = ix.get(e.a), j = ix.get(e.b), w = Number(e.w);
    if (i == null || j == null || !(w > 0)) continue;
    if (i === j) adj[i].set(i, (adj[i].get(i) || 0) + 2 * w);
    else { adj[i].set(j, (adj[i].get(j) || 0) + w); adj[j].set(i, (adj[j].get(i) || 0) + w); }
  }
  let member = ids.map((_, i) => i);   // each original node's node at the current level
  for (let level = 0; level < maxLevels; level++) {
    const k = adj.map(row => { let s = 0; for (const w of row.values()) s += w; return s; });
    const m2 = k.reduce((a, b) => a + b, 0);
    if (!(m2 > 0)) break;
    const comm = Array.from({ length: n }, (_, i) => i);
    const tot = k.slice();
    let moved = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      let changes = 0;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        const wTo = new Map();
        for (const [j, w] of adj[i]) { if (j !== i) wTo.set(comm[j], (wTo.get(comm[j]) || 0) + w); }
        tot[ci] -= k[i];
        let best = ci, bestGain = (wTo.get(ci) || 0) - resolution * tot[ci] * k[i] / m2;
        for (const c of [...wTo.keys()].sort((a, b) => a - b)) {
          if (c === ci) continue;
          const gain = wTo.get(c) - resolution * tot[c] * k[i] / m2;
          if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
        }
        tot[best] += k[i];
        if (best !== ci) { comm[i] = best; changes++; moved = true; }
      }
      if (!changes) break;
    }
    if (!moved) break;
    const renum = new Map();
    for (let i = 0; i < n; i++) if (!renum.has(comm[i])) renum.set(comm[i], renum.size);
    const next = Array.from({ length: renum.size }, () => new Map());
    for (let i = 0; i < n; i++) for (const [j, w] of adj[i]) { const a = renum.get(comm[i]), b = renum.get(comm[j]); next[a].set(b, (next[a].get(b) || 0) + w); }
    member = member.map(s => renum.get(comm[s]));
    adj = next;
    n = next.length;
  }
  const groups = new Map();
  ids.forEach((id, i) => { const g = member[i]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(id); });
  return [...groups.values()].map(g => g.sort()).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/** Newman modularity of a partition (pure), for the record and the tests. */
export function modularity(groups, edges, resolution = 1) {
  const of = new Map();
  groups.forEach((g, i) => g.forEach(id => of.set(id, i)));
  let m = 0;
  const tot = new Map(), inside = new Map();
  for (const e of edges || []) {
    const w = Number(e.w) || 0;
    m += w;
    const ca = of.get(e.a), cb = of.get(e.b);
    tot.set(ca, (tot.get(ca) || 0) + w);
    tot.set(cb, (tot.get(cb) || 0) + w);
    if (ca === cb && ca != null) inside.set(ca, (inside.get(ca) || 0) + w);
  }
  if (!(m > 0)) return 0;
  let q = 0;
  for (const [c, t] of tot) if (c != null) q += (inside.get(c) || 0) / m - resolution * (t / (2 * m)) ** 2;
  return r3(q);
}

// The graph's edges between the given ids only.
const induced = (ids, edges) => { const s = new Set(ids); return edges.filter(e => s.has(e.a) && s.has(e.b)); };
// Each id's weight inside the set.
function strengths(ids, edges) {
  const s = new Map(ids.map(id => [id, 0]));
  for (const e of edges) { if (s.has(e.a) && s.has(e.b)) { s.set(e.a, s.get(e.a) + e.w); s.set(e.b, s.get(e.b) + e.w); } }
  return s;
}

/**
 * The groups worth keeping (pure): Louvain's communities, a group over max_size split again at a finer resolution (up to
 * split_depth times; whatever is still too big keeps its max_size most tied members), and groups of min_size or more kept.
 */
export function sizedGroups(nodes, edges, W = CLUSTERS, depth = 0, resolution = W.resolution) {
  const out = [];
  for (const g of louvain(nodes, edges, { resolution, seed: W.seed, maxLevels: W.max_levels, maxPasses: W.max_passes })) {
    if (g.length > W.max_size) {
      const sub = induced(g, edges);
      const split = depth < W.split_depth ? sizedGroups(g, sub, W, depth + 1, resolution * W.split_factor) : null;
      if (split && split.length && !(split.length === 1 && split[0].length === g.length)) { out.push(...split); continue; }
      const st = strengths(g, sub);
      out.push(g.slice().sort((a, b) => st.get(b) - st.get(a) || (a < b ? -1 : 1)).slice(0, W.max_size).sort());
    } else if (g.length >= W.min_size) out.push(g);
  }
  return out;
}

// ---------------------------------------------------------------- 3. the root: personalised PageRank (pure)

export function pagerank(nodes, edges, personal, { alpha = CLUSTERS.alpha, iters = CLUSTERS.iters } = {}) {
  const ids = [...new Set(nodes)].sort();
  const ix = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  if (!n) return new Map();
  const nbr = Array.from({ length: n }, () => []);
  const deg = new Array(n).fill(0);
  for (const e of edges || []) {
    const i = ix.get(e.a), j = ix.get(e.b), w = Number(e.w);
    if (i == null || j == null || !(w > 0) || i === j) continue;
    nbr[i].push([j, w]); nbr[j].push([i, w]); deg[i] += w; deg[j] += w;
  }
  let p = ids.map(id => Math.max(0, Number(personal instanceof Map ? personal.get(id) : personal && personal[id]) || 0));
  const ps = p.reduce((a, b) => a + b, 0);
  p = ps > 0 ? p.map(x => x / ps) : p.map(() => 1 / n);
  let r = p.slice();
  for (let it = 0; it < iters; it++) {
    const next = p.map(x => (1 - alpha) * x);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!(deg[i] > 0)) { dangling += r[i]; continue; }
      for (const [j, w] of nbr[i]) next[j] += alpha * r[i] * w / deg[i];
    }
    for (let i = 0; i < n; i++) next[i] += alpha * dangling * p[i];
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - r[i]);
    r = next;
    if (diff < 1e-10) break;
  }
  return new Map(ids.map((id, i) => [id, r[i]]));
}

/**
 * A cluster's root (pure): personalised PageRank over the whole error graph from its members' misses (fails + 1 each).
 * Candidates are the members and any concept tied to two or more of them; a foundation concept wins when there is one
 * (the highest-ranked concept), else the highest-ranked member. Returns {id, kind: concept | topic, score, scores}.
 */
export function rootOf(members, graph, topics) {
  const T = topics instanceof Map ? topics : new Map((topics || []).map(t => [t.id, t]));
  const set = new Set(members);
  const personal = new Map(members.map(id => [id, isConcept(T.get(id)) ? 0 : 1 + num((T.get(id) || {}).fails)]));
  const scores = pagerank(graph.nodes, graph.edges, personal);
  const tiesTo = new Map();
  for (const e of graph.edges) {
    if (set.has(e.a) && !set.has(e.b) && isConcept(T.get(e.b))) tiesTo.set(e.b, (tiesTo.get(e.b) || 0) + 1);
    if (set.has(e.b) && !set.has(e.a) && isConcept(T.get(e.a))) tiesTo.set(e.a, (tiesTo.get(e.a) || 0) + 1);
  }
  const cands = [...members, ...[...tiesTo].filter(([, n]) => n >= 2).map(([id]) => id)];
  const rank = list => list.slice().sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0) || (a < b ? -1 : 1));
  const concepts = rank(cands.filter(id => isConcept(T.get(id))));
  const id = concepts[0] || rank(cands)[0] || null;
  return { id, kind: id && isConcept(T.get(id)) ? 'concept' : 'topic', score: r3(scores.get(id) || 0), in_cluster: set.has(id) };
}

// ---------------------------------------------------------------- 4. the cost (pure)

export const wrongChance = t => (t && Number(t.seen) && t.weakness_raw != null ? Math.max(0, Math.min(1, Number(t.weakness_raw))) : CLUSTERS.unseen_wrong);

export function costOf(group, graph, topics) {
  const T = topics instanceof Map ? topics : new Map((topics || []).map(t => [t.id, t]));
  const set = new Set(group);
  const total = new Map(group.map(id => [id, 0])), inside = new Map(group.map(id => [id, 0]));
  const pairs = [];
  for (const e of graph.edges) {
    const ia = set.has(e.a), ib = set.has(e.b);
    if (ia) total.set(e.a, total.get(e.a) + e.w);
    if (ib) total.set(e.b, total.get(e.b) + e.w);
    if (ia && ib) {
      inside.set(e.a, inside.get(e.a) + e.w); inside.set(e.b, inside.get(e.b) + e.w);
      if (e.parts && (e.parts.confusion > 0 || e.parts.versus > 0)) pairs.push({ a: e.a, b: e.b, link_id: e.link_id || null, w: e.w, confusion: e.parts.confusion || 0 });
    }
  }
  const members = group.map(id => {
    const t = T.get(id) || {};
    const density = total.get(id) > 0 ? inside.get(id) / total.get(id) : 0;
    return { id, cost: r3(yieldOf(t) * wrongChance(t) * density), density: r3(density), w_in: r3(inside.get(id)) };
  });
  pairs.sort((x, y) => y.w - x.w || (x.a < y.a ? -1 : 1));
  return { cost: r3(members.reduce((s, m) => s + m.cost, 0)), members, pairs };
}

// ---------------------------------------------------------------- 5. stable ids and names (pure)

export const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };
export const newClusterId = (members, salt = '') => `k_${fnv1a(`${[...members].sort().join('|')}#${salt}`)}${fnv1a(`${salt}#${members.length}`).slice(0, 2)}`;

/**
 * Last night's ids kept (pure): each new group takes the id of the old cluster it overlaps most, when the overlap
 * (Jaccard over members) is jaccard_keep or more and no closer group took it first. Returns [{members, id, kept, from?}].
 */
export function matchIds(groups, previous, { keep = CLUSTERS.jaccard_keep, salt = '' } = {}) {
  const prev = (previous || []).map(p => ({ id: p.id, members: (p.members || []).map(m => (isObj(m) ? m.id : m)) }));
  const pairs = [];
  groups.forEach((g, gi) => prev.forEach(p => { const j = jaccard(g, p.members); if (j >= keep) pairs.push({ gi, id: p.id, j }); }));
  pairs.sort((a, b) => b.j - a.j || a.gi - b.gi || (a.id < b.id ? -1 : 1));
  const taken = new Set(), got = new Map();
  for (const p of pairs) if (!taken.has(p.id) && !got.has(p.gi)) { taken.add(p.id); got.set(p.gi, p); }
  const used = new Set(prev.map(p => p.id));
  return groups.map((g, gi) => {
    if (got.has(gi)) return { members: g, id: got.get(gi).id, kept: true, overlap: r3(got.get(gi).j) };
    let id = newClusterId(g, salt), i = 0;
    while (used.has(id)) id = newClusterId(g, `${salt}:${++i}`);
    used.add(id);
    return { members: g, id, kept: false };
  });
}

/** A code name from the root (pure): a concept's own name, else "<root> and its look-alikes". At most name_max. */
export function codeName(root, members = []) {
  if (!root || !root.name) return cut(members.map(m => m.name).filter(Boolean).slice(0, 2).join(' and ') || 'A group of topics', CLUSTERS.name_max);
  return cut(root.kind === 'concept' || isConcept(root) ? root.name : `${root.name} and its look-alikes`, CLUSTERS.name_max);
}

/**
 * The night's clusters from the read rows (pure): the graph, the sized groups, each scored and rooted, ids kept from
 * the previous clusters, best cost first, at most keep_max. raw: {topics, versus, concepts}; previous: the active rows.
 * Returns {graph: {nodes, edges}, clusters: [{id, kept, members: [{id, name, kind, role, cost, density, band, fails}],
 * root: {id, name, kind}, pairs, cost, name, modularity}], q}.
 */
export function findClusters(raw, previous = [], W = CLUSTERS, { salt = '' } = {}) {
  const topics = raw.topics instanceof Map ? raw.topics : new Map((raw.topics || []).map(t => [t.id, t]));
  const graph = buildGraph({ topics, versus: raw.versus, concepts: raw.concepts }, W);
  const groups = sizedGroups(graph.nodes, graph.edges, W);
  const q = modularity(louvain(graph.nodes, graph.edges, { resolution: W.resolution, seed: W.seed }), graph.edges);
  const scored = groups.map(g => {
    const c = costOf(g, graph, topics);
    const root = rootOf(g, graph, topics);
    return { g, c, root };
  }).filter(x => x.c.cost > 0).sort((a, b) => b.c.cost - a.c.cost || (a.g[0] < b.g[0] ? -1 : 1)).slice(0, W.keep_max);
  const ids = matchIds(scored.map(x => x.g), previous, { keep: W.jaccard_keep, salt });
  const clusters = scored.map((x, i) => {
    const rootT = topics.get(x.root.id) || { id: x.root.id, name: x.root.id };
    const members = x.c.members.map(m => {
      const t = topics.get(m.id) || {};
      return { id: m.id, name: t.name || m.id, kind: isConcept(t) ? 'concept' : 'topic', role: m.id === x.root.id ? 'root' : 'member', cost: m.cost, density: m.density,
        band: Number(t.seen) ? t.band || null : 'unseen', fails: num(t.fails), root_tie: graph.edges.some(e => (e.a === m.id && e.b === x.root.id) || (e.b === m.id && e.a === x.root.id)) };
    }).sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : 0) || b.cost - a.cost || (a.id < b.id ? -1 : 1));
    const root = { id: rootT.id, name: rootT.name, kind: x.root.kind, in_cluster: x.root.in_cluster };
    return { id: ids[i].id, kept: ids[i].kept, members, root, pairs: x.c.pairs, cost: x.c.cost, name: codeName({ ...root, kind: x.root.kind }, members),
      edges: induced(x.g, graph.edges).length, weight: r3(induced(x.g, graph.edges).reduce((s, e) => s + e.w, 0)) };
  });
  return { graph, clusters, q };
}

// ---------------------------------------------------------------- 7. reads (connector side; no Claude call)

/** A clusters row as the code uses it (pure). */
export function shapeRow(r) {
  if (!r) return null;
  const d = parse(r.detail_json, {}) || {};
  return { id: r.id, name: r.name, name_by: r.name_by, name_status: r.name_status, status: r.status, cost: num(r.cost),
    root: { id: r.root_id, kind: r.root_kind, name: d.root_name || null }, members: parse(r.members_json, []) || [], pairs: parse(r.pairs_json, []) || [],
    first_seen: r.first_seen, last_seen: r.last_seen, lesson_at: r.lesson_at != null ? num(r.lesson_at) : null, lesson_n: num(r.lesson_n), detail: d };
}

/** The active clusters, costliest first, each with its newest cluster lesson (lesson_at) (binds ?1 user, ?2 limit):
 *  teach-priority.js rankTopicsFor reads it in its own batch, so a plain "teach me" costs no query for it. */
export const CLUSTERS_SQL = CLUSTERS_READ;
/** The active clusters, costliest first, each with its newest cluster lesson (lesson_at). [] before 0071. */
export async function readClusters(env, user, { limit = CLUSTERS.keep_max } = {}) {
  try {
    return ((await env.DB.prepare(CLUSTERS_SQL).bind(user, limit).all()).results || []).map(shapeRow);
  } catch (e) { if (noTable(e)) return []; throw e; }
}

/** One cluster by id (active or gone), or null. */
export async function readCluster(env, user, id) {
  try { return shapeRow(await env.DB.prepare('SELECT * FROM clusters WHERE user_id = ? AND id = ?').bind(user, id).first()); } catch (e) { if (noTable(e)) return null; throw e; }
}

/** The active cluster a topic belongs to, its costliest (binds ?1 user, ?2 topic): topic.js reads it in its own batch. */
export const CLUSTER_OF_SQL = `SELECT * FROM clusters c WHERE c.user_id = ?1 AND c.status = 'active'
  AND EXISTS (SELECT 1 FROM json_each(c.members_json) j WHERE json_extract(j.value, '$.id') = ?2) ORDER BY c.cost DESC LIMIT 1`;
/** A topic's cluster from that row (pure): {id, name, root, members: [{id, name, band, role}], line}, or null. */
export function clusterOfRow(r, topicId) {
  const c = shapeRow(r);
  if (!c) return null;
  const others = c.members.filter(m => m.id !== topicId);
  return { id: c.id, name: c.name, root: { id: c.root.id, name: c.root.name, kind: c.root.kind }, members: c.members.map(m => ({ id: m.id, name: m.name, band: m.band, role: m.role })),
    line: cut(`Part of ${c.name}, with ${others.slice(0, 3).map(m => m.name).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}`, 200) };
}
/** The active cluster a topic belongs to (the panel chip, map_topic), or null. */
export async function clusterOfTopic(env, user, topicId) {
  if (!topicId) return null;
  try { return clusterOfRow(await env.DB.prepare(CLUSTER_OF_SQL).bind(user, topicId).first(), topicId); } catch (e) { if (noTable(e)) return null; throw e; }
}

/** map_overview's line (pure): "Clusters: Thyroid: reading the uptake scan (4 topics, costing you most), ...", or null. */
export function clustersLine(rows, max = 3) {
  const list = (rows || []).slice(0, max);
  if (!list.length) return null;
  return cut(`Clusters: ${list.map((c, i) => `${c.name} (${plural(c.members.filter(m => m.kind !== 'concept').length, 'topic')}${i === 0 ? ', costing you most' : ''})`).join('; ')}`, 300);
}
export async function clustersOverviewLine(env, user) {
  return clustersLine(await readClusters(env, user, { limit: 3 }));
}

// ---------------------------------------------------------------- 7. a cluster lesson's reads (teach_next)

const MISS_COLS = `id, topic_id, label, day, at, source, result, confidence, time_s, slow, error_type, my_reasoning, reasoning_source, rule, look_alikes,
  block_id, sitting_id, q_index, step, confidence_source, his_words, his_words_at, mo_corrected_json`;
/**
 * What a cluster lesson's brief reads, in one D1 batch (teach-brief.js shapes it and scrubs the misses): each member's
 * newest live misses, the versus links between members (the separating finding each way), the members' cards and
 * pictures. has: the tables present (teach-priority.js tablesPresent). Returns {misses, links, cards, pictures}.
 */
export async function clusterBriefReads(env, user, cluster, has = new Set(['card_topics', 'card_cache', 'topic_pictures'])) {
  const ids = JSON.stringify([...new Set([cluster.root && cluster.root.id, ...(cluster.members || []).map(m => m.id)].filter(Boolean))]);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const none = () => q('SELECT NULL AS id WHERE 0 AND ? = ?', user, ids);
  const res = await env.DB.batch([
    q(`SELECT ${MISS_COLS} FROM misses WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2)) AND held = 0 AND deleted_at IS NULL ORDER BY at DESC LIMIT 40`, user, ids),
    q(`SELECT id, from_id, to_id, a_vs_b, b_vs_a, confusion, confused_n, picture FROM links WHERE user_id = ?1 AND type = 'versus' AND status IN ('active', 'proposed')
       AND from_id IN (SELECT value FROM json_each(?2)) AND to_id IN (SELECT value FROM json_each(?2)) ORDER BY confusion DESC LIMIT 20`, user, ids),
    has.has('card_topics') && has.has('card_cache')
      ? q(`SELECT ct.topic_id, c.card_id, c.note_id, c.question, c.answer, c.vs, c.image_count FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
         WHERE ct.user_id = ?1 AND ct.topic_id IN (SELECT value FROM json_each(?2)) AND ct.removed_at IS NULL AND c.deleted_at IS NULL AND (ct.strong = 1 OR ct.match <> 'search')
         ORDER BY ct.match = 'miss' DESC, ct.strong DESC, c.lapses DESC LIMIT 24`, user, ids) : none(),
    has.has('topic_pictures')
      ? q(`SELECT topic_id, source, ref, title FROM topic_pictures WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2)) AND hidden_at IS NULL LIMIT 60`, user, ids) : none(),
  ]);
  const [misses, links, cards, pictures] = res.map(r => r.results || []);
  return { misses, links, cards, pictures };
}

const VS_TITLE = /\b(?:vs\.?|versus)\b/i;
export function clusterPictures(rows, members, max = 6) {
  const nameOf = new Map((members || []).map(m => [m.id, m.name]));
  const by = new Map();
  for (const p of rows || []) {
    const k = `${p.source}:${p.ref}`;
    if (!by.has(k)) by.set(k, { ref: p.ref, source: p.source, title: p.title || null, topics: [] });
    const name = nameOf.get(p.topic_id);
    if (name && !by.get(k).topics.includes(name)) by.get(k).topics.push(name);
  }
  const rank = p => (p.source === 'anking' ? (VS_TITLE.test(p.title || '') && p.topics.length >= 2 ? 0 : VS_TITLE.test(p.title || '') ? 1 : 2) : p.source === 'nbme_hy' ? 3 : 4);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.topics.length - a.topics.length || (a.ref < b.ref ? -1 : 1)).slice(0, max);
}

/**
 * The member a lesson's step is about (pure): the member whose name (or the start of it, three words or more) its title
 * names, the longest first; else the fallback (the lesson's root). A cluster lesson's step checks count on that member.
 */
export function memberOfText(members, text, fallback = null) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null, len = 0;
  for (const m of members || []) {
    const words = String(m.name || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    for (const n of [words.length, Math.min(3, words.length), Math.min(2, words.length), 1]) {
      const k = words.slice(0, n).join(' ');
      if (!k || k.length < 5 || !t.includes(` ${k} `)) continue;
      if (k.length > len) { best = m.id; len = k.length; }
      break;
    }
  }
  return best || fallback;
}
