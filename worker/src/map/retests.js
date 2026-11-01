import { londonDay, londonDayStart, now as nowMs } from '../util.js';
import { ankiCall } from '../anki.js';
import { noteJob } from '../job-log.js';
import { retestKey, ankiKey, dayNoon, isDay, retestOutcome, sameEvidence, eventAt } from './ingest/map-fields.js';
import { addDays, NO_LESSON_ERRORS } from './teach-priority.js';

// The old deck the cards went to until 1 Nov 2026; its cards move into MY_DECK, then the server deletes it.
export const RETEST_DECK = 'Step 2 — Re-tests';
export const MY_DECK = 'Step 2 — My Cards';
export const SPACING = { sure: [7], lean: [7], guess: [7], unsaid: [7] };
// An open re-test from the Anki log within this many days of one booked here is the same re-test.
export const SAME_WITHIN_DAYS = 3;
export const CATCHUP_PER_DAY = 12, BOOK_LIMIT = 200;
export const NEW_CARDS_PER_DAY = 3;
export const EXPIRE_DAYS = 14;
export const CARDS_PER_DAY = NEW_CARDS_PER_DAY, CARDS_PER_RUN = 3, CARD_TRIES = 3, RETEST_DAILY_USD = Infinity, RESERVE_USD = 0.2;
export const QUIET_MOVES_PER_RUN = 10;
export const COVERED_TAG = 'hub_duplicate';
export const RESULTS = ['got_it', 'missed_again'];
const CALL_MS = 25_000;

const json = v => JSON.stringify([...new Set(v)]);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const maxDay = (a, b) => (a > b ? a : b);

// ---------------------------------------------------------------- pure rules

export const missRetestId = (missId, due) => `${missId}|${due}`;
export const lessonRetestId = (lessonId, due) => `lesson:${lessonId}|${due}`;
/** The tag-safe key the Anki server files a re-test's card under (hub_retest::<key>). */
export const cardKey = id => String(id).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);

/** A miss that gets re-tests: live, wrong or flawed, not a slip. */
export const bookable = m => !!m && !Number(m.held) && m.deleted_at == null && (m.result === 'wrong' || m.result === 'flawed')
  && !NO_LESSON_ERRORS.includes(m.error_type);

/** A card rating as a re-test result: Good (3) and Easy (4) got it; Again (1) and Hard (2) missed it. */
export const ratingResult = ease => (Number(ease) >= 3 ? 'got_it' : Number(ease) >= 1 ? 'missed_again' : null);

/**
 * The due days for a miss booked now (pure). slot(): the next catch-up day with room, used when the first day has
 * already passed; the later days keep their spacing from it and never come before their own day.
 */
export function plannedDues(miss, today, slot = () => today) {
  const gaps = SPACING[miss.confidence] || SPACING.unsaid;
  const day = isDay(miss.day) ? miss.day : today;
  const own = gaps.map(g => addDays(day, g));
  if (own[0] >= today) return own;
  const first = slot();
  return gaps.map((g, i) => (i === 0 ? first : maxDay(own[i], addDays(first, g - gaps[0]))));
}

/** A catch-up slot finder over open counts per day (pure): the first day from today with fewer than perDay. */
export function slotter(today, counts = new Map(), perDay = CATCHUP_PER_DAY) {
  return () => {
    for (let i = 0; i < 400; i++) {
      const d = addDays(today, i);
      const n = counts.get(d) || 0;
      if (n < perDay) { counts.set(d, n + 1); return d; }
    }
    return today;
  };
}

/** The earliest open due day of some re-test rows, or null. */
export const nextDue = rows => (rows || []).filter(r => r && r.result == null && isDay(r.due)).map(r => r.due).sort()[0] || null;

/**
 * The retest evidence for one answered re-test (pure). row: the retests row; miss: its miss (topic, queue, label,
 * anki id) or null for a lesson re-test with topic: {topic_id, category_id, label}. The key is the Anki log's own
 * (retest:<mistake id>:<due>) whenever the miss has one, so the same result never counts twice.
 */
export function retestEvidence(row, miss, result, { at, day, source, source_ref, card_id = null }) {
  const aid = miss && miss.anki_mistake_id != null ? miss.anki_mistake_id : null;
  const key = aid != null ? retestKey(aid, row.due) : row.kind === 'lesson' ? retestKey(`lesson:${row.lesson_id}`, row.due) : retestKey(row.miss_id, row.due);
  const topic = (miss && miss.topic_id) || row.topic_id || null;
  return {
    obs_key: key, slot: 0, kind: 'retest', at, day, source, source_ref, miss_id: row.kind === 'lesson' ? null : row.miss_id, lesson_id: row.kind === 'lesson' ? row.lesson_id : null,
    held: 0, result: result === 'got_it' ? 'right' : 'wrong', outcome: result, topic_id: topic,
    queue_id: topic ? null : (miss && miss.queue_id) || null, label_norm: topic ? null : (miss && miss.label_norm) || null,
    category_id: (miss && miss.category_id) || row.category_id || null, card_id,
    detail_json: JSON.stringify({ label: (miss && miss.label) || row.label || 'lesson check' }),
  };
}

export function closePlan(target, open, result, by, day) {
  const close = [{ id: target.id, result, done_by: by }];
  for (const r of open) if (r.id !== target.id && r.result == null && r.due <= day) close.push({ id: r.id, result, done_by: 'same' });
  return { close, book: [] };
}

/**
 * The Anki log's re-tests of one mirrored miss against those booked here (pure). ankiList: [{due, result}] as the
 * log sends them; hub: the miss's retests rows. Returns {insert: [{id, due, result}], close: [{id, result, due}],
 * evidenceFor: [{id, due, result}]}: the log's first open day when the miss has no row here yet (one card per miss), results the log
 * recorded on rows still open here, and new rows with a result (each closing this miss's open rows due by then).
 * A result here that the log only echoes (the push after a card or a lesson) is left alone.
 */
