import { norm, slug, slugId, userKey, isCut, isDiscriminatorDiff } from '../../../public/js/shared/names.js';
import { TOPIC_KINDS, NAME_MAX, CATEGORY_IDS, namingProblem, laneFor, splitUnit } from './vocab.js';
import { unitSystemFor, systemForWords, systemByName, sectionId, tagsOf, LEGACY, SPLIT, D } from './systems.js';
import { topicYield, unitLane, ankingCounts, refreshYield } from './yield.js';
import { fetchAliases, liveTopic, searchTopics, requeueAfter, resolveCategory } from './resolve.js';
import { queueHandlers } from './registry/index.js';
import { ambossUrlOk, cueLooksLikeStem, looksLikeQuestionText, GAP_LEFT_OUT } from './guard.js';
import { placeRows } from './queue.js';
import { SOFT, softFields } from './events.js';
import { lookalikeProposals } from './links-ingest.js';
import { planLinks } from './links-store.js';
import { HttpError, json, readJson, londonDay } from '../util.js';

export const TOPIC_STATUSES = ['proposed', 'confirmed', 'merged', 'retired'];
export const ALIAS_KINDS = ['name', 'abbrev', 'british', 'synonym', 'uworld_label', 'truncated', 'log_topic', 'analysis_topic', 'gap_topic',
  'tally_condition', 'amboss_title', 'nbme_term', 'merge', 'typo'];
export const GIVEN_ALIAS_KINDS = ALIAS_KINDS.filter(k => !['name', 'merge'].includes(k));
export const QUEUE_KINDS = ['label', 'gap', 'card', 'lookalike', 'unit', 'versus', 'review_row'];
export const MAX_TOPICS = 25, MAX_TOPICS_RUN = 50, MAX_ITEMS = 25, MAX_ITEMS_RUN = 50, MAX_ALIASES = 10;
export const AUTO_CONFIRM_DAYS = 7;
const DAY = 86_400_000;
const LANE_RANK = { A: 3, B: 2, C: 1 };
const KIND_WORDS = /\s(disease|syndrome|disorder)$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const uniq = list => [...new Set(list)];
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const createdBy = ctx => (ctx.actor === 'code' ? 'code' : ctx.actor === 'mo' ? 'mo' : 'claude');
const sourceOf = ctx => (ctx.run_id ? 'seed' : ctx.actor === 'code' ? 'code' : ctx.actor === 'mo' ? 'hub' : 'claude');
// The topic id a queue item or a user's key carries, without the user prefix.
const unprefix = (user, id) => (user === 'mo' ? String(id) : String(id).replace(new RegExp(`^${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), ''));

// An event's before and after from its row, as events.js eventRow fills them, so a part's events stay right
// wherever its rows land in the merged change (other areas' parts may carry more rows than events).
function pin(e, r) {
  if (!r || e.before !== undefined) return e;
  const before = r.before == null ? null : { ...r.key, ...r.before };
  const emptySoft = r.op === 'soft_delete' && !(isObj(r.after) && Object.keys(r.after).length);
  const after = r.op === 'delete' || (emptySoft && !SOFT[r.table]) ? null : { ...r.key, ...(emptySoft ? softFields(r.table) : r.after || {}) };
  return { ...e, before, after };
}
export const pinned = part => ({ rows: (part && part.rows) || [], events: ((part && part.events) || []).map((e, i) => pin(e, ((part && part.rows) || [])[i])) });

class Problem extends Error {}
const problem = msg => { throw new Problem(msg); };

// ---------------------------------------------------------------- reads shared by the planners

// The categories this user has (the seeded vocabulary, else the step2 constants before the seed has run).
async function categoryIds(env, user) {
  try {
    const rows = (await env.DB.prepare(`SELECT id FROM categories WHERE user_id = ? AND status = 'active'`).bind(user).all()).results || [];
    return new Set(rows.length ? rows.map(r => r.id) : CATEGORY_IDS);
  } catch (e) { if (noTable(e)) return new Set(CATEGORY_IDS); throw e; }
}

async function rowsByIds(env, user, table, cols, ids) {
  if (!ids.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(uniq(ids.map(String)))).all()).results || [];
  return new Map(rows.map(r => [r.id, r]));
}
const TOPIC_COLS = 'id, name, short_name, kind, status, merged_into, suspect_dupe_of, category_id, category2_id, unit_id, parent_id, amboss_url, amboss_src, amboss_checked_at, yield, yield_json, q_seen, anking_cards, mehlman_match, nbme_images_own, confirmed_at, confirmed_by, created_at, updated_at, oncology, disciplines';
const UNIT_COLS = 'id, num, kind, name, lane, mehlman_rank, category_id, onenote_section, checklist_system, nbme_images, yield, yield_json, locked_json';

// The tags a topic carries (taxonomy v2): oncology 0 or 1, disciplines as systems.js D bits (1 to 31).
const ALL_DISC = Object.values(D).reduce((a, b) => a | b, 0);
function givenTags(spec) {
  const out = {};
  if (spec.oncology != null) { if (![0, 1, true, false].includes(spec.oncology)) problem('oncology is true or false.'); out.oncology = spec.oncology ? 1 : 0; }
  if (spec.disciplines != null) {
    const bits = Array.isArray(spec.disciplines) ? spec.disciplines.reduce((a, k) => (D[k] ? a | D[k] : problem(`disciplines are ${Object.keys(D).join(', ')}.`)), 0) : spec.disciplines;
    if (!Number.isInteger(bits) || bits < 1 || (bits & ~ALL_DISC)) problem(`disciplines are ${Object.keys(D).join(', ')}.`);
    out.disciplines = bits;
  }
  return out;
}
/** A new topic's system: the one given (an old category id read as its system, split by the name), else its unit's. */
export function newTopicSystem(name, given, unit, cats = null) {
  if (given != null) {
    const g = String(given);
    if (!cats || cats.has(g)) return g;
    if (LEGACY[g]) { const sys = systemForWords(name, g); if (!cats || cats.has(sys)) return sys; }
    return g;
  }
  if (!unit) return null;
  const section = sectionId(unit.onenote_section);
  return (section && SPLIT.includes(section) && systemByName(name, section)) || unit.category_id || unitSystemFor(unit);
}

// A topic named by id, or by any of its names; refuses when the name is ambiguous.
async function findTopic(env, user, ref) {
  if (ref == null || String(ref).trim() === '') problem('Say which topic (its id or name).');
  const t = await liveTopic(env, user, String(ref).trim());
  if (t) return (await rowsByIds(env, user, 'topics', TOPIC_COLS, [t.id])).get(t.id);
  const raw = (await rowsByIds(env, user, 'topics', 'id, name, status', [String(ref).trim()])).get(String(ref).trim());
  if (raw) problem(`${raw.name} is ${raw.status}; change the topic it went to instead.`);
  const { byKey } = await fetchAliases(env, user, [norm(ref)]);
  const hits = byKey.get(norm(ref)) || [];
  if (hits.length > 1) problem(`"${ref}" names ${hits.length} topics (${hits.map(h => h.id).join(', ')}); use the id.`);
  if (!hits.length) problem(`No topic is called "${ref}". Look it up with map_search.`);
  return (await rowsByIds(env, user, 'topics', TOPIC_COLS, [hits[0].id])).get(hits[0].id);
}

// ---------------------------------------------------------------- row and event builders

const ev = (kind, target_type, target_id, topic_id, summary, extra = {}) => ({ kind, target_type, target_id, topic_id: topic_id ?? null, summary: String(summary).slice(0, 160), ...extra });

function aliasRow(topicId, alias, kind, ctx, existing = null) {
  const key = { alias_key: norm(alias), topic_id: topicId };
  if (existing) return { table: 'topic_aliases', op: 'update', key, before: { status: existing.status, kind: existing.kind }, after: { status: 'active', kind } };
  return { table: 'topic_aliases', op: 'insert', key, before: null, after: { alias: String(alias).trim(), kind, status: 'active', source: sourceOf(ctx), created_by: createdBy(ctx), created_at: ctx.now } };
}

export function betterUnit(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const la = LANE_RANK[unitLane(a)] || 0, lb = LANE_RANK[unitLane(b)] || 0;
  if (la !== lb) return la > lb ? a : b;
  const ra = a.mehlman_rank ?? 1e9, rb = b.mehlman_rank ?? 1e9;
  return rb < ra ? b : a;
}

export function suspectDupe(name, others) {
  const k = norm(name);
  const bare = k.replace(KIND_WORDS, '');
  for (const o of others) {
    const ok = norm(o.name);
    if (ok === k) continue;
    if (bare && ok.replace(KIND_WORDS, '') === bare) return o.id;
    const [s, l] = k.length < ok.length ? [k, ok] : [ok, k];
    if (l.split(' ').length !== s.split(' ').length + 1 || isDiscriminatorDiff(s, l)) continue;
    const extra = l.startsWith(s + ' ') ? l.slice(s.length + 1) : l.endsWith(' ' + s) ? l.slice(0, l.length - s.length - 1) : null;
    if (extra && EMPTY_WORDS.has(extra)) return o.id;
  }
  return null;
}
// Words that never make a finer topic ('Crohn' and 'Crohn disease', 'Lyme' and 'Lyme infection').
const EMPTY_WORDS = new Set(['disease', 'syndrome', 'disorder', 'infection', 'condition', 'illness', 'disease process']);

// What new topics and learned names need read, in three queries: {cats, units, topics, aliases (live hits by key),
// aliasRows (every alias row by key, any status, so a removed one is revived, never inserted twice), catTopics}.
async function loadForNew(env, user, specs, extraKeys = []) {
  const nameKeys = uniq([...specs.flatMap(s => [norm(s.name), ...(Array.isArray(s.aliases) ? s.aliases : []).map(a => norm(isObj(a) ? a.alias : a)), s.short_name ? norm(s.short_name) : null]),
    ...extraKeys.map(norm)].filter(Boolean));
  const ids = specs.flatMap(s => [slugId(user, s.name || ''), s.parent_id]).filter(Boolean);
  const unitIds = specs.map(s => s.unit_id).filter(Boolean);
  const cats = uniq(specs.map(s => s.category_id).filter(Boolean));
  const [catSet, aliases, batch] = await Promise.all([
    categoryIds(env, user),
    fetchAliases(env, user, nameKeys),
    env.DB.batch([
      env.DB.prepare(`SELECT ${UNIT_COLS} FROM units WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(uniq(unitIds))),
      env.DB.prepare(`SELECT id, name, status, category_id FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(uniq(ids))),
      env.DB.prepare(`SELECT id, name, category_id FROM topics WHERE user_id = ? AND status IN ('proposed','confirmed') AND category_id IN (SELECT value FROM json_each(?)) LIMIT 2000`)
        .bind(user, JSON.stringify(cats)),
      env.DB.prepare(`SELECT alias_key, topic_id, kind, status FROM topic_aliases WHERE user_id = ? AND alias_key IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(nameKeys)),
    ]),
  ]);
  const [u, t, ct, ar] = batch.map(r => r.results || []);
  const aliasRows = new Map();
  for (const r of ar) aliasRows.set(`${r.alias_key}|${r.topic_id}`, r);
  return { cats: catSet, units: new Map(u.map(r => [r.id, r])), topics: new Map(t.map(r => [r.id, r])), aliases: aliases.byKey, aliasRows, catTopics: ct };
}

