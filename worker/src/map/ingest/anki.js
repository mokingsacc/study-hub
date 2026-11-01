import { now as nowMs, londonDay } from '../../util.js';
import { ankiCall } from '../../anki.js';
import {
  missFromAnki, mergeMiss, ANKI_COPY_COLS, questionEvidence, sameEvidence, ankiKey, uwKey, uwLabel, ankiLabel,
  userKey, rawKey, dayDiff, isDay, normLabel, STICKY_METHODS, wordsChanged, CODE_PLACED, withCause, sameQuestion,
} from './map-fields.js';
import { placeTopics, lookups, commit, finishMiss, missStatement, missSummary, lookAlikeParts, lookAlikeFollowUp, evidenceStatements, learnStatements,
  staleSupportParts } from './hub.js';
import { queueStatements } from '../queue.js';
import { countingEnv } from '../d1-count.js';
import { importParts } from '../retests.js';

export const PAGE = 300, CHUNK = 100, CALL_MS = 8_000;
// A page of new records per run: the whole page on a Paid budget, a dozen on Free's 50 queries (a backlog then
// takes a few minutes, and the cursor always moves on).
export const pageFor = env => ((Number(env && env.D1_QUERY_BUDGET) || 45) >= 500 ? PAGE : 12);
// What one Anki job may spend of the invocation's D1 queries on Paid (B2-1): the minute cron gives each job its
// share (D1_JOB_QUERIES); elsewhere (a pull in a request's waitUntil) it takes ANKI_SHARE of D1_QUERY_BUDGET, so
// the request keeps the rest. JOB_MARGIN is claimSource and finishSource around it. On Free's budget the page is
// already a dozen records, which fits (ingest-budget tests), so it is not counted (null).
export const ANKI_SHARE = 0.6, JOB_MARGIN = 6;
export function jobBudget(env) {
  const b = Number(env && env.D1_QUERY_BUDGET) || 45;
  if (b < 500) return null;
  const own = Number(env && env.D1_JOB_QUERIES);
  return Math.max(4, (own > 0 ? own : Math.floor(b * ANKI_SHARE)) - JOB_MARGIN);
}
// A chunk's cost, guessed until chunks have been measured: CHUNK_FIXED for its reads and commit, PER_RECORD per
// record (look-alikes resolved, rows written). The first chunk is at most FIRST_CHUNK records, to measure.
const CHUNK_FIXED = 10, PER_RECORD = 4, FIRST_CHUNK = 25, SAFETY = 1.25;
const cap = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const json = v => JSON.stringify([...new Set(v)]);
const HUB_PREFIX = /^\[(.{1,120}) Q(\d{1,3})\]/;

/**
 * Mirror Anki records into misses and evidence. records: list_mistakes / mistake_sources rows. opts:
 * {via, deleted: [ids gone from the server], budget: D1 queries this call may spend}. With a budget the records
 * go in order, a chunk at a time sized from what the chunks before cost, and the call stops before the budget
 * (the caller moves its cursor only past `ingested` of them). Unchanged rows write nothing.
 * Returns {added, updated, copies, deleted, unchanged, ingested}.
 */
export async function ingestAnkiRows(env, user, records, { via = 'cron:anki', deleted = [], budget = null } = {}) {
  const recs = (records || []).filter(r => r && Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0);
  const out = { added: 0, updated: 0, copies: 0, deleted: 0, unchanged: 0 };
  let i = 0;
  if (budget == null) {
    for (; i < recs.length; i += CHUNK) add(out, await ingestChunk(env, user, recs.slice(i, i + CHUNK), via));
    i = recs.length;
  } else {
    const { env: cenv, counter } = countingEnv(env);
    let per = PER_RECORD, chunks = 0;
    while (i < recs.length) {
      const left = budget - counter.n;
      let k = Math.min(i ? CHUNK : FIRST_CHUNK, recs.length - i, Math.floor((left / SAFETY - CHUNK_FIXED) / per));
      if (k < 1) { if (i === 0 && left >= 4) k = 1; else break; }
      add(out, await ingestChunk(cenv, user, recs.slice(i, i + k), via));
      i += k;
      chunks++;
      per = Math.max(1, (counter.n - CHUNK_FIXED * chunks) / i);
    }
    if (i < recs.length) console.log(JSON.stringify({ anki_ingest_budget: { via, ingested: i, left_for_next_run: recs.length - i, queries: counter.n } }));
  }
  if (deleted.length) out.deleted = await forgetAnki(env, user, deleted, via);
  out.ingested = i;
  return out;
}
const add = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; };

