import { rootCausesLine } from './concepts.js';
import { clustersOverviewLine } from './clusters.js';
import { overnightBrief } from './snapshots.js';
import { json, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { leaks } from '../checks.js';
import { leakIndexFor, gapSafe, stemSafe, questionSafe } from './guard.js';
import { nextUpFor, nextUp, itemName, whyLine, daysLeft, phaseFor, laneOf, yieldOf, NO_LESSON_ERRORS, addDays, LIVE_CAND_SQL } from './teach-priority.js';
import { examDayOf, EXAM_DATE_SQL } from '../exam-day.js';
import { liveMap, liveSummaries, weakestCategories, loadLive } from './live.js';
import { pullNewIfStale } from './sync.js';
import { topPairs } from './links-store.js';
import { lookAlikeHead } from './links.js';
import { UNIT_SUMMARY_SQL, summaryFromSql } from './weakness.js';
import { londonStamp } from '../mcp/reply.js';
import { UNLOGGED_SQL, unloggedWords, MY_DECK } from './retests.js';
import { overconfident } from './calibration.js';
import { honestyLineStored } from './honesty.js';
import { auditSummary } from './viva.js';
import { integrityLineStored } from './integrity.js';
import { storedProfile, profileLines } from './facets.js';
import { newPatternLine, profileShort, habitTopics } from './habits.js';
import { forecastStored } from '../forecast/data.js';
import { planFactor } from '../forecast/teach-factor.js';
import { CARDS } from '../forecast/constants.js';

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

/** The voice line: days left (none with no exam ahead), what changed, then the tap or the next pick (at most 250 characters). */
export function overviewSay({ days_left, lines, requested, next_up, gaps, unlogged }) {
  const bits = days_left > 0 ? [`${days_left} days to go.`] : days_left === 0 ? ['Exam day.'] : [];
  const head = bits.length;
  if (lines && lines.length) bits.push(`Since last time: ${lines.slice(0, 2).join('; ')}.`);
  if (gaps && gaps.length) bits.push(`You logged ${plural(gaps.length, 'gap')}${gaps[0].topic ? `, the latest on ${gaps[0].topic}` : ''}.`);
  if (unlogged && unlogged.length) bits.push(`Finish review not run for ${unlogged[0].sitting}.`);
  if (requested && requested.length) bits.push(`You tapped Teach me on ${requested[0].topic}; want that first?`);
  else if (next_up && next_up.length) bits.push(`Next up: ${next_up[0].kind === 'pair_test' ? `a pair test, ${next_up[0].name} against ${next_up[0].pair_with}` : next_up[0].name}.`);
  let say = bits.join(' ');
  while (say.length > SAY_MAX && bits.length > head + 1) { bits.splice(head, 1); say = bits.join(' '); }
  return cap(say, SAY_MAX);
}

// ---------------------------------------------------------------- map_overview

export async function overview(env, user, { voice = false, now = Date.now(), ctx = null, touch = true, note = null } = {}) {
  const today = londonDay(now);
  const noted = note != null ? await noteNightly(env, user, note, now) : null;
  const pull = await pullNewIfStale(env, user, { maxMs: 1500, ctx }).catch(e => ({ ran: false, ok: false, error: e && e.message }));
  const key = seenKey(user);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const markerSeq = `coalesce((SELECT CAST(json_extract(value, '$.seq') AS INTEGER) FROM settings WHERE key = ?), 0)`;
  const [rank, rows] = await Promise.all([
    // One list of what to do next (1 Nov 2026): next_up is nextUp's, the same as Home, teach_next and the forecast sheet.
    nextUpFor(env, user, { now, today, limit: OVERVIEW_LISTS.next_up }).then(r => r.data).catch(e => { console.error('overview ranking failed', e && e.message); return { ok: false }; }),
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
      q(`SELECT coalesce(t.name, l.topic_name) AS topic, l.day, l.kind, l.outcome, l.minutes, l.card_action FROM lessons l
           LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         WHERE l.user_id = ? AND l.status = 'done' ORDER BY l.ended_at DESC LIMIT 1`, user),
      q(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' AND kind != 'card_fix' GROUP BY kind`, user),   // cards to fix are the nightly session's, not places
      q(`SELECT count(*) AS topics, coalesce(sum(s.seen), 0) AS seen, coalesce(sum(s.band = 'very_weak'), 0) AS very_weak, coalesce(sum(s.band = 'weak'), 0) AS weak
         FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id WHERE t.user_id = ? AND t.status IN ('proposed', 'confirmed')`, user),
      q(`SELECT c.name, avg(s.t) AS t FROM topic_scores s JOIN categories c ON c.user_id = s.user_id AND c.id = s.category_id
         WHERE s.user_id = ? AND s.seen = 1 AND s.t IS NOT NULL GROUP BY s.category_id HAVING count(*) >= 2 ORDER BY avg(s.t) DESC LIMIT 3`, user),
      q(`SELECT last_ok_at, last_error, fails FROM sync_state WHERE user_id = ? AND source = 'anki.new'`, user),
      q(UNLOGGED_SQL, user),
      q(`SELECT trap, status, n, topics_n, last_seen, examples_json, systems_json, note, active_at FROM habits WHERE user_id = ? AND status = 'active'
         ORDER BY active_at DESC LIMIT 1`, user),
      q('SELECT text, facts_json FROM learner_profile WHERE user_id = ?', user),
      // The colours as of now (live.js, 1 Nov 2026): the weak counts and the weakest systems read the fade on the spot.
      q(LIVE_CAND_SQL, user),
      q('SELECT id, name FROM categories WHERE user_id = ?', user),
      // The exam date (exam-day.js): the setting, or the profile's when there is no row; cleared means no exam.
      q(EXAM_DATE_SQL),
    ]),
  ]);
  const [[seqRow], [markerRow], groups, gaps, requested, [lastLesson], queueRows, [totals0], weakCats0, [sync], unlogged, [newHabit], [profile], liveRows, catRows, examRows] = rows;
  const live = liveMap(liveRows, now);
  const totals = liveRows.length ? { ...(totals0 || {}), ...bandCounts(live) } : totals0;
  const catName = new Map(catRows.map(c => [c.id, c.name]));
  const weakCats = liveRows.length ? weakestCategories(live).map(c => ({ name: catName.get(c.category_id) || c.category_id, t: c.t })) : weakCats0;
  const seq = (seqRow && seqRow.seq) || 0;
  const marker = markerRow ? parse(markerRow.value, null) : null;
  const examDay = examDayOf(examRows && examRows[0] ? examRows[0].value : undefined);
  const d = daysLeft(today, examDay);
  const phase = phaseFor(d);
  const lines = sinceLines(groups.filter(g => !QUIET_KINDS.includes(g.kind)));
  const events = groups.reduce((a, g) => a + (QUIET_KINDS.includes(g.kind) ? 0 : g.n), 0);
  const next_up = rank && rank.ok ? nextUp(rank, { limit: OVERVIEW_LISTS.next_up }).map(nextRow) : [];
  const by_kind = Object.fromEntries(queueRows.map(r => [r.kind, r.n]));
  const open = Object.values(by_kind).reduce((a, b) => a + b, 0);
  // Stored text is checked on the way out too (a cue saved before the guard, a said that reads like question text).
  const gapsOut = gaps.map(gapSafe).map(g => ({ id: g.id, day: g.day, gap: cap(g.gap, 200), ...(g.said ? { said: cap(g.said, 200) } : {}), topic: g.topic || null, topic_id: g.topic_id || null }));
  const requestedOut = requested.map(r => ({ lesson_id: r.id, topic_id: r.topic_id, topic: r.topic, kind: r.kind, tapped: londonStamp(r.requested_at) }));
  const out = {
    as_of_seq: seq, as_of: londonStamp(now),
    fresh: { anki_pulled_s_ago: sync && sync.last_ok_at ? Math.max(0, Math.round((now - sync.last_ok_at) / 1000)) : null, anki_ok: !(sync && sync.fails > 0) && !(pull && pull.ran && !pull.ok),
      ...(sync && sync.fails > 0 && sync.last_error ? { anki_error: cap(sync.last_error, 160) } : {}) },
    // No exam set, or past it: no countdown (days_left null), and the open phase (teach-priority.js OPEN_PHASE).
    exam: { date: examDay, days_left: d != null && d >= 0 ? d : null, phase: phase ? phase.name : null, ...(examDay ? (d < 0 ? { passed: true } : {}) : { none: 'No exam set: hub_settings exam_date sets one.' }) },
    since_last: { last_seen: marker && marker.at ? londonStamp(marker.at) : null, events, lines },
    gaps_stated: gapsOut,
    requested: requestedOut,
    next_up,
    ...(unlogged && unlogged.length ? { finish_review_not_run: unloggedWords(unlogged) } : {}),
    last_lesson: lastLesson ? { topic: lastLesson.topic, day: lastLesson.day, kind: lastLesson.kind, outcome: lastLesson.outcome, minutes: lastLesson.minutes,
      card: lastLesson.card_action || null } : null,
    queue: { open, by_kind, ...(open ? { next_step: 'Place them now, before anything else and without asking Mo: map_queue then map_resolve (25 at a time; an existing topic when one fits, else new_topic).' } : {}) },
    map: { topics: (totals && totals.topics) || 0, seen: (totals && totals.seen) || 0, very_weak: (totals && totals.very_weak) || 0, weak: (totals && totals.weak) || 0,
      weakest_categories: weakCats.map(c => c.name) },
  };
  const over = await overconfident(env, user, { today }).catch(e => { console.error('overconfident failed', e && e.message); return null; });
  if (over) out.map.overconfident = over;
  const honest = await honestyLineStored(env, user).catch(e => { console.error('honesty line failed', e && e.message); return null; });
  if (honest) out.map.honesty = honest;
  const fcast = await forecastStored(env, user).catch(e => { console.error('forecast line failed', e && e.message); return null; });
  if (fcast) out.forecast = fcast;
  // The map auditing itself (viva.js, wave 4): this week's vivas against what the colours predicted.
  const audit = await auditSummary(env, user, { now }).catch(e => { console.error('viva audit line failed', e && e.message); return null; });
  if (audit) out.map.audit = audit.line;
  // The nightly data checks beside it (integrity.js): whether the rows under the colours keep their rules.
  const sound = await integrityLineStored(env, user).catch(e => { console.error('integrity line failed', e && e.message); return null; });
  if (sound) out.map.integrity = sound;
  // Diagnose / Manage (wave 3, facets.js): the overall split and the systems with a clear weaker part, from the hourly run.
  const parts = await facetLines(env, user).catch(e => { console.error('facet lines failed', e && e.message); return []; });
  if (parts.length) out.map.parts = parts;
  const roots = await rootCausesLine(env, user).catch(e => { console.error('root causes line failed', e && e.message); return null; });
  if (roots) out.map.root_causes = roots;
  const clusterLine = await clustersOverviewLine(env, user).catch(e => { console.error('clusters line failed', e && e.message); return null; });
  if (clusterLine) out.map.clusters = clusterLine;
  const fresh = newPatternLine(newHabit, { since: marker && marker.at, now });
  if (fresh) out.new_pattern = fresh;
  if (profile && profile.text) out.profile = profile.text;
  // What changed overnight and why (snapshots.js, wave 2): the map re-weighed by cause, while it is fresh.
  const night = await overnightBrief(env, user, now);
  if (night) out.overnight = night;
  if (!(rank && rank.ok) && !out.map.topics) out.next_step = 'The map is not set up yet: use list_gaps and the Anki connector as before.';
  if (voice) {
    delete out.map; delete out.fresh;
    // By voice the profile is its one short line (the top habit, the overconfident system).
    if (out.profile) { const short = profileShort(parse(profile.facts_json, {})); if (short) out.profile = short; else delete out.profile; }
    out.say = overviewSay({ days_left: d, lines, requested: requestedOut, next_up, gaps: gapsOut, unlogged: out.finish_review_not_run });
  }
  if (noted != null) out.note_posted = noted;   // the nightly session's line reached Recent activity
  if (touch) await touchSeen(env, user, seq, now, ctx);
  return out;
}

