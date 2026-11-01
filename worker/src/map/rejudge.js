import { json, readJson, HttpError, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { CAUSE_RULES, CAUSE_SCHEMA_PROPS, CAUSE_VERSION, causeOf, causeWords, confusionShown, tidyCause } from '../../../public/js/shared/cause.js';
import { splitByStarts } from '../../../public/js/uworld/split.js';
import { fnv1a, rawKey, withCause, MISS_CAUSE_COLS } from './ingest/map-fields.js';
import { stemSafe, questionSafe } from './guard.js';
import { lookAlikeHead, lookAlikeNames } from './links.js';
import { AUDIT_SPECS, auditAndReask, checkItem, reaskText, recordAudit, auditCounts } from '../ai-audit.js';

export const REJUDGE = { limit: 30, max: 60, per_call: 12, per_batch: 5, reserve_usd: 1, words_max: 1200 };

// Other areas' code, behind one object so tests can swap it (_setDeps).
const deps = {
  claude: () => import('../claude.js'),
  reserve: async env => { const db = await import('../db.js'); return db.reserveSpend(env, REJUDGE.reserve_usd, await db.spendCap(env)); },
  writeBatch: async (...a) => (await import('./events.js')).writeBatch(...a),
  lookAlikeParts: async (...a) => (await import('./ingest/hub.js')).lookAlikeParts(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

// ---------------------------------------------------------------- the judge call (the judges' own cause rules)

export const REJUDGE_SYSTEM = `You re-read why Mo, a learner preparing for USMLE Step 2 CK, missed some practice questions, to name the cause of each miss by the rules below. You never see the questions. For each miss you get its label, the topic it tested, a look-alike an earlier reviewer named (a teaching contrast that may or may not be something he mixed up), its error type and step as judged before, how sure he was, and his words:
- "His words" are what he said aloud while answering (transcribed by Whisper, so expect misheard medical words). Only these can be quoted.
- "Summary" is an earlier reviewer's line about his reasoning, not his words: use it to understand, never quote it, and treat "Going by my pick" as a guess from his letter.
When his words are missing or say nothing about why, infer the most likely cause from the error type and step, set cause_inferred true and cause_quote empty. Most misses are a missing fact; a confusion needs his words. Answer for every ref given.

${CAUSE_RULES}

Answer with the JSON object only.`;

export const REJUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', ...Object.keys(CAUSE_SCHEMA_PROPS)],
    properties: { ref: { type: 'string' }, ...CAUSE_SCHEMA_PROPS } } } },
};

/** The words one miss is judged on (pure): {said, summary, source}, each cut short. */
export function wordsOf(m, said = null) {
  return { said: cut(said, REJUDGE.words_max), summary: cut(m.my_reasoning, 400), source: m.reasoning_source || null };
}
/** What a judgement depends on (pure): its words, look-alike and error type, hashed. */
export const wordsHash = (m, w) => fnv1a(JSON.stringify([w.said, w.summary, m.look_alikes || null, m.look_alike_names_json || null, m.error_type || null, CAUSE_VERSION]));

/** The user turn (pure): one block of lines per miss, ref m1, m2, ... */
export function rejudgeMessage(items) {
  return items.map(({ ref, m, w }) => [
    `${ref}: ${m.label || 'a miss'}, ${m.result === 'flawed' ? 'right but shaky' : 'wrong'}${m.confidence ? `, ${m.confidence}` : ''}${m.error_type ? `; error type ${String(m.error_type).replace(/_/g, ' ')}` : ''}${m.step ? `; step ${m.step}` : ''}${m.flaw_kind ? `; ${String(m.flaw_kind).replace(/_/g, ' ')}` : ''}.`,
    `  Topic tested: ${m.topic_name || m.condition_raw || m.topic_raw || 'unknown'}.`,
    ...(lookAlikeHead(m.look_alikes) || lookAlikeNames(m).length ? [`  Look-alike named before: ${lookAlikeHead(m.look_alikes) || lookAlikeNames(m)[0].text}.`] : []),
    `  His words: ${w.said ? `"${w.said}"` : '(none recorded)'}`,
    ...(w.summary ? [`  Summary (${w.source === 'mo' ? 'his own note' : 'not his words'}): ${w.summary}`] : []),
  ].join('\n')).join('\n\n');
}

