import { londonDay } from '../util.js';
import { addDays } from './teach-priority.js';

export const CONFS = ['sure', 'lean', 'guess', 'unknown'];
// A system needs this many sure answers before its rate is called overconfident (fewer is noise).
export const MIN_SURE = 5;
export const WEEKS_SHOWN = 10;
const OVERCONFIDENT_DAYS = 28;

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const pct = (a, n) => (n ? Math.round((100 * a) / n) : null);

const ROWS_SQL = `SELECT e.category_id, c.name AS system, e.source, coalesce(e.confidence, 'unknown') AS confidence, e.result, e.day, count(*) AS n
  FROM evidence e LEFT JOIN categories c ON c.user_id = e.user_id AND c.id = e.category_id
  WHERE e.user_id = ?1 AND e.kind = 'question' AND e.slot = 0 AND e.held = 0 AND e.result IN ('right', 'flawed', 'wrong')
    AND (?2 IS NULL OR e.day >= ?2) AND (?3 IS NULL OR e.category_id = ?3)
  GROUP BY e.category_id, e.source, coalesce(e.confidence, 'unknown'), e.result, e.day`;

/** The Monday of a day's week ('2026-10-29' -> '2026-10-26'). */
export function weekOf(day) {
  const t = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

const empty = () => Object.fromEntries(CONFS.map(c => [c, { n: 0, right: 0, flawed: 0, wrong: 0 }]));
function add(cell, r) {
  const c = cell[CONFS.includes(r.confidence) ? r.confidence : 'unknown'];
  const n = Number(r.n) || 0;
  c.n += n;
  if (r.result === 'right') c.right += n; else if (r.result === 'flawed') c.flawed += n; else c.wrong += n;
}
// {sure: {n, right_pct, wrong}, ...}, confidences with no answers left out. right_pct counts a right answer for a shaky
// reason as right (the answer was right).
const shown = cell => Object.fromEntries(CONFS.filter(c => cell[c].n).map(c => [c, { n: cell[c].n, right_pct: pct(cell[c].right + cell[c].flawed, cell[c].n), wrong: cell[c].wrong }]));
const sureWrongPct = cell => pct(cell.sure.wrong, cell.sure.n);

/** The calibration from grouped evidence rows [{category_id, system, source, confidence, result, day, n}] (pure). */
export function calibrationFrom(rows) {
  const overall = empty(), bySystem = new Map(), byWeek = new Map(), bySource = new Map();
  for (const r of rows || []) {
    add(overall, r);
    const sk = r.category_id || 'none';
    if (!bySystem.has(sk)) bySystem.set(sk, { system: r.system || (r.category_id ? r.category_id : 'not on the map'), cell: empty() });
    add(bySystem.get(sk).cell, r);
    const wk = weekOf(r.day);
    if (wk) { if (!byWeek.has(wk)) byWeek.set(wk, empty()); add(byWeek.get(wk), r); }
    const src = r.source || 'other';
    if (!bySource.has(src)) bySource.set(src, empty());
    add(bySource.get(src), r);
  }
  const systems = [...bySystem.values()].map(s => ({ system: s.system, answers: CONFS.reduce((a, c) => a + s.cell[c].n, 0), sure_wrong_pct: sureWrongPct(s.cell), ...shown(s.cell) }))
    .sort((a, b) => (b.sure_wrong_pct ?? -1) - (a.sure_wrong_pct ?? -1) || b.answers - a.answers);
  const weeks = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, WEEKS_SHOWN)
    .map(([week, cell]) => ({ week, sure_wrong_pct: sureWrongPct(cell), ...shown(cell) }));
  const worst = [...bySystem.values()].filter(s => s.cell.sure.n >= MIN_SURE && s.cell.sure.wrong > 0)
    .sort((a, b) => sureWrongPct(b.cell) - sureWrongPct(a.cell) || b.cell.sure.n - a.cell.sure.n)[0] || null;
  return {
    overall: shown(overall), by_source: Object.fromEntries([...bySource].map(([k, cell]) => [k, shown(cell)])), by_system: systems, by_week: weeks,
    overconfident: worst ? { system: worst.system, sure: worst.cell.sure.n, sure_wrong: worst.cell.sure.wrong, sure_wrong_pct: sureWrongPct(worst.cell) } : null,
  };
}

/** board_tallies {kind: 'calibration', since_day?, category?}: overall, by source, by system (worst sure first), by week. */
export async function calibration(env, user, { since_day = null, category_id = null } = {}) {
  let rows = [];
  try { rows = (await env.DB.prepare(ROWS_SQL).bind(user, since_day, category_id).all()).results || []; } catch (e) { if (!noTable(e)) throw e; }
  const c = calibrationFrom(rows);
  const sure = c.overall.sure;
  const head = sure ? `Sure answers right ${sure.right_pct}% of ${sure.n}${c.overall.lean ? `, lean ${c.overall.lean.right_pct}%` : ''}${c.overall.guess ? `, guess ${c.overall.guess.right_pct}%` : ''}`
    : 'No answers with a sure confidence yet';
  const worst = c.overconfident ? `; most overconfident: ${c.overconfident.system} (${c.overconfident.sure_wrong} of ${c.overconfident.sure} sure answers wrong)` : '';
  return { kind: 'calibration', ...(since_day ? { since_day } : {}), summary: `${head}${since_day ? ` since ${since_day}` : ''}${worst}.`, ...c };
}

export async function overconfident(env, user, { today = londonDay() } = {}) {
  try {
    const rows = (await env.DB.prepare(`SELECT c.name AS system, count(*) AS sure, sum(e.result = 'wrong') AS wrong
        FROM evidence e JOIN categories c ON c.user_id = e.user_id AND c.id = e.category_id
        WHERE e.user_id = ? AND e.kind = 'question' AND e.slot = 0 AND e.held = 0 AND e.confidence = 'sure' AND e.result IN ('right', 'flawed', 'wrong') AND e.day >= ?
        GROUP BY e.category_id HAVING count(*) >= ? AND sum(e.result = 'wrong') > 0
        ORDER BY 1.0 * sum(e.result = 'wrong') / count(*) DESC, count(*) DESC LIMIT 1`).bind(user, addDays(today, -OVERCONFIDENT_DAYS), MIN_SURE).all()).results || [];
    const r = rows[0];
    return r ? { system: r.system, sure: r.sure, sure_wrong: r.wrong, sure_wrong_pct: pct(r.wrong, r.sure), days: OVERCONFIDENT_DAYS } : null;
  } catch (e) { if (noTable(e)) return null; throw e; }
}
