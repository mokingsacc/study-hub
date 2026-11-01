import { json, readJson, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { junkSaid } from './hygiene.js';
import { FORMS_SQL, fakeQuotes } from './forms-check.js';
import { ROOT_SQL } from './card-roots.js';

const MO = 'mo';

export const CHECKS = [
  { id: 'I1', name: 'one answer row per answer', plain: 'Every answer has its row on the map', unit: ['answer without its row', 'answers without their row'] },
  { id: 'I2', name: 'one miss per question', plain: 'One miss per question', unit: ['duplicate miss', 'duplicate misses'] },
  { id: 'I3', name: 'one gap per card and rating', plain: 'One gap per card rating, no doubled topic names', unit: ['duplicate gap', 'duplicate gaps'] },
  { id: 'I4', name: 'his words only', plain: 'Only your own words kept as what you said', unit: ['"said" that is not his words', '"said"s that are not his words'] },
  { id: 'I5', name: 'look-alike only from a real confusion', plain: 'Look-alike marks only where your words show a mix-up', unit: ['look-alike penalty without a confusion', 'look-alike penalties without a confusion'] },
  { id: 'I6', name: 'card gaps placed within an hour', plain: 'Card gaps get a topic within an hour', unit: ['card gap without a topic', 'card gaps without a topic'] },
  { id: 'I7', name: 'real answer times', plain: 'Answers dated when they happened', unit: ['answer stamped at noon', 'answers stamped at noon'] },
  { id: 'I8', name: 'card ratings on the map', plain: 'Every card rating reaches the map', unit: ['card rating missing', 'card ratings missing'] },
  { id: 'I9', name: 'colours not resting on look-alike penalties', plain: 'No colour rests on look-alike marks alone', unit: ['colour from look-alike penalties alone', 'colours from look-alike penalties alone'] },
  { id: 'I10', name: 'AI analyses complete and quotes real', plain: 'AI analyses complete, quoting only your own words', unit: ['analysis item missing a part or quote', 'analysis items missing a part or quote'] },
  { id: 'I11', name: 'answer forms consistent', plain: 'Error type fits cause; quotes yours; look-alike only for mix-ups', unit: ['answer form that contradicts itself', 'answer forms that contradict themselves'] },
  { id: 'I12', name: 'root causes hold only concept rows', plain: 'Cards and answers sit on clinical topics, not root causes', unit: ['card or answer on a root cause', 'cards or answers on root causes'] },
  { id: 'F', name: 'scores fresh', plain: 'Scores up to date with their evidence', unit: ['stale score', 'stale scores'] },
];
// The sub-checks the data clean-up (hygiene.js) puts right, by its part. Every other one is only noted: the noon
// stamps of old blocks have no real time to take, and a near-identical name or a missing topic needs a person's eye.
export const FIXED_BY = { block_answer_not_on_map: 'blocks', duplicate_miss: 'misses', duplicate_gap: 'gaps', said_stock: 'said', said_window: 'said', said_repeated: 'said',
  mixed_no_confusion: 'forms', quote_not_his: 'forms' };
export const INTEGRITY = { examples: 5, history: 30, stale_ms: 3_600_000, said_days: 30, line_max: 220 };
const HOUR = 3_600_000, DAY = 86_400_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// Each sub-check is one SELECT of an example column x; the count and the first few examples come from one statement.
const counted = (sql, n = INTEGRITY.examples) => `SELECT (SELECT count(*) FROM (${sql})) AS n, (SELECT group_concat(x, ' · ') FROM (SELECT x FROM (${sql}) LIMIT ${n})) AS ex`;
const LABEL = "coalesce(json_extract(e.detail_json, '$.label'), e.obs_key)";
const REAL_CONFUSION = "(m.cause = 'confusion' AND (coalesce(m.cause_quote, '') <> '' OR m.cause_inferred = 0))";
const ANSWERED = "(json_extract(j.value, '$.result') IN ('right', 'wrong', 'omitted') OR json_extract(j.value, '$.verdict') IN ('wrong', 'right_flawed', 'sound'))";

// ?1 user, ?2 now. [check id, sub-check, sql]
export const SUBCHECKS = [
  ['I1', 'miss_without_row', `SELECT m.label AS x FROM misses m WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND m.held = 0
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.slot = 0 AND (e.obs_key = m.id OR e.miss_id = m.id))`],
  ['I1', 'row_of_deleted_miss', `SELECT ${LABEL} AS x FROM evidence e JOIN misses m ON m.id = e.miss_id
    WHERE e.user_id = ?1 AND e.slot = 0 AND m.deleted_at IS NOT NULL`],
  ['I1', 'block_answer_not_on_map', `SELECT 'UW ' || b.day || ' Q' || json_extract(j.value, '$.q') AS x
    FROM uworld_blocks b, json_each(CASE WHEN json_valid(b.questions_json) THEN b.questions_json ELSE '[]' END) j
    WHERE ?1 = '${MO}' AND ${ANSWERED}
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.slot = 0 AND e.source_ref = 'uworld:' || b.id || ':q' || json_extract(j.value, '$.q'))
      AND NOT EXISTS (SELECT 1 FROM misses m WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND m.uworld_block_id = b.id AND m.uworld_q = json_extract(j.value, '$.q'))`],
  ['I2', 'duplicate_miss', `SELECT a.label || ' (' || min(a.day, b.day) || ', ' || max(a.day, b.day) || ')' AS x FROM misses a JOIN misses b ON b.user_id = a.user_id AND b.uw_qid = a.uw_qid AND b.id > a.id
    WHERE a.user_id = ?1 AND a.uw_qid IS NOT NULL AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND a.held = 0 AND b.held = 0
      AND abs(julianday(a.day) - julianday(b.day)) <= 14
      AND NOT (a.uworld_block_id IS NOT NULL AND b.uworld_block_id IS NOT NULL AND a.uworld_block_id <> b.uworld_block_id)`],
  ['I3', 'duplicate_gap', `SELECT 'card ' || a.card_id || ' (' || a.day || ')' AS x FROM gaps a JOIN gaps b ON b.user_id = a.user_id AND b.card_id = a.card_id AND b.id > a.id
    WHERE a.user_id = ?1 AND a.card_id IS NOT NULL AND (abs(a.at - b.at) <= 5000 OR (a.review_id IS NOT NULL AND a.review_id = b.review_id))`],
  ['I3', 'parent_child_lookalike', `SELECT ta.name || ' / ' || tb.name AS x FROM links l
    JOIN topics ta ON ta.user_id = l.user_id AND ta.id = l.from_id JOIN topics tb ON tb.user_id = l.user_id AND tb.id = l.to_id
    WHERE l.user_id = ?1 AND l.type = 'versus' AND l.status IN ('active', 'proposed')
      AND (ta.parent_id = tb.id OR tb.parent_id = ta.id OR instr(lower(tb.name), lower(ta.name)) > 0 OR instr(lower(ta.name), lower(tb.name)) > 0)`],
  ['I5', 'support_without_confusion', `SELECT coalesce(m.label, ls.obs_key) AS x FROM link_support ls JOIN misses m ON m.id = ls.miss_id
    WHERE ls.user_id = ?1 AND ls.cw > 0 AND ls.held = 0 AND m.deleted_at IS NULL AND NOT ${REAL_CONFUSION}`],
  ['I5', 'penalty_without_confusion', `SELECT ${LABEL} AS x FROM evidence e JOIN misses m ON m.id = e.miss_id
    WHERE e.user_id = ?1 AND e.kind = 'confused_with' AND e.held = 0 AND NOT ${REAL_CONFUSION}`],
  ['I6', 'card_gap_unplaced', `SELECT 'card ' || card_id || ' (' || day || ')' AS x FROM gaps
    WHERE user_id = ?1 AND card_id IS NOT NULL AND topic_id IS NULL AND held = 0 AND at < ?2 - ${HOUR}`],
  ['I7', 'noon_stamp', `SELECT ${LABEL} AS x FROM evidence e WHERE e.user_id = ?1 AND e.held = 0 AND e.slot = 0 AND e.kind IN ('question', 'retest')
    AND e.obs_key NOT LIKE 'hub:%' AND (e.at % ${DAY}) BETWEEN 43200000 AND 43260000`],
  ['I8', 'card_rating_missing', `SELECT 'card ' || r.card_id AS x FROM card_rates r WHERE r.user_id = ?1 AND r.kind = 'rate' AND r.status = 'applied'
    AND r.at BETWEEN ?2 - ${14 * DAY} AND ?2 - ${HOUR}
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.card_id = r.card_id AND e.kind = 'card_review' AND e.at BETWEEN r.at - ${DAY} AND r.at + ${DAY})`],
  // A rating whose card no topic names waits in the tray (anki-reviews.js) until Claude places the card: flagged after a day.
  ['I8', 'card_rating_in_tray', `SELECT 'card ' || r.card_id AS x FROM card_rates r WHERE r.user_id = ?1 AND r.kind = 'rate' AND r.status = 'applied'
    AND r.at BETWEEN ?2 - ${14 * DAY} AND ?2 - ${DAY}
    AND EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.card_id = r.card_id AND e.kind = 'card_review' AND e.at BETWEEN r.at - ${DAY} AND r.at + ${DAY})
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.card_id = r.card_id AND e.kind = 'card_review' AND e.topic_id IS NOT NULL
      AND e.at BETWEEN r.at - ${DAY} AND r.at + ${DAY})`],
  ['I9', 'colour_from_penalties', `SELECT t.name AS x FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
    WHERE s.user_id = ?1 AND s.band <> 'unseen'
      AND EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.topic_id = s.topic_id AND e.held = 0 AND e.kind = 'confused_with')
      AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.topic_id = s.topic_id AND e.held = 0 AND e.kind <> 'confused_with')`],
  ['I9', 'why_says_picked', `SELECT t.name AS x FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
    WHERE s.user_id = ?1 AND s.why_json LIKE '%picked as the look-alike%'`],
  // I12: a foundation concept takes only concept rows (concepts.js); POST /api/map/card-roots/repair moves the cards.
  ['I12', 'card_link_on_root', `SELECT 'card ' || ct.card_id || ' on ' || t.name AS x FROM card_topics ct JOIN topics t ON t.user_id = ct.user_id AND t.id = ct.topic_id
    WHERE ct.user_id = ?1 AND ct.removed_at IS NULL AND ${ROOT_SQL('t')}`],
  ['I12', 'card_row_on_root', `SELECT 'card ' || e.card_id || ' on ' || t.name AS x FROM evidence e JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id
    WHERE e.user_id = ?1 AND e.kind LIKE 'card%' AND ${ROOT_SQL('t')}`],
  ['I12', 'miss_on_root', `SELECT m.label || ' on ' || t.name AS x FROM misses m JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id
    WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND ${ROOT_SQL('t')}`],
  ['I12', 'gap_on_root', `SELECT coalesce(g.topic, g.id) || ' on ' || t.name AS x FROM gaps g JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id
    WHERE g.user_id = ?1 AND ${ROOT_SQL('t')}`],
  ['F', 'score_older_than_evidence', `SELECT t.name AS x FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
    WHERE s.user_id = ?1 AND s.computed_at < (SELECT max(e.updated_at) FROM evidence e WHERE e.user_id = ?1 AND e.topic_id = s.topic_id AND e.held = 0) - ${INTEGRITY.stale_ms}`],
  ['F', 'colour_without_evidence', `SELECT t.name AS x FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
    WHERE s.user_id = ?1 AND s.band <> 'unseen' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ?1 AND e.topic_id = s.topic_id AND e.held = 0)`],
];
// I10 reads ai_audits (0064) in its own statement, so a database without the table still runs every other check.
export const AUDIT_DAYS = 7;
export const AUDIT_SQL = `SELECT a.job || coalesce(' ' || a.ref, '') || ': ' || json_extract(j.value, '$.id') AS x
    FROM ai_audits a, json_each(CASE WHEN json_valid(a.failing_json) THEN a.failing_json ELSE '[]' END) j
    WHERE a.user_id = ?1 AND a.at >= ?2 - ${AUDIT_DAYS * DAY}`;
const SAID_SQL = `SELECT g.id, g.said, g.card_id, c.session_id, c.n, c.shown_at, c.revealed_at, c.answered_at, c.before_json, c.after_json, s.started_at
  FROM gaps g LEFT JOIN anki_cards c ON g.id = 'anki:' || c.session_id || ':' || c.n LEFT JOIN anki_sessions s ON s.id = c.session_id
  WHERE g.user_id = ?1 AND g.said IS NOT NULL AND g.said <> '' AND g.at >= ?2`;
const TOPICS_SQL = "SELECT id, name FROM topics WHERE user_id = ?1 AND status IN ('proposed', 'confirmed')";

/** A topic name as compared for near-duplicates: lower case, letters and digits only, a plural s off. Pure. */
export const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(?<=[a-z]{3})s$/, '');
/** Pairs of live topics whose names are the same but for spaces, hyphens, case or a plural (pure): [[a, b]]. */
export function nearNames(topics) {
  const by = new Map(), out = [];
  for (const t of topics || []) {
    const k = nameKey(t.name);
    if (!k) continue;
    if (by.has(k)) out.push([by.get(k).name, t.name]); else by.set(k, t);
  }
  return out;
}