export function importPlan(missId, ankiList, hub) {
  const byId = new Map((hub || []).map(r => [r.id, r]));
  const out = { insert: [], close: [], evidenceFor: [] };
  const done = r => (r.done_at != null ? { done_at: r.done_at } : {});
  const near = (a, b) => Math.abs(Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) <= SAME_WITHIN_DAYS * 86_400_000;
  for (const r of [...(ankiList || [])].filter(x => x && isDay(x.due)).sort((x, y) => x.due.localeCompare(y.due))) {
    const result = r.result == null ? null : retestOutcome(r.result);
    if (r.result != null && !result) continue;
    const id = missRetestId(missId, r.due);
    const h = byId.get(id);
    if (h) {
      if (h.result == null && result) { out.close.push({ id, result, due: r.due }); out.evidenceFor.push({ id, due: r.due, result, ...done(r) }); h.result = result; }
      continue;
    }
    if (!result) {
      // One card per miss (1 Nov 2026): the log's open re-test is booked here only while the miss has nothing here
      // at all; its later days (28 days, a week after missed again) are not.
      if (byId.size) continue;
      out.insert.push({ id, due: r.due, result: null });
      byId.set(id, { id, due: r.due, result: null });
      continue;
    }
    // A result for a day not booked here: the log's answer when nothing was due there ("today"). When a card or a lesson
    // closed one of this miss's re-tests within the last few days, it is that result echoed back.
    const echo = (hub || []).some(x => x.result != null && x.done_by !== 'anki' && x.done_at && near(londonDay(x.done_at), r.due) && londonDay(x.done_at) <= r.due);
    if (echo) continue;
    out.insert.push({ id, due: r.due, result, ...done(r) });
    out.evidenceFor.push({ id, due: r.due, result, ...done(r) });
    for (const x of hub || []) if (x.result == null && x.due <= r.due) { out.close.push({ id: x.id, result, due: x.due, same: true }); x.result = result; }
    byId.set(id, { id, due: r.due, result });
  }
  return out;
}

// ---------------------------------------------------------------- statements

const COLS = ['user_id', 'id', 'kind', 'miss_id', 'lesson_id', 'topic_id', 'due', 'source', 'result', 'done_at', 'done_by', 'card_state', 'created_at', 'updated_at'];
/** New retests rows in one statement; an id already there is left as it is. */
export function insertStatement(env, user, rows, t) {
  if (!rows.length) return null;
  const list = rows.map(r => ({ user_id: user, kind: 'miss', miss_id: null, lesson_id: null, topic_id: null, result: null, done_at: null, done_by: null,
    card_state: 'pending', created_at: t, updated_at: t, ...r }));
  return env.DB.prepare(`INSERT INTO retests (${COLS.join(', ')}) SELECT ${COLS.map(c => `json_extract(value, '$.${c}')`).join(', ')}
      FROM json_each(?2) WHERE json_extract(value, '$.user_id') = ?1 ON CONFLICT (user_id, id) DO NOTHING`)
    .bind(user, JSON.stringify(list.map(r => Object.fromEntries(COLS.map(c => [c, r[c] ?? null])))));
}
export function closeStatement(env, user, close, t) {
  if (!close.length) return null;
  const pick = k => `(SELECT json_extract(j.value, '$.${k}') FROM json_each(?2) j WHERE json_extract(j.value, '$.id') = retests.id LIMIT 1)`;
  return env.DB.prepare(`UPDATE retests SET result = ${pick('result')}, done_by = ${pick('done_by')}, done_at = coalesce(${pick('done_at')}, ?3), updated_at = ?3
      WHERE user_id = ?1 AND result IS NULL AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`)
    .bind(user, JSON.stringify(close.map(c => ({ id: c.id, result: c.result, done_by: c.done_by, done_at: Number.isSafeInteger(c.done_at) ? c.done_at : null }))), t);
}
export function nextRetestStatement(env, user, missIds = null) {
  const sub = `(SELECT min(r.due) FROM retests r WHERE r.user_id = misses.user_id AND r.miss_id = misses.id AND r.result IS NULL AND r.covered IS NULL)`;
  if (missIds && !missIds.length) return null;
  return env.DB.prepare(`UPDATE misses SET next_retest_day = ${sub} WHERE user_id = ?1 ${missIds ? 'AND id IN (SELECT value FROM json_each(?2))' : 'AND ?2 IS NULL'}
      AND coalesce(next_retest_day, '') <> coalesce(${sub}, '')`).bind(user, missIds ? json(missIds) : null);
}
const outboxStatement = (env, user, missId, result, day, t) => env.DB.prepare(`INSERT INTO outbox (id, kind, idem_key, payload_json, status, attempts, created_at)
    VALUES (?1, 'anki_retest', ?2, ?3, 'pending', 0, ?4) ON CONFLICT (idem_key) DO NOTHING`)
  .bind(crypto.randomUUID(), `retest:${user}:${missId}:${day}`, JSON.stringify({ user, miss_id: missId, result, day }), t);

// ---------------------------------------------------------------- the Anki log's re-tests (anki.js and the catch-up)

export function retestDoneAt(r, now = nowMs()) {
  const fallback = dayNoon(r.due);
  const d = r.done_at;
  const real = isDay(d) ? Math.min(dayNoon(d), now) : typeof d === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(d) ? Date.parse(d) : d;
  return eventAt(real, fallback, { lo: fallback - 7 * 86_400_000, hi: now });
}

/**
 * The Anki log's re-tests for mirrored misses, as parts of the caller's commit: {statements, upsert, events, recompute}.
 * items: [{row: the misses row (id, topic, queue, label, anki id, held), retests: [{due, result}]}]. One read of what
 * is booked here and of the evidence already written for those results.
 */
