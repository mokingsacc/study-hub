import { HttpError, json, readJson, londonDayStart } from '../util.js';
import { lookup, tierOf } from './change-kinds.js';
import { Refusal, REASONS, blockedKey, guardPlan } from './guard.js';

export const ACTORS = ['claude', 'mo', 'code'];
export const LIMITS = {
  per10min: 40, perDay: 300,     // Claude's batches
  maxRows: 100, confirmOver: 25,   // rows in one call
  importRows: 2000, importMs: 3 * 3600_000,
  undoFreeMs: 24 * 3600_000, undoFreeMax: 5,
};
export const CONFIRM_TTL_MS = 10 * 60_000;
export const UNDO_HINT = 'Say "undo that" to reverse it.';
const RATE_REASON = "That's a lot of changes at once. Ask Mo to say go on.";

// realtime's writer and undo, loaded when first used (tests swap them with _setIo). Literal paths, so wrangler
// bundles them.
const io = {
  writeBatch: async (...a) => (await import('./events.js')).writeBatch(...a),
  undoBatch: async (...a) => (await import('./undo.js')).undoBatch(...a),
};
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

const refused = (reason, field = null) => (field ? { refused: true, reason, field } : { refused: true, reason });
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table/i.test(String(e && e.message));
const rand = () => crypto.randomUUID().replace(/-/g, '');

// ---------------------------------------------------------------- confirm tokens
// canon(args): keys sorted at every level; confirm_token, surface and mo_said dropped at the top.
export function canon(args) {
  const sort = v => (Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v);
  const top = { ...(isObj(args) ? args : {}) };
  for (const k of ['confirm_token', 'surface', 'mo_said']) delete top[k];
  return JSON.stringify(sort(top));
}

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

async function hmac(env, text) {
  if (!env.HUB_KEY) throw new Refusal('The hub has no key, so it cannot confirm changes.');
  const k = await crypto.subtle.digest('SHA-256', enc.encode('practice-hub-confirm:' + env.HUB_KEY));
  const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// A token binding exactly this user, op and args for 10 minutes: exp36 + '.' + 22 chars of the MAC.
export async function confirmToken(env, user, op, args, now = Date.now()) {
  const exp = now + CONFIRM_TTL_MS;
  const mac = await hmac(env, `${user}|${op}|${canon(args)}|${exp}`);
  return { confirm_token: `${exp.toString(36)}.${b64url(mac).slice(0, 22)}`, expires_at: exp };
}

// {ok, batch_id} for a token that matches and has not expired; {ok: false, why} otherwise.
export async function checkToken(env, user, op, args, token, now = Date.now()) {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) return { ok: false, why: 'malformed' };
  const exp = parseInt(m[1], 36);
  const mac = await hmac(env, `${user}|${op}|${canon(args)}|${exp}`);
  if (b64url(mac).slice(0, 22) !== m[2]) return { ok: false, why: 'mismatch' };
  if (exp < now) return { ok: false, why: 'expired' };
  return { ok: true, batch_id: 'c_' + hex(mac).slice(0, 16) };
}

// ---------------------------------------------------------------- reads (one query each)
async function earlierResult(env, user, batchId) {
  const r = await env.DB.prepare(
    `SELECT max(seq) AS seq, count(*) AS n, (SELECT summary FROM map_events WHERE user_id = ?1 AND batch_id = ?2 ORDER BY seq LIMIT 1) AS summary
     FROM map_events WHERE user_id = ?1 AND batch_id = ?2`).bind(user, batchId).first();
  return r && r.n ? { ok: true, replay: true, batch_id: batchId, seq: r.seq, summary: r.summary } : null;
}

// Claude's batches in the last 10 minutes and since midnight in London.
export async function claudeBatches(env, user, now = Date.now()) {
  const since = Math.min(now - 600_000, londonDayStart(now));
  const r = await env.DB.prepare(
    `SELECT count(DISTINCT CASE WHEN at >= ?3 THEN batch_id END) AS recent, count(DISTINCT CASE WHEN at >= ?4 THEN batch_id END) AS today
     FROM map_events WHERE user_id = ?1 AND actor = 'claude' AND at >= ?2`).bind(user, since, now - 600_000, londonDayStart(now)).first();
  return { recent: (r && r.recent) || 0, today: (r && r.today) || 0 };
}

