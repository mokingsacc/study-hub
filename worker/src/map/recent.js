import { HttpError, json, londonDay } from '../util.js';
import { MO } from '../users.js';
import { PREFIX as NOTES_PREFIX, rowsOf, summarise, chipJob } from '../notes/import-summary.js';
import { JOBS as RUN_JOBS } from '../job-log.js';
import { auditWords } from '../ai-audit.js';

const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
export const RECENT_HOURS = [1, 24, 168];
export const WHAT_MAX = 90, LINE_MAX = 160, ACTIVITY_MAX = 40, TOPICS_MAX = 800;
export const QUIET = ['score.changed', 'scores.refreshed', 'evidence.added', 'evidence.removed', 'sync.status', 'map.resync', 'positions.changed',
  'topic.sources_refreshed',
  // A clean-up's row changes (hygiene.js): its job line says what it did, once, instead of a line per row.
  'data.cleaned',
  // Pictures the picture job added (auto-pictures.js): its job line counts them, one line a day, instead of a line a topic.
  'media.found',
  'self.rated',
  // Claude's verdict on each card to fix (card-fix.js): the night's one "Cards reviewed by Claude" job line counts them.
  'card.fixed'];
const QUIET_SQL = `(${QUIET.map(k => `'${k}'`).join(', ')})`;
const STATE_KINDS_SQL = `('card_new', 'card_young', 'card_mature', 'card_suspended')`;
const UW_TRIES = 3, ANKI_TRIES = 8, OUTBOX_TRIES = 8;
const FAILED_FOR_MS = 3 * DAY_MS;   // a failed job shows this long, then drops off the chip

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const upper = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// One batch; when a table is missing (an older database) each statement runs alone and a missing one gives no rows.
async function batchSoft(env, stmts) {
  try {
    return (await env.DB.batch(stmts)).map(r => r.results || []);
  } catch (e) {
    if (!noTable(e)) throw e;
    return Promise.all(stmts.map(s => s.all().then(r => r.results || [], err => { if (!noTable(err)) throw err; return []; })));
  }
}

// ---------------------------------------------------------------- words (pure)

const SOURCE_WORD = { uworld: 'UWorld', hub: 'Exam', anki: 'Mistake log', screenshot: 'UWorld' };
export function evidenceWhat(r) {
  if (!r) return null;
  const src = SOURCE_WORD[r.source] || '';
  switch (r.kind) {
    case 'card_review': return r.rating ? `card rated ${upper(String(r.rating))}` : 'card reviewed';
    case 'card_lapse': return 'card forgotten';
    case 'card_check': return `spoken answer checked: ${r.verdict === 'sound' ? 'sound' : r.verdict === 'shaky' ? 'shaky' : 'gap'}`;
    case 'card_weak_part': return 'part of a card missed';
    case 'question': return `${src ? `${src} ` : ''}question ${r.result === 'right' ? 'right' : r.result === 'omitted' ? 'left blank' : 'missed'}`;
    case 'confused_with': return 'mixed up with another topic';
    case 'retest': return `card from a miss ${r.outcome === 'got_it' ? 'right' : 'missed'} the first time`;
    case 'lesson_probe': case 'lesson_final': case 'lesson_check': case 'pair_item': case 'lesson_teachback': case 'lesson_misconception': return 'lesson';
    case 'gap_stated': return 'gap stated';
    case 'recall_audit': return 'viva graded';
    case 'review_option': return 'answer choice known in your UWorld review';
    case 'self_mastered': return 'checklist ticked';
    case 'self_rating': return 'self-rating';
    default: return String(r.kind || 'updated').replace(/_/g, ' ');
  }
}

/** Where a change came from, by its event kind: 'Mistake log', 'Map', 'Lessons', 'Settings'… */
export function sourceOf(kind) {
  const k = String(kind || '');
  const pre = k.split('.')[0];
  if (pre === 'miss' || pre === 'sitting') return 'Mistake log';
  if (pre === 'lesson' || pre === 'teach_memory' || pre === 'misconception' || pre === 'viva') return 'Lessons';
  if (pre === 'setting' || pre === 'pref') return 'Settings';
  if (pre === 'checklist') return 'Checklist';
  if (pre === 'gap') return 'Gaps';
  if (pre === 'card') return 'Cards';
  if (pre === 'note' || pre === 'onenote') return 'OneNote';
  if (pre === 'undo') return 'Undo';
  if (pre === 'search') return 'Search';   // the history search's index (history/sweep.js)
  if (pre === 'pattern' || pre === 'profile') return 'Patterns';   // the pattern review (patterns.js)
  return 'Map';
}
const DEVICE_WORD = { phone: 'on your phone', tablet: 'on your iPad', laptop: 'on your laptop' };
const CHROME_TOOLS = /^mcp:(teach_debrief|save_uworld_questions|uworld_[a-z_]+|next_to_check|save_check)\b/;
export function whereOf({ actor, surface, via } = {}) {
  const v = String(via || ''), dev = (/· (phone|tablet|laptop)\b/.exec(v) || [])[1];
  const client = (/· client:([a-z_]+)/.exec(v) || [])[1];
  if (actor === 'mo') return dev ? `you, ${DEVICE_WORD[dev]}` : surface === 'web' ? 'you, on the hub' : 'you';
  if (actor === 'claude') {
    if (client === 'code' || surface === 'code') return 'Claude Code';
    if (CHROME_TOOLS.test(v)) return 'Claude in Chrome';
    if (surface === 'voice' || surface === 'anki_voice') return 'Claude, by voice';
    return 'Claude (app or Chrome)';
  }
  if (actor === 'anki') return surface === 'ankimobile' ? 'AnkiMobile' : surface === 'anki_voice' ? 'Anki Voice' : 'Anki on the Mac';
  return 'the hub, automatically';
}