export async function importParts(env, user, items, t = nowMs()) {
  const out = { statements: [], upsert: [], events: [], recompute: [] };
  const live = (items || []).filter(it => it && it.row && !Number(it.row.held) && it.row.deleted_at == null && Array.isArray(it.retests) && it.retests.length);
  if (!live.length) return out;
  let hubRows;
  try {
    hubRows = (await env.DB.prepare('SELECT * FROM retests WHERE user_id = ? AND miss_id IN (SELECT value FROM json_each(?))').bind(user, json(live.map(it => it.row.id))).all()).results || [];
  } catch (e) { if (noTable(e)) return out; throw e; }
  const byMiss = new Map();
  for (const r of hubRows) { if (!byMiss.has(r.miss_id)) byMiss.set(r.miss_id, []); byMiss.get(r.miss_id).push(r); }
  const insert = [], close = [], ev = [], touched = new Set();
  for (const it of live) {
    const m = it.row;
    const plan = importPlan(m.id, it.retests, (byMiss.get(m.id) || []).map(r => ({ ...r })));
    for (const r of plan.insert) insert.push({ id: r.id, miss_id: m.id, topic_id: m.topic_id || null, due: r.due, source: 'anki', result: r.result,
      done_at: r.result ? retestDoneAt(r, t) : null, done_by: r.result ? 'anki' : null, card_state: r.result ? 'done' : 'pending' });
    for (const c of plan.close) close.push({ id: c.id, result: c.result, done_by: c.same ? 'same' : 'anki' });
    for (const e of plan.evidenceFor) {
      const at = retestDoneAt(e, t);
      ev.push(retestEvidence({ id: e.id, kind: 'miss', miss_id: m.id, due: e.due }, m, e.result,
        { at, day: londonDay(at), source: 'anki', source_ref: ankiKey(m.anki_mistake_id) }));
    }
    if (plan.insert.length || plan.close.length) touched.add(m.id);
  }
  if (ev.length) {
    const stored = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))')
      .bind(user, json(ev.map(e => e.obs_key))).all()).results || [];
    const by = new Map(stored.map(r => [r.obs_key, r]));
    for (const e of ev) {
      const prev = by.get(e.obs_key);
      if (sameEvidence(e, prev)) continue;
      out.upsert.push(e);
      if (e.topic_id) out.recompute.push(e.topic_id);
      if (prev && prev.topic_id && prev.topic_id !== e.topic_id) out.recompute.push(prev.topic_id);
      if (!prev) out.events.push({ kind: 'evidence.added', target_type: 'evidence', target_id: e.obs_key, topic_id: e.topic_id,
        summary: cap(`${parse(e.detail_json, {}).label}: checked again, ${e.outcome === 'got_it' ? 'right' : 'missed'}`), before: null, after: { topic_id: e.topic_id, kind: 'retest', outcome: e.outcome } });
    }
  }
  out.statements.push(...[insertStatement(env, user, insert, t), closeStatement(env, user, close, t), nextRetestStatement(env, user, [...touched])].filter(Boolean));
  return out;
}

// ---------------------------------------------------------------- booking (minute job)

const MISS_READ = `m.id, m.day, m.at, m.label, m.result, m.confidence, m.error_type, m.held, m.deleted_at, m.topic_id, m.queue_id, m.label_norm,
  m.category_id, m.anki_mistake_id, m.retests_json`;
const NONE_HERE = 'NOT EXISTS (SELECT 1 FROM retests r WHERE r.user_id = m.user_id AND r.miss_id = m.id)';
const BOOKABLE = `m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.result IN ('wrong', 'flawed')
  AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking')) AND ${NONE_HERE}`;

/**
 * The booking job: the Anki log's re-tests on mirrored misses that have none here yet (the first run imports the whole
 * mirror), then the hub's own spacing on every other bookable miss, then next_retest_day put right for any miss whose
 * day is out of step. Returns {imported, booked, misses} or {skipped}.
 */
