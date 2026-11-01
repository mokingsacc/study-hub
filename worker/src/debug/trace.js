import { AsyncLocalStorage } from 'node:async_hooks';

export const TRACE = { slowMs: 3000, cronSlowMs: 25_000, sqlMax: 300, stmtMax: 120, batchSqlMax: 8, paramsMax: 12,
  keepDays: 7, rowsMax: 2000, jsonMax: 64_000, ringMax: 20, claudeMax: 30, jobsMax: 30, switchTtlMs: 60_000 };
export const KEEP_WHY = ['error', 'slow', 'asked', 'failed_job', 'report'];
const DAY = 86_400_000;
const als = new AsyncLocalStorage();
const safe = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ------------------------------------------------------------------ ids (W3C Trace Context)

const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export const newTraceId = () => { let id; do id = hex(16); while (/^0+$/.test(id)); return id; };
/** The trace-id of a W3C traceparent header ('00-<32 hex>-<16 hex>-<2 hex>'), or null (all zeros and version ff are invalid). */
export function traceIdOf(header) {
  const m = TRACEPARENT_RE.exec(String(header || '').trim().toLowerCase());
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return m[2];
}

// ------------------------------------------------------------------ the trace

const cutSql = s => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > TRACE.sqlMax ? `${t.slice(0, TRACE.sqlMax - 1)}…` : t; };
/** A bound value's shape, never the value: s12, n, null, b (bytes), bool. */
const shapeOf = v => (v == null ? 'null' : typeof v === 'string' ? `s${v.length}` : typeof v === 'number' || typeof v === 'bigint' ? 'n'
  : typeof v === 'boolean' ? 'bool' : ArrayBuffer.isView(v) || v instanceof ArrayBuffer ? 'b' : typeof v);
const shapesOf = p => (Array.isArray(p) ? p.slice(0, TRACE.paramsMax).map(shapeOf) : null);
const errLine = e => String((e && e.message) || e || 'error').split('\n')[0].slice(0, 300);

export class Trace {
  constructor({ kind = 'api', method = null, path = null, route = null, id = null, at = Date.now() } = {}) {
    this.id = TRACE_ID_RE.test(String(id || '')) ? id : newTraceId();
    this.kind = kind;            // api | mcp | cron
    this.method = method;
    this.path = path;            // the address asked for (no query string; the connector's token never)
    this.route = route;          // the matched route pattern ('GET /api/map/topic/:id'), or 'cron <job>'
    this.at = at;
    this.t0 = Date.now();
    this.ms = null;
    this.status = null;
    this.db = [];                // [{m, sql, ms, rows?, changes?, n?, err?, shapes?}]
    this.dbN = 0;                // every call, the ones past stmtMax included
    this.dbMs = 0;
    this.claude = [];            // [{role, mode, usd, stop}]
    this.audits = [];            // [{job, items, missing}]
    this.jobs = [];              // [{job, key, state}]
    this.tools = [];             // connector tools called
    this.error = null;           // {message, stack}
    this.keep = null;            // a reason set before the end (asked, failed_job)
  }
  noteDb(rec) {
    this.dbN++;
    this.dbMs += rec.ms || 0;
    if (this.db.length < TRACE.stmtMax || (rec.err && this.db.length < TRACE.stmtMax + 10)) this.db.push(rec);
  }
  fail(e) {
    if (this.error) return;
    this.error = { message: errLine(e), stack: String((e && e.stack) || '').split('\n').slice(0, 12).join('\n').slice(0, 2000) || null };
  }
  noteClaude({ role, mode, usd, stop } = {}) {
    if (this.claude.length < TRACE.claudeMax) this.claude.push({ role: role || null, mode: mode || null, usd: Number.isFinite(usd) ? Math.round(usd * 1e5) / 1e5 : null, stop: stop || null });
  }
  noteAudit({ job, items, missing } = {}) {
    if (this.audits.length < TRACE.claudeMax) this.audits.push({ job: job || null, items: Number(items) || 0, missing: Number(missing) || 0 });
  }
  noteJob(job, key, state) {
    if (this.jobs.length < TRACE.jobsMax) this.jobs.push({ job, key: key == null ? null : String(key).slice(0, 60), state: state || 'ok' });
    if (state === 'failed') this.want('failed_job');
  }
  noteTool(name) { if (this.tools.length < 10) this.tools.push(String(name || '').slice(0, 60)); }
  want(why) { if (!this.keep && KEEP_WHY.includes(why)) this.keep = why; }
  finish(status = null) {
    if (this.ms == null) this.ms = Date.now() - this.t0;
    if (status != null) this.status = status;
    return this;
  }
  /** The trace as stored: SQL whitespace collapsed, held under TRACE.jsonMax by dropping statements from the middle. */
  toJSON() {
    const db = this.db.map(r => ({ ...r, sql: Array.isArray(r.sql) ? r.sql.map(cutSql) : cutSql(r.sql) }));
    const out = { id: this.id, kind: this.kind, method: this.method, path: this.path, route: this.route, at: this.at, ms: this.ms, status: this.status,
      error: this.error, db_calls: this.dbN, db_ms: this.dbMs, db, dropped: Math.max(0, this.dbN - db.length), claude: this.claude,
      audits: this.audits, jobs: this.jobs, tools: this.tools };
    while (JSON.stringify(out).length > TRACE.jsonMax && out.db.length > 4) {
      out.db.splice(Math.floor(out.db.length / 4), Math.ceil(out.db.length / 2));
      out.dropped = Math.max(0, this.dbN - out.db.length);
    }
    if (JSON.stringify(out).length > TRACE.jsonMax) { out.db = []; out.dropped = this.dbN; if (out.error && out.error.stack) out.error.stack = out.error.stack.slice(0, 1000); }
    return out;
  }
}

