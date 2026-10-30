import { HttpError, json, readJson, now, londonDay, safeParse } from './util.js';
import { all, first, getSettings, reserveSpend, spendCap } from './db.js';
import { callJson } from './claude.js';
import { MO } from './users.js';
import { planDates, uworldStatus, incorrectsDone, anchoredTotal, addDays } from '../../public/js/hub/plan-maths.js';
import { cleanQuestions, mergeQuestions, tidyShot } from './uworld.js';

export const KINDS = ['first_pass', 'incorrect'];
export const POOLS = ['unused', 'incorrect', 'marked', 'omitted', 'correct', 'mixed', 'all', 'unknown'];
export const MODES = ['timed', 'tutor', 'untimed', 'unknown'];
export const PAGES = ['performance', 'previous_tests', 'test_results', 'other'];
const RESULTS = ['right', 'wrong', 'omitted'];
export const BIG = 100;
export const DAY_MAX = 400;
export const SETTINGS_KEY = 'uworld_track';
const SHOT_RESERVE_USD = 1, MAX_SHOTS = 4, MAX_SHOT_CHARS = 5_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const autoId = (day, kind) => `auto:${day}:${kind}`;
export const isAutoId = id => String(id || '').startsWith('auto:');
const key = (day, kind) => `${day}|${kind}`;
const split = k => k.split('|');
/** Which kind a test's Q. Pool means: unused is the first pass, any used pool is a redo; mixed or unknown: by date. */
export const poolKind = pool => (pool === 'unused' ? 'first_pass' : ['incorrect', 'marked', 'omitted', 'correct'].includes(pool) ? 'incorrect' : null);
const noTable = e => /no such table/i.test(String(e && e.message));
const sum = list => list.reduce((t, x) => t + x.n, 0);

// ---------------------------------------------------------------- the sources
const QJ = "CASE WHEN json_valid(b.questions_json) THEN b.questions_json ELSE '[]' END";
const BLOCKS_SQL = `SELECT b.id, b.day, b.count, b.created_at,
  (SELECT count(*) FROM json_each(${QJ})) AS nq,
  (SELECT max(CAST(json_extract(j.value, '$.q') AS INTEGER)) FROM json_each(${QJ}) j) AS maxq,
  (SELECT json_group_array(json_extract(j.value, '$.uworld_id')) FROM json_each(${QJ}) j WHERE json_extract(j.value, '$.uworld_id') IS NOT NULL) AS ids,
  (SELECT count(*) FROM json_each(${QJ}) j WHERE json_extract(j.value, '$.result') IS NOT NULL) AS nres,
  (SELECT count(*) FROM json_each(${QJ}) j WHERE json_extract(j.value, '$.result') = 'right') AS nright
  FROM uworld_blocks b`;

/** When a block began: the recorder's id is Date.now() at the start; otherwise when it was first saved. */
export function blockStart(b) {
  const id = Number(b.id);
  return /^\d{13}$/.test(String(b.id)) && id > 1.6e12 && id < 4e12 ? id : Number(b.created_at) || 0;
}
/** How many questions a block counts: the recorder's count, the highest question saved, or how many are saved. */
export const blockCount = b => Math.max(Number(b.count) || 0, Number(b.maxq) || 0, Number(b.nq) || 0);

/** Everything retally needs, read in one batch (the 0016 tables count as empty before the migration). */
export async function loadState(env, user = MO) {
  const base = [env.DB.prepare(BLOCKS_SQL), env.DB.prepare('SELECT id, day, n, kind, created_at FROM uworld_log ORDER BY day, created_at')];
  const extra = [
    env.DB.prepare('SELECT * FROM uworld_readings WHERE user_id = ? ORDER BY taken_at').bind(user),
    env.DB.prepare('SELECT day, kind, n, set_at, absorbed_json FROM uworld_adjust WHERE user_id = ?').bind(user),
    env.DB.prepare('SELECT block_id, kind FROM uworld_block_kind WHERE user_id = ?').bind(user),
    env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(SETTINGS_KEY),
  ];
  let res, tracked = true;
  try { res = await env.DB.batch([...base, ...extra]); } catch (e) {
    if (!noTable(e)) throw e;
    tracked = false;
    res = [...await env.DB.batch(base), { results: [] }, { results: [] }, { results: [] }, { results: [] }];
  }
  const [b, log, rd, adj, bk, sv] = res.map(r => r.results || []);
  const settings = await getSettings(env);
  const blocks = b.map(r => ({ id: String(r.id), day: r.day, n: blockCount(r), start: blockStart(r), results: Number(r.nres) || 0, right: Number(r.nright) || 0,
    ids: (safeParse(r.ids, []) || []).filter(x => x != null).map(String) }));
  const readings = rd.map(r => ({ ...r, tests: safeParse(r.tests_json, []) || [], pages: safeParse(r.pages, []) || [], check: safeParse(r.check_json, {}) || {} }));
  return {
    user, tracked, settings, blocks,
    log: log.map(r => ({ ...r, n: Number(r.n) || 0 })),
    readings,
    adjusts: new Map(adj.map(r => [key(r.day, r.kind), { n: Number(r.n) || 0, set_at: Number(r.set_at) || 0, absorbed: safeParse(r.absorbed_json, []) || [] }])),
    kinds: new Map(bk.map(r => [String(r.block_id), r.kind])),
    saved: sv[0] ? sv[0].value : null,
    finish: planDates(settings).uworldFinish,
  };
}