export async function bookRetests(env, user, { now = nowMs(), limit = BOOK_LIMIT } = {}) {
  const today = londonDay(now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let fromAnki, todo, counts;
  try {
    [fromAnki, todo, counts] = await env.DB.batch([
      q(`SELECT ${MISS_READ} FROM misses m WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.anki_mistake_id IS NOT NULL
           AND m.retests_json IS NOT NULL AND m.retests_json NOT IN ('', '[]') AND ${NONE_HERE} ORDER BY m.at LIMIT ?2`, user, limit),
      q(`SELECT ${MISS_READ} FROM misses m WHERE m.user_id = ?1 AND ${BOOKABLE} AND (m.retests_json IS NULL OR m.retests_json IN ('', '[]'))
         ORDER BY (m.confidence = 'sure' AND m.result = 'wrong') DESC, CASE m.confidence WHEN 'sure' THEN 0 WHEN 'lean' THEN 1 WHEN 'guess' THEN 2 ELSE 3 END, m.at LIMIT ?2`, user, limit),
      q(`SELECT due, count(*) AS n FROM retests WHERE user_id = ?1 AND result IS NULL AND due >= ?2 GROUP BY due`, user, today),
    ]);
  } catch (e) { if (noTable(e)) return { skipped: 'not ready' }; throw e; }
  const t = nowMs();
  const imp = await importParts(env, user, (fromAnki.results || []).map(row => ({ row, retests: parse(row.retests_json, []) })), t);
  const slot = slotter(today, new Map((counts.results || []).map(r => [r.due, Number(r.n) || 0])));
  const rows = [];
  for (const m of todo.results || []) {
    if (!bookable(m)) continue;
    for (const due of [...new Set(plannedDues(m, today, slot))]) rows.push({ id: missRetestId(m.id, due), miss_id: m.id, topic_id: m.topic_id || null, due, source: 'hub' });
  }
  const statements = [...imp.statements, insertStatement(env, user, rows, t), nextRetestStatement(env, user, null)].filter(Boolean);
  const { commit } = await import('./ingest/hub.js');
  await commit(env, user, { via: 'cron:retests', surface: 'cron', statements, evidence: { upsert: imp.upsert }, events: imp.events, recompute: imp.recompute });
  const out = { imported: (fromAnki.results || []).length, booked: rows.length, misses: new Set(rows.map(r => r.miss_id)).size };
  if (out.booked || out.imported) await noteJob(env, { job: 'retest_book', user, add: true, at: now, counts: out });
  return out;
}

// ---------------------------------------------------------------- closing from card ratings (anki-reviews.js)

/**
 * The results the first ratings of re-test cards give (pure): rows are retests rows with a card; a card's first
 * rating after it was made (card ids are their creation time) answers its re-test, if still open.
 * Returns [{row, result, at}].
 */
export function cardResults(rows, reviews) {
  const first = new Map();
  for (const r of reviews || []) {
    const ease = Number(r && r.ease), at = Number(r && r.review_id), card = Number(r && r.card_id);
    if (!(ease >= 1 && ease <= 4) || !Number.isSafeInteger(at) || !Number.isSafeInteger(card)) continue;
    const prev = first.get(card);
    if (!prev || at < prev.at) first.set(card, { at, ease });
  }
  const out = [];
  for (const row of rows || []) {
    const f = row.card_id != null ? first.get(Number(row.card_id)) : null;
    if (!f || row.result != null || f.at < Number(row.card_id) - 60_000) continue;
    out.push({ row, result: ratingResult(f.ease), at: f.at });
  }
  return out;
}

export async function closeFromReviews(env, user, reviews, { now = nowMs() } = {}) {
  const cand = [...new Set((reviews || []).map(r => Number(r && r.card_id)).filter(n => Number.isSafeInteger(n) && n > 0))];
  const out = { cards: new Set(), skip: new Set(), topics: new Map(), closed: 0 };
  if (!cand.length) return out;
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT r.*, m.anki_mistake_id, m.label, m.topic_id AS m_topic_id, m.queue_id, m.label_norm, m.category_id AS m_category_id,
        t.category_id AS t_category_id, t.name AS topic_name FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id
        LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = coalesce(m.topic_id, r.topic_id)
      WHERE r.user_id = ?1 AND r.card_id IN (SELECT value FROM json_each(?2))`).bind(user, json(cand)).all()).results || [];
  } catch (e) { if (noTable(e)) return out; throw e; }
  for (const r of rows) {
    const card = Number(r.card_id);
    out.cards.add(card);
    const topic = r.m_topic_id || r.topic_id;
    if (topic && !out.topics.has(card)) out.topics.set(card, topic);
    if (r.done_by === 'card' && r.done_at != null) out.skip.add(`${card}|${londonDay(Number(r.done_at))}`);
  }
  const answered = cardResults(rows, (reviews || []).filter(r => out.cards.has(Number(r.card_id))));
  for (const a of answered) out.skip.add(`${Number(a.row.card_id)}|${londonDay(a.at)}`);
  if (!answered.length) return out;
  const parts = await answerParts(env, user, answered.map(a => ({ ...a, by: 'card' })), now);
  if (parts) {
    const { commit } = await import('./ingest/hub.js');
    await commit(env, user, { via: 'cron:anki.reviews', surface: 'cron', ...parts });
  }
  out.closed = answered.length;
  return out;
}

// The commit parts for answered re-tests (cards; the lesson builds its own rows). answered: [{row (with the miss's
// fields joined), result, at, by}]. One read of the open rows of the same misses and lessons.
async function answerParts(env, user, answered, t) {
  const missIds = [...new Set(answered.map(a => a.row.miss_id).filter(Boolean))];
  const lessonIds = [...new Set(answered.map(a => a.row.lesson_id).filter(Boolean))];
  const open = (await env.DB.prepare(`SELECT * FROM retests WHERE user_id = ?1 AND result IS NULL
      AND (miss_id IN (SELECT value FROM json_each(?2)) OR lesson_id IN (SELECT value FROM json_each(?3)))`).bind(user, json(missIds), json(lessonIds)).all()).results || [];
  const close = [], upsert = [], events = [], recompute = [], statements = [];
  const done = new Set();
  for (const a of answered) {
    const row = a.row;
    if (done.has(row.id)) continue;
    const day = londonDay(a.at);
    const mine = open.filter(o => (row.kind === 'lesson' ? o.lesson_id === row.lesson_id : o.miss_id === row.miss_id) && !done.has(o.id));
    const plan = closePlan(row, mine.some(o => o.id === row.id) ? mine : [row, ...mine], a.result, a.by, day);
    for (const c of plan.close) done.add(c.id);
    close.push(...plan.close.map(c => ({ ...c, done_at: a.at })));
    const miss = row.kind === 'lesson' ? null : { anki_mistake_id: row.anki_mistake_id, topic_id: row.m_topic_id, queue_id: row.queue_id, label_norm: row.label_norm,
      category_id: row.m_category_id || row.t_category_id, label: row.label };
    const e = retestEvidence({ ...row, category_id: row.t_category_id, label: row.kind === 'lesson' ? `${row.topic_name || 'lesson'}: lesson check` : row.label }, miss, a.result,
      { at: a.at, day, source: 'anki', source_ref: `retest:${row.id}`, card_id: row.card_id != null ? Number(row.card_id) : null });
    upsert.push(e);
    if (e.topic_id) recompute.push(e.topic_id);
    events.push({ kind: 'evidence.added', target_type: 'evidence', target_id: e.obs_key, topic_id: e.topic_id,
      summary: cap(`${parse(e.detail_json, {}).label}: its card ${a.result === 'got_it' ? 'right' : 'missed'} the first time`), before: null, after: { topic_id: e.topic_id, kind: 'retest', outcome: a.result } });
    // The Anki log agrees: its own re-test of the miss gets the same result (only a re-test the log booked itself, so it
    // never adds one of its own for a day it had none).
    const ankiOwned = [row, ...mine].some(o => plan.close.some(c => c.id === o.id) && o.source === 'anki');
    if (row.anki_mistake_id != null && ankiOwned) statements.push(outboxStatement(env, user, row.miss_id, a.result, day, t));
  }
  statements.unshift(...[closeStatement(env, user, close, t)].filter(Boolean));
  const s = nextRetestStatement(env, user, missIds);
  if (s) statements.push(s);
  return { statements, evidence: { upsert }, events, recompute };
}

// ---------------------------------------------------------------- the lesson (teach-save.js)

/**
 * What a lesson's save needs to know about re-tests: the topic's open ones due by today (its misses' and earlier lesson
 * re-tests on it), every open one of those misses (for their next day), the misses' stored next day, and this lesson's
 * own re-tests already booked (a re-save books none twice). {due, open, next: Map, booked: [ids]}.
 */
export async function lessonRetests(env, user, { topicId, lessonId, today }) {
  const none = { due: [], open: [], next: new Map(), booked: [] };
  if (!topicId) return none;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  try {
    const [due, booked] = await env.DB.batch([
      q(`SELECT r.*, m.anki_mistake_id FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id
          WHERE r.user_id = ?1 AND r.result IS NULL AND r.due <= ?3 AND ((r.kind = 'miss' AND m.topic_id = ?2 AND m.held = 0 AND m.deleted_at IS NULL)
            OR (r.kind = 'lesson' AND r.topic_id = ?2)) ORDER BY r.due LIMIT 50`, user, topicId, today),
      q(`SELECT id FROM retests WHERE user_id = ?1 AND lesson_id = ?2`, user, lessonId),
    ]);
    const missIds = [...new Set((due.results || []).map(r => r.miss_id).filter(Boolean))];
    const [mine, next] = missIds.length ? await env.DB.batch([
      q(`SELECT * FROM retests WHERE user_id = ?1 AND miss_id IN (SELECT value FROM json_each(?2))`, user, json(missIds)),
      q(`SELECT id, next_retest_day FROM misses WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, user, json(missIds)),
    ]) : [{ results: [] }, { results: [] }];
    const all = mine.results || [];
    return { due: due.results || [], open: all.filter(r => r.result == null), next: new Map((next.results || []).map(r => [r.id, r.next_retest_day ?? null])),
      booked: [...(booked.results || []).map(r => r.id), ...all.map(r => r.id)] };
  } catch (e) { if (noTable(e)) return none; throw e; }
}

