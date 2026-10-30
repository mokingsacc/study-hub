import { json, readJson, HttpError } from '../util.js';
import { ankiCall, AnkiError } from '../anki.js';
import { looksLikeQuestionBank, leakIndexFor } from './guard.js';
import { leaks } from '../checks.js';
import {
  lookAlikeNames, lookAlikeRole, cwForMiss, weightOf, titleNames, versusLine, gapPair, W, CW, CAPS, SLIP_ERRORS,
} from './links.js';
import { planLinks, readState } from './links-store.js';
import { errorKeyOf } from './weights.js';
import { resolveTopic } from './resolve.js';
import { writeBatch } from './events.js';
import { norm, userKey } from '../../../public/js/shared/names.js';

// Other areas' code, behind one object so tests can swap it (_setDeps).
const deps = {
  resolveTopic: (...a) => resolveTopic(...a),
  names: async () => ({ norm, userKey }),
  writeBatch: (...a) => writeBatch(...a),
  ankiCall: (...a) => ankiCall(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}

export const ACCEPT = 0.9;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const EMPTY = { rows: [], events: [] };

// Which support source a miss is, by where it came from.
const SRC = { anki: 'anki_log', uworld: 'uworld', hub: 'hub_analysis', claude: 'claude', onenote: 'onenote' };
export const missSource = miss => SRC[miss.source] || 'derived';

// A misread or a test-taking slip (a time-out click) says nothing about which topics look alike: it makes no link.
const isSlip = miss => SLIP_ERRORS.includes(miss.error_type);

// The miss's own observation key: its id without the family prefix ('anki:200', 'uw:19038:2026-10-23', 'hub:b1:4').
export const missObsKey = (user, miss) => (String(miss.id).startsWith(`${user}.`) ? String(miss.id).slice(user.length + 1) : String(miss.id));

// One resolveTopic answer, kept only at confidence >= 0.9.
async function resolveName(env, user, texts, extra = {}) {
  let r;
  try { r = await deps.resolveTopic(env, user, { texts, ...extra }); } catch (e) { if (noTable(e)) return { topic_id: null, candidates: [] }; throw e; }
  if (r && r.topic_id && (r.confidence ?? 0) >= ACCEPT) return { topic_id: r.topic_id, confidence: r.confidence };
  return { topic_id: null, candidates: ((r && r.candidates) || []).slice(0, 3) };
}

// The first of several names that resolves (each tried exactly, in order), else the first one's candidates.
async function resolveFirst(env, user, texts, extra) {
  let first = null;
  for (const t of texts) {
    const r = await resolveName(env, user, [t], extra);
    if (r.topic_id) return r;
    first = first || r;
  }
  return first || { topic_id: null, candidates: [] };
}

function safeText(text, leakIndex) {
  const t = String(text || '').trim();
  if (!t || t.length > CAPS.text || looksLikeQuestionBank(t)) return null;
  if (leakIndex && leakIndex.size && leaks(leakIndex, t)) return null;
  return t;
}

// The look_alikes segment a name came from (the separating words, for the panel's sources).
function segmentFor(miss, text) {
  const k = text.toLowerCase();
  return String(miss.look_alikes || '').split(/;|\n|\s\|\s/).map(s => s.trim()).find(s => s.toLowerCase().includes(k)) || null;
}

/**
 * The miss's look-alikes, resolved: [{text, from, topic_id, role, w, cw}] for the resolved ones and
 * [{text, from, topic_id: null, candidates}] for the rest. The true topic itself is dropped.
 */
export async function lookAlikeCandidates(env, user, miss) {
  const out = [];
  for (const n of lookAlikeNames(miss)) {
    const r = await resolveName(env, user, [n.text], { system: miss.system_raw ?? null, exact: true, source: 'lookalike', source_ref: miss.id });
    if (r.topic_id && r.topic_id === miss.topic_id) continue;
    if (r.topic_id && out.some(o => o.topic_id === r.topic_id)) {
      const o = out.find(x => x.topic_id === r.topic_id);
      if (n.from === 'title') o.titled = true;
      continue;
    }
    out.push({ text: n.text, from: n.from, topic_id: r.topic_id, candidates: r.candidates || [], titled: n.from === 'title', ...(n.vs ? { vs: true } : {}) });
  }
  const ids = [...new Set(out.filter(o => o.topic_id).map(o => o.topic_id))];
  const info = ids.length ? await topicInfo(env, user, [miss.topic_id, ...ids]) : new Map();
  const mine = info.get(miss.topic_id) || null;
  for (const o of out) {
    const t = o.topic_id ? info.get(o.topic_id) : null;
    if (!t) continue;
    if (familyOf(t.kind) !== familyOf(mine ? mine.kind : 'condition')) { o.drop = true; continue; }
    if (ABBREV.test(o.text) && mine && mine.category_id && t.category_id && mine.category_id !== t.category_id) {
      o.candidates = [{ id: t.id, name: t.name }];
      o.topic_id = null;
    }
  }
  // A lower-case head that names nothing on the map is a fragment of the explanation ("infection", "repeat chest
  // x-ray"), not a name to queue (RH2-2); the halves of an "A versus B" head are names, so they stay.
  const kept = out.filter(o => !o.drop && !(!o.topic_id && o.from === 'head' && !o.vs && /^[a-z]/.test(o.text)));
  out.length = 0;
  out.push(...kept);
  const resolved = out.filter(o => o.topic_id);
  const aliases = await aliasesOf(env, user, resolved.map(o => o.topic_id));
  const src = missSource(miss);
  for (const o of resolved) {
    o.role = lookAlikeRole(miss, o.titled ? 'title' : o.from, [o.text, ...(aliases.get(o.topic_id) || [])]);
    o.cw = cwForMiss(o.role, miss);
    o.w = weightOf(src, o.role);
  }
  return out;
}

// Diagnoses (conditions, organisms, approaches) are one family; drugs, procedures, findings and concepts each their own.
const familyOf = k => (['condition', 'organism', 'approach'].includes(k || 'condition') ? 'dx' : k);
const ABBREV = /^[A-Z][A-Z0-9-]{1,6}s?$/;

// Kind and category of some topics, in one query: Map(id -> {id, name, kind, category_id}).
async function topicInfo(env, user, topicIds) {
  const map = new Map();
  try {
    const rows = (await env.DB.prepare(`SELECT id, name, kind, category_id FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(user, JSON.stringify([...new Set(topicIds.filter(Boolean))])).all()).results || [];
    for (const r of rows) map.set(r.id, r);
  } catch (e) { if (!noTable(e)) throw e; }
  return map;
}

// Names and aliases of some topics, in one query: Map(topic_id -> [names]).
async function aliasesOf(env, user, topicIds) {
  const map = new Map();
  if (!topicIds.length) return map;
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT id AS topic_id, name AS alias FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))
      UNION ALL SELECT topic_id, alias FROM topic_aliases WHERE user_id = ?1 AND status = 'active' AND kind != 'typo' AND topic_id IN (SELECT value FROM json_each(?2))`)
      .bind(user, JSON.stringify(topicIds)).all()).results || [];
  } catch (e) { if (!noTable(e)) throw e; }
  for (const r of rows) { if (!map.has(r.topic_id)) map.set(r.topic_id, []); map.get(r.topic_id).push(r.alias); }
  return map;
}

/**
 * Support for one miss: {rows, events, queued}. A miss without its own topic yet makes nothing (realtime runs
 * this again when the miss is placed). Held misses write held support, no event and no queue item.
 */
export async function fromMiss(env, user, miss, ctx = {}) {
  if (!miss || !miss.topic_id || miss.deleted_at || isSlip(miss)) return { ...EMPTY, queued: 0 };
  const cands = await lookAlikeCandidates(env, user, miss);
  if (!cands.length) return { ...EMPTY, queued: 0 };
  const held = miss.held ? 1 : 0;
  const src = missSource(miss);
  const leakIndex = miss.block_id != null && miss.q_index != null ? await leakIndexFor(env, user, { missIds: [miss.id] }) : null;
  const obs = missObsKey(user, miss);

  // Unresolved heads: a resolved lookalike queue item already names the topic; otherwise queue it.
  const open = cands.filter(c => !c.topic_id);
  const queue = open.length ? await queueRowsFor(env, user, miss, open, { held }) : { rows: [], placed: new Map() };
  const { norm: normName } = await deps.names();
  for (const c of open) { const t = queue.placed.get(normName(c.text)); if (t && t !== miss.topic_id) Object.assign(c, { topic_id: t }); }
  const late = cands.filter(c => c.topic_id && c.role == null);
  if (late.length) {
    const aliases = await aliasesOf(env, user, late.map(c => c.topic_id));
    for (const c of late) {
      c.role = lookAlikeRole(miss, c.titled ? 'title' : c.from, [c.text, ...(aliases.get(c.topic_id) || [])]);
      c.cw = cwForMiss(c.role, miss);
      c.w = weightOf(src, c.role);
    }
  }

  const proposals = cands.filter(c => c.topic_id).map(c => ({
    type: 'versus', from: miss.topic_id, to: c.topic_id, by: 'code', source: src, source_ref: miss.id, label: miss.label || null,
    support: { obs_key: obs, src, role: c.role, w: c.w, cw: c.cw, truth_id: c.cw > 0 ? miss.topic_id : null,
      text: safeText(segmentFor(miss, c.text), leakIndex), miss_id: miss.id, sitting_id: miss.sitting_id ?? null, held, at: miss.at },
  }));
  const r = proposals.length ? await planLinks(env, user, proposals, ctx) : { rows: [], events: [] };
  return { rows: [...r.rows, ...queue.rows], events: held ? [] : r.events, queued: queue.rows.length };
}

// topic_queue rows for look-alike heads code could not place ('lookalike:<norm>'), one read for all of them.
const queueRowsFor = (env, user, miss, open, { held }) => queueRowsForMany(env, user, [{ miss, open, held }]);

/**
 * The same for several misses at once (fromMisses): one read, and one row per queue item however many of the
 * misses name it (a new item counts them all in refs and miss_ids), so two misses naming one head never plan the
 * same insert twice. groups: [{miss, open: [candidate], held}]. Returns {rows, placed: Map(norm -> topic_id)}.
 */
async function queueRowsForMany(env, user, groups) {
  const { norm, userKey } = await deps.names();
  const items = [];
  for (const g of groups) for (const c of g.open) { const key = norm(c.text); if (key) items.push({ g, c, key }); }
  const idOf = key => userKey(user, `lookalike:${key}`);
  let have = [];
  try {
    have = items.length ? (await env.DB.prepare(`SELECT * FROM topic_queue WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(user, JSON.stringify([...new Set(items.map(x => idOf(x.key)))])).all()).results || [] : [];
  } catch (e) { if (!noTable(e)) throw e; return { rows: [], placed: new Map() }; }
  const byId = new Map(have.map(q => [q.id, q]));
  const placed = new Map();
  const plan = new Map();   // queue id -> {q, first: {miss, c}, missIds: []}
  const now = Date.now();
  for (const x of items) {
    const id = idOf(x.key);
    const q = byId.get(id);
    if (q && q.status === 'resolved' && q.resolved_topic_id) { placed.set(x.key, q.resolved_topic_id); continue; }
    if (x.g.held || (q && q.status === 'rejected')) continue;
    const p = plan.get(id) || { q, first: x, missIds: [] };
    plan.set(id, p);
    const known = q ? parse(q.context_json, {}).miss_ids || [] : [];
    if (!known.includes(x.g.miss.id) && !p.missIds.includes(x.g.miss.id)) p.missIds.push(x.g.miss.id);
  }
  const rows = [];
  for (const [id, p] of plan) {
    if (!p.missIds.length) continue;
    const { miss, c } = { miss: p.first.g.miss, c: p.first.c };
    if (!p.q) {
      const seg = String(segmentFor(miss, c.text) || '').slice(0, 400);
      rows.push({ table: 'topic_queue', op: 'insert', key: { user_id: user, id }, before: null, after: {
        kind: 'lookalike', label_norm: p.first.key, label_raw: c.text.slice(0, CAPS.head),
        context_json: JSON.stringify({ miss_ids: p.missIds.slice(-10), head: c.text, true_topic_id: miss.topic_id, label: miss.label || null, context: looksLikeQuestionBank(seg) ? null : seg || null }),
        candidates_json: JSON.stringify(c.candidates || []), refs: p.missIds.length, first_seen_at: now, last_seen_at: now, status: 'open', attempts: 0 } });
      continue;
    }
    const ctxj = parse(p.q.context_json, {});
    const missIds = Array.isArray(ctxj.miss_ids) ? ctxj.miss_ids : [];
    rows.push({ table: 'topic_queue', op: 'update', key: { user_id: user, id }, before: p.q, after: {
      refs: (p.q.refs || 1) + p.missIds.length, last_seen_at: now, context_json: JSON.stringify({ ...ctxj, miss_ids: [...missIds, ...p.missIds].slice(-10) }) } });
  }
  return { rows, placed };
}

/**
 * Support for several released misses in one plan (lookAlikeParts): every miss's look-alikes resolved, the queue
 * items they name merged, and one planLinks over all their proposals, so misses naming the same look-alike add
 * their support to one link instead of each planning it (no follow-up rounds, no repeated reads). Held misses go
 * through fromMiss one by one. Returns {rows, events, queued, cw: Map(miss id -> resolved candidates, for
 * weakness's confused_with)}.
 */
export async function fromMisses(env, user, misses, ctx = {}) {
  const live = (misses || []).filter(m => m && m.topic_id && !m.deleted_at && !m.held);
  const out = { rows: [], events: [], queued: 0, cw: new Map() };
  if (!live.length) return out;
  const per = [];
  for (const miss of live) {
    const cands = await lookAlikeCandidates(env, user, miss);
    out.cw.set(miss.id, cands.filter(c => c.topic_id).map(c => ({ ...c })));
    if (cands.length && !isSlip(miss)) per.push({ miss, cands });
  }
  if (!per.length) return out;
  const { norm } = await deps.names();
  const queue = await queueRowsForMany(env, user, per.filter(p => p.cands.some(c => !c.topic_id)).map(p => ({ miss: p.miss, open: p.cands.filter(c => !c.topic_id), held: 0 })));
  for (const p of per) for (const c of p.cands) if (!c.topic_id) { const t = queue.placed.get(norm(c.text)); if (t && t !== p.miss.topic_id) c.topic_id = t; }
  const late = per.flatMap(p => p.cands.filter(c => c.topic_id && c.role == null).map(c => ({ p, c })));
  if (late.length) {
    const aliases = await aliasesOf(env, user, [...new Set(late.map(x => x.c.topic_id))]);
    for (const { p, c } of late) {
      const src = missSource(p.miss);
      c.role = lookAlikeRole(p.miss, c.titled ? 'title' : c.from, [c.text, ...(aliases.get(c.topic_id) || [])]);
      c.cw = cwForMiss(c.role, p.miss);
      c.w = weightOf(src, c.role);
    }
  }
  const hubIds = per.filter(p => p.miss.block_id != null && p.miss.q_index != null).map(p => p.miss.id);
  const leakIndex = hubIds.length ? await leakIndexFor(env, user, { missIds: hubIds }) : null;
  const proposals = per.flatMap(({ miss, cands }) => {
    const src = missSource(miss), obs = missObsKey(user, miss);
    return cands.filter(c => c.topic_id && c.topic_id !== miss.topic_id).map(c => ({
      type: 'versus', from: miss.topic_id, to: c.topic_id, by: 'code', source: src, source_ref: miss.id, label: miss.label || null,
      support: { obs_key: obs, src, role: c.role, w: c.w, cw: c.cw, truth_id: c.cw > 0 ? miss.topic_id : null,
        text: safeText(segmentFor(miss, c.text), miss.block_id != null ? leakIndex : null), miss_id: miss.id, sitting_id: miss.sitting_id ?? null, held: 0, at: miss.at },
    }));
  });
  const r = proposals.length ? await planLinks(env, user, proposals, ctx) : { rows: [], events: [] };
  out.rows.push(...r.rows, ...queue.rows);
  out.events.push(...r.events);
  out.queued = queue.rows.length;
  return out;
}

/** A released hub analysis: the hub miss it made, by block and question (the analysis text itself is never read). */
export async function fromAnalysis(env, user, { block_id, q_index }, ctx = {}) {
  let miss;
  try {
    miss = await env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND block_id = ? AND q_index = ? AND deleted_at IS NULL').bind(user, block_id, q_index).first();
  } catch (e) { if (noTable(e)) return EMPTY; throw e; }
  return miss ? fromMiss(env, user, miss, ctx) : EMPTY;
}

export async function fromGap(env, user, gap, ctx = {}) {
  if (!gap || !gap.id) return EMPTY;
  let a = gap.topic_id || null, b = null;
  const pair = gapPair(gap.gap) || gapPair(gap.topic);
  if (pair) {
    const [ra, rb] = [await resolveName(env, user, [pair[0]], { source: 'gap', source_ref: gap.id }), await resolveName(env, user, [pair[1]], { source: 'gap', source_ref: gap.id })];
    if (ra.topic_id && rb.topic_id) [a, b] = [ra.topic_id, rb.topic_id];
  }
  if (!b && gap.mixed_with && a) b = (await resolveName(env, user, [gap.mixed_with], { source: 'gap', source_ref: gap.id })).topic_id;
  if (!a || !b || a === b) return EMPTY;
  const stated = (gap.origin || 'stated') === 'stated';
  const slip = SLIP_ERRORS.includes(errorKeyOf(gap.error_type));   // gaps keep the hub's words ('test-taking')
  const r = await planLinks(env, user, [{ type: 'versus', from: a, to: b, by: 'code', source: 'gap', source_ref: gap.id, label: 'gap',
    support: { obs_key: `gap:${gap.id}`, src: stated ? 'gap' : 'anki_review', role: 'mixed', w: W.gap, cw: slip ? 0 : stated ? CW.gap_stated : CW.mixed_review,
      truth_id: gap.topic_id || a, gap_id: gap.id, card_id: gap.card_id ?? null, note_id: gap.note_id ?? null, sitting_id: gap.sitting_id ?? null,
      held: gap.held ? 1 : 0, at: gap.at || Date.now() } }], ctx);
  return { rows: r.rows, events: gap.held ? [] : r.events };
}

/**
 * realtime's ingestion hook, in the batch of the change that made or moved the miss, analysis or gap:
 * {rows, events} for the same writeBatch (empty when the map tables are not there yet).
 */
export async function linkStatements(env, user, item = {}) {
  try {
    if (item.miss) return await fromMiss(env, user, item.miss, item.ctx);
    if (item.miss_id) {
      const miss = await env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND id = ?').bind(user, item.miss_id).first();
      return miss ? await fromMiss(env, user, miss, item.ctx) : EMPTY;
    }
    if (item.analysis) return await fromAnalysis(env, user, item.analysis, item.ctx);
    if (item.gap) return await fromGap(env, user, item.gap, item.ctx);
  } catch (e) {
    if (noTable(e)) return EMPTY;
    throw e;
  }
  return EMPTY;
}

/**
 * Taxonomy's lookalike queue item, once Claude names its topic: the links for every miss it came from, for
 * queue.resolve's own batch (the alias it writes is not readable yet, so the topic comes in by id).
 * {miss_ids, topic_id, head} -> {rows, events}.
 */
export async function fromResolvedLookalike(env, user, args, ctx = {}) {
  const proposals = await lookalikeProposals(env, user, args);
  if (!proposals.length) return EMPTY;
  const r = await planLinks(env, user, proposals, ctx);
  return { rows: r.rows, events: r.events };
}

/**
 * The versus proposals one placed look-alike item makes (fromResolvedLookalike's first half). queue.resolve gathers
 * every look-alike item's proposals and plans them in one planLinks call, so two items placed on one topic that
 * name the same miss's topic make one link with their supports, never two inserts of it (B4-1).
 */
export async function lookalikeProposals(env, user, { miss_ids = [], topic_id, head = '' }) {
  if (!topic_id || !miss_ids.length) return [];
  let misses;
  try {
    misses = (await env.DB.prepare(`SELECT * FROM misses WHERE user_id = ? AND deleted_at IS NULL AND topic_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))`)
      .bind(user, JSON.stringify(miss_ids.slice(0, 20))).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
  const aliases = (await aliasesOf(env, user, [topic_id])).get(topic_id) || [];
  const proposals = [];
  for (const miss of misses) {
    if (miss.topic_id === topic_id || isSlip(miss)) continue;
    const src = missSource(miss);
    const role = lookAlikeRole(miss, 'head', [head, ...aliases].filter(Boolean));
    const cw = cwForMiss(role, miss);
    proposals.push({ type: 'versus', from: miss.topic_id, to: topic_id, by: 'code', source: src, source_ref: miss.id, label: miss.label || null,
      support: { obs_key: missObsKey(user, miss), src, role, w: weightOf(src, role), cw, truth_id: cw > 0 ? miss.topic_id : null, miss_id: miss.id,
        sitting_id: miss.sitting_id ?? null, held: miss.held ? 1 : 0, at: miss.at } });
  }
  return proposals;
}


// Every two-way 'X versus Y' title: [{library, title, num, sides: [[names A], [names B]]}].
export function twoWayTitles(catalogue) {
  const out = [];
  const subjects = (catalogue && catalogue.subjects) || {};
  for (const list of Object.values(subjects)) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.library !== 'string' || !/^[a-z0-9_]{3,60}$/.test(e.library)) continue;
      const sides = titleNames(e.title);
      if (sides) out.push({ library: e.library, title: String(e.title).slice(0, 200), num: (/(\d+)$/.exec(e.library) || [])[1] || e.library, sides });
    }
  }
  return out;
}

export async function fromCatalogue(env, user, { catalogue = null, now = Date.now() } = {}) {
  const cat = catalogue || await deps.ankiCall(env, 'picture_catalogue', {}, { timeoutMs: 20_000 });
  const titles = twoWayTitles(cat);
  const proposals = [], open = [];
  for (const t of titles) {
    const extra = { exact: true, source: 'anking_hy', source_ref: t.library };
    const [a, b] = [await resolveFirst(env, user, t.sides[0], extra), await resolveFirst(env, user, t.sides[1], extra)];
    if (a.topic_id && b.topic_id && a.topic_id !== b.topic_id) {
      proposals.push({ type: 'versus', from: a.topic_id, to: b.topic_id, picture: t.library, by: 'seed', source: 'anking_hy', source_ref: t.library,
        label: `AnKing HY ${t.num}`, support: { obs_key: t.library, src: 'anking_hy', role: 'named', w: W.anking_hy, cw: 0, at: now } });
    } else open.push({ ...t, a: a.topic_id, b: b.topic_id, candidates: [a.candidates || [], b.candidates || []] });
  }
  const plan = proposals.length ? await planLinks(env, user, proposals, { now }) : { rows: [], events: [], links: [], problems: [] };
  const queueRows = await versusQueueRows(env, user, open, now);
  const rows = [...plan.rows, ...queueRows];
  let w = null;
  if (rows.length) {
    w = await deps.writeBatch(env, user, { actor: 'code', surface: 'code', via: 'api:POST /api/map/seed/links-catalogue', rows, events: plan.events, undoable: false });
  }
  const ops = plan.links.reduce((m, l) => ({ ...m, [l.op]: (m[l.op] || 0) + 1 }), {});
  return { titles: titles.length, linked: ops.created || 0, supported: (ops.supported || 0) + (ops.restored || 0), unchanged: ops.unchanged || 0,
    queued: queueRows.length, waiting: open.length, problems: plan.problems.slice(0, 10), batch_id: w && w.batch_id, seq: w && w.seq };
}

// 'versus:<library>' queue items for titles code could not place, made once each.
async function versusQueueRows(env, user, open, now) {
  if (!open.length) return [];
  const { userKey } = await deps.names();
  const id = t => userKey(user, `versus:${t.library}`);
  let have;
  try {
    have = new Set(((await env.DB.prepare('SELECT id FROM topic_queue WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(user, JSON.stringify(open.map(id))).all()).results || []).map(r => r.id));
  } catch (e) { if (noTable(e)) return []; throw e; }
  return open.filter(t => !have.has(id(t))).map(t => ({ table: 'topic_queue', op: 'insert', key: { user_id: user, id: id(t) }, before: null, after: {
    kind: 'versus', label_norm: t.library, label_raw: t.title.slice(0, 200),
    context_json: JSON.stringify({ source: 'anking_hy', picture: t.library, title: t.title, names: [t.sides[0][t.sides[0].length - 1], t.sides[1][0]],
      resolved: [t.a || null, t.b || null] }),
    candidates_json: JSON.stringify(t.candidates.map(c => c.slice(0, 3))), refs: 1, first_seen_at: now, last_seen_at: now, status: 'open', attempts: 0 } }));
}

export async function seedCatalogueRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 400_000);
  if (body.catalogue != null && (typeof body.catalogue !== 'object' || !body.catalogue.subjects)) throw new HttpError(400, 'catalogue is picture_catalogue\'s reply: {subjects: {...}}.');
  try {
    return json(await fromCatalogue(env, user, { catalogue: body.catalogue || null }));
  } catch (e) {
    if (noTable(e)) throw new HttpError(409, 'The map tables are not there yet: apply migration 0010 first.');
    if (e instanceof AnkiError) throw new HttpError(502, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ the versus queue handler

const LINK_SRC_W = { anking_hy: W.anking_hy, onenote: W.onenote, mehlman: W.mehlman };
const createdBy = ctx => (ctx.actor === 'code' ? 'code' : ctx.actor === 'mo' ? 'mo' : 'claude');

// One versus item's argument checked against the topics read: {proposals, skipped} or {problem}.
async function versusProposals(item, arg, topics, ctx, now) {
  if (arg.reject != null) {
    if (typeof arg.reject !== 'string' || !arg.reject.trim() || arg.reject.length > 120) return { problem: 'reject is the reason, at most 120 characters.' };
    return { proposals: [], reject: arg.reject.trim() };
  }
  const links = Array.isArray(arg.links) ? arg.links : [];
  const skips = Array.isArray(arg.skip_pairs) ? arg.skip_pairs : [];
  if (!links.length && !skips.length) return { problem: 'A versus item needs links [{a_topic_id, b_topic_id, fact}], skip_pairs or reject.' };
  if (links.length > 10) return { problem: 'At most 10 links per versus item.' };
  const context = isPlain(item.context) ? item.context : parse(item.context_json, {});
  const src = LINK_SRC_W[context.source] ? context.source : (ctx.actor === 'mo' ? 'mo' : 'claude');
  const base = context.picture || item.label_norm || item.id;
  const live = id => { const t = topics.get(id); return t && t.status !== 'merged' && t.status !== 'retired' ? t : null; };
  const proposals = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i] || {};
    if (typeof l.a_topic_id !== 'string' || typeof l.b_topic_id !== 'string') return { problem: `Link ${i + 1} needs a_topic_id and b_topic_id.` };
    if (l.a_topic_id === l.b_topic_id) return { problem: `Link ${i + 1}: a topic cannot be linked to itself.` };
    if (!live(l.a_topic_id) || !live(l.b_topic_id)) return { problem: `Link ${i + 1}: no live topic has that id.` };
    let a_vs_b = null;
    if (l.fact != null && l.fact !== '') {
      if (typeof l.fact !== 'string' || l.fact.length > 160) return { problem: `Link ${i + 1}: the fact is at most 160 characters.` };
      const v = versusLine(live(l.b_topic_id).name, l.fact);
      if (v.error) return { problem: `Link ${i + 1}: ${v.error}` };
      a_vs_b = v.line;
    }
    proposals.push({ type: 'versus', from: l.a_topic_id, to: l.b_topic_id, a_vs_b, picture: context.picture || null,
      by: createdBy(ctx) === 'mo' ? 'mo' : 'claude', source: src, source_ref: base, label: context.title ? String(context.title).slice(0, 60) : null,
      support: { obs_key: links.length === 1 ? base : `${base}:${i + 1}`, src, role: 'named', w: LINK_SRC_W[src] ?? W[src] ?? W.claude, cw: 0, at: now } });
  }
  return { proposals, skipped: skips.length };
}
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The queue item's own row, resolved or rejected (taxonomy's shape), with its event carrying both copies.
function queueRow(item, ctx, result, status) {
  const before = { status: item.status, resolved_topic_id: item.resolved_topic_id ?? null, resolved_by: item.resolved_by ?? null, result_json: item.result_json ?? null };
  const after = { status, resolved_topic_id: null, resolved_by: createdBy(ctx), result_json: JSON.stringify(result) };
  return {
    row: { table: 'topic_queue', op: 'update', key: { id: item.id }, before, after },
    event: { kind: 'topic.updated', target_type: 'queue', target_id: item.id, topic_id: null, before: { id: item.id, ...before }, after: { id: item.id, ...after },
      summary: `${String(item.label_raw || item.id).slice(0, 100)}: ${status === 'rejected' ? 'not a pair' : 'pairs placed'}` },
  };
}

/**
 * map_resolve on 'versus' items (plan §10.3), as taxonomy's queue.resolve calls every QUEUE_HANDLERS entry:
 * handler(env, user, entries: [{item, arg}], ctx, shared) -> {rows, events, results, problems}. arg is
 * {queue_id, links: [{a_topic_id, b_topic_id, fact? <= 160}], skip_pairs?: [], names?: [{text, topic_id}]} or
 * {queue_id, reject}. All items' links are planned together, so two items naming one pair make one link. Every
 * event carries its own before and after (none relies on pairing with a row).
 */
export async function versusHandler(env, user, entries, ctx = {}, shared = null) {
  const now = ctx.now || Date.now();
  const list = entries || [];
  const topicIds = list.flatMap(e => (Array.isArray(e.arg && e.arg.links) ? e.arg.links : []).flatMap(l => [l && l.a_topic_id, l && l.b_topic_id])).filter(x => typeof x === 'string');
  const state = await readState(env, user, { topicIds });
  const rows = [], events = [], results = [], problems = [], proposals = [];
  const done = [];
  for (const { item, arg } of list) {
    const r = await versusProposals(item, arg || {}, state.topics, ctx, now);
    if (r.problem) { problems.push({ queue_id: item.id, problem: r.problem }); continue; }
    proposals.push(...r.proposals);
    done.push({ item, r });
  }
  const plan = proposals.length ? await planLinks(env, user, proposals, { ...ctx, now, state, undoable: true }) : { rows: [], events: [], links: [], problems: [] };
  if (plan.problems.length) return { rows: [], events: [], results: [], problems: list.map(e => ({ queue_id: e.item.id, problem: plan.problems[0].why })) };
  for (const { item, r } of done) {
    const result = r.reject ? { reject: r.reject } : { links: r.proposals.map(p => [p.from, p.to]), skipped: r.skipped };
    const q = queueRow(item, ctx, result, r.reject ? 'rejected' : 'resolved');
    rows.push(q.row);
    events.push(q.event);
    results.push({ queue_id: item.id, ...(r.reject ? { rejected: true } : { linked: r.proposals.length, skipped: r.skipped }) });
  }
  rows.push(...plan.rows);
  events.push(...plan.events);
  return { rows, events, results, problems };
}

/** One versus item on its own (tests, tools): {rows, events, result, learn} or {problem}. */
export async function resolveVersus(env, user, arg, queueItem, ctx = {}) {
  const item = { ...queueItem, context: isPlain(queueItem && queueItem.context) ? queueItem.context : parse(queueItem && queueItem.context_json, {}) };
  const r = await versusHandler(env, user, [{ item, arg: arg || {} }], ctx);
  if (r.problems.length) return { problem: r.problems[0].problem };
  const learn = (Array.isArray(arg && arg.names) ? arg.names : []).filter(n => n && typeof n.text === 'string' && typeof n.topic_id === 'string').slice(0, 10);
  return { rows: r.rows, events: r.events, learn, result: r.results[0] };
}
