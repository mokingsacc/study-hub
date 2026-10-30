import { HttpError, json, readJson } from '../util.js';
import { MO } from '../users.js';
import { writeBatch } from './events.js';
import { drainDirty } from './recompute.js';
import { refreshPriors } from './weakness.js';
import { queryBudget } from './feed.js';
import { countingEnv } from './d1-count.js';

export const PARTS = ['scores', 'hub', 'uworld', 'gaps', 'anki'];
export const STEP = 40;
export const TIME_MS = 20_000;
// The D1 queries ingest spends per source row (a guess on the high side), and per Anki page.
const PER_ROW = { hub: 5, uworld: 8, gaps: 5, anki: 12 };
const LABEL = { scores: 'Scores', hub: 'Hub exams', uworld: 'UWorld blocks', gaps: 'Gaps', anki: 'The Anki log' };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table/i.test(String(e && e.message));
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

// ------------------------------------------------------------------ counting D1

// countingEnv lives in d1-count.js (ingest's Anki jobs and the minute cron count with it too).
export { countingEnv };

// ------------------------------------------------------------------ ingest's functions

// Loaded when first used (tests swap them with _setIngest). Each part names the function it needs.
let ingest;
export function _setIngest(mods) { const prev = ingest; ingest = mods; return () => { ingest = prev; }; }
async function loadIngest() {
  if (ingest !== undefined) return ingest;
  const load = async f => { try { return await f(); } catch (e) { console.error('rebuild: an ingest module is missing', e && e.message); return {}; } };
  ingest = {
    hub: await load(() => import('./ingest/hub.js')),
    gaps: await load(() => import('./ingest/gaps.js')),
    anki: await load(() => import('./ingest/anki.js')),
  };
  return ingest;
}

// ------------------------------------------------------------------ the parts

// One step of a part from `cursor`: {n, cursor, done}. Each reads up to STEP source rows in one query and hands
// them to ingest; a row ingest refuses is counted in `failed` and skipped, so one bad row never stalls a part.
const STEPS = {
  // Every analysis with a verdict, in (block, question) order. ingest decides misses, evidence and the hold.
  async hub(env, user, cursor, mods, limit) {
    if (user !== MO) return { n: 0, cursor, done: true };
    const fn = mods.hub.ingestAnalysis;
    if (typeof fn !== 'function') throw new HttpError(501, 'Hub exams cannot be rebuilt yet (ingest/hub.js ingestAnalysis is missing).');
    const c = isObj(cursor) ? cursor : { block: '', q: -1 };
    const rows = (await env.DB.prepare(`SELECT block_id, q_index FROM analyses WHERE status = 'done' AND verdict IS NOT NULL
      AND (block_id > ?1 OR (block_id = ?1 AND q_index > ?2)) ORDER BY block_id, q_index LIMIT ?3`).bind(c.block, c.q, limit).all()).results || [];
    let failed = 0;
    for (const r of rows) {
      try { await fn(env, user, r.block_id, r.q_index); } catch (e) { failed++; console.error('rebuild hub: ingestAnalysis failed', r.block_id, r.q_index, e && e.message); }
    }
    const last = rows[rows.length - 1];
    return { n: rows.length, failed, cursor: last ? { block: last.block_id, q: last.q_index } : c, done: rows.length < limit };
  },
  async uworld(env, user, cursor, mods, limit) {
    if (user !== MO) return { n: 0, cursor, done: true };
    const fn = mods.hub.ingestUworldQuestions;
    if (typeof fn !== 'function') throw new HttpError(501, 'UWorld blocks cannot be rebuilt yet (ingest/hub.js ingestUworldQuestions is missing).');
    const c = typeof cursor === 'string' ? cursor : '';
    const rows = (await env.DB.prepare(`SELECT id, questions_json FROM uworld_blocks WHERE id > ? ORDER BY id LIMIT ?`).bind(c, limit).all()).results || [];
    let failed = 0, n = 0;
    for (const r of rows) {
      const qs = parse(r.questions_json);
      if (!Array.isArray(qs) || !qs.length) continue;
      try { await fn(env, user, r.id, qs); n += qs.length; } catch (e) { failed++; console.error('rebuild uworld: ingest failed', r.id, e && e.message); }
    }
    const last = rows[rows.length - 1];
    return { n, failed, cursor: last ? last.id : c, done: rows.length < limit };
  },
  // Every gap of the user's, oldest first, a step in one ingestGaps call (row by row if that fails, so one bad
  // gap is skipped alone). Idempotent: one observation per gap id.
  async gaps(env, user, cursor, mods, limit) {
    const fn = mods.gaps.ingestGap, many = mods.gaps.ingestGaps;
    if (typeof fn !== 'function') throw new HttpError(501, 'Gaps cannot be rebuilt yet (ingest/gaps.js ingestGap is missing).');
    const c = isObj(cursor) ? cursor : { at: -1, id: '' };
    const rows = (await env.DB.prepare(`SELECT * FROM gaps WHERE user_id = ?1 AND (at > ?2 OR (at = ?2 AND id > ?3)) ORDER BY at, id LIMIT ?4`)
      .bind(user, c.at, c.id, limit).all()).results || [];
    let failed = 0, done = false;
    if (typeof many === 'function' && rows.length > 1) {
      try { await many(env, user, rows); done = true; } catch (e) { console.error('rebuild gaps: ingestGaps failed; row by row', e && e.message); }
    }
    if (!done) {
      for (const r of rows) {
        try { await fn(env, user, r); } catch (e) { failed++; console.error('rebuild gaps: ingestGap failed', r.id, e && e.message); }
      }
    }
    const last = rows[rows.length - 1];
    return { n: rows.length, failed, cursor: last ? { at: last.at, id: last.id } : c, done: rows.length < limit };
  },
  // The whole Anki mistake log, a page at a time, through ingest's own step (it owns the Anki calls and merging).
  // The step mirrors only as many records as `left` (the queries the runner has left) allows (B2-2).
  async anki(env, user, cursor, mods, limit, left) {
    const fn = mods.anki.rebuildAnkiStep;
    if (typeof fn !== 'function') throw new HttpError(501, 'The Anki log cannot be rebuilt yet (ingest/anki.js rebuildAnkiStep is missing).');
    const r = await fn(env, user, { cursor: cursor ?? null, limit: 100, budget: Math.max(4, left) });
    return { n: (r && r.n) || 0, failed: (r && r.failed) || 0, cursor: r ? r.cursor ?? null : cursor, done: !r || !r.more };
  },
};

