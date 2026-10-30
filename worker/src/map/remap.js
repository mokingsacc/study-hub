import { json, readJson, HttpError } from '../util.js';
import { STEP2_CATEGORIES, CATEGORY_ALIASES, categoryFor } from './vocab.js';
import { S, SYSTEM_IDS_V2, LEGACY, SPLIT, legacySystem, unitSystemFor, topicSystemFor, secondSystemFor, systemByName, systemForWords, tagsOf }
  from './systems.js';
import { priorsFrom, priorUpserts, rereadScores, scoreUpserts } from './weakness.js';
import { PRIOR, DAY_MS } from './weights.js';
import { summaryOf } from './events.js';

export const TARGET = 'taxonomy_remap';
const V2 = new Set(SYSTEM_IDS_V2);
const CHUNK = 300;
const IDS_CHUNK = 900;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const isLegacy = id => id != null && Object.prototype.hasOwnProperty.call(LEGACY, String(id)) && !V2.has(String(id));
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const CAT_COLS = ['name', 'short_name', 'sort', 'cms_subject', 'onenote_section', 'checklist_system', 'status'];

// ---------------------------------------------------------------- reads

/** Everything the remap reads, in one D1 batch. */
export async function readRemap(env, user, { now = Date.now() } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const from = now - PRIOR.days * DAY_MS;
  const reads = [
    q('SELECT id, name, short_name, sort, cms_subject, onenote_section, checklist_system, status FROM categories WHERE user_id = ?1', user),
    q('SELECT vocab, alias_key, alias, category_id, confidence FROM category_aliases WHERE user_id = ?1', user),
    q('SELECT id, num, kind, name, checklist_system, onenote_section, category_id FROM units WHERE user_id = ?1', user),
    q('SELECT id, name, short_name, status, category_id, category2_id, unit_id, oncology, disciplines FROM topics WHERE user_id = ?1', user),
    q('SELECT id, topic_id, category_id, topic_raw, condition_raw, system_raw, label FROM misses WHERE user_id = ?1', user),
    q('SELECT id, topic_id, category_id, miss_id FROM evidence WHERE user_id = ?1', user),
    q(`SELECT id, kind, label_raw, status, context_json FROM topic_queue WHERE user_id = ?1
        AND (json_extract(context_json, '$.category_hint') IS NOT NULL OR json_extract(context_json, '$.category_id') IS NOT NULL)`, user),
    q("SELECT id, scope_ref FROM teach_memory WHERE user_id = ?1 AND scope = 'category'", user),
    q('SELECT user_id, category_id, prior, right_n, n, g, updated_at FROM category_priors WHERE user_id = ?1', user),
    q(`SELECT s.*, tp.name AS topic_name FROM topic_scores s LEFT JOIN topics tp ON tp.user_id = s.user_id AND tp.id = s.topic_id WHERE s.user_id = ?1`, user),
    q(`SELECT id, category_id, CASE WHEN result IN ('right', 'flawed') THEN 1 ELSE 0 END AS right FROM evidence_live WHERE user_id = ?1 AND kind = 'question'
        AND slot = 0 AND at >= ?2 AND result IN ('right', 'flawed', 'wrong', 'omitted')
        AND json_extract(detail_json, '$.from_block') = 1 AND coalesce(json_extract(detail_json, '$.redo'), 0) = 0`, user, from),
  ];
  if (user === 'mo') {
    reads.push(q(`SELECT sum(b.correct) AS correct, sum(b.scored) AS scored FROM blocks b JOIN sittings st ON st.id = b.sitting_id
        WHERE st.status = 'done' AND b.ended_at >= ?1 AND b.scored > 0`, from));
  }
  const res = await env.DB.batch(reads);
  const r = i => (res[i] && res[i].results) || [];
  return {
    categories: r(0), aliases: r(1), units: r(2), topics: r(3), misses: r(4), evidence: r(5), queue: r(6), memory: r(7), priors: r(8),
    scores: r(9), priorSample: r(10), nbme: res[11] ? r(11)[0] || {} : {},
  };
}