async function ingestChunk(env, user, recs, via) {
  const ids = recs.map(r => Number(r.id));
  const qids = recs.map(r => r.uworld_id ?? r.uw_qid).filter(v => v != null).map(String);
  const labels = recs.map(r => HUB_PREFIX.exec(String(r.correct_reasoning || ''))).filter(Boolean).map(m => `${m[1]} Q${m[2]}`);
  const [byId, byUw, ob] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND anki_mistake_id IN (SELECT value FROM json_each(?))').bind(user, json(ids)),
    env.DB.prepare(`SELECT * FROM misses WHERE user_id = ? AND anki_mistake_id IS NULL AND deleted_at IS NULL AND (uw_qid IN (SELECT value FROM json_each(?))
      OR (block_id IS NOT NULL AND label IN (SELECT value FROM json_each(?))))`).bind(user, json(qids), json(labels)),
    env.DB.prepare(`SELECT idem_key, CAST(json_extract(result_json, '$.mistake_id') AS INTEGER) AS mid FROM outbox WHERE kind = 'debrief' AND status = 'done'
      AND CAST(json_extract(result_json, '$.mistake_id') AS INTEGER) IN (SELECT value FROM json_each(?))`).bind(json(ids)),
  ]);
  const mine = new Map(byId.results.map(r => [r.anki_mistake_id, r]));
  // debrief:<sitting>:<block>:<q> -> hub:<block>:<q>
  const outboxHub = new Map(ob.results.map(r => { const [, , block, q] = String(r.idem_key).split(':'); return [r.mid, `hub:${block}:${q}`]; }));
  const hubIds = [...outboxHub.values()].map(k => userKey(user, k)).filter(id => ![...mine.values()].some(m => m.id === id));
  const hubRows = new Map(byUw.results.filter(r => r.block_id).map(r => [r.id, r]));
  if (hubIds.length) {
    const r = await env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(user, json(hubIds)).all();
    for (const row of r.results || []) hubRows.set(row.id, row);
  }

  // Each record: where it goes and what it brings.
  const plans = [];
  for (const rec of recs) {
    const id = Number(rec.id);
    const fields = missFromAnki(rec);
    let existing = mine.get(id) || null;
    if (!existing && outboxHub.has(id)) existing = hubRows.get(userKey(user, outboxHub.get(id))) || null;
    if (!existing) {
      // Only a label that names one hub row (two sittings can share a name; B3-3). One that names several waits
      // for its outbox row (the flush marks it done within seconds; anki.recent and the nightly pass read it again),
      // so it is never merged into the wrong question nor counted twice.
      const m = HUB_PREFIX.exec(String(rec.correct_reasoning || ''));
      const hits = m ? [...hubRows.values()].filter(r => r.label === `${m[1]} Q${m[2]}`) : [];
      if (hits.length > 1) continue;
      if (hits.length === 1) existing = hits[0];
    }
    // A duplicate the clean-up merged into another miss (map/hygiene.js) stays deleted: its record is the other's now.
    if (existing && existing.merged_into) continue;
    if (existing && existing.block_id) { plans.push({ rec, fields, copy: existing }); continue; }
    if (!existing && fields.uw_qid && fields.day) {
      existing = byUw.results.filter(r => !r.block_id && sameQuestion(r, fields))
        .sort((a, b) => dayDiff(a.day, fields.day) - dayDiff(b.day, fields.day))[0] || null;
    }
    if (!fields.day) continue; // a record with no day cannot be dated; the next full pass tries again
    const key = existing ? rawKey(user, existing.id) : fields.uw_qid ? uwKey(fields.uw_qid, fields.day) : ankiKey(id);
    const label = existing ? existing.label : fields.uw_qid ? uwLabel(fields.uw_qid) : ankiLabel(id);
    plans.push({ rec, fields: { ...fields, label }, existing, key });
  }

  // Evidence already there for these observations and re-tests, in one read.
  const evKeys = [];
  for (const p of plans) {
    const key = p.copy ? rawKey(user, p.copy.id) : p.key;
    if (!p.copy) evKeys.push(key);
  }
  const evRows = evKeys.length
    ? (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))').bind(user, json(evKeys)).all()).results || []
    : [];
  const evBy = new Map(evRows.map(r => [r.obs_key, r]));

  const places = new Map(), reqs = new Map();
  for (const p of plans) {
    p.replace = !p.copy && wordsChanged(p.existing, p.fields.condition_raw || p.fields.topic_raw);
    if (p.copy || (p.existing && !p.replace && (p.existing.topic_id || p.existing.queue_id || STICKY_METHODS.includes(p.existing.match_method)))) continue;
    const k = `${normLabel(p.fields.condition_raw || p.fields.topic_raw)}|${normLabel(p.fields.system_raw)}|${p.rec.hub_topic_id || ''}`;
    p.placeKey = k;
    // A record with no topic words still gets a queue item, by its label (B3-6), so Claude can place it.
    if (!reqs.has(k)) reqs.set(k, { texts: [p.fields.condition_raw, p.fields.topic_raw], system: p.fields.system_raw, label: p.fields.label,
      topic_id: typeof p.rec.hub_topic_id === 'string' ? p.rec.hub_topic_id : null, source: 'anki', source_ref: ankiKey(p.rec.id) });
  }
  const keys = [...reqs.keys()];
  (await placeTopics(env, user, keys.map(k => reqs.get(k)))).forEach((r, i) => places.set(keys[i], r));
  const look = await lookups(env, user, {
    topicIds: [...[...places.values()].map(x => x.topic_id), ...plans.map(p => (p.copy || p.existing || {}).topic_id)],
    systems: plans.map(p => p.fields.system_raw),
  });

  const t = nowMs();
  const statements = [], upsert = [], events = [], recompute = [], queue = [], changed = [], moved = [], retests = [];
  const res = { added: 0, updated: 0, copies: 0, unchanged: 0 };
  for (const p of plans) {
    let row;
    if (p.copy) {
      const same = ANKI_COPY_COLS.every(c => String(p.copy[c] ?? '') === String(p.fields[c] ?? ''));
      if (!same) {
        statements.push(env.DB.prepare(`UPDATE misses SET ${ANKI_COPY_COLS.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`)
          .bind(...ANKI_COPY_COLS.map(c => p.fields[c] ?? null), t, user, p.copy.id));
        res.copies++;
      } else res.unchanged++;
      row = p.copy;
    } else {
      const base = mergeMiss(p.existing ? stripTopic(p.existing) : null, p.fields, 'anki');
      let place = p.placeKey ? places.get(p.placeKey) : { topic_id: p.existing && p.existing.topic_id };
      if (p.replace && !(place && place.topic_id)) {
        const cands = ((place && place.queue && place.queue.candidates) || []).map(c => c && (c.id || c.topic_id)).filter(Boolean);
        place = disagrees(p.existing, cands) ? { topic_id: null, queue: place.queue, unplace: true } : { topic_id: p.existing.topic_id, pending: (place && place.queue) || null };
      }
      row = finishMiss(user, p.key, { ...base, held: p.existing ? p.existing.held || 0 : 0, deleted_at: null }, p.existing, place, look, t);
      if (row.changed) {
        statements.push(missStatement(env, row));
        changed.push(row);
        if (p.existing && p.existing.topic_id && row.topic_id !== p.existing.topic_id) moved.push({ id: row.id, topic_id: row.topic_id });
        res[p.existing ? 'updated' : 'added']++;
        if (!row.held) {
          const name = row.topic_id ? (look.topics.get(row.topic_id) || {}).name : null;
          events.push({ kind: p.existing && p.existing.deleted_at == null ? 'miss.updated' : 'miss.added', target_type: 'miss', target_id: row.id,
            topic_id: row.topic_id, summary: missSummary(row, name), before: null, after: { topic_id: row.topic_id, label: row.label, result: row.result, error_type: row.error_type } });
          if (!row.topic_id && place.queue && (!p.existing || place.unplace)) queue.push(place.queue);
          if (place.pending && p.existing && row.queue_id === userKey(user, place.pending.id) && p.existing.queue_id !== row.queue_id) queue.push(place.pending);
        }
      } else res.unchanged++;
      const prev = evBy.get(p.key) || null;
      const ev = questionEvidence({ obs_key: p.key, answer: { result: row.result, outcome: p.fields.outcome, label: row.label,
        confidence: row.confidence ?? p.fields.confidence, error_type: p.fields.error_type, time_s: row.time_s }, at: row.at, day: row.day, source: 'anki', source_ref: ankiKey(p.rec.id),
      miss_id: row.id, held: row.held });
      // Confidence as the merged miss keeps it (mergeMiss confidenceWinner: an assumed Anki value never beats the hub's own).
      const merged = prev ? { ...prev, outcome: ev.outcome ?? prev.outcome, confidence: ev.confidence ?? prev.confidence, error_type: ev.error_type ?? prev.error_type,
        result: prev.result === 'wrong' || prev.result === 'flawed' ? prev.result : ev.result, time_s: prev.time_s ?? ev.time_s,
        topic_id: row.topic_id, queue_id: row.topic_id ? null : row.queue_id, label_norm: row.topic_id ? null : row.label_norm, category_id: row.category_id }
        : { ...ev, topic_id: row.topic_id, queue_id: row.topic_id ? null : row.queue_id, label_norm: row.topic_id ? null : row.label_norm, category_id: row.category_id };
      withCause(merged, row);   // a judged cause weighs the miss on its topic (wave 2)
      if (!row.held && !sameEvidence(merged, prev)) {
        upsert.push(evidenceRow(merged));
        if (row.topic_id) recompute.push(row.topic_id);
        if (prev && prev.topic_id && prev.topic_id !== row.topic_id) recompute.push(prev.topic_id);   // it moved: the old topic too
      }
    }
    const before = (p.copy || p.existing || {}).anki_note_ids_json;
    if (!row.held && hasIds(p.fields.anki_note_ids_json) && !hasIds(before)) {
      statements.push(env.DB.prepare(`UPDATE misses SET reviewed_at = ?, reviewed_by = 'card' WHERE user_id = ? AND id = ? AND reviewed_at IS NULL`).bind(t, user, row.id));
    }
    // Re-tests: the log's own, booked into the hub's table (map/retests.js, 0036), which writes each result's
    // observation once (the same key as before, retest:<id>:<due>) and keeps next_retest_day.
    if (!row.held && (p.rec.retests || []).length) retests.push({ row: { ...row, anki_mistake_id: Number(p.rec.id) }, retests: p.rec.retests });
  }
  const rt = await importParts(env, user, retests, t);
  statements.push(...rt.statements);
  upsert.push(...rt.upsert);
  events.push(...rt.events);
  recompute.push(...rt.recompute);
  // Links and confused_with for the rows that changed (their events first: they carry their own before and after).
  const la = await lookAlikeParts(env, user, changed, t);
  const stale = await staleSupportParts(env, user, moved);
  upsert.push(...la.upsert);
  for (const r of la.upsert) recompute.push(r.topic_id);
  statements.push(...queueStatements(env, user, queue, t), ...evidenceStatements(env, user, la.held, t), ...learnStatements(env, user, [...places.values()], t));
  await commit(env, user, { via, surface: 'cron', statements, rows: [...la.rows, ...stale.rows], evidence: { upsert, remove: la.remove },
    events: [...la.events, ...stale.events, ...events], recompute });
  if (la.deferred.length) await lookAlikeFollowUp(env, user, la.deferred, via);
  return res;
}