export const currentTrace = () => safe(() => als.getStore()) || null;
/** Runs fn inside the trace: every await under it, background work included, sees currentTrace() === trace. */
export const withTrace = (trace, fn) => als.run(trace, fn);
/** Notes into the current trace, if any; never throws (for claude.js, ai-audit.js, job-log.js, router.js, mcp.js). */
export function noteTrace(fn) { const t = currentTrace(); if (t) safe(() => fn(t)); return t; }

// ------------------------------------------------------------------ the recording Proxy

const RAW = Symbol('trace.raw');

/** A prepared statement that notes its run into the trace current when it runs. */
class TracedStmt {
  constructor(stmt, sql, params = null) { this._s = stmt; this._sql = sql; this._p = params; }
  bind(...values) { return new TracedStmt(this._s.bind(...values), this._sql, values); }
  first(col) { return timed(this, 'first', () => (col === undefined ? this._s.first() : this._s.first(col)), r => ({ rows: r == null ? 0 : 1 })); }
  all() { return timed(this, 'all', () => this._s.all(), r => ({ rows: r && Array.isArray(r.results) ? r.results.length : 0 })); }
  run() { return timed(this, 'run', () => this._s.run(), r => ({ changes: r && r.meta ? Number(r.meta.changes) || 0 : 0 })); }
  raw(opts) { return timed(this, 'raw', () => (opts === undefined ? this._s.raw() : this._s.raw(opts)), r => ({ rows: Array.isArray(r) ? r.length : 0 })); }
}
// The test's hook: makes every note throw, to show the answers do not change.
export const _hooks = { record: null };
function note(t, rec) { safe(() => { if (_hooks.record) _hooks.record(rec); t.noteDb(rec); }); }

async function timed(st, m, call, sizeOf) {
  const t = currentTrace();
  if (!t) return call();
  const t0 = Date.now();
  let r;
  try {
    r = await call();
  } catch (e) {
    note(t, { m, sql: st._sql, ms: Date.now() - t0, err: errLine(e), shapes: shapesOf(st._p) });
    throw e;
  }
  note(t, { m, sql: st._sql, ms: Date.now() - t0, ...(safe(() => sizeOf(r), {}) || {}) });
  return r;
}

async function tracedBatch(db, stmts) {
  const list = Array.isArray(stmts) ? stmts.map(s => (s instanceof TracedStmt ? s._s : s)) : stmts;
  const t = currentTrace();
  if (!t) return db.batch(list);
  const t0 = Date.now();
  const sqlOf = () => safe(() => stmts.slice(0, TRACE.batchSqlMax).map(s => (s instanceof TracedStmt ? s._sql : '?')), []);
  const n = Array.isArray(stmts) ? stmts.length : 0;
  let out;
  try {
    out = await db.batch(list);
  } catch (e) {
    // D1 does not say which statement failed: the shapes of the batch's first statements' values are noted.
    note(t, { m: 'batch', n, sql: sqlOf(), ms: Date.now() - t0, err: errLine(e),
      shapes: safe(() => stmts.slice(0, TRACE.batchSqlMax).map(s => (s instanceof TracedStmt ? shapesOf(s._p) : null)), null) });
    throw e;
  }
  const size = safe(() => {
    let rows = 0, changes = 0;
    for (const r of out || []) { rows += r && Array.isArray(r.results) ? r.results.length : 0; changes += r && r.meta ? Number(r.meta.changes) || 0 : 0; }
    return { rows, changes };
  }, {});
  note(t, { m: 'batch', n, sql: sqlOf(), ms: Date.now() - t0, ...size });
  return out;
}