// ---------------------------------------------------------------- the pure plan

/**
 * What the remap would do with this data (readRemap's), as a plan: {snapshot, report, scoreRows, priorRows,
 * scoreEvents, count}. Pure apart from now.
 */
export function planRemapData(user, data, { now = Date.now() } = {}) {
  // Units: each into one system.
  const unitOld = new Map(data.units.map(u => [u.id, u.category_id]));
  const unitNew = new Map();
  const units = [];
  for (const u of data.units) {
    const next = isLegacy(u.category_id) ? unitSystemFor(u) || legacySystem(u.category_id) : V2.has(String(u.category_id)) ? u.category_id : unitSystemFor(u) || u.category_id;
    unitNew.set(u.id, next);
    if (next !== u.category_id) units.push([u.id, u.category_id, next]);
  }
  const unitById = new Map(data.units.map(u => [u.id, u]));

  // Topics: system, second home and tags.
  const topicNew = new Map();
  const topics = [], moves = [];
  for (const t of data.topics) {
    const old = t.category_id;
    const { system, why } = topicSystemFor(t, { unitOld: t.unit_id ? unitOld.get(t.unit_id) : null, unitNew: t.unit_id ? unitNew.get(t.unit_id) : null });
    const cat = system || old;
    const cat2 = t.category2_id != null ? secondSystemFor(t, cat) : null;
    const moved = cat !== old || (cat2 ?? null) !== (t.category2_id ?? null);
    const unit = t.unit_id ? { ...unitById.get(t.unit_id) } : null;
    const tags = moved || !Number(t.disciplines) ? tagsOf(t, cat, unit, isLegacy(old) || LEGACY[old] === old ? old : null) : { oncology: Number(t.oncology) || 0, disciplines: Number(t.disciplines) };
    topicNew.set(t.id, cat);
    if (moved || tags.oncology !== (Number(t.oncology) || 0) || tags.disciplines !== (Number(t.disciplines) || 0)) {
      topics.push([t.id, old, t.category2_id ?? null, Number(t.oncology) || 0, Number(t.disciplines) || 0, cat, cat2, tags.oncology, tags.disciplines]);
    }
    if (cat !== old) moves.push({ id: t.id, name: t.name, status: t.status, from: old, to: cat, why });
  }

  // Misses and evidence follow their topic; otherwise their own words or the old category's default.
  const missNew = new Map();
  const groups = (list, pick) => {
    const out = {};
    for (const x of list) {
      const next = pick(x);
      if (next == null || next === x.category_id) continue;
      const k = `${x.category_id ?? ''}>${next}`;
      (out[k] = out[k] || []).push(x.id);
    }
    return out;
  };
  const missSystem = m => {
    if (m.topic_id && topicNew.has(m.topic_id)) return topicNew.get(m.topic_id);
    if (!isLegacy(m.category_id)) return m.category_id;
    const old = String(m.category_id);
    if (SPLIT.includes(old)) {
      const byWords = systemByName(m.condition_raw || '', old) || systemByName(m.topic_raw || '', old);
      if (byWords) return byWords;
      const bySystem = m.system_raw ? categoryFor(m.system_raw) : null;
      if (bySystem && V2.has(String(bySystem.category_id)) && (bySystem.category_ids || [bySystem.category_id]).length === 1) return bySystem.category_id;
    }
    return LEGACY[old];
  };
  for (const m of data.misses) missNew.set(m.id, missSystem(m));
  const misses = groups(data.misses, m => missNew.get(m.id));
  const evidence = groups(data.evidence, e => (e.topic_id && topicNew.has(e.topic_id) ? topicNew.get(e.topic_id)
    : e.miss_id && missNew.has(e.miss_id) ? missNew.get(e.miss_id) : isLegacy(e.category_id) ? LEGACY[e.category_id] : e.category_id));

  // Queue items' hints, and teaching notes scoped to a category.
  const queue = [];
  for (const it of data.queue) {
    const c = parse(it.context_json, {});
    const next = {};
    for (const k of ['category_hint', 'category_id']) {
      if (!isLegacy(c[k])) continue;
      const unitId = it.kind === 'unit' ? c.unit_id : null;
      next[k] = (unitId && unitNew.get(unitId)) || systemForWords(it.label_raw, c[k]);
    }
    if (Object.keys(next).length) queue.push([it.id, c.category_hint ?? null, c.category_id ?? null, next.category_hint ?? c.category_hint ?? null, next.category_id ?? c.category_id ?? null]);
  }
  const memory = data.memory.filter(m => isLegacy(m.scope_ref)).map(m => [m.id, m.scope_ref, LEGACY[m.scope_ref]]);

  // Categories and their names.
  const haveCat = new Map(data.categories.map(c => [c.id, c]));
  const categories = [];
  for (const c of STEP2_CATEGORIES) {
    const want = { ...Object.fromEntries(CAT_COLS.filter(k => k !== 'status').map(k => [k, c[k]])), status: 'active' };
    const cur = haveCat.get(c.id);
    const before = cur ? Object.fromEntries(CAT_COLS.map(k => [k, cur[k] ?? null])) : null;
    if (!cur || CAT_COLS.some(k => (cur[k] ?? null) !== (want[k] ?? null))) categories.push({ id: c.id, before, after: want });
  }
  for (const c of data.categories) {
    if (V2.has(c.id) || c.status === 'retired') continue;
    categories.push({ id: c.id, before: Object.fromEntries(CAT_COLS.map(k => [k, c[k] ?? null])), after: { ...Object.fromEntries(CAT_COLS.map(k => [k, c[k] ?? null])), status: 'retired' } });
  }
  const haveAlias = new Map(data.aliases.map(a => [`${a.vocab}|${a.alias_key}`, a]));
  const aliases = [];
  const wanted = new Set();
  for (const a of CATEGORY_ALIASES) {
    const k = `${a.vocab}|${a.alias_key}`;
    wanted.add(k);
    const cur = haveAlias.get(k);
    const after = { alias: a.alias, category_id: a.category_id, confidence: a.confidence };
    if (!cur) aliases.push({ vocab: a.vocab, alias_key: a.alias_key, before: null, after });
    else if ((cur.category_id ?? null) !== (a.category_id ?? null) || Number(cur.confidence) !== Number(a.confidence)) {
      aliases.push({ vocab: a.vocab, alias_key: a.alias_key, before: { alias: cur.alias, category_id: cur.category_id ?? null, confidence: Number(cur.confidence) }, after: { ...after, alias: cur.alias } });
    }
  }
  for (const a of data.aliases) {   // a name added later that still points at an old category
    if (wanted.has(`${a.vocab}|${a.alias_key}`) || !isLegacy(a.category_id)) continue;
    aliases.push({ vocab: a.vocab, alias_key: a.alias_key, before: { alias: a.alias, category_id: a.category_id, confidence: Number(a.confidence) },
      after: { alias: a.alias, category_id: LEGACY[a.category_id], confidence: Number(a.confidence) } });
  }

  // Priors from the remapped sample, a row for every system, and every stored score re-read.
  const evNew = new Map();
  for (const [k, ids] of Object.entries(evidence)) { const to = k.split('>')[1]; for (const id of ids) evNew.set(id, to); }
  const sample = new Map();
  for (const e of data.priorSample) {
    const cat = evNew.get(e.id) ?? e.category_id;
    if (cat == null) continue;
    const g = sample.get(cat) || { category_id: cat, n: 0, right_n: 0 };
    g.n += 1; g.right_n += Number(e.right) || 0;
    sample.set(cat, g);
  }
  const { priors, g, priorRows } = priorsFrom(user, [...sample.values()], data.nbme, SYSTEM_IDS_V2, now);
  const scoreRows = data.scores.map(s => ({ ...s, topic_category: topicNew.get(s.topic_id) ?? s.category_id }));
  const reread = rereadScores(user, scoreRows, priors, g, now);
  const priorsBefore = data.priors.map(p => ({ user_id: user, category_id: p.category_id, prior: p.prior, right_n: p.right_n, n: p.n, g: p.g, updated_at: p.updated_at }));
  const priorsChanged = JSON.stringify(priorsBefore.map(p => [p.category_id, p.prior, p.n]).sort())
    !== JSON.stringify(priorRows.map(p => [p.category_id, p.prior, p.n]).sort());

  const snapshot = { v: 2, at: now, topics, units, misses, evidence, queue, memory, categories, aliases,
    priors_before: priorsBefore, priors_after: priorsChanged ? priorRows : priorsBefore };
  const n = list => Object.values(list).reduce((a, b) => a + b.length, 0);
  const counts = { topics: topics.length, topics_moved: moves.length, units: units.length, misses: n(misses), evidence: n(evidence), queue: queue.length,
    teach_memory: memory.length, categories: categories.length, aliases: aliases.length, scores: reread.writes.length, priors: priorsChanged ? priorRows.length : 0 };
  const count = Object.values(counts).reduce((a, b) => a + b, 0) - counts.topics_moved;
  return { snapshot, counts, count, moves, priorRows, scoreWrites: reread.writes, scoreEvents: reread.events, priors, g };
}

