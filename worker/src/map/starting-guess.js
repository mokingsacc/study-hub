import { londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { priorOf, guessM0, GUESS_KIND, refreshPriors } from './weakness.js';
import { logLoss, brier, WINDOW_DAYS, DAY_MS } from './honesty-stats.js';

export const SG = { k_cat: 10, k_global: 20, min: 0.35, max: 0.85, move: 0.005, moves_shown: 3, base_id: 'sg:base' };
export { GUESS_KIND };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pc = x => Math.round(100 * Number(x));
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function startingGuess(firsts, base) {
  const b = clamp(Number.isFinite(Number(base)) ? Number(base) : 0.62, SG.min, SG.max);
  let n = 0, k = 0;
  const by = new Map();
  for (const f of firsts || []) {
    const y = Number(f && f.y);
    if (y !== 0 && y !== 1) continue;
    n++; k += y;
    if (f.category_id == null || f.category_id === '') continue;
    const c = by.get(f.category_id) || { n: 0, k: 0 };
    c.n++; c.k += y;
    by.set(f.category_id, c);
  }
  const global = clamp((k + SG.k_global * b) / (n + SG.k_global), SG.min, SG.max);
  const by_category = {};
  for (const [id, c] of [...by].sort((x, y) => String(x[0]).localeCompare(String(y[0])))) {
    by_category[id] = { n: c.n, k: c.k, m0: r4(clamp((c.k + SG.k_cat * global) / (c.n + SG.k_cat), SG.min, SG.max)) };
  }
  return { kind: GUESS_KIND, base: r4(b), global: r4(global), global_rate: n ? r4(k / n) : null, n, k, k_cat: SG.k_cat, k_global: SG.k_global,
    clamp: [SG.min, SG.max], by_category };
}

/** Whether the guess moved enough to adopt (pure): the overall m0 or any system's by SG.move or more. */
export function guessChanged(prev, next) {
  if (!prev) return true;
  const cats = new Set([...Object.keys(prev.by_category || {}), ...Object.keys(next.by_category || {})]);
  if (Math.abs(Number(prev.global) - Number(next.global)) >= SG.move) return true;
  for (const c of cats) if (Math.abs((guessM0(prev, c) ?? 0) - (guessM0(next, c) ?? 0)) >= SG.move) return true;
  return false;
}

/** The biggest system moves (pure): [{category_id, name, from, to}], at most SG.moves_shown, 1 point or more. */
export function guessMoves(prev, next, names = new Map()) {
  const cats = new Set([...Object.keys((prev && prev.by_category) || {}), ...Object.keys(next.by_category || {})]);
  return [...cats].map(c => ({ category_id: c, name: names.get(c) || c, from: guessM0(prev, c), to: guessM0(next, c) }))
    .filter(m => m.from != null && m.to != null && Math.abs(pc(m.to) - pc(m.from)) >= 1)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || String(a.name).localeCompare(String(b.name))).slice(0, SG.moves_shown);
}

/** The Recent activity words (pure): "Starting guess raised from 57% to 70% from your first answers (Cardiology 55 to 74%, ...)". */
export function guessLine(prev, next, moves = []) {
  const from = prev ? pc(prev.global) : null, to = pc(next.global);
  const verb = from == null || from === to ? 'set at' : to > from ? 'raised' : 'lowered';
  const head = verb === 'set at' ? `Starting guess set at ${to}%` : `Starting guess ${verb} from ${from}% to ${to}%`;
  const tail = moves.length ? ` (${moves.map(m => `${m.name} ${pc(m.from)} to ${pc(m.to)}%`).join(', ')})` : '';
  return `${head} from your first answers${tail}`;
}

/** The version adopted at or before `at` (pure). versions: [{adopted_at, params}] in any order; null when none. */
export function versionAt(versions, at) {
  let best = null;
  for (const v of versions || []) {
    const t = Number(v && v.adopted_at);
    if (!Number.isFinite(t) || t > Number(at)) continue;
    if (!best || t > Number(best.adopted_at)) best = v;
  }
  return best ? best.params : null;
}