const hasIds = j => { try { const v = JSON.parse(j || '[]'); return Array.isArray(v) && v.length > 0; } catch { return false; } };
const stripTopic = r => { const o = { ...r }; for (const c of ['id', 'user_id', 'src_hash', 'updated_at', 'created_at', 'created_by', 'reviewed_at', 'reviewed_by', 'gen']) delete o[c]; return o; };
const EV_KEEP = ['obs_key', 'slot', 'topic_id', 'queue_id', 'label_norm', 'category_id', 'kind', 'at', 'day', 'source', 'source_ref', 'miss_id', 'sitting_id',
  'card_id', 'note_id', 'gap_id', 'lesson_id', 'held', 'result', 'outcome', 'verdict', 'confidence', 'error_type', 'flaw_kind', 'time_s', 'others_pct', 'amount',
  'rating', 'detail_json'];
const evidenceRow = r => Object.fromEntries(EV_KEEP.map(k => [k, r[k] ?? null]).map(([k, v]) => [k, k === 'slot' || k === 'held' ? v || 0 : v]));

async function forgetAnki(env, user, ids, via) {
  const rows = (await env.DB.prepare('SELECT id, label, topic_id, block_id, uworld_block_id, anki_mistake_id FROM misses WHERE user_id = ? AND deleted_at IS NULL AND anki_mistake_id IN (SELECT value FROM json_each(?))')
    .bind(user, json(ids.map(Number))).all()).results || [];
  if (!rows.length) return 0;
  const t = nowMs();
  const statements = [], remove = [], events = [], recompute = [];
  const stale = await staleSupportParts(env, user, rows.filter(r => !(r.block_id || r.uworld_block_id)).map(r => ({ id: r.id, topic_id: null })));
  for (const r of rows) {
    if (r.block_id || r.uworld_block_id) {
      // Its re-tests stay booked in the hub's table (0036), so next_retest_day stays too.
      statements.push(env.DB.prepare(`UPDATE misses SET anki_mistake_id = NULL, retests_json = '[]', updated_at = ? WHERE user_id = ? AND id = ?`).bind(t, user, r.id));
      continue;
    }
    statements.push(env.DB.prepare('UPDATE misses SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?').bind(t, t, user, r.id));
    remove.push(rawKey(user, r.id));
    if (r.topic_id) recompute.push(r.topic_id);
    events.push({ kind: 'miss.deleted', target_type: 'miss', target_id: r.id, topic_id: r.topic_id, summary: cap(`${r.label}: deleted from the Anki log`),
      before: null, after: { topic_id: r.topic_id, label: r.label } });
  }
  await commit(env, user, { via, surface: 'cron', statements, rows: stale.rows, evidence: { remove }, events: [...stale.events, ...events], recompute });
  return rows.length;
}