/**
 * The report from the sub-checks' results (pure). subs: [{check, sub, n, ex}]; prev: the last run's counts or null.
 * Returns {checks, counts, failing, total, line: {text, failing, total}}.
 */
export function buildReport(subs, prev = null) {
  const checks = CHECKS.map(c => {
    const mine = subs.filter(s => s.check === c.id);
    const n = mine.reduce((a, s) => a + (Number(s.n) || 0), 0);
    const ex = mine.flatMap(s => String(s.ex || '').split(' · ').filter(Boolean)).slice(0, INTEGRITY.examples);
    const fixed = Object.fromEntries(mine.filter(s => FIXED_BY[s.sub]).map(s => [s.sub, FIXED_BY[s.sub]]));
    return { id: c.id, name: c.name, plain: c.plain, n, ...(prev && prev[c.id] != null ? { was: Number(prev[c.id]) } : {}),
      parts: Object.fromEntries(mine.map(s => [s.sub, Number(s.n) || 0])), ...(Object.keys(fixed).length ? { fixed_by: fixed } : {}), ...(ex.length ? { examples: ex } : {}) };
  });
  const counts = Object.fromEntries(checks.map(c => [c.id, c.n]));
  const failing = checks.filter(c => c.n > 0);
  const total = failing.reduce((a, c) => a + c.n, 0);
  const prevTotal = prev ? CHECKS.reduce((a, c) => a + (Number(prev[c.id]) || 0), 0) : null;
  let text;
  if (!failing.length) text = `Data checks: all ${CHECKS.length} pass.`;
  else {
    const top = [...failing].sort((a, b) => b.n - a.n).slice(0, 3).map(c => { const u = CHECKS.find(x => x.id === c.id).unit; return `${c.n} ${c.n === 1 ? u[0] : u[1]}`; });
    const trend = prevTotal == null ? '' : prevTotal === total ? ', same as last night' : `, ${total < prevTotal ? 'down' : 'up'} from ${prevTotal} last night`;
    text = `Data checks: ${failing.length} of ${CHECKS.length} flag rows: ${top.join(', ')}${failing.length > 3 ? ' and more' : ''}${trend}.`;
  }
  if (text.length > INTEGRITY.line_max) text = `${text.slice(0, INTEGRITY.line_max - 1)}…`;
  return { checks, counts, failing: failing.length, total, line: { text, failing: failing.length, total } };
}

