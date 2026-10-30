import { json, londonDay } from '../util.js';
import { leaks } from '../checks.js';
import { leakIndexFor, gapSafe, stemSafe, questionSafe } from './guard.js';
import { rankTopicsFor, whyLine, daysLeft, phaseFor, EXAM_DAY, laneOf, yieldOf, NO_LESSON_ERRORS, addDays } from './teach-priority.js';
import { pullNewIfStale } from './sync.js';
import { topPairs } from './links-store.js';
import { lookAlikeHead } from './links.js';
import { UNIT_SUMMARY_SQL, summaryFromSql } from './weakness.js';
import { londonStamp } from '../mcp/reply.js';
import { DUE_COUNT_SQL, UNLOGGED_SQL, unloggedWords, RETEST_DECK } from './retests.js';
import { overconfident } from './calibration.js';
import { newPatternLine, profileShort, habitTopics, HABIT_BOOST } from './habits.js';

const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
export const SEEN_WINDOW_MS = 30 * 60_000;
export const LINE_MAX = 160, SAY_MAX = 250;
export const OVERVIEW_LISTS = { next_up: 5, requested: 5, gaps_stated: 5, lines: 5 };
// Event kinds that make a since_last line, most telling first; anything else is only counted.
const LINE_KINDS = ['sitting.released', 'miss.added', 'lesson.saved', 'gap.added', 'topic.added', 'link.added', 'queue.resolved', 'checklist.ticked',
  'teach_memory.saved', 'request.added'];
const QUIET_KINDS = ['score.changed', 'scores.refreshed', 'evidence.added', 'evidence.removed', 'sync.status', 'map.resync', 'lesson.started', 'positions.changed',
  'search.indexed'];   // the history search's index status lines (hub_history)
const LANE_RANK = { A: 3, B: 2, C: 1, off: 0 };

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const t1000Of = t => (t == null ? null : Math.round(Number(t) * 1000));
const seenKey = user => (user === 'mo' ? 'mcp_seen' : `mcp_seen:${user}`);

/**
 * Runs statements as one D1 batch; when a table is missing (a database before 0010, or an area not landed),
 * each runs on its own and a failing one gives no rows, so one missing table never blanks the rest.
 */
async function batchSoft(env, stmts) {
  try {
    return (await env.DB.batch(stmts)).map(r => r.results || []);
  } catch (e) {
    if (!noTable(e)) throw e;
    return Promise.all(stmts.map(s => s.all().then(r => r.results || [], err => { if (!noTable(err)) throw err; return []; })));
  }
}

// ---------------------------------------------------------------- since_last lines (pure)

/** since_last lines from grouped events [{kind, n, summary}], most telling first, at most 5 of 160 characters. */
export function sinceLines(groups) {
  const by = new Map(groups.map(g => [g.kind, g]));
  const out = [];
  for (const kind of LINE_KINDS) {
    const g = by.get(kind);
    if (!g || !g.n) continue;
    const s = g.summary ? String(g.summary) : '';
    let line;
    if (kind === 'sitting.released') line = s || `${plural(g.n, 'sitting')} released to the map`;
    else if (kind === 'miss.added') line = `${plural(g.n, 'miss', 'misses')} logged${s ? ` (latest: ${s})` : ''}`;
    else if (kind === 'lesson.saved') line = g.n === 1 && s ? s : `${plural(g.n, 'lesson')} saved${s ? `; last: ${s}` : ''}`;
    else if (kind === 'gap.added') line = `${plural(g.n, 'gap')} logged${s ? ` (latest: ${s})` : ''}`;
    else if (kind === 'topic.added') line = `${plural(g.n, 'new topic')}${s ? ` (${s})` : ''}`;
    else if (kind === 'link.added') line = `${plural(g.n, 'link')} added${s ? ` (${s})` : ''}`;
    else if (kind === 'queue.resolved') line = `${plural(g.n, 'unplaced item')} placed on the map`;
    else if (kind === 'checklist.ticked') line = `${plural(g.n, 'checklist tick')}${s ? ` (${s})` : ''}`;
    else if (kind === 'teach_memory.saved') line = `${plural(g.n, 'teaching note')} saved`;
    else line = s || `${g.n} × ${kind}`;
    out.push(cap(line, LINE_MAX));
    if (out.length >= OVERVIEW_LISTS.lines) break;
  }
  return out;
}