// An AMBOSS link for a new topic: the URL given (checked), an article title Claude names, else a guess from the name.
function ambossFor(spec, ctx) {
  if (spec.amboss_url != null) {
    if (!ambossUrlOk(spec.amboss_url) || !/amboss\.com\/us\/(knowledge|article)\//.test(spec.amboss_url)) problem('amboss_url must be an AMBOSS US article link (amboss.com/us/knowledge/...).');
    return { amboss_url: spec.amboss_url, amboss_src: ctx.actor === 'mo' ? 'mo' : 'claude', amboss_checked_at: ctx.actor === 'mo' ? ctx.now : null };
  }
  if (spec.amboss_title != null) {
    if (typeof spec.amboss_title !== 'string' || !slug(spec.amboss_title)) problem('amboss_title is the article title, such as "Pituitary adenoma".');
    return { amboss_url: `https://www.amboss.com/us/knowledge/${slug(spec.amboss_title)}`, amboss_src: ctx.actor === 'mo' ? 'mo' : 'claude', amboss_checked_at: null };
  }
  return { amboss_url: `https://www.amboss.com/us/knowledge/${slug(spec.name)}`, amboss_src: 'guess', amboss_checked_at: null };
}

// The given aliases as [{alias, kind}], checked (at most 10, each at most 80 characters, a known kind).
function givenAliases(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_ALIASES) problem(`aliases is a list of at most ${MAX_ALIASES} names.`);
  return list.map(a => {
    const alias = isObj(a) ? a.alias : a;
    const kind = isObj(a) && a.kind ? a.kind : 'synonym';
    if (typeof alias !== 'string' || !alias.trim() || alias.length > NAME_MAX) problem(`Each alias is a name of at most ${NAME_MAX} characters.`);
    if (!GIVEN_ALIAS_KINDS.includes(kind)) problem(`Alias kind must be one of ${GIVEN_ALIAS_KINDS.join(', ')}.`);
    return { alias: alias.trim(), kind };
  });
}

/**
 * One new topic: {rows, events, created, existing?}. Checks the naming rule, the category, unit and parent,
 * and that no live topic already has the name (then it returns {existing} and creates nothing).
 * data is loadForNew's, plus taken (ids and keys used earlier in the same change).
 */
export function buildNewTopic(user, spec, ctx, data, { status = null } = {}) {
  if (!isObj(spec)) problem('Each new topic is {name, kind, category_id, ...}.');
  const reason = namingProblem(spec.name, spec.kind);
  if (reason) problem(reason);
  if (!TOPIC_KINDS.includes(spec.kind)) problem(`kind must be one of ${TOPIC_KINDS.join(', ')}.`);
  // An old category id (release 1's 19) is read as the system it became, split by the condition's name.
  if (spec.category_id != null && !data.cats.has(spec.category_id) && LEGACY[spec.category_id]) spec = { ...spec, category_id: newTopicSystem(spec.name, spec.category_id, null, data.cats) };
  if (spec.category2_id != null && !data.cats.has(spec.category2_id) && LEGACY[spec.category2_id]) spec = { ...spec, category2_id: newTopicSystem(spec.name, spec.category2_id, null, data.cats) };
  if (!data.cats.has(spec.category_id)) problem(`Unknown category_id "${spec.category_id}"; the categories are ${[...data.cats].join(', ')}.`);
  if (spec.category2_id != null && (!data.cats.has(spec.category2_id) || spec.category2_id === spec.category_id)) problem('category2_id must be a different known category.');
  if (spec.short_name != null && (typeof spec.short_name !== 'string' || !spec.short_name.trim() || spec.short_name.length > 20)) problem('short_name is the abbreviation, at most 20 characters.');
  const unit = spec.unit_id != null ? data.units.get(spec.unit_id) : null;
  if (spec.unit_id != null && !unit) problem(`Unknown unit_id "${spec.unit_id}".`);
  if (spec.parent_id != null && !data.topics.has(spec.parent_id) && !data.taken.ids.has(spec.parent_id)) problem(`Unknown parent_id "${spec.parent_id}".`);
  const key = norm(spec.name);
  const hit = (data.aliases.get(key) || [])[0] || data.taken.keys.get(key);
  if (hit) return { rows: [], events: [], existing: { id: hit.id, name: hit.name, category_id: hit.category_id ?? null, via: 'alias' } };
  const aliases = givenAliases(spec.aliases);
  for (const a of [...aliases, ...(spec.short_name ? [{ alias: spec.short_name.trim() }] : [])]) {
    const owner = nameOwner(data.aliases, norm(a.alias));
    if (owner) problem(clashProblem(a.alias, owner, spec.name));
  }

  let id = slugId(user, spec.name);
  for (let n = 2; data.topics.has(id) || data.taken.ids.has(id); n++) id = `${slugId(user, spec.name)}-${n}`;
  const want = status || spec.status || 'proposed';
  if (!['proposed', 'confirmed'].includes(want)) problem('A new topic is proposed or confirmed.');
  const confirmed = want === 'confirmed' && (ctx.actor !== 'claude' || ctx.run_id || ctx.mo_said || status === 'confirmed');
  const dupe = suspectDupe(spec.name, data.catTopics.filter(t => t.category_id === spec.category_id).concat([...data.taken.created].filter(t => t.category_id === spec.category_id)));
  const y = topicYield({ q_seen: 0, anking_cards: 0 }, unit);
  const tags = { ...tagsOf(spec, spec.category_id, unit), ...givenTags(spec) };
  const after = {
    name: spec.name, short_name: spec.short_name ? spec.short_name.trim() : null, kind: spec.kind, status: confirmed ? 'confirmed' : 'proposed',
    suspect_dupe_of: dupe, category_id: spec.category_id, category2_id: spec.category2_id ?? null, unit_id: spec.unit_id ?? null, parent_id: spec.parent_id ?? null,
    ...ambossFor(spec, ctx), yield: y.yield, yield_json: JSON.stringify(y.json), exam_profile: 'step2', source: sourceOf(ctx), source_ref: spec.source_ref ?? null,
    created_by: createdBy(ctx), created_at: ctx.now, updated_at: ctx.now, confirmed_at: confirmed ? ctx.now : null, confirmed_by: confirmed ? createdBy(ctx) : null,
    oncology: tags.oncology, disciplines: tags.disciplines,
  };
  const rows = [{ table: 'topics', op: 'insert', key: { id }, before: null, after }];
  const events = [ev('topic.added', 'topic', id, id, `New topic ${spec.name} (${spec.category_id}${after.status === 'proposed' ? ', proposed' : ''})`)];
  if (unit) {
    rows.push({ table: 'unit_topics', op: 'insert', key: { unit_id: unit.id, topic_id: id }, before: null, after: { role: 'primary', source: sourceOf(ctx), created_by: createdBy(ctx), created_at: ctx.now } });
    events.push(ev('unit.updated', 'unit_topic', `${unit.id}:${id}`, id, `${spec.name} sits in unit ${unit.name}`.slice(0, 160)));
  }
  const names = [{ alias: spec.name, kind: 'name' }, ...(spec.short_name ? [{ alias: spec.short_name.trim(), kind: 'abbrev' }] : []), ...aliases];
  const seen = new Set();
  for (const a of names) {
    const k = norm(a.alias);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    rows.push(aliasRow(id, a.alias, a.kind, ctx));
    events.push(ev('alias.added', 'alias', `${k}|${id}`, id, `"${a.alias}" names ${spec.name}`));
  }
  const created = { id, name: spec.name, status: after.status, category_id: spec.category_id, ...(dupe ? { suspect_dupe_of: dupe } : {}) };
  data.taken.ids.add(id);
  for (const k of seen) data.taken.keys.set(k, { id, name: spec.name, category_id: spec.category_id });
  data.taken.created.add(created);
  return { rows, events, created, dupe: dupe ? ev('topic.dupe_suspected', 'topic', id, id, `${spec.name} may be the same as ${dupe}`, { undoable: false }) : null };
}

const freshTaken = () => ({ ids: new Set(), keys: new Map(), created: new Set() });

/**
 * Another live topic whose own name is this key, or null (B4-2). An alias equal to it would leave the name naming
 * neither topic (both score 0.6), so every later miss, gap or card with that name would wait in the queue.
 * byKey is fetchAliases' (hits carry alias_kind); an abbreviation two topics share is not a name, so it stays allowed.
 */
export function nameOwner(byKey, key, topicId = null) {
  return ((byKey && byKey.get(key)) || []).find(h => h.id !== topicId && h.alias_kind === 'name') || null;
}

export const LABEL_NAME_WORDS = 6;
/** Why this label is not a name (a colon, "vs" or "versus", more than 6 words), or null. */
export function labelNotAName(raw) {
  const s = String(raw ?? '').trim();
  if (s.includes(':')) return 'it has a colon';
  if (/\s(?:vs\.?|versus)\s/i.test(` ${s} `)) return 'it compares two things';
  if (s.split(/\s+/).filter(Boolean).length > LABEL_NAME_WORDS) return `it is longer than ${LABEL_NAME_WORDS} words`;
  return null;
}
/** Every run of whole words inside a key, the whole key left out ("diabetic nephropathy causing hypertension" -> "diabetic", …). */
export function innerSpans(key) {
  const w = String(key || '').split(' ').filter(Boolean);
  if (w.length > LABEL_NAME_WORDS) return [];
  const out = [];
  for (let i = 0; i < w.length; i++) for (let j = i + 1; j <= w.length; j++) if (j - i < w.length) out.push(w.slice(i, j).join(' '));
  return uniq(out);
}
/** Another live topic whose own name is a run of words inside this key (byKey must hold innerSpans(key)), or null. */
export function spanOwner(byKey, key, topicId = null) {
  for (const k of innerSpans(key)) { const o = nameOwner(byKey, k, topicId); if (o) return o; }
  return null;
}
/** Why a queue label is not learned as a name of topicId, or null: labelNotAName, or it holds another topic's name. */
export function labelAliasProblem(byKey, raw, key, topicId) {
  const why = labelNotAName(raw);
  if (why) return why;
  const o = spanOwner(byKey, key, topicId);
  return o ? `it holds the name of ${o.name}` : null;
}