// An import run (import.start's event, target_id = run_id): active for 3 h, up to 2,000 rows.
export async function importRun(env, user, runId, now = Date.now()) {
  const r = await env.DB.prepare(
    `SELECT (SELECT at FROM map_events WHERE user_id = ?1 AND kind = 'import.started' AND target_id = ?2 ORDER BY seq DESC LIMIT 1) AS at,
            (SELECT count(*) FROM map_events WHERE user_id = ?1 AND batch_id LIKE ?3) AS used`).bind(user, runId, `${runId}.%`).first();
  if (!r || r.at == null) return { active: false, used: 0 };
  return { active: now - r.at <= LIMITS.importMs, used: r.used || 0, left: Math.max(0, LIMITS.importRows - (r.used || 0)) };
}

// ---------------------------------------------------------------- applyChange
function checkRequest(req) {
  if (!isObj(req)) return 'The change request is malformed.';
  if (!ACTORS.includes(req.actor)) return 'Unknown actor.';
  if (typeof req.op !== 'string' || !req.op) return 'Which change? (op is missing)';
  if (req.args != null && !isObj(req.args)) return 'The change arguments must be an object.';
  if (req.mo_said != null && (typeof req.mo_said !== 'string' || req.mo_said.length > 300)) return "mo_said is Mo's words, at most 300 characters.";
  if (req.surface != null && (typeof req.surface !== 'string' || req.surface.length > 30)) return 'surface is a short word such as chat, voice or web.';
  return null;
}

const plainSummary = plan => plan.summary || (plan.events || []).map(e => e.summary).filter(Boolean).slice(0, 3).join('; ') || 'Changed the hub';