// ---------------------------------------------------------------- the tally (pure)
export function tally(state, cutoff = Infinity) {
  const dateKind = day => (day <= state.finish ? 'first_pass' : 'incorrect');
  const readings = state.readings.filter(r => r.status === 'applied' && r.taken_at <= cutoff);
  const perReading = [];
  const shots = new Map(), byNo = new Map(), testsByDay = new Map();
  for (const r of readings) {
    const per = new Map(), days = new Map();
    for (const t of r.tests) {
      if (!t || !DAY.test(t.date) || !(t.n > 0)) continue;
      const kind = t.kind || dateKind(t.date);
      per.set(key(t.date, kind), (per.get(key(t.date, kind)) || 0) + t.n);
      if (t.no != null) byNo.set(t.no, { k: key(t.date, kind), n: t.n });
      if (!days.has(t.date)) days.set(t.date, []);
      days.get(t.date).push({ n: t.n, kind: t.kind || null });
    }
    perReading.push({ at: r.taken_at, per });
    for (const [k, n] of per) shots.set(k, Math.max(shots.get(k) || 0, n));
    for (const [d, list] of days) if ((testsByDay.get(d) || []).length < list.length) testsByDay.set(d, list);
  }
  const union = new Map();
  for (const t of byNo.values()) union.set(t.k, (union.get(t.k) || 0) + t.n);
  for (const [k, n] of union) shots.set(k, Math.max(shots.get(k) || 0, n));

  const blocks = state.blocks.filter(b => b.start <= cutoff).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const seen = new Set(), used = new Map(), blockKinds = new Map(), fromBlocks = new Map();
  for (const b of blocks) {
    let kind = state.kinds.get(b.id) || null, why = kind ? 'mo' : null;
    if (!kind && b.n) {
      const list = testsByDay.get(b.day) || [], taken = used.get(b.day) || new Set();
      const i = list.findIndex((t, j) => !taken.has(j) && t.n === b.n && t.kind);
      if (i >= 0) { taken.add(i); used.set(b.day, taken); kind = list[i].kind; why = 'screenshot'; }
    }
    if (!kind && b.ids.length >= 3 && b.ids.filter(id => seen.has(id)).length * 2 >= b.ids.length) { kind = 'incorrect'; why = 'repeats'; }
    if (!kind) { kind = dateKind(b.day); why = 'date'; }
    b.ids.forEach(id => seen.add(id));
    blockKinds.set(b.id, { kind, n: b.n, why });
    if (b.n > 0) {
      const k = key(b.day, kind);
      if (!fromBlocks.has(k)) fromBlocks.set(k, []);
      fromBlocks.get(k).push({ n: b.n, t: b.start });
    }
  }
  const mo = new Map();
  for (const r of state.log) {
    if (isAutoId(r.id) || !(r.n > 0) || r.created_at > cutoff) continue;
    const k = key(r.day, r.kind || 'first_pass');
    if (!mo.has(k)) mo.set(k, []);
    mo.get(k).push({ n: r.n, t: r.created_at });
  }
  const adjusts = new Map([...state.adjusts].filter(([, a]) => a.set_at <= cutoff));
  const keys = new Set([...shots.keys(), ...fromBlocks.keys(), ...mo.keys(), ...adjusts.keys()]);
  const totals = new Map(), parts = new Map();
  for (const k of keys) {
    const B = fromBlocks.get(k) || [], M = mo.get(k) || [], S = shots.get(k) || 0, a = adjusts.get(k);
    let T;
    if (a) {
      const after = x => x.t > a.set_at;
      const later = Math.max(0, ...perReading.filter(r => r.at > a.set_at).map(r => r.per.get(k) || 0));
      T = Math.max(a.n + sum(B.filter(after)) + sum(M.filter(after)), later);
    } else T = Math.max(sum(M), sum(B), S);
    totals.set(k, T);
    parts.set(k, { blocks: sum(B), screenshots: S, mo: a ? a.n : sum(M), adjusted: !!a, total: T });
  }
  return { totals, parts, blocks: blockKinds };
}

/** The anchor: the latest applied Performance reading, with what the hub had counted of the first pass by then. */
export function anchorOf(state, full = tally(state)) {
  const r = state.readings.filter(x => x.status === 'applied' && Number.isInteger(x.unused)).sort((a, b) => b.taken_at - a.taken_at)[0];
  if (!r) return null;
  let through = 0;
  for (const [k, n] of full.totals) { const [d, kind] = split(k); if (kind === 'first_pass' && d < r.day) through += n; }
  const sameDay = key(r.day, 'first_pass');
  through += Math.min(full.totals.get(sameDay) || 0, tally(state, r.taken_at).totals.get(sameDay) || 0);
  return { reading: r.id, day: r.day, at: r.taken_at, unused: r.unused, used: r.used, total: r.total, pct_correct: r.pct_correct, through };
}