// The scores part: every topic with a score row or live evidence into topic_dirty (one statement), then drained
// 20 at a time; drainDirty sends map.resync once the queue is empty.
async function startScores(env, user, now) {
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at)
        SELECT ?1, topic_id, 'rebuild', ?2 FROM topic_scores WHERE user_id = ?1
        UNION SELECT ?1, topic_id, 'rebuild', ?2 FROM evidence WHERE user_id = ?1 AND held = 0 AND topic_id IS NOT NULL
        ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = 'rebuild', at = excluded.at`).bind(user, now),
      env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, 'rebuild:scores', 'draining', ?2)
        ON CONFLICT (user_id, source) DO UPDATE SET cursor = 'draining', last_ok_at = excluded.last_ok_at`).bind(user, now),
    ]);
  } catch (e) {
    if (!noTable(e)) throw e;
    // Without weakness's table yet: only the topics with evidence.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO topic_dirty (user_id, topic_id, reason, at) SELECT DISTINCT ?1, topic_id, 'rebuild', ?2 FROM evidence
        WHERE user_id = ?1 AND held = 0 AND topic_id IS NOT NULL ON CONFLICT (user_id, topic_id) DO UPDATE SET reason = 'rebuild', at = excluded.at`).bind(user, now),
      env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, 'rebuild:scores', 'draining', ?2)
        ON CONFLICT (user_id, source) DO UPDATE SET cursor = 'draining', last_ok_at = excluded.last_ok_at`).bind(user, now),
    ]);
  }
}

// ------------------------------------------------------------------ the runner

async function readState(env, user, part) {
  const r = await env.DB.prepare('SELECT cursor, last_error FROM sync_state WHERE user_id = ? AND source = ?').bind(user, `rebuild:${part}`).first();
  return r ? { cursor: parse(r.cursor), running: true } : { cursor: null, running: false };
}