export function remapReport(plan, data) {
  const names = new Map(STEP2_CATEGORIES.map(c => [c.id, c.name]));
  const oldNames = new Map(data.categories.map(c => [c.id, c.name]));
  const label = id => names.get(id) || oldNames.get(id) || id;
  const unitById = new Map(data.units.map(u => [u.id, u]));
  const byMove = {};
  for (const m of plan.moves) { const k = `${label(m.from)} → ${label(m.to)}`; byMove[k] = (byMove[k] || 0) + 1; }
  const perSystem = {};
  const topicNew = new Map(plan.snapshot.topics.map(t => [t[0], t[5]]));
  for (const t of data.topics) {
    if (!['proposed', 'confirmed'].includes(t.status)) continue;
    const c = topicNew.get(t.id) ?? t.category_id;
    perSystem[c] = (perSystem[c] || 0) + 1;
  }
  const leftOld = data.topics.filter(t => isLegacy(topicNew.get(t.id) ?? t.category_id)).map(t => t.id);
  return {
    systems: STEP2_CATEGORIES.map(c => ({ id: c.id, name: c.name, topics: perSystem[c.id] || 0,
      units: data.units.filter(u => ((plan.snapshot.units.find(x => x[0] === u.id) || [])[2] ?? u.category_id) === c.id).length })),
    counts: plan.counts,
    by_move: Object.entries(byMove).sort((a, b) => b[1] - a[1]).map(([move, n]) => ({ move, n })),
    topics: plan.moves.map(m => ({ id: m.id, name: m.name, status: m.status, from: label(m.from), to: label(m.to), from_id: m.from, to_id: m.to, why: m.why })),
    units: plan.snapshot.units.map(([id, from, to]) => ({ id, name: (unitById.get(id) || {}).name || id, from: label(from), to: label(to) })),
    categories: plan.snapshot.categories.map(c => ({ id: c.id, change: c.before == null ? 'added' : c.after.status === 'retired' ? 'retired' : 'updated', name: c.after.name })),
    left_in_old_ids: leftOld,
  };
}

