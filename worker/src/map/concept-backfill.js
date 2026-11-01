import { json, readJson, HttpError, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { CONCEPT_RULES, CONCEPT_SCHEMA_PROPS, NOT_CONCEPTUAL, tidyConcept } from '../../../public/js/shared/concept.js';
import { causeOf } from '../../../public/js/shared/cause.js';
import { fnv1a } from './ingest/map-fields.js';
import { stemSafe, questionSafe } from './guard.js';
import { applyConcepts, tagRow, upsertStatement } from './concepts.js';

export const BACKFILL = { limit: 30, max: 60, per_call: 12, reserve_usd: 1, words_max: 600 };

const deps = {
  claude: () => import('../claude.js'),
  reserve: async env => { const db = await import('../db.js'); return db.reserveSpend(env, BACKFILL.reserve_usd, await db.spendCap(env)); },
  undoBatch: async (...a) => (await import('./undo.js')).undoBatch(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const num = v => Number(v) || 0;

// ---------------------------------------------------------------- the judge call

export const BACKFILL_SYSTEM = `You read why Mo, a learner preparing for USMLE Step 2 CK, missed some practice questions and the wrong beliefs he held, to find the underlying principle each one rests on, so one misunderstanding behind several topics can be taught once. You never see the questions. For each item you get its label, the topic it was on, the cause an earlier reviewer named and its detail, and his words:
- "His words" are what he said aloud (transcribed by Whisper, so expect misheard medical words). Only these can be quoted.
- "Summary" is a reviewer's line, not his words: use it to understand, never quote it.
Most misses are a single missing fact and have no concept: leave concept empty for those. Name a concept only when the error comes from misunderstanding a principle that other topics share. When one of the map's concept names below fits, use it exactly. Answer for every ref given.

${CONCEPT_RULES}

Answer with the JSON object only.`;

export const BACKFILL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', ...Object.keys(CONCEPT_SCHEMA_PROPS)],
    properties: { ref: { type: 'string' }, ...CONCEPT_SCHEMA_PROPS } } } },
};

/** The words an item is judged on (pure), each cut short and never question text. */
export function wordsOf(x) {
  const safe = (v, n) => { const t = cut(v, n); return t && stemSafe(questionSafe(t)) ? t : null; };
  if (x.kind === 'belief') return { said: x.words === 'mo' ? safe(x.belief, 300) : null, summary: x.words === 'mo' ? null : safe(x.belief, 300) };
  return { said: safe(x.his_words || x.cause_quote, BACKFILL.words_max), summary: safe(x.my_reasoning, 300) };
}
export const wordsHash = (x, w) => fnv1a(JSON.stringify([x.kind, w.said, w.summary, x.cause || null, x.cause_detail || null, x.topic_name || null]));

/** The user turn (pure): the map's concept names, then one block of lines per item, refs i1, i2, ... */
export function backfillMessage(items, conceptNames = []) {
  const head = conceptNames.length ? `The map's concept names so far: ${conceptNames.slice(0, 120).join('; ')}.` : 'The map has no concept names yet.';
  return [head, '', ...items.map(({ ref, x, w }) => {
    if (x.kind === 'belief') return [`${ref}: a wrong belief${x.ref ? ` (${x.ref})` : ''} on ${x.topic_name || 'an unnamed topic'}.`,
      w.said ? `  His words: "${w.said}"` : `  Summary (not his words): ${w.summary || '(none)'}`].join('\n');
    const c = causeOf(x);
    return [`${ref}: ${x.label || 'a miss'}, ${x.result === 'flawed' ? 'right but shaky' : 'wrong'}${x.confidence ? `, ${x.confidence}` : ''}, on ${x.topic_name || 'an unnamed topic'}.`,
      ...(c ? [`  Cause: ${c.cause.replace(/_/g, ' ')}${c.detail ? `: ${c.detail}` : ''}${c.inferred === false ? ' (he said so)' : ''}.`] : []),
      `  His words: ${w.said ? `"${w.said}"` : '(none recorded)'}`,
      ...(w.summary ? [`  Summary (not his words): ${w.summary}`] : [])].join('\n');
  })].join('\n\n');
}

/** The judge's answer made safe (pure): Map(ref -> {concept, concept_discipline, concept_quote}) for every ref answered. */
export function tidyBackfill(data, refs) {
  const out = new Map();
  for (const x of (data && Array.isArray(data.items) ? data.items : [])) {
    if (!x || !refs.has(x.ref)) continue;
    const c = tidyConcept(x);
    out.set(x.ref, c.concept && questionSafe(c.concept) ? c : { concept: null, concept_discipline: null, concept_quote: null });
  }
  return out;
}