/** The judge's answer made safe (pure): Map(ref -> {cause, cause_quote, cause_inferred, cause_detail}). */
export function tidyRejudge(data, refs) {
  const out = new Map();
  for (const x of (data && Array.isArray(data.items) ? data.items : [])) {
    if (!x || !refs.has(x.ref)) continue;
    const c = tidyCause(x);
    if (!c.cause) continue;
    out.set(x.ref, { ...c, cause_quote: c.cause_quote ? stemSafe(c.cause_quote) : null, cause_detail: c.cause_detail ? questionSafe(c.cause_detail) : null });
  }
  return out;
}

// ---------------------------------------------------------------- reads

const MISS_SQL = `SELECT m.*, t.name AS topic_name FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id
  WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.topic_id IS NOT NULL AND m.result IN ('wrong', 'flawed')
    AND json_extract(coalesce(m.mo_corrected_json, '{}'), '$.cause') IS NULL`;

async function readMisses(env, user, { ids, limit }) {
  const q = ids && ids.length
    ? env.DB.prepare(`${MISS_SQL} AND m.id IN (SELECT value FROM json_each(?2)) ORDER BY m.at DESC LIMIT ?3`).bind(user, JSON.stringify(ids.map(String)), limit)
    : env.DB.prepare(`${MISS_SQL} AND (m.cause IS NULL OR coalesce(m.cause_version, 0) < ?2) ORDER BY m.at DESC LIMIT ?3`).bind(user, CAUSE_VERSION, limit);
  const left = ids && ids.length ? null
    : env.DB.prepare(`SELECT count(*) AS n FROM misses m WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.topic_id IS NOT NULL
        AND m.result IN ('wrong', 'flawed') AND (m.cause IS NULL OR coalesce(m.cause_version, 0) < ?2)
        AND json_extract(coalesce(m.mo_corrected_json, '{}'), '$.cause') IS NULL`).bind(user, CAUSE_VERSION);
  const res = await env.DB.batch(left ? [q, left] : [q]);
  return { misses: res[0].results || [], left: left ? Number((res[1].results || [])[0]?.n) || 0 : 0 };
}