function saveState(env, user, part, cursor, error, now) {
  return env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, last_error) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error`)
    .bind(user, `rebuild:${part}`, JSON.stringify(cursor ?? null), now, error ?? null);
}

/**
 * Runs one part as far as the budget allows. restart: begin again from the start instead of carrying on.
 * Returns {part, done, n, failed, cursor?, left?}.
 */
export async function rebuildPart(env, user, part, { restart = false, timeMs = TIME_MS, now = Date.now } = {}) {
  if (!PARTS.includes(part)) throw new HttpError(400, `part is one of ${PARTS.join(', ')}.`);
  const { env: cenv, counter } = countingEnv(env);
  const budget = queryBudget(env) - 3;
  const start = now();
  const fits = per => counter.n + per < budget && now() - start < timeMs;

  if (part === 'scores') {
    const st = await readState(cenv, user, 'scores');
    if (restart || !st.running) {
      // Priors first, so every row is re-read with the day's category priors (not only at the 03:44 run).
      try { await refreshPriors(cenv, user, { now: now() }); } catch (e) { console.error('rebuild scores: refreshPriors failed', e && e.message); }
      await startScores(cenv, user, now());
    }
    let n = 0, left = 0;
    while (fits(4)) {
      const d = await drainDirty(cenv, user, { limit: 20, actor: 'code', surface: 'code' });
      n += d.n;
      left = d.left;
      if (d.error || !d.n || d.left <= 0) { left = d.error ? d.left : left; break; }
    }
    return { part, done: left <= 0, n, left };
  }

  const mods = await loadIngest();
  const st = restart ? { cursor: null } : await readState(cenv, user, part);
  let cursor = st.cursor, n = 0, failed = 0, done = false, steps = 0;
  // Rows per step from what is left of the budget: each source row costs ingest a few queries.
  const perRow = PER_ROW[part];
  const room = () => Math.floor((budget - counter.n - 3) / perRow);
  while (!done && (steps === 0 || (room() >= 1 && fits(perRow + 2)))) {
    let r;
    try {
      r = await STEPS[part](cenv, user, cursor, mods, Math.max(1, Math.min(part === 'uworld' ? STEP / 4 : STEP, room())), budget - counter.n - 6);
    } catch (e) {
      // A step that fails after others worked keeps their place, so the next POST or the minute cron carries on.
      if (!steps || e instanceof HttpError) throw e;
      console.error('rebuild step failed', part, e && e.message);
      await saveState(cenv, user, part, cursor, String((e && e.message) || e).slice(0, 200), now()).run().catch(() => {});
      return { part, done: false, n, failed, cursor, error: String((e && e.message) || e).slice(0, 200) };
    }
    steps++;
    n += r.n;
    failed += r.failed || 0;
    cursor = r.cursor;
    done = r.done;
  }
  if (done) {
    await writeBatch(cenv, user, {
      actor: 'code', surface: 'code', via: `rebuild:${part}`, undoable: false,
      statements: [cenv.DB.prepare('DELETE FROM sync_state WHERE user_id = ? AND source = ?').bind(user, `rebuild:${part}`)],
      events: [{ kind: 'map.resync', target_type: 'map', summary: `${LABEL[part]} rebuilt into the map`, after: { reason: `rebuild:${part}`, n, failed } }],
    });
  } else {
    await saveState(cenv, user, part, cursor, failed ? `${failed} rows failed` : null, now()).run();
  }
  return { part, done, n, failed, ...(done ? {} : { cursor }) };
}

// POST /api/map/rebuild {part, restart?}
export async function rebuildRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000);
  if (!PARTS.includes(body.part)) return json({ error: `Say which part to rebuild: ${PARTS.join(', ')}.` }, 400);
  try {
    return json(await rebuildPart(env, user, body.part, { restart: body.restart === true }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (noTable(e)) return json({ error: 'The map tables are not set up yet (migration 0010).' }, 503);
    throw e;
  }
}

// The minute cron's share (ingest's dispatcher calls it): carries on the oldest unfinished part, if any.
export async function rebuildTick(env, user) {
  let r;
  try { r = await env.DB.prepare("SELECT source FROM sync_state WHERE user_id = ? AND source LIKE 'rebuild:%' ORDER BY last_ok_at LIMIT 1").bind(user).first(); } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
  if (!r) return null;
  const part = r.source.slice('rebuild:'.length);
  if (!PARTS.includes(part)) return null;
  try { return await rebuildPart(env, user, part, { timeMs: 8_000 }); } catch (e) {
    console.error('rebuildTick failed', part, e && e.message);
    return { part, error: String(e && e.message).slice(0, 200) };
  }
}