/** Every check, worked out now, in one read batch. Returns the report (with `at`). */
export async function computeIntegrity(env, user, { now = Date.now() } = {}) {
  const DB = env.DB;
  // Each statement binds only the numbers it names (D1 refuses extra bindings).
  const stmts = [...SUBCHECKS.map(([, , sql]) => (/\?2/.test(sql) ? DB.prepare(counted(sql)).bind(user, now) : DB.prepare(counted(sql)).bind(user))),
    DB.prepare(SAID_SQL).bind(user, now - INTEGRITY.said_days * DAY), DB.prepare(TOPICS_SQL).bind(user),
    DB.prepare('SELECT counts_json FROM integrity_runs WHERE user_id = ?1 AND day < ?2 AND state = \'ok\' ORDER BY day DESC LIMIT 1').bind(user, londonDay(now))];
  const res = await DB.batch(stmts);
  const subs = SUBCHECKS.map(([check, sub], i) => ({ check, sub, ...((res[i].results || [])[0] || { n: 0, ex: null }) }));
  const said = (res[SUBCHECKS.length].results || []).map(r => ({ id: r.id, said: r.said, card_id: r.card_id, started_at: r.started_at,
    card: r.session_id != null ? { session_id: r.session_id, n: r.n, shown_at: r.shown_at, revealed_at: r.revealed_at, answered_at: r.answered_at, before_json: r.before_json, after_json: r.after_json } : null }));
  const junk = junkSaid(said);
  for (const why of ['stock', 'window', 'repeated']) {
    const hit = junk.filter(j => j.why === why);
    subs.push({ check: 'I4', sub: `said_${why}`, n: hit.length, ex: hit.slice(0, INTEGRITY.examples).map(j => j.id).join(' · ') || null });
  }
  const near = nearNames(res[SUBCHECKS.length + 1].results || []);
  subs.push({ check: 'I3', sub: 'near_identical_topics', n: near.length, ex: near.slice(0, INTEGRITY.examples).map(p => p.join(' / ')).join(' · ') || null });
  const audit = await DB.prepare(counted(AUDIT_SQL)).bind(user, now).first().catch(e => { if (noTable(e)) return null; throw e; });
  subs.push({ check: 'I10', sub: 'analysis_incomplete', n: Number(audit && audit.n) || 0, ex: (audit && audit.ex) || null });
  for (const [sub, sql] of FORMS_SQL) {
    const r = await DB.prepare(counted(`SELECT x FROM (${sql})`)).bind(user).first().catch(e => { if (noTable(e)) return null; throw e; });
    subs.push({ check: 'I11', sub, n: Number(r && r.n) || 0, ex: (r && r.ex) || null });
  }
  const fake = await fakeQuotes(env, user, { now });
  subs.push({ check: 'I11', sub: 'quote_not_his', n: fake.length, ex: fake.slice(0, INTEGRITY.examples).map(f => f.label).join(' · ') || null });
  const prevRow = (res[SUBCHECKS.length + 2].results || [])[0];
  return { at: now, day: londonDay(now), ...buildReport(subs, prevRow ? parse(prevRow.counts_json, null) : null) };
}