const clashProblem = (alias, owner, name) => `"${alias}" already names ${owner.name} (${owner.id}), so it cannot name ${name || 'this topic'} too. `
  + `If they are the same condition, retire ${owner.name} first (it asks Mo), then add its name here.`;

// ---------------------------------------------------------------- topic.add

/** Planner for topic.add: {topics: [1..25 (50 in an import run)], reason?}. */
export async function planTopicAdd(env, user, args, ctx) {
  const list = Array.isArray(args.topics) ? args.topics : isObj(args.topic) ? [args.topic] : null;
  const max = ctx.run_id ? MAX_TOPICS_RUN : MAX_TOPICS;
  if (!list || !list.length || list.length > max) return { refuse: `topics is a list of 1 to ${max} new topics.`, field: 'topics' };
  const data = { ...(await loadForNew(env, user, list)), taken: freshTaken() };
  const rows = [], events = [], dupes = [], created = [], existing = [];
  for (let i = 0; i < list.length; i++) {
    let r;
    try { r = buildNewTopic(user, list[i], ctx, data); } catch (e) {
      if (e instanceof Problem) return { refuse: list.length > 1 ? `Topic ${i + 1} (${(list[i] && list[i].name) || 'no name'}): ${e.message}` : e.message, field: `topics[${i}]` };
      throw e;
    }
    if (r.existing) { existing.push({ name: list[i].name, existing: r.existing }); continue; }
    rows.push(...r.rows); events.push(...r.events); created.push(r.created);
    if (r.dupe) dupes.push(r.dupe);
  }
  if (!created.length) return { noop: true, summary: `Already on the map: ${existing.map(e => `${e.existing.name} (${e.existing.id})`).join(', ')}`.slice(0, 300) };
  const summary = created.length === 1 ? `New topic ${created[0].name}` : `${created.length} new topics: ${created.slice(0, 4).map(c => c.name).join(', ')}${created.length > 4 ? '…' : ''}`;
  return { rows, events: [...events, ...dupes], count: created.length, summary: summary.slice(0, 160),
    reply: { created, ...(existing.length ? { existing } : {}) } };
}

// ---------------------------------------------------------------- topic.update, topic.retire, topic.confirm, aliases

const SET_KEYS = ['name', 'short_name', 'kind', 'category_id', 'category2_id', 'unit_id', 'parent_id', 'status', 'amboss_url', 'amboss_checked',
  'aliases_add', 'aliases_remove', 'cards_add', 'oncology', 'disciplines'];

// The rows that send a retired topic's misses and gaps back to the queue, their evidence with them. Their events
// are on targets 'retired_miss' and 'retired_gap', whose undo (undoRetiredRow) puts the row and its evidence back.
async function retireRows(env, user, t, ctx) {
  const read = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let misses = [], gapRows = [], obs = [], queue = [];
  const [al] = await env.DB.batch([read(`SELECT alias_key, kind, status FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active'`, user, t.id)]);
  const aliases = al.results || [];
  try {
    const [m, g, e, q] = await env.DB.batch([
      read(`SELECT id, topic_id, match_status, match_method FROM misses WHERE user_id = ? AND topic_id = ? AND held = 0 AND deleted_at IS NULL LIMIT 500`, user, t.id),
      read(`SELECT id, topic_id, map_state, mapped_at FROM gaps WHERE user_id = ? AND topic_id = ? AND held = 0 LIMIT 300`, user, t.id),
      read(`SELECT DISTINCT obs_key FROM evidence WHERE user_id = ? AND topic_id = ? AND held = 0 AND (miss_id IS NOT NULL OR gap_id IS NOT NULL) LIMIT 1500`, user, t.id),
      read(`SELECT id, status, resolved_topic_id, resolved_by FROM topic_queue WHERE user_id = ? AND resolved_topic_id = ? AND status = 'resolved' LIMIT 200`, user, t.id),
    ]);
    [misses, gapRows, obs, queue] = [m.results || [], g.results || [], (e.results || []).map(r => r.obs_key), q.results || []];
  } catch (e) { if (!noTable(e)) throw e; }
  const rows = [], events = [];
  for (const a of aliases) {
    rows.push({ table: 'topic_aliases', op: 'update', key: { alias_key: a.alias_key, topic_id: t.id }, before: { status: 'active' }, after: { status: 'removed' } });
    events.push(ev('alias.removed', 'alias', `${a.alias_key}|${t.id}`, t.id, `"${a.alias_key}" no longer names ${t.name}`));
  }
  for (const m of misses) {
    rows.push({ table: 'misses', op: 'update', key: { id: m.id }, before: { topic_id: m.topic_id, match_status: m.match_status, match_method: m.match_method },
      after: { topic_id: null, match_status: 'open', match_method: null } });
    events.push(ev('miss.placed', 'retired_miss', m.id, t.id, `A miss on ${t.name} goes back to the queue`));
  }
  for (const g of gapRows) {
    rows.push({ table: 'gaps', op: 'update', key: { id: g.id }, before: { topic_id: g.topic_id, map_state: g.map_state, mapped_at: g.mapped_at },
      after: { topic_id: null, map_state: 'queued', mapped_at: null } });
    events.push(ev('miss.placed', 'retired_gap', g.id, t.id, `A gap on ${t.name} goes back to the queue`));
  }
  for (const q of queue) {
    rows.push({ table: 'topic_queue', op: 'update', key: { id: q.id }, before: { status: q.status, resolved_topic_id: q.resolved_topic_id, resolved_by: q.resolved_by },
      after: { status: 'open', resolved_topic_id: null, resolved_by: null } });
    events.push(ev('topic.updated', 'queue', q.id, t.id, `Reopened for placing (${t.name} retired)`));
  }
  return { rows, events, evidence: obs.length ? { repoint: [{ obs_keys: obs, to_topic: null }] } : null };
}

/**
 * UNDO['target:retired_miss'] and ['target:retired_gap'] (realtime's undoBatch calls handler(env, user, event)):
 * the miss or gap goes back on the topic it was retired from, and its unplaced evidence with it. A row placed
 * again since is a conflict. Returns {rows, evidence: {upsert}, recompute} or {conflict}.
 */