// ---------------------------------------------------------------- reads

// Misses with no concept tag yet (by the miss, or by the question a judge already tagged), placed, live, not a slip.
const MISS_SQL = `SELECT m.id, m.label, m.at, m.day, m.result, m.confidence, m.error_type, m.flaw_kind, m.outcome, m.cause, m.cause_quote, m.cause_inferred, m.cause_detail,
    m.my_reasoning, m.his_words, m.topic_id, t.name AS topic_name
  FROM misses m JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id AND t.category_id NOT LIKE 'foundation-%'
  WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.result IN ('wrong', 'flawed') AND coalesce(m.cause, '') NOT IN ('misread', 'guess')
    AND coalesce(m.error_type, '') NOT IN ('misread', 'test_taking')
    AND NOT EXISTS (SELECT 1 FROM concept_tags c WHERE c.user_id = m.user_id AND (c.miss_id = m.id OR c.id = 'miss:' || m.id
      OR (m.uworld_block_id IS NOT NULL AND c.uworld_block_id = m.uworld_block_id AND c.uworld_q = m.uworld_q)
      OR (m.block_id IS NOT NULL AND c.block_id = m.block_id AND c.q_index = m.q_index)) AND c.status != 'judged')`;
const MISC_SQL = `SELECT c.id, c.topic_id, coalesce(t.name, c.topic_name) AS topic_name, c.belief, c.words, c.ref, c.first_seen FROM misconceptions c
  LEFT JOIN topics t ON t.user_id = c.user_id AND t.id = c.topic_id
  WHERE c.user_id = ?1 AND c.status != 'closed' AND NOT EXISTS (SELECT 1 FROM concept_tags g WHERE g.user_id = c.user_id AND g.id = 'misc:' || c.id AND g.status != 'judged')`;

async function readItems(env, user, n) {
  const res = await env.DB.batch([
    env.DB.prepare(`${MISS_SQL} ORDER BY m.at DESC LIMIT ?2`).bind(user, n),
    env.DB.prepare(`${MISC_SQL} ORDER BY c.last_seen DESC LIMIT ?2`).bind(user, n),
    env.DB.prepare(`SELECT count(*) AS n FROM (${MISS_SQL})`).bind(user),
    env.DB.prepare(`SELECT count(*) AS n FROM (${MISC_SQL})`).bind(user),
    env.DB.prepare(`SELECT t.name FROM topics t WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed') AND t.category_id LIKE 'foundation-%' ORDER BY t.name LIMIT 200`).bind(user),
  ]);
  const misses = (res[0].results || []).map(m => ({ ...m, kind: 'miss', key: `miss:${m.id}` }));
  const beliefs = (res[1].results || []).map(b => ({ ...b, kind: 'belief', key: `misc:${b.id}` }));
  // Misses first (the larger share), then beliefs, within the limit.
  const items = [...misses, ...beliefs].slice(0, n);
  const total = num((res[2].results || [])[0]?.n) + num((res[3].results || [])[0]?.n);
  return { items, left: Math.max(0, total - items.length), names: (res[4].results || []).map(r => r.name) };
}

// ---------------------------------------------------------------- the job

/**
 * Judge (or reuse) concepts for up to `limit` errors, then report (dry_run) or apply them. Returns {dry_run, run_key,
 * judged, reused, held?, usd, items, counts, batches, left}.
 */