export function compute(state) {
  const full = tally(state);
  const live = new Map();
  for (const r of state.log) if (!isAutoId(r.id)) live.set(key(r.day, r.kind || 'first_pass'), (live.get(key(r.day, r.kind || 'first_pass')) || 0) + r.n);
  const rows = [];
  for (const [k, T] of [...full.totals].sort()) {
    const [day, kind] = split(k);
    const n = Math.min(2400, T - (live.get(k) || 0));
    if (n > 0) rows.push({ id: autoId(day, kind), day, n, kind });
  }
  return { full, rows, summary: { v: 1, anchor: anchorOf(state, full) } };
}

export const ledgerOf = (state, rows) => [...state.log.filter(r => !isAutoId(r.id)), ...rows];

/** The first pass and incorrects worked out as the Plan card does (plan-maths.js), for a state. */
export function planNumbers(state, computed = compute(state), today = londonDay()) {
  const d = planDates(state.settings);
  const log = ledgerOf(state, computed.rows);
  const a = anchoredTotal({ totalLeft: d.totalLeft, asOf: d.asOf, log, anchor: computed.summary.anchor });
  const st = uworldStatus({ log, totalLeft: a.totalLeft, asOf: d.asOf, today, rest: d.off, offWeekdays: d.offWeekdays, until: d.phase2Start });
  return { d, a, st, inc: incorrectsDone(log, today), log };
}

// ---------------------------------------------------------------- retally (the one writer of the derived rows)
export async function retally(env, user = MO) {
  const state = await loadState(env, user);
  const c = compute(state);
  const have = new Map(state.log.filter(r => isAutoId(r.id)).map(r => [r.id, r]));
  const want = new Map(c.rows.map(r => [r.id, r]));
  const t = now();
  const writes = [];
  for (const r of want.values()) {
    const h = have.get(r.id);
    if (h && h.n === r.n && h.day === r.day && h.kind === r.kind) continue;
    writes.push(env.DB.prepare(`INSERT INTO uworld_log (id, day, n, kind, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET n = excluded.n, day = excluded.day, kind = excluded.kind`).bind(r.id, r.day, r.n, r.kind, t));
  }
  for (const id of have.keys()) if (!want.has(id)) writes.push(env.DB.prepare('DELETE FROM uworld_log WHERE id = ?').bind(id));
  const summary = JSON.stringify(c.summary);
  if (state.tracked && summary !== state.saved) {
    writes.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(SETTINGS_KEY, summary));
  }
  if (writes.length) await env.DB.batch(writes);
  return { changed: writes.length, rows: c.rows, summary: c.summary, state, computed: c };
}

export async function trackHook(env, user = MO) {
  try { return await retally(env, user); } catch (e) { console.error('uworld track failed', (e && e.stack) || e); return null; }
}

// ---------------------------------------------------------------- readings (numbers from a screenshot)
const whole = (v, max) => (Number.isFinite(Number(v)) && v !== null && v !== '' && Number(v) >= 0 && Number(v) <= max ? Math.round(Number(v)) : null);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y, m, d) => {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
};
export function readDate(v) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return iso(m[1], m[2], m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return iso(m[3], m[1], m[2]);
  if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MONTHS.includes(m[1].toLowerCase())) return iso(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]);
  return null;
}
// A date after the screenshot was taken may be day and month swapped; one more than 400 days before it is a misread.
function testDate(v, today) {
  let d = readDate(v);
  if (d && d > today) {
    const [y, mo, da] = d.split('-').map(Number);
    const swapped = da <= 12 ? iso(y, da, mo) : null;
    d = swapped && swapped <= today ? swapped : null;
  }
  return d && d >= addDays(today, -400) ? d : null;
}

/**
 * A reading made safe: whole numbers in range, ISO dates no later than the day it was taken, enums, and nothing
 * else (never a test name or question text). -> {reading, problems}
 */
export function normalizeReading(raw = {}, { today = londonDay() } = {}) {
  const problems = [], skipped = [];
  let used = whole(raw.used, 20000), unused = whole(raw.unused, 20000), total = whole(raw.total, 20000);
  if (unused == null && used != null && total != null && total >= used) unused = total - used;
  if (total == null && used != null && unused != null) total = used + unused;
  if (used == null && total != null && unused != null && total >= unused) used = total - unused;
  const pct = null;
  const tests = [];
  const nos = new Set();
  for (const t of Array.isArray(raw.tests) ? raw.tests.slice(0, 300) : []) {
    if (!t || typeof t !== 'object') continue;
    const n = whole(t.questions ?? t.n, 60);
    const date = testDate(t.date, today);
    if (!n) continue;
    if (!date) { skipped.push(`A test with ${n} questions has no readable date (${String(t.date ?? 'none').slice(0, 20)}), so it was left out.`); continue; }
    const no = Number.isSafeInteger(Number(t.test_no ?? t.no)) && Number(t.test_no ?? t.no) > 0 ? Number(t.test_no ?? t.no) : null;
    if (no != null && nos.has(no)) continue; // the same test on two overlapping screenshots
    if (no != null) nos.add(no);
    const pool = POOLS.includes(t.pool) ? t.pool : 'unknown';
    tests.push({ date, n, pool, kind: poolKind(pool), mode: MODES.includes(t.mode) ? t.mode : 'unknown', pct: null, no });
  }
  tests.sort((a, b) => a.date.localeCompare(b.date) || (a.no || 0) - (b.no || 0) || a.n - b.n);
  const reading = { used, unused, total, pct_correct: pct, tests_created: whole(raw.tests_created, 5000), tests_completed: whole(raw.tests_completed, 5000), tests };
  if (used != null && unused != null && total != null && Math.abs(used + unused - total) > 5) problems.push(`Used ${used} and unused ${unused} do not add up to the ${total} total.`);
  return { reading, problems, skipped };
}
const hasNumbers = r => r.unused != null || r.used != null || r.total != null || r.pct_correct != null || r.tests.length > 0;

