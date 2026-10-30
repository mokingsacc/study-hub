import { HttpError, json, readJson, londonDay, now as nowMs } from '../util.js';
import { MO } from '../users.js';
import { TRAPS, TRAP_KEYS, cleanTraps, recomputeHabits, refreshProfile, readProfile, safeLine, shortDay, trapLabel, NOTE_MAX } from './habits.js';
import { stemSafe, questionSafe, gapSafe, leakIndexFor } from './guard.js';
import { leaks } from '../checks.js';
import { lookAlikeHead } from './links.js';
import { addDays, daysLeft, NO_LESSON_ERRORS } from './teach-priority.js';

export const PATTERN_DAILY_USD = 1.5, RESERVE_USD = 0.8;
export const ITEMS_PER_CALL = 40, HISTORY_MISSES = 40, HISTORY_GAPS = 20, MAX_TRIES = 3;
export const MAX_MISCONCEPTIONS = 4, MAX_RECHECKS = 4, MAX_RETESTS = 3, CONTRADICTION_DAYS = 3;
export const CATCHUP_DAYS = 60, DAILY_HOUR = 23, DAILY_MINUTE = 10, PROFILE_HOURS = [6, 13, 19], PROFILE_MINUTE = 37;
export const SETTLE_MS = { uworld: 3 * 60_000, anki: 10 * 60_000, nbme: 5 * 60_000, daily: 0, catchup: 0 };
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000, STALE_MS = 15 * 60_000, RETRY_MS = 10 * 60_000, CAPPED_WAIT_MS = 30 * 60_000;
export const KINDS = ['uworld', 'anki', 'nbme', 'daily', 'catchup'];

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const json1 = v => JSON.stringify([...new Set(v)]);
export const spentKey = (day = londonDay()) => `pattern_usd:${day}`;
const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockOf = ms => { const [h, m] = LONDON.format(new Date(ms)).split(':').map(Number); return { hour: h, minute: m }; };

// ---------------------------------------------------------------- queueing (the hooks)

export async function enqueuePattern(env, user, kind, ref, { now = nowMs(), again = kind !== 'daily' && kind !== 'catchup' } = {}) {
  if (!KINDS.includes(kind) || ref == null || ref === '') return false;
  const id = `${kind}:${ref}`, next = now + (SETTLE_MS[kind] || 0);
  try {
    const conflict = again ? `DO UPDATE SET status = CASE WHEN pattern_runs.status IN ('done', 'failed') THEN 'pending' ELSE pattern_runs.status END,
        attempts = CASE WHEN pattern_runs.status IN ('done', 'failed') THEN 0 ELSE pattern_runs.attempts END,
        next_at = CASE WHEN pattern_runs.status IN ('done', 'failed') THEN excluded.next_at ELSE pattern_runs.next_at END, updated_at = excluded.updated_at` : 'DO NOTHING';
    const r = await env.DB.prepare(`INSERT INTO pattern_runs (user_id, id, kind, ref, status, next_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)
        ON CONFLICT (user_id, id) ${conflict}`).bind(user, id, kind, String(ref), next, now).run();
    return !!(r && r.meta && r.meta.changes);
  } catch (e) {
    if (!noTable(e)) console.error(JSON.stringify({ pattern_enqueue_failed: { id, error: String((e && e.message) || e).slice(0, 200) } }));
    return false;
  }
}

// ---------------------------------------------------------------- the prompt

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
const TRAP_LIST = TRAP_KEYS.map(k => `- ${k}: ${TRAPS[k].label}: ${TRAPS[k].hint}`).join('\n');

export const PATTERN_SYSTEM = `You review the newest mistakes of Mo, a learner preparing for USMLE Step 2 CK, beside his earlier ones, to find his reasoning habits. You get compact rows only: what he thought (his words, or a judge's summary of them), the rule he should have used, the look-alike, labels and counts. You never see the questions: never guess or write their content.

New items (refs n1, n2, ...) are misses (wrong, or right for a flawed reason) and gaps (a card or point he did not hold). History rows (h1, ...) are his other misses and gaps on the same topics. You also get his open misconceptions on these topics (ids mc_...), his current habits with counts, the traps already counted in each system, the profile written last time, and contradictions code found (sure and right, then sure and wrong on the same topic, or the reverse).

1. items: for every new item, the reasoning traps behind it from the fixed list below, none to two, most telling first. A trap is how his thinking went wrong, not the topic and not the missing fact itself: a plain knowledge gap with no sign of a trap gets none. Judge from his words, the judge's trap label, the error type, the step that broke and the history. note: how it showed here, in at most 20 plain words, or null.
2. habits: for each trap that recurs across topics or systems (new items and history together), one line on how it shows in him and the habit that would catch it ("goes for the trauma story first: read the drug list before the head CT"). Traps from the list only.
3. misconceptions: wrong beliefs his words show he holds, new or seen again, at most 4: ref (the new item it showed in), topic as an AMBOSS article names it, belief in one line (in quotation marks when they are his own words). A real false belief ("metastases are never lytic"), not a missing fact.
4. recheck: open misconceptions (by id) that his newer answers seem to contradict, such as a sure right answer on that point since, with why in one line. They are only marked for a re-check, never closed.
5. retests: contradictions worth an early re-test, at most 3: the ref of the miss to re-test (n or h) and why in one line. Only where a sure answer flipped, never for a misread or test-taking slip.
6. insight: one plain paragraph of at most 450 characters on how Mo reasons now, for whoever teaches him next: his strongest habits with an example ref ("UW 16048"), where he is overconfident, and what to watch for. Build on the last profile; change it only where the new items show something. No lists or symbols.
7. headline: one line of at most 120 characters when a habit is new or clearly growing in these items ("Anchoring on the first clue again: 3 of 9 misses in this block"), else null.

Write in your own words and quote only Mo's. US guidelines.

The traps (key: label: what it looks like):
${TRAP_LIST}`;