export const disagrees = (existing, candidateIds) => !!(existing && existing.topic_id && CODE_PLACED.includes(existing.match_method)
  && existing.source === 'uworld' && candidateIds.length && !candidateIds.includes(existing.topic_id));

// ---------------------------------------------------------------- the jobs (run by sync.js with its locks)
const list = (env, args) => ankiCall(env, 'list_mistakes', args, { timeoutMs: CALL_MS });
const maxId = recs => recs.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
const minId = recs => recs.reduce((m, r) => Math.min(m, Number(r.id) || Infinity), Infinity);

// ---------------------------------------------------------------- past the server's 300 (B3-1)
// list_mistakes {after_id} answers at most 300 records, newest first. On a log longer than that, a page the server
// cut (`more`) leaves out the OLDEST records after the cursor, and no after_id can reach them: their re-test results,
// edits and deletions would never reach the map. So when a page is cut, the records between the cursor and the
// page's lowest id are read by id first, with mistake_sources (the full record as list_mistakes gives it, plus its
// sources; an id the server no longer has comes back {id, missing: true}). The server looks the sources up live for
// older records, so the calls are small and few a run, and the job carries on next minute. Which ids:
//   - 'nightly' (anki.full): the mirrored ones that can have changed: every one with a re-test due by today (its
//     result) and a seventh of the rest each night by id (edits and deletions within a week);
//   - 'all' (the rebuild): every mirrored one;
//   - 'unseen' (anki.new, after a long gap): every id, since all of them are above the newest one mirrored.
// A call that fails is skipped for this pass (logged), so one slow lookup never stalls the pass.
export const IDS_PER_CALL = 10, ID_CALLS_PER_RUN = 2, IDS_CALL_MS = 25_000, IDS_RUN_MS = 30_000, ROTATE_NIGHTS = 7, UNSEEN_MAX = 600;
const byIds = (env, ids) => ankiCall(env, 'mistake_sources', { ids }, { timeoutMs: IDS_CALL_MS });
const dayNumber = day => Math.floor(Date.parse(`${day}T12:00:00Z`) / 86_400_000);