/**
 * The same answers scored with a starting guess (pure, a dry comparison: nothing is stored or shown on the map). The
 * map's p is (1 - c)·m0 + c·R, so with c (the forecast's cert) kept, a new m0 moves p by (1 - c)·(m0_new - m0_used).
 * rows: question forecasts {day, at, p, y, m0, cert, band, category_id} (the 28-day window is cut here). In-sample: the
 * guess was learned from these same first answers, so this is a description, never the honesty test.
 */
export function dryComparison(rows, version, { now = Date.now() } = {}) {
  if (!version) return null;
  const since = now - WINDOW_DAYS * DAY_MS;
  const list = (rows || []).filter(r => r && r.stratum !== 'card' && Number(r.at) >= since && Number.isFinite(Number(r.p)) && (Number(r.y) === 0 || Number(r.y) === 1));
  if (!list.length) return { n: 0, text: 'Starting guess: no answers in the last 28 days to compare.' };
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const pNew = list.map(r => {
    const m = guessM0(version, r.category_id);
    const c = clamp(Number(r.cert) || 0, 0, 1);
    return clamp(Number(r.p) + (1 - c) * ((m ?? Number(r.m0)) - Number(r.m0)), 0, 1);
  });
  const ys = list.map(r => Number(r.y));
  const fresh = list.map((r, i) => ({ r, i })).filter(x => x.r.band === 'unseen');
  const out = {
    n: list.length, in_sample: true,
    now: { log_loss: r4(mean(list.map((r, i) => logLoss(r.p, ys[i])))), brier: r4(mean(list.map((r, i) => brier(r.p, ys[i])))), mean_p: r4(mean(list.map(r => Number(r.p)))) },
    with_guess: { log_loss: r4(mean(pNew.map((p, i) => logLoss(p, ys[i])))), brier: r4(mean(pNew.map((p, i) => brier(p, ys[i])))), mean_p: r4(mean(pNew)) },
    right_rate: r4(mean(ys)),
    new_topics: fresh.length ? { n: fresh.length, right_rate: r4(mean(fresh.map(x => ys[x.i]))), expected_now: r4(mean(fresh.map(x => Number(x.r.p)))),
      expected_with_guess: r4(mean(fresh.map(x => pNew[x.i]))) } : null,
  };
  const nt = out.new_topics;
  out.text = `With the new starting guess these ${out.n} answers would score log loss ${out.with_guess.log_loss.toFixed(3)} (now ${out.now.log_loss.toFixed(3)})`
    + (nt ? `; new topics expected ${pc(nt.expected_with_guess)}% (now ${pc(nt.expected_now)}%), ${pc(nt.right_rate)}% right` : '')
    + '. In-sample: the guess was learned from these first answers, so this is not the honesty test.';
  return out;
}

// ------------------------------------------------------------------ D1

export const FIRSTS_SQL = `SELECT category_id, y FROM forecasts WHERE user_id = ?1 AND retracted = 0 AND stratum = 'question' AND band = 'unseen' AND at <= ?2`;
export const VERSIONS_SQL = `SELECT id, adopted_at, params_json FROM model_versions WHERE user_id = ?1 AND adopted_at IS NOT NULL
  AND json_extract(params_json, '$.kind') = '${GUESS_KIND}' ORDER BY adopted_at`;

/** Every adopted version, oldest first: [{id, adopted_at, params}] ([] before 0051). */
export async function readVersions(env, user) {
  try {
    return ((await env.DB.prepare(VERSIONS_SQL).bind(user).all()).results || []).map(r => ({ id: r.id, adopted_at: Number(r.adopted_at), params: parse(r.params_json, null) }))
      .filter(v => v.params);
  } catch (e) { if (noTable(e)) return []; throw e; }
}

// FNV-1a: the same id for the same numbers.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * Nightly (honesty.js honestyJob, once its run has finished; and the hourly job until the first version exists): the
 * guess learned from every first answer so far; when it moved (or there is none yet) it is adopted now, the old rule's
 * priors kept once as 'sg:base' for the replay of earlier answers, the priors written and the stored scores re-read.
 * One Recent activity line a run (job 'starting_guess'), a failure too. Returns {changed, from, to, n} or {skipped}.
 */