export async function backfill(env, user, { dry_run = true, limit = BACKFILL.limit, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(BACKFILL.max, Number(limit) || BACKFILL.limit));
  let read;
  try { read = await readItems(env, user, n); } catch (e) { if (noTable(e)) throw new HttpError(503, 'Run migration 0063 first.'); throw e; }
  const run_key = dry_run ? null : `bf_${now.toString(36)}`;
  const out = { dry_run: !!dry_run, run_key, judged: 0, reused: 0, usd: 0, items: [], counts: { read: read.items.length, concepts: 0, new_concepts: 0, applied: 0, queued: 0 },
    batches: [], left: read.left };
  if (!read.items.length) { await noteRun(env, user, out, now); return out; }

  const work = read.items.map((x, i) => { const w = wordsOf(x); return { ref: `i${i + 1}`, x, w, hash: wordsHash(x, w) }; });
  const kept = new Map(((await env.DB.prepare(`SELECT * FROM concept_tags WHERE user_id = ? AND status IN ('judged', 'none') AND id IN (SELECT value FROM json_each(?))`)
    .bind(user, JSON.stringify(work.map(x => x.x.key))).all()).results || []).map(r => [r.id, r]));
  const verdict = new Map();
  for (const x of work) {
    const k = kept.get(x.x.key);
    if (k && k.words_hash === x.hash) { verdict.set(x.x.key, k.status === 'none' ? { concept: null } : { concept: k.concept, concept_discipline: k.discipline, concept_quote: k.quote }); out.reused++; }
  }

  // The judge, a dozen a call, each under the hub's caps; a cap that is reached stops here with what it has.
  for (const part of chunk(work.filter(x => !verdict.has(x.x.key)), BACKFILL.per_call)) {
    let release;
    try { release = await deps.reserve(env); } catch (e) { if (e && e.status === 429) { out.held = e.message; break; } throw e; }
    let r;
    try {
      const { callJson } = await deps.claude();
      r = await callJson(env, { role: 'reviewer', use: 'backfill', system: BACKFILL_SYSTEM, schema: BACKFILL_SCHEMA, effort: 'high', maxTokens: 12000,
        messages: [{ role: 'user', content: backfillMessage(part, read.names) }] });
      out.usd += Number(r.usd) || 0;
    } catch (e) {
      out.usd += Number(e && e.usd) || 0;
      console.error('concept back-fill call failed', e && e.message);
      out.failed = (out.failed || 0) + part.length;
      continue;
    } finally { await release(0); }
    const got = tidyBackfill(r.data, new Set(part.map(x => x.ref)));
    const rows = [];
    for (const x of part) {
      const c = got.get(x.ref);
      if (!c) continue;
      verdict.set(x.x.key, c);
      out.judged++;
      rows.push(storedRow(x, c, now));
    }
    if (rows.length) await upsertStatement(env, user, rows).run();
  }

  // What would be tagged: each error's concept, and whether a concept topic carries its name yet.
  const names = new Set(read.names.map(s => s.toLowerCase()));
  const ids = [];
  for (const x of work) {
    const v = verdict.get(x.x.key);
    if (!v) continue;
    const item = { key: x.x.key, label: x.x.kind === 'belief' ? (x.x.ref || 'a wrong belief') : x.x.label, topic: x.x.topic_name || null, concept: v.concept || null,
      discipline: v.concept ? v.concept_discipline : null, on_map: v.concept ? names.has(String(v.concept).toLowerCase()) : null };
    out.items.push(item);
    if (v.concept) { out.counts.concepts++; if (!item.on_map) out.counts.new_concepts++; ids.push(x.x.key); }
  }
  if (!dry_run && ids.length) {
    const st = env.DB.prepare(`UPDATE concept_tags SET status = 'pending', run_key = ?3, updated_at = ?4 WHERE user_id = ?1 AND status = 'judged'
        AND id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(ids), run_key, now);
    await st.run();
    const a = await applyConcepts(env, user, { now, only: ids, note: false, via: 'api:POST /api/map/concepts/backfill' });
    Object.assign(out.counts, { applied: a.applied, queued: a.queued, skipped: a.skipped, links: a.links });
    out.batches = a.batches;
  }
  await noteRun(env, user, out, now);
  return out;
}

// A judged error as stored (judged with its concept, or none), keyed by the error.
function storedRow(x, c, now) {
  const base = { id: x.x.key, source: 'backfill', concept: c.concept, concept_discipline: c.concept_discipline, concept_quote: c.concept_quote,
    cause: x.x.kind === 'miss' ? (causeOf(x.x) || {}).cause || null : null, confidence: x.x.confidence || null, words_hash: x.hash,
    miss_id: x.x.kind === 'miss' ? x.x.id : null, misconception_id: x.x.kind === 'belief' ? x.x.id : null, belief: x.x.kind === 'belief',
    clinical_topic_id: x.x.topic_id || null, clinical_name: x.x.topic_name || null, ref: x.x.kind === 'belief' ? x.x.ref : x.x.label,
    at: Number(x.x.at) || Number(x.x.first_seen) || now };
  const row = c.concept ? tagRow(base, now) : null;
  if (row) return { ...row, status: 'judged' };
  // Not conceptual (or a slip): kept as none, so it is not judged again until its words change.
  return { id: base.id, source: 'backfill', block_id: null, q_index: null, uworld_block_id: null, uworld_q: null, misconception_id: base.misconception_id, miss_id: base.miss_id,
    clinical_topic_id: base.clinical_topic_id, clinical_name: cut(base.clinical_name, 120), ref: cut(base.ref, 60), concept: null, concept_key: null, discipline: null, quote: null,
    cause: base.cause, confidence: base.confidence, weight: 0, status: 'none', reason: NOT_CONCEPTUAL.includes(base.cause) ? 'slip or guess' : 'not conceptual',
    words_hash: x.hash, run_key: null, at: base.at, judged_at: now, updated_at: now };
}

/** Undo a back-fill run: each of its batches (newest first) through realtime's undoBatch, its tags marked undone. */
export async function undoBackfill(env, user, runKey, { now = Date.now() } = {}) {
  let key = runKey;
  if (key === true) {
    const r = await env.DB.prepare(`SELECT run_key FROM concept_tags WHERE user_id = ? AND run_key IS NOT NULL AND status = 'applied' ORDER BY applied_at DESC LIMIT 1`).bind(user).first();
    key = r && r.run_key;
  }
  if (typeof key !== 'string' || !key) throw new HttpError(404, 'No back-fill run to undo.');
  const rows = (await env.DB.prepare(`SELECT batch_id, max(applied_at) AS at FROM concept_tags WHERE user_id = ? AND run_key = ? AND status = 'applied' AND batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY at DESC`).bind(user, key).all()).results || [];
  const results = [];
  for (const r of rows) results.push({ ...(await deps.undoBatch(env, user, r.batch_id, { actor: 'code', surface: 'code', via: 'api:POST /api/map/concepts/backfill' })), batch_id: r.batch_id });
  const done = results.filter(x => !x.conflict).map(x => x.batch_id);
  if (done.length) {
    await env.DB.prepare(`UPDATE concept_tags SET status = 'undone', updated_at = ?3 WHERE user_id = ?1 AND run_key = ?2 AND status = 'applied'
        AND batch_id IN (SELECT value FROM json_each(?4))`).bind(user, key, now, JSON.stringify(done)).run();
  }
  const out = { run_key: key, undone: done.length, results };
  await noteJob(env, { job: 'concepts', key: `undo:${londonDay(now)}`, ref: 'undo', user, add: true, at: now, state: 'ok', counts: { undone: done.length } });
  return out;
}

// Recent activity: one line a day for dry runs (the latest replaces it) and one for real runs (added up).
function noteRun(env, user, out, now, error = null) {
  const c = out.counts || {};
  const ref = out.dry_run ? 'dry' : 'run';
  return noteJob(env, { job: 'concepts', key: `${ref}:${londonDay(now)}`, ref, user, add: !out.dry_run, at: now,
    state: error ? 'failed' : out.held ? 'held' : 'ok', detail: error || out.held || null,
    counts: { read: num(c.read), judged: num(out.judged), reused: num(out.reused), concepts: num(c.concepts), new_concepts: num(c.new_concepts), applied: num(c.applied),
      queued: num(c.queued), batches: (out.batches || []).length, left: num(out.left) } });
}

// POST /api/map/concepts/backfill {dry_run = true, limit, undo}
export async function backfillRoute(request, env, ctx, params, url, user) {
  const body = (await readJson(request, 20_000).catch(() => ({}))) || {};
  for (const k of Object.keys(body)) if (!['dry_run', 'limit', 'undo'].includes(k)) throw new HttpError(400, `Unknown field ${k}.`);
  const now = Date.now();
  if (body.undo != null) {
    if (!(body.undo === true || (typeof body.undo === 'string' && /^bf_[a-z0-9]{4,16}$/.test(body.undo)))) throw new HttpError(400, 'undo is a run key (bf_...) or true for the newest run.');
    try { return json(await undoBackfill(env, user, body.undo, { now })); } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) await noteJob(env, { job: 'concepts', key: `undo:${londonDay(now)}:failed`, ref: 'undo', user, at: now, state: 'failed', detail: e });
      throw e;
    }
  }
  const dry = body.dry_run !== false;
  try {
    return json(await backfill(env, user, { dry_run: dry, limit: body.limit, now }));
  } catch (e) {
    await noteRun(env, user, { dry_run: dry, counts: {} }, now, (e && e.message) || 'failed');   // a failure posts too
    throw e;
  }
}