/** The ids in (after, below) to read by id this pass, ascending (see above for the modes). */
export async function gapIds(env, user, after, below, mode, { today = londonDay() } = {}) {
  if (!Number.isFinite(below) || !(below > after + 1)) return [];
  if (mode === 'unseen') return Array.from({ length: Math.min(below - after - 1, UNSEEN_MAX) }, (_, i) => after + 1 + i);
  const rows = (await env.DB.prepare(`SELECT anki_mistake_id AS id, next_retest_day AS due FROM misses WHERE user_id = ? AND deleted_at IS NULL
    AND anki_mistake_id > ? AND anki_mistake_id < ? ORDER BY anki_mistake_id`).bind(user, after, below).all()).results || [];
  const night = dayNumber(today) % ROTATE_NIGHTS;
  return [...new Set(rows.filter(r => mode === 'all' || (isDay(r.due) && r.due <= today) || Number(r.id) % ROTATE_NIGHTS === night).map(r => Number(r.id)))];
}

/**
 * Read `ids` (ascending) by id, at most ID_CALLS_PER_RUN calls of IDS_PER_CALL within IDS_RUN_MS, and mirror what
 * comes back. With `mirrored` (the ids are all in misses), an id the server says is missing is deleted; a large
 * share at once waits for a later pass to agree (as the nightly pass's own deletions do). Returns the ingest counts
 * with {deleted, asked, cursor: the last id done (null when none was)}.
 */
export async function readByIds(env, user, ids, { via, budget = null, mirrored = true, start = nowMs() } = {}) {
  const asked = [], recs = [], missing = [];
  for (let k = 0, calls = 0; k < ids.length && calls < ID_CALLS_PER_RUN && (calls === 0 || nowMs() - start < IDS_RUN_MS); k += IDS_PER_CALL, calls++) {
    const chunk = ids.slice(k, k + IDS_PER_CALL);
    let res = null;
    try { res = await byIds(env, chunk); } catch (e) {
      // A failed call's ids are not done: the cursor stops before them and the next run asks again (B4-5), so a
      // blip never loses records for good. Only a chunk that fails BY_ID_TRIES runs in a row is given up on.
      const skip = await failedChunk(env, user, chunk[0]);
      console.error(JSON.stringify({ [skip ? 'anki_by_id_given_up' : 'anki_by_id_retry_next_run']: { via, ids: chunk, error: (e && e.message) || String(e) } }));
      if (skip) asked.push(...chunk);
      break;
    }
    const got = new Map(((res && res.mistakes) || []).filter(r => r && Number.isSafeInteger(Number(r.id))).map(r => [Number(r.id), r]));
    for (const id of chunk) {
      const r = got.get(id);
      if (r && r.missing) missing.push(id);
      else if (r) recs.push(r);
    }
    asked.push(...chunk);
  }
  const r = await ingestAnkiRows(env, user, recs, { via, budget });
  // Only past what was mirrored: a record the budget left is read again next run, with the ids after it.
  const left = recs[r.ingested];
  const done = left ? asked.filter(id => id < Number(left.id)) : asked;
  let deleted = 0, held = 0;
  let gone = mirrored ? missing.filter(id => done.includes(id)) : [];
  if (gone.length > GONE_MAX && gone.length > GONE_SHARE * done.length) {
    const agreed = await idsGoneAgreed(env, user, gone);
    held = gone.length - agreed.length;
    if (held) console.error(JSON.stringify({ anki_by_id_deletes_held: { user, gone: gone.length, asked: done.length, agreed: agreed.length } }));
    gone = agreed;
  }
  if (gone.length) deleted = await forgetAnki(env, user, gone, via);
  return { ...r, deleted, ...(held ? { deletes_held: held } : {}), asked: done.length, cursor: done.length ? Math.max(...done) : null };
}