export async function applyChange(env, user, req) {
  const bad = checkRequest(req);
  if (bad) return refused(bad);
  const { actor, op } = req;
  const args = req.args || {};
  const surface = req.surface || (actor === 'mo' ? 'web' : actor === 'code' ? 'code' : 'chat');
  // Where it came from (Recent activity): the hub page's device, or the connector's caller when it is known.
  const where = surface === 'web' && env && env.HUB_DEVICE ? ` · ${env.HUB_DEVICE}` : env && env.MCP_CLIENT ? ` · client:${env.MCP_CLIENT}` : '';
  const via = `${req.via || ''}${where}` || null;
  const mo_said = req.mo_said || null;
  const now = Date.now();

  const entry = lookup(op);
  if (!entry) return refused(/^cards?\./.test(op) ? REASONS.cards : `There is no change called ${op}.`);
  const key = blockedKey(args, entry.allowKeys || []);
  if (key) return refused(REASONS.code_decides, key);

  try {
    // A confirmed call: the token is checked first, and a replay returns the batch it already made.
    let confirmed = null;
    if (actor === 'claude' && req.confirm_token) {
      const t = await checkToken(env, user, op, args, req.confirm_token, now);
      if (t.ok) {
        confirmed = t.batch_id;
        const earlier = await earlierResult(env, user, confirmed).catch(e => { if (noTable(e)) return null; throw e; });
        if (earlier) return earlier;
      }
    }

    const runId = actor === 'claude' && typeof args.run_id === 'string' ? args.run_id : null;
    let run = null;
    if (runId) {
      run = await importRun(env, user, runId, now);
      if (!run.active) return refused('That import run has ended or does not exist. Start a new one with map_import_start.', 'run_id');
    }

    const ctx = { actor, surface, via, mo_said, now, run_id: runId, request_id: req.request_id || null };
    const plan = await entry.plan(env, user, args, ctx);
    if (!isObj(plan)) throw new Error(`planner for ${op} returned nothing`);
    if (plan.refuse) return refused(plan.refuse, plan.field || null);
    if (plan.statements) throw new Error(`planner for ${op} returned SQL; planners return row diffs`);
    if (plan.noop) return { ok: true, nothing: true, summary: plan.summary || 'Nothing to change.' };

    const checked = await guardPlan(env, user, op, entry, plan, { moSaid: mo_said });
    const count = Number.isFinite(plan.count) ? plan.count : checked.rows.length + ((checked.evidence && checked.evidence.upsert.length) || 0);
    const summary = plainSummary(checked);

    const tier = tierOf(entry, args, checked, ctx);
    if (tier === 'refused') return refused(entry.reason || 'That change is not allowed.');
    if (actor === 'claude') {
      if (count > LIMITS.maxRows) return refused(RATE_REASON);
      if (run && count > run.left) return refused(`This import run has ${run.left} of its ${LIMITS.importRows} rows left.`);
      const needsConfirm = tier === 'confirm' || (!run && count > LIMITS.confirmOver);
      if (!run) {
        const b = await claudeBatches(env, user, now).catch(e => { if (noTable(e)) return { recent: 0, today: 0 }; throw e; });
        if (b.recent >= LIMITS.per10min || b.today >= LIMITS.perDay) return refused(RATE_REASON);
      }
      if (needsConfirm && !confirmed) {
        const ask = checked.ask || (count > LIMITS.confirmOver ? `${summary}: ${count} changes in one go. Go ahead?` : `${summary}?`);
        return { needs_confirm: true, ask, preview: { op, count, changes: (checked.events || []).slice(0, 5).map(e => e.summary) }, ...(await confirmToken(env, user, op, args, now)) };
      }
    }

    const batch_id = confirmed || (runId ? `${runId}.${rand().slice(0, 12)}` : `b_${rand()}`);
    const undoable = entry.undoable !== false;
    if (entry.apply) {
      const r = await entry.apply(env, user, checked, { ...ctx, batch_id });
      return { summary, ...r };
    }
    const events = (checked.events || []).map(e => ({ kind: entry.kind, undoable, ...e }));
    const w = await io.writeBatch(env, user, {
      batch_id, actor, surface, via, mo_said, request_id: ctx.request_id,
      rows: checked.rows, events, evidence: checked.evidence || undefined,
      recompute: checked.touched_topics || [], undoable,
    });
    return { ok: true, batch_id: (w && w.batch_id) || batch_id, seq: w && w.seq, summary, ...(undoable ? { undo_hint: UNDO_HINT } : {}),
      ...(w && w.scores ? { scores: w.scores } : {}), ...(checked.reply || {}) };
  } catch (e) {
    if (e instanceof Refusal) return refused(e.reason, e.field);
    if (e instanceof HttpError && e.status < 500) return refused(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- REST
// The HTTP answer for an applyChange result: 200 done, 409 needs confirm or nothing undone, 400 refused.
export function changeResponse(r) {
  if (r.refused) return json({ error: r.reason, refused: true, ...(r.field ? { field: r.field } : {}) }, 400);
  if (r.needs_confirm) return json(r, 409);
  if (r.undone && !r.undone.length && r.conflicts && r.conflicts.length) return json({ error: r.conflicts[0].reason, ...r }, 409);
  return json(r);
}

export async function undoRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const args = {};
  for (const k of ['seq', 'batch_id', 'last']) if (body[k] != null) args[k] = body[k];
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'undo', args, via: 'api:POST /api/changes/undo' }));
}