/**
 * A lesson's rows for its own applyChange batch (pure): the final case closes the topic's due checks (right got_it,
 * wrong missed_again, partial leaves them open). It books nothing (1 Nov 2026: lessons no longer book re-tests, and
 * missed again books nothing). No retest evidence: the lesson_final row already carries that answer. Each
 * misses.next_retest_day that moves is a row too. rt: lessonRetests' reply. Returns {rows, events, outbox: [{miss_id,
 * result}]}, rows as applyChange row diffs (retests, misses), events paired with them by index.
 */
export function lessonParts({ topicId, topicName, final, rt, now }) {
  const rows = [], events = [], outbox = [];
  const add = (row, event) => { rows.push(row); events.push({ topic_id: topicId, ...event, summary: cap(event.summary) }); };
  const result = final === 'right' ? 'got_it' : final === 'wrong' ? 'missed_again' : null;
  const open = new Map((rt.open || []).map(r => [r.id, { ...r }]));
  const on = topicName || 'a topic';
  if (result) {
    for (const r of rt.due || []) {
      add({ table: 'retests', op: 'update', key: { id: r.id }, before: { result: null, done_at: null, done_by: null, updated_at: r.updated_at },
        after: { result, done_at: now, done_by: 'lesson', updated_at: now } },
      { kind: 'miss.updated', target_type: 'retests', target_id: r.id, summary: `${result === 'got_it' ? 'Right' : 'Missed'} again in a lesson on ${on}` });
      open.delete(r.id);
      if (r.source === 'anki' && r.anki_mistake_id != null && r.miss_id && !outbox.some(o => o.miss_id === r.miss_id)) outbox.push({ miss_id: r.miss_id, result });
    }
    for (const [missId, before] of rt.next || new Map()) {
      const after = nextDue([...open.values()].filter(o => o.miss_id === missId && o.covered == null));
      if ((before ?? null) === after) continue;
      add({ table: 'misses', op: 'update', key: { id: missId }, before: { next_retest_day: before ?? null }, after: { next_retest_day: after } },
        { kind: 'miss.updated', target_type: 'miss', target_id: missId, summary: `Checked in a lesson on ${on}` });
    }
  }
  return { rows, events, outbox };
}

// ---------------------------------------------------------------- the cards (minute job)

export const CASE_SYSTEM = `You write one Anki card for Mo, a learner preparing for USMLE Step 2 CK (exam day).

The card checks the concept behind something he got wrong, with a NEW case: a different patient, setting and wording, so remembering the original question would not help. You are given only the teaching point: the topic, his rule ("if X then Y"), the look-alike, what he thought, the kind of miss and the checklist step that broke (or, for a lesson, what he still left out). You never see the original question; never imitate a question bank's stem.

Mo's card style:
- stem: one or two full sentences, under 30 words, with only the findings that decide the answer; never name the answer in it.
- questions: one or two full questions, in this order: what is it ("What is the most likely diagnosis?"), then what do you do ("What is the next best step in management?" or "What is the treatment?"); one only when the point is a single fact. Aim at the step that broke when one is given: recognise asks the diagnosis, distinguish builds the look-alike's tempting finding into the case, test and treat ask the next step, trap asks the exception.
- answer: one full spoken sentence answering the first question, its key words in **bold**.
- management: one full spoken sentence answering the second question, key words in **bold**; empty when there is one question.
- vs: exactly "Versus <one real look-alike>: <the finding that tells them apart>, so <what you do differently>."
- why: one easy sentence, the reasoning chain in one line.
Words, not arrows or symbols: cards are read aloud. US guidelines. Make it differ from any earlier case listed for the same point.`;

export const CASE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['stem', 'questions', 'answer', 'management', 'vs', 'why'],
  properties: {
    stem: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' },
    management: { type: 'string' }, vs: { type: 'string' }, why: { type: 'string' },
  },
};