// ---------------------------------------------------------------- statements (one direction)

const CAT_SQL = `INSERT INTO categories (user_id, id, name, short_name, sort, cms_subject, onenote_section, checklist_system, status, source, created_by, created_at, updated_at)
  SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.short_name'), json_extract(value, '$.sort'),
    json_extract(value, '$.cms_subject'), json_extract(value, '$.onenote_section'), json_extract(value, '$.checklist_system'), json_extract(value, '$.status'),
    'seed', 'seed', ?2, ?2 FROM json_each(?3) WHERE true
  ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name, sort = excluded.sort, cms_subject = excluded.cms_subject,
    onenote_section = excluded.onenote_section, checklist_system = excluded.checklist_system, status = excluded.status, updated_at = excluded.updated_at`;
const ALIAS_SQL = `INSERT INTO category_aliases (user_id, vocab, alias_key, alias, category_id, confidence, source, created_by, created_at)
  SELECT ?1, json_extract(value, '$.vocab'), json_extract(value, '$.alias_key'), json_extract(value, '$.alias'), json_extract(value, '$.category_id'),
    json_extract(value, '$.confidence'), 'seed', 'seed', ?2 FROM json_each(?3) WHERE true
  ON CONFLICT (user_id, vocab, alias_key) DO UPDATE SET category_id = excluded.category_id, confidence = excluded.confidence`;