async function readRun(env, user, day) {
  return env.DB.prepare('SELECT day, at, state, counts_json, report_json FROM integrity_runs WHERE user_id = ?1 AND day = ?2').bind(user, day).first();
}

export async function integrityJob(env, user, { now = Date.now(), force = false, tidy = false } = {}) {
  const day = londonDay(now);
  const lineKey = tidy ? { key: `${day}:tidy`, ref: 'tidy' } : { key: day };
  try {
    if (!force && !tidy) {
      const had = await readRun(env, user, day);
      if (had && had.state === 'ok') return { skipped: 'ran today' };
    }
    const rep = await computeIntegrity(env, user, { now });
    await env.DB.prepare(`INSERT INTO integrity_runs (user_id, day, at, state, counts_json, report_json) VALUES (?1, ?2, ?3, 'ok', ?4, ?5)
      ON CONFLICT (user_id, day) DO UPDATE SET at = excluded.at, state = excluded.state, counts_json = excluded.counts_json, report_json = excluded.report_json`)
      .bind(user, day, now, JSON.stringify(rep.counts), JSON.stringify(rep)).run();
    await noteJob(env, { job: 'integrity', user, ...lineKey, at: now, state: 'ok', detail: rep.line.text,
      counts: { failing: rep.failing, rows: rep.total, checks: CHECKS.length } });
    return { failing: rep.failing, total: rep.total, line: rep.line.text, ...(tidy ? { report: rep } : {}) };
  } catch (e) {
    if (noTable(e) && /integrity_runs/.test(String(e && e.message))) return { skipped: 'no integrity_runs table yet' };
    console.error('integrity check failed', e && e.message);
    await env.DB.prepare(`INSERT INTO integrity_runs (user_id, day, at, state) VALUES (?1, ?2, ?3, 'failed')
      ON CONFLICT (user_id, day) DO UPDATE SET at = excluded.at, state = 'failed' WHERE integrity_runs.state <> 'ok'`).bind(user, day, now).run().catch(() => {});
    await noteJob(env, { job: 'integrity', user, ...lineKey, at: now, state: 'failed', detail: e });
    return { error: (e && e.message) || String(e) };
  }
}