export async function undoRetiredRow(env, user, e) {
  const table = e.target_type === 'retired_gap' ? 'gaps' : 'misses';
  const col = table === 'gaps' ? 'gap_id' : 'miss_id';
  const before = parse(e.before_json, {}) || {};
  if (!e.target_id || !before.topic_id) return { conflict: "That change can't be undone automatically." };
  const [cur, evs] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND id = ?`).bind(user, e.target_id),
    env.DB.prepare(`SELECT * FROM evidence WHERE user_id = ? AND ${col} = ? AND topic_id IS NULL`).bind(user, e.target_id),
  ]);
  const row = (cur.results || [])[0];
  if (!row) return { conflict: 'That row is no longer there.' };
  if (row.topic_id != null) return { conflict: 'That was changed again since; undo the later change first.' };
  const back = table === 'misses'
    ? { topic_id: before.topic_id, match_status: before.match_status ?? 'matched', match_method: before.match_method ?? null }
    : { topic_id: before.topic_id, map_state: before.map_state ?? 'placed', mapped_at: before.mapped_at ?? null };
  const was = Object.fromEntries(Object.keys(back).map(k => [k, row[k] ?? null]));
  const upsert = (evs.results || []).map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v;
    return { ...o, topic_id: before.topic_id };
  });
  return { rows: [{ table, op: 'update', key: { id: e.target_id }, before: was, after: back }], evidence: { upsert }, recompute: [before.topic_id] };
}

/**
 * Planner for topic.update: {topic, set: {...}, reason?}. The id is kept on a rename (the old name stays an
 * alias). Retiring sends its aliases away and its misses back to the queue. Tier: see updateTier.
 */
export async function planTopicUpdate(env, user, args, ctx) {
  const set = isObj(args.set) ? args.set : null;
  if (!set || !Object.keys(set).length) return { refuse: 'set lists the fields to change.', field: 'set' };
  const bad = Object.keys(set).find(k => !SET_KEYS.includes(k));
  if (bad) return { refuse: `Unknown field ${bad}; you can set ${SET_KEYS.join(', ')}.`, field: `set.${bad}` };
  try {
    const t = await findTopic(env, user, args.topic ?? args.id);
    if (t.status === 'merged' || t.status === 'retired') problem(`${t.name} is ${t.status}; change the topic it went to instead.`);
    const rows = [], events = [];
    const after = {}, before = {};
    const put = (k, v) => { if (t[k] !== v) { before[k] = t[k]; after[k] = v; } };
    const needs = {};
    const unitIds = [set.unit_id, t.unit_id].filter(Boolean);
    const [cats, units, parents] = await Promise.all([
      categoryIds(env, user),
      rowsByIds(env, user, 'units', UNIT_COLS, unitIds),
      set.parent_id ? rowsByIds(env, user, 'topics', 'id, status', [set.parent_id]) : new Map(),
    ]);
    const aliasRows = [], aliasEvents = [];
    let keysToCheck = [];
    if (set.name !== undefined) {
      const r = namingProblem(set.name, set.kind || t.kind);
      if (r) problem(r);
      put('name', set.name);
      keysToCheck.push(norm(set.name));
    }
    if (set.short_name !== undefined) {
      if (set.short_name !== null && (typeof set.short_name !== 'string' || !set.short_name.trim() || set.short_name.length > 20)) problem('short_name is the abbreviation, at most 20 characters.');
      put('short_name', set.short_name ? set.short_name.trim() : null);
      if (set.short_name) keysToCheck.push(norm(set.short_name));
    }
    if (set.kind !== undefined) { if (!TOPIC_KINDS.includes(set.kind)) problem(`kind must be one of ${TOPIC_KINDS.join(', ')}.`); put('kind', set.kind); }
    if (set.category_id !== undefined) {
      const c = newTopicSystem(set.name ?? t.name, set.category_id, null, cats);
      if (!cats.has(c)) problem(`Unknown category_id "${set.category_id}".`);
      put('category_id', c);
    }
    if (set.category2_id !== undefined) {
      if (set.category2_id !== null && (!cats.has(set.category2_id) || set.category2_id === (after.category_id ?? t.category_id))) problem('category2_id must be a different known category (or null).');
      put('category2_id', set.category2_id);
    }
    if (set.parent_id !== undefined) {
      if (set.parent_id !== null && (set.parent_id === t.id || !parents.has(set.parent_id))) problem(`Unknown parent_id "${set.parent_id}".`);
      put('parent_id', set.parent_id);
    }
    if (set.unit_id !== undefined) {
      if (set.unit_id !== null && !units.has(set.unit_id)) problem(`Unknown unit_id "${set.unit_id}".`);
      put('unit_id', set.unit_id);
      needs.yield = true;
    }
    if (set.amboss_url !== undefined) {
      if (set.amboss_url !== null && (!ambossUrlOk(set.amboss_url) || !/amboss\.com\/us\/(knowledge|article)\//.test(set.amboss_url))) problem('amboss_url must be an AMBOSS US article link (amboss.com/us/knowledge/...).');
      if (ctx.actor !== 'mo' && (t.amboss_src === 'mo' || t.amboss_src === 'tally')) problem(`Mo's checked link stays; he can change it on the topic panel.`);
      if (set.amboss_url === null && ctx.actor !== 'mo') problem('Only Mo can clear the AMBOSS link.');
      put('amboss_url', set.amboss_url);
      put('amboss_src', set.amboss_url === null ? null : ctx.actor === 'mo' ? 'mo' : 'claude');
      put('amboss_checked_at', ctx.actor === 'mo' && set.amboss_url ? ctx.now : null);
    }
    if (set.amboss_checked !== undefined) {
      if (ctx.actor !== 'mo') problem('Only Mo can mark the AMBOSS page as right.');
      if (set.amboss_checked === true) { put('amboss_checked_at', ctx.now); if (t.amboss_src === 'guess' || t.amboss_src === 'claude') put('amboss_src', 'mo'); }
    }
    if (set.status !== undefined) {
      if (!['confirmed', 'retired'].includes(set.status)) problem('status is confirmed or retired.');
      if (set.status === 'confirmed' && t.status !== 'confirmed') { put('status', 'confirmed'); put('confirmed_at', ctx.now); put('confirmed_by', createdBy(ctx)); }
      if (set.status === 'retired') { put('status', 'retired'); put('suspect_dupe_of', null); }
    }
    const added = givenAliases(set.aliases_add);
    // Name clashes: a new name already naming another live topic, or a new alias or abbreviation that is another
    // live topic's own name (B4-2: it would then name neither).
    const aliasKeys = [...added.map(a => [norm(a.alias), a.alias]), ...(set.short_name ? [[norm(set.short_name), set.short_name.trim()]] : [])].filter(([k]) => k);
    keysToCheck = uniq([...keysToCheck, ...aliasKeys.map(([k]) => k)]);
    if (keysToCheck.length) {
      const { byKey } = await fetchAliases(env, user, keysToCheck);
      for (const k of keysToCheck) {
        const other = (byKey.get(k) || []).find(h => h.id !== t.id);
        if (other && set.name !== undefined && k === norm(set.name)) problem(`"${set.name}" already names ${other.name} (${other.id}). Retire one and add its name as an alias of the other.`);
      }
      for (const [k, alias] of aliasKeys) {
        const owner = nameOwner(byKey, k, t.id);
        if (owner) problem(clashProblem(alias, owner, after.name ?? t.name));
      }
    }
    const nowName = after.name ?? t.name;
    const removed = set.aliases_remove == null ? [] : (Array.isArray(set.aliases_remove) && set.aliases_remove.length <= MAX_ALIASES ? set.aliases_remove : problem(`aliases_remove is a list of at most ${MAX_ALIASES} names.`));
    const newNames = [...(set.name !== undefined && set.name !== t.name ? [{ alias: set.name, kind: 'name' }] : []),
      ...(set.short_name ? [{ alias: set.short_name.trim(), kind: 'abbrev' }] : []), ...added];
    const allKeys = uniq([...newNames.map(a => norm(a.alias)), ...removed.map(norm)]).filter(Boolean);
    const existingAliases = allKeys.length ? ((await env.DB.prepare(`SELECT alias_key, kind, status FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND alias_key IN (SELECT value FROM json_each(?))`)
      .bind(user, t.id, JSON.stringify(allKeys)).all()).results || []) : [];
    const have = new Map(existingAliases.map(a => [a.alias_key, a]));
    for (const a of newNames) {
      const k = norm(a.alias);
      const cur = have.get(k);
      if (cur && cur.status === 'active') continue;
      aliasRows.push(aliasRow(t.id, a.alias, a.kind, ctx, cur || null));
      aliasEvents.push(ev('alias.added', 'alias', `${k}|${t.id}`, t.id, `"${a.alias}" names ${nowName}`));
      have.set(k, { alias_key: k, status: 'active' });
    }
    for (const r of removed) {
      const k = norm(r);
      const cur = have.get(k);
      if (!cur || cur.status !== 'active') problem(`"${r}" is not a name of ${t.name}.`);
      if (k === norm(nowName)) problem(`"${r}" is the topic's own name; rename it first.`);
      aliasRows.push({ table: 'topic_aliases', op: 'update', key: { alias_key: k, topic_id: t.id }, before: { status: 'active' }, after: { status: 'removed' } });
      aliasEvents.push(ev('alias.removed', 'alias', `${k}|${t.id}`, t.id, `"${r}" no longer names ${nowName}`));
    }
    const cards = set.cards_add == null ? [] : (Array.isArray(set.cards_add) && set.cards_add.length <= 10 && set.cards_add.every(c => Number.isInteger(c) && c > 0)
      ? set.cards_add : problem('cards_add is a list of at most 10 card ids.'));
    // The tags: as given, else worked out again when the name, system or unit moves (never over a given value).
    const given = givenTags(set);
    if (given.oncology != null) put('oncology', given.oncology);
    if (given.disciplines != null) put('disciplines', given.disciplines);
    if (['name', 'category_id', 'unit_id'].some(k => k in after)) {
      const u = (after.unit_id ?? t.unit_id) ? units.get(after.unit_id ?? t.unit_id) : null;
      const tags = tagsOf({ name: after.name ?? t.name, short_name: after.short_name ?? t.short_name }, after.category_id ?? t.category_id, u);
      if (given.oncology == null) put('oncology', tags.oncology);
      if (given.disciplines == null) put('disciplines', tags.disciplines);
    }
    if (needs.yield) {
      const u = after.unit_id ? units.get(after.unit_id) : null;
      const y = topicYield(t, u);
      put('yield', y.yield); put('yield_json', JSON.stringify(y.json));
    }
    if (Object.keys(after).length) {
      after.updated_at = ctx.now; before.updated_at = t.updated_at ?? null;
      const kind = after.status === 'retired' ? 'topic.retired' : after.status === 'confirmed' ? 'topic.confirmed' : 'topic.updated';
      const what = Object.keys(after).filter(k => !['updated_at', 'yield', 'yield_json', 'confirmed_at', 'confirmed_by', 'amboss_src', 'amboss_checked_at', 'suspect_dupe_of'].includes(k));
      rows.push({ table: 'topics', op: 'update', key: { id: t.id }, before, after });
      events.push(ev(kind, 'topic', t.id, t.id, kind === 'topic.retired' ? `Retired ${t.name}` : `${nowName}: ${what.join(', ') || 'checked'} changed`));
    }
    const linked = after.unit_id ? await env.DB.prepare('SELECT 1 AS x FROM unit_topics WHERE user_id = ? AND unit_id = ? AND topic_id = ?').bind(user, after.unit_id, t.id).first() : null;
    if (after.unit_id && !linked) {
      rows.push({ table: 'unit_topics', op: 'insert', key: { unit_id: after.unit_id, topic_id: t.id }, before: null, after: { role: 'primary', source: sourceOf(ctx), created_by: createdBy(ctx), created_at: ctx.now } });
      events.push(ev('unit.updated', 'unit_topic', `${after.unit_id}:${t.id}`, t.id, `${nowName} sits in unit ${units.get(after.unit_id).name}`));
    }
    rows.push(...aliasRows); events.push(...aliasEvents);
    const haveCards = await existingCardTopics(env, user, cards);
    for (const c of cards) {
      if (haveCards.has(`${c}:${t.id}`)) continue;
      rows.push({ table: 'card_topics', op: 'insert', key: { card_id: c, topic_id: t.id }, before: null, after: { match: 'claude', strong: 1, created_by: createdBy(ctx), created_at: ctx.now } });
      events.push(ev('topic.updated', 'card_topic', `${c}:${t.id}`, t.id, `Card ${c} linked to ${nowName}`));
    }
    let evidence = null;
    if (after.status === 'retired') {
      const r = await retireRows(env, user, t, ctx);
      rows.push(...r.rows); events.push(...r.events); evidence = r.evidence;
    }
    if (!rows.length) return { noop: true, summary: `${t.name} already looks like that.` };
    return { rows, events, evidence, touched_topics: [t.id], count: 1, summary: events[0].summary,
      reply: { topic: { id: t.id, name: nowName }, before, after } };
  } catch (e) {
    if (e instanceof Problem) return { refuse: e.message };
    throw e;
  }
}

export function updateTier(args) {
  const set = isObj(args.set) ? args.set : {};
  return set.status === 'retired' || (Array.isArray(set.aliases_remove) && set.aliases_remove.length) ? 'confirm' : 'free';
}

export const planTopicRetire = (env, user, args, ctx) => planTopicUpdate(env, user, { topic: args.topic ?? args.id, set: { status: 'retired' }, reason: args.reason }, ctx);
export const planAliasAdd = (env, user, args, ctx) => planTopicUpdate(env, user, { topic: args.topic ?? args.id, set: { aliases_add: args.aliases } }, ctx);
export const planAliasRemove = (env, user, args, ctx) => planTopicUpdate(env, user, { topic: args.topic ?? args.id, set: { aliases_remove: args.aliases } }, ctx);

/** Planner for topic.confirm: {ids: [...]} or {topic}. Already-confirmed topics are skipped. */
export async function planTopicConfirm(env, user, args, ctx) {
  let ids = Array.isArray(args.ids) ? args.ids.map(String) : null;
  try {
    if (!ids) ids = [(await findTopic(env, user, args.topic ?? args.id)).id];
  } catch (e) { if (e instanceof Problem) return { refuse: e.message }; throw e; }
  if (!ids.length || ids.length > 500) return { refuse: 'ids is a list of 1 to 500 topic ids.' };
  const topics = await rowsByIds(env, user, 'topics', 'id, name, status, confirmed_at, confirmed_by, updated_at', ids);
  const rows = [], events = [];
  for (const t of topics.values()) {
    if (t.status !== 'proposed') continue;
    rows.push({ table: 'topics', op: 'update', key: { id: t.id }, before: { status: t.status, confirmed_at: t.confirmed_at, confirmed_by: t.confirmed_by, updated_at: t.updated_at },
      after: { status: 'confirmed', confirmed_at: ctx.now, confirmed_by: createdBy(ctx), updated_at: ctx.now } });
    events.push(ev('topic.confirmed', 'topic', t.id, t.id, `Confirmed ${t.name}${args.auto ? ' (enough evidence)' : ''}`));
  }
  if (!rows.length) return { noop: true, summary: 'Nothing to confirm.' };
  return { rows, events, count: ctx.actor === 'code' ? rows.length : 1, summary: rows.length === 1 ? events[0].summary : `Confirmed ${rows.length} topics` };
}