/** The same numbers give the same id, so dropping one screenshot twice keeps one reading. */
export async function readingId(r) {
  const canon = JSON.stringify([r.used, r.unused, r.total, r.pct_correct, r.tests_created, r.tests_completed, r.tests.map(t => [t.date, t.n, t.pool, t.mode, t.pct, t.no])]);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)));
  return 'r' + [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const shortDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmt = n => Number(n).toLocaleString('en-GB');

/**
 * How much a reading would move the hub's numbers: left (now) before and after, and each day's count that it
 * changes by BIG or more where the hub already had a count (or makes implausible). A reading that adds days the
 * hub knew nothing about is not a disagreement. -> {needs_confirm, notes, left_before, left_after, added}
 */
export function checkReading(state, reading, today = londonDay()) {
  const before = compute(state);
  const withIt = { ...state, readings: [...state.readings.filter(r => r.id !== reading.id), { ...reading, status: 'applied' }] };
  const after = compute(withIt);
  const nb = planNumbers(state, before, today), na = planNumbers(withIt, after, today);
  const notes = [...(reading.problems || [])];
  if (reading.unused != null && Math.abs(na.st.left - nb.st.left) >= BIG) {
    notes.push(`UWorld says ${fmt(reading.unused)} unused; the hub had ${fmt(nb.st.left)} left of the first pass, so it would now say ${fmt(na.st.left)}.`);
  }
  let added = 0;
  for (const [k, ta] of after.full.totals) {
    const tb = before.full.totals.get(k) || 0;
    added += Math.max(0, ta - tb);
    const [d, kind] = split(k);
    const what = kind === 'first_pass' ? 'first-pass' : 'incorrects';
    if (ta > DAY_MAX && ta > tb) notes.push(`${shortDay(d)}: ${ta} ${what} questions in one day looks like a misread.`);
    else if (tb > 0 && ta - tb >= BIG) notes.push(`${shortDay(d)}: UWorld lists ${ta} ${what} questions; the hub had ${tb}.`);
  }
  return { needs_confirm: notes.length > 0, notes, left_before: nb.st.left, left_after: na.st.left, added };
}

export async function saveReading(env, user, raw, { source = 'screenshot', takenAt = now(), confirm = false, usd = 0, rowsSaved = 0, blockId = null } = {}) {
  const today = londonDay(takenAt);
  const { reading, problems, skipped } = normalizeReading(raw, { today });
  if (!hasNumbers(reading)) return { saved: false, problems: [...problems, ...skipped, 'No UWorld numbers were found to save.'] };
  const id = await readingId(reading);
  const state = await loadState(env, user);
  if (!state.tracked) throw new HttpError(503, 'The hub needs its 0016 update before it can keep UWorld screenshots.');
  const old = state.readings.find(r => r.id === id);
  if (old && old.status === 'applied') return { saved: true, already: true, reading_id: id, notes: [] };
  const full = { ...reading, id, taken_at: old ? old.taken_at : takenAt, day: old ? old.day : today, problems };
  const nowDay = londonDay();
  const check = checkReading(state, full, full.day > nowDay ? full.day : nowDay); // as of the reading, at the latest
  const status = check.needs_confirm && !confirm ? 'pending' : 'applied';
  const t = now();
  await env.DB.prepare(`INSERT INTO uworld_readings (user_id, id, taken_at, day, source, pages, used, unused, total, pct_correct, tests_created, tests_completed,
      tests_json, rows_saved, block_id, status, check_json, usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET status = excluded.status, check_json = excluded.check_json, rows_saved = max(uworld_readings.rows_saved, excluded.rows_saved),
      block_id = coalesce(excluded.block_id, uworld_readings.block_id), usd = uworld_readings.usd + excluded.usd, updated_at = excluded.updated_at`)
    .bind(user, id, full.taken_at, full.day, source, JSON.stringify(pagesOf(reading, rowsSaved)), reading.used, reading.unused, reading.total, reading.pct_correct,
      reading.tests_created, reading.tests_completed, JSON.stringify(reading.tests), rowsSaved, blockId, status,
      JSON.stringify({ notes: check.notes, left_before: check.left_before, left_after: check.left_after, added: check.added }), usd, t, t).run();
  if (status === 'applied') await retally(env, user);
  const out = { saved: status === 'applied', reading_id: id, notes: check.notes, skipped, left_before: check.left_before, left_after: check.left_after, added: check.added };
  if (status === 'pending') Object.assign(out, { needs_confirm: true, ask: `${check.notes.join(' ')} Use UWorld's numbers?` });
  return out;
}
const pagesOf = (r, rows) => [r.unused != null || r.used != null ? 'performance' : null, r.tests.length ? 'previous_tests' : null, rows ? 'test_results' : null].filter(Boolean);

export async function decideReading(env, user, id, action) {
  if (!['apply', 'discard'].includes(action)) throw new HttpError(400, 'action must be apply or discard.');
  const row = await first(env, 'SELECT status FROM uworld_readings WHERE user_id = ? AND id = ?', user, String(id));
  if (!row) throw new HttpError(404, 'That UWorld reading was not found.');
  const status = action === 'apply' ? 'applied' : 'discarded';
  await env.DB.prepare('UPDATE uworld_readings SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?').bind(status, now(), user, String(id)).run();
  await retally(env, user);
  return { ok: true, reading_id: String(id), status };
}

/**
 * "Adjust": set a day's count of one kind by hand (n 0 to 2400), or clear it (n null). Setting it takes the legacy
 * rows of that day and kind into the adjustment (so they are not counted twice) and clearing puts them back.
 * Later blocks and screenshots still add on top of an adjustment.
 */
export async function adjust(env, user, { day, kind = 'first_pass', n }) {
  if (typeof day !== 'string' || !DAY.test(day)) throw new HttpError(400, 'Dates must look like 2027-06-30.');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'kind must be first_pass or incorrect.');
  const clear = n == null || n === '';
  const count = clear ? null : Number(n);
  if (!clear && !(Number.isInteger(count) && count >= 0 && count <= 2400)) throw new HttpError(400, 'The count must be a whole number from 0 to 2400.');
  const state = await loadState(env, user);
  if (!state.tracked) throw new HttpError(503, 'The hub needs its 0016 update before it can adjust UWorld counts.');
  const had = state.adjusts.get(key(day, kind));
  const t = now();
  const writes = [];
  if (clear) {
    if (had) {
      for (const r of had.absorbed) writes.push(env.DB.prepare('INSERT OR IGNORE INTO uworld_log (id, day, n, kind, created_at) VALUES (?, ?, ?, ?, ?)').bind(r.id, r.day, r.n, r.kind, r.created_at));
      writes.push(env.DB.prepare('DELETE FROM uworld_adjust WHERE user_id = ? AND day = ? AND kind = ?').bind(user, day, kind));
    }
  } else {
    const legacy = state.log.filter(r => !isAutoId(r.id) && r.day === day && (r.kind || 'first_pass') === kind);
    const absorbed = [...(had ? had.absorbed : []), ...legacy.map(r => ({ id: r.id, day: r.day, n: r.n, kind: r.kind || 'first_pass', created_at: r.created_at }))];
    writes.push(env.DB.prepare(`INSERT INTO uworld_adjust (user_id, day, kind, n, set_at, absorbed_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day, kind) DO UPDATE SET n = excluded.n, set_at = excluded.set_at, absorbed_json = excluded.absorbed_json, updated_at = excluded.updated_at`)
      .bind(user, day, kind, count, t, JSON.stringify(absorbed), t, t));
    for (const r of legacy) writes.push(env.DB.prepare('DELETE FROM uworld_log WHERE id = ?').bind(r.id));
  }
  if (writes.length) await env.DB.batch(writes);
  const r = await retally(env, user);
  const total = r.computed.full.totals.get(key(day, kind)) || 0;
  return { ok: true, day, kind, adjusted: !clear, n: total };
}