/**
 * The statements that move every value of a snapshot one way: dir 'forward' (old -> v2) or 'back' (v2 -> old).
 * Each moved column changes only where it still holds what the other side left, so a row changed since is kept.
 */
export function directionStatements(env, user, snap, dir, now = Date.now()) {
  const DB = env.DB;
  const fwd = dir === 'forward';
  const out = [];
  // Topics: [id, c, c2, onc, disc, nc, nc2, nonc, ndisc].
  const topicRows = snap.topics.map(t => (fwd
    ? { k: t[0], w: t[1], c: t[5], c2: t[6], o: t[7], d: t[8] }
    : { k: t[0], w: t[5], c: t[1], c2: t[2], o: t[3], d: t[4] }));
  for (const part of chunk(topicRows, CHUNK)) {
    out.push(DB.prepare(`UPDATE topics SET category_id = json_extract(j.value, '$.c'), category2_id = json_extract(j.value, '$.c2'),
        oncology = json_extract(j.value, '$.o'), disciplines = json_extract(j.value, '$.d')
      FROM json_each(?2) AS j WHERE topics.user_id = ?1 AND topics.id = json_extract(j.value, '$.k') AND topics.category_id IS json_extract(j.value, '$.w')`)
      .bind(user, JSON.stringify(part)));
  }
  const pairs = (rows, table, key) => {
    const list = rows.map(r => (fwd ? { k: r[0], w: r[1], c: r[2] } : { k: r[0], w: r[2], c: r[1] }));
    for (const part of chunk(list, CHUNK)) {
      out.push(DB.prepare(`UPDATE ${table} SET ${key} = json_extract(j.value, '$.c') FROM json_each(?2) AS j
        WHERE ${table}.user_id = ?1 AND ${table}.id = json_extract(j.value, '$.k') AND ${table}.${key} IS json_extract(j.value, '$.w')`).bind(user, JSON.stringify(part)));
    }
  };
  pairs(snap.units, 'units', 'category_id');
  pairs(snap.memory, 'teach_memory', 'scope_ref');
  // Misses and evidence, grouped as {"old>new": [ids]}.
  const grouped = (groups, table) => {
    for (const [k, ids] of Object.entries(groups)) {
      const [a, b] = k.split('>');
      const was = fwd ? (a === '' ? null : a) : b;
      const to = fwd ? b : (a === '' ? null : a);
      for (const part of chunk(ids, IDS_CHUNK)) {
        out.push(DB.prepare(`UPDATE ${table} SET category_id = ?2 WHERE user_id = ?1 AND category_id IS ?3 AND id IN (SELECT value FROM json_each(?4))`)
          .bind(user, to, was, JSON.stringify(part)));
      }
    }
  };
  grouped(snap.misses, 'misses');
  grouped(snap.evidence, 'evidence');
  // Queue hints: [id, hint, cid, new hint, new cid].
  const qRows = snap.queue.map(r => (fwd ? { k: r[0], h: r[3], c: r[4], wh: r[1], wc: r[2] } : { k: r[0], h: r[1], c: r[2], wh: r[3], wc: r[4] }));
  for (const part of chunk(qRows, CHUNK)) {
    out.push(DB.prepare(`UPDATE topic_queue SET context_json = json_set(context_json,
        '$.category_hint', json_extract(j.value, '$.h'), '$.category_id', json_extract(j.value, '$.c'))
      FROM json_each(?2) AS j WHERE topic_queue.user_id = ?1 AND topic_queue.id = json_extract(j.value, '$.k')
        AND json_extract(topic_queue.context_json, '$.category_hint') IS json_extract(j.value, '$.wh')
        AND json_extract(topic_queue.context_json, '$.category_id') IS json_extract(j.value, '$.wc')`).bind(user, JSON.stringify(part)));
  }
  // json_set leaves a null where the key was absent; take those keys back out.
  if (qRows.length) {
    out.push(DB.prepare(`UPDATE topic_queue SET context_json = json_remove(context_json, '$.category_hint') WHERE user_id = ?1
      AND id IN (SELECT value FROM json_each(?2)) AND json_type(context_json, '$.category_hint') = 'null'`).bind(user, JSON.stringify(qRows.map(r => r.k))));
    out.push(DB.prepare(`UPDATE topic_queue SET context_json = json_remove(context_json, '$.category_id') WHERE user_id = ?1
      AND id IN (SELECT value FROM json_each(?2)) AND json_type(context_json, '$.category_id') = 'null'`).bind(user, JSON.stringify(qRows.map(r => r.k))));
  }
  // Categories: forward writes each one's after; back its before, and retires one the remap added.
  const catRows = snap.categories.map(c => {
    const side = fwd ? c.after : c.before;
    return side ? { id: c.id, ...side } : { id: c.id, ...c.after, status: 'retired' };
  });
  for (const part of chunk(catRows, CHUNK)) out.push(DB.prepare(CAT_SQL).bind(user, now, JSON.stringify(part)));
  // Aliases: forward upserts each after; back puts the before back, and deletes one the remap added.
  const aliasSet = snap.aliases.filter(a => (fwd ? a.after : a.before)).map(a => ({ vocab: a.vocab, alias_key: a.alias_key, ...(fwd ? a.after : a.before) }));
  for (const part of chunk(aliasSet, CHUNK)) out.push(DB.prepare(ALIAS_SQL).bind(user, now, JSON.stringify(part)));
  const aliasGone = fwd ? [] : snap.aliases.filter(a => !a.before).map(a => `${a.vocab}|${a.alias_key}`);
  for (const part of chunk(aliasGone, CHUNK)) {
    out.push(DB.prepare(`DELETE FROM category_aliases WHERE user_id = ?1 AND vocab || '|' || alias_key IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(part)));
  }
  // Priors: the side's rows, and nothing else.
  const rows = fwd ? snap.priors_after : snap.priors_before;
  out.push(DB.prepare('DELETE FROM category_priors WHERE user_id = ?1 AND category_id NOT IN (SELECT value FROM json_each(?2))')
    .bind(user, JSON.stringify(rows.map(p => p.category_id))));
  out.push(...priorUpserts(DB, rows.map(p => ({ ...p, user_id: user }))));
  return out;
}

// ---------------------------------------------------------------- the change

export async function planRemap(env, user, args, ctx) {
  let data;
  try { data = await readRemap(env, user, { now: ctx.now }); } catch (e) {
    if (noTable(e)) return { refuse: 'The map is not set up yet (migrations 0010 to 0012 first).' };
    throw e;
  }
  const plan = planRemapData(user, data, { now: ctx.now });
  if (!plan.count) return { noop: true, summary: `Every topic is already in the ${STEP2_CATEGORIES.length} systems.` };
  const summary = summaryOf(`Taxonomy v2: ${plan.counts.topics_moved} topics and ${plan.counts.units} units moved into the ${STEP2_CATEGORIES.length} systems`);
  return {
    rows: [], count: plan.count, summary,
    events: [{ kind: 'map.resync', target_type: TARGET, target_id: 'v2', summary }],
    remap: plan, data,
  };
}

/** apply for 'taxonomy.remap': the forward statements, the scores and the one event, in one writeBatch. */
export async function applyRemap(env, user, checked, ctx) {
  const plan = checked.remap;
  const { writeBatch } = await import('./events.js');
  const statements = [...directionStatements(env, user, plan.snapshot, 'forward', ctx.now), ...scoreUpserts(env.DB, plan.scoreWrites, { cas: true })];
  const summary = checked.summary;
  const events = [
    { kind: 'map.resync', target_type: TARGET, target_id: 'v2', summary, before: plan.snapshot, after: { dir: 'forward', counts: plan.counts }, undoable: true },
    ...plan.scoreEvents.map(e => ({ ...e, undoable: false })),
  ];
  const w = await writeBatch(env, user, { batch_id: ctx.batch_id, actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said,
    request_id: ctx.request_id, statements, events, undoable: true });
  return { ok: true, batch_id: w.batch_id, seq: w.seq, summary, undo_hint: 'Say "undo that" to reverse it.', counts: plan.counts };
}

/**
 * UNDO 'target:taxonomy_remap': moves every value of the snapshot back (or, undoing an undo, forward again), reads
 * the stored scores again with that side's priors, and writes its own map.resync event so open pages refetch.
 */
export async function undoRemap(env, user, e, ctx) {
  const snap = parse(e.before_json, null);
  const was = (parse(e.after_json, {}) || {}).dir || 'forward';
  if (!snap || snap.v !== 2) return { conflict: "That change can't be undone automatically." };
  const dir = was === 'forward' ? 'back' : 'forward';
  const now = ctx.now || Date.now();
  const statements = directionStatements(env, user, snap, dir, now);
  // Scores: each topic's category on this side, with this side's priors.
  const target = new Map(snap.topics.map(t => [t[0], dir === 'forward' ? t[5] : t[1]]));
  const priorRows = dir === 'forward' ? snap.priors_after : snap.priors_before;
  const priors = Object.fromEntries(priorRows.map(p => [p.category_id, Number(p.prior)]));
  const g = priorRows.length ? Number(priorRows[0].g) : null;
  const stored = (await env.DB.prepare(`SELECT s.*, tp.name AS topic_name, tp.category_id AS topic_now FROM topic_scores s
      LEFT JOIN topics tp ON tp.user_id = s.user_id AND tp.id = s.topic_id WHERE s.user_id = ?1`).bind(user).all()).results || [];
  const reread = rereadScores(user, stored.map(s => ({ ...s, topic_category: target.get(s.topic_id) ?? s.topic_now ?? s.category_id })), priors, g, now);
  statements.push(...scoreUpserts(env.DB, reread.writes, { cas: true }));
  const summary = summaryOf(dir === 'back' ? 'Back to the 19 categories of release 1' : `Taxonomy v2 again: ${snap.topics.length} topics into the ${STEP2_CATEGORIES.length} systems`);
  statements.push(env.DB.prepare(`INSERT INTO map_events (user_id, at, actor, surface, via, kind, target_type, target_id, topic_id, summary, before_json, after_json,
      batch_id, source, source_ref, undoable, undo_of, mo_said, request_id)
    VALUES (?1, ?2, ?3, ?4, ?5, 'map.resync', ?6, 'v2', NULL, ?7, ?8, ?9, ?10, NULL, NULL, 1, ?11, NULL, NULL) RETURNING seq`)
    .bind(user, now, ctx.actor || 'mo', ctx.surface || null, ctx.via || null, TARGET, summary, e.before_json,
      JSON.stringify({ dir, counts: { topics: snap.topics.length, units: snap.units.length } }), ctx.undo_batch_id, ctx.batch_id));
  return { statements };
}

// ---------------------------------------------------------------- route

export async function remapRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000);
  const apply = body && body.apply === true;
  if (body && body.apply != null && typeof body.apply !== 'boolean') throw new HttpError(400, 'apply is true or false.');
  let data;
  try { data = await readRemap(env, user); } catch (e) {
    if (noTable(e)) throw new HttpError(409, 'The map is not set up yet (migrations 0010 to 0012 first).');
    throw e;
  }
  const plan = planRemapData(user, data);
  const report = remapReport(plan, data);
  if (!apply) return json({ dry_run: true, nothing_to_do: plan.count === 0, ...report });
  const { applyChange, changeResponse } = await import('./change.js');
  const r = await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'taxonomy.remap', args: {}, via: 'api:POST /api/map/remap' });
  if (r.refused || r.needs_confirm) return changeResponse(r);
  return json({ dry_run: false, ...r, systems: report.systems, by_move: report.by_move });
}

export { S };