export const PATTERN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items', 'habits', 'misconceptions', 'recheck', 'retests', 'insight', 'headline'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'traps', 'note'], properties: {
      ref: { type: 'string' }, traps: { type: 'array', items: { type: 'string', enum: TRAP_KEYS } }, note: nul({ type: 'string' }) } } },
    habits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['trap', 'note'], properties: {
      trap: { type: 'string', enum: TRAP_KEYS }, note: { type: 'string' } } } },
    misconceptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'topic', 'belief'], properties: {
      ref: { type: 'string' }, topic: { type: 'string' }, belief: { type: 'string' } } } },
    recheck: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } } },
    retests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'why'], properties: { ref: { type: 'string' }, why: { type: 'string' } } } },
    insight: { type: 'string' }, headline: nul({ type: 'string' }),
  },
};

const ERR_WORDS = { knowledge_gap: 'knowledge gap', premature_closure: 'premature closure', faulty_synthesis: 'faulty synthesis', misread: 'misread', test_taking: 'test-taking',
  threshold: 'threshold or number', calculation: 'calculation' };
const GAP_WORDS = { chat: 'stated in chat', anki_voice: 'Anki Voice review', spoken_cue: 'said aloud while recording', anki_mac: 'Anki check', anki_hub: 'Anki check', anki_phone: 'Anki check' };

export function missLine(ref, m, { history = false } = {}) {
  const head = [m.result, m.confidence, m.error_type ? ERR_WORDS[m.error_type] || m.error_type : null, m.step ? `step ${m.step}` : null,
    m.flaw_kind ? m.flaw_kind.replace(/_/g, ' ') : null, m.time_s ? `${m.time_s} s` : null].filter(Boolean).join(', ');
  const parts = [`${ref} miss ${m.label || ''}, ${shortDay(m.day) || m.day}, ${m.topic || 'no topic'}${m.system ? ` (${m.system})` : ''}: ${head}.`];
  if (m.rule) parts.push(`Rule: ${cap(m.rule, history ? 140 : 200)}`);
  if (m.my_reasoning) parts.push(`He thought: ${cap(m.my_reasoning, history ? 160 : 240)}`);
  const la = lookAlikeHead(m.look_alikes);
  if (la && !history) parts.push(`Look-alike: ${cap(la, 80)}.`);
  if (m.judge_trap) parts.push(`Judge's trap: ${cap(m.judge_trap, 60)}.`);
  const traps = cleanTraps(parse(m.traps_json, []));
  if (traps.length) parts.push(`Traps: ${traps.join(', ')}.`);
  return parts.join(' ');
}

export function gapLine(ref, g, { history = false } = {}) {
  const s = gapSafe(g);
  const head = [GAP_WORDS[s.source] || String(s.source || '').replace(/_/g, ' '), s.verdict && s.verdict !== 'gap' ? s.verdict : null, s.step ? `step ${s.step}` : null, s.confidence].filter(Boolean).join(', ');
  const parts = [`${ref} gap, ${shortDay(s.day) || s.day}, ${s.topic || 'no topic'}${s.system ? ` (${s.system})` : ''}: ${head}.`];
  if (s.gap) parts.push(`Gap: ${cap(s.gap, history ? 140 : 200)}`);
  if (s.said && !history) parts.push(`He said: "${cap(s.said, 160)}"`);
  if (s.mixed_with) parts.push(`Mixed with: ${cap(s.mixed_with, 60)}.`);
  const traps = cleanTraps(parse(s.traps_json, []));
  if (traps.length) parts.push(`Traps: ${traps.join(', ')}.`);
  return parts.join(' ');
}

export function contradictions(newMisses, sure, rights, history) {
  const out = [];
  for (const { ref, row } of newMisses) {
    if (row.confidence !== 'sure' || row.result !== 'wrong' || !row.topic_id) continue;
    const before = (sure || []).filter(e => e.topic_id === row.topic_id && e.result === 'right' && Number(e.at) < Number(row.at)).sort((a, b) => b.at - a.at)[0];
    if (before) out.push({ topic: row.topic, ref, text: `${row.topic}: right when sure on ${shortDay(before.day)}, then wrong when sure on ${shortDay(row.day)} (${ref}).` });
  }
  for (const e of rights || []) {
    const was = (history || []).filter(h => h.row.topic_id === e.topic_id && h.row.confidence === 'sure' && h.row.result === 'wrong' && Number(h.row.at) < Number(e.at))
      .sort((a, b) => b.row.at - a.row.at)[0];
    if (was && !out.some(x => x.ref === was.ref)) out.push({ topic: e.topic, ref: was.ref, text: `${e.topic}: wrong when sure on ${shortDay(was.row.day)} (${was.ref}), then right when sure on ${shortDay(e.day)}.` });
  }
  return out.slice(0, 6);
}