/** The voice line: days left, what changed, then the tap or the next pick (at most 250 characters). */
export function overviewSay({ days_left, lines, requested, next_up, gaps, unlogged }) {
  const bits = [`${days_left} days to go.`];
  if (lines && lines.length) bits.push(`Since last time: ${lines.slice(0, 2).join('; ')}.`);
  if (gaps && gaps.length) bits.push(`You logged ${plural(gaps.length, 'gap')}${gaps[0].topic ? `, the latest on ${gaps[0].topic}` : ''}.`);
  if (unlogged && unlogged.length) bits.push(`Finish review not run for ${unlogged[0].sitting}.`);
  if (requested && requested.length) bits.push(`You tapped Teach me on ${requested[0].topic}; want that first?`);
  else if (next_up && next_up.length) bits.push(`Next up: ${next_up[0].name}.`);
  let say = bits.join(' ');
  while (say.length > SAY_MAX && bits.length > 2) { bits.splice(1, 1); say = bits.join(' '); }
  return cap(say, SAY_MAX);
}

// ---------------------------------------------------------------- map_overview

export async function overview(env, user, { voice = false, now = Date.now(), ctx = null, touch = true } = {}) {
  const today = londonDay(now);
  const pull = await pullNewIfStale(env, user, { maxMs: 1500, ctx }).catch(e => ({ ran: false, ok: false, error: e && e.message }));
  const key = seenKey(user);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const markerSeq = `coalesce((SELECT CAST(json_extract(value, '$.seq') AS INTEGER) FROM settings WHERE key = ?), 0)`;
  const [rank, rows] = await Promise.all([
    rankTopicsFor(env, user, { now, today }).catch(e => { console.error('overview ranking failed', e && e.message); return { ok: false }; }),
    batchSoft(env, [
      q('SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?', user),
      q('SELECT value FROM settings WHERE key = ?', key),
      q(`WITH since AS (SELECT seq, kind, summary FROM map_events WHERE user_id = ? AND seq > ${markerSeq} AND at >= ? AND undone_by IS NULL AND undo_of IS NULL
           ORDER BY seq DESC LIMIT 500)
         SELECT kind, count(*) AS n, max(seq) AS last, (SELECT x.summary FROM since x WHERE x.kind = since.kind ORDER BY x.seq DESC LIMIT 1) AS summary
         FROM since GROUP BY kind`, user, key, now - 14 * DAY_MS),
      q(`SELECT g.id, g.day, g.source, g.gap, g.said, coalesce(t.name, g.topic) AS topic, g.topic_id FROM gaps g
           LEFT JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id
         WHERE g.user_id = ? AND g.origin = 'stated' AND g.held = 0
           AND g.at >= max(?, coalesce((SELECT CAST(json_extract(value, '$.at') AS INTEGER) FROM settings WHERE key = ?), 0))
         ORDER BY g.at DESC LIMIT ?`, user, now - 7 * DAY_MS, key, OVERVIEW_LISTS.gaps_stated),
      q(`SELECT l.id, l.topic_id, coalesce(t.name, l.topic_name) AS topic, l.kind, l.requested_at FROM lessons l
           LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         WHERE l.user_id = ? AND l.status = 'requested' AND l.requested_at >= ?
           AND NOT EXISTS (SELECT 1 FROM lessons o WHERE o.user_id = l.user_id AND o.id != l.id AND o.topic_id = l.topic_id
             AND coalesce(o.pair_topic_id, '') = coalesce(l.pair_topic_id, '') AND o.status IN ('in_progress', 'done') AND o.started_at > l.requested_at)
         ORDER BY l.requested_at LIMIT ?`, user, now - 24 * HOUR_MS, OVERVIEW_LISTS.requested),
      // Re-tests from the hub's own table (0036): misses' and lessons'.
      q(DUE_COUNT_SQL, user, today),
      q(`SELECT coalesce(t.name, l.topic_name) AS topic, l.day, l.kind, l.outcome, l.minutes, l.card_action FROM lessons l
           LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         WHERE l.user_id = ? AND l.status = 'done' ORDER BY l.ended_at DESC LIMIT 1`, user),
      q(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' GROUP BY kind`, user),
      q(`SELECT count(*) AS topics, coalesce(sum(s.seen), 0) AS seen, coalesce(sum(s.band = 'very_weak'), 0) AS very_weak, coalesce(sum(s.band = 'weak'), 0) AS weak
         FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id WHERE t.user_id = ? AND t.status IN ('proposed', 'confirmed')`, user),
      q(`SELECT c.name, avg(s.t) AS t FROM topic_scores s JOIN categories c ON c.user_id = s.user_id AND c.id = s.category_id
         WHERE s.user_id = ? AND s.seen = 1 AND s.t IS NOT NULL GROUP BY s.category_id HAVING count(*) >= 2 ORDER BY avg(s.t) DESC LIMIT 3`, user),
      q(`SELECT last_ok_at, last_error, fails FROM sync_state WHERE user_id = ? AND source = 'anki.new'`, user),
      q(UNLOGGED_SQL, user),
      q(`SELECT trap, status, n, topics_n, last_seen, examples_json, systems_json, note, active_at FROM habits WHERE user_id = ? AND status = 'active'
         ORDER BY active_at DESC LIMIT 1`, user),
      q('SELECT text, facts_json FROM learner_profile WHERE user_id = ?', user),
    ]),
  ]);
  const [[seqRow], [markerRow], groups, gaps, requested, [retests], [lastLesson], queueRows, [totals], weakCats, [sync], unlogged, [newHabit], [profile]] = rows;
  const seq = (seqRow && seqRow.seq) || 0;
  const marker = markerRow ? parse(markerRow.value, null) : null;
  const d = daysLeft(today);
  const phase = phaseFor(d);
  const lines = sinceLines(groups.filter(g => !QUIET_KINDS.includes(g.kind)));
  const events = groups.reduce((a, g) => a + (QUIET_KINDS.includes(g.kind) ? 0 : g.n), 0);
  const next_up = rank && rank.ok ? rank.ranked.slice(0, OVERVIEW_LISTS.next_up).map(r => ({
    id: r.topic_id, name: r.name, lane: r.lane, band: r.band || 'unseen', t1000: r.seen ? t1000Of(r.t) : null, why: cap(whyLine(r, 'pick'), LINE_MAX),
  })) : [];
  const by_kind = Object.fromEntries(queueRows.map(r => [r.kind, r.n]));
  const open = Object.values(by_kind).reduce((a, b) => a + b, 0);
  // Stored text is checked on the way out too (a cue saved before the guard, a said that reads like question text).
  const gapsOut = gaps.map(gapSafe).map(g => ({ id: g.id, day: g.day, gap: cap(g.gap, 200), ...(g.said ? { said: cap(g.said, 200) } : {}), topic: g.topic || null, topic_id: g.topic_id || null }));
  const requestedOut = requested.map(r => ({ lesson_id: r.id, topic_id: r.topic_id, topic: r.topic, kind: r.kind, tapped: londonStamp(r.requested_at) }));
  const out = {
    as_of_seq: seq, as_of: londonStamp(now),
    fresh: { anki_pulled_s_ago: sync && sync.last_ok_at ? Math.max(0, Math.round((now - sync.last_ok_at) / 1000)) : null, anki_ok: !(sync && sync.fails > 0) && !(pull && pull.ran && !pull.ok),
      ...(sync && sync.fails > 0 && sync.last_error ? { anki_error: cap(sync.last_error, 160) } : {}) },
    exam: { date: EXAM_DAY, days_left: d, phase: phase ? phase.name : null },
    since_last: { last_seen: marker && marker.at ? londonStamp(marker.at) : null, events, lines },
    gaps_stated: gapsOut,
    requested: requestedOut,
    next_up,
    // cards: how many of them are already cards in Anki's re-test deck (each card's rating records the result).
    due: { retests: (retests && retests.n) || 0, oldest: (retests && retests.oldest) || null, ...(retests && retests.cards ? { cards: retests.cards, deck: RETEST_DECK } : {}) },
    ...(unlogged && unlogged.length ? { finish_review_not_run: unloggedWords(unlogged) } : {}),
    last_lesson: lastLesson ? { topic: lastLesson.topic, day: lastLesson.day, kind: lastLesson.kind, outcome: lastLesson.outcome, minutes: lastLesson.minutes,
      card: lastLesson.card_action || null } : null,
    queue: { open, by_kind, ...(open ? { next_step: 'Place them now, before anything else and without asking Mo: map_queue then map_resolve (25 at a time; an existing topic when one fits, else new_topic).' } : {}) },
    map: { topics: (totals && totals.topics) || 0, seen: (totals && totals.seen) || 0, very_weak: (totals && totals.very_weak) || 0, weak: (totals && totals.weak) || 0,
      weakest_categories: weakCats.map(c => c.name) },
  };
  const over = await overconfident(env, user, { today }).catch(e => { console.error('overconfident failed', e && e.message); return null; });
  if (over) out.map.overconfident = over;
  const fresh = newPatternLine(newHabit, { since: marker && marker.at, now });
  if (fresh) out.new_pattern = fresh;
  if (profile && profile.text) out.profile = profile.text;
  if (!(rank && rank.ok) && !out.map.topics) out.next_step = 'The map is not set up yet: use list_gaps and the Anki connector as before.';
  if (voice) {
    delete out.map; delete out.fresh;
    // By voice the profile is its one short line (the top habit, the overconfident system).
    if (out.profile) { const short = profileShort(parse(profile.facts_json, {})); if (short) out.profile = short; else delete out.profile; }
    out.say = overviewSay({ days_left: d, lines, requested: requestedOut, next_up, gaps: gapsOut, unlogged: out.finish_review_not_run });
  }
  if (touch) await touchSeen(env, user, seq, now, ctx);
  return out;
}

// mcp_seen {seq, at}: stored unless it was stored in the last 30 minutes (teach_next keeps the same rule).
async function touchSeen(env, user, seq, now, ctx) {
  const p = env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value
      WHERE coalesce(json_extract(settings.value, '$.at'), 0) < ?3`).bind(seenKey(user), JSON.stringify({ seq, at: now }), now - SEEN_WINDOW_MS).run()
    .catch(e => console.error('mcp_seen not stored', e && e.message));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
}

// GET /api/map/overview?voice=1: the same reply for the hub's own pages; it never moves Claude's marker.
export async function overviewRoute(request, env, ctx, params, url, user) {
  return json(await overview(env, user, { voice: url.searchParams.get('voice') === '1', ctx, touch: false }));
}

// ---------------------------------------------------------------- hub_changes

const NOT_SUMMARY = `('score.changed', 'scores.refreshed', 'evidence.added', 'evidence.removed', 'sync.status')`;
export const CHANGES_SCAN = 3000;

/**
 * hub_changes: one row per change batch, newest first: {latest_seq, changes[{seq, at, actor, surface, kind,
 * summary, batch_id, undoable, undone, events}], more}. Batches holding only score refreshes are left out unless
 * kinds asks for them. kinds: exact kinds or prefixes ending in '.' ('lesson.').
 */
export async function changesByBatch(env, user, { since_seq = null, actor = null, kinds = null, limit = 15, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(30, Number(limit) || 15));
  const who = actor && actor !== 'any' ? actor : null;
  const kindList = Array.isArray(kinds) && kinds.length ? kinds.slice(0, 10).map(String) : null;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let rows, latest;
  try {
    [[latest], rows] = await batchSoft(env, [
      q('SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?', user),
      q(`SELECT e.batch_id, min(e.seq) AS seq, max(e.at) AS at, min(e.actor) AS actor, min(e.surface) AS surface, count(*) AS events,
           max(e.undoable) AS undoable, max(e.undone_by IS NOT NULL) AS undone,
           (SELECT e2.kind FROM map_events e2 WHERE e2.user_id = e.user_id AND e2.batch_id = e.batch_id AND e2.kind NOT IN ${NOT_SUMMARY} ORDER BY e2.seq LIMIT 1) AS kind,
           (SELECT e2.summary FROM map_events e2 WHERE e2.user_id = e.user_id AND e2.batch_id = e.batch_id AND e2.kind NOT IN ${NOT_SUMMARY} ORDER BY e2.seq LIMIT 1) AS summary,
           min(e.kind) AS any_kind, min(e.summary) AS any_summary
         FROM map_events e
         WHERE e.user_id = ? AND e.seq > max(?, (SELECT coalesce(max(seq), 0) FROM map_events WHERE user_id = ?) - ${CHANGES_SCAN})
           AND (? IS NULL OR e.actor = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) j WHERE e.kind = j.value OR (substr(j.value, -1) = '.' AND substr(e.kind, 1, length(j.value)) = j.value)))
         GROUP BY e.batch_id ORDER BY seq DESC LIMIT ?`,
      user, Number.isInteger(since_seq) ? since_seq : 0, user, who, who, kindList ? 1 : null, kindList ? JSON.stringify(kindList) : '[]', 200),
    ]);
  } catch (e) {
    if (noTable(e)) return { latest_seq: 0, changes: [] };
    throw e;
  }
  const shown = rows.filter(r => r.kind || kindList).map(r => ({
    seq: r.seq, at: londonStamp(r.at), actor: r.actor, surface: r.surface || null, kind: r.kind || r.any_kind, summary: cap(r.summary || r.any_summary, LINE_MAX),
    batch_id: r.batch_id, undoable: !!r.undoable, undone: !!r.undone, events: r.events,
  }));
  const out = { as_of_seq: (latest && latest.seq) || 0, latest_seq: (latest && latest.seq) || 0, changes: shown.slice(0, n) };
  if (shown.length > n) out.more = { left: shown.length - n, call: `hub_changes {since_seq: ${shown[n - 1].seq - 1}}` };
  return out;
}

// ---------------------------------------------------------------- map_weakest

export const PURPOSES = ['lesson', 'cards', 'retest', 'pairs', 'review'];
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const laneFor = row => (row.topic_id ? laneOf(yieldOf({ yield: row.yield })) : 'off');
const keepLane = (lane, want) => !want || lane === want;

const sureWrong = r => (r.confidence === 'sure' && r.result === 'wrong' ? 1 : 0);
export function rankCardRows(rows) {
  return rows.map(r => ({ ...r, lane: laneFor(r) })).sort((a, b) => (LANE_RANK[b.lane] - LANE_RANK[a.lane])
    || ((Number(b.yield) || 0) - (Number(a.yield) || 0))
    || (sureWrong(b) - sureWrong(a))
    || ((b.topic_misses || 0) - (a.topic_misses || 0))
    || ((b.slow || 0) - (a.slow || 0)) || (b.at - a.at));
}

/** map_weakest, by purpose. Returns {purpose, rows, ...}; rows never carry a misread or test-taking slip for cards and re-tests. */
export async function weakest(env, user, args = {}) {
  const purpose = args.purpose || 'lesson';
  if (!PURPOSES.includes(purpose)) return { refused: true, reason: `purpose is one of ${PURPOSES.join(', ')}.` };
  const limit = Math.max(1, Math.min(15, Number(args.limit) || (purpose === 'cards' ? 15 : 10)));
  const now = args.now || Date.now();
  const today = londonDay(now);
  const cat = args.category_id || null;
  const lane = args.lane || null;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);

  if (purpose === 'lesson') {
    const data = await rankTopicsFor(env, user, { now, today });
    if (!data.ok) return { purpose, rows: [], next_step: 'The map is not set up yet.' };
    // A topic where an active reasoning habit recurs (the pattern review) is lifted by HABIT_BOOST: a nudge between
    // close topics, never a change to the evidence or the scores.
    const habitAt = await habitTopics(env, user, { now }).catch(() => new Map());
    const lifted = r => r.gain * (habitAt.has(r.topic_id) ? HABIT_BOOST : 1);
    const rows = data.ranked.filter(r => (!cat || r.category_id === cat) && keepLane(r.lane, lane))
      .map((r, i) => ({ r, i, g: lifted(r) })).sort((a, b) => (habitAt.size ? b.g - a.g : 0) || a.i - b.i).slice(0, limit).map(({ r }) => ({
        id: r.topic_id, name: r.name, category: r.category || r.category_id, lane: r.lane, band: r.band || 'unseen', t1000: r.seen ? t1000Of(r.t) : null,
        seen: !!r.seen, gain: Math.round(r.gain * 1000) / 1000, why: cap(whyLine(r, 'pick'), LINE_MAX),
        ...(habitAt.has(r.topic_id) ? { habit: habitAt.get(r.topic_id) } : {}),
      }));
    return { purpose, phase: data.phase && data.phase.name, rows, ...(args.voice ? { say: cap(rows.length ? `Weakest for teaching: ${rows.slice(0, 3).map(r => r.name).join(', ')}.` : 'Nothing needs a lesson right now.', SAY_MAX) } : {}) };
  }

  if (purpose === 'cards') {
    const sinceId = Number.isInteger(args.since_anki_id) ? args.since_anki_id : null;
    const sinceDay = isDay(args.since_day) ? args.since_day : sinceId == null ? addDays(today, -1) : null;
    const [rows] = await batchSoft(env, [q(`SELECT m.id, m.label, m.day, m.at, m.anki_mistake_id, m.error_type, m.confidence, m.result, m.time_s, m.slow, m.look_alikes, m.rule, m.uw_qid, m.step,
        m.anki_note_ids_json, m.topic_id, m.topic_raw, t.name AS topic, t.yield, coalesce(t.category_id, m.category_id) AS category_id, u.mehlman_rank,
        (SELECT count(*) FROM misses m2 WHERE m2.user_id = m.user_id AND m2.topic_id = m.topic_id AND m2.held = 0 AND m2.deleted_at IS NULL AND m2.at >= ?) AS topic_misses
      FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
      WHERE m.user_id = ? AND m.held = 0 AND m.deleted_at IS NULL AND (? IS NULL OR m.anki_mistake_id > ?
          OR (m.anki_mistake_id IS NULL AND m.source = 'uworld' AND m.at >= ? AND m.at >= coalesce((SELECT max(x.at) FROM misses x WHERE x.user_id = m.user_id AND x.anki_mistake_id = ?), 0)))
        AND (? IS NULL OR m.day >= ?)
      ORDER BY m.at DESC LIMIT 300`, now - 14 * DAY_MS, user, sinceId, sinceId, now - 7 * DAY_MS, sinceId, sinceDay, sinceDay)]);
    const slips = rows.filter(r => NO_LESSON_ERRORS.includes(r.error_type)).length;
    const ranked = rankCardRows(rows.filter(r => !NO_LESSON_ERRORS.includes(r.error_type) && (!cat || r.category_id === cat))).filter(r => keepLane(r.lane, lane));
    return {
      purpose, since: sinceId != null ? { anki_id: sinceId } : { day: sinceDay }, total: ranked.length, slips_left_out: slips,
      rows: ranked.slice(0, limit).map(r => ({ miss_id: r.id, label: r.label, day: r.day, topic: r.topic || r.topic_raw || null, topic_id: r.topic_id || null, lane: r.lane,
        yield: r.topic_id && r.yield != null ? Math.round(Number(r.yield) * 100) / 100 : null, mehlman_rank: r.mehlman_rank ?? null,
        error_type: r.error_type, confidence: r.confidence, result: r.result, time_s: r.time_s, slow: !!r.slow, repeats: r.topic_misses || 0,
        has_card: parse(r.anki_note_ids_json, []).length > 0, look_alike_head: lookAlikeHead(r.look_alikes), ...(r.step ? { step: r.step } : {}),
        ...(r.anki_mistake_id == null ? { logged: false, uw_qid: r.uw_qid || null, rule: cap(r.rule, 300) } : {}) })),
      next_step: 'Take the full fields from mistake_sources (Anki connector); rows with logged false are not in the Anki log: use their rule, or teach_debrief {uworld_id, peek: true} for the pack. step is what broke: recognise asks the diagnosis, distinguish puts the look-alike in the Versus line, test and treat ask the next step, trap asks the exception. Then suggest at most 15 cards; add only the ones Mo keeps.',
    };
  }

  if (purpose === 'retest') {
    // The hub's re-tests (0036): misses' and lessons', one per miss or lesson (its earliest due).
    const [list] = await batchSoft(env, [
      q(`SELECT r.id AS retest_id, r.kind, r.due, r.card_state, r.lesson_id, m.id, m.anki_mistake_id, m.block_id, m.rule, m.look_alikes, m.my_reasoning,
           coalesce(t.name, l.topic_name) AS topic, t.id AS topic_id, t.yield, coalesce(t.category_id, m.category_id) AS category_id, s.weakness_raw
         FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id LEFT JOIN lessons l ON l.user_id = r.user_id AND l.id = r.lesson_id
           LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = coalesce(m.topic_id, r.topic_id) LEFT JOIN topic_scores s ON s.user_id = r.user_id AND s.topic_id = t.id
         WHERE r.user_id = ? AND r.result IS NULL AND r.due <= ? AND (r.kind = 'lesson' OR (m.held = 0 AND m.deleted_at IS NULL
           AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking')))) ORDER BY r.due LIMIT 300`, user, isDay(args.since_day) ? args.since_day : today),
    ]);
    const seen = new Set();
    const misses = list.filter(r => { const k = r.kind === 'lesson' ? `lesson:${r.lesson_id}` : r.id; if (seen.has(k)) return false; seen.add(k); return true; });
    const gain = r => (Number(r.yield) || 0.05) * (r.weakness_raw != null ? Number(r.weakness_raw) : 0.5);
    const index = misses.some(m => m.block_id) ? await leakIndexFor(env, user, { missIds: misses.filter(m => m.block_id).map(m => m.id) }).catch(() => null) : null;
    const SHAPE = { rule: questionSafe, look_alikes: questionSafe, my_reasoning: stemSafe };
    const safe = (m, k) => { const v = SHAPE[k](m[k]) ? cap(m[k], 200) : null; return v && m.block_id && (!index || leaks(index, v)) ? null : v; };
    const items = [
      ...misses.filter(m => (!cat || m.category_id === cat) && keepLane(laneFor(m), lane)).map(m => ({ kind: 'retest',
        ref: m.kind === 'lesson' ? `lesson:${m.lesson_id}` : m.anki_mistake_id ? `anki:${m.anki_mistake_id}` : m.id, topic: m.topic,
        topic_id: m.topic_id, rule: safe(m, 'rule'), look_alikes: safe(m, 'look_alikes'), my_reasoning: safe(m, 'my_reasoning'), due: m.due,
        ...(m.card_state === 'made' ? { card: true } : {}), _g: gain(m) })),
    ].sort((a, b) => b._g - a._g || String(a.due).localeCompare(String(b.due)));
    const rows = items.slice(0, args.voice ? Math.min(limit, 3) : limit).map(({ _g, ...r }) => r);
    return { purpose, due: items.length, rows,
      next_step: `Rows with card true are cards in Anki's "${RETEST_DECK}" deck now; their rating records the result. For one you ask yourself, write a fresh case; record an anki: ref with the Anki connector's update_mistake (the hub reads it back).`,
      ...(args.voice ? { say: cap(rows.length ? `${plural(items.length, 're-test')} due. First: ${rows.map(r => r.topic).filter(Boolean).slice(0, 3).join(', ')}.` : 'No re-tests are due.', SAY_MAX) } : {}) };
  }

  if (purpose === 'pairs') {
    const rows = (await topPairs(env, user, limit)).map(p => ({ link_id: p.link_id, a: p.a, b: p.b, confusion: p.confusion, mixed_up: p.mixed_up, confused_n: p.confused_n, last_confused_day: p.last_confused_day,
        took_for: p.took_for, vs_a: cap(p.vs_a, 240), vs_b: cap(p.vs_b, 240) }));
    return { purpose, rows, next_step: 'For "test me on this pair": teach_next {mode: "pair_test", topic: a, pair: b}.' };
  }

  // review: the weakest units with at least one seen topic.
  const [units] = await batchSoft(env, [q(`WITH ${UNIT_SUMMARY_SQL}
      SELECT us.*, u.num, u.name, u.lane, u.mehlman_rank, u.category_id FROM unit_summary us JOIN units u ON u.user_id = ?1 AND u.id = us.unit_id`, user)]);
  const rows = units.map(u => ({ u, s: summaryFromSql(u) })).filter(({ u, s }) => s.n_seen > 0 && (!cat || u.category_id === cat) && keepLane(u.lane, lane))
    .sort((a, b) => (b.s.t1000 ?? -1) - (a.s.t1000 ?? -1)).slice(0, limit)
    .map(({ u, s }) => ({ unit_id: u.unit_id, num: u.num, name: u.name, lane: u.lane, mehlman_rank: u.mehlman_rank, band: s.band, t1000: s.t1000,
      topics: s.n_topics, seen: s.n_seen, weak: s.n_weak, very_weak: s.n_very_weak }));
  return { purpose, rows, next_step: 'board_tallies and board_checklist show each unit on the Review page.' };
}
