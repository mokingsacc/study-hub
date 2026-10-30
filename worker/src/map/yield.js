import { ankiCall } from '../anki.js';
import { rankJoin, RANK_COLS } from '../exam-ranks.js';

export const YIELD_BANDS = Object.freeze({ A: [0.70, 1.00], B: [0.40, 0.55], C: [0.20, 0.30], none: [0.05, 0.15] });
export const BANDS = YIELD_BANDS;
export const LANES = ['A', 'B', 'C'];
export const WEIGHTS = Object.freeze({ m: 0.35, i: 0.25, f: 0.25, a: 0.15 });
export const MEHLMAN_UNITS = 229;          // ranks run 1..229
export const T_MAX = 1.05;                 // teach's tie-break ceiling
export const EVENT_STEP = 0.01;            // a change this big emits topic.updated {yield}
export const RESYNC_OVER = 50;             // more changed topics than this: one map.resync instead

const sat = (n, full) => Math.min(1, Math.log(1 + Math.max(0, Number(n) || 0)) / Math.log(1 + full));
const r4 = x => Math.round(x * 10000) / 10000;

const rankScore = r => (Number.isInteger(r) && r >= 1 ? Math.max(0, 1 - (Math.min(r, MEHLMAN_UNITS) - 1) / (MEHLMAN_UNITS - 1)) : 0);

export function yieldOf({ lane = null, rank = null, nbme_images = 0, q_seen = 0, anking_cards = 0, mehlman_match = null, exam = null } = {}) {
  const band = LANES.includes(lane) ? lane : 'none';
  const [lo, hi] = YIELD_BANDS[band];
  const mm = Number.isInteger(rank) && rank >= 1 ? rankScore(rank) : ({ strong: 0.5, weak: 0 }[mehlman_match] ?? 0);
  const m = exam ? (mm + rankScore(exam.nbme) + rankScore(exam.cms)) / 3 : mm;
  const i = sat(nbme_images, 20);    // 20 or more pictures = 1
  const f = sat(q_seen, 8);
  const a = sat(anking_cards, 21);
  const w = WEIGHTS.m * m + WEIGHTS.i * i + WEIGHTS.f * f + WEIGHTS.a * a;
  const y = lo + (hi - lo) * w;
  return { yield: r4(y), json: { lane: band === 'none' ? null : band, m: r4(m), i: r4(i), f: r4(f), a: r4(a), w: r4(w), band,
    ...(exam ? { exam: { nbme: exam.nbme ?? null, cms: exam.cms ?? null } } : {}) } };
}

/** The smallest ratio between neighbouring bands (lowest of the higher over highest of the lower). */
export function bandGap(bands = YIELD_BANDS) {
  const order = ['A', 'B', 'C', 'none'];
  let min = Infinity;
  for (let k = 0; k + 1 < order.length; k++) min = Math.min(min, bands[order[k]][0] / bands[order[k + 1]][1]);
  return min;
}

export const unitLane = u => (u && (u.lane || { onenote_core: 'B', onenote_mehlman: 'C' }[u.kind])) || null;

// A checklist unit's exam ranks once the bank is loaded (planYieldRefresh reads bank 1), else null: no change.
const examOf = u => (u && u.kind === 'checklist' && Number(u.bank) ? { nbme: u.nbme_rank ?? null, cms: u.cms_rank ?? null } : null);

/** A topic's yield from its best unit (or none) and its own counts. */
export function topicYield(topic, unit = null) {
  const r = yieldOf({
    lane: unitLane(unit), rank: unit ? unit.mehlman_rank ?? null : null,
    nbme_images: Math.max(unit ? unit.nbme_images || 0 : 0, topic.nbme_images_own || 0),
    q_seen: topic.q_seen || 0, anking_cards: topic.anking_cards || 0, mehlman_match: topic.mehlman_match || null, exam: examOf(unit),
  });
  return { yield: r.yield, json: { ...r.json, unit_id: unit ? unit.id : null } };
}