async function saidFor(env, misses) {
  const out = new Map();
  const blocks = [...new Set(misses.filter(m => m.uworld_block_id && m.uworld_q != null).map(m => m.uworld_block_id))];
  const hub = misses.filter(m => m.block_id && m.q_index != null);
  const stmts = [];
  if (blocks.length) stmts.push(env.DB.prepare('SELECT id, segments_json, questions_json FROM uworld_blocks WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(blocks)));
  if (hub.length) stmts.push(env.DB.prepare(`SELECT block_id, q_index, mo_quote, cleaned_transcript FROM analyses WHERE block_id || ':' || q_index IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(hub.map(m => `${m.block_id}:${m.q_index}`))));
  if (!stmts.length) return out;
  let res;
  try { res = await env.DB.batch(stmts); } catch (e) { if (noTable(e)) return out; throw e; }
  let i = 0;
  if (blocks.length) {
    const groups = new Map();
    for (const b of res[i++].results || []) {
      try { groups.set(b.id, splitByStarts(parse(b.segments_json, []), parse(b.questions_json, []).filter(q => q && q.start_ms != null)).groups); } catch { /* no words then */ }
    }
    for (const m of misses) {
      const g = groups.get(m.uworld_block_id);
      const segs = g && g.get(Number(m.uworld_q));
      if (segs && segs.length) out.set(m.id, segs.map(s => s.text).join(' '));
    }
  }
  if (hub.length) {
    const by = new Map((res[i++].results || []).map(r => [`${r.block_id}:${r.q_index}`, r.cleaned_transcript || r.mo_quote]));
    for (const m of hub) { const t = by.get(`${m.block_id}:${m.q_index}`); if (t) out.set(m.id, t); }
  }
  for (const [k, v] of out) out.set(k, stemSafe(v) ? v : null);   // a stem read aloud is never sent
  return out;
}

// The look-alike penalty rows each miss holds now: Map(miss id -> [{topic_id, name}]).
async function penaltiesNow(env, user, misses) {
  const keys = misses.map(m => rawKey(user, m.id));
  const rows = keys.length ? (await env.DB.prepare(`SELECT e.obs_key, e.topic_id, t.name FROM evidence e LEFT JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id
      WHERE e.user_id = ?1 AND e.kind = 'confused_with' AND e.obs_key IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(keys)).all()).results || [] : [];
  const out = new Map();
  for (const m of misses) out.set(m.id, rows.filter(r => r.obs_key === rawKey(user, m.id)).map(r => ({ topic_id: r.topic_id, name: r.name || r.topic_id })));
  return out;
}

// ---------------------------------------------------------------- the job

/**
 * Judge (or reuse) causes for up to `limit` misses, then report (dry_run) or write them in undoable batches.
 * Returns {dry_run, judged, reused, held?, usd, items, counts, batches, left}.
 */
export async function rejudge(env, user, { dry_run = true, limit = REJUDGE.limit, ids = null, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(REJUDGE.max, Number(limit) || REJUDGE.limit));
  let read;
  try { read = await readMisses(env, user, { ids, limit: n }); } catch (e) { if (noTable(e)) throw new HttpError(503, 'Run migration 0053 first.'); throw e; }
  const { misses, left } = read;
  const out = { dry_run: !!dry_run, judged: 0, reused: 0, usd: 0, items: [], counts: { misses: misses.length, changed: 0, confusion: 0, penalties_removed: 0, penalties_kept: 0 }, batches: [], left };
  if (!misses.length) return out;

  const said = await saidFor(env, misses);
  const work = misses.map((m, i) => { const w = wordsOf(m, said.get(m.id)); return { ref: `m${i + 1}`, m, w, hash: wordsHash(m, w) }; });
  const kept = new Map(((await env.DB.prepare('SELECT * FROM cause_judgements WHERE user_id = ? AND miss_id IN (SELECT value FROM json_each(?))')
    .bind(user, JSON.stringify(misses.map(m => m.id))).all()).results || []).map(r => [r.miss_id, r]));
  const verdict = new Map();
  for (const x of work) {
    const k = kept.get(x.m.id);
    if (k && k.words_hash === x.hash && Number(k.version) === CAUSE_VERSION && k.cause) { verdict.set(x.m.id, k); out.reused++; }
  }

  // The judge, a dozen misses a call, each under the hub's caps; a cap that is reached stops here with what it has.
  for (const part of chunk(work.filter(x => !verdict.has(x.m.id)), REJUDGE.per_call)) {
    let release;
    try { release = await deps.reserve(env); } catch (e) { if (e && e.status === 429) { out.held = e.message; break; } throw e; }
    let got;
    try {
      const { callJson } = await deps.claude();
      const ask = items => callJson(env, { role: 'reviewer', system: REJUDGE_SYSTEM, schema: REJUDGE_SCHEMA, effort: 'high', maxTokens: 16000,
        messages: [{ role: 'user', content: rejudgeMessage(items) }] });
      const r = await ask(part);
      out.usd += Number(r.usd) || 0;
      const refs = new Set(part.map(x => x.ref));
      const said = new Map(part.map(x => [x.ref, [x.w.said, x.w.source === 'mo' || !x.w.source ? x.w.summary : null].filter(Boolean).join(' ')]));
      const check = c => checkItem(c, { id: c.ref, ...AUDIT_SPECS.rejudge(c), source: said.get(c.ref) || '' });
      const first = part.map(x => ({ ref: x.ref, ...((r.data && Array.isArray(r.data.items) ? r.data.items : []).find(i => i && i.ref === x.ref) || {}) }));
      const a = await auditAndReask(first, { idOf: c => c.ref, check, reask: async rows => {
        const ids = new Set(rows.map(x => x.id));
        const again = await callJson(env, { role: 'reviewer', system: REJUDGE_SYSTEM, schema: REJUDGE_SCHEMA, effort: 'high', maxTokens: 16000,
          messages: [{ role: 'user', content: [{ type: 'text', text: rejudgeMessage(part.filter(x => ids.has(x.ref))) }, { type: 'text', text: reaskText(rows) }] }] });
        out.usd += Number(again.usd) || 0;
        return again.data && Array.isArray(again.data.items) ? again.data.items : [];
      } });
      out.audit = { rows: [...((out.audit && out.audit.rows) || []), ...a.rows], reasked: ((out.audit && out.audit.reasked) || 0) + a.reasked };
      got = tidyRejudge({ items: a.items }, refs);
    } catch (e) {
      out.usd += Number(e && e.usd) || 0;
      // Waiting for its Message Batch: the next run (or the same request again) finds the answers.
      if (e && e.pending === true && e.batch === true) { out.waiting = (out.waiting || 0) + part.length; continue; }
      console.error('rejudge call failed', e && e.message);
      out.failed = (out.failed || 0) + part.length;
      continue;
    } finally { await release(0); }
    const stmts = [];
    for (const x of part) {
      const c = got.get(x.ref);
      if (!c) continue;
      const row = { miss_id: x.m.id, words_hash: x.hash, ...c, version: CAUSE_VERSION, judged_at: now };
      verdict.set(x.m.id, row);
      out.judged++;
      stmts.push(env.DB.prepare(`INSERT INTO cause_judgements (user_id, miss_id, words_hash, cause, cause_quote, cause_inferred, cause_detail, version, judged_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (user_id, miss_id) DO UPDATE SET words_hash = excluded.words_hash, cause = excluded.cause,
          cause_quote = excluded.cause_quote, cause_inferred = excluded.cause_inferred, cause_detail = excluded.cause_detail, version = excluded.version,
          judged_at = excluded.judged_at, applied_at = NULL, batch_id = NULL`)
        .bind(user, row.miss_id, row.words_hash, row.cause, row.cause_quote, row.cause_inferred, row.cause_detail, row.version, row.judged_at));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }

  const penalties = await penaltiesNow(env, user, misses);
  const plans = [];
  for (const x of work) {
    const v = verdict.get(x.m.id);
    if (!v) continue;
    const next = { ...x.m, cause: v.cause, cause_quote: v.cause_quote, cause_inferred: v.cause_inferred, cause_detail: v.cause_detail, cause_version: CAUSE_VERSION };
    const before = causeOf(x.m), after = causeOf(next);
    const pen = penalties.get(x.m.id) || [];
    const confusion = after && after.cause === 'confusion';
    const stays = p => confusion && confusionShown(after, [p.name, lookAlikeHead(x.m.look_alikes)].filter(Boolean));
    const item = { miss_id: x.m.id, label: x.m.label, topic: x.m.topic_name || null, was: before ? before.cause : null, cause: v.cause,
      cause_words: (causeWords(after, { lookAlike: lookAlikeHead(x.m.look_alikes) }) || {}).text || null, inferred: v.cause_inferred !== 0,
      quote: v.cause_quote || null, penalties_removed: pen.filter(p => !stays(p)).map(p => p.name), penalties_kept: pen.filter(stays).map(p => p.name) };
    const changed = MISS_CAUSE_COLS.some(k => String(x.m[k] ?? '') !== String(next[k] ?? ''));
    out.items.push(item);
    if (changed) out.counts.changed++;
    if (confusion) out.counts.confusion++;
    out.counts.penalties_removed += item.penalties_removed.length;
    out.counts.penalties_kept += item.penalties_kept.length;
    if (changed) plans.push({ m: x.m, next, item });
  }
  if (!dry_run) for (const part of chunk(plans, REJUDGE.per_batch)) out.batches.push(await applyPart(env, user, part, now));
  if (out.audit) out.check = await recordAudit(env, { job: 'rejudge', key: `${dry_run ? 'dry' : 'run'}:${now}`, ref: dry_run ? 'dry' : 'run', user, rows: out.audit.rows, reasked: out.audit.reasked, at: now });
  delete out.audit;
  await noteRun(env, user, out, now);
  return out;
}

function noteRun(env, user, out, now, error = null) {
  const c = out.counts || {};
  return noteJob(env, { job: 'rejudge', key: `${out.dry_run ? 'dry' : 'run'}:${londonDay(now)}`, ref: out.dry_run ? 'dry' : 'run', user, add: true, at: now,
    state: error ? 'failed' : out.held ? 'held' : 'ok', detail: error || out.held || null,
    counts: { misses: num(c.misses), judged: num(out.judged), reused: num(out.reused), changed: num(c.changed), confusion: num(c.confusion),
      removed: num(c.penalties_removed), kept: num(c.penalties_kept), links_removed: (out.batches || []).reduce((a, b) => a + num(b.links_removed), 0),
      batches: (out.batches || []).length, left: num(out.left), waiting: num(out.waiting), ...auditCounts(out.check) } });
}
const num = v => Number(v) || 0;

/** One undoable batch for a few misses: their cause, their answer's weight, their look-alike rows and support. */
async function applyPart(env, user, part, now) {
  const rows = [], events = [];
  const pick = r => Object.fromEntries(MISS_CAUSE_COLS.map(k => [k, r[k] ?? null]));
  for (const { m, next, item } of part) {
    const before = { id: m.id, ...pick(m) }, after = { id: m.id, ...pick(next) };
    rows.push({ table: 'misses', op: 'update', key: { id: m.id }, before: pick(m), after: pick(next) });
    events.push({ kind: 'miss.updated', target_type: 'miss', target_id: m.id, topic_id: m.topic_id, undoable: true, before, after,
      summary: cut(`${m.label}: ${item.cause_words || item.cause} (re-judged from his words)${item.penalties_removed.length ? `; look-alike penalty off ${item.penalties_removed.slice(0, 2).join(', ')}` : ''}`, 160) });
  }
  // Each miss's own answer (slot 0) counts by its cause now.
  const keys = part.map(p => rawKey(user, p.m.id));
  const evs = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))')
    .bind(user, JSON.stringify(keys)).all()).results || [];
  const strip = r => { const o = {}; for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v; return o; };
  const upsert = [];
  for (const e of evs) {
    const p = part.find(x => rawKey(user, x.m.id) === e.obs_key);
    const o = strip(e), was = o.detail_json;
    withCause(o, p.next);
    if (o.detail_json !== was) upsert.push(o);
  }
  // Their look-alike rows and link support, as ingestion would make them now (only a confusion keeps any).
  const la = await deps.lookAlikeParts(env, user, part.map(p => p.next), now);
  const w = await deps.writeBatch(env, user, {
    actor: 'code', surface: 'code', via: 'api:POST /api/map/rejudge', undoable: true,
    rows: [...la.rows, ...rows], events: [...la.events.map(e => ({ ...e, undoable: true })), ...events],
    evidence: { upsert: [...upsert, ...la.upsert], remove: la.remove },
    recompute: [...new Set([...part.map(p => p.m.topic_id), ...la.upsert.map(r => r.topic_id)].filter(Boolean))],
  });
  await env.DB.prepare('UPDATE cause_judgements SET applied_at = ?1, batch_id = ?2 WHERE user_id = ?3 AND miss_id IN (SELECT value FROM json_each(?4))')
    .bind(now, w.batch_id, user, JSON.stringify(part.map(p => p.m.id))).run();
  return { batch_id: w.batch_id, misses: part.length, deferred: (la.deferred || []).length, links_removed: la.events.filter(e => e.kind === 'link.removed').length };
}

// POST /api/map/rejudge {dry_run = true, limit, ids}
export async function rejudgeRoute(request, env, ctx, params, url, user) {
  const body = (await readJson(request, 20_000).catch(() => ({}))) || {};
  for (const k of Object.keys(body)) if (!['dry_run', 'limit', 'ids'].includes(k)) throw new HttpError(400, `Unknown field ${k}.`);
  if (body.ids != null && !(Array.isArray(body.ids) && body.ids.length <= REJUDGE.max)) throw new HttpError(400, `ids is a list of at most ${REJUDGE.max} miss ids.`);
  const dry = body.dry_run !== false;
  try {
    return json(await rejudge(env, user, { dry_run: dry, limit: body.limit, ids: body.ids || null }));
  } catch (e) {
    await noteRun(env, user, { dry_run: dry, counts: {} }, Date.now(), (e && e.message) || 'failed');   // a failure posts too
    throw e;
  }
}