// ---------------------------------------------------------------- units

const UNIT_SET = ['name', 'heading', 'lane', 'mehlman_rank', 'category_id', 'checklist_system', 'checklist_order', 'onenote_section', 'onenote_link', 'notes_gap'];

/** Planner for unit.update: {id, set}. The fields set are locked against re-imports; its topics' yield follows. */
export async function planUnitUpdate(env, user, args, ctx) {
  const set = isObj(args.set) ? args.set : null;
  if (!set || !Object.keys(set).length) return { refuse: 'set lists the unit fields to change.' };
  const bad = Object.keys(set).find(k => !UNIT_SET.includes(k));
  if (bad) return { refuse: `Unknown unit field ${bad}; you can set ${UNIT_SET.join(', ')}.` };
  const u = (await rowsByIds(env, user, 'units', `${UNIT_COLS}, heading, checklist_system, checklist_order, onenote_section, onenote_link, notes_gap, updated_at`, [String(args.id)])).get(String(args.id));
  if (!u) return { refuse: `No unit ${args.id}.` };
  if (set.lane !== undefined && set.lane !== null && !['A', 'B', 'C'].includes(set.lane)) return { refuse: 'lane is A, B or C.' };
  if (set.mehlman_rank !== undefined && set.mehlman_rank !== null && !(Number.isInteger(set.mehlman_rank) && set.mehlman_rank >= 1 && set.mehlman_rank <= 229)) return { refuse: 'mehlman_rank is 1 to 229.' };
  if (set.category_id !== undefined && !(await categoryIds(env, user)).has(set.category_id)) return { refuse: `Unknown category_id "${set.category_id}".` };
  if (set.name !== undefined && (typeof set.name !== 'string' || !set.name.trim() || set.name.length > 200)) return { refuse: 'A unit name is at most 200 characters.' };
  const before = {}, after = {};
  for (const [k, v] of Object.entries(set)) if (u[k] !== v) { before[k] = u[k]; after[k] = v; }
  if (!Object.keys(after).length) return { noop: true, summary: `Unit ${u.name} already looks like that.` };
  const locked = uniq([...parse(u.locked_json, []), ...Object.keys(after)]);
  before.locked_json = u.locked_json; after.locked_json = JSON.stringify(locked);
  const next = { ...u, ...after };
  const rows = [{ table: 'units', op: 'update', key: { id: u.id }, before: { ...before, updated_at: u.updated_at }, after: { ...after, updated_at: ctx.now } }];
  const events = [ev('unit.updated', 'unit', u.id, null, `Unit ${next.name}: ${Object.keys(set).join(', ')} changed`)];
  if ('lane' in after || 'mehlman_rank' in after) {
    const topics = (await env.DB.prepare(`SELECT id, name, unit_id, yield, yield_json, q_seen, anking_cards, mehlman_match, nbme_images_own FROM topics
        WHERE user_id = ? AND unit_id = ? AND status IN ('proposed','confirmed')`).bind(user, u.id).all()).results || [];
    for (const t of topics) {
      const y = topicYield(t, next);
      if (Math.abs(y.yield - t.yield) < 0.00005) continue;
      rows.push({ table: 'topics', op: 'update', key: { id: t.id }, before: { yield: t.yield, yield_json: t.yield_json }, after: { yield: y.yield, yield_json: JSON.stringify(y.json) } });
      events.push(ev('topic.updated', 'topic', t.id, t.id, `${t.name}: yield ${t.yield.toFixed(2)} to ${y.yield.toFixed(2)}`));
    }
  }
  return { rows, events, count: 1, summary: events[0].summary };
}

const UNIT_ID = /^(u\d{3}|x-[a-z0-9-]{1,60})$/;
const UNIT_UPSERT_COLS = ['num', 'kind', 'name', 'heading', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id', 'onenote_section',
  'onenote_page_id', 'onenote_object_id', 'onenote_link', 'coverage_json', 'nbme_images', 'notes_gap', 'source_ref'];
const UNIT_KINDS = ['checklist', 'onenote_core', 'onenote_mehlman'];

/** A parsed unit checked and completed for storage (lane override and category applied). Throws HttpError(400). */
export function unitRow(u) {
  const bad = why => { throw new HttpError(400, `Unit ${u && (u.id || u.num) || '?'}: ${why}`); };
  if (!isObj(u)) bad('not an object.');
  const id = u.id ?? (Number.isInteger(u.num) ? `u${String(u.num).padStart(3, '0')}` : null);
  if (!UNIT_ID.test(String(id))) bad("id is 'u' and the 3-digit to-do number, or 'x-<slug>' for a OneNote heading.");
  const kind = u.kind || (String(id).startsWith('x-') ? 'onenote_core' : 'checklist');
  if (!UNIT_KINDS.includes(kind)) bad(`kind is ${UNIT_KINDS.join(', ')}.`);
  if (typeof u.name !== 'string' || !u.name.trim() || u.name.length > 200) bad('needs a name of at most 200 characters.');
  if (u.lane != null && !['A', 'B', 'C'].includes(u.lane)) bad('lane is A, B or C.');
  if (u.mehlman_rank != null && !(Number.isInteger(u.mehlman_rank) && u.mehlman_rank >= 1 && u.mehlman_rank <= 229)) bad('mehlman_rank is 1 to 229.');
  for (const k of ['num', 'checklist_order', 'nbme_images']) if (u[k] != null && !(Number.isInteger(u[k]) && u[k] >= 0)) bad(`${k} is a whole number.`);
  // Taxonomy v2: the one system the unit belongs to (systems.js unitSystemFor); an old category id given is read as its system.
  const cat = (u.category_id && !LEGACY[u.category_id] ? u.category_id : null) || unitSystemFor({ ...u, id: u.id ?? (Number.isInteger(u.num) ? `u${String(u.num).padStart(3, '0')}` : null), kind: u.kind || (String(u.id || '').startsWith('x-') ? 'onenote_core' : 'checklist') });
  if (!cat) bad(`no category: its OneNote section "${u.onenote_section ?? ''}" and checklist system "${u.checklist_system ?? ''}" are not known names.`);
  const lane = kind === 'checklist' ? laneFor({ ...u, kind }).lane : (u.lane || { onenote_core: 'B', onenote_mehlman: 'C' }[kind]);
  const coverage = u.coverage_json == null ? {} : typeof u.coverage_json === 'string' ? parse(u.coverage_json, null) : u.coverage_json;
  if (!isObj(coverage)) bad('coverage_json is an object of counts.');
  const nbme = Number.isInteger(u.nbme_images) ? u.nbme_images : Number.isInteger(coverage['NBME High Yield Images']) ? coverage['NBME High Yield Images'] : 0;
  return { id: String(id), num: u.num ?? (kind === 'checklist' ? Number(String(id).slice(1)) : null), kind, name: u.name.trim(), heading: u.heading ?? null, lane: lane ?? null,
    mehlman_rank: u.mehlman_rank ?? null, checklist_system: u.checklist_system ?? null, checklist_order: u.checklist_order ?? null, category_id: cat,
    onenote_section: u.onenote_section ?? null, onenote_page_id: u.onenote_page_id ?? null, onenote_object_id: u.onenote_object_id ?? null,
    onenote_link: u.onenote_link ?? null, coverage_json: JSON.stringify(coverage), nbme_images: nbme, notes_gap: u.notes_gap ? 1 : 0, source_ref: u.source_ref ?? null };
}

export function unitUpsertStatements(env, user, units, { now = Date.now() } = {}) {
  if (!Array.isArray(units)) throw new HttpError(400, 'units must be a list.');
  const rows = units.map(unitRow);
  const ids = new Set();
  for (const r of rows) { if (ids.has(r.id)) throw new HttpError(400, `Unit ${r.id} is listed twice.`); ids.add(r.id); }
  const keep = c => `${c} = CASE WHEN EXISTS (SELECT 1 FROM json_each(units.locked_json) l WHERE l.value = '${c}') THEN units.${c} ELSE excluded.${c} END`;
  const sql = `INSERT INTO units (user_id, id, ${UNIT_UPSERT_COLS.join(', ')}, source, created_by, created_at, updated_at)
    SELECT ?1, json_extract(value, '$.id'), ${UNIT_UPSERT_COLS.map(c => `json_extract(value, '$.${c}')`).join(', ')}, 'onenote', 'seed', ?2, ?2 FROM json_each(?3) WHERE true
    ON CONFLICT (user_id, id) DO UPDATE SET ${UNIT_UPSERT_COLS.map(keep).join(', ')}, updated_at = excluded.updated_at`;
  const out = [];
  for (let i = 0; i < rows.length; i += 150) out.push(env.DB.prepare(sql).bind(user, now, JSON.stringify(rows.slice(i, i + 150))));
  return out;
}

/**
 * The unit:<unit_id> queue row ONE's import writes for each unit (plan §16): the unit, its lane and rank,
 * taxonomy's split candidates and its tally conditions with their AMBOSS links (≤ 2,000 characters in all).
 */
export function unitQueueRow(user, unit, { tally = [], now = Date.now() } = {}) {
  const u = unitRow(unit);
  const conditions = (Array.isArray(tally) ? tally : []).filter(t => t && typeof t.condition === 'string' && t.condition.trim())
    .map(t => ({ condition: t.condition.trim().slice(0, 120), ...(t.amboss_url && ambossUrlOk(t.amboss_url) ? { amboss_url: t.amboss_url } : {}) }));
  const context = { unit: u.name, unit_id: u.id, lane: u.lane, rank: u.mehlman_rank, category_id: u.category_id, split: splitUnit(u.name, u.category_id), tally: conditions };
  while (JSON.stringify(context).length > 2000 && context.tally.length) context.tally.pop();
  return { id: userKey(user, `unit:${u.id}`), user_id: user, kind: 'unit', label_norm: norm(u.name), label_raw: u.name.slice(0, 200), context_json: JSON.stringify(context),
    candidates_json: '[]', refs: 1, first_seen_at: now, last_seen_at: now, status: 'open' };
}

// ---------------------------------------------------------------- the queue

// Links already made between cards and topics ('card:topic'), so a placement never inserts one twice.
async function existingCardTopics(env, user, cardIds) {
  if (!cardIds.length) return new Set();
  try {
    const rows = (await env.DB.prepare(`SELECT card_id, topic_id FROM card_topics WHERE user_id = ? AND card_id IN (SELECT value FROM json_each(?))`)
      .bind(user, JSON.stringify(uniq(cardIds))).all()).results || [];
    return new Set(rows.map(r => `${r.card_id}:${r.topic_id}`));
  } catch (e) { if (noTable(e)) return new Set(); throw e; }
}