/** Weak and very weak topics among live rows as of now (pure; live.js). */
export function bandCounts(live) {
  let weak = 0, very_weak = 0;
  for (const r of live.values()) { if (r.band === 'weak') weak++; else if (r.band === 'very_weak') very_weak++; }
  return { weak, very_weak };
}

/** The Diagnose / Manage profile lines (facets.js), with the systems' names: [] before the first hourly run. */
export async function facetLines(env, user, { max = 3 } = {}) {
  const stored = await storedProfile(env, user);
  if (!stored) return [];
  const rows = (await env.DB.prepare('SELECT id, name FROM categories WHERE user_id = ?1').bind(user).all()).results || [];
  return profileLines(stored, new Map(rows.map(r => [r.id, r.name])), { max });
}

/** The nightly scheduled session's short summary to Recent activity (job nightly_session, one line a London day,
 * the latest note replacing the earlier). Plain words only: arrows and symbols go. Returns true when posted. */
export async function noteNightly(env, user, note, now = Date.now()) {
  const text = String(note || '').replace(/[→←↑↓]|->|<-|=>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  // The nightly fact check's morning line (1 Nov 2026, map_rules fact_check): a note starting "Fact check:" is its own
  // Recent activity line (job fact_check), so the review's summary note never replaces it.
  const fact = /^fact check\s*:\s*/i.exec(text);
  if (fact) {
    const rest = text.slice(fact[0].length).trim();
    if (!rest) return false;
    return noteJob(env, { job: 'fact_check', user, key: londonDay(now), ref: 'claude', state: 'ok', at: now, detail: rest, counts: { chars: rest.length } });
  }
  return noteJob(env, { job: 'nightly_session', user, key: londonDay(now), ref: 'claude', state: 'ok', at: now, detail: text, counts: { chars: text.length } });
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

/** One nextUp item as map_overview and map_weakest {purpose: lesson} show it (a pair test names its look-alike). */
export function nextRow(it) {
  const r = it.row;
  return { id: it.topic_id, name: it.name, kind: it.kind === 'pair' ? 'pair_test' : 'lesson', ...(it.partner_id ? { pair_with: it.partner_name, pair_id: it.partner_id } : {}),
    lane: r.lane, band: r.band || 'unseen', t1000: r.seen ? t1000Of(r.t) : null, why: cap(whyLine(r, 'pick'), LINE_MAX) };
}

export const PURPOSES = ['lesson', 'weakest', 'cards', 'miss_cards', 'pairs', 'review'];
export const WEAKEST_LABEL = 'Weakest by colour, for browsing. Not what to do next: purpose lesson is that list.';
export const LESSON_LABEL = 'What to do next: the planner\'s order, the same list as Home, teach me and the forecast sheet.';
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

export function rankByMarks(rows, plan) {
  if (!plan || !plan.topics || !(Number(plan.unit) > 0)) return { rows, skipped: [], ranked_by: 'lane' };
  const scored = rows.map((r, i) => {
    const f = r.topic_id ? planFactor(plan, r.topic_id, { pairOff: true }) : null;
    return { ...r, marks: f && f.planned ? Math.round(f.lesson * 100) / 100 : null, _i: i };
  });
  const val = r => (r.marks == null ? CARDS.unknown : r.marks);
  scored.sort((a, b) => val(b) - val(a) || a._i - b._i);
  const clean = ({ _i, ...r }) => r;
  return { rows: scored.filter(r => r.marks == null || r.marks >= CARDS.marks_min).map(clean),
    skipped: scored.filter(r => r.marks != null && r.marks < CARDS.marks_min).map(clean), ranked_by: 'marks' };
}
export const MARKS_LINE = 'Ranked by marks at stake: marks is the planner\'s value of the topic (exam weight times how weak he is times the share of his misses a fix targets), 1 being a typical lesson.';

export function judgedOf(teachJson) {
  const t = parse(teachJson, null);
  if (!t || typeof t !== 'object') return {};
  const j = { clue: cap(t.decision_point, 200), look_alike: cap(t.look_alike, 80), separator: cap(t.separator, 240), fell_for: cap(t.fell_for, 200), trap: cap(t.trap, 60) };
  const kept = Object.fromEntries(Object.entries(j).filter(([, v]) => v));
  return Object.keys(kept).length ? { judged: kept } : {};
}
export function gapCardRow(r) {
  return { gap_id: r.id, kind: 'gap', day: r.day, source: r.source, topic: r.topic || r.topic_raw || null, topic_id: r.topic_id || null, lane: r.lane,
    yield: r.topic_id && r.yield != null ? Math.round(Number(r.yield) * 100) / 100 : null, mehlman_rank: r.mehlman_rank ?? null, repeats: r.topic_misses || 0,
    gap: cap(r.gap, 200), ...(r.said ? { said: cap(r.said, 160) } : {}), ...(r.mixed_with ? { mixed_with: cap(r.mixed_with, 80) } : {}),
    ...(r.step ? { step: r.step } : {}), ...(r.confidence ? { confidence: r.confidence } : {}) };
}

/** map_weakest, by purpose. Returns {purpose, rows, ...}; rows never carry a misread or test-taking slip for cards and re-tests. */
export async function weakest(env, user, args = {}) {
  const purpose = args.purpose === 'retest' ? 'miss_cards' : args.purpose || 'lesson';
  if (!PURPOSES.includes(purpose)) return { refused: true, reason: `purpose is one of ${PURPOSES.join(', ')}.` };
  const limit = Math.max(1, Math.min(15, Number(args.limit) || (purpose === 'cards' ? 15 : 10)));
  const now = args.now || Date.now();
  const today = londonDay(now);
  const cat = args.category_id || null;
  const lane = args.lane || null;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);

  if (purpose === 'lesson') {
    const { data } = await nextUpFor(env, user, { now, today, limit: 1 });
    if (!data.ok) return { purpose, rows: [], next_step: 'The map is not set up yet.' };
    const habitAt = await habitTopics(env, user, { now }).catch(() => new Map());
    const items = nextUp(data, { limit: 500 }).filter(it => (!cat || it.row.category_id === cat) && keepLane(it.row.lane, lane)).slice(0, limit);
    const rows = items.map(it => ({ ...nextRow(it), category: it.row.category || it.row.category_id, seen: !!it.row.seen, gain: Math.round(it.row.gain * 1000) / 1000,
      ...(habitAt.has(it.topic_id) ? { habit: habitAt.get(it.topic_id) } : {}) }));
    return { purpose, label: LESSON_LABEL, phase: data.phase && data.phase.name, rows,
      ...(args.voice ? { say: cap(rows.length ? `Next to teach: ${items.slice(0, 3).map(itemName).join(', ')}.` : 'Nothing needs a lesson right now.', SAY_MAX) } : {}) };
  }

  if (purpose === 'weakest') {
    // Browsing only: every seen topic by its colour as of now (live.js), weakest first. Not an order of what to do.
    const [liveRows, names] = await batchSoft(env, [q(LIVE_CAND_SQL, user),
      q(`SELECT t.id, t.name, t.category_id, coalesce(c.name, t.category_id) AS category FROM topics t LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
         WHERE t.user_id = ? AND t.status IN ('proposed','confirmed')`, user)]);
    const nm = new Map((names || []).map(n => [n.id, n]));
    const rows = [...liveMap(liveRows || [], now).values()].filter(r => r.t != null && nm.has(r.topic_id))
      .map(r => ({ r, n: nm.get(r.topic_id), lane: laneOf(yieldOf(r)) }))
      .filter(x => (!cat || x.n.category_id === cat) && keepLane(x.lane, lane))
      .sort((a, b) => Number(b.r.t) - Number(a.r.t) || String(a.r.topic_id).localeCompare(String(b.r.topic_id))).slice(0, limit)
      .map(({ r, n, lane: l }) => ({ id: r.topic_id, name: n.name, category: n.category, lane: l, band: r.band || 'unseen', t1000: t1000Of(r.t) }));
    return { purpose, label: WEAKEST_LABEL, rows, ...(args.voice ? { say: cap(rows.length ? `Weakest by colour: ${rows.slice(0, 3).map(r => r.name).join(', ')}.` : 'No topic is coloured yet.', SAY_MAX) } : {}) };
  }

  if (purpose === 'cards') {
    const sinceId = Number.isInteger(args.since_anki_id) ? args.since_anki_id : null;
    const sinceDay = isDay(args.since_day) ? args.since_day : sinceId == null ? addDays(today, -1) : null;
    const [rows, gapRows] = await batchSoft(env, [q(`SELECT m.id, m.label, m.day, m.at, m.anki_mistake_id, m.error_type, m.confidence, m.result, m.time_s, m.slow, m.look_alikes, m.rule, m.uw_qid, m.step,
        m.anki_note_ids_json, m.topic_id, m.topic_raw, t.name AS topic, t.yield, coalesce(t.category_id, m.category_id) AS category_id, u.mehlman_rank,
        (SELECT r.teach_json FROM uworld_reviews r WHERE r.user_id = m.user_id AND r.block_id = m.uworld_block_id AND r.q = m.uworld_q) AS teach_json,
        (SELECT count(*) FROM misses m2 WHERE m2.user_id = m.user_id AND m2.topic_id = m.topic_id AND m2.held = 0 AND m2.deleted_at IS NULL AND m2.at >= ?) AS topic_misses
      FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
      WHERE m.user_id = ? AND m.held = 0 AND m.deleted_at IS NULL AND (? IS NULL OR m.anki_mistake_id > ?
          OR (m.anki_mistake_id IS NULL AND m.source = 'uworld' AND m.at >= ? AND m.at >= coalesce((SELECT max(x.at) FROM misses x WHERE x.user_id = m.user_id AND x.anki_mistake_id = ?), 0)))
        AND (? IS NULL OR m.day >= ?)
      ORDER BY m.at DESC LIMIT 300`, now - 14 * DAY_MS, user, sinceId, sinceId, now - 7 * DAY_MS, sinceId, sinceDay, sinceDay),
    q(`SELECT g.id, g.at, g.day, g.source, g.topic AS topic_raw, g.gap, g.said, g.mixed_with, g.step, g.confidence, g.topic_id,
        t.name AS topic, t.yield, t.category_id, u.mehlman_rank,
        (SELECT count(*) FROM misses m2 WHERE m2.user_id = g.user_id AND m2.topic_id = g.topic_id AND m2.held = 0 AND m2.deleted_at IS NULL AND m2.at >= ?) AS topic_misses
      FROM gaps g LEFT JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
      WHERE g.user_id = ? AND g.held = 0 AND g.card_id IS NULL AND g.source IN ('chat', 'spoken_cue') AND g.verdict = 'gap'
        AND (? IS NULL OR g.at >= max(?, coalesce((SELECT max(x.at) FROM misses x WHERE x.user_id = g.user_id AND x.anki_mistake_id = ?), 0)))
        AND (? IS NULL OR g.day >= ?)
      ORDER BY g.at DESC LIMIT 100`, now - 14 * DAY_MS, user, sinceId, now - 7 * DAY_MS, sinceId, sinceDay, sinceDay)]);
    const slips = rows.filter(r => NO_LESSON_ERRORS.includes(r.error_type)).length;
    const missTopics = new Set(rows.map(r => r.topic_id).filter(Boolean));
    const gaps = (gapRows || []).filter(g => !(g.topic_id && missTopics.has(g.topic_id)))   // a miss on the topic covers it
      .map(g => ({ ...g, kind: 'gap', result: 'gap', error_type: 'knowledge gap' }));
    const byLane = rankCardRows([...rows.filter(r => !NO_LESSON_ERRORS.includes(r.error_type)), ...gaps].filter(r => !cat || r.category_id === cat)).filter(r => keepLane(r.lane, lane));
    const plan = byLane.length ? await import('../forecast/teach-plan.js').then(tp => tp.loadTeachPlan(env, user, { now, live: true })).catch(() => null) : null;
    const { rows: ranked, skipped, ranked_by } = rankByMarks(byLane, plan);
    return {
      purpose, since: sinceId != null ? { anki_id: sinceId } : { day: sinceDay }, total: ranked.length, slips_left_out: slips,
      ranked_by: ranked_by === 'marks' ? MARKS_LINE : 'Ranked by lane, then exam yield: the planner has no values yet.',
      ...(ranked_by === 'marks' ? { marks_min: CARDS.marks_min } : {}),
      ...(skipped.length ? { skipped: skipped.slice(0, CARDS.skipped_max).map(r => ({ topic: r.topic || r.topic_raw || null, marks: r.marks, ...(r.kind === 'gap' ? { gap_id: r.id } : { miss_id: r.id, label: r.label }) })),
        skipped_total: skipped.length } : {}),
      rows: ranked.slice(0, limit).map(r => (r.kind === 'gap' ? { ...gapCardRow(r), marks: r.marks ?? null } : { miss_id: r.id, label: r.label, day: r.day, topic: r.topic || r.topic_raw || null, topic_id: r.topic_id || null, lane: r.lane, marks: r.marks ?? null,
        yield: r.topic_id && r.yield != null ? Math.round(Number(r.yield) * 100) / 100 : null, mehlman_rank: r.mehlman_rank ?? null,
        error_type: r.error_type, confidence: r.confidence, result: r.result, time_s: r.time_s, slow: !!r.slow, repeats: r.topic_misses || 0,
        has_card: parse(r.anki_note_ids_json, []).length > 0, look_alike_head: lookAlikeHead(r.look_alikes), ...(r.step ? { step: r.step } : {}),
        ...(r.anki_mistake_id == null ? { logged: false, uw_qid: r.uw_qid || null, rule: cap(r.rule, 300) } : {}), ...judgedOf(r.teach_json) })),
      next_step: 'Cards only for the top rows (most marks first); say in one line which were skipped (skipped: too few marks) and why, and that slips get none. Take the full fields from mistake_sources (Anki connector); rows with logged false are not in the Anki log: use their rule and judged (no extra call needed). judged is the UWorld judge\'s note: build the case from its clue, the Versus line from its look_alike and separator. gap rows are gaps he stated himself, with no card yet: the card teaches what the gap says. step is what broke: recognise asks the diagnosis, distinguish puts the look-alike in the Versus line, test and treat ask the next step, trap asks the exception. Then suggest at most 15 cards; add only the ones Mo keeps.',
    };
  }

  if (purpose === 'miss_cards') {
    const [list] = await batchSoft(env, [
      q(`SELECT r.id AS retest_id, r.kind, r.due, r.card_state, r.lesson_id, m.id, m.anki_mistake_id, m.block_id, m.rule, m.look_alikes, m.my_reasoning,
           coalesce(t.name, l.topic_name) AS topic, t.id AS topic_id, t.yield, coalesce(t.category_id, m.category_id) AS category_id, s.weakness_raw
         FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id LEFT JOIN lessons l ON l.user_id = r.user_id AND l.id = r.lesson_id
           LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = coalesce(m.topic_id, r.topic_id) LEFT JOIN topic_scores s ON s.user_id = r.user_id AND s.topic_id = t.id
         WHERE r.user_id = ? AND r.result IS NULL AND r.covered IS NULL AND r.due <= ? AND (r.kind = 'lesson' OR (m.held = 0 AND m.deleted_at IS NULL
           AND (m.error_type IS NULL OR m.error_type NOT IN ('misread', 'test_taking')))) ORDER BY r.due LIMIT 300`, user, isDay(args.since_day) ? args.since_day : today),
    ]);
    const seen = new Set();
    const misses = list.filter(r => { const k = r.kind === 'lesson' ? `lesson:${r.lesson_id}` : r.id; if (seen.has(k)) return false; seen.add(k); return true; });
    // Each topic's weakness as of now (live.js), so a re-test on a topic that faded comes up sooner.
    const liveW = await loadLive(env, user, { ids: [...new Set(misses.map(m => m.topic_id).filter(Boolean))], now }).catch(() => new Map());
    const rawOf = r => { const l = r.topic_id ? liveW.get(r.topic_id) : null; return l && l.weakness_raw != null ? l.weakness_raw : r.weakness_raw; };
    const gain = r => (Number(r.yield) || 0.05) * (rawOf(r) != null ? Number(rawOf(r)) : 0.5);
    const index = misses.some(m => m.block_id) ? await leakIndexFor(env, user, { missIds: misses.filter(m => m.block_id).map(m => m.id) }).catch(() => null) : null;
    const SHAPE = { rule: questionSafe, look_alikes: questionSafe, my_reasoning: stemSafe };
    const safe = (m, k) => { const v = SHAPE[k](m[k]) ? cap(m[k], 200) : null; return v && m.block_id && (!index || leaks(index, v)) ? null : v; };
    const items = [
      ...misses.filter(m => (!cat || m.category_id === cat) && keepLane(laneFor(m), lane)).map(m => ({ kind: 'miss_card',
        ref: m.kind === 'lesson' ? `lesson:${m.lesson_id}` : m.anki_mistake_id ? `anki:${m.anki_mistake_id}` : m.id, topic: m.topic,
        topic_id: m.topic_id, rule: safe(m, 'rule'), look_alikes: safe(m, 'look_alikes'), my_reasoning: safe(m, 'my_reasoning'), due: m.due,
        ...(m.card_state === 'made' ? { card: true } : {}), _g: gain(m) })),
    ].sort((a, b) => b._g - a._g || String(a.due).localeCompare(String(b.due)));
    const rows = items.slice(0, args.voice ? Math.min(limit, 3) : limit).map(({ _g, ...r }) => r);
    return { purpose, due: items.length, rows,
      next_step: `Rows with card true are already ordinary cards in his deck "${MY_DECK}"; their first rating records the result, so leave those to his reviews. For one you ask yourself, write a fresh case; record an anki: ref with the Anki connector's update_mistake (the hub reads it back). To Mo each is just a card from that miss.`,
      ...(args.voice ? { say: cap(rows.length ? `${plural(items.length, 'miss', 'misses')} to check again. First: ${rows.map(r => r.topic).filter(Boolean).slice(0, 3).join(', ')}.` : 'No misses to check again.', SAY_MAX) } : {}) };
  }

  if (purpose === 'pairs') {
    const rows = (await topPairs(env, user, limit)).map(p => ({ link_id: p.link_id, a: p.a, b: p.b, confusion: p.confusion, mixed_up: p.mixed_up, confused_n: p.confused_n, last_confused_day: p.last_confused_day,
        took_for: p.took_for, vs_a: cap(p.vs_a, 240), vs_b: cap(p.vs_b, 240) }));
    return { purpose, rows, next_step: 'For "test me on this pair": teach_next {mode: "pair_test", topic: a, pair: b}.' };
  }

  // review: the weakest units with at least one seen topic, each summarised from its topics' colours as of now (live.js).
  const [units, members, liveRows] = await batchSoft(env, [q(`WITH ${UNIT_SUMMARY_SQL}
      SELECT us.*, u.num, u.name, u.lane, u.mehlman_rank, u.category_id FROM unit_summary us JOIN units u ON u.user_id = ?1 AND u.id = us.unit_id`, user),
    q(`SELECT ut.unit_id, tp.id AS topic_id, tp.yield FROM unit_topics ut JOIN topics tp ON tp.user_id = ut.user_id AND tp.id = ut.topic_id
        AND tp.status IN ('proposed', 'confirmed') WHERE ut.user_id = ?`, user),
    q(LIVE_CAND_SQL, user)]);
  const unitLive = liveRows.length ? liveSummaries(members, liveMap(liveRows, now), m => [m.unit_id]) : new Map();
  const rows = units.map(u => ({ u, s: unitLive.get(u.unit_id) || summaryFromSql(u) })).filter(({ u, s }) => s.n_seen > 0 && (!cat || u.category_id === cat) && keepLane(u.lane, lane))
    .sort((a, b) => (b.s.t1000 ?? -1) - (a.s.t1000 ?? -1)).slice(0, limit)
    .map(({ u, s }) => ({ unit_id: u.unit_id, num: u.num, name: u.name, lane: u.lane, mehlman_rank: u.mehlman_rank, band: s.band, t1000: s.t1000,
      topics: s.n_topics, seen: s.n_seen, weak: s.n_weak, very_weak: s.n_very_weak }));
  return { purpose, rows, next_step: 'board_tallies and board_checklist show each unit on the Review page.' };
}