export async function startingGuessJob(env, user, { now = Date.now() } = {}) {
  const DB = env.DB;
  try {
    const [firsts, priors, cats] = (await DB.batch([
      DB.prepare(FIRSTS_SQL).bind(user, now),
      DB.prepare('SELECT category_id, prior, g FROM category_priors WHERE user_id = ?1').bind(user),
      DB.prepare('SELECT id, name FROM categories WHERE user_id = ?1').bind(user),
    ])).map(r => r.results || []);
    const versions = await readVersions(env, user);
    const g = priors.find(p => p.g != null)?.g ?? null;
    const base = priorOf(0, 0, g);
    const next = startingGuess(firsts, base);
    const real = versions.filter(v => v.id !== SG.base_id);
    const cur = real.length ? real[real.length - 1].params : null;
    const names = new Map(cats.map(c => [c.id, c.name]));
    const writes = [];
    let baseline = (versions.find(v => v.id === SG.base_id) || {}).params || null;
    if (!baseline) {
      // The old rule's priors, as they stood before the first guess: what the honesty replay uses for earlier answers.
      const by = {};
      for (const p of priors) if (p.category_id != null && Number.isFinite(Number(p.prior))) by[p.category_id] = { m0: Number(p.prior) };
      baseline = { kind: GUESS_KIND, base: base, global: base, rule: 'old', by_category: by };
      writes.push(DB.prepare(`INSERT INTO model_versions (user_id, id, created_at, model_id, params_json, adopted_at, note) VALUES (?1, ?2, ?3, ?2, ?4, 0, ?5)
        ON CONFLICT (user_id, id) DO NOTHING`).bind(user, SG.base_id, now, JSON.stringify(baseline),
        'the starting guess before it was learned: the old rule (UWorld block rates per system, 0.50-0.72)'));
    }
    const prev = cur || baseline;
    const changed = !cur || guessChanged(cur, next);
    const moves = changed ? guessMoves(prev, next, names) : [];
    const line = guessLine(prev, next, moves);
    if (changed) {
      const id = `sg:${londonDay(now)}:${fnv(JSON.stringify(next))}`;
      writes.push(DB.prepare(`INSERT INTO model_versions (user_id, id, created_at, model_id, params_json, adopted_at, note) VALUES (?1, ?2, ?3, ?2, ?4, ?3, ?5)
        ON CONFLICT (user_id, id) DO UPDATE SET adopted_at = excluded.adopted_at, params_json = excluded.params_json, note = excluded.note`)
        .bind(user, id, now, JSON.stringify(next), line.slice(0, 200)));
    }
    if (writes.length) await DB.batch(writes);
    // The priors take the new guess and every stored score whose m0 moved is read again (exact: no evidence read).
    const pr = changed ? await refreshPriors(env, user, { now }) : null;
    await noteJob(env, { job: 'starting_guess', user, key: londonDay(now), at: now, state: 'ok', detail: changed ? line : null,
      counts: { changed: changed ? 1 : 0, from: pc(prev.global), to: pc(next.global), n: next.n, rescored: pr ? pr.written || 0 : 0 } });
    return { changed, from: prev.global, to: next.global, n: next.n, moves, line, rescored: pr ? pr.written || 0 : 0 };
  } catch (e) {
    if (noTable(e)) return { skipped: 'no forecasts or model_versions yet' };
    await noteJob(env, { job: 'starting_guess', user, key: londonDay(now), at: now, state: 'failed', detail: e });
    return { error: (e && e.message) || String(e) };
  }
}

/** The hourly job's first run: no wait for tonight when no guess has been learned yet (and there are forecasts). */
export async function startingGuessIfMissing(env, user, opts = {}) {
  const versions = await readVersions(env, user);
  if (versions.some(v => v.id !== SG.base_id)) return null;
  try {
    const any = await env.DB.prepare("SELECT 1 AS x FROM forecasts WHERE user_id = ?1 AND stratum = 'question' LIMIT 1").bind(user).first();
    if (!any) return null;
  } catch (e) { if (noTable(e)) return null; throw e; }
  return startingGuessJob(env, user, opts);
}