const CONTEXT_KEYS = ['system', 'category_hint', 'category_id', 'unit', 'unit_id', 'unit_hint', 'lane', 'rank', 'split', 'tally', 'look_alike_head', 'gap',
  'said', 'ref_label', 'cut', 'source', 'amboss_url', 'title', 'names', 'pairs',
  'label', 'true_topic_id', 'resolved'];   // a look-alike's miss label and the miss's own topic; a card pair's sides code placed

export async function listQueue(env, user, { kind = null, category = null, limit = 10, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(25, Number(limit) || 10));
  const skip = Math.max(0, Math.min(100_000, Math.floor(Number(offset) || 0)));
  if (kind != null && !QUEUE_KINDS.includes(kind)) throw new HttpError(400, `kind is one of ${QUEUE_KINDS.join(', ')}.`);
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' GROUP BY kind`).bind(user),
      env.DB.prepare(`SELECT id, kind, label_raw, refs, first_seen_at, context_json, candidates_json FROM topic_queue WHERE user_id = ?1 AND status = 'open'
          AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR json_extract(context_json, '$.category_hint') = ?3 OR json_extract(context_json, '$.category_id') = ?3)
          ORDER BY refs DESC, first_seen_at, id LIMIT ?4 OFFSET ?5`).bind(user, kind, category, n, skip),
    ]);
  } catch (e) { if (noTable(e)) return { open: 0, by_kind: {}, items: [] }; throw e; }
  const by_kind = Object.fromEntries((res[0].results || []).map(r => [r.kind, r.n]));
  const items = (res[1].results || []).map(r => {
    const c = parse(r.context_json, {});
    const context = Object.fromEntries(CONTEXT_KEYS.filter(k => c[k] != null).map(k => [k, typeof c[k] === 'string' ? c[k].slice(0, 400) : c[k]]));
    const label = r.kind === 'gap' ? gapItemSafe(r.label_raw, c, context, r.first_seen_at) : r.label_raw;
    return { queue_id: r.id, kind: r.kind, label_raw: label, refs: r.refs, first_seen_day: londonDay(r.first_seen_at), context,
      candidates: parse(r.candidates_json, []).slice(0, 3) };
  });
  return { open: Object.values(by_kind).reduce((a, b) => a + b, 0), by_kind, items };
}

/**
 * A gap item as map_queue shows it (LS4-1): its words in the context are checked again, with the spoken-cue rules
 * unless the gap is known not to be a spoken cue, and an item stored before gaps were labelled by where and when
 * (its label is the gap's own words) gets a neutral label. Mutates context; returns the label.
 */
function gapItemSafe(label, stored, context, firstSeen) {
  const check = stored.gap_source && stored.gap_source !== 'spoken_cue' ? looksLikeQuestionText : cueLooksLikeStem;
  if (context.gap && check(context.gap)) context.gap = GAP_LEFT_OUT;
  if (context.said && check(context.said)) delete context.said;
  const words = String(label || '');
  if (!words || (stored.gap && words === String(stored.gap).slice(0, 200)) || check(words)) return `Gap noted, ${londonDay(firstSeen)}`;
  return words;
}

// The alias kind a placed label teaches, from where the label came.
function learnKind(item) {
  if (item.kind === 'lookalike') return 'synonym';
  if (isCut(item.label_raw)) return 'truncated';
  const s = String((item.context && item.context.source) || '');
  if (/uworld/.test(s)) return 'uworld_label';
  if (/hub|analysis|nbme/.test(s)) return 'analysis_topic';
  if (/gap/.test(s)) return 'gap_topic';
  if (/tally|onenote/.test(s)) return 'tally_condition';
  return 'log_topic';
}

// The queue item's own row, resolved or rejected. Its event is topic.updated on target 'queue' (restored by plain
// row undo); queue.resolved stays for the misses and gaps placeRows moves, which ING's unplace reverses.
function resolvedRow(item, ctx, result, status = 'resolved') {
  return { table: 'topic_queue', op: 'update', key: { id: item.id }, before: { status: item.status, resolved_topic_id: item.resolved_topic_id ?? null, resolved_by: item.resolved_by ?? null, result_json: item.result_json ?? null },
    after: { status, resolved_topic_id: status === 'resolved' ? result.topic_id ?? null : null, resolved_by: createdBy(ctx), result_json: JSON.stringify(result) } };
}

/**
 * The topic an item argument names: an existing live topic ({topic_id}) or a new one ({new_topic} or {new}),
 * built into the shared plan. Returns the topic {id, name, category_id, created?}.
 */
function targetTopic(user, arg, ctx, shared, opts = {}) {
  const spec = arg.new_topic || arg.new;
  if (spec) {
    const r = buildNewTopic(user, { ...spec, unit_id: spec.unit_id ?? opts.unit_id, category_id: spec.category_id ?? opts.category_id }, ctx, shared.data, { status: opts.status });
    if (r.existing) { const t = shared.topics.get(r.existing.id); return t || { id: r.existing.id, name: r.existing.name, category_id: r.existing.category_id }; }
    shared.out.rows.push(...r.rows); shared.out.events.push(...r.events);
    if (r.dupe) shared.out.dupes.push(r.dupe);
    shared.out.new_topics.push(r.created);
    shared.topics.set(r.created.id, r.created);
    return { ...r.created, created: true };
  }
  if (arg.topic_id == null) problem('Give topic_id, new_topic or reject.');
  const t = shared.topics.get(String(arg.topic_id));
  if (!t || !['proposed', 'confirmed'].includes(t.status)) problem(`No live topic ${arg.topic_id}; look it up with map_search.`);
  return t;
}

// Handlers for the kinds taxonomy owns. Each takes the shared state and the entries of its kind.
function placeHandler(learn) {
  return async (env, user, entries, ctx, shared) => {
    const versus = [];   // every placed look-alike's versus proposals, planned once below (B4-1)
    for (const { item, arg } of entries) {
      try {
        if (arg.reject != null) {
          if (typeof arg.reject !== 'string' || !arg.reject.trim() || arg.reject.length > 120) problem('reject is the reason, at most 120 characters.');
          shared.out.rows.push(resolvedRow(item, ctx, { reject: arg.reject.trim() }, 'rejected'));
          // A gap's summary never carries its words (CONTRACT I23: summaries are names, never gap text).
          shared.out.events.push(ev('topic.updated', 'queue', item.id, null, (item.kind === 'gap' ? 'A gap set aside: not a topic' : `Not a topic: ${item.label_raw}`).slice(0, 160)));
          shared.out.results.push({ queue_id: item.id, rejected: true });
          continue;
        }
        const topic = targetTopic(user, arg, ctx, shared);
        let aliasSkipped = null;
        if (learn && item.label_norm && !(item.context && item.context.no_alias) && !shared.data.taken.keys.has(item.label_norm)) {
          const k = item.label_norm;
          const row = shared.data.aliasRows.get(`${k}|${topic.id}`);
          // Another live topic's own name is never learned as this one's alias (B4-2): the item is placed, the name is not.
          const owner = nameOwner(shared.data.aliases, k, topic.id);
          const notName = owner ? null : labelAliasProblem(shared.data.aliases, item.label_raw, k, topic.id);
          if (owner) aliasSkipped = `"${item.label_raw}" is the name of ${owner.name}, so it was not added as a name of ${topic.name}.`;
          else if (notName) aliasSkipped = `"${item.label_raw}" reads as a description (${notName}), so it was not added as a name of ${topic.name}.`.slice(0, 300);
          else if ((!row || row.status !== 'active') && norm(topic.name) !== k) {
            shared.out.rows.push(aliasRow(topic.id, item.label_raw, learnKind(item), ctx, row || null));
            shared.out.events.push(ev('alias.added', 'alias', `${k}|${topic.id}`, topic.id, `"${item.label_raw}" names ${topic.name}`.slice(0, 160)));
            shared.data.taken.keys.set(k, topic);
          }
        }
        if (item.kind === 'card') {
          const card = Number(unprefix(user, item.id).replace(/^card:/, ''));
          if (Number.isInteger(card) && card > 0 && !shared.cardTopics.has(`${card}:${topic.id}`)) {
            shared.cardTopics.add(`${card}:${topic.id}`);
            shared.out.rows.push({ table: 'card_topics', op: 'insert', key: { card_id: card, topic_id: topic.id }, before: null, after: { match: 'claude', strong: 1, created_by: createdBy(ctx), created_at: ctx.now } });
            shared.out.events.push(ev('topic.updated', 'card_topic', `${card}:${topic.id}`, topic.id, `Card ${card} linked to ${topic.name}`));
          }
        }
        shared.out.placements.push({ queue_id: item.id, topic_id: topic.id });
        // A look-alike placed: links joins the misses that named it to this topic (their versus links).
        if (item.kind === 'lookalike' && Array.isArray(item.context.miss_ids) && item.context.miss_ids.length) {
          versus.push(...await lookalikeProposals(env, user, { miss_ids: item.context.miss_ids, topic_id: topic.id, head: item.label_raw }));
        }
        shared.out.rows.push(resolvedRow(item, ctx, { topic_id: topic.id, ...(topic.created ? { created: true } : {}) }));
        shared.out.events.push(ev('topic.updated', 'queue', item.id, topic.id, (item.kind === 'gap' ? `A gap placed on ${topic.name}` : `${item.label_raw} placed on ${topic.name}`).slice(0, 160)));
        shared.out.touched.add(topic.id);
        shared.out.results.push({ queue_id: item.id, topic_id: topic.id, ...(topic.created ? { created: true } : {}), ...(aliasSkipped ? { alias_skipped: aliasSkipped } : {}) });
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        shared.out.problems.push({ queue_id: item.id, problem: e.message });
      }
    }
    // One plan for all of them: two items on one topic from misses on the same topic share one link (B4-1).
    if (versus.length) {
      const r = await planLinks(env, user, versus, ctx);
      shared.out.parts.push(pinned({ rows: r.rows, events: r.events }));
    }
  };
}