/** Count one recorded block as first pass or incorrects (kind null: back to the hub's own guess). */
export async function setBlockKind(env, user, { block, kind }) {
  const b = block ? await first(env, 'SELECT id FROM uworld_blocks WHERE id = ?', String(block)) : null;
  if (!b) throw new HttpError(404, 'That UWorld block was not found.');
  if (kind == null) await env.DB.prepare('DELETE FROM uworld_block_kind WHERE user_id = ? AND block_id = ?').bind(user, b.id).run();
  else if (!KINDS.includes(kind)) throw new HttpError(400, 'kind must be first_pass or incorrect.');
  else await env.DB.prepare(`INSERT INTO uworld_block_kind (user_id, block_id, kind, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, block_id) DO UPDATE SET kind = excluded.kind, set_at = excluded.set_at`).bind(user, b.id, kind, now()).run();
  const r = await retally(env, user);
  return { ok: true, block: b.id, kind: (r.computed.full.blocks.get(b.id) || {}).kind || kind };
}

// ---------------------------------------------------------------- a test's results table -> its block -> the map
export async function saveResultRows(env, user, rows, { day = londonDay(), ctx = null, testNo = null, dated = true } = {}) {
  const tidy = tidyShot(rows);
  if (!tidy.length) return { saved: false, problems: ['No question rows could be read.'] };
  const { questions, problems } = cleanQuestions(tidy);
  if (problems.length) return { saved: false, problems };
  const no = (typeof testNo === 'number' || typeof testNo === 'string') && Number.isSafeInteger(Number(testNo)) && Number(testNo) > 0 ? Number(testNo) : null;
  const ids = [...new Set(questions.map(q => q.uworld_id).filter(Boolean))];
  let target = null;
  const sameTest = b => {
    const mine = safeParse(b.questions_json, []) || [];
    const byId = new Map(questions.filter(q => q.uworld_id).map(q => [String(q.uworld_id), q]));
    const byQ = new Map(questions.map(q => [q.q, q]));
    for (const m of Array.isArray(mine) ? mine : []) {
      if (!m) continue;
      const o = m.uworld_id != null ? byId.get(String(m.uworld_id)) : null;
      if (o && m.q != null && Number(m.q) !== o.q) return false;
      const row = byQ.get(Number(m.q));
      if (row && row.uworld_id && m.uworld_id != null && String(m.uworld_id) !== String(row.uworld_id)) return false;
      if (row && RESULTS.includes(m.result) && RESULTS.includes(row.result) && m.result !== row.result) return false;
    }
    return true;
  };
  const otherTest = b => no != null && /^shot-t\d+$/.test(b.id) && b.id !== `shot-t${no}`;
  const own = no != null ? await first(env, 'SELECT id FROM uworld_blocks WHERE id = ?', `shot-t${no}`) : null;
  if (own) target = { id: own.id, fresh: false };
  else if (ids.length) {
    const hits = await all(env, `SELECT id, day, questions_json, hits FROM (SELECT b.id AS id, b.day AS day, b.questions_json AS questions_json,
        (SELECT count(*) FROM json_each(${QJ}) j
        WHERE CAST(json_extract(j.value, '$.uworld_id') AS TEXT) IN (SELECT value FROM json_each(?1))) AS hits FROM uworld_blocks b) WHERE hits > 0 ORDER BY hits DESC, id`, JSON.stringify(ids));
    // The test's own day first: a block that day sharing any of these IDs at the same numbers is this test (BUG-1).
    // With no date on the screenshot the day is only a guess, so an agreeing block on another day (two or more
    // shared IDs, all at the same numbers with the same results) is this test too.
    const mine = hits.find(h => !otherTest(h) && h.day === day && sameTest(h))
      || (!dated && hits.find(h => !otherTest(h) && h.hits >= Math.min(2, ids.length) && sameTest(h)));
    if (mine) target = { id: mine.id, fresh: false };
    else if (dated) {
      const max = Math.max(...questions.map(q => q.q));
      const rest = (await all(env, `SELECT id, count, questions_json FROM uworld_blocks WHERE day = ? ORDER BY created_at DESC`, day))
        .filter(b => !otherTest(b) && (b.count == null || max <= b.count || /^shot-/.test(b.id)) && (safeParse(b.questions_json, []) || []).some(m => m && m.uworld_id != null) && sameTest(b));
      if (rest.length === 1) {
        target = { id: rest[0].id, fresh: false };
        // A block made from an earlier screenshot took that screenshot's last number as its size; the test runs on.
        if (/^shot-/.test(rest[0].id)) await env.DB.prepare('UPDATE uworld_blocks SET count = max(coalesce(count, 0), ?) WHERE id = ?').bind(max, rest[0].id).run();
      }
    }
  } else {
    const same = await all(env, `SELECT b.id, b.count, b.questions_json FROM uworld_blocks b WHERE b.day = ? ORDER BY b.created_at DESC`, day);
    const max = Math.max(...questions.map(q => q.q));
    const hit = same.find(b => !otherTest(b) && (b.count == null || b.count === max) && sameTest(b));
    if (hit) target = { id: hit.id, fresh: false };
  }
  if (!target) {
    let id = `shot-t${no}`;
    if (no == null) {
      const sig = JSON.stringify(questions.map(q => [q.q, q.uworld_id, q.result, ...(ids.length ? [] : [q.time_s, q.topic])]));
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${sig}`)));
      id = 'shot-' + [...h.slice(0, 6)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    target = { id, fresh: true };
    const t = now();
    await env.DB.prepare(`INSERT OR IGNORE INTO uworld_blocks (id, day, mode, minutes, count, segments_json, manual_json, results_json, questions_json, words, created_at, updated_at)
      VALUES (?, ?, 'timed', NULL, ?, '[]', '[]', '{}', '[]', 0, ?, ?)`).bind(target.id, day, Math.max(...questions.map(q => q.q)), t, t).run();
  }
  const merged = await mergeQuestions(env, target.id, questions, ctx);
  return { saved: true, block: target.id, read: questions.length, saved_in_block: merged.length, new_block: target.fresh, already_saved: 0 };
}

// ---------------------------------------------------------------- reading a screenshot with Claude
export const PROGRESS_SYSTEM = `You read Mo's screenshots of UWorld, the USMLE Step 2 CK question bank, for numbers only. In pages, list which of these you see:
- performance: the Performance (overall) page. Read QBank usage into used, unused and total (Used, Unused and Total Questions) and the test count into tests_created and tests_completed. Always leave pct_correct null: Mo does not track a UWorld percentage.
- previous_tests: the Previous Tests list, one row per test. For each row: date as YYYY-MM-DD (UWorld writes dates month first, so 10/24/2026 is 2026-10-24), questions (the test's number of questions), pool (its Q. Pool: unused, incorrect, marked, omitted, correct, mixed when it lists more than one, all, or unknown when not shown), mode (timed, tutor, untimed or unknown), pct always null (no UWorld scores are kept) and test_no (the test's number only when it is a plain number). A row on two overlapping screenshots counts once.
- test_results: one test's results table, one row per question: q (its number in the test), uworld_id (the question ID), result (right, wrong or omitted, from the tick, cross or mark), subject, system and topic exactly as the row labels them (short labels), others_pct (% of others who got it right), time_s (his time in seconds: "1 min 35 sec" or "1:35" is 95) and others_time_s. Also test_date and test_no when the page shows them.
Leave anything you cannot read clearly as null rather than guessing. Never copy question text, answer text or test names. If none of these pages is shown, return pages ["other"] and say what you see in problem.`;
const nul = s => ({ anyOf: [s, { type: 'null' }] });
const INT = { type: 'integer' }, NUM = { type: 'number' }, STR = { type: 'string' };
export const PROGRESS_SCHEMA = {
  type: 'object',
  properties: {
    pages: { type: 'array', items: { type: 'string', enum: PAGES } },
    used: nul(INT), unused: nul(INT), total: nul(INT), pct_correct: nul(NUM), tests_created: nul(INT), tests_completed: nul(INT),
    tests: { type: 'array', items: { type: 'object', properties: {
      date: nul(STR), questions: nul(INT), pool: nul({ type: 'string', enum: POOLS }), mode: nul({ type: 'string', enum: MODES }), pct: nul(INT), test_no: nul(INT),
    }, required: ['date', 'questions', 'pool', 'mode', 'pct', 'test_no'], additionalProperties: false } },
    test_date: nul(STR), test_no: nul(INT),
    questions: { type: 'array', items: { type: 'object', properties: {
      q: INT, uworld_id: nul(STR), result: nul({ type: 'string', enum: RESULTS }), subject: nul(STR), system: nul(STR), topic: nul(STR),
      others_pct: nul(INT), time_s: nul(INT), others_time_s: nul(INT),
    }, required: ['q', 'uworld_id', 'result', 'subject', 'system', 'topic', 'others_pct', 'time_s', 'others_time_s'], additionalProperties: false } },
    problem: nul(STR),
  },
  required: ['pages', 'used', 'unused', 'total', 'pct_correct', 'tests_created', 'tests_completed', 'tests', 'test_date', 'test_no', 'questions', 'problem'],
  additionalProperties: false,
};

function imageBlock(url) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof url === 'string' ? url : '');
  if (!m) throw new HttpError(400, 'Each screenshot must be a PNG, JPEG or WebP picture.');
  if (m[2].length > MAX_SHOT_CHARS) throw new HttpError(413, 'A screenshot is too large. Try a smaller one.');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}
// When the screenshot was taken: the file's own time from the page (a dropped file's lastModified), when plausible.
const takenTime = v => (Number.isSafeInteger(Number(v)) && Number(v) > now() - 60 * 86_400_000 && Number(v) <= now() + 60_000 ? Number(v) : now());

/**
 * Claude reads 1 to 4 screenshots (Opus 5.5 at high, role reader, under the daily and monthly spend caps), then
 * the numbers go to saveReading and any results rows to saveResultRows. The pictures are not kept.
 */
export async function readScreenshots(env, user, { images, taken_at, day, confirm = false } = {}, ctx = null) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length || list.length > MAX_SHOTS) throw new HttpError(400, `Send 1 to ${MAX_SHOTS} screenshots of UWorld.`);
  const content = list.map(imageBlock);
  content.push({ type: 'text', text: `${list.length === 1 ? 'This screenshot is' : `These ${list.length} screenshots are`} from Mo's UWorld account. Read the numbers.` });
  const takenAt = takenTime(taken_at);
  const release = await reserveSpend(env, SHOT_RESERVE_USD, await spendCap(env));
  let data, usd;
  try {
    ({ data, usd } = await callJson(env, { role: 'reader', system: PROGRESS_SYSTEM, schema: PROGRESS_SCHEMA, effort: 'high', maxTokens: 16000, messages: [{ role: 'user', content }] }));
  } finally {
    await release(0); // the call added its real cost
  }
  const out = { pages: Array.isArray(data.pages) ? data.pages.filter(p => PAGES.includes(p)) : [], usd: Math.round(usd * 1e4) / 1e4 };
  const today = londonDay(takenAt);
  let rowsSaved = 0, blockId = null;
  if (Array.isArray(data.questions) && data.questions.length) {
    const read = testDate(data.test_date, today);
    const testDay = read || (typeof day === 'string' && DAY.test(day) && day <= today ? day : today);
    out.results = await saveResultRows(env, user, data.questions, { day: testDay, ctx, testNo: data.test_no, dated: !!read });
    if (out.results.saved) { rowsSaved = out.results.read; blockId = out.results.block; }
  }
  const r = await saveReading(env, user, data, { source: 'screenshot', takenAt, confirm, usd, rowsSaved, blockId });
  if (r.saved || r.needs_confirm) out.reading = r;
  if (!r.saved && !r.needs_confirm && !rowsSaved) throw new HttpError(422, data.problem || (out.results && out.results.problems && out.results.problems[0]) || 'No UWorld numbers could be read from that screenshot.');
  out.progress = await progress(env, user);
  return out;
}

// ---------------------------------------------------------------- what the pages and Claude read
export async function progress(env, user = MO, { today = londonDay() } = {}) {
  const state = await loadState(env, user);
  const c = compute(state);
  const { d, a, st, inc } = planNumbers(state, c, today);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = addDays(today, -i);
    const fp = c.full.parts.get(key(day, 'first_pass')), ic = c.full.parts.get(key(day, 'incorrect'));
    if (fp || ic) days.push({ day, first_pass: fp ? fp.total : 0, incorrect: ic ? ic.total : 0, from: Object.fromEntries(Object.entries({ first_pass: fp, incorrect: ic }).filter(([, v]) => v)) });
  }
  const anchor = c.summary.anchor;
  return {
    today,
    first_pass: { left: st.left, of: a.totalLeft, as_of: d.asOf, from: anchor && a.anchored ? `UWorld screenshot ${anchor.day}` : 'settings', done: st.done, pace: st.pace,
      needed: st.needed, days_left: st.daysLeft, finish: st.finish, finish_by: d.uworldFinish, status: st.status, behind_by: st.behindBy },
    incorrects: inc,
    anchor: anchor ? { day: anchor.day, unused: anchor.unused, used: anchor.used, total: anchor.total } : null,
    days,
    blocks: { counted: [...c.full.blocks.values()].filter(b => b.n > 0).length, no_count: state.blocks.filter(b => !b.n).map(b => b.id).slice(0, 10) },
    today_blocks: state.blocks.filter(b => b.day === today).sort((x, y) => x.start - y.start).slice(0, 12)
      .map(b => ({ id: b.id, n: b.n, right: b.right, marked: b.results, at: b.start, kind: (c.full.blocks.get(b.id) || {}).kind || null })),
    pending: state.readings.filter(r => r.status === 'pending').map(r => ({ id: r.id, day: r.day, notes: r.check.notes || [] })),
  };
}

export function progressText(p) {
  if (!p) return '';
  const f = p.first_pass;
  const bits = [`UWorld progress: ${fmt(f.left)} of the first pass left (of ${fmt(f.of)} from ${f.as_of}; ${f.from})`];
  if (f.status !== 'done' && f.status !== 'no_data') bits.push(`${f.pace} a study day over the last 7 days, ${f.needed} needed to finish by ${f.finish_by}${f.finish ? `; at this pace done ${f.finish}` : ''}`);
  bits.push(`incorrects redone: ${p.incorrects.total} (${p.incorrects.last7} in the last 7 days)`);
  if (p.pending.length) bits.push(`${p.pending.length} screenshot reading(s) wait for Mo's yes on the recorder page`);
  return bits.join('; ') + '. Counted from his recorded blocks and UWorld screenshots; he never types it.';
}

export const routes = {
  get: async (request, env, ctx, params, url, user) => json(await progress(env, user || MO)),
  screenshot: async (request, env, ctx, params, url, user) => {
    const b = await readJson(request, MAX_SHOTS * MAX_SHOT_CHARS + 10_000);
    return json(await readScreenshots(env, user || MO, b, ctx));
  },
  reading: async (request, env, ctx, params, url, user) => {
    const b = await readJson(request);
    const r = await saveReading(env, user || MO, b, { source: b.source === 'claude' ? 'claude' : 'mo', takenAt: takenTime(b.taken_at), confirm: b.confirm === true });
    if (!r.saved && !r.needs_confirm) throw new HttpError(400, (r.problems || [])[0] || 'Nothing to save.');
    return json({ ...r, progress: await progress(env, user || MO) });
  },
  decide: async (request, env, ctx, params, url, user) => {
    const b = await readJson(request);
    return json({ ...(await decideReading(env, user || MO, params.id, b.action)), progress: await progress(env, user || MO) });
  },
  adjust: async (request, env, ctx, params, url, user) => {
    const b = await readJson(request);
    return json({ ...(await adjust(env, user || MO, { day: b.day || londonDay(), kind: b.kind || 'first_pass', n: b.n })), progress: await progress(env, user || MO) });
  },
  blockKind: async (request, env, ctx, params, url, user) => json(await setBlockKind(env, user || MO, await readJson(request))),
  retally: async (request, env, ctx, params, url, user) => { const r = await retally(env, user || MO); return json({ ok: true, changed: r.changed, rows: r.rows.length }); },
};