// A by-id chunk that failed: counted per chunk (by its first id) in sync_state 'retry:anki.ids'. Returns true once it
// has failed BY_ID_TRIES runs in a row (then it is skipped, as before, so one bad record never stalls anki.new).
export const BY_ID_TRIES = 3;
async function failedChunk(env, user, firstId, t = nowMs()) {
  try {
    const row = await env.DB.prepare(`SELECT cursor FROM sync_state WHERE user_id = ? AND source = 'retry:anki.ids'`).bind(user).first();
    let cur = {};
    try { cur = row && row.cursor ? JSON.parse(row.cursor) : {}; } catch { cur = {}; }
    const n = cur && cur.id === firstId ? (Number(cur.n) || 0) + 1 : 1;
    const skip = n >= BY_ID_TRIES;
    await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, fails, lock_until, last_ok_at) VALUES (?, 'retry:anki.ids', ?, 0, 0, ?)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`)
      .bind(user, JSON.stringify(skip ? {} : { id: firstId, n }), t).run();
    return skip;
  } catch (e) { return false; }
}

// The large deletions read by id wait, per id, until a pass at least an hour later finds the id missing too (kept in
// sync_state 'gone:anki.ids' as {id: first seen missing}, for 3 days). Returns the agreed ids.
const GONE_AGREE_MIN_MS = 3_600_000;
async function idsGoneAgreed(env, user, gone, t = nowMs()) {
  let prev = {};
  try {
    const row = await env.DB.prepare(`SELECT cursor FROM sync_state WHERE user_id = ? AND source = 'gone:anki.ids'`).bind(user).first();
    prev = row && row.cursor ? JSON.parse(row.cursor) : {};
  } catch (e) { prev = {}; }
  const keep = {};
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) for (const [id, at] of Object.entries(prev)) if (Number(at) > 0 && t - Number(at) < GONE_AGREE_MS) keep[id] = Number(at);
  const agreed = [];
  for (const id of gone) {
    const at = keep[id];
    if (at && t - at >= GONE_AGREE_MIN_MS) { agreed.push(id); delete keep[id]; } else if (!at) keep[id] = t;
  }
  const kept = Object.entries(keep).sort((a, b) => b[1] - a[1]).slice(0, 2000);
  await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, fails, lock_until, last_ok_at) VALUES (?, 'gone:anki.ids', ?, 0, 0, ?)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, JSON.stringify(Object.fromEntries(kept)), t).run();
  return agreed;
}

// A cut page's gap, read by id before the page itself: the run's result when there was any to read, else null.
async function gapStep(env, user, page, after, mode, { via, budget }) {
  if (!page || page.error || !page.more) return null;
  const ids = await gapIds(env, user, after, minId(pageOf(page, PAGE).all), mode);
  if (!ids.length) return null;
  const r = await readByIds(env, user, ids, { via, budget, mirrored: mode !== 'unseen' });
  return { ...r, cursor: String(Math.max(after, r.cursor ?? after)), more: true, seen: r.ingested };
}

/**
 * The part of one list_mistakes page to mirror now: its lowest ids first, at most n of them. A server before S1
 * answers newest first and does not take `limit`, so the page is cut here, oldest first, and the rest come again on
 * the next run (they are still after the cursor); S1's pages come oldest first and within limit already. Returns
 * {recs, all, more, cut}: `more` when the server or this cut left records out; `cut` only when this cut did.
 */
export function pageOf(page, n) {
  const all = ((page && page.mistakes) || []).filter(r => r && Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const recs = all.slice(0, Math.max(1, n));
  const cut = recs.length < all.length;
  return { recs, all, cut, more: !!(page && page.more) || cut };
}

/** anki.new: records after the newest id mirrored. cursor: that id (else the newest in misses). */
export async function ankiNew(env, user, cursor) {
  let after = Number(cursor) || 0;
  if (!after) {
    const r = await env.DB.prepare('SELECT max(anki_mistake_id) AS m FROM misses WHERE user_id = ?').bind(user).first();
    after = (r && r.m) || 0;
  }
  const page = await list(env, { after_id: after, limit: pageFor(env), order: 'oldest' });
  if (ascending(page)) {
    // S1: the oldest records after the cursor, at most a page, with a true `more`: nothing is ever left between pages.
    const recs = pageOf(page, PAGE).all;
    const r = await ingestAnkiRows(env, user, recs, { via: 'cron:anki.new', budget: jobBudget(env) });
    const got = recs.slice(0, r.ingested);
    return { ...r, cursor: String(Math.max(after, maxId(got))), more: !!page.more || got.length < recs.length, seen: got.length };
  }
  // An older server answers newest first and ignores limit and order. After a long gap (over 300 new records), the ones
  // it left out first (B3-1).
  const gap = await gapStep(env, user, page, after, 'unseen', { via: 'cron:anki.new', budget: jobBudget(env) });
  if (gap) return gap;
  const { recs, more } = pageOf(page, pageFor(env));
  const r = await ingestAnkiRows(env, user, recs, { via: 'cron:anki.new', budget: jobBudget(env) });
  // Only past what was mirrored: the rest are still after the cursor, and `more` brings the next run at once.
  const got = recs.slice(0, r.ingested);
  return { ...r, cursor: String(Math.max(after, maxId(got))), more: more || got.length < recs.length, seen: got.length };
}

// The newest-first page cut to what this run's budget mirrored (anki.recent and anki.due run again within minutes).
async function ingestPage(env, user, page, via) {
  const recs = pageOf(page, PAGE).recs;
  const r = await ingestAnkiRows(env, user, recs, { via, budget: jobBudget(env) });
  return { ...r, seen: r.ingested };
}

/**
 * anki.recent: records edited since the last run (rule fixes, confidence, outcome, re-test results), whatever their age,
 * through S1's changed_since and its cursor (sync_state: {c}); the first run looks two days back. An older server gives
 * the last two days' records, newest first, as before.
 */
export const RECENT_PAGE = 100;
export async function ankiRecent(env, user, cursor) {
  let st = {};
  try { st = cursor ? JSON.parse(cursor) : {}; } catch { st = {}; }
  const from = st && typeof st.c === 'string' ? { cursor: st.c } : { changed_since: nowMs() - 2 * 86_400_000 };
  const page = await list(env, { ...from, limit: RECENT_PAGE, since_days: 2 });
  if (!(ascending(page) && typeof page.cursor === 'string')) return ingestPage(env, user, page, 'cron:anki.recent');
  const recs = ((page && page.mistakes) || []).filter(r => r && Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0);
  const r = await ingestAnkiRows(env, user, recs, { via: 'cron:anki.recent', budget: jobBudget(env) });
  const got = recs.slice(0, r.ingested);
  const last = got[got.length - 1];
  // Only past what was mirrored: the server's cursor when the whole page was, else the last record's own place.
  const next = got.length === recs.length ? page.cursor : last && last.updated_at ? `changed:${last.updated_at}|${last.id}` : st.c || null;
  return { ...r, cursor: next ? JSON.stringify({ c: next }) : cursor ?? null, more: !!page.more || got.length < recs.length, seen: got.length };
}

/** anki.due: records with a re-test due, for their results. */
export async function ankiDue(env, user) {
  return ingestPage(env, user, await list(env, { due_only: true }), 'cron:anki.due');
}

/**
 * anki.full: one page of the nightly pass (cursor: the last id done). Returns {cursor: null} when the pass is
 * complete. Deletions are read only from a page the server gave in full (`more` false): mirrored ids after the
 * cursor, up to the last id mirrored now, that it no longer has are deleted. A page the server cut (over 300
 * records, newest first) deletes nothing, because the ids it left out are not gone. A run mirrors only what its
 * query budget allows; the pass then carries on next minute from the last id it mirrored (B2-1).
 * An answer that would delete much at once (a blank list, or over 30% of what is mirrored in its range) is only
 * believed when the next pass says the same (RH2-3): a server restarting or Anki not loaded must never empty the map.
 * Before a cut page, its gap is read by id (gapStep, 'nightly'), so records older than the server's 300 still get
 * their re-test results, edits and deletions (B3-1).
 */
export async function ankiFull(env, user, cursor) {
  const after = Number(cursor) || 0;
  const page = await list(env, { after_id: after, limit: pageFor(env), order: 'oldest' });
  if (ascending(page)) return fullAscending(env, user, after, page);
  // An older server (newest first, no limit): a page it cut leaves out the older mirrored records, read by id first (B3-1).
  const gap = await gapStep(env, user, page, after, 'nightly', { via: 'cron:anki.full', budget: jobBudget(env) });
  if (gap) return gap;
  const { recs, all, cut, more } = pageOf(page, pageFor(env));
  const r = await ingestAnkiRows(env, user, recs, { via: 'cron:anki.full', budget: jobBudget(env) });
  const got = recs.slice(0, r.ingested);
  const partial = got.length < recs.length;
  let deleted = 0, held_back = 0;
  if (!page.error && !page.more && (got.length || !partial)) {
    const top = cut || partial ? maxId(got) : Number.MAX_SAFE_INTEGER;
    const have = new Set(all.map(x => Number(x.id)));
    const mirrored = (await env.DB.prepare(`SELECT anki_mistake_id AS id FROM misses WHERE user_id = ? AND deleted_at IS NULL AND anki_mistake_id > ? AND anki_mistake_id <= ?`)
      .bind(user, after, top).all()).results || [];
    let gone = mirrored.map(x => x.id).filter(id => !have.has(id));
    if (gone.length) {
      const blank = !all.length && after === 0;
      const many = gone.length > GONE_MAX && gone.length > GONE_SHARE * mirrored.length;
      if (blank || many) {
        const agreed = blank ? [] : await goneAgreed(env, user, gone);
        held_back = gone.length - agreed.length;
        console.error(JSON.stringify({ anki_full_deletes_held: { user, gone: gone.length, mirrored: mirrored.length, blank, agreed: agreed.length } }));
        gone = agreed;
      }
      if (gone.length) deleted = await forgetAnki(env, user, gone, 'cron:anki.full');
    }
  }
  const going = more || partial;
  return { ...r, deleted, ...(held_back ? { deletes_held: held_back } : {}), cursor: going ? String(Math.max(after, maxId(got))) : null, more: going, seen: got.length };
}
export const GONE_MAX = 5, GONE_SHARE = 0.3, GONE_AGREE_MS = 3 * 86_400_000;

/** Whether a list_mistakes reply pages oldest first with a true `more` (the server's S1); an older server says nothing. */
export const ascending = page => !!(page && !page.error && page.order === 'oldest');

/**
 * anki.full on S1's pages (oldest first, at most a page, a true `more`). Every record the server has between the cursor
 * and the last one mirrored is on the page, so a mirrored id in that range that the page lacks is gone; on the last page
 * (mirrored in full) the range runs to the end of the log. The same guards as before: a blank first page, or a large
 * share at once, waits for the next pass to agree (RH2-3).
 */
async function fullAscending(env, user, after, page) {
  const { all } = pageOf(page, PAGE);
  const r = await ingestAnkiRows(env, user, all, { via: 'cron:anki.full', budget: jobBudget(env) });
  const got = all.slice(0, r.ingested);
  const going = !!page.more || got.length < all.length;
  let deleted = 0, held_back = 0;
  if (got.length || !going) {
    const top = going ? maxId(got) : Number.MAX_SAFE_INTEGER;
    const have = new Set(all.map(x => Number(x.id)));
    const mirrored = (await env.DB.prepare(`SELECT anki_mistake_id AS id FROM misses WHERE user_id = ? AND deleted_at IS NULL AND anki_mistake_id > ? AND anki_mistake_id <= ?`)
      .bind(user, after, top).all()).results || [];
    let gone = mirrored.map(x => x.id).filter(id => !have.has(id));
    if (gone.length) {
      const blank = !all.length && after === 0;
      const many = gone.length > GONE_MAX && gone.length > GONE_SHARE * mirrored.length;
      if (blank || many) {
        const agreed = blank ? [] : await goneAgreed(env, user, gone);
        held_back = gone.length - agreed.length;
        console.error(JSON.stringify({ anki_full_deletes_held: { user, gone: gone.length, mirrored: mirrored.length, blank, agreed: agreed.length } }));
        gone = agreed;
      }
      if (gone.length) deleted = await forgetAnki(env, user, gone, 'cron:anki.full');
    }
  }
  return { ...r, deleted, ...(held_back ? { deletes_held: held_back } : {}), cursor: going ? String(Math.max(after, maxId(got))) : null, more: going, seen: got.length };
}
// A large deletion waits for a second pass: the ids are kept in sync_state 'gone:anki.full', and those the next
// pass (within 3 days) also finds gone are returned for deleting. Returns the agreed ids.
async function goneAgreed(env, user, gone) {
  const t = nowMs();
  let prev = [];
  try {
    const row = await env.DB.prepare(`SELECT cursor, last_ok_at FROM sync_state WHERE user_id = ? AND source = 'gone:anki.full'`).bind(user).first();
    if (row && row.last_ok_at && t - row.last_ok_at < GONE_AGREE_MS) prev = JSON.parse(row.cursor || '[]');
  } catch (e) { prev = []; }
  const seen = new Set((Array.isArray(prev) ? prev : []).map(Number));
  const agreed = gone.filter(id => seen.has(Number(id)));
  const waiting = gone.filter(id => !seen.has(Number(id)));
  await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, fails, lock_until, last_ok_at) VALUES (?, 'gone:anki.full', ?, 0, 0, ?)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, JSON.stringify(waiting.slice(0, 2000)), t).run();
  return agreed;
}

/**
 * One step of realtime's rebuild part 'anki' (rebuild.js): a page of the whole log after `cursor`, mirrored as
 * far as `budget` (the D1 queries the step may spend; B2-2) allows. Returns {n, failed, cursor, more}.
 */
export async function rebuildAnkiStep(env, user, { cursor = null, limit = 100, budget = null } = {}) {
  const after = Number(cursor) || 0;
  const n = Math.max(1, Math.min(PAGE, limit));
  const page = await list(env, { after_id: after, limit: n, order: 'oldest' });
  // An older server's cut page (newest first): every mirrored record it left out, by id first (B3-1). S1's pages are
  // oldest first and leave nothing out.
  if (!ascending(page)) {
    const gap = await gapStep(env, user, page, after, 'all', { via: 'rebuild:anki', budget });
    if (gap) return { n: gap.seen, failed: 0, cursor: gap.cursor, more: true };
  }
  const { recs, more } = pageOf(page, n);
  const r = await ingestAnkiRows(env, user, recs, { via: 'rebuild:anki', budget });
  const got = recs.slice(0, r.ingested);
  return { n: got.length, failed: 0, cursor: got.length ? String(maxId(got)) : cursor, more: more || got.length < recs.length };
}

export const JOBS = { 'anki.new': ankiNew, 'anki.recent': ankiRecent, 'anki.due': ankiDue, 'anki.full': ankiFull };