// ---------------------------------------------------------------- op 'undo'
// Which batches: {seq} the batch holding that event, {batch_id}, or {last: n} the newest n undoable batches
// not yet undone (Claude's own when Claude asks), never an undo itself (undo one by seq to redo).
export async function planUndo(env, user, args, ctx) {
  const given = ['seq', 'batch_id', 'last'].filter(k => args[k] != null);
  if (given.length !== 1) return { refuse: 'Say which change to undo: seq, batch_id or last (1 to 5).' };
  for (const k of Object.keys(args)) if (!['seq', 'batch_id', 'last', 'run_id'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  const head = `SELECT batch_id, max(seq) AS seq, min(at) AS at, group_concat(DISTINCT actor) AS actors, sum(undoable) AS n,
    max(undone_by IS NOT NULL) AS undone, max(undo_of IS NOT NULL) AS is_undo,
    (SELECT summary FROM map_events x WHERE x.user_id = e.user_id AND x.batch_id = e.batch_id ORDER BY x.seq LIMIT 1) AS summary
    FROM map_events e WHERE user_id = ?1 AND batch_id IN`;
  let q;
  if (args.seq != null) {
    if (!Number.isInteger(args.seq) || args.seq < 1) return { refuse: 'seq is a change number from hub_changes.' };
    q = env.DB.prepare(`${head} (SELECT batch_id FROM map_events WHERE user_id = ?1 AND seq = ?2) GROUP BY batch_id`).bind(user, args.seq);
  } else if (args.batch_id != null) {
    if (typeof args.batch_id !== 'string' || args.batch_id.length > 80) return { refuse: 'batch_id is the id a change replied with.' };
    q = env.DB.prepare(`${head} (?2) GROUP BY batch_id`).bind(user, args.batch_id);
  } else {
    if (!Number.isInteger(args.last) || args.last < 1 || args.last > LIMITS.undoFreeMax) return { refuse: 'last is from 1 to 5.' };
    const mine = ctx.actor === 'claude' ? "AND actor = 'claude'" : "AND actor IN ('claude','mo')";
    q = env.DB.prepare(`${head} (SELECT batch_id FROM map_events WHERE user_id = ?1 ${mine} GROUP BY batch_id
        HAVING sum(undoable) > 0 AND max(undone_by IS NOT NULL) = 0 AND max(undo_of IS NOT NULL) = 0 ORDER BY max(seq) DESC LIMIT ?2)
      GROUP BY batch_id`).bind(user, args.last);
  }
  let batches;
  try { batches = ((await q.all()).results || []).sort((a, b) => b.seq - a.seq); } catch (e) {
    if (noTable(e)) return { refuse: 'There is nothing to undo yet.' };
    throw e;
  }
  if (!batches.length) return { refuse: args.last != null ? 'There is nothing to undo.' : 'No change has that number.' };
  for (const b of batches) {
    if (!b.n) return { refuse: `"${b.summary}" came from a log, so it is fixed at its source, not undone here.` };
    if (b.undone) return { refuse: `"${b.summary}" was already undone.` };
  }
  const n = batches.length;
  const label = n === 1 ? `Undo "${batches[0].summary}"` : `Undo ${n} changes: ${batches.map(b => `"${b.summary}"`).join(', ')}`;
  return { rows: [], events: [], batches, count: n, summary: label.slice(0, 300) };
}

export function undoTier(args, plan, ctx) {
  if (ctx.actor !== 'claude') return 'free';
  const now = ctx.now || Date.now();
  const own = plan.batches.every(b => String(b.actors) === 'claude' && now - b.at <= LIMITS.undoFreeMs);
  return own && plan.batches.length <= LIMITS.undoFreeMax ? 'free' : 'confirm';
}

// Newest first, one undoBatch each; a conflict is reported and the rest still run.
export async function applyUndo(env, user, plan, ctx) {
  const undone = [], conflicts = [];
  for (const b of plan.batches) {
    try {
      const r = await io.undoBatch(env, user, b.batch_id, { actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said });
      if (r && (r.conflict || r.refused)) { conflicts.push({ seq: b.seq, reason: r.reason || String(r.conflict) }); continue; }
      undone.push({ batch_id: (r && r.batch_id) || null, seq: r && r.seq, undid: b.batch_id, summary: b.summary });
    } catch (e) {
      if (e instanceof Refusal || (e instanceof HttpError && e.status === 409) || (e && e.conflict)) { conflicts.push({ seq: b.seq, reason: e.message }); continue; }
      throw e;
    }
  }
  const last = undone[undone.length - 1];
  return { ok: undone.length > 0, undone, conflicts, batch_id: last ? last.batch_id : null, seq: last ? last.seq : null,
    summary: undone.length ? `Undone: ${undone.map(u => u.summary).join('; ')}`.slice(0, 300) : 'Nothing was undone.' };
}