/** A topic's newest change as {at, what}, from its newest event and its newest evidence row (either may be missing). */
export function newestOf(ev, evi) {
  const a = ev && ev.at != null ? { at: Number(ev.at), what: cap(ev.summary, WHAT_MAX) } : null;
  const b = evi && evi.at != null ? { at: Number(evi.at), what: cap(upper(evidenceWhat(evi)), WHAT_MAX) } : null;
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

// ---------------------------------------------------------------- the map's Recent button

/** ?hours=1|24|168 (default 24). */
export function readHours(v) {
  if (v == null || v === '') return 24;
  const h = Number(v);
  if (!RECENT_HOURS.includes(h)) throw new HttpError(400, 'hours is 1, 24 or 168.');
  return h;
}

/**
 * Topics changed since now - hours: {hours, since, topics: [{id, at, what, n}]}, newest first. One batch of two
 * statements: each topic's newest telling event, and its newest evidence row written in the window (held rows and
 * card states left out).
 */
export async function recentTopics(env, user, { hours = 24, now = Date.now() } = {}) {
  const since = now - hours * HOUR_MS;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [events, evidence] = await batchSoft(env, [
    q(`SELECT topic_id, at, kind, summary, n FROM (
         SELECT topic_id, at, kind, summary, count(*) OVER (PARTITION BY topic_id) AS n,
           row_number() OVER (PARTITION BY topic_id ORDER BY seq DESC) AS rn
         FROM map_events WHERE user_id = ? AND topic_id IS NOT NULL AND at >= ? AND kind NOT IN ${QUIET_SQL})
       WHERE rn = 1 ORDER BY at DESC LIMIT ${TOPICS_MAX}`, user, since),
    q(`SELECT topic_id, at, kind, source, rating, result, outcome, verdict, n FROM (
         SELECT topic_id, at, kind, source, rating, result, outcome, verdict, count(*) OVER (PARTITION BY topic_id) AS n,
           row_number() OVER (PARTITION BY topic_id ORDER BY at DESC, id DESC) AS rn
         FROM evidence WHERE user_id = ? AND updated_at >= ? AND at >= ? AND held = 0 AND topic_id IS NOT NULL AND kind NOT IN ${STATE_KINDS_SQL})
       WHERE rn = 1 ORDER BY at DESC LIMIT ${TOPICS_MAX}`, user, since, since),
  ]);
  const by = new Map();
  for (const e of events) by.set(e.topic_id, { ev: e, evi: null, n: Number(e.n) || 1 });
  for (const v of evidence) {
    const cur = by.get(v.topic_id);
    if (cur) { cur.evi = v; cur.n += Number(v.n) || 1; } else by.set(v.topic_id, { ev: null, evi: v, n: Number(v.n) || 1 });
  }
  const topics = [...by.entries()].map(([id, x]) => ({ id, ...newestOf(x.ev, x.evi), n: x.n }))
    .filter(t => t.at != null).sort((a, b) => b.at - a.at).slice(0, TOPICS_MAX);
  return { hours, since, now, topics };
}

export async function recentTopicsRoute(request, env, ctx, params, url, user) {
  return json(await recentTopics(env, user, { hours: readHours(url.searchParams.get('hours')) }));
}

// ---------------------------------------------------------------- a topic's newest change (topicDetail)

/** One statement for topicDetail's read batch: the topic's newest telling event and newest live evidence row. */
export function lastChangeSql(env, user, topicId) {
  return env.DB.prepare(`SELECT * FROM (SELECT 'event' AS src, at, kind, summary, NULL AS source, NULL AS rating, NULL AS result, NULL AS outcome, NULL AS verdict
        FROM map_events WHERE user_id = ?1 AND topic_id = ?2 AND kind NOT IN ${QUIET_SQL} ORDER BY seq DESC LIMIT 1)
    UNION ALL SELECT * FROM (SELECT 'evidence' AS src, at, kind, NULL AS summary, source, rating, result, outcome, verdict
        FROM evidence WHERE user_id = ?1 AND topic_id = ?2 AND held = 0 AND kind NOT IN ${STATE_KINDS_SQL} ORDER BY at DESC LIMIT 1)`).bind(user, topicId);
}

/** {at, what} from lastChangeSql's rows, or null. */
export function lastChangeOf(rows) {
  const list = rows || [];
  return newestOf(list.find(r => r.src === 'event'), list.find(r => r.src === 'evidence'));
}

// ---------------------------------------------------------------- running now

const clock = ms => {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(11, 16); }
};
const dayWord = day => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}` : null;
};
const SPOKEN = `(words > 0 OR length(segments_json) > 2)`;
const OUTBOX_TO = { debrief: 'the Anki mistake log', onenote: 'OneNote', anki_link_card: 'Anki', anki_retest: 'the Anki mistake log' };
// An Anki session's device: the add-on on the Mac, the hub's Cards page, or an Anki Voice review (sent by its server).
const SESSION_WHERE = { mac: 'Anki on the Mac', phone: 'Cards page on your phone', hub: 'Cards page on your laptop', voice: 'Anki Voice' };
// The map's sync sources (sync_state), in words.
const SYNC_WORD = { anki: 'Anki mistake log sync', 'anki.new': 'Anki mistake log sync', 'anki.due': 'Anki mistake log sync', 'anki.recent': 'Anki mistake log sync',
  'anki.full': 'Nightly Anki check', 'anki.reviews': 'Anki card reviews sync', card_reviews: 'Anki card reviews sync',
  'anki.fsrs': 'Anki memory data sync', gaps: 'Gaps sync', labeller: 'Exam question labelling', hub: 'Hub exams sync', uworld: 'UWorld sync',
  history: 'Search index' };
const SYNC_FAILS = 3;   // backoff starts at once; three misses in a row is a source not working, not a blip
const STALE_RUN_MS = 12 * HOUR_MS;
// The Cards page pings every 30 s while open and on screen (spoken.js aliveRoute): quiet for 75 s, it is not.
const LIVE_SESSION_MS = 75_000, SESSION_IDLE_MS = 30 * 60_000;   // spoken.js OPEN_IDLE_MS
// The Anki session sweep runs one minute after each quarter hour (cron.js): the first such minute at or after t.
export const nextAnkiSlot = t => { const m = 60_000, start = Math.ceil(t / m) * m; for (let k = 0; k < 15; k++) { const x = start + k * m; if (new Date(x).getUTCMinutes() % 15 === 1) return x; } return start; };

function jobStatements(env, now) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const from = now - FAILED_FOR_MS;
  return {
    uw: q(`SELECT j.block_id, j.status, j.attempts, j.error, j.next_at, j.started_at, j.updated_at, b.day, b.count
       FROM uworld_judging j LEFT JOIN uworld_blocks b ON b.id = j.block_id
       WHERE j.user_id = ? AND (j.status IN ('pending', 'running', 'packing', 'capped') OR (j.status = 'failed' AND j.updated_at >= ?))
       ORDER BY j.updated_at DESC LIMIT 10`, MO, from),
    sessions: q(`SELECT id, device, status, attempts, last_error, started_at, ended_at, updated_at, ${SPOKEN} AS spoken FROM anki_sessions
       WHERE (status IN ('aligned', 'checking') OR (status = 'open' AND (${SPOKEN} OR updated_at >= ?)) OR (status = 'failed' AND updated_at >= ?))
       ORDER BY updated_at DESC LIMIT 10`, now - LIVE_SESSION_MS, from),
    outbox: q(`SELECT kind, status, attempts, last_error, created_at, json_extract(result_json, '$.wait') AS wait FROM outbox
       WHERE status IN ('pending', 'sending', 'failed') AND created_at >= ? ORDER BY created_at DESC LIMIT 50`, now - 14 * DAY_MS),
    syncs: q(`SELECT source, last_ok_at, fails, last_error, next_at FROM sync_state WHERE user_id = ? AND fails >= ${SYNC_FAILS} AND last_error IS NOT NULL`, MO),
    spend: q(`SELECT (SELECT usd FROM usage WHERE day = ?) AS usd, (SELECT value FROM settings WHERE key = 'daily_cap_usd') AS cap`, londonDay(now)),
    exams: q(`SELECT s.id, s.name, max(b.started_at) AS started, sum(b.started_at IS NOT NULL AND b.ended_at IS NULL) AS open_blocks,
         (SELECT count(*) FROM analyses a JOIN blocks b2 ON b2.id = a.block_id WHERE b2.sitting_id = s.id AND a.status IN ('pending', 'running')) AS checking,
         (SELECT count(*) FROM analyses a JOIN blocks b2 ON b2.id = a.block_id WHERE b2.sitting_id = s.id AND a.status = 'error') AS errors
       FROM sittings s JOIN blocks b ON b.sitting_id = s.id
       WHERE s.status = 'in_progress' OR EXISTS (SELECT 1 FROM blocks b3 JOIN analyses a3 ON a3.block_id = b3.id WHERE b3.sitting_id = s.id AND b3.ended_at >= ?
         AND a3.status IN ('pending', 'running', 'error'))
       GROUP BY s.id ORDER BY started DESC LIMIT 5`, from),
    docs: q(`SELECT title, status, status_note, updated_at FROM library_docs WHERE user_id = ?
       AND ((status IN ('uploading', 'uploaded', 'extracting', 'indexing') AND updated_at >= ?) OR (status IN ('failed', 'refused') AND updated_at >= ?))
       ORDER BY updated_at DESC LIMIT 10`, MO, now - DAY_MS, from),
    // The driver reads only part 1 of a system page (its Contents tags) and leaves it 'fetching': that page is done.
    onenote: q(`SELECT count(*) AS n, max(updated_at) AS at FROM onenote_pages WHERE user_id = ? AND fetch_status IN ('queued', 'fetching')
       AND NOT (kind = 'system' AND next_part >= 2)`, MO),
    notesImport: q(`SELECT source, cursor, next_at, last_ok_at FROM sync_state WHERE user_id = ? AND source >= ? AND source < ? LIMIT 500`, MO, NOTES_PREFIX, `${NOTES_PREFIX.slice(0, -1)};`),
  };
}
const JOB_NAMES = ['uw', 'sessions', 'outbox', 'syncs', 'spend', 'exams', 'docs', 'onenote', 'notesImport'];

export function jobsOf(rows, now = Date.now()) {
  const { uw = [], sessions = [], outbox = [], syncs = [], spend = [], exams = [], docs = [], onenote = [], notesImport = [] } = Array.isArray(rows)
    ? Object.fromEntries(JOB_NAMES.map((k, i) => [k, rows[i]])) : rows || {};
  const out = [];
  for (const j of uw) {
    const block = `UWorld block${j.day ? ` of ${dayWord(j.day)}` : ''}${j.count ? ` (${plural(Number(j.count), 'question')})` : ''}`;
    const base = { key: `uw:${j.block_id}`, source: 'UWorld', since: Number(j.started_at || j.updated_at) || null };
    if (j.status === 'running') out.push({ ...base, state: 'running', what: `Judging ${block}` });
    else if (j.status === 'packing') out.push({ ...base, state: 'running', what: `Building review packs for ${block}` });
    else if (j.status === 'pending') out.push({ ...base, state: 'waiting', what: `${upper(block)} waits to be judged` });
    else if (j.status === 'capped') out.push({ ...base, state: 'waiting', what: `${upper(block)} waits for Claude's daily limit`, detail: j.next_at > now ? `Tries again at ${clock(j.next_at)}` : 'Tries again shortly' });
    else if (j.status === 'failed' && Number(j.attempts) < UW_TRIES) out.push({ ...base, state: 'waiting', what: `${upper(block)}: judging stopped, trying again`, detail: j.next_at > now ? `Next try at ${clock(j.next_at)}` : 'Next try shortly' });
    else if (j.status === 'failed') out.push({ ...base, state: 'failed', what: `${upper(block)} could not be judged`, detail: cap(j.error, 120) || 'It tries again tomorrow.', since: Number(j.updated_at) || null });
  }
  for (const s of sessions) {
    const where = SESSION_WHERE[s.device] || 'Anki';
    const base = { key: `anki:${s.id}`, source: 'Anki', since: Number(s.started_at || s.updated_at) || null };
    if (s.status === 'open' && now - Number(s.updated_at) < LIVE_SESSION_MS) out.push({ ...base, state: 'running', what: `Anki review ${s.spoken ? 'being recorded' : 'in progress'} (${where})` });
    else if (s.status === 'open') out.push({ ...base, state: 'waiting', what: `Anki review paused (${where})`,
      detail: `Its spoken answers are checked at ${clock(nextAnkiSlot(Number(s.updated_at) + SESSION_IDLE_MS))}`, since: Number(s.updated_at) || null });
    else if (s.status === 'aligned' && Number(s.attempts) > 0) out.push({ ...base, state: 'waiting', what: `Anki review check: trying again (${where})`, since: Number(s.ended_at || s.updated_at) || null });
    else if (s.status === 'aligned') out.push({ ...base, state: 'waiting', what: `Anki review check pending (${where})`, since: Number(s.ended_at || s.updated_at) || null });
    else if (s.status === 'checking') out.push({ ...base, state: 'running', what: `Checking your spoken Anki answers (${where})`, since: Number(s.updated_at) || null });
    else if (s.status === 'failed') out.push({ ...base, state: 'failed', what: `Anki review check failed (${where})`, detail: cap(s.last_error, 120), since: Number(s.updated_at) || null });
  }
  const groups = new Map();
  for (const o of outbox) {
    const gaveUp = o.status === 'failed' && Number(o.attempts) >= OUTBOX_TRIES;
    const waitsForMiss = o.status === 'pending' && !!o.wait;
    const state = gaveUp ? 'failed' : o.status === 'sending' ? 'running' : 'waiting';
    const k = `${o.kind}:${waitsForMiss ? 'miss' : state}`;
    const g = groups.get(k) || { kind: o.kind, state, n: 0, since: Number(o.created_at) || null, error: null, retrying: false, waitsForMiss };
    g.n++;
    g.since = Math.min(g.since || Infinity, Number(o.created_at) || Infinity);
    if (!g.error && o.last_error) g.error = o.last_error;
    if (o.status === 'failed' && !gaveUp) g.retrying = true;
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const to = OUTBOX_TO[g.kind] || 'Anki';
    const base = { key: `outbox:${g.kind}:${g.waitsForMiss ? 'miss' : g.state}`, source: g.kind === 'onenote' ? 'OneNote' : 'Anki', since: Number.isFinite(g.since) ? g.since : null };
    if (g.waitsForMiss) out.push({ ...base, state: 'waiting', what: `${plural(g.n, 'lesson card')} waiting for ${g.n === 1 ? 'its miss' : 'their misses'} to reach the Anki mistake log`,
      detail: "Linked once the miss is logged, for an exam miss after that exam's finish review. Checked every hour." });
    else if (g.state === 'failed') out.push({ ...base, state: 'failed', what: `${plural(g.n, 'item')} could not be sent to ${to}`, detail: cap(g.error, 120) });
    else if (g.state === 'running') out.push({ ...base, state: 'running', what: `Sending ${plural(g.n, 'item')} to ${to}` });
    else out.push({ ...base, state: 'waiting', what: `${plural(g.n, 'item')} waiting to send to ${to}`, detail: g.retrying ? `Retrying after: ${cap(g.error, 100) || 'an error'}` : null });
  }
  // A sync that keeps failing: the map stops hearing from that source until it answers again.
  for (const y of syncs) {
    out.push({ key: `sync:${y.source}`, source: 'Sync', state: 'failed', what: `${SYNC_WORD[y.source] || `${y.source} sync`} is not working`,
      detail: [cap(y.last_error, 100), y.last_ok_at ? `last worked ${dayClock(y.last_ok_at, now)}` : null].filter(Boolean).join(' · '), since: Number(y.last_ok_at) || null });
  }
  // Claude's daily spend cap: every AI job (checks, judging, reading) waits until tomorrow.
  const sp = spend[0];
  const capUsd = sp && sp.cap != null && sp.cap !== '' ? Number(String(sp.cap).replace(/"/g, '')) : 30;
  if (sp && Number(sp.usd) > 0 && capUsd > 0 && Number(sp.usd) >= capUsd) {
    out.push({ key: 'spend', source: 'Claude', state: 'failed', what: `Claude's daily limit reached ($${Number(sp.usd).toFixed(2)} of $${capUsd})`,
      detail: 'AI checks and judging wait until tomorrow, or raise the limit in Settings.', since: null });
  }
  for (const x of exams) {
    const name = cap(x.name, 60) || 'Exam';
    if (Number(x.open_blocks) > 0 && now - Number(x.started) < STALE_RUN_MS) out.push({ key: `exam:${x.id}`, source: 'Exam', state: 'running', what: `${name} in progress`, since: Number(x.started) || null });
    if (Number(x.checking) > 0) out.push({ key: `exam-check:${x.id}`, source: 'Exam', state: 'running', what: `Checking your ${name} answers (${Number(x.checking)} left)`, since: null });
    if (Number(x.errors) > 0) out.push({ key: `exam-err:${x.id}`, source: 'Exam', state: 'failed', what: `${plural(Number(x.errors), 'answer')} in ${name} could not be checked`, since: null });
  }
  for (const d of docs) {
    const title = cap(d.title, 60) || 'A PDF';
    if (d.status === 'failed' || d.status === 'refused') out.push({ key: `doc:${title}`, source: 'Library', state: 'failed', what: `${title} could not be read`, detail: cap(d.status_note, 120), since: Number(d.updated_at) || null });
    else out.push({ key: `doc:${title}`, source: 'Library', state: 'running', what: `${d.status === 'uploading' ? 'Uploading' : 'Reading'} ${title}`, since: Number(d.updated_at) || null });
  }
  const on = onenote[0];
  if (on && Number(on.n) > 0) {
    const at = Number(on.at) || null;
    if (at && now - at < 30 * 60_000) out.push({ key: 'onenote', source: 'OneNote', state: 'running', what: `Importing ${plural(Number(on.n), 'OneNote page')}`, since: at });
    else out.push({ key: 'onenote', source: 'OneNote', state: 'waiting', what: `OneNote import stopped part way (${plural(Number(on.n), 'page')} left)`,
      detail: 'Ask Claude to import OneNote again to finish it.', since: at });
  }
  const notes = notesImport.length ? chipJob(summarise(rowsOf(notesImport), { now }), now) : null;
  if (notes) out.push(notes);
  const rank = { failed: 0, running: 1, waiting: 2 };
  return out.map(j => (j.detail ? j : (({ detail, ...rest }) => rest)(j))).sort((a, b) => rank[a.state] - rank[b.state] || (b.since || 0) - (a.since || 0));
}
const dayClock = (ms, now) => (londonDay(ms) === londonDay(now) ? `at ${clock(ms)}` : `${dayWord(londonDay(ms))} ${clock(ms)}`);

/** The bar's chip: {running, waiting, failed, line} ('' line when nothing runs). */
export function jobsSummary(jobs) {
  const n = s => jobs.filter(j => j.state === s).length;
  const failed = n('failed'), running = n('running'), waiting = n('waiting');
  const top = jobs[0];
  const line = !jobs.length ? '' : jobs.length === 1 ? top.what : [failed && `${failed} failed`, running && `${running} running`, waiting && `${waiting} waiting`].filter(Boolean).join(' · ');
  return { failed, running, waiting, line };
}

async function readJobs(env, now) {
  const named = jobStatements(env, now);
  const rows = await batchSoft(env, JOB_NAMES.map(k => named[k]));
  return jobsOf(Object.fromEntries(JOB_NAMES.map((k, i) => [k, rows[i]])), now);
}

export async function jobsNow(env, user, { now = Date.now() } = {}) {
  if (user !== MO) return { jobs: [], summary: jobsSummary([]) };
  const jobs = await readJobs(env, now);
  return { jobs, summary: jobsSummary(jobs) };
}

// ---------------------------------------------------------------- job lines (job_runs, job-log.js)

const num = v => Number(v) || 0;
const REC_WORD = { uworld: 'UWorld recorder', anki: 'Anki review', exam: 'practice exam', viva: 'topic panel viva' };
// The minute and cron jobs by name, for a job that stopped with an error (sync.js RUN, cron.js JOBS).
const JOB_WORD = { gaps: 'placing gaps on the map', retests: 'booking cards for your misses', retestCards: 'cards from your misses', labeller: 'exam question labelling',
  cardReviews: 'card reviews from the Mac', dirty: 'map colours', scores: 'map colours', repair: 'map colours', rebuild: 'map rebuild',
  release: 'finished sittings onto the map', library: 'reading the Library', morning: "this morning's topics", embed: 'map layout', hourly: 'hourly map upkeep',
  priors: 'map starting levels', lessonCards: 'lesson cards', learn: 'Learn', 'cards.due': 'due cards', 'orbits.daily': 'map orbits',
  flush: 'sending to Anki and OneNote', images: 'picture tidy', anki: 'Anki check', uworld: 'UWorld judge', exambank: 'exam bank search',
  notes: 'Notes import', backfill: 'catch-up', minute: 'map jobs', pictures: 'finding topic pictures', forecast: 'the score forecast', clusters: 'finding clusters of topics you mix up' };
const FORM_WORD = { uworld_review_talks: 'a UWorld review', viva_results: 'a viva' };
const SPELL_WORD = { limit: 'spelling check skipped: daily limit', error: 'spelling check skipped: it failed' };
const spellOf = c => (c.spell === 'done' ? (num(c.fixes) ? `spelling check fixed ${plural(num(c.fixes), 'word')}` : 'spelling check: nothing to fix') : SPELL_WORD[c.spell] || null);
const tries = c => (num(c.tries) >= num(c.max) && num(c.max) ? `gave up after ${num(c.max)} tries` : `will retry${num(c.tries) ? ` (try ${num(c.tries)} of ${num(c.max)})` : ''}`);
const VOICE_FAIL = { key: 'the hub refused its key (check PRACTICE_HUB_KEY on Anki Voice)', refused: 'the hub turned one down', busy: 'the hub was busy, it will retry',
  down: 'it could not reach the hub, it will retry' };
const parseCounts = t => { try { const o = JSON.parse(t || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

const BATCH_WORD = { uworld_judge: 'UWorld block', uworld_review_talk: 'UWorld review', anki_check: 'Anki check', rejudge: 'Look-alike re-judge',
  viva: 'Viva', pictures: 'Pictures', catchup_signals: 'Catch-up', retest_cards: 'Cards from your misses', integrity: 'Data checks', honesty: 'Honesty check',
  nbme_check: 'Exam answers check', pattern_review: 'Pattern review', labeller: 'Exam question labelling', clusters: 'Cluster names' };

/**
 * One job_runs row in words: {source, what, who} (pure). Code-built from the job, its state and its counts only; the
 * detail (an error's first words) rides along separately. A run checked for completeness (ai-audit.js) says so after
 * its words ("checked: all parts present"), and a run waiting for its Message Batch says that instead of a limit.
 */
export function jobLine(r) {
  const c = parseCounts(r.counts_json);
  if (r.state === 'held' && c.batch) {
    const what = BATCH_WORD[r.job] || String(r.job || 'job').replace(/_/g, ' ');
    return { source: jobLineCore(r).source, what: `${what}${c.day ? ` of ${dayWord(c.day)}` : ''}: waiting for its batch (half price; minutes to an hour)`, who: 'the hub, automatically' };
  }
  const line = jobLineCore(r);
  const checked = r.state === 'ok' || r.state === 'fallback' ? auditWords(c) : null;
  return checked ? { ...line, what: `${line.what} · ${checked}` } : line;
}

function jobLineCore(r) {
  const c = parseCounts(r.counts_json), st = r.state, ref = r.ref;
  const auto = 'the hub, automatically';
  switch (r.job) {
    case 'transcribe': {
      const clips = num(c.clips), bits = [];
      const whisperFirst = ref === 'uworld';
      if (num(c.nova) === clips) bits.push('all Nova-3');
      else if (num(c.whisper) === clips) bits.push('all Whisper');
      else {
        if (num(c.whisper) && whisperFirst) bits.push(`${num(c.whisper)} Whisper`);
        if (num(c.nova)) bits.push(whisperFirst ? `${num(c.nova)} fell back to Nova-3` : `${num(c.nova)} Nova-3`);
        if (num(c.plain)) bits.push(`${num(c.plain)} Nova-3 without your word list`);
        if (num(c.whisper) && !whisperFirst) bits.push(`${num(c.whisper)} fell back to Whisper`);
        if (num(c.failed)) bits.push(`${num(c.failed)} not heard (kept on the device and sent again)`);
      }
      return { source: 'Recording', what: `Transcription (${REC_WORD[ref] || 'recording'}): ${plural(clips, 'clip')}, ${bits.join(', ')}`, who: auto };
    }
    case 'anki_check': {
      const who = SESSION_WHERE[ref] || 'Anki';
      // An Anki Voice review arriving from its server (spoken.js put), before its check.
      if (c.received != null) {
        return st === 'failed' ? { source: 'Anki', what: 'Anki Voice review could not be saved for its check', who }
          : { source: 'Anki', what: `Anki Voice review received: ${plural(num(c.received), 'card')} with your words${num(c.to_check) ? `, ${num(c.to_check)} to check` : ''}`, who };
      }
      if (st === 'failed') return { source: 'Anki', what: `Anki check failed, ${tries(c)}`, who };
      if (st === 'held' && !num(c.left)) return { source: 'Anki', what: "Anki check waits for Claude's daily limit", who };
      const bits = [`${plural(num(c.cards), 'card')} checked`];
      if (num(c.tutor)) bits.push(`${plural(num(c.tutor), 'card')} already marked by the tutor`);
      if (num(c.gaps)) bits.push(plural(num(c.gaps), 'gap'));
      if (num(c.shaky)) bits.push(`${num(c.shaky)} shaky`);
      if (num(c.pairs)) bits.push(plural(num(c.pairs), 'look-alike'));
      if (num(c.left)) bits.push(`${num(c.left)} wait for tomorrow (its daily limit)`);
      const sp = spellOf(c);
      return { source: 'Anki', what: `Anki check: ${bits.join(', ')}${sp ? ` · ${sp}` : ''}`, who };
    }
    case 'anki_echo':
      return { source: 'Anki', what: `Anki review not saved: the UWorld recorder was on (${num(c.share)}% of its words were the block's)`, who: SESSION_WHERE[ref] || 'Anki' };
    case 'uworld_log': {
      const block = `UWorld block${c.day ? ` of ${dayWord(c.day)}` : ''}`;
      return { source: 'UWorld', what: `${block}: ${plural(num(c.logged), 'miss', 'misses')} logged for you${num(c.waiting) ? `, ${num(c.waiting)} wait for your say` : ''}`, who: auto };
    }
    case 'uworld_pages': {
      const block = `UWorld block${c.day ? ` of ${dayWord(c.day)}` : ''}`;
      if (st === 'failed') return { source: 'UWorld', what: `${block}: question pages not read`, who: 'the recorder page' };
      if (st === 'held') return { source: 'UWorld', what: `${block}: question pages wait for Claude's daily limit`, who: 'the recorder page' };
      return { source: 'UWorld', what: `${block}: ${plural(num(c.pages), 'question page')} read (${num(c.read)} results, ${num(c.wrong)} wrong), the judge reads them next`, who: 'the recorder page' };
    }
    case 'uworld_judge': {
      const block = `UWorld block${c.day ? ` of ${dayWord(c.day)}` : ''}`;
      if (st === 'failed') return { source: 'UWorld', what: `${block}: judging failed, ${tries(c)}`, who: auto };
      if (st === 'held') return { source: 'UWorld', what: c.limit ? `${block} waits: the UWorld review's daily limit ($${num(c.limit)})` : `${block} waits for Claude's daily limit`, who: auto };
      if (c.again) return { source: 'UWorld', what: `${block} judged again: ${plural(num(c.questions), 'question')} (more of your words were heard)`, who: auto };
      const bits = [plural(num(c.questions), 'question'), `${num(c.review)} to review`];
      if (num(c.pairs)) bits.push(plural(num(c.pairs), 'look-alike'));
      if (num(c.steps)) bits.push(`step on ${num(c.steps)}`);
      if (num(c.sure) + num(c.lean) + num(c.guess)) bits.push(`${num(c.sure)} sure, ${num(c.lean)} lean, ${num(c.guess)} guess`);
      if (num(c.seen)) bits.push(`${num(c.seen)} with the question in view`);
      if (num(c.unclear)) bits.push(`${num(c.unclear)} heard unclearly (they count less)`);
      if (num(c.others)) bits.push(plural(num(c.others), 'other condition'));
      const sp = spellOf(c);
      if (c.by === 'chat') return { source: 'UWorld', what: `${block} judged in the chat: ${bits.join(', ')}`, who: 'Claude in the chat' };
      if (c.fallback) return { source: 'UWorld', what: `${block} judged by the hub: the chat didn't finish it. ${bits.join(', ')}${sp ? ` · ${sp}` : ''}`, who: auto };
      return { source: 'UWorld', what: `${block} judged: ${bits.join(', ')}${sp ? ` · ${sp}` : ''}`, who: auto };
    }
    case 'uworld_review_talk': {
      const block = `UWorld review${c.day ? ` of ${dayWord(c.day)}` : ''}`;
      // The catch-up after new analysis rules, and one review queued again ({reanalyse: true}).
      if (c.requeued != null) return { source: 'UWorld', what: st === 'failed' ? 'UWorld reviews: queueing them to be analysed again failed' : num(c.requeued)
        ? `UWorld reviews: ${plural(num(c.requeued), 'review')} queued to be analysed again with the newest rules` : 'UWorld reviews: none left to analyse again', who: auto };
      if (c.queued) return { source: 'UWorld', what: `${block} queued to be analysed again`, who: auto };
      if (st === 'failed') return { source: 'UWorld', what: `${block}: analysis failed, ${tries(c)}`, who: auto };
      if (st === 'held') return { source: 'UWorld', what: `${block} waits for Claude's daily limit`, who: auto };
      if (c.chat_skip) return { source: 'UWorld', what: `${block}: the recording was not analysed, you reviewed it in the chat`, who: auto };
      const bits = [plural(num(c.questions), 'question'), plural(num(c.gaps), 'gap'), plural(num(c.mixups), 'mix-up'), plural(num(c.links), 'link'),
        plural(num(c.misconceptions), 'misconception')];
      if (num(c.causes)) bits.push(`${plural(num(c.causes), 'miss', 'misses')} re-read from your words`);
      if (num(c.known)) bits.push(plural(num(c.known), 'answer choice you knew', 'answer choices you knew'));
      if (num(c.versus)) bits.push(plural(num(c.versus), 'versus note'));
      if (c.chat) return { source: 'UWorld', what: `${block} saved from the chat${c.done ? ', done' : ''}: ${bits.join(', ')}`, who: 'Claude in the chat' };
      if (c.fallback) return { source: 'UWorld', what: `${block} analysed by the hub: the chat review didn't cover it. ${bits.join(', ')}`, who: auto };
      return { source: 'UWorld', what: `${block} analysed${c.again ? ' again' : ''}: ${bits.join(', ')}`, who: auto };
    }
    case 'retest_book':
      return { source: 'Cards', what: `${plural(num(c.misses), 'miss', 'misses')} will get a card in your deck${num(c.imported) ? ` (${num(c.imported)} from the Anki log)` : ''}`, who: auto };
    case 'retest_cards': {
      if (st === 'failed') return { source: 'Cards', what: c.writing ? 'Cards from your misses: a card could not be written, will retry' : `Cards from your misses: Anki Voice did not answer, will retry${num(c.waiting) ? ` (${plural(num(c.waiting), 'card')} waiting)` : ''}`, who: auto };
      if (st === 'held') return { source: 'Cards', what: c.limit ? `Cards from your misses wait: today's $${num(c.limit)} for writing them is used` : "Cards from your misses wait for Claude's daily limit", who: auto };
      const added = num(c.made) + num(c.moved);
      const bits = [];
      if (added) bits.push(`${plural(added, 'card')} from your misses added to your deck`);
      if (num(c.hidden)) bits.push(`${plural(num(c.hidden), 'old card')} moved in suspended (already checked or your own card covers it)`);
      if (!added && num(c.written)) bits.push(`${plural(num(c.written), 'card')} written, going to Anki next`);
      if (num(c.unusable)) bits.push(`${plural(num(c.unusable), 'card')} could not be written`);
      if (num(c.deck_removed)) bits.push('the old extra deck was empty and is gone');
      if (num(c.expired)) bits.push(`${plural(num(c.expired), 'older miss', 'older misses')} not picked in 14 days let go (still on the map)`);
      const head = bits.join(', ') || 'Cards from your misses: nothing to do';
      return { source: 'Cards', what: head.charAt(0).toUpperCase() + head.slice(1), who: auto };
    }
    case 'catchup_signals': {
      const head = `Catch-up of older gaps and blocks${c.status === 'done' ? ' finished' : ''}`;
      if (st === 'held') return { source: 'Catch-up', what: `${head}: stopped at its $${num(c.max)} limit (${num(c.gaps)} gaps tagged, ${num(c.blocks)} blocks read)`, who: auto };
      if (st === 'failed') return { source: 'Catch-up', what: `${head}: a step failed, it tries again next minute`, who: auto };
      return { source: 'Catch-up', what: `${head}: ${num(c.gaps)} gaps tagged, ${num(c.blocks)} blocks read${num(c.left) ? `, ${num(c.left)} left` : ''} ($${num(c.usd).toFixed(2)} of $${num(c.max)})`, who: auto };
    }
    case 'catchup_audit': {
      if (st === 'failed') return { source: 'Catch-up', what: 'Clean-up of older data failed', who: auto };
      const bits = [num(c.echoes) && `${plural(num(c.echoes), 'echo session')} removed`, num(c.cues) && `${plural(num(c.cues), 'cue')} mapped again`,
        num(c.relabelled) && `${plural(num(c.relabelled), 'gap label')} fixed`, num(c.scrubbed) && `${num(c.scrubbed)} read-aloud questions scrubbed`,
        num(c.rejudge) && `${plural(num(c.rejudge), 'UWorld question')} to judge again`].filter(Boolean);
      return { source: 'Catch-up', what: `Clean-up of older data: ${bits.join(', ') || 'nothing left to change'}`, who: auto };
    }
    case 'honesty': {
      if (st === 'failed') return { source: 'Map check', what: 'Map honesty check failed, it tries again next minute', who: auto };
      const nq = num(c.blue_nq) ? `; blue without a real question: ${plural(num(c.blue_nq), 'topic')}, right on ${num(c.blue_nq_right)} of ${num(c.blue_nq_n)} later` : '';
      if (c.verdict) return { source: 'Map check', what: `Map honesty check: ${r.detail || c.verdict}${nq}${num(c.written) ? ` (${plural(num(c.written), 'answer')} scored today)` : ''}`, who: auto };
      return { source: 'Map check', what: `Map honesty check: ${plural(num(c.written), 'answer')} scored against what happened, more to go`, who: auto };
    }
    case 'facets': {
      // Wave 3: the hourly Diagnose / Manage recompute, and what a lesson's own failures did to its topic.
      if (ref === 'lesson') {
        const moved = num(c.before) >= 0 && num(c.after) >= 0 && num(c.before) !== num(c.after) ? `, colour ${num(c.before)} to ${num(c.after)}` : ', colour unchanged';
        const part = c.facet === 'diagnose' || c.facet === 'manage' ? ` (${c.facet === 'diagnose' ? 'Diagnose' : 'Manage'})` : '';
        return { source: 'Lessons', what: `Lesson evidence counted on ${r.detail || 'a topic'}${part}${moved}`, who: auto };
      }
      if (st === 'failed') return { source: 'Map', what: 'Diagnose / Manage parts: the recompute failed, it tries again next hour', who: auto };
      const tail = c.weaker === 'diagnose' ? '; overall, diagnosis is the weaker part' : c.weaker === 'manage' ? '; overall, management is the weaker part' : '';
      // 1 Nov 2026: what was updated straight away today as answers landed, folded into this one daily line.
      const now = [num(c.instant_colours) && `${plural(num(c.instant_colours), 'topic')} recoloured`, num(c.instant_parts) && `parts of ${plural(num(c.instant_parts), 'topic')}`,
        num(c.instant_reviews) && `${plural(num(c.instant_reviews), 'Anki Voice review')} sent at once`].filter(Boolean);
      const instant = now.length ? `. Updated straight away today: ${now.join(', ')}` : '';
      return { source: 'Map', what: `Diagnose / Manage parts worked out: ${plural(num(c.topics), 'topic')} (${num(c.enough)} with enough evidence), ${num(c.written)} changed, from ${plural(num(c.answers), 'tagged answer')}${tail}${instant}`, who: auto };
    }
    case 'systems_tidy':
      return st === 'failed' ? { source: 'Catch-up', what: 'System labels tidy failed, it tries again next minute', who: auto }
        : { source: 'Catch-up', what: `System labels tidied to UWorld's names: ${plural(num(c.blocks), 'block')}, ${plural(num(c.labels), 'miss label')}`, who: auto };
    case 'sync': {
      const word = SYNC_WORD[ref] || `${ref} sync`;
      return st === 'failed' ? { source: 'Sync', what: `${word} stopped working (3 tries in a row)`, who: auto } : { source: 'Sync', what: `${word} is working again`, who: auto };
    }
    case 'outbox':
      // 1 Nov 2026: a lesson card's link waiting for its miss is not a failure (0079 restated the old failed lines).
      if (c.waited) return { source: 'Anki', what: "A lesson card's link to its miss waited: the miss was not in the Anki mistake log yet. Not a failure, it is linked once the miss is there", who: auto };
      if (num(c.skipped)) return { source: 'Anki', what: `${plural(num(c.skipped), 'lesson card link')} skipped: the miss never reached the Anki mistake log in 30 days`, who: auto };
      return { source: ref === 'onenote' ? 'OneNote' : 'Anki', what: `${plural(num(c.n), 'item')} could not be sent to ${OUTBOX_TO[ref] || 'Anki'}${num(c.gave_up) ? `, ${num(c.gave_up)} gave up after ${OUTBOX_TRIES} tries` : ', will retry'}`, who: auto };
    case 'anki_voice_gaps':
      return ref === 'off' ? { source: 'Anki Voice', what: 'Anki Voice is not sending missed cards to your map: it has no practice hub key', who: 'Anki Voice' }
        : { source: 'Anki Voice', what: `Anki Voice could not send ${plural(num(c.pending), 'missed card')} to your map: ${VOICE_FAIL[c.kind] || VOICE_FAIL.down}`, who: 'Anki Voice' };
    case 'spend': {
      const times = num(c.n) > 1 ? ` (${num(c.n)} jobs held)` : '';
      return ref === 'monthly' ? { source: 'Claude', what: `The monthly limit ($${num(c.cap)}) is reached: AI work waits for the new month${times}`, who: auto }
        : { source: 'Claude', what: `Claude's daily limit ($${num(c.cap)}) reached: AI checks and judging wait until tomorrow${times}`, who: auto };
    }
    case 'rejudge': {
      const head = ref === 'dry' ? 'Look-alike re-judge, dry run (nothing changed yet)' : 'Look-alike re-judge';
      if (st === 'failed') return { source: 'Map', what: `${head} failed${c.misses ? ` after ${plural(num(c.misses), 'miss', 'misses')}` : ''}`, who: auto };
      if (st === 'held' && !num(c.judged) && !num(c.reused)) return { source: 'Map', what: `${head} waits for Claude's daily limit`, who: auto };
      const bits = [`${plural(num(c.judged) + num(c.reused), 'miss', 'misses')} read from your words`, `${num(c.confusion)} real mix-ups`,
        `${plural(num(c.removed), 'look-alike penalty', 'look-alike penalties')} ${ref === 'dry' ? 'would go' : 'removed'}`, `${num(c.kept)} kept`];
      if (num(c.links_removed)) bits.push(`${plural(num(c.links_removed), 'look-alike link')} retired`);
      if (num(c.left)) bits.push(`${num(c.left)} left to read`);
      if (num(c.waiting)) bits.push(`${num(c.waiting)} waiting for their batch (run it again once it is back)`);
      if (st === 'held') bits.push("the rest wait for Claude's daily limit");
      return { source: 'Map', what: `${head}: ${bits.join(', ')}${ref === 'dry' ? '' : ' (undo puts it back)'}`, who: auto };
    }
    case 'overnight': {
      if (st === 'failed') return { source: 'Map', what: 'Before-and-after snapshot of the colours failed', who: auto };
      if (ref === 'snapshot') return { source: 'Map', what: `Colours kept before ${num(c.version) >= 9 ? "a lesson's closing viva counted at half weight" : num(c.version) >= 8 ? 'vivas and card days counted toward blue' : num(c.version) >= 7 ? 'the starting guess was learned' : 'the re-weighing by cause'}: ${plural(num(c.topics), 'topic')}`, who: auto };
      if (num(c.version) >= 8) return { source: 'Map', what: `What changed overnight: ${plural(num(c.moved), 'topic')} moved, ${num(c.lifted)} allowed blue by your viva and spaced card answers`, who: auto };
      if (num(c.version) >= 7) return { source: 'Map', what: `What changed overnight: ${plural(num(c.moved), 'topic')} moved, ${num(c.guess)} by the starting guess learned from your first answers`, who: auto };
      return { source: 'Map', what: `What changed overnight: ${plural(num(c.moved), 'topic')} moved, ${num(c.penalties)} after a look-alike penalty came off${num(c.unseen) ? `, ${num(c.unseen)} back to unseen` : ''}`, who: auto };
    }
    case 'scores_version':
      return st === 'failed' ? { source: 'Map', what: `Scores for the new rules (v${num(c.version) || ''}): the recompute failed, it tries again`, who: auto }
        : { source: 'Map', what: `Scores recomputed for the new rules (v${num(c.version)}): ${plural(num(c.topics), 'topic')} so far`, who: auto };
    case 'gap_retract':
      return st === 'failed' ? { source: 'Anki Voice', what: 'A rating undone in Anki Voice could not be taken off the map', who: 'Anki Voice' }
        : { source: 'Anki Voice', what: `${plural(num(c.ratings), 'rating')} undone in Anki Voice taken off the map (${plural(num(c.gaps), 'gap')}, ${plural(num(c.reviews), 'card review')})`, who: 'Anki Voice' };
    case 'hygiene': {
      const head = ref === 'dry' ? 'Data clean-up, dry run (nothing changed yet)' : ref === 'undo' ? 'Data clean-up undone' : 'Data clean-up';
      if (st === 'failed') return { source: 'Map', what: `${head} failed`, who: auto };
      if (ref === 'undo') return { source: 'Map', what: `${head}: ${plural(num(c.undone), 'batch', 'batches')} put back`, who: auto };
      const bits = [num(c.misses) && `${plural(num(c.misses), 'duplicate miss', 'duplicate misses')} merged`, num(c.miscs) && `${plural(num(c.miscs), 'repeated misconception')} merged`,
        num(c.retests) && `${plural(num(c.retests), 'duplicate booking')} removed`, num(c.said) && `${num(c.said)} "said" that were not your words cleared`,
        num(c.gaps) && `${plural(num(c.gaps), 'duplicate gap')} merged`, num(c.answers) && `${plural(num(c.answers), 'UWorld answer')} put on the map`,
        num(c.forms) && `${plural(num(c.forms), 'mixed-with or quote')} that did not fit cleared`].filter(Boolean);
      const verb = ref === 'dry' ? (bits.length ? `would change: ${bits.join(', ').replace(/ (merged|removed|cleared|put on the map)/g, '')}` : 'nothing to change') : bits.join(', ') || 'nothing to change';
      return { source: 'Map', what: `${head}: ${verb}${ref === 'run' && num(c.batches) ? ' (undo puts it back)' : ''}`, who: auto };
    }
    case 'integrity': {
      // A run from the map's Tidy (ref 'tidy') says so, beside the nightly one.
      const tidy = ref === 'tidy';
      if (st === 'failed') return { source: 'Map check', what: tidy ? 'Data checks from Tidy failed (tap Tidy to try again; they also run tonight at 02:08)' : 'Data checks failed, they run again tonight (02:08)', who: auto };
      const what = r.detail || (num(c.failing) ? `Data checks: ${num(c.failing)} of ${num(c.checks)} flag rows (${num(c.rows)})` : `Data checks: all ${num(c.checks)} pass`);
      return { source: 'Map check', what: tidy ? what.replace(/^Data checks:/, 'Data checks (from Tidy):') : what, who: auto };
    }
    case 'provenance': {
      if (st === 'failed') return { source: 'Map', what: 'Your words on each miss: reading them from the recordings failed, it tries again next hour', who: auto };
      const bits = [`${plural(num(c.filled), 'miss', 'misses')} now show your own words with their time`];
      if (num(c.none)) bits.push(`${num(c.none)} had no words that could be told apart (Claude's summary only)`);
      if (num(c.left)) bits.push(`${num(c.left)} left to read`);
      return { source: 'Map', what: `Your words on each miss: ${bits.join(', ')}`, who: auto };
    }
    case 'self_rating': {
      if (st === 'failed') return { source: 'Map', what: `A self-rating could not be saved${r.detail ? ` (${r.detail})` : ''}`, who: 'you' };
      const bits = [];
      if (num(c.pairs)) bits.push(`${plural(num(c.pairs), 'look-alike or link pair')}`);
      if (num(c.after)) bits.push(`${num(c.after)} after seeing the answers (half weight)`);
      const head = `You rated ${plural(num(c.parts), 'topic part')} today${num(c.topics) ? `, on ${plural(num(c.topics), 'topic')}` : ''}`;
      return { source: 'Map', what: `${head}${bits.length ? ` (${bits.join('; ')})` : ''}: each a light signal on the colour`, who: 'you' };
    }
    case 'viva': {
      // The viva (viva.js, wave 4): a rubric built, a viva graded with its counts, the 5-minute audit's picks, failures.
      const topic = r.detail ? `: ${r.detail}` : '';
      if (c.kind === 'rubric') {
        if (st === 'failed') return { source: 'Lessons', what: `Viva rubric could not be built${topic}, it tries again`, who: auto };
        if (st === 'held') return { source: 'Lessons', what: "Viva rubrics wait for Claude's daily limit", who: auto };
        return { source: 'Lessons', what: `Viva rubric ${c.rebuilt ? 'rebuilt (your sources changed)' : 'built'}${topic} (${plural(num(c.points), 'key point')}, ${num(c.high)} high-yield)`, who: auto };
      }
      if (c.kind === 'audit') {
        if (st === 'failed') return { source: 'Lessons', what: 'Map audit: topics could not be picked', who: auto };
        return { source: 'Lessons', what: `Map audit: ${plural(num(c.picked), 'topic')} picked${topic}`, who: auto };
      }
      // A lesson's "don't know it" (the viva-first lesson): every heading missing, nothing marked.
      if (c.kind === 'skipped') return { source: 'Lessons', what: `${c.phase === 'after' ? 'Closing' : 'Opening'} lesson viva${topic}: "don't know it", every heading missing`, who: auto };
      if (st === 'failed') return { source: 'Lessons', what: `Viva grading failed${topic}${c.final ? ', given up' : ', it tries again'}`, who: auto };
      if (st === 'held') return { source: 'Lessons', what: "Viva grading waits for Claude's daily limit", who: auto };
      const word = { matched: 'the map matched', too_red: 'the map was too red', too_green: 'the map was too green' }[c.surprise] || null;
      const bits = [`${num(c.said)} of ${num(c.of)} key points said`, `${num(c.wrong)} wrong`, `${num(c.missing)} missing`];
      if (num(c.misconceptions)) bits.push(plural(num(c.misconceptions), 'misconception'));
      if (num(c.gaps)) bits.push(`${plural(num(c.gaps), 'gap')} on other topics`);
      if (word) bits.push(word);
      if (c.phase === 'after') bits.push('counted at half weight');
      const what = c.audit ? 'Map audit graded' : c.panel ? 'Topic panel viva graded' : c.phase === 'before' ? 'Opening lesson viva marked'
        : c.phase === 'after' ? 'Closing lesson viva marked' : 'Viva graded';
      return { source: 'Lessons', what: `${what}${topic}: ${bits.join(', ')}`, who: auto };
    }
    case 'shadow': {
      if (st === 'failed') return { source: 'Map check', what: 'Shadow test of a new scoring rule failed, it tries again next minute', who: auto };
      const rule = c.challenger ? `rules ${c.challenger}` : 'the new rule';
      if (num(c.replay)) return { source: 'Map check', what: `Shadow test of ${rule}: ${plural(num(c.scored), 'past answer')} replayed today, more to go`, who: auto };
      const ll = num(c.ll_challenger) && num(c.ll_champion) ? ` (${(num(c.ll_challenger) / 1000).toFixed(2)} vs ${(num(c.ll_champion) / 1000).toFixed(2)})` : '';
      const n = plural(num(c.n), 'answer');
      if (c.verdict === 'better' && num(c.auto)) return { source: 'Map', what: `Shadow test: the new rule predicts your answers better on ${n}${ll}; switched to it automatically (Undo puts the old one back)`, who: auto };
      if (c.verdict === 'better') return { source: 'Map check', what: `Shadow test: the new rule predicts your answers better on ${n}${ll}; tap Switch on the map's Tidy`, who: auto };
      if (num(c.live) && c.verdict !== 'better') return { source: 'Map check', what: `Shadow test: the rule you switched to is no longer clearly better on ${n}${ll}; Switch back is on the map's Tidy`, who: auto };
      if (c.verdict === 'not_better') return { source: 'Map check', what: `Shadow test: the new rule was not better on ${n}${ll}; kept the current one`, who: auto };
      return { source: 'Map check', what: r.detail || `Shadow test of ${rule}: no verdict yet on ${n}`, who: auto };
    }
    case 'starting_guess': {
      if (st === 'failed') return { source: 'Map check', what: 'Starting guess: learning it from your first answers failed, it tries again tonight', who: auto };
      if (num(c.changed)) return { source: 'Map', what: `${r.detail || `Starting guess ${num(c.to) > num(c.from) ? 'raised' : 'lowered'} from ${num(c.from)}% to ${num(c.to)}% from your first answers`}${num(c.rescored) ? `; ${plural(num(c.rescored), 'colour')} re-read` : ''}`, who: auto };
      return { source: 'Map check', what: `Starting guess checked: ${num(c.to)}% from ${plural(num(c.n), 'first answer')}, unchanged`, who: auto };
    }
    case 'habits_recount': {
      // Look-alike swaps kept only for real confusions (patterns.js recountHabits).
      if (st === 'failed') return { source: 'Map', what: 'Habits recount failed, it tries again at the next profile slot', who: auto };
      if (!num(c.retired)) return { source: 'Map', what: `Habits recount: every "mixed up two look-alikes" (${num(c.after)}) is a real mix-up, nothing changed`, who: auto };
      return { source: 'Map', what: `Habits recount: "mixed up two look-alikes" ${num(c.before)} to ${num(c.after)} (${plural(num(c.retired), 'miss', 'misses')} that were not mix-ups); profile rebuilt (undo puts it back)`, who: auto };
    }
    case 'card_tray': {
      // Card ratings whose card no topic names go to the tray for Claude to place (anki-reviews.js).
      if (st === 'failed') return { source: 'Cards', what: 'Card ratings with no topic could not be sent to the tray, it tries again', who: auto };
      const bits = [];
      if (num(c.queued)) bits.push(`${plural(num(c.queued), 'card rating')} sent to the tray (no topic names the card yet)`);
      if (num(c.found)) bits.push(`${plural(num(c.found), 'missing Cards page rating')} read again from Anki`);
      return { source: 'Cards', what: `${bits.join('; ') || 'No card ratings waiting'}: once Claude places a card, its earlier ratings count`, who: auto };
    }
    case 'pictures': {
      // A picture on every topic (auto-pictures.js): a day's runs in one line, failures and the spend cap their own.
      if (st === 'failed') return { source: 'Map', what: `Pictures: ${plural(num(c.n), 'topic')} could not be looked up (Anki or Claude failed), tried again in an hour`, who: auto };
      if (st === 'held') return { source: 'Map', what: "Pictures: unclear matches wait for Claude's daily limit", who: auto };
      const from = `AnKing tables ${num(c.anking)}, AnKing cards ${num(c.cards)}, NBME ${num(c.nbme)}`;
      const bits = [`${plural(num(c.got), 'topic')} got a picture (${from})`, `${num(c.none)} had none that matched`];
      if (num(c.ai)) bits.push(`${num(c.ai)} unclear checked by Claude`);
      if (num(c.left)) bits.push(`${num(c.left)} left to look at`);
      return { source: 'Map', what: `Pictures: ${bits.join(', ')}`, who: auto };
    }
    case 'concepts': {
      if (ref === 'apply') {
        if (st === 'failed') return { source: 'Map', what: 'Root causes: placing concepts under your misses failed, it tries again next hour', who: auto };
        const bits = [`${plural(num(c.applied), 'miss', 'misses')} tied to the concept underneath`];
        if (num(c.links)) bits.push(`${plural(num(c.links), 'new line')} from a concept to a topic (proposed)`);
        if (num(c.queued)) bits.push(`${plural(num(c.queued), 'new concept')} for Claude to place`);
        if (num(c.named)) bits.push(`${plural(num(c.named), 'waiting concept')} found on your map and taken off the queue`);
        if (num(c.skipped)) bits.push(`${num(c.skipped)} already counted or gone`);
        return { source: 'Map', what: `Root causes: ${bits.join(', ')}${num(c.batches) ? ' (undo puts it back)' : ''}`, who: auto };
      }
      const head = ref === 'dry' ? 'Root-cause back-fill, dry run (nothing changed yet)' : ref === 'undo' ? 'Root-cause back-fill undone' : 'Root-cause back-fill';
      if (st === 'failed') return { source: 'Map', what: `${head} failed`, who: auto };
      if (ref === 'undo') return { source: 'Map', what: `${head}: ${plural(num(c.undone), 'batch', 'batches')} put back`, who: auto };
      if (st === 'held' && !num(c.judged) && !num(c.reused)) return { source: 'Map', what: `${head} waits for Claude's daily limit`, who: auto };
      const bits = [`${plural(num(c.judged) + num(c.reused), 'miss or belief', 'misses and beliefs')} read`, `${num(c.concepts)} rest on a concept`];
      if (ref !== 'dry') bits.push(`${num(c.applied)} tied to it now`, `${num(c.queued)} new concepts for Claude to place`);
      if (num(c.left)) bits.push(`${num(c.left)} left to read`);
      if (st === 'held') bits.push("the rest wait for Claude's daily limit");
      return { source: 'Map', what: `${head}: ${bits.join(', ')}${ref === 'run' && num(c.batches) ? ' (undo puts it back)' : ''}`, who: auto };
    }
    case 'card_roots': {
      // The one-off repair (card-roots.js): cards on root-cause topics (foundation concepts) moved to their clinical topics.
      if (st === 'failed') return { source: 'Map', what: `Moving cards off root-cause topics failed${r.detail ? ` (${r.detail})` : ''}; it runs again on the next deploy`, who: auto };
      const more = num(c.unplaced) ? ` ${plural(num(c.unplaced), 'card')} named no clinical topic, so only taken off.` : '';
      return { source: 'Map', what: `Cards on root-cause topics moved to their clinical topics: ${num(c.moved)} (undo puts them back).${more}`, who: auto };
    }
    case 'clusters': {
      if (ref === 'names') {
        if (st === 'failed') return { source: 'Map', what: 'Clusters: naming the new ones failed; they keep a name from their root', who: auto };
        return { source: 'Map', what: `Clusters named: ${r.detail || plural(num(c.named), 'cluster')}`, who: auto };
      }
      if (st === 'failed') return { source: 'Map', what: 'Clusters: finding the groups of topics you mix up failed, it tries again tomorrow night', who: auto };
      if (!num(c.found)) return { source: 'Map', what: `Clusters: none found${num(c.gone) ? `, ${plural(num(c.gone), 'old one')} gone` : ''}; your mix-ups do not group yet`, who: auto };
      const [fresh, top] = String(r.detail || '').split(' | ').map(x => x.trim());
      const bits = [`${num(c.found)} found`];
      if (num(c.fresh)) bits.push(`${num(c.fresh)} new: ${fresh || 'a new one'}${num(c.top_new) ? ', costing you most' : ''}`);
      if (top && !num(c.top_new)) bits.push(`costing you most: ${top}`);
      if (num(c.gone)) bits.push(`${plural(num(c.gone), 'old one')} gone`);
      if (num(c.naming)) bits.push('names for the new ones on their way');
      return { source: 'Map', what: `Clusters: ${bits.join(', ')}`, who: auto };
    }
    case 'ai_batch': {
      // The Message Batches API (claude.js batchTick): a day's batches in one line, a batch that could not be sent its own.
      if (ref === 'unsent') return { source: 'Claude', what: `${plural(num(c.n), 'batched call')} could not be sent as a batch: each job asked directly instead`, who: auto };
      if (st === 'failed') return { source: 'Claude', what: 'Batches could not be read back, tried again each minute', who: auto };
      const bits = [`${plural(num(c.sent), 'call')} sent`, `${num(c.done)} answered`];
      if (num(c.failed)) bits.push(`${num(c.failed)} asked directly instead`);
      if (num(c.cents)) bits.push(`$${(num(c.cents) / 100).toFixed(2)} at half price`);
      return { source: 'Claude', what: `Batches: ${bits.join(', ')}`, who: auto };
    }
    case 'ai_cost': {
      // The week's AI spend and cache use (ai-cost.js), from the usage rows.
      if (st === 'failed') return { source: 'Claude', what: "The week's AI spend could not be added up", who: auto };
      const bits = [`$${(num(c.cents) / 100).toFixed(2)} over ${plural(num(c.calls), 'call')}`, `${num(c.hit)}% of input read from the cache`];
      if (num(c.batch)) bits.push(`${num(c.batch)} by batch (saved $${(num(c.saved_cents) / 100).toFixed(2)})`);
      if (c.top && c.top !== 'none') bits.push(`most: ${c.top}`);
      return { source: 'Claude', what: `AI last 7 days: ${bits.join(', ')}`, who: auto };
    }
    case 'nbme_check': {
      // An exam block's answers checked from their batch (analyze.js sweepBatched): one line a block, added up.
      if (st === 'failed') return { source: 'Exam', what: `Exam answers check failed on ${plural(num(c.n), 'question')}, will retry`, who: auto };
      return { source: 'Exam', what: `Exam answers checked from their batch: ${plural(num(c.checked), 'question')}`, who: auto };
    }
    case 'fact_check': {
      // The nightly fact check (map_rules fact_check): its own words, "Corrected 1 card: ..." or "4 cards and 2 lessons checked, nothing wrong".
      const d = String(r.detail || 'done');
      return { source: 'Claude', what: `Fact check: ${d.charAt(0).toUpperCase()}${d.slice(1)}`, who: 'Claude, the nightly session' };
    }
    case 'card_fix': {
      if (ref === 'review') {
        const sus = num(c.suspended);
        const kinds = [['low_yield', 'low yield'], ['duplicate', 'duplicate'], ['wrong', 'wrong']].filter(([k]) => num(c[k]));
        const why = !sus || !kinds.length ? '' : kinds.length === 1 ? ` (${kinds[0][1]})` : ` (${kinds.map(([k, w]) => `${num(c[k])} ${w}`).join(', ')})`;
        const bits = [`${num(c.rewritten)} rewritten`, `${sus} suspended${why}`, `${num(c.kept)} kept`];
        return { source: 'Cards', what: `Cards reviewed by Claude: ${bits.join(', ')}; "undo that" puts one back`, who: 'Claude, the nightly session' };
      }
      if (ref === 'queue') {
        if (st === 'failed') return { source: 'Cards', what: 'Cards for Claude: leeches and slow cards could not be read from Anki Voice, it tries again in 10 minutes', who: auto };
        if (st === 'held') return { source: 'Cards', what: `Cards for Claude: waiting (${r.detail || 'an update is needed'})`, who: auto };
        const found = num(c.leeches) + num(c.slow);
        const head = found ? `${plural(num(c.leeches), 'leech', 'leeches')} and ${plural(num(c.slow), 'slow card')} queued for Claude tonight` : 'No new leeches or slow cards tonight';
        return { source: 'Cards', what: `${head} (${num(c.waiting)} waiting in all)`, who: auto };
      }
      if (st === 'failed') return { source: 'Cards', what: 'A skipped card could not be sent to Claude; it is still buried for today', who: auto };
      if (st === 'held') return { source: 'Cards', what: `Skipped cards: ${r.detail || 'waiting for an update of the hub'}`, who: auto };
      const bits = [`${plural(num(c.skipped), 'skipped card')} sent to Claude to look at tonight`];
      if (num(c.not_now)) bits.push(`${num(c.not_now)} just not now`);
      if (num(c.undone)) bits.push(`${num(c.undone)} undone`);
      return { source: 'Cards', what: bits.join(', '), who: 'you, with Skip' };
    }
    case 'nightly_session':
      // The nightly scheduled Claude session's summary (map_overview {note}), in its own words, symbols taken out.
      return { source: 'Claude', what: `Nightly review: ${r.detail || 'done'}`, who: 'Claude, the nightly session' };
    case 'forecast': {
      if (ref === 'check') {
        const so_far = num(c.n) ? `; ${num(c.in80)} of ${plural(num(c.n), 'form')} inside the 80% range, off by ${num(c.mae)} on average` : '';
        const d = num(c.actual) - num(c.pred);
        const how = d === 0 ? 'spot on' : `${Math.abs(d)} ${d > 0 ? 'higher' : 'lower'}`;
        return { source: 'Forecast', what: c.kind === 'pct'
          ? `${c.label || 'A form'}: forecast ${num(c.pred)}, your percent reads as ${num(c.actual)} (${how})${so_far}`
          : `${c.label || 'A form'}: forecast ${num(c.pred)}, you scored ${num(c.actual)} (${how})${so_far}`, who: auto };
      }
      if (st === 'failed') return { source: 'Forecast', what: 'Score forecast could not be worked out, it tries again next hour', who: auto };
      const ch = c.change == null ? '' : num(c.change) > 0 ? `, up ${num(c.change)} this week` : num(c.change) < 0 ? `, down ${-num(c.change)} this week` : ', same as last week';
      return { source: 'Forecast', what: `Forecast ${num(c.mid)} (${num(c.low)} to ${num(c.high)})${ch}${c.rough ? ', rough' : ''}${r.detail ? `. Best next hour: ${r.detail.replace(/\.$/, '')}` : ''}`, who: auto };
    }
    case 'gap_dedupe':
      return { source: 'Gaps', what: `${plural(num(c.gaps), 'gap')} on a question already on the map joined that answer instead of counting twice`, who: auto };
    case 'bug': {
      const said = r.detail || 'a screenshot, no words';
      if (c.closed === 'dropped') return { source: 'Hub', what: `Problem report closed without a change: ${said}`, who: 'Claude Code' };
      if (c.closed) return { source: 'Hub', what: `Problem fixed: ${said}${c.fix ? ` (${c.fix})` : ''}`, who: 'Claude Code' };
      const from = c.source === 'voice' ? 'by voice in Anki Voice' : c.source === 'anki_voice' ? 'from Anki Voice' : 'from the hub';
      return { source: 'Hub', what: `Problem reported: ${said}${c.shot ? ' (with a screenshot)' : ''}`, who: `you, ${from}` };
    }
    case 'form_stamp':
      // A form_version stamp that did not save (job-log.js stampFailed): the catch-ups read it to know what to redo.
      return { source: 'Hub', what: `Could not save which form made ${FORM_WORD[ref] || 'an analysis'}${num(c.n) > 1 ? ` (${num(c.n)} times)` : ''}`, who: auto };
    case 'minute': case 'cron':
      return { source: 'Hub', what: `Background job failed: ${JOB_WORD[ref] || ref}${num(c.n) > 1 ? ` (${num(c.n)} times)` : ''}`, who: auto };
    default:
      return { source: 'Hub', what: `${String(r.job || 'job').replace(/_/g, ' ')}: ${st}`, who: auto };
  }
}
// The runs a job line already covers, so the plain table line for the same run is not shown twice.
const runRefs = (runs, job) => new Set(runs.filter(r => r.job === job && r.state !== 'failed').map(r => String(r.id).slice(job.length + 1).replace(/:(ok|held|again)$/, '')));

// ---------------------------------------------------------------- recent activity

const MAP_BATCHES = `SELECT e.batch_id, max(e.at) AS at, min(e.actor) AS actor, min(e.surface) AS surface, min(e.via) AS via, count(*) AS events, max(e.undone_by IS NOT NULL) AS undone,
    min(e.topic_id) AS topic_id, count(DISTINCT e.topic_id) AS topics,
    (SELECT e2.kind FROM map_events e2 WHERE e2.user_id = e.user_id AND e2.batch_id = e.batch_id AND e2.kind NOT IN ${QUIET_SQL} ORDER BY e2.seq LIMIT 1) AS kind,
    (SELECT e2.summary FROM map_events e2 WHERE e2.user_id = e.user_id AND e2.batch_id = e.batch_id AND e2.kind NOT IN ${QUIET_SQL} ORDER BY e2.seq LIMIT 1) AS summary
  FROM map_events e
  WHERE e.user_id = ? AND e.seq > (SELECT coalesce(max(seq), 0) FROM map_events WHERE user_id = ?) - 3000
  GROUP BY e.batch_id ORDER BY max(e.seq) DESC LIMIT 120`;

export function activityOf({ batches = [], syncs = [], judged = [], checked = [], sent = [], rated = [], recorded = [], debriefed = [],
  examBlocks = [], logs = [], docs = [], runs = [], examChecks = [], voiceGaps = [], retestsClosed = [] }) {
  const out = [];
  const add = (at, source, what, who, map = null, extra = null) => out.push({ at: Number(at), source, what: cap(what, LINE_MAX), who, ...(map ? { map } : {}), ...(extra || {}) });
  for (const b of batches) {
    if (!b.kind) continue;   // only score refreshes and bookkeeping
    const map = !b.undone && Number(b.topics) > 0 ? (Number(b.topics) === 1 ? { topic: b.topic_id } : {}) : null;
    add(b.at, sourceOf(b.kind), `${b.summary || b.kind}${b.undone ? ' (undone)' : ''}`, whereOf(b), map);
  }
  for (const s of syncs) {
    const bits = [];
    if (s.reviews) bits.push(`${plural(Number(s.reviews), 'card review')}${s.again ? ` (${s.again} Again)` : ''}`);
    if (s.checks) bits.push(plural(Number(s.checks), 'spoken answer') + ' checked');
    if (s.questions) bits.push(`${plural(Number(s.questions), 'question result')}`);
    if (!bits.length) continue;
    add(s.at, s.questions && !s.reviews && !s.checks ? 'Questions' : 'Cards', `${bits.join(', ')} on ${plural(Number(s.topics), 'topic')}`,
      s.questions && !s.reviews ? 'the hub, automatically' : 'Anki sync', Number(s.topics) > 0 ? {} : null);
  }
  for (const r of rated) {
    const bits = [`${plural(Number(r.n), 'card')} rated${r.again ? ` (${r.again} Again)` : ''}`];
    if (r.suspended) bits.push(`${r.suspended} suspended`);
    add(r.at, 'Cards', bits.join(', '), 'you, on the hub\'s Cards page');
  }
  for (const b of recorded) add(b.at, 'UWorld', `UWorld block of ${dayWord(b.day) || 'today'} recorded${b.count ? ` (${plural(Number(b.count), 'question')})` : ''}`, 'you, with the UWorld recorder');
  for (const d of debriefed) add(d.at, 'UWorld', `${plural(Number(d.n), 'UWorld question')} gone through${d.logged ? `, ${d.logged} logged to Anki` : ''} (block of ${dayWord(d.day) || '?'})`, 'Claude in Chrome');
  for (const x of examBlocks) {
    const name = cap(x.name, 60) || 'Exam';
    if (x.ended_at) add(x.ended_at, 'Exam', `${name}: block ${Number(x.idx) + 1} finished${x.scored ? ` (${x.correct ?? 0} of ${x.scored} right)` : ''}`, 'you, on the hub');
    if (x.started_at) add(x.started_at, 'Exam', `${name}: block ${Number(x.idx) + 1} started`, 'you, on the hub');
  }
  for (const l of logs) {
    if (l.kind === 'cms') add(l.at, 'Exam', `CMS ${l.what} logged${l.score != null ? ` (${Math.round(Number(l.score))}%)` : ''}`, 'you');
    else add(l.at, 'UWorld', `${plural(Number(l.n), 'UWorld question')} logged (${l.what === 'incorrect' ? 'incorrects' : 'first pass'})`, 'you');
  }
  for (const d of docs) {
    add(d.created_at, 'Library', `PDF added: ${d.title}`, 'you, in the Library');
    if (d.indexed_at) add(d.indexed_at, 'Library', `PDF ready to search: ${d.title}`, 'the hub, automatically');
  }
  const judgedRuns = runRefs(runs, 'uworld_judge'), checkedRuns = runRefs(runs, 'anki_check');
  for (const j of judged) {
    if (judgedRuns.has(String(j.block_id))) continue;   // its job line says more
    add(j.at, 'UWorld', `UWorld block${j.day ? ` of ${dayWord(j.day)}` : ''} judged${j.count ? ` (${plural(Number(j.count), 'question')})` : ''}`, 'the hub, automatically');
  }
  for (const c of checked) {
    if (checkedRuns.has(String(c.id))) continue;
    const bits = [plural(num(c.cards), 'card')];
    if (num(c.gaps) || num(c.shaky)) bits.push(plural(num(c.gaps), 'gap'), `${num(c.shaky)} shaky`); else bits.push('no gaps');
    add(c.at, 'Anki', `Anki check: ${bits.join(', ')}`, SESSION_WHERE[c.device] || 'Anki');
  }
  for (const r of runs) {
    if (!RUN_JOBS.includes(r.job)) continue;
    const l = jobLine(r);
    const extra = r.state !== 'ok' ? { state: r.state, ...(r.detail && r.state !== 'held' ? { detail: cap(r.detail, 120) } : {}) } : null;
    add(r.at, l.source, l.what, l.who, null, extra);
  }
  // Read straight from their tables: an exam's answers checked (counts only: a sitting's right and wrong stay hidden
  // until it ends), missed cards Anki Voice sent, and re-tests closed by their card or a lesson.
  for (const x of examChecks) {
    const done = num(x.n) - num(x.errors);
    add(x.at, 'Exam', `${cap(x.name, 60) || 'Exam'}: ${plural(done, 'answer')} checked${num(x.errors) ? `, ${num(x.errors)} could not be checked` : ''}`, 'the hub, automatically',
      null, num(x.errors) ? { state: done ? 'fallback' : 'failed' } : null);
  }
  for (const g of voiceGaps) add(g.at, 'Anki Voice', `Anki Voice sent ${plural(num(g.n), 'missed card')} to your map`, 'Anki Voice');
  for (const r of retestsClosed) {
    add(r.at, 'Cards', r.done_by === 'card' ? `First answer on ${plural(num(r.n), 'card')} from your misses: ${num(r.got)} right, ${num(r.n) - num(r.got)} missed`
      : `${plural(num(r.n), 'miss', 'misses')} checked again in a lesson's final case: ${num(r.got)} right, ${num(r.n) - num(r.got)} missed`, 'the hub, automatically');
  }
  for (const o of sent) add(o.at, o.kind === 'onenote' ? 'OneNote' : 'Anki', `${plural(Number(o.n), 'item')} sent to ${OUTBOX_TO[o.kind] || 'Anki'}`, 'the hub, automatically');
  return collapseRepeats(out.filter(x => Number.isFinite(x.at) && x.at > 0).sort((a, b) => b.at - a.at)).slice(0, ACTIVITY_MAX);
}

// The same line again and again within half an hour (a gap noted on every save of a session, 27 Oct) is one line,
// at its newest time, with how many times it happened.
function collapseRepeats(items) {
  const out = [], seen = new Map();
  for (const x of items) {
    const k = `${x.source}|${x.what}|${x.who}`, prev = seen.get(k);
    if (prev && prev.first - x.at <= 30 * 60_000) { prev.n++; prev.first = x.at; continue; }
    const row = { ...x };
    seen.set(k, Object.defineProperties(row, { n: { value: 1, writable: true, enumerable: false }, first: { value: x.at, writable: true, enumerable: false } }));
    out.push(row);
  }
  return out.map(x => (x.n > 1 ? { at: x.at, source: x.source, what: cap(`${x.what} (×${x.n})`, LINE_MAX), who: x.who, ...(x.map ? { map: x.map } : {}),
    ...(x.state ? { state: x.state } : {}), ...(x.detail ? { detail: x.detail } : {}) } : x));
}

/** GET /api/recent: {now, activity, jobs, summary}; ?part=jobs: {now, jobs, summary}. One batch either way. */
export async function recentActivity(env, user, { now = Date.now(), part = null } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const mine = user === MO;
  if (part === 'jobs') {
    const jobs = mine ? await readJobs(env, now) : [];
    return { now, jobs, summary: jobsSummary(jobs) };
  }
  const week = now - 7 * DAY_MS;
  const reads = {
    batches: q(MAP_BATCHES, user, user),
    syncs: q(`SELECT updated_at AS at, count(DISTINCT topic_id) AS topics, sum(kind = 'card_review') AS reviews, sum(kind = 'card_review' AND rating = 'again') AS again,
         sum(kind = 'card_check') AS checks, sum(kind = 'question') AS questions
       FROM evidence WHERE user_id = ? AND updated_at >= ? AND held = 0 AND kind IN ('card_review', 'card_check', 'question')
         AND created_at = updated_at
       GROUP BY updated_at ORDER BY updated_at DESC LIMIT 30`, user, week),
  };
  if (mine) {
    Object.assign(reads, {
      judged: q(`SELECT j.block_id, coalesce(j.done_at, j.updated_at) AS at, b.day, b.count FROM uworld_judging j LEFT JOIN uworld_blocks b ON b.id = j.block_id
         WHERE j.user_id = ? AND j.status = 'done' AND coalesce(j.done_at, j.updated_at) >= ? ORDER BY at DESC LIMIT 10`, MO, week),
      checked: q(`SELECT s.id, s.updated_at AS at, s.device, (SELECT count(*) FROM anki_cards c WHERE c.session_id = s.id) AS cards,
           (SELECT count(*) FROM anki_cards c WHERE c.session_id = s.id AND c.verdict = 'gap') AS gaps,
           (SELECT count(*) FROM anki_cards c WHERE c.session_id = s.id AND c.verdict = 'shaky') AS shaky
         FROM anki_sessions s WHERE s.status = 'checked' AND s.updated_at >= ? AND ${SPOKEN} ORDER BY s.updated_at DESC LIMIT 10`, week),
      sent: q(`SELECT kind, count(*) AS n, max(done_at) AS at FROM outbox WHERE status = 'done' AND done_at >= ?
         GROUP BY kind, done_at / 600000 ORDER BY at DESC LIMIT 10`, week),
      // Ratings on the hub's Cards page, by the ten minutes they fall in.
      rated: q(`SELECT max(at) AS at, sum(kind = 'rate') AS n, sum(kind = 'rate' AND ease = 1) AS again, sum(kind = 'suspend') AS suspended
         FROM card_rates WHERE user_id = ? AND at >= ? AND status IN ('sent', 'applied') GROUP BY at / 600000 ORDER BY at DESC LIMIT 20`, MO, week),
      recorded: q(`SELECT created_at AS at, day, count FROM uworld_blocks WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10`, week),
      debriefed: q(`SELECT max(r.reviewed_at) AS at, count(*) AS n, sum(r.logged_at IS NOT NULL) AS logged, b.day FROM uworld_reviews r LEFT JOIN uworld_blocks b ON b.id = r.block_id
         WHERE r.user_id = ? AND r.reviewed_at >= ? GROUP BY r.block_id, r.reviewed_at / 1800000 ORDER BY at DESC LIMIT 10`, MO, week),
      examBlocks: q(`SELECT s.name, b.idx, b.started_at, b.ended_at, b.correct, b.scored FROM blocks b JOIN sittings s ON s.id = b.sitting_id
         WHERE b.started_at >= ? OR b.ended_at >= ? ORDER BY coalesce(b.ended_at, b.started_at) DESC LIMIT 10`, week, week),
      logs: q(`SELECT * FROM (SELECT 'uworld' AS kind, created_at AS at, n, kind AS what, NULL AS score FROM uworld_log WHERE created_at >= ?
         UNION ALL SELECT 'cms' AS kind, created_at AS at, NULL AS n, subject || ' form ' || form AS what, score_pct AS score FROM cms_log WHERE created_at >= ?)
         ORDER BY at DESC LIMIT 10`, week, week),
      docs: q(`SELECT title, created_at, indexed_at FROM library_docs WHERE user_id = ? AND (created_at >= ? OR indexed_at >= ?) ORDER BY created_at DESC LIMIT 10`, MO, week, week),
      // Every background job's own lines (job-log.js), and the lines read from their tables (activityOf).
      runs: q(`SELECT id, job, ref, state, counts_json, detail, at FROM job_runs WHERE user_id = ? AND at >= ? ORDER BY at DESC LIMIT 60`, MO, week),
      examChecks: q(`SELECT s.name, count(*) AS n, sum(a.status = 'error') AS errors, max(a.created_at) AS at FROM analyses a JOIN blocks b ON b.id = a.block_id
         JOIN sittings s ON s.id = b.sitting_id WHERE a.status IN ('done', 'error') AND a.created_at >= ? GROUP BY s.id, a.created_at / 3600000 ORDER BY at DESC LIMIT 10`, week),
      voiceGaps: q(`SELECT max(created_at) AS at, count(*) AS n FROM gaps WHERE user_id = ? AND source = 'anki_voice' AND created_at >= ?
         GROUP BY created_at / 1800000 ORDER BY at DESC LIMIT 10`, MO, week),
      retestsClosed: q(`SELECT done_by, count(*) AS n, sum(result = 'got_it') AS got, max(done_at) AS at FROM retests WHERE user_id = ? AND done_at >= ? AND done_by IN ('card', 'lesson')
         GROUP BY done_by, done_at / 1800000 ORDER BY at DESC LIMIT 10`, MO, week),
    });
  }
  const names = Object.keys(reads);
  const jobNamed = mine ? jobStatements(env, now) : {};
  const rows = await batchSoft(env, [...names.map(k => reads[k]), ...(mine ? JOB_NAMES.map(k => jobNamed[k]) : [])]);
  const got = Object.fromEntries(names.map((k, i) => [k, rows[i]]));
  const activity = activityOf(got);
  const jobs = mine ? jobsOf(Object.fromEntries(JOB_NAMES.map((k, i) => [k, rows[names.length + i]])), now) : [];
  return { now, activity, jobs, summary: jobsSummary(jobs) };
}

export async function recentRoute(request, env, ctx, params, url, user) {
  const part = url.searchParams.get('part');
  if (part != null && part !== 'jobs') throw new HttpError(400, 'part is jobs, or leave it out.');
  return json(await recentActivity(env, user, { part }), 200);
}