const STEP_WORDS = { recognise: 'recognising it', distinguish: 'telling it from its look-alike', test: 'the test to do', treat: 'the treatment', trap: 'the trap or exception' };
export function caseMessage(item) {
  const lines = [`Topic: ${item.topic || 'unknown'}`];
  if (item.kind === 'lesson') {
    lines.push('This re-tests a lesson that only partly landed.');
    if (item.weak_spot) lines.push(`Where it broke: ${item.weak_spot}`);
    if (item.missing && item.missing.length) lines.push(`What he left out: ${item.missing.join('; ')}`);
    if (item.goal) lines.push(`The lesson's goal: ${item.goal}`);
  } else {
    if (item.rule) lines.push(`His rule: ${item.rule}`);
    if (item.look_alikes) lines.push(`Look-alike: ${item.look_alikes}`);
    if (item.my_reasoning) lines.push(`What he thought: ${item.my_reasoning}`);
    if (item.error_type) lines.push(`Kind of miss: ${String(item.error_type).replace(/_/g, ' ')}`);
    if (item.confidence) lines.push(`He was ${item.confidence === 'guess' ? 'guessing' : item.confidence} when he got it wrong.`);
  }
  if (item.step && STEP_WORDS[item.step]) lines.push(`The step that broke: ${item.step} (${STEP_WORDS[item.step]}).`);
  if (item.past && item.past.length) lines.push('Earlier re-test cases on this point (write a different one):', ...item.past.map(p => `- ${p}`));
  return lines.join('\n');
}

/** A written case, checked and trimmed (pure); null when it is not a usable card. */
export function cleanCase(data) {
  if (!data || typeof data !== 'object') return null;
  const s = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const questions = (Array.isArray(data.questions) ? data.questions : []).map(s).filter(Boolean).slice(0, 2);
  const out = { stem: s(data.stem), questions, answer: s(data.answer), management: questions.length > 1 ? s(data.management) : '', vs: s(data.vs), why: s(data.why) };
  if (!out.stem || !questions.length || !out.answer || out.stem.split(' ').length > 45) return null;
  return out;
}