async function unitHandler(env, user, entries, ctx, shared) {
  const unitIds = entries.map(e => unprefix(user, e.item.id).replace(/^unit:/, ''));
  const topicUnitIds = [...shared.topics.values()].map(t => t.unit_id).filter(Boolean);
  const units = await rowsByIds(env, user, 'units', UNIT_COLS, [...unitIds, ...topicUnitIds]);
  const have = (await env.DB.prepare(`SELECT unit_id, topic_id FROM unit_topics WHERE user_id = ? AND unit_id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(unitIds)).all()).results || [];
  for (const r of have) shared.unitTopicSeen.add(`${r.unit_id}:${r.topic_id}`);
  for (const { item, arg } of entries) {
    const unitId = unprefix(user, item.id).replace(/^unit:/, '');
    try {
      const unit = units.get(unitId);
      if (!unit) problem(`Unit ${unitId} is not on the map yet; run the OneNote import first.`);
      if (arg.reject != null) problem('A checklist unit is never rejected: give its topics, or skip_conditions with reasons.');
      const list = Array.isArray(arg.topics) ? arg.topics : [];
      const skips = Array.isArray(arg.skip_conditions) ? arg.skip_conditions : [];
      if (!list.length && !skips.length) problem('Give topics [{topic_id | new_topic, role, from[]}] for this unit.');
      for (const s of skips) if (!isObj(s) || typeof s.condition !== 'string' || typeof s.why !== 'string' || !s.why.trim() || s.why.length > 200) problem('Each skip is {condition, why}.');
      const tally = Array.isArray(item.context.tally) ? item.context.tally : [];
      const named = new Set([...list.flatMap(x => (Array.isArray(x.from) ? x.from : [])), ...skips.map(s => s.condition)].map(norm));
      const missing = tally.filter(t => !named.has(norm(t.condition)));
      if (missing.length) problem(`Place or skip every tally condition of ${unit.name}: ${missing.map(t => t.condition).join(', ')}.`.slice(0, 300));
      const placedIds = [], aliasesSkipped = [];
      for (const x of list) {
        if (!isObj(x)) problem('Each topic is {topic_id | new_topic, role, from[]}.');
        const role = x.role || 'primary';
        if (!['primary', 'also'].includes(role)) problem('role is primary or also.');
        const spec = x.new_topic || x.new;
        const topic = targetTopic(user, x, ctx, shared, { unit_id: unit.id, category_id: newTopicSystem(spec && spec.name, null, unit), status: 'confirmed' });
        placedIds.push(topic.id);
        if (!topic.created) {
          if (!shared.unitTopicSeen.has(`${unit.id}:${topic.id}`)) {
            shared.out.rows.push({ table: 'unit_topics', op: 'insert', key: { unit_id: unit.id, topic_id: topic.id }, before: null, after: { role, source: sourceOf(ctx), created_by: createdBy(ctx), created_at: ctx.now } });
            shared.out.events.push(ev('unit.updated', 'unit_topic', `${unit.id}:${topic.id}`, topic.id, `${topic.name} sits in unit ${unit.name}`.slice(0, 160)));
            shared.unitTopicSeen.add(`${unit.id}:${topic.id}`);
          }
          const cur = topic.unit_id ? units.get(topic.unit_id) : null;
          const best = betterUnit(cur, unit);
          const amboss = tallyLink(tally, x.from, topic);
          if ((best && best.id !== topic.unit_id) || amboss) {
            const after = {}, before = {};
            if (best && best.id !== topic.unit_id) {
              const y = topicYield(topic, best);
              Object.assign(before, { unit_id: topic.unit_id, yield: topic.yield, yield_json: topic.yield_json });
              Object.assign(after, { unit_id: best.id, yield: y.yield, yield_json: JSON.stringify(y.json) });
              topic.unit_id = best.id;
            }
            if (amboss) { Object.assign(before, { amboss_url: topic.amboss_url, amboss_src: topic.amboss_src }); Object.assign(after, amboss); }
            shared.out.rows.push({ table: 'topics', op: 'update', key: { id: topic.id }, before, after: { ...after, updated_at: ctx.now } });
            shared.out.events.push(ev('topic.updated', 'topic', topic.id, topic.id, `${topic.name}: ${Object.keys(after).includes('unit_id') ? `unit ${best.name}` : 'AMBOSS link from the tally'}`.slice(0, 160)));
          }
        } else {
          shared.unitTopicSeen.add(`${unit.id}:${topic.id}`);
          const amboss = tallyLink(tally, x.from, { amboss_src: 'guess' });
          const ins = shared.out.rows.find(r => r.table === 'topics' && r.op === 'insert' && r.key.id === topic.id);
          if (amboss && ins) Object.assign(ins.after, amboss);
        }
        // A tally condition worded differently from the topic becomes its alias.
        for (const c of Array.isArray(x.from) ? x.from : []) {
          const k = norm(c);
          if (!k || k === norm(topic.name) || shared.data.taken.keys.has(k)) continue;
          const row = shared.data.aliasRows.get(`${k}|${topic.id}`);
          if ((row && row.status === 'active') || typeof c !== 'string' || c.length > NAME_MAX) continue;
          // A condition that is another live topic's own name stays that topic's (B4-2): placed here, never an alias.
          const owner = nameOwner(shared.data.aliases, k, topic.id);
          if (owner) { aliasesSkipped.push(`"${c}" is the name of ${owner.name}, so it was not added as a name of ${topic.name}.`); continue; }
          shared.out.rows.push(aliasRow(topic.id, c, 'tally_condition', ctx, row || null));
          shared.out.events.push(ev('alias.added', 'alias', `${k}|${topic.id}`, topic.id, `"${c}" names ${topic.name}`.slice(0, 160)));
          shared.data.taken.keys.set(k, topic);
        }
        shared.out.touched.add(topic.id);
      }
      shared.out.rows.push(resolvedRow(item, ctx, { topics: placedIds, skipped: skips.map(s => s.condition) }));
      shared.out.events.push(ev('topic.updated', 'queue', item.id, placedIds[0] || null, `Unit ${unit.name}: ${placedIds.length} topics`.slice(0, 160)));
      shared.out.results.push({ queue_id: item.id, topics: placedIds, skipped: skips.length, ...(aliasesSkipped.length ? { aliases_skipped: aliasesSkipped.slice(0, 10) } : {}) });
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
      shared.out.problems.push({ queue_id: item.id, problem: e.message });
    }
  }
}

function tallyLink(tally, from, topic) {
  if (!Array.isArray(from) || topic.amboss_src === 'mo' || topic.amboss_src === 'tally') return null;
  const keys = new Set(from.map(norm));
  const t = tally.find(x => keys.has(norm(x.condition)) && x.amboss_url && /^https:\/\/(www\.)?amboss\.com\/us\/knowledge\//.test(x.amboss_url) && ambossUrlOk(x.amboss_url));
  return t ? { amboss_url: t.amboss_url, amboss_src: 'tally' } : null;
}

export const TAX_QUEUE_HANDLERS = {
  label: placeHandler(true),
  lookalike: placeHandler(true),
  gap: placeHandler(false),
  card: placeHandler(false),
  unit: unitHandler,
};

export async function planQueueResolve(env, user, args, ctx) {
  const list = Array.isArray(args.items) ? args.items : null;
  const max = ctx.run_id || ctx.actor === 'code' ? MAX_ITEMS_RUN : MAX_ITEMS;
  if (!list || !list.length || list.length > max) return { refuse: `items is a list of 1 to ${max} queue items.`, field: 'items' };
  for (const [i, x] of list.entries()) if (!isObj(x) || typeof x.queue_id !== 'string') return { refuse: `Item ${i + 1} needs its queue_id.`, field: `items[${i}]` };
  const ids = uniq(list.map(x => x.queue_id));
  if (ids.length !== list.length) return { refuse: 'Each queue item once per call.' };
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT id, kind, label_norm, label_raw, context_json, status, resolved_topic_id, resolved_by, result_json FROM topic_queue
        WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || [];
  } catch (e) { if (noTable(e)) return { refuse: 'The queue is not set up yet.' }; throw e; }
  const items = new Map(rows.map(r => [r.id, { ...r, context: parse(r.context_json, {}), gap_id: r.kind === 'gap' ? unprefix(user, r.id).replace(/^gap:/, '') : null }]));
  const problems = [];
  const entries = [];
  for (const x of list) {
    const item = items.get(x.queue_id);
    if (!item) { problems.push({ queue_id: x.queue_id, problem: 'No such queue item; read map_queue again.' }); continue; }
    if (item.status !== 'open' && item.status !== 'claimed') { problems.push({ queue_id: x.queue_id, problem: `Already ${item.status}.` }); continue; }
    entries.push({ item, arg: x });
  }
  // Everything the handlers need, read once: target topics, new-topic checks and the unplaced rows.
  const specs = entries.flatMap(e => [e.arg.new_topic || e.arg.new, ...(Array.isArray(e.arg.topics) ? e.arg.topics.map(t => isObj(t) && (t.new_topic || t.new)) : [])]).filter(isObj);
  const unitDefaults = entries.filter(e => e.item.kind === 'unit').map(e => ({ unit_id: unprefix(user, e.item.id).replace(/^unit:/, '') }));
  const targetIds = entries.flatMap(e => [e.arg.topic_id, ...(Array.isArray(e.arg.topics) ? e.arg.topics.map(t => isObj(t) && t.topic_id) : [])]).filter(v => typeof v === 'string');
  const learnKeys = entries.flatMap(e => [e.item.label_norm, ...(['label', 'lookalike'].includes(e.item.kind) ? innerSpans(e.item.label_norm) : []), ...(Array.isArray(e.arg.topics) ? e.arg.topics.flatMap(t => (isObj(t) && Array.isArray(t.from) ? t.from : [])) : [])])
    .filter(k => typeof k === 'string');
  const cardIds = entries.filter(e => e.item.kind === 'card').map(e => Number(unprefix(user, e.item.id).replace(/^card:/, ''))).filter(Number.isInteger);
  const [data, topics, cardTopics] = await Promise.all([
    loadForNew(env, user, [...specs, ...unitDefaults.map(u => ({ unit_id: u.unit_id }))].map(s => ({ ...s, name: s.name || '' })), learnKeys),
    rowsByIds(env, user, 'topics', TOPIC_COLS, targetIds),
    existingCardTopics(env, user, cardIds),
  ]);
  data.taken = freshTaken();
  const shared = {
    data, topics, unitTopicSeen: new Set(), cardTopics,
    out: { rows: [], events: [], dupes: [], repoint: [], placements: [], parts: [], new_topics: [], results: [], problems, touched: new Set() },
  };
  const handlers = { ...queueHandlers(), ...TAX_QUEUE_HANDLERS };
  const byKind = new Map();
  for (const e of entries) { if (!byKind.has(e.item.kind)) byKind.set(e.item.kind, []); byKind.get(e.item.kind).push(e); }
  for (const [kind, group] of byKind) {
    const h = handlers[kind];
    if (typeof h !== 'function') { for (const e of group) problems.push({ queue_id: e.item.id, problem: `Items of kind ${kind} cannot be placed yet.` }); continue; }
    // Other areas' handlers return their own part: {rows, events, evidence?, touched_topics?, results?, problems?}.
    const part = await h(env, user, group, ctx, shared);
    if (isObj(part)) {
      shared.out.parts.push(pinned(part));
      if (part.evidence && part.evidence.repoint) shared.out.repoint.push(...part.evidence.repoint);
      for (const t of part.touched_topics || []) shared.out.touched.add(t);
      shared.out.results.push(...(part.results || [])); problems.push(...(part.problems || []));
    }
  }
  const o = shared.out;
  // The rows the placements move (ING's placeRows: misses and gaps waiting on those items, their evidence repointed).
  let placed = { misses: 0, gaps: 0 };
  if (o.placements.length) {
    let p;
    try { p = await placeRows(env, user, o.placements, { actor: ctx.actor, now: ctx.now, topics: shared.topics }); } catch (e) { if (!noTable(e)) throw e; p = null; }
    if (p) {
      o.parts.push(pinned(p));
      if (p.evidence && p.evidence.repoint) o.repoint.push(...p.evidence.repoint);
      for (const t of p.touched_topics || []) o.touched.add(t);
      placed = { misses: p.rows.filter(r => r.table === 'misses').length, gaps: p.rows.filter(r => r.table === 'gaps').length };
    }
  }
  // Taxonomy's own rows and events pair by index; every other part arrives pinned, so they simply follow.
  const own = pinned({ rows: o.rows, events: o.events });
  const allRows = [...own.rows, ...o.parts.flatMap(p => p.rows)];
  const allEvents = [...own.events, ...o.parts.flatMap(p => p.events), ...o.dupes];
  if (!allRows.length) return { refuse: problems.length ? problems.map(p => `${p.queue_id}: ${p.problem}`).join(' ').slice(0, 600) : 'Nothing to place.' };
  const done = o.results.length;
  const summary = `Placed ${done} queue item${done === 1 ? '' : 's'}${o.new_topics.length ? `, ${o.new_topics.length} new topic${o.new_topics.length === 1 ? '' : 's'}` : ''}`;
  return {
    rows: allRows, events: allEvents, evidence: o.repoint.length ? { repoint: o.repoint } : null, touched_topics: [...o.touched],
    count: entries.length, summary,
    reply: { resolved: done, new_topics: o.new_topics, also_placed: placed, problems, results: o.results },
  };
}

// ---------------------------------------------------------------- the hourly job

/**
 * Topics that have earned 'confirmed': evidence from 2 different sources, a finished lesson, or 7 days old with
 * no duplicate suspicion. One read, then one change (topic.confirm as code).
 */
export async function autoConfirm(env, user, { now = Date.now(), apply = null } = {}) {
  const old = now - AUTO_CONFIRM_DAYS * DAY;
  const q = withLessons => env.DB.prepare(`SELECT t.id FROM topics t WHERE t.user_id = ?1 AND t.status = 'proposed' AND (
      (t.created_at <= ?2 AND t.suspect_dupe_of IS NULL)
      OR (SELECT count(DISTINCT e.source) FROM evidence e WHERE e.user_id = t.user_id AND e.topic_id = t.id AND e.held = 0) >= 2
      ${withLessons ? `OR EXISTS (SELECT 1 FROM lessons l WHERE l.user_id = t.user_id AND l.topic_id = t.id AND l.status = 'done')` : ''}) LIMIT 300`).bind(user, old);
  let rows;
  try { rows = (await q(true).all()).results || []; } catch (e) {
    if (!noTable(e)) throw e;
    try { rows = (await q(false).all()).results || []; } catch (e2) { if (noTable(e2)) return { confirmed: 0 }; throw e2; }
  }
  if (!rows.length) return { confirmed: 0 };
  const run = apply || (async (...a) => (await import('./change.js')).applyChange(...a));
  const r = await run(env, user, { actor: 'code', surface: 'cron', op: 'topic.confirm', args: { ids: rows.map(x => x.id), auto: true }, via: 'cron:autoConfirm' });
  return { confirmed: r && r.ok ? rows.length : 0, batch_id: r && r.batch_id };
}

export async function taxonomyHourly(env, user, { now = Date.now() } = {}) {
  const out = {};
  try {
    const y = await refreshYield(env, user, { now });
    out.yield = y && (y.reply || y.summary);
  } catch (e) { console.error('taxonomyHourly: yield failed', e && e.message); out.yield_error = true; }
  try { out.confirm = await autoConfirm(env, user, { now }); } catch (e) { console.error('taxonomyHourly: autoConfirm failed', e && e.message); out.confirm_error = true; }
  return out;
}


async function change(env, user, op, args, via) {
  const { applyChange } = await import('./change.js');
  return applyChange(env, user, { actor: 'mo', surface: 'web', op, args, via });
}
async function respond(r, env, user, ctx) {
  const { changeResponse } = await import('./change.js');
  if (r && r.ok && r.batch_id) await requeueAfter(env, user, r.batch_id, ctx);
  return changeResponse(r);
}

// GET /api/map/search?q=&category=&kind=&status=&limit=
export async function searchRoute(request, env, ctx, params, url, user) {
  const p = url.searchParams;
  const q = p.get('q') || '';
  if (q.length > 120) throw new HttpError(400, 'Search for at most 120 characters.');
  return json({ topics: await searchTopics(env, user, { q, category: p.get('category'), kind: p.get('kind'), status: p.get('status'), limit: p.get('limit') }) });
}

// POST /api/map/topic {topics: [...]} or one topic {name, kind, category_id, ...}
export async function addTopicRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 100_000);
  const args = Array.isArray(body.topics) ? { topics: body.topics } : { topics: [body] };
  return respond(await change(env, user, 'topic.add', args, 'api:POST /api/map/topic'), env, user, ctx);
}

// PATCH /api/map/topic/:id {set: {...}} (the panel's AMBOSS link box and 'Right page', renames, units)
export async function patchTopicRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 50_000);
  const set = isObj(body.set) ? body.set : body;
  return respond(await change(env, user, 'topic.update', { topic: decodeURIComponent(params.id), set }, 'api:PATCH /api/map/topic'), env, user, ctx);
}

// GET /api/map/queue?kind=&category=&limit=&offset=
export async function queueRoute(request, env, ctx, params, url, user) {
  const p = url.searchParams;
  return json(await listQueue(env, user, { kind: p.get('kind') || null, category: p.get('category') || null, limit: p.get('limit'), offset: p.get('offset') }));
}

// A D1 or Worker error that is worth one more try (the live seeding met these as 500s, 25 Oct): a lost connection,
// a reset, an overloaded or restarted storage object, a timeout. A refused or confirm answer is never retried, and a
// failed batch wrote nothing (one batch is one transaction), so the second try plans again from what is there.
export const isTransient = e => /network connection lost|connection (?:reset|closed|refused)|socket hang up|timed? ?out|overloaded|internal error|storage (?:caused|reset)|object (?:to be )?reset|D1_ERROR: (?:Network|Internal)|SQLITE_BUSY|database is locked|503|502/i
  .test(String((e && e.message) || e)) && !/UNIQUE constraint/i.test(String(e && e.message));

/** fn(), and once more after a short pause when it threw a transient error (release-2 fixes: queue.resolve). */
export async function retryTransient(fn, { pauseMs = 250 } = {}) {
  try { return await fn(); } catch (e) {
    if (!isTransient(e)) throw e;
    console.error('transient error, trying once more', e && e.message);
    await new Promise(r => setTimeout(r, pauseMs));
    return fn();
  }
}

// POST /api/map/queue/resolve {items: [...]} (the map's 'Not on the map yet' tray)
export async function resolveQueueRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 200_000);
  const r = await retryTransient(() => change(env, user, 'queue.resolve', { items: body.items }, 'api:POST /api/map/queue/resolve'));
  return respond(r, env, user, ctx);
}

// POST /api/map/seed/vocab: the 23 systems and their names (keyed; a second run changes nothing).
export async function seedVocabRoute(request, env, ctx, params, url, user) {
  const { applyChange, changeResponse } = await import('./change.js');
  return changeResponse(await applyChange(env, user, { actor: 'code', surface: 'web', op: 'vocab.seed', args: {}, via: 'api:POST /api/map/seed/vocab' }));
}

export async function seedYieldRoute(request, env, ctx, params, url, user) {
  const anking = env.ANKI_MCP_URL ? await ankingCounts(env, user, { maxCalls: 10 }) : null;
  const r = await refreshYield(env, user, { anking: anking ? anking.counts : null });
  if (r.refused) return json({ error: r.reason }, 400);
  return json({ ok: true, anking: anking ? { misses: anking.misses, calls: anking.calls, partial: anking.partial, topics: Object.keys(anking.counts).length } : null,
    yield: r.reply || { summary: r.summary }, batch_id: r.batch_id || null });
}

/** The map's seeding numbers (GET /api/map/seed/status), for scripts/seed-map.mjs and plan §17.2's done list. */
export async function seedStatus(env, user) {
  const read = sql => env.DB.prepare(sql).bind(user);
  const out = { categories: 0, aliases: 0, units: { total: 0, A: 0, B: 0, C: 0, pseudo: 0 }, topics: { proposed: 0, confirmed: 0, retired: 0, merged: 0 },
    unit_topics: 0, queue: { open: 0, by_kind: {} }, misses: { total: 0, placed: 0, anki: 0, anki_placed: 0 } };
  const [c, a, u, t, ut] = await env.DB.batch([
    read('SELECT count(*) AS n FROM categories WHERE user_id = ?'),
    read('SELECT count(*) AS n FROM category_aliases WHERE user_id = ?'),
    read('SELECT kind, lane, count(*) AS n FROM units WHERE user_id = ? GROUP BY kind, lane'),
    read('SELECT status, count(*) AS n FROM topics WHERE user_id = ? GROUP BY status'),
    read('SELECT count(*) AS n FROM unit_topics WHERE user_id = ?'),
  ]);
  out.categories = c.results[0].n; out.aliases = a.results[0].n; out.unit_topics = ut.results[0].n;
  for (const r of u.results || []) { out.units.total += r.n; if (r.kind === 'checklist' && r.lane) out.units[r.lane] += r.n; if (r.kind !== 'checklist') out.units.pseudo += r.n; }
  for (const r of t.results || []) out.topics[r.status] = r.n;
  try {
    const [q, m] = await env.DB.batch([
      read(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' GROUP BY kind`),
      read(`SELECT count(*) AS total, sum(topic_id IS NOT NULL) AS placed, sum(source = 'anki' OR anki_mistake_id IS NOT NULL) AS anki,
          sum((source = 'anki' OR anki_mistake_id IS NOT NULL) AND topic_id IS NOT NULL) AS anki_placed FROM misses_live WHERE user_id = ?`),
    ]);
    for (const r of q.results || []) { out.queue.by_kind[r.kind] = r.n; out.queue.open += r.n; }
    const mm = m.results[0] || {};
    out.misses = { total: mm.total || 0, placed: mm.placed || 0, anki: mm.anki || 0, anki_placed: mm.anki_placed || 0 };
  } catch (e) { if (!noTable(e)) throw e; }
  return out;
}

export async function seedStatusRoute(request, env, ctx, params, url, user) {
  return json(await seedStatus(env, user));
}

export { resolveCategory, refreshYield };