async function tracedExec(db, sql) {
  const t = currentTrace();
  if (!t) return db.exec(sql);
  const t0 = Date.now();
  let r;
  try { r = await db.exec(sql); } catch (e) { note(t, { m: 'exec', sql: String(sql).slice(0, 400), ms: Date.now() - t0, err: errLine(e) }); throw e; }
  note(t, { m: 'exec', sql: String(sql).slice(0, 400), ms: Date.now() - t0 });
  return r;
}

const proxies = new WeakMap();
/** env.DB behind the recording Proxy: the same Proxy for the same binding every time. */
export function tracedDb(db) {
  if (!db || typeof db !== 'object' || db[RAW]) return db;
  let p = proxies.get(db);
  if (p) return p;
  const prepare = sql => new TracedStmt(db.prepare(sql), String(sql).slice(0, TRACE.sqlMax * 2));
  const batch = stmts => tracedBatch(db, stmts);
  const exec = sql => tracedExec(db, sql);
  p = new Proxy(db, {
    get(target, prop) {
      if (prop === RAW) return target;
      if (prop === 'prepare') return prepare;
      if (prop === 'batch') return batch;
      if (prop === 'exec') return exec;
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  proxies.set(db, p);
  return p;
}
/** The binding under the Proxy (the binding itself when it is not one). */
export const rawDb = db => (db && db[RAW]) || db;
/** env with its DB behind the Proxy (a new object; the env given is untouched). */
export const tracedEnv = env => (env && env.DB && typeof env.DB === 'object' && !env.DB[RAW] ? { ...env, DB: tracedDb(env.DB) } : env);

// ------------------------------------------------------------------ the kill switch

const sw = { on: true, at: 0, db: null };
/** The hub setting debug_capture (default on), at most once a minute per isolate. Never throws: unreadable means on. */
export async function captureOn(env, { now = Date.now() } = {}) {
  try {
    if (!env || !env.DB) return false;
    if (env.DEBUG_CAPTURE === 'off') return false;
    const raw = rawDb(env.DB);
    if (sw.db === raw && now - sw.at < TRACE.switchTtlMs) return sw.on;
    let on = true;
    try {
      const r = await raw.prepare("SELECT value FROM settings WHERE key = 'debug_capture'").first();
      on = !(r && String(r.value).trim() === 'false');
    } catch { on = true; }
    Object.assign(sw, { on, at: now, db: raw });
    return on;
  } catch { return false; }
}
/** For the tests and the setting's change: the next captureOn reads afresh. */
export function _resetSwitch() { Object.assign(sw, { on: true, at: 0, db: null }); }

// ------------------------------------------------------------------ keeping

/** Why this trace is kept, or null. cron: a failure, or over cronSlowMs (a minute job often runs long on purpose). */
export function keepReason(t) {
  if (!t) return null;
  if (t.keep) return t.keep;
  if (t.error || (t.status != null && t.status >= 500)) return 'error';
  if (t.ms != null && t.ms > (t.kind === 'cron' ? TRACE.cronSlowMs : TRACE.slowMs)) return 'slow';
  return null;
}

const ring = [];
/** A finished request trace into the isolate's ring (the last TRACE.ringMax). */
export function remember(t) {
  if (!t) return;
  ring.push(t);
  if (ring.length > TRACE.ringMax) ring.shift();
}
export const fromRing = id => ring.find(t => t.id === id) || null;
export const _ring = () => ring;

const noTable = e => /no such table/i.test(String(e && e.message));

/** One row in debug_traces. Never throws; quiet before 0072. bugId pins it to a report. */
export async function persistTrace(db, t, why, { bugId = null, now = Date.now() } = {}) {
  try {
    if (!db || !t) return false;
    const raw = rawDb(db);
    const j = typeof t.toJSON === 'function' ? t.toJSON() : t;
    await raw.prepare(`INSERT INTO debug_traces (id, user_id, at, kind, route, status, ms, why, error, trace_json, bug_id, expires_at)
      VALUES (?1, 'mo', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT (user_id, id) DO UPDATE SET bug_id = coalesce(excluded.bug_id, debug_traces.bug_id)`)
      .bind(j.id, Number(j.at) || now, j.kind || 'api', j.route || (j.method && j.path ? `${j.method} ${j.path}` : j.path || null),
        j.status ?? null, j.ms ?? null, KEEP_WHY.includes(why) ? why : 'asked', j.error ? j.error.message : null,
        JSON.stringify(j), bugId, now + TRACE.keepDays * DAY).run();
    return true;
  } catch (e) {
    if (!noTable(e)) safe(() => console.error('trace not kept', e && e.message));
    return false;
  }
}

/** The nightly sweep: expired rows not pinned to an open report, then the oldest past `max`. Never throws. */
export async function pruneTraces(db, { now = Date.now(), max = TRACE.rowsMax } = {}) {
  try {
    const raw = rawDb(db);
    const res = await raw.batch([
      raw.prepare(`DELETE FROM debug_traces WHERE expires_at < ?1
        AND (bug_id IS NULL OR bug_id NOT IN (SELECT id FROM bug_reports WHERE user_id = debug_traces.user_id AND state = 'open'))`).bind(now),
      raw.prepare(`DELETE FROM debug_traces WHERE id IN (SELECT id FROM debug_traces WHERE bug_id IS NULL ORDER BY at DESC LIMIT -1 OFFSET ?1)`).bind(max),
    ]);
    return { expired: Number(res[0].meta.changes) || 0, over: Number(res[1].meta.changes) || 0 };
  } catch (e) {
    if (!noTable(e)) safe(() => console.error('traces not pruned', e && e.message));
    return null;
  }
}

// ------------------------------------------------------------------ the boundaries (index.js, cron.js)

const noBody = new Set([101, 204, 205, 304]);
/** The response with X-Trace-Id set (copied when its headers are fixed); a WebSocket's 101 is never touched. */
export function withTraceId(res, id) {
  if (!res || res.status === 101 || res.webSocket) return res;
  try { res.headers.set('X-Trace-Id', id); return res; } catch {
    const r = new Response(noBody.has(res.status) ? null : res.body, res);
    r.headers.set('X-Trace-Id', id);
    return r;
  }
}

/** Finished: into the ring (requests only), and kept when keepReason says so (in the background). Never throws. */
export function settleTrace(t, env, ctx, { ring: inRing = true } = {}) {
  return safe(() => {
    t.finish();
    if (inRing) remember(t);
    const why = keepReason(t);
    if (!why || !env || !env.DB) return null;
    const p = persistTrace(env.DB, t, why);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    return p;
  }, null);
}

/**
 * One /api/* or /mcp/* request inside its trace: serve(request, env, ctx, url) gets env with its DB behind the Proxy.
 * The answer gains X-Trace-Id; its body, status and streaming are untouched (the time ends when the handler hands back
 * its Response, not when a stream ends). X-Trace-Keep: 1 keeps it, except on a refused key (401, or the connector's 404),
 * so nobody without the key can fill the table. With capture off, or if the trace cannot be set up, serve runs alone.
 */
export async function traceRequest(request, env, ctx, url, serve) {
  let t = null, tenv = env;
  try {
    if (await captureOn(env)) {
      const mcp = url.pathname.startsWith('/mcp/');
      t = new Trace({ kind: mcp ? 'mcp' : 'api', method: request.method, path: mcp ? '/mcp/<token>' : url.pathname, id: traceIdOf(request.headers.get('traceparent')) });
      tenv = tracedEnv(env);
    }
  } catch { t = null; tenv = env; }
  if (!t) return serve(request, env, ctx, url);
  let res;
  try {
    res = await withTrace(t, () => serve(request, tenv, ctx, url));
  } catch (e) {
    safe(() => { t.fail(e); t.finish(500); settleTrace(t, env, ctx); });
    throw e;
  }
  return safe(() => {
    t.finish(res ? res.status : null);
    const mcp = t.kind === 'mcp';
    if (request.headers.get('X-Trace-Keep') === '1' && res && res.status !== 401 && !(mcp && res.status === 404)) t.want('asked');
    settleTrace(t, env, ctx);
    return withTraceId(res, t.id);
  }, res);
}

/** One cron job inside its own trace (kind cron). Returns {trace, promise}; trace is null when capture is off. */
export function traceJob(name, event, run, on = true) {
  if (!on) return { trace: null, promise: Promise.resolve().then(run) };
  const t = safe(() => new Trace({ kind: 'cron', method: 'CRON', path: event && event.cron ? String(event.cron) : null, route: `cron ${name}` }), null);
  if (!t) return { trace: null, promise: Promise.resolve().then(run) };
  return { trace: t, promise: withTrace(t, () => Promise.resolve().then(run)) };
}