const spentKey = (day = londonDay()) => `retest_usd:${day}`;
async function addSpent(env, usd) {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS REAL) + ?2 AS TEXT)`)
    .bind(spentKey(), String(usd)).run();
}

async function writeCase(env, item) {
  const [{ callJson }, { reserveSpend, spendCap }] = await Promise.all([import('../claude.js'), import('../db.js')]);
  const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
  let usd = 0;
  try {
    const r = await callJson(env, { role: 'retester', system: CASE_SYSTEM, schema: CASE_SCHEMA, effort: 'high', maxTokens: 8000,
      messages: [{ role: 'user', content: caseMessage(item) }] });
    usd = r.usd || 0;
    return { case: cleanCase(r.data), usd };
  } catch (e) {
    usd = Number(e && e.usd) || 0;
    throw e;
  } finally {
    await release(0);
    if (usd > 0) await addSpent(env, usd);
  }
}

export const OWN_CARD_SQL = `(coalesce(m.anki_note_ids_json, '[]') NOT IN ('[]', '') OR (m.topic_id IS NOT NULL AND EXISTS (SELECT 1 FROM lessons l2
    WHERE l2.user_id = m.user_id AND l2.topic_id = m.topic_id AND l2.card_id IS NOT NULL AND l2.card_action IN ('added', 'edited_existing'))))`;

const DUE_SQL = `SELECT r.*, m.label, m.rule, m.look_alikes, m.my_reasoning, m.error_type, m.confidence, m.step, m.block_id, m.system_raw,
    coalesce(t.name, m.condition_raw, m.topic_raw, l.topic_name) AS topic, t.yield, l.weak_spot, l.goal, l.teach_back_json, l.final_explain_json,
    (m.confidence = 'sure' AND m.result = 'wrong') AS sure_wrong
  FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id
    LEFT JOIN lessons l ON l.user_id = r.user_id AND l.id = r.lesson_id
    LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = coalesce(m.topic_id, r.topic_id)
  WHERE r.user_id = ?1 AND r.result IS NULL AND r.covered IS NULL AND r.due <= ?2 AND r.card_state IN ('pending', 'written') AND r.card_tries < ?3
    AND (r.kind = 'lesson' OR (m.held = 0 AND m.deleted_at IS NULL AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking'))))
    AND NOT EXISTS (SELECT 1 FROM retests o WHERE o.user_id = r.user_id AND o.id <> r.id AND o.card_id IS NOT NULL
      AND ((r.kind = 'miss' AND o.miss_id = r.miss_id) OR (r.kind = 'lesson' AND o.lesson_id = r.lesson_id)))
  ORDER BY r.card_state = 'written' DESC, sure_wrong DESC, coalesce(t.yield, 0) DESC, r.due DESC LIMIT ?4`;

const OLD_SQL = `SELECT r.id, r.kind, r.card_id, r.due, r.result, r.card_state, (m.confidence = 'sure' AND m.result = 'wrong') AS sure_wrong,
    CASE WHEN r.kind = 'miss' AND m.id IS NOT NULL AND ${OWN_CARD_SQL} THEN 1 ELSE 0 END AS own,
    CASE WHEN r.result IS NOT NULL OR r.card_state = 'done' OR r.covered IS NOT NULL OR (r.kind = 'miss' AND (m.id IS NULL OR m.held = 1 OR m.deleted_at IS NOT NULL
      OR m.error_type IN ('misread', 'test_taking'))) THEN 1 ELSE 0 END AS closed
  FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id
  WHERE r.user_id = ?1 AND r.card_deck = 'retests' AND r.card_id IS NOT NULL
  ORDER BY sure_wrong DESC, r.due LIMIT 80`;

const COVER_SQL = `UPDATE retests SET covered = 'own_card', updated_at = ?2 WHERE user_id = ?1 AND kind = 'miss' AND result IS NULL AND covered IS NULL
    AND card_id IS NULL AND card_state IN ('pending', 'written', 'failed') AND miss_id IN (SELECT m.id FROM misses m WHERE m.user_id = ?1 AND ${OWN_CARD_SQL})`;

// Open rows with no card that waited past EXPIRE_DAYS (?3 is the cut-off day): let go, never carded or counted.
const EXPIRE_SQL = `UPDATE retests SET covered = 'expired', updated_at = ?2 WHERE user_id = ?1 AND result IS NULL AND covered IS NULL
    AND card_id IS NULL AND card_state IN ('pending', 'written', 'failed') AND due < ?3`;

const TODAY_SQL = `SELECT count(*) AS n FROM retests WHERE user_id = ?1 AND card_state = 'made' AND covered IS NULL
    AND ((card_at >= ?2 AND card_moved_at IS NULL) OR card_moved_at >= ?2)`;

/**
 * Today's share of new cards (pure): the old cards to move as they are and the due rows to card, sure-and-wrong first,
 * then the ones ready to go (an old card, or a case already written), then the earliest due. left: how many more today.
 * Returns {move: [old rows], add: [due rows]} within left and CARDS_PER_RUN.
 */
export function pickToday(old, due, left, perRun = CARDS_PER_RUN) {
  const items = [...old.map(r => ({ r, kind: 'move', ready: 1 })), ...due.map(r => ({ r, kind: 'add', ready: r.card_state === 'written' ? 1 : 0 }))];
  items.sort((a, b) => (Number(b.r.sure_wrong) || 0) - (Number(a.r.sure_wrong) || 0) || b.ready - a.ready || String(a.r.due).localeCompare(String(b.r.due)));
  const take = items.slice(0, Math.max(0, Math.min(perRun, left)));
  return { move: take.filter(x => x.kind === 'move').map(x => x.r), add: take.filter(x => x.kind === 'add').map(x => x.r) };
}

export async function retestCards(env, user, { now = nowMs(), write = writeCase } = {}) {
  if (!env.ANKI_MCP_URL) return { skipped: 'Anki is not connected' };
  const today = londonDay(now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let dueRes, oldRes, made, expired;
  try {
    [, expired, dueRes, oldRes, made] = await env.DB.batch([
      q(COVER_SQL, user, nowMs()),
      q(EXPIRE_SQL, user, nowMs(), addDays(today, -EXPIRE_DAYS)),
      q(DUE_SQL, user, today, CARD_TRIES, CARDS_PER_RUN * 4),
      q(OLD_SQL, user),
      q(TODAY_SQL, user, londonDayStart(now)),
    ]);
  } catch (e) { if (noTable(e)) return { skipped: 'not ready' }; throw e; }
  const left = Math.max(0, CARDS_PER_DAY - Number((made.results[0] || {}).n || 0));
  // One card per miss or lesson: two of its rows due together are one card.
  const one = new Set();
  const due = (dueRes.results || []).filter(r => { const k = r.kind === 'lesson' ? `l:${r.lesson_id}` : `m:${r.miss_id}`; if (one.has(k)) return false; one.add(k); return true; });
  const old = oldRes.results || [];
  const quiet = old.filter(r => Number(r.closed) || Number(r.own)).slice(0, QUIET_MOVES_PER_RUN);
  const pick = pickToday(old.filter(r => !Number(r.closed) && !Number(r.own)), due, left);
  const rows = pick.add;
  const letGo = Number(expired && expired.meta && expired.meta.changes) || 0;
  if (!rows.length && !pick.move.length && !quiet.length) {
    if (letGo) await noteJob(env, { job: 'retest_cards', user, key: `${today}:ok`, state: 'ok', add: true, at: now, counts: { expired: letGo } });
    return { made: 0, moved: 0, hidden: 0, expired: letGo };
  }
  const note = (state, counts, detail = null) => noteJob(env, { job: 'retest_cards', user, key: `${today}:${state}`, state, add: state === 'ok', at: now, counts, detail });
  const report = async o => {
    o.expired = letGo;
    if (o.made || o.moved || o.hidden || o.written || o.failed || o.deck_removed || letGo) {
      await note('ok', { made: o.made, moved: o.moved, hidden: o.hidden, written: o.written, unusable: o.failed, ...(o.deck_removed ? { deck_removed: 1 } : {}), ...(letGo ? { expired: letGo } : {}) });
    }
    return o;
  };
  const t = nowMs();
  const stmts = [], out = { written: 0, made: 0, moved: 0, hidden: 0, failed: 0 };
  // Cases: the written ones are sent again as they are; new ones under the day's limit.
  let spent = 0;
  try { spent = Number((await q('SELECT value FROM settings WHERE key = ?1', spentKey(today)).first() || {}).value) || 0; } catch { spent = 0; }
  const waiting = rows.filter(r => r.card_state === 'written').length;
  let budget = Math.max(0, CARDS_PER_RUN - waiting);
  const leakIds = rows.filter(r => r.block_id).map(r => r.miss_id);
  const index = leakIds.length ? await (await import('./guard.js')).leakIndexFor(env, user, { missIds: leakIds }).catch(() => null) : null;
  const { leaks } = await import('../checks.js');
  const { stemSafe, questionSafe } = await import('./guard.js');
  const send = [];
  for (const r of rows) {
    if (r.card_state === 'written') { const c = parse(r.case_json, null); if (c) send.push({ r, c }); continue; }
    if (spent >= RETEST_DAILY_USD && budget > 0) { await note('held', { limit: RETEST_DAILY_USD }); budget = 0; }
    if (budget <= 0 || spent >= RETEST_DAILY_USD) continue;
    budget--;
    const past = (await q(`SELECT case_json FROM retests WHERE user_id = ?1 AND id <> ?2 AND case_json IS NOT NULL AND ((?3 IS NOT NULL AND miss_id = ?3) OR (?4 IS NOT NULL AND lesson_id = ?4))
        ORDER BY created_at DESC LIMIT 3`, user, r.id, r.miss_id, r.lesson_id).all()).results.map(x => (parse(x.case_json, {}) || {}).stem).filter(Boolean);
    const missing = [...((parse(r.teach_back_json, {}) || {}).missing || []), ...((parse(r.final_explain_json, {}) || {}).missing || [])].slice(0, 4);
    const item = { kind: r.kind, topic: r.topic, rule: questionSafe(r.rule), look_alikes: questionSafe(r.look_alikes), my_reasoning: stemSafe(r.my_reasoning),
      error_type: r.error_type, confidence: r.confidence, step: r.step, weak_spot: questionSafe(r.weak_spot), goal: questionSafe(r.goal),
      missing: missing.filter(x => typeof x === 'string' && questionSafe(x)), past };
    let c = null, err = null;
    try {
      const w = await write(env, item);
      spent += w.usd || 0;
      c = w.case;
      // A hub question's card must not share a run of words with that question (the leak guard).
      if (c && r.block_id && (!index || leaks(index, [c.stem, ...c.questions, c.answer, c.management, c.vs, c.why].join(' ')))) { c = null; err = 'the case shared words with the question'; }
      if (!c && !err) err = 'the case came back unusable';
    } catch (e) {
      // Waiting for its Message Batch (claude.js): the next due rows are queued too; the next run finds the cases.
      if (e && e.pending === true && e.batch === true) { await note('held', { batch: 1 }); continue; }
      // Only an answer that cannot be used counts as a try (422: refused, cut off, not JSON); a cap, a missing key or
      // the API being down stops this run and leaves the row as it was for the next.
      if (!(e && e.status === 422)) {
        console.error(JSON.stringify({ retest_case_not_written: { user, id: r.id, error: String((e && e.message) || e).slice(0, 200) } }));
        await note(e && e.status === 429 ? 'held' : 'failed', { writing: 1 }, e);
        budget = 0;
        continue;
      }
      err = String((e && e.message) || e).slice(0, 200);
    }
    if (c) {
      stmts.push(q(`UPDATE retests SET case_json = ?3, card_state = 'written', card_error = NULL, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`, user, r.id, JSON.stringify(c), t));
      send.push({ r, c });
      out.written++;
    } else {
      stmts.push(q(`UPDATE retests SET card_tries = card_tries + 1, card_error = ?3, card_state = CASE WHEN card_tries + 1 >= ?4 THEN 'failed' ELSE card_state END,
          updated_at = ?5 WHERE user_id = ?1 AND id = ?2`, user, r.id, err, CARD_TRIES, t));
      out.failed++;
    }
  }
  if (stmts.length) await env.DB.batch(stmts.splice(0));
  const move = [...pick.move.map(r => ({ card_id: Number(r.card_id) })),
    ...quiet.map(r => ({ card_id: Number(r.card_id), suspend: true, ...(Number(r.own) ? { tag: COVERED_TAG } : {}) }))];
  if (!send.length && !move.length) return report(out);
  let reply;
  try {
    reply = await ankiCall(env, 'retest_cards', {
      add: send.map(({ r, c }) => ({ key: cardKey(r.id), ...c, ...(r.system_raw ? { system: r.system_raw } : {}) })),
      move,
    }, { timeoutMs: CALL_MS });
  } catch (e) {
    // The written cases stay written and go again next run, with the same keys, so no card is ever added twice.
    console.error(JSON.stringify({ retest_cards_failed: { user, add: send.length, move: move.length, error: (e && e.message) || String(e) } }));
    await note('failed', { waiting: send.length + pick.move.length }, e);
    await report(out);   // the cases written this run, if any
    return { ...out, error: (e && e.message) || String(e) };
  }
  const byKey = new Map(((reply && reply.added) || []).filter(a => a && a.key && Number.isSafeInteger(Number(a.card_id))).map(a => [a.key, a]));
  for (const { r } of send) {
    const a = byKey.get(cardKey(r.id));
    if (!a) continue;
    stmts.push(q(`UPDATE retests SET card_state = 'made', card_deck = 'mine', card_id = ?3, note_id = ?4, card_at = ?5, card_error = NULL, updated_at = ?5 WHERE user_id = ?1 AND id = ?2`,
      user, r.id, Number(a.card_id), Number.isSafeInteger(Number(a.note_id)) ? Number(a.note_id) : null, t));
    out.made++;
  }
  const moved = new Set(((reply && reply.moved) || []).map(Number));
  const gone = new Set(((reply && reply.missing) || []).map(Number));
  for (const r of pick.move) {
    if (moved.has(Number(r.card_id))) { stmts.push(q(`UPDATE retests SET card_deck = 'mine', card_moved_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`, user, r.id, t)); out.moved++; }
  }
  for (const r of quiet) {
    if (!moved.has(Number(r.card_id))) continue;
    stmts.push(Number(r.own) && !Number(r.closed)
      ? q(`UPDATE retests SET card_deck = 'mine', card_moved_at = ?3, covered = 'own_card', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`, user, r.id, t)
      : q(`UPDATE retests SET card_deck = 'mine', card_moved_at = ?3, card_state = 'done', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`, user, r.id, t));
    out.hidden++;
  }
  // A card deleted in Anki: nothing to move; the row stops waiting for it.
  for (const r of [...pick.move, ...quiet]) {
    if (gone.has(Number(r.card_id))) stmts.push(q(`UPDATE retests SET card_deck = NULL, card_state = 'done', card_error = 'card deleted in Anki', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`, user, r.id, t));
  }
  if (reply && reply.deck_removed) out.deck_removed = true;
  if (stmts.length) await env.DB.batch(stmts);
  return report(out);
}

// ---------------------------------------------------------------- Finish review not run (audit 1d)

// Hub sittings with misses that never reached the Anki log: no debrief was queued for them (Finish review not run), so
// they have no Anki copy, card or log entry. ?1 user. [{sitting_id, name, day, misses}], newest first.
export const UNLOGGED_SQL = `SELECT m.sitting_id, s.name, max(m.day) AS day, count(*) AS misses FROM misses m JOIN sittings s ON s.id = m.sitting_id
    WHERE m.user_id = ?1 AND m.source = 'hub' AND m.held = 0 AND m.deleted_at IS NULL AND m.anki_mistake_id IS NULL
      AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking'))
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind = 'debrief' AND o.idem_key LIKE 'debrief:' || m.sitting_id || ':%')
    GROUP BY m.sitting_id ORDER BY day DESC LIMIT 5`;
export const DUE_COUNT_SQL = `SELECT count(DISTINCT coalesce(r.miss_id, r.lesson_id)) AS n, min(r.due) AS oldest,
      count(DISTINCT CASE WHEN r.card_state = 'made' THEN coalesce(r.miss_id, r.lesson_id) END) AS cards
    FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id
    WHERE r.user_id = ?1 AND r.result IS NULL AND r.covered IS NULL AND r.due <= ?2 AND (r.kind = 'lesson'
      OR (m.held = 0 AND m.deleted_at IS NULL AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking'))))`;
export const unloggedWords = list => (list || []).map(r => ({ sitting: r.name, sitting_id: r.sitting_id, day: r.day, misses: Number(r.misses) || 0 }));
