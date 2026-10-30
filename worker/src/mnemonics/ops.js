// Mnemonics' changes (registry mnemonics.js; CONTRACT I35). Each is one batch through applyChange, so Recent activity
// lists it and Undo works: add, import (the seed and Claude's lists, idempotent by source_ref), edit, remove (soft)
// and rate (one test of one direction: the FSRS row and, on a miss, a light self-rating on the topics it covers).
import { summaryOf, rand } from '../map/events.js';
import { londonDay } from '../util.js';
import { cleanFields, ratingOf, stepReview, shapeMnemonic, shapeReview, ID, DIRS, SOURCES, CAP } from './store.js';

export const IMPORT_MAX = 200;
export const REMOVE_MAX = 50;
const FIELDS = ['cue', 'about', 'kind', 'items_json', 'topics_json', 'category_id', 'notes'];
const REVIEW_COLS = ['due', 'stability', 'difficulty', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review', 'last_rating', 'last_missed_json'];
export const WRITES = {
  mnemonics: { actions: 'iud', cols: [...FIELDS, 'deleted_at'] },
  mnemonic_reviews: { actions: 'iu', cols: ['mnemonic_id', 'dir', ...REVIEW_COLS, 'first_at'] },
};
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const unknownArg = (a, keys) => Object.keys(a || {}).find(k => !keys.includes(k));
const label = m => `${m.cue} (${m.about})`;

/** The live topics behind ids (a merged one read as the topic it became): Map asked id -> {id, name, category_id}. */
export async function liveTopics(env, user, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = (await env.DB.prepare(`SELECT t0.id AS asked, t.id, t.name, t.category_id, t.status FROM topics t0
    LEFT JOIN topics t ON t.user_id = t0.user_id AND t.id = CASE WHEN t0.status = 'merged' THEN t0.merged_into ELSE t0.id END
    WHERE t0.user_id = ? AND t0.id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify([...new Set(ids)])).all()).results || [];
  for (const r of rows) if (r.id && r.status !== 'retired' && r.status !== 'merged') out.set(r.asked, { id: r.id, name: r.name, category_id: r.category_id });
  return out;
}

// The topics a mnemonic names, as live ids: {ids, names, missing}. A subject left empty follows the first topic.
async function placeTopics(env, user, fields, map = null) {
  if (fields.topics_json == null) return { names: new Map(), missing: [] };
  const asked = parse(fields.topics_json, []);
  const live = map || await liveTopics(env, user, asked);
  const ids = [], missing = [], names = new Map();
  for (const id of asked) {
    const t = live.get(id);
    if (!t) { missing.push(id); continue; }
    if (!ids.includes(t.id)) ids.push(t.id);
    names.set(t.id, t);
  }
  fields.topics_json = JSON.stringify(ids);
  if (fields.category_id === null && ids.length && !fields.category_set) fields.category_id = names.get(ids[0]).category_id || null;
  delete fields.category_set;
  return { names, missing };
}

const sourceFor = (ctx, a) => {
  if (ctx.actor === 'mo') return 'mo';
  if (a.source != null) return SOURCES.includes(a.source) ? a.source : null;
  return ctx.actor === 'claude' ? 'claude' : null;
};

// ---------------------------------------------------------------- mnemonic.add

const ADD_KEYS = ['cue', 'about', 'kind', 'items', 'category_id', 'topics', 'notes', 'source', 'source_ref'];

export async function planAdd(env, user, args, ctx) {
  const a = args || {};
  const bad = unknownArg(a, ADD_KEYS);
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  const c = cleanFields(a);
  if (c.refuse) return c;
  const source = sourceFor(ctx, a);
  if (!source) return { refuse: `source is one of ${SOURCES.join(', ')}.`, field: 'source' };
  const ref = a.source_ref == null ? null : String(a.source_ref).trim().slice(0, CAP.source_ref) || null;
  const f = { ...c.fields, category_set: a.category_id != null && a.category_id !== '' };
  const { names, missing } = await placeTopics(env, user, f);
  if (missing.length) return { refuse: `There is no topic ${missing[0]} on the map.`, field: 'topics' };
  const id = `mn_${rand().slice(0, 16)}`;
  const after = { ...f, source, source_ref: ref, created_by: ctx.actor, created_at: ctx.now, updated_at: ctx.now, deleted_at: null };
  const topics = parse(f.topics_json, []);
  const summary = summaryOf(`Mnemonic added: ${label(f)}`);
  return {
    rows: [{ table: 'mnemonics', op: 'insert', key: { id }, before: null, after }],
    events: [{ target_type: 'mnemonics', target_id: id, topic_id: topics[0] || null, summary }],
    // Claude's words are checked against the exam questions on the topics they cover (guard.js leak index).
    touched_topics: ctx.actor === 'claude' ? topics : [],
    summary, reply: { mnemonic: shapeMnemonic({ id, ...after }, {}, names) },
  };
}

// ---------------------------------------------------------------- mnemonic.import

export async function planImport(env, user, args, ctx) {
  const a = args || {};
  const bad = unknownArg(a, ['source', 'items']);
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  const source = sourceFor(ctx, a);
  if (!source || source === 'mo') return { refuse: 'source is onenote, ajmonics or claude.', field: 'source' };
  if (!Array.isArray(a.items) || !a.items.length || a.items.length > IMPORT_MAX) return { refuse: `items is a list of 1 to ${IMPORT_MAX} mnemonics.`, field: 'items' };
  const clean = [];
  for (const [i, it] of a.items.entries()) {
    const extra = unknownArg(it, ['source_ref', 'cue', 'about', 'kind', 'items', 'category_id', 'topics', 'notes']);
    if (extra) return { refuse: `Item ${i + 1}: unknown argument ${extra}.` };
    const ref = it && typeof it.source_ref === 'string' ? it.source_ref.trim().slice(0, CAP.source_ref) : '';
    if (!ref) return { refuse: `Item ${i + 1} needs its source_ref (where it came from, so a second import matches it).`, field: 'source_ref' };
    const c = cleanFields(it);
    if (c.refuse) return { refuse: `Item ${i + 1} (${ref}): ${c.refuse}`, field: c.field };
    clean.push({ ref, f: { ...c.fields, category_set: it.category_id != null && it.category_id !== '' } });
  }
  const refs = [...new Set(clean.map(x => x.ref))];
  if (refs.length !== clean.length) return { refuse: 'Two items share a source_ref.', field: 'source_ref' };
  const have = new Map(((await env.DB.prepare(`SELECT * FROM mnemonics WHERE user_id = ? AND source = ? AND source_ref IN (SELECT value FROM json_each(?))`)
    .bind(user, source, JSON.stringify(refs)).all()).results || []).map(r => [r.source_ref, r]));
  const live = await liveTopics(env, user, clean.flatMap(x => parse(x.f.topics_json, [])));
  const rows = [], events = [];
  let dropped = 0, kept = 0;
  for (const { ref, f } of clean) {
    dropped += (await placeTopics(env, user, f, live)).missing.length;
    const was = have.get(ref);
    if (!was) {
      const id = `mn_${rand().slice(0, 16)}`;
      rows.push({ table: 'mnemonics', op: 'insert', key: { id }, before: null,
        after: { ...f, source, source_ref: ref, created_by: ctx.actor, created_at: ctx.now, updated_at: ctx.now, deleted_at: null } });
      events.push({ target_type: 'mnemonics', target_id: id, topic_id: parse(f.topics_json, [])[0] || null, summary: summaryOf(`Mnemonic added: ${label(f)}`) });
      continue;
    }
    if (was.deleted_at != null || Number(was.updated_at) !== Number(was.created_at)) { kept += 1; continue; }
    const diff = Object.fromEntries(FIELDS.filter(k => (was[k] ?? null) !== (f[k] ?? null)).map(k => [k, f[k] ?? null]));
    if (!Object.keys(diff).length) continue;
    rows.push({ table: 'mnemonics', op: 'update', key: { id: was.id }, before: Object.fromEntries(Object.keys(diff).map(k => [k, was[k] ?? null])), after: diff });
    events.push({ target_type: 'mnemonics', target_id: was.id, topic_id: parse(f.topics_json, [])[0] || null, summary: summaryOf(`Mnemonic updated: ${label(f)}`) });
  }
  if (!rows.length) return { noop: true, summary: 'Those mnemonics are already in the hub.' };
  const added = rows.filter(r => r.op === 'insert').length;
  const summary = summaryOf(`Mnemonics imported: ${added} added, ${rows.length - added} updated`);
  return { rows, events, summary, count: rows.length,
    touched_topics: ctx.actor === 'claude' ? [...new Set(rows.flatMap(r => parse(r.after.topics_json || '[]', [])))] : [],
    reply: { added, updated: rows.length - added, kept_his_edits: kept, topics_dropped: dropped } };
}

// ---------------------------------------------------------------- mnemonic.edit

export async function planEdit(env, user, args, ctx) {
  const a = args || {};
  const bad = unknownArg(a, ['id', 'cue', 'about', 'kind', 'items', 'category_id', 'topics', 'notes']);
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  if (typeof a.id !== 'string' || !ID.test(a.id)) return { refuse: 'id is the mnemonic to change.', field: 'id' };
  const was = await env.DB.prepare('SELECT * FROM mnemonics WHERE user_id = ? AND id = ?').bind(user, a.id).first();
  if (!was || was.deleted_at != null) return { refuse: 'There is no mnemonic with that id.', field: 'id' };
  const { id, ...rest } = a;
  const c = cleanFields(rest, { partial: true });
  if (c.refuse) return c;
  // A subject set to empty follows the first topic, as on add.
  const f = { ...c.fields, category_set: !(Object.prototype.hasOwnProperty.call(rest, 'category_id') && (rest.category_id == null || rest.category_id === '')) };
  if (!f.category_set && f.topics_json == null) f.topics_json = was.topics_json;
  const { names, missing } = await placeTopics(env, user, f);
  if (missing.length) return { refuse: `There is no topic ${missing[0]} on the map.`, field: 'topics' };
  delete f.category_set;
  const diff = Object.fromEntries(Object.entries(f).filter(([k, v]) => (was[k] ?? null) !== (v ?? null)));
  if (!Object.keys(diff).length) return { noop: true, summary: 'That mnemonic already says that.' };
  const after = { ...diff, updated_at: ctx.now };
  const now = { ...was, ...after };
  const summary = summaryOf(`Mnemonic edited: ${label(now)}`);
  const topics = parse(now.topics_json, []);
  return {
    rows: [{ table: 'mnemonics', op: 'update', key: { id }, before: Object.fromEntries(Object.keys(after).map(k => [k, was[k] ?? null])), after }],
    events: [{ target_type: 'mnemonics', target_id: id, topic_id: topics[0] || null, summary }],
    touched_topics: ctx.actor === 'claude' ? topics : [],
    summary, reply: { mnemonic: shapeMnemonic(now, {}, names) },
  };
}

// ---------------------------------------------------------------- mnemonic.remove

export async function planRemove(env, user, args, ctx) {
  const a = args || {};
  const bad = unknownArg(a, ['id', 'ids']);
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  const ids = [...new Set(a.ids != null ? a.ids : [a.id])];
  if (!ids.length || ids.length > REMOVE_MAX || !ids.every(x => typeof x === 'string' && ID.test(x))) return { refuse: `ids is a list of 1 to ${REMOVE_MAX} mnemonic ids.`, field: 'ids' };
  const rows0 = (await env.DB.prepare(`SELECT id, cue, about, topics_json, deleted_at FROM mnemonics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(ids)).all()).results || [];
  const live = rows0.filter(r => r.deleted_at == null);
  if (!live.length) return rows0.length ? { noop: true, summary: 'Those mnemonics are already removed.' } : { refuse: 'There is no mnemonic with that id.', field: 'ids' };
  const summary = summaryOf(live.length === 1 ? `Mnemonic removed: ${label(live[0])}` : `${live.length} mnemonics removed`);
  return {
    rows: live.map(r => ({ table: 'mnemonics', op: 'soft_delete', key: { id: r.id }, before: { deleted_at: null }, after: { deleted_at: ctx.now } })),
    events: live.map(r => ({ target_type: 'mnemonics', target_id: r.id, topic_id: parse(r.topics_json, [])[0] || null, summary: summaryOf(`Mnemonic removed: ${label(r)}`) })),
    count: live.length, summary, ask: `Remove ${live.length} mnemonics (${live.slice(0, 3).map(r => r.cue).join(', ')}${live.length > 3 ? ', …' : ''})?`,
    reply: { removed: live.map(r => r.id) },
  };
}

export const removeTier = (args, plan, ctx) => (ctx && ctx.actor === 'claude' && plan && plan.rows && plan.rows.length > 5 ? 'confirm' : 'free');

// ---------------------------------------------------------------- mnemonic.rate

export async function planRate(env, user, args, ctx) {
  const a = args || {};
  const bad = unknownArg(a, ['id', 'dir', 'missed', 'easy']);
  if (bad) return { refuse: `Unknown argument ${bad}.` };
  if (typeof a.id !== 'string' || !ID.test(a.id)) return { refuse: 'id is the mnemonic tested.', field: 'id' };
  if (!DIRS.includes(a.dir)) return { refuse: 'dir is fwd (cue to expansion) or rev (what it is for to cue).', field: 'dir' };
  const [m, prev] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM mnemonics WHERE user_id = ? AND id = ?').bind(user, a.id),
    env.DB.prepare('SELECT * FROM mnemonic_reviews WHERE user_id = ? AND mnemonic_id = ? AND dir = ?').bind(user, a.id, a.dir),
  ]).then(r => r.map(x => (x.results || [])[0] || null));
  if (!m || m.deleted_at != null) return { refuse: 'There is no mnemonic with that id.', field: 'id' };
  const total = a.dir === 'rev' ? 1 : parse(m.items_json, []).length;
  const missed = a.missed == null ? [] : a.missed;
  if (!Array.isArray(missed) || !missed.every(i => Number.isInteger(i) && i >= 0 && i < total) || new Set(missed).size !== missed.length) {
    return { refuse: `missed lists the items he missed, by position (0 to ${total - 1}).`, field: 'missed' };
  }
  const rating = ratingOf(missed.length, total, a.easy === true);
  const step = stepReview(prev, rating, ctx.now);
  const after = { ...step, last_missed_json: JSON.stringify([...missed].sort((x, y) => x - y)), updated_at: ctx.now };
  const key = { mnemonic_id: a.id, dir: a.dir };
  const row = prev
    ? { table: 'mnemonic_reviews', op: 'update', key, before: Object.fromEntries([...REVIEW_COLS, 'updated_at'].map(k => [k, prev[k] ?? null])), after }
    : { table: 'mnemonic_reviews', op: 'insert', key, before: null, after: { ...after, first_at: ctx.now } };
  const topics = [...(await liveTopics(env, user, parse(m.topics_json, []))).values()];
  const upsert = [];
  if (rating === 'again' || rating === 'hard') {
    const day = londonDay(ctx.now);
    for (const t of topics) {
      upsert.push({ obs_key: `mnem:${a.id}:${a.dir}:${day}:${t.id}`, slot: 0, topic_id: t.id, category_id: t.category_id || null, kind: 'self_rating', rating,
        at: ctx.now, day, source: 'mnemonics', source_ref: a.id, created_by: ctx.actor });
    }
  }
  const got = total - missed.length;
  const word = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }[rating];
  const summary = summaryOf(`Mnemonic tested: ${m.cue}${a.dir === 'rev' ? ' (from what it is for)' : ''}, ${got} of ${total} (${word})`);
  return {
    rows: [row],
    events: [{ target_type: 'mnemonic_reviews', target_id: `${a.id}:${a.dir}`, topic_id: topics[0] ? topics[0].id : null, summary }],
    evidence: upsert.length ? { upsert } : undefined,
    touched_topics: upsert.length ? topics.map(t => t.id) : [],
    summary, reply: { id: a.id, dir: a.dir, rating, review: shapeReview({ ...(prev || { first_at: ctx.now }), ...after }), nudged: upsert.map(u => u.topic_id) },
  };
}