/** The report: the last stored run's (or worked out now when fresh, or before any run), with the counts over time. */
export async function integrityReport(env, user, { fresh = false, now = Date.now() } = {}) {
  try {
    const rows = (await env.DB.prepare('SELECT day, at, state, counts_json, report_json FROM integrity_runs WHERE user_id = ?1 ORDER BY day DESC LIMIT ?2')
      .bind(user, INTEGRITY.history).all()).results || [];
    const last = rows.find(r => r.state === 'ok');
    const rep = (!fresh && last && parse(last.report_json, null)) || await computeIntegrity(env, user, { now });
    return { kind: 'integrity', ...rep, last_run: rows[0] ? { day: rows[0].day, state: rows[0].state } : null,
      history: rows.map(r => ({ day: r.day, state: r.state, ...parse(r.counts_json, {}) })) };
  } catch (e) {
    if (noTable(e)) return { kind: 'integrity', line: { text: 'Data checks: not set up yet.', failing: 0, total: 0 }, checks: [], history: [] };
    throw e;
  }
}

/** The last run's line (null before the first run or the table): "Data checks: ...", or that last night's run failed. */
export async function integrityLineStored(env, user) {
  try {
    const r = await env.DB.prepare('SELECT day, state, report_json FROM integrity_runs WHERE user_id = ?1 ORDER BY day DESC LIMIT 1').bind(user).first();
    if (!r) return null;
    if (r.state !== 'ok') return `Data checks: the run of ${r.day} failed (Recent activity says why).`;
    const rep = parse(r.report_json, null);
    return rep && rep.line ? rep.line.text : null;
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

// GET /api/map/integrity: the report and the counts over time. ?fresh=1 works it out now (stores nothing); ?line=1 the line.
export async function integrityRoute(request, env, ctx, params, url, user) {
  if (url.searchParams.get('line') === '1') return json({ line: await integrityLineStored(env, user) });
  return json(await integrityReport(env, user, { fresh: url.searchParams.get('fresh') === '1' }));
}

export async function integrityRunRoute(request, env, ctx, params, url, user) {
  await readJson(request, 1_000).catch(() => ({}));
  const r = await integrityJob(env, user, { tidy: true });
  if (r.report) return json({ kind: 'integrity', ...r.report });
  return json({ error: r.skipped ? 'The data checks are not set up yet.' : `The data checks failed: ${r.error}` }, r.skipped ? 503 : 500);
}