/** The user turn (pure). */
export function reviewMessage({ what, today, newItems, history, miscs, habits, systems, contra, profile }) {
  const lines = [`Batch: ${what} (${plural(newItems.length, 'new item')}). Today ${today}, ${daysLeft(today)} days to the exam.`];
  if (profile) lines.push(`Last profile: ${cap(profile, 700)}`);
  if (habits.length) lines.push('Current habits:', ...habits.map(h => `- ${h.trap} (${trapLabel(h.trap)}): ${h.n} items on ${h.topics_n} topics, last ${shortDay(h.last_seen)}${h.status === 'active' ? '' : ', quiet'}${h.note ? `. ${h.note}` : ''}`));
  if (systems.length) lines.push(`Traps by system, last 60 days: ${systems.map(s => `${s.system}: ${s.traps.map(t => `${t.trap} ${t.n}`).join(', ')}`).join('; ')}.`);
  lines.push('New items:', ...newItems.map(({ ref, kind, row }) => (kind === 'miss' ? missLine(ref, row) : gapLine(ref, row))));
  if (history.length) lines.push('History on the same topics:', ...history.map(({ ref, kind, row }) => (kind === 'miss' ? missLine(ref, row, { history: true }) : gapLine(ref, row, { history: true }))));
  if (miscs.length) lines.push('Open misconceptions on these topics:', ...miscs.map(m => `- ${m.id} (${m.topic || 'no topic'}): "${cap(m.belief, 160)}", seen ${m.seen_n || 1}, ${m.status}${m.note ? `; note: ${cap(m.note, 80)}` : ''}`));
  if (contra.length) lines.push('Possible contradictions:', ...contra.map(c => `- ${c.text}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------- reads

const MISS_SELECT = `SELECT m.id, m.label, m.day, m.at, m.source, m.topic_id, coalesce(t.name, m.condition_raw, m.topic_raw) AS topic,
    coalesce(t.category_id, m.category_id) AS category_id, c.name AS system, m.result, m.confidence, m.error_type, m.step, m.flaw_kind, m.time_s,
    m.rule, m.my_reasoning, m.look_alikes, m.block_id, m.uworld_block_id, m.sitting_id, json_extract(r.teach_json, '$.trap') AS judge_trap
  FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id
    LEFT JOIN categories c ON c.user_id = m.user_id AND c.id = coalesce(t.category_id, m.category_id)
    LEFT JOIN uworld_reviews r ON r.user_id = m.user_id AND r.block_id = m.uworld_block_id AND r.q = m.uworld_q`;
const GAP_SELECT = `SELECT g.id, g.day, g.at, g.source, g.origin, g.verdict, g.gap, g.said, g.step, g.confidence, g.mixed_with, g.topic_id, g.card_id, g.ref, g.sitting_id,
    coalesce(t.name, g.topic) AS topic, t.category_id, c.name AS system
  FROM gaps g LEFT JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id LEFT JOIN categories c ON c.user_id = g.user_id AND c.id = t.category_id`;
const NOT_READ = k => `NOT EXISTS (SELECT 1 FROM pattern_items p WHERE p.user_id = ${k}.user_id AND p.item_kind = '${k === 'm' ? 'miss' : 'gap'}' AND p.item_id = ${k}.id)`;

/** Each kind's new items as {miss: [sql, ...args] | null, gap: ...}, positional ? only (pure). */
export function scopeOf(run, t) {
  const ref = run.ref;
  switch (run.kind) {
    case 'uworld': return { miss: ['m.uworld_block_id = ?', ref], gap: null };
    case 'nbme': return { miss: ['m.sitting_id = ?', ref], gap: ['g.sitting_id = ?', ref] };
    case 'anki': return { miss: null, gap: ["g.ref = 'anki:' || ?", ref] };
    case 'daily': {
      // What came another way, from the last week: not a batch whose own run has yet to read it.
      const open = (k, expr) => `NOT EXISTS (SELECT 1 FROM pattern_runs x WHERE x.user_id = ${k}.user_id AND x.status <> 'done' AND x.id IN (${expr}))`;
      return {
        miss: [`m.created_at >= ? AND m.created_at <= ? AND ${open('m', "'uworld:' || coalesce(m.uworld_block_id, ''), 'nbme:' || coalesce(m.sitting_id, '')")}`, t - 7 * DAY_MS, t - HOUR_MS],
        gap: [`g.created_at >= ? AND g.created_at <= ? AND ${open('g', "coalesce(g.ref, ''), 'nbme:' || coalesce(g.sitting_id, '')")}`, t - 7 * DAY_MS, t - HOUR_MS],
      };
    }
    case 'catchup': {
      const from = addDays(londonDay(Number(run.created_at) || t), -(Number(ref) || CATCHUP_DAYS));
      return { miss: ['m.day >= ?', from], gap: ['g.day >= ?', from] };
    }
    default: return { miss: null, gap: null };
  }
}

/** The run's unread misses and gaps, newest first, at most ITEMS_PER_CALL together: {misses, gaps, more}. */
export async function newItems(env, user, run, t) {
  const s = scopeOf(run, t);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const stmts = [];
  if (s.miss) stmts.push(q(`${MISS_SELECT} WHERE m.user_id = ? AND m.held = 0 AND m.deleted_at IS NULL AND ${s.miss[0]} AND ${NOT_READ('m')}
      ORDER BY m.at DESC LIMIT ${ITEMS_PER_CALL + 1}`, user, ...s.miss.slice(1)));
  if (s.gap) stmts.push(q(`${GAP_SELECT} WHERE g.user_id = ? AND g.held = 0 AND ${s.gap[0]} AND ${NOT_READ('g')}
      ORDER BY g.at DESC LIMIT ${ITEMS_PER_CALL + 1}`, user, ...s.gap.slice(1)));
  if (!stmts.length) return { misses: [], gaps: [], more: false };
  const res = (await env.DB.batch(stmts)).map(r => r.results || []);
  const misses = s.miss ? res[0] : [], gaps = s.gap ? res[s.miss ? 1 : 0] : [];
  const keepM = misses.slice(0, ITEMS_PER_CALL);
  const keepG = gaps.slice(0, Math.max(0, ITEMS_PER_CALL - keepM.length));
  return { misses: keepM, gaps: keepG, more: misses.length > keepM.length || gaps.length > keepG.length };
}

export async function historyFor(env, user, { misses, gaps }, t) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const today = londonDay(t);
  const topics = [...new Set([...misses, ...gaps].map(r => r.topic_id).filter(Boolean))];
  const cats = [...new Set([...misses, ...gaps].map(r => r.category_id).filter(Boolean))];
  const ats = [...misses, ...gaps].map(r => Number(r.at)).filter(Number.isFinite);
  const from = ats.length ? Math.min(...ats) - 6 * HOUR_MS : t - DAY_MS, to = ats.length ? Math.max(...ats) + 6 * HOUR_MS : t;
  const [hm, hg, habits, sys, sure, rights] = (await env.DB.batch([
    q(`SELECT * FROM (${MISS_SELECT.replace('json_extract(r.teach_json', 'p.traps_json, json_extract(r.teach_json')}
        LEFT JOIN pattern_items p ON p.user_id = m.user_id AND p.item_kind = 'miss' AND p.item_id = m.id
      WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.topic_id IN (SELECT value FROM json_each(?2)) AND m.id NOT IN (SELECT value FROM json_each(?3))
      ORDER BY m.at DESC LIMIT ${HISTORY_MISSES})`, user, json1(topics), json1(misses.map(m => m.id))),
    q(`SELECT * FROM (${GAP_SELECT.replace('g.sitting_id,', 'g.sitting_id, p.traps_json,')}
        LEFT JOIN pattern_items p ON p.user_id = g.user_id AND p.item_kind = 'gap' AND p.item_id = g.id
      WHERE g.user_id = ?1 AND g.held = 0 AND g.topic_id IN (SELECT value FROM json_each(?2)) AND g.id NOT IN (SELECT value FROM json_each(?3))
      ORDER BY g.at DESC LIMIT ${HISTORY_GAPS})`, user, json1(topics), json1(gaps.map(g => g.id))),
    q('SELECT trap, status, n, topics_n, last_seen, note FROM habits WHERE user_id = ? AND n > 0 ORDER BY n DESC LIMIT 12', user),
    q(`SELECT coalesce(c.name, p.category_id) AS system, j.value AS trap, count(*) AS n FROM pattern_items p, json_each(p.traps_json) j
        LEFT JOIN categories c ON c.user_id = p.user_id AND c.id = p.category_id
      WHERE p.user_id = ? AND p.category_id IN (SELECT value FROM json_each(?)) AND p.day >= ? GROUP BY p.category_id, j.value ORDER BY n DESC LIMIT 30`,
    user, json1(cats), addDays(today, -60)),
    q(`SELECT topic_id, at, day, result FROM evidence WHERE user_id = ? AND kind = 'question' AND slot = 0 AND held = 0 AND confidence = 'sure'
        AND topic_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC LIMIT 200`, user, json1(topics)),
    q(`SELECT e.topic_id, e.at, e.day, t.name AS topic FROM evidence e JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id
      WHERE e.user_id = ?1 AND e.kind = 'question' AND e.slot = 0 AND e.held = 0 AND e.confidence = 'sure' AND e.result = 'right' AND e.at >= ?2 AND e.at <= ?3
        AND EXISTS (SELECT 1 FROM misses x WHERE x.user_id = e.user_id AND x.topic_id = e.topic_id AND x.held = 0 AND x.deleted_at IS NULL
          AND x.confidence = 'sure' AND x.result = 'wrong' AND x.at < e.at)
      ORDER BY e.at DESC LIMIT 20`, user, from, to),
  ])).map(r => r.results || []);
  const rightTopics = [...new Set(rights.map(r => r.topic_id).filter(x => !topics.includes(x)))];
  const [rm, miscs] = (await env.DB.batch([
    q(`${MISS_SELECT} WHERE m.user_id = ?1 AND m.held = 0 AND m.deleted_at IS NULL AND m.topic_id IN (SELECT value FROM json_each(?2))
        AND m.confidence = 'sure' AND m.result = 'wrong' ORDER BY m.at DESC LIMIT 10`, user, json1(rightTopics)),
    q(`SELECT id, topic_id, coalesce(topic_name, topic_id) AS topic, belief, status, seen_n, note FROM misconceptions
      WHERE user_id = ? AND status <> 'closed' AND topic_id IN (SELECT value FROM json_each(?)) ORDER BY last_seen DESC LIMIT 20`, user, json1([...topics, ...rightTopics])),
  ])).map(r => r.results || []);
  const bySystem = new Map();
  for (const r of sys) {
    if (!TRAPS[r.trap]) continue;
    const s = bySystem.get(r.system) || { system: r.system, traps: [] };
    if (s.traps.length < 4) s.traps.push({ trap: r.trap, n: Number(r.n) || 0 });
    bySystem.set(r.system, s);
  }
  return { histMisses: [...hm, ...rm.filter(r => !hm.some(x => x.id === r.id))], histGaps: hg, habits, systems: [...bySystem.values()].slice(0, 6), sure, rights, miscs };
}

// ---------------------------------------------------------------- one run

async function whatOf(env, user, run) {
  const r = run.ref;
  try {
    if (run.kind === 'uworld') { const b = await env.DB.prepare('SELECT day FROM uworld_blocks WHERE id = ?').bind(r).first(); return `UWorld block of ${shortDay(b && b.day) || 'today'}`; }
    if (run.kind === 'nbme') { const s = await env.DB.prepare('SELECT name FROM sittings WHERE id = ?').bind(r).first(); return cap((s && s.name) || 'the exam sitting', 60); }
    if (run.kind === 'anki') { const s = await env.DB.prepare('SELECT day FROM anki_sessions WHERE id = ?').bind(r).first(); return `Anki review of ${shortDay(s && s.day) || 'today'}`; }
  } catch { /* the words are only a label */ }
  if (run.kind === 'daily') return `the other misses and gaps of ${shortDay(r) || 'today'}`;
  return `the catch-up of the last ${Number(r) || CATCHUP_DAYS} days`;
}

async function callReview(env, content) {
  const [{ callJson }, { reserveSpend, spendCap }] = await Promise.all([import('../claude.js'), import('../db.js')]);
  const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
  let usd = 0;
  try {
    const r = await callJson(env, { role: 'patterner', system: PATTERN_SYSTEM, schema: PATTERN_SCHEMA, effort: 'high', maxTokens: 32000,
      messages: [{ role: 'user', content }] });
    usd = r.usd || 0;
    return { data: r.data, usd };
  } catch (e) {
    usd = Number(e && e.usd) || 0;
    throw e;
  } finally {
    await release(0);
    if (usd > 0) await addSpent(env, usd);
  }
}

async function addSpent(env, usd) {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS REAL) + ?2 AS TEXT)`)
    .bind(spentKey(), String(usd)).run();
}
async function spentToday(env, t) {
  try { const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(spentKey(londonDay(t))).first(); return Number(r && String(r.value).replace(/"/g, '')) || 0; } catch { return 0; }
}

/** One Recent activity line (a map_events row through the one writer), with any statements of the same step. */
async function line(env, user, kind, run, summary, statements = []) {
  const { commit } = await import('./ingest/hub.js');
  return commit(env, user, { via: 'cron:patterns', surface: 'cron', statements,
    events: [{ kind, target_type: 'pattern_run', target_id: run ? run.id : 'profile', summary: cap(summary, 160) }] });
}

const runUpdate = (env, user, id, set, args) => env.DB.prepare(`UPDATE pattern_runs SET ${set} WHERE user_id = ? AND id = ?`).bind(...args, user, id);

/** The labels the review sees for a new item (pure). */
export const itemLabel = (kind, row) => (kind === 'miss' ? row.label || 'miss' : row.card_id ? `card ${row.card_id}` : `gap ${shortDay(row.day) || row.day}`);

/**
 * What the review's answer changes, written in order: misconceptions and re-checks (through misconceptionSave, each its
 * own logged change), then one batch with every item's traps and the early re-tests, then the habits recounted and the
 * profile rewritten. Returns the counts for the run's line.
 */
export async function applyReview(env, user, { run, refs, data, ctx, t, index = null, contra = [] }) {
  const today = londonDay(t);
  const out = { items: 0, tagged: 0, misconceptions: 0, rechecks: 0, retests: 0, habits: 0, newly: [], profile: false };
  const d = data && typeof data === 'object' ? data : {};
  const safe = (s, n, row) => { const v = safeLine(s, n); return v && row && row.block_id && (!index || leaks(index, v)) ? null : v; };
  const { misconceptionSave } = await import('./teach-memory.js');
  const via = { actor: 'code', surface: 'cron', via: 'cron:patterns' };
  for (const m of (Array.isArray(d.misconceptions) ? d.misconceptions : []).slice(0, MAX_MISCONCEPTIONS)) {
    const it = refs.get(m && m.ref);
    const belief = safe(m && m.belief, 200, it && it.row);
    if (!belief || !it) continue;
    const r = await misconceptionSave(env, user, { topic: cap((it.row.topic || m.topic), 120) || undefined, belief, ref: cap(itemLabel(it.kind, it.row), 60) }, via)
      .catch(e => { console.error('pattern misconception failed', e && e.message); return null; });
    if (r && r.id) out.misconceptions++;
  }
  const open = new Map((ctx.miscs || []).map(m => [m.id, m]));
  for (const c of (Array.isArray(d.recheck) ? d.recheck : []).slice(0, MAX_RECHECKS)) {
    const m = open.get(c && c.id);
    const why = safeLine(c && c.why, 140);
    if (!m || !why || String(m.note || '').startsWith(`Re-check (${shortDay(today)})`)) continue;
    const keep = m.note && !String(m.note).startsWith('Re-check') ? ` · ${m.note}` : '';
    const r = await misconceptionSave(env, user, { id: m.id, note: cap(`Re-check (${shortDay(today)}): ${why}${keep}`, 200) }, via)
      .catch(e => { console.error('pattern recheck failed', e && e.message); return null; });
    if (r && r.id) out.rechecks++;
  }
  // 3. Every new item read once, with its traps; then the early re-tests for contradictions.
  const given = new Map((Array.isArray(d.items) ? d.items : []).filter(x => x && refs.has(x.ref)).map(x => [x.ref, x]));
  const rows = [];
  for (const [ref, it] of refs) {
    if (!it.isNew) continue;
    const g = given.get(ref) || {};
    const traps = cleanTraps(g.traps);
    rows.push({ item_kind: it.kind, item_id: it.row.id, run_id: run.id, topic_id: it.row.topic_id || null, category_id: it.row.category_id || null,
      day: it.row.day || today, label: cap(itemLabel(it.kind, it.row), 60), traps_json: JSON.stringify(traps), note: safe(g.note, NOTE_MAX, it.row) });
    out.items++;
    if (traps.length) out.tagged++;
  }
  const statements = [];
  if (rows.length) {
    const cols = ['item_kind', 'item_id', 'run_id', 'topic_id', 'category_id', 'day', 'label', 'traps_json', 'note'];
    statements.push(env.DB.prepare(`INSERT INTO pattern_items (user_id, ${cols.join(', ')}, created_at)
        SELECT ?1, ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')}, ?3 FROM json_each(?2) WHERE true
        ON CONFLICT (user_id, item_kind, item_id) DO UPDATE SET run_id = excluded.run_id, traps_json = excluded.traps_json, note = excluded.note, topic_id = excluded.topic_id,
          category_id = excluded.category_id`).bind(user, JSON.stringify(rows), t));
  }
  // Only a contradiction code found can book one (a sure answer that flipped), never any miss Claude names.
  const flipped = new Set(contra.map(c => c.ref));
  const retests = await retestParts(env, user, (Array.isArray(d.retests) ? d.retests : []).filter(x => x && flipped.has(x.ref)).map(x => refs.get(x.ref))
    .filter(it => it && it.kind === 'miss'), { today, t });
  statements.push(...retests.statements);
  out.retests = retests.booked;
  if (statements.length) await env.DB.batch(statements);
  // 4. The habits recounted by code, with the review's lines; 5. the profile with its new insight.
  const notes = {};
  for (const h of Array.isArray(d.habits) ? d.habits : []) if (h && TRAPS[h.trap] && h.note) notes[h.trap] = h.note;
  const hb = await recomputeHabits(env, user, { notes, now: t });
  out.habits = hb.updated;
  out.newly = hb.newly;
  const p = await refreshProfile(env, user, { now: t, insight: typeof d.insight === 'string' ? d.insight : undefined, runId: run.id }).catch(e => { console.error('profile refresh failed', e && e.message); return null; });
  out.profile = !!(p && p.changed);
  out.headline = safeLine(d.headline, 120);
  return out;
}

/** Early re-tests for contradictions (retests.js): one CONTRADICTION_DAYS out, unless one is open within a week. */
async function retestParts(env, user, items, { today, t }) {
  const { bookable, missRetestId, insertStatement, nextRetestStatement } = await import('./retests.js');
  const misses = [...new Map(items.map(it => [it.row.id, it.row])).values()].filter(m => bookable(m)).slice(0, MAX_RETESTS);
  if (!misses.length) return { statements: [], booked: 0 };
  let open = [];
  try {
    open = (await env.DB.prepare(`SELECT miss_id, min(due) AS due FROM retests WHERE user_id = ? AND result IS NULL AND miss_id IN (SELECT value FROM json_each(?)) GROUP BY miss_id`)
      .bind(user, json1(misses.map(m => m.id))).all()).results || [];
  } catch (e) { if (noTable(e)) return { statements: [], booked: 0 }; throw e; }
  const soon = new Map(open.map(r => [r.miss_id, r.due]));
  const due = addDays(today, CONTRADICTION_DAYS);
  const rows = misses.filter(m => !(soon.get(m.id) && soon.get(m.id) <= addDays(today, 7)))
    .map(m => ({ id: missRetestId(m.id, due), miss_id: m.id, topic_id: m.topic_id || null, due, source: 'hub' }));
  if (!rows.length) return { statements: [], booked: 0 };
  return { statements: [insertStatement(env, user, rows, t), nextRetestStatement(env, user, rows.map(r => r.miss_id))].filter(Boolean), booked: rows.length };
}

/** The run's Recent activity line (pure). */
export function runSummary(what, out) {
  const parts = [plural(out.items, 'item')];
  if (out.newly && out.newly.length) parts.push(`new pattern: ${trapLabel(out.newly[0])}`);
  if (out.misconceptions) parts.push(plural(out.misconceptions, 'misconception'));
  if (out.rechecks) parts.push(`${out.rechecks} to re-check`);
  if (out.retests) parts.push(`${plural(out.retests, 're-test')} booked`);
  return `Pattern review: ${plural(out.habits, 'habit')} updated from ${what} (${parts.join(', ')})`;
}

/**
 * One run: the daily limit, a claim, its new items (none: done quietly), the history, one call, what it changes, and
 * its line. A batch bigger than one call stays pending for the next minute. Returns what it did (for the tests and
 * the logs); never throws for a failed call (the run is marked and tried again).
 */
export async function reviewRun(env, user, run, { now = nowMs(), call = callReview } = {}) {
  const t = now;
  const what = await whatOf(env, user, run);
  if ((await spentToday(env, t)) >= PATTERN_DAILY_USD) {
    await runUpdate(env, user, run.id, `status = 'capped', error = ?, next_at = ?, updated_at = ?`, [`The pattern review's daily limit ($${PATTERN_DAILY_USD}) is reached.`, t + CAPPED_WAIT_MS, t]).run();
    if (run.status !== 'capped') await line(env, user, 'pattern.failed', run, `Pattern review held by its daily limit ($${PATTERN_DAILY_USD}): ${what} waits for tomorrow`).catch(() => null);
    return { held: 'daily limit' };
  }
  // The claim holds only if nobody moved the run since it was read (two minutes' jobs never review it twice).
  const claim = await env.DB.prepare(`UPDATE pattern_runs SET status = 'running', started_at = coalesce(started_at, ?1), updated_at = ?1
      WHERE user_id = ?2 AND id = ?3 AND status = ?4 AND updated_at = ?5`).bind(t, user, run.id, run.status, run.updated_at).run();
  if (!claim.meta || !claim.meta.changes) return { skipped: 'not claimed' };
  if (run.kind === 'nbme') {
    const busy = await env.DB.prepare(`SELECT count(*) AS n FROM analyses a JOIN blocks b ON b.id = a.block_id WHERE b.sitting_id = ? AND a.status IN ('pending', 'running')`)
      .bind(run.ref).first().catch(() => null);
    if (busy && Number(busy.n) > 0) {
      await runUpdate(env, user, run.id, `status = 'pending', next_at = ?, updated_at = ?`, [t + RETRY_MS, t]).run();
      return { waiting: 'answers still being checked' };
    }
  }
  try {
    const items = await newItems(env, user, run, t);
    if (!items.misses.length && !items.gaps.length) {
      await runUpdate(env, user, run.id, `status = 'done', done_at = ?, error = NULL, attempts = 0, updated_at = ?`, [t, t]).run();
      return { done: true, items: 0 };
    }
    const ctx = await historyFor(env, user, items, t);
    const refs = new Map();
    let n = 0, h = 0;
    for (const row of items.misses) refs.set(`n${++n}`, { kind: 'miss', row, isNew: true });
    for (const row of items.gaps) refs.set(`n${++n}`, { kind: 'gap', row, isNew: true });
    for (const row of ctx.histMisses) refs.set(`h${++h}`, { kind: 'miss', row, isNew: false });
    for (const row of ctx.histGaps) refs.set(`h${++h}`, { kind: 'gap', row, isNew: false });
    const hubIds = [...refs.values()].filter(x => x.kind === 'miss' && x.row.block_id).map(x => x.row.id);
    const index = hubIds.length ? await leakIndexFor(env, user, { missIds: hubIds.slice(0, 200) }).catch(() => null) : null;
    for (const x of refs.values()) {
      if (x.kind !== 'miss') continue;
      const r = x.row = { ...x.row };
      for (const [k, ok] of [['rule', questionSafe], ['look_alikes', questionSafe], ['my_reasoning', stemSafe]]) {
        if (r[k] && (!ok(r[k]) || (r.block_id && (!index || leaks(index, r[k]))))) r[k] = null;
      }
    }
    const list = kind => [...refs.entries()].filter(([, x]) => (kind === 'new') === x.isNew).map(([ref, x]) => ({ ref, ...x }));
    const contra = contradictions(list('new').filter(x => x.kind === 'miss'), ctx.sure, ctx.rights, list('old').filter(x => x.kind === 'miss'));
    const profile = await readProfile(env, user).catch(() => null);
    const content = reviewMessage({ what, today: londonDay(t), newItems: list('new'), history: list('old'), miscs: ctx.miscs, habits: ctx.habits, systems: ctx.systems,
      contra, profile: profile && (profile.insight || profile.text) });
    let data, usd = 0;
    try {
      ({ data, usd } = await call(env, content));
    } catch (e) {
      usd = Number(e && e.usd) || 0;
      const capped = e instanceof HttpError && e.status === 429;
      await runUpdate(env, user, run.id, `status = ?, attempts = attempts + ?, error = ?, next_at = ?, usd = usd + ?, updated_at = ?`,
        [capped ? 'capped' : 'failed', capped ? 0 : 1, String((e && e.message) || e).slice(0, 300), t + (capped ? CAPPED_WAIT_MS : RETRY_MS), usd, t]).run();
      if (!capped || run.status !== 'capped') {
        const last = !capped && Number(run.attempts || 0) + 1 >= MAX_TRIES;
        await line(env, user, 'pattern.failed', run, capped ? `Pattern review held by Claude's spend limit: ${what} waits until there is room`
          : `Pattern review failed: ${what}, ${cap(String((e && e.message) || e), 70)}; will retry${last ? ' tomorrow' : ''}`).catch(() => null);
      }
      return { error: String((e && e.message) || e), capped };
    }
    const out = await applyReview(env, user, { run, refs, data, ctx, t, index, contra });
    const summary = out.headline && out.newly.length ? `Pattern review: ${out.headline}` : runSummary(what, out);
    await line(env, user, 'pattern.reviewed', run, summary, [
      runUpdate(env, user, run.id, `status = ?, next_at = ?, done_at = ?, error = NULL, attempts = 0, items_n = items_n + ?, calls = calls + 1, usd = usd + ?, summary = ?, updated_at = ?`,
        [items.more ? 'pending' : 'done', t, items.more ? null : t, out.items, usd, cap(summary, 160), t]),
    ]);
    return { ...out, usd, more: items.more };
  } catch (e) {
    // Reading or saving failed (not the call): tried again later, three times a day.
    await runUpdate(env, user, run.id, `status = 'failed', attempts = attempts + 1, error = ?, next_at = ?, updated_at = ?`, [`Saving failed: ${String((e && e.message) || e).slice(0, 250)}`, t + RETRY_MS, t]).run().catch(() => null);
    await line(env, user, 'pattern.failed', run, `Pattern review failed: ${what}, ${cap(String((e && e.message) || e), 70)}; will retry`).catch(() => null);
    console.error('pattern review failed', run.id, (e && e.stack) || e);
    return { error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------- the cron job

/** The profile's refresh from code facts (three times a day): one line when it changed. */
export async function profileJob(env, user, { now = nowMs() } = {}) {
  try {
    const p = await refreshProfile(env, user, { now });
    if (p && p.changed) await line(env, user, 'profile.refreshed', null, 'About-you profile refreshed from the map (habits, weak spots, calibration, re-tests)');
    return p ? { changed: p.changed } : { skipped: 'not ready' };
  } catch (e) {
    await line(env, user, 'pattern.failed', null, `About-you profile refresh failed: ${cap(String((e && e.message) || e), 80)}; will retry at the next slot`).catch(() => null);
    return { error: String((e && e.message) || e) };
  }
}

export async function patternJob(env, user = MO, { at = nowMs(), call = callReview } = {}) {
  if (!env || !env.DB || env.PATTERNS === 'off' || user !== MO) return null;
  const t = Number(at) || nowMs();
  const clock = clockOf(t);
  let runRow;
  try {
    if (clock.hour === DAILY_HOUR && clock.minute >= DAILY_MINUTE) await enqueuePattern(env, user, 'daily', londonDay(t), { now: t });
    await env.DB.prepare(`UPDATE pattern_runs SET attempts = 0, next_at = 0 WHERE user_id = ? AND status = 'failed' AND attempts >= ? AND updated_at < ?`).bind(user, MAX_TRIES, t - DAY_MS).run();
    runRow = await env.DB.prepare(`SELECT * FROM pattern_runs WHERE user_id = ?1 AND ((status IN ('pending', 'capped', 'failed') AND next_at <= ?2 AND attempts < ?3)
        OR (status = 'running' AND updated_at < ?4)) ORDER BY kind = 'catchup', created_at LIMIT 1`).bind(user, t, MAX_TRIES, t - STALE_MS).first();
  } catch (e) { if (noTable(e)) return { skipped: 'not ready' }; throw e; }
  const profile = PROFILE_HOURS.includes(clock.hour) && clock.minute === PROFILE_MINUTE ? await profileJob(env, user, { now: t }) : null;
  if (!runRow) return { idle: true, ...(profile ? { profile } : {}) };
  return { run: runRow.id, ...(await reviewRun(env, user, runRow, { now: t, call })), ...(profile ? { profile } : {}) };
}

// ---------------------------------------------------------------- the catch-up (deploy)

export async function catchupRoute(request, env) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  const days = Math.max(1, Math.min(120, Math.round(Number(body && body.days) || CATCHUP_DAYS)));
  try { await env.DB.prepare('SELECT 1 FROM pattern_runs WHERE user_id = ? LIMIT 1').bind(MO).all(); } catch (e) {
    if (noTable(e)) throw new HttpError(409, 'Apply migration 0040_patterns.sql first.');
    throw e;
  }
  const t = nowMs();
  const id = `catchup:${londonDay(t)}`;
  await env.DB.prepare(`INSERT INTO pattern_runs (user_id, id, kind, ref, status, next_at, created_at, updated_at) VALUES (?1, ?2, 'catchup', ?3, 'pending', 0, ?4, ?4)
      ON CONFLICT (user_id, id) DO UPDATE SET ref = excluded.ref, status = CASE WHEN pattern_runs.status = 'running' THEN 'running' ELSE 'pending' END, attempts = 0, next_at = 0,
        updated_at = excluded.updated_at`).bind(MO, id, String(days), t).run();
  return json({ started: true, run: id, days, ...(await catchupState(env)) });
}

/** GET /api/backfill/patterns: how far the catch-up is ({runs, items_read, habits, profile, spent_today}). */
export async function catchupStatusRoute(request, env) {
  return json(await catchupState(env));
}

async function catchupState(env) {
  try {
    const [runs, items, habits, prof] = (await env.DB.batch([
      env.DB.prepare(`SELECT id, status, items_n, calls, round(usd, 3) AS usd, error, summary FROM pattern_runs WHERE user_id = ? AND kind = 'catchup' ORDER BY created_at DESC LIMIT 3`).bind(MO),
      env.DB.prepare('SELECT count(*) AS n FROM pattern_items WHERE user_id = ?').bind(MO),
      env.DB.prepare(`SELECT count(*) AS n, sum(status = 'active') AS active FROM habits WHERE user_id = ? AND n > 0`).bind(MO),
      env.DB.prepare('SELECT updated_at FROM learner_profile WHERE user_id = ?').bind(MO),
    ])).map(r => r.results || []);
    return { runs, items_read: Number((items[0] || {}).n) || 0, habits: Number((habits[0] || {}).n) || 0, active_habits: Number((habits[0] || {}).active) || 0,
      profile_at: prof[0] ? prof[0].updated_at : null, spent_today: await spentToday(env, nowMs()), daily_usd: PATTERN_DAILY_USD };
  } catch (e) { if (noTable(e)) return { ready: false }; throw e; }
}