export function unitYield(unit, topics = []) {
  const sum = k => topics.reduce((s, t) => s + (Number(t[k]) || 0), 0);
  return yieldOf({ lane: unitLane(unit), rank: unit.mehlman_rank ?? null, nbme_images: unit.nbme_images || 0, q_seen: sum('q_seen'), anking_cards: sum('anking_cards'), exam: examOf(unit) });
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const sameJson = (a, b) => { try { return JSON.stringify(JSON.parse(a || '{}')) === JSON.stringify(b); } catch { return false; } };

const Q_SEEN_SQL = `SELECT topic_id, count(DISTINCT obs_key) AS n FROM evidence WHERE user_id = ? AND held = 0 AND slot = 0 AND topic_id IS NOT NULL
  AND (obs_key LIKE 'uw:%' OR obs_key LIKE 'uwb:%' OR obs_key LIKE 'hub:%') GROUP BY topic_id`;

export async function planYieldRefresh(env, user, args = {}, ctx = {}) {
  const now = ctx.now || Date.now();
  const read = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [tq, uq, utq] = await env.DB.batch([
    read(`SELECT id, unit_id, yield, yield_json, q_seen, anking_cards, mehlman_match, nbme_images_own FROM topics
          WHERE user_id = ? AND status IN ('proposed','confirmed')`, user),
    read(`SELECT u.id, u.kind, u.lane, u.mehlman_rank, u.nbme_images, u.yield, u.yield_json, ${RANK_COLS},
            EXISTS (SELECT 1 FROM xq_rank b WHERE b.user_id = u.user_id) AS bank FROM units u ${rankJoin('u')} WHERE u.user_id = ?`, user),
    read('SELECT unit_id, topic_id FROM unit_topics WHERE user_id = ?', user),
  ]);
  let seen = null;
  try { seen = new Map(((await read(Q_SEEN_SQL, user).all()).results || []).map(r => [r.topic_id, r.n])); } catch (e) { if (!noTable(e)) throw e; }
  const units = new Map((uq.results || []).map(u => [u.id, u]));
  const anking = args.anking && typeof args.anking === 'object' ? args.anking : {};
  const only = Array.isArray(args.unit_ids) && args.unit_ids.length ? new Set(args.unit_ids) : null;
  const unitTopics = new Map();
  for (const r of utq.results || []) { if (!unitTopics.has(r.unit_id)) unitTopics.set(r.unit_id, []); unitTopics.get(r.unit_id).push(r.topic_id); }

  const evented = [], quiet = [], next = new Map();
  for (const t of tq.results || []) {
    const q_seen = seen ? seen.get(t.id) || 0 : t.q_seen;
    const anking_cards = Number.isInteger(anking[t.id]) ? anking[t.id] : t.anking_cards;
    const fresh = { ...t, q_seen, anking_cards };
    next.set(t.id, fresh);
    if (only && !only.has(t.unit_id)) continue;
    const y = topicYield(fresh, units.get(t.unit_id) || null);
    const after = {};
    if (q_seen !== t.q_seen) after.q_seen = q_seen;
    if (anking_cards !== t.anking_cards) after.anking_cards = anking_cards;
    if (Math.abs(y.yield - t.yield) >= 0.00005) after.yield = y.yield;
    if (!sameJson(t.yield_json, y.json)) after.yield_json = JSON.stringify(y.json);
    if (!Object.keys(after).length) continue;
    const row = { table: 'topics', op: 'update', key: { id: t.id }, before: Object.fromEntries(Object.keys(after).map(k => [k, t[k]])), after: { ...after, updated_at: now } };
    (Math.abs((after.yield ?? t.yield) - t.yield) >= EVENT_STEP ? evented : quiet).push({ row, t, y });
  }
  const unitRows = [];
  for (const u of units.values()) {
    if (only && !only.has(u.id)) continue;
    const y = unitYield(u, (unitTopics.get(u.id) || []).map(id => next.get(id)).filter(Boolean));
    if (Math.abs(y.yield - u.yield) < 0.00005 && sameJson(u.yield_json, y.json)) continue;
    unitRows.push({ table: 'units', op: 'update', key: { id: u.id }, before: { yield: u.yield, yield_json: u.yield_json }, after: { yield: y.yield, yield_json: JSON.stringify(y.json), updated_at: now } });
  }
  const n = evented.length + quiet.length + unitRows.length;
  if (!n) return { noop: true, summary: 'Yield is up to date.' };
  const summary = `Yield refreshed: ${evented.length + quiet.length} topics and ${unitRows.length} units`;
  // One topic.updated per topic that moved by 0.01 or more (rows first, in the same order); a big refresh is one map.resync.
  const many = evented.length > RESYNC_OVER;
  const events = many ? [{ kind: 'map.resync', target_type: 'map', target_id: 'yield', summary, undoable: false }]
    : evented.map(({ t, y }) => ({ kind: 'topic.updated', target_type: 'topic', target_id: t.id, topic_id: t.id, undoable: false,
      summary: `Yield ${t.yield.toFixed(2)} to ${y.yield.toFixed(2)} (lane ${y.json.lane || 'off the checklist'})` }));
  return { rows: [...evented.map(x => x.row), ...quiet.map(x => x.row), ...unitRows], events, count: n, summary,
    reply: { topics: evented.length + quiet.length, units: unitRows.length, events: events.length } };
}

function ankingList(record) {
  const nested = record && record.sources && record.sources.anking;
  if (nested && Array.isArray(nested.cards)) return nested.cards;
  if (Array.isArray(nested)) return nested;
  return record && Array.isArray(record.anking) ? record.anking : null;
}
export const hasAnking = record => ankingList(record) !== null;
export function ankingIds(record) {
  const list = ankingList(record) || [];
  return list.map(c => (c && typeof c === 'object' ? c.card_id ?? c.cid ?? c.id ?? c.note_id : c)).filter(x => x != null).map(String);
}

// The call size and timeout ingestion's by-id reads use (ingest/anki.js IDS_PER_CALL, IDS_CALL_MS): the live server
// answers mistake_sources for 10 ids within 25 s, and 40 ids in 8 s always failed (release-2 fixes, 25 Oct).
export const ANKING_IDS_PER_CALL = 10, ANKING_CALL_MS = 25_000, ANKING_RUN_MS = 150_000, ANKING_MAX_CALLS = 30;

export async function ankingCounts(env, user, { topicIds = null, maxCalls = ANKING_MAX_CALLS, runMs = ANKING_RUN_MS, now = () => Date.now() } = {}) {
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT anki_mistake_id AS id, topic_id FROM misses WHERE user_id = ? AND held = 0 AND deleted_at IS NULL
        AND anki_mistake_id IS NOT NULL AND topic_id IS NOT NULL ${topicIds ? 'AND topic_id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY anki_mistake_id`).bind(...(topicIds ? [user, JSON.stringify(topicIds)] : [user])).all()).results || [];
  } catch (e) { if (noTable(e)) return { counts: {}, misses: 0, calls: 0, partial: false }; throw e; }
  const topicOf = new Map(rows.map(r => [Number(r.id), r.topic_id]));
  const ids = [...topicOf.keys()];
  const sets = new Map();
  let calls = 0, partial = false;
  const start = now();
  for (let k = 0; k < ids.length; k += ANKING_IDS_PER_CALL) {
    if (calls >= maxCalls || (calls > 0 && now() - start > runMs)) { partial = true; break; }
    calls++;
    let res;
    try { res = await ankiCall(env, 'mistake_sources', { ids: ids.slice(k, k + ANKING_IDS_PER_CALL) }, { timeoutMs: ANKING_CALL_MS }); } catch (e) {
      console.error('ankingCounts: mistake_sources failed', e && e.message);
      partial = true;
      break;
    }
    for (const m of (res && res.mistakes) || []) {
      const topic = topicOf.get(Number(m.id));
      if (!topic) continue;
      if (!hasAnking(m)) { partial = true; continue; } // unknown is not zero: never lower a topic's count on it
      if (!sets.has(topic)) sets.set(topic, new Set());
      for (const c of ankingIds(m)) sets.get(topic).add(c);
    }
  }
  const counts = {};
  for (const t of new Set(topicOf.values())) if (sets.has(t) || !partial) counts[t] = sets.has(t) ? sets.get(t).size : 0;
  return { counts, misses: ids.length, calls, partial };
}

export async function refreshYield(env, user, { anking, unit_ids = null, now = Date.now(), apply = null } = {}) {
  let counts = anking;
  if (counts === undefined) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(new Date(now)));
    counts = hour === 3 && env.ANKI_MCP_URL ? (await ankingCounts(env, user)).counts : null;
  }
  const run = apply || (async (...a) => (await import('./change.js')).applyChange(...a));
  return run(env, user, { actor: 'code', surface: 'cron', op: 'yield.refresh', via: 'cron:refreshYield',
    args: { ...(counts && Object.keys(counts).length ? { anking: counts } : {}), ...(unit_ids ? { unit_ids } : {}) } });
}
