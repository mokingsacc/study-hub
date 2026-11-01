// A D1 binding on node:sqlite, for fast Worker tests without wrangler. It follows the D1 Worker API that the
// hub uses: prepare().bind().first(col?) / all() / run() / raw(), batch() as one transaction, exec().
// It also counts queries the way Cloudflare does (a batch is one query), so a test can hold a code path to
// the Workers Free budget of 50 queries per invocation.
//
//   const { env, db, stats } = createD1();                 // every migration in worker/migrations applied
//   const { env } = createD1({ migrations: false, sql });  // only your own schema
//   stats.reset(); await someRoute(env); assert.ok(stats.queries <= 50);
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// D1's limit on one compound SELECT (UNION, UNION ALL, INTERSECT, EXCEPT); a subquery starts its own count.
export const D1_COMPOUND_MAX = 5;
// D1's limit on bound parameters in one query (Cloudflare D1 limits page).
export const D1_BIND_MAX = 100;
export function maxCompoundTerms(sql) {
  const stack = [0];
  let max = 1;
  const s = String(sql).replace(/'(?:''|[^'])*'/g, "''");
  for (const m of s.matchAll(/\(|\)|\b(UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi)) {
    if (m[0] === '(') stack.push(0);
    else if (m[0] === ')') { const n = stack.length > 1 ? stack.pop() : 0; max = Math.max(max, n + 1); }
    else stack[stack.length - 1]++;
  }
  for (const n of stack) max = Math.max(max, n + 1);
  return max;
}
export const MIGRATIONS_DIR = path.join(ROOT, 'worker/migrations');
export const FREE_QUERY_LIMIT = 50;

// The migration files in apply order, optionally only those whose number is <= upTo ('0009').
export function migrationFiles(upTo = null) {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f))
    .filter(f => !upTo || f.slice(0, 4) <= upTo).sort().map(f => path.join(MIGRATIONS_DIR, f));
}

// D1 refuses undefined and plain objects; booleans go in as 1 and 0.
function toSql(v, i) {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${i + 1})`);
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${String(v)}' (parameter ${i + 1})`);
}

const plain = row => (row ? { ...row } : row);
const d1Error = e => Object.assign(new Error(`D1_ERROR: ${e.message}`), { cause: e });

class Statement {
  constructor(d1, sql, params = []) { this.d1 = d1; this.sql = sql; this.params = params; }
  bind(...values) {
    // D1 refuses a query with more than 100 bound parameters (node:sqlite allows 32766).
    if (values.length > D1_BIND_MAX) throw new Error(`D1_ERROR: too many SQL variables (${values.length} > ${D1_BIND_MAX}): SQLITE_ERROR`);
    return new Statement(this.d1, this.sql, values.map(toSql));
  }
  _prepared() {
    // D1 refuses what node:sqlite allows: a compound SELECT of more than 5 terms (each parenthesised group counts alone).
    if (maxCompoundTerms(this.sql) > D1_COMPOUND_MAX) throw new Error('D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR');
    try { return this.d1.db.prepare(this.sql); } catch (e) { throw d1Error(e); }
  }
  _all() {
    const st = this._prepared();
    try {
      if (st.columns().length === 0) { // a write: D1 still answers with an empty result list
        const r = st.run(...this.params);
        return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
      }
      const results = st.all(...this.params).map(plain);
      return { results, success: true, meta: { changes: 0, last_row_id: 0, rows_read: results.length, duration: 0 } };
    } catch (e) { throw d1Error(e); }
  }
  async first(col) {
    this.d1.count(1);
    const r = this._all().results[0];
    if (r === undefined) return null;
    if (col === undefined) return r;
    if (!(col in r)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
    return r[col];
  }
  async all() { this.d1.count(1); return this._all(); }
  async run() { this.d1.count(1); return this._all(); }
  async raw({ columnNames = false } = {}) {
    this.d1.count(1);
    const { results } = this._all();
    const rows = results.map(r => Object.values(r));
    if (columnNames) rows.unshift(this._prepared().columns().map(c => c.name));
    return rows;
  }
}

export class FakeD1 {
  constructor(db, stats) { this.db = db; this.stats = stats; }
  count(n) {
    this.stats.queries += n;
    if (this.stats.limit && this.stats.queries > this.stats.limit) {
      throw new Error(`Too many API requests by single worker invocation (${this.stats.queries} > ${this.stats.limit})`);
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  // One transaction: every statement or none. One query against the budget, as on Cloudflare.
  async batch(statements) {
    if (!Array.isArray(statements)) throw new Error('D1_ERROR: batch() needs a list of statements');
    this.count(1);
    this.stats.batches++;
    this.stats.statements += statements.length;
    this.db.exec('BEGIN');
    try {
      const out = statements.map(s => s._all());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) {
    this.count(1);
    try { this.db.exec(sql); } catch (e) { throw d1Error(e); }
    return { count: sql.split(';').filter(s => s.trim()).length, duration: 0 };
  }
  async dump() { throw new Error('dump() is not supported by the fake'); }
}

/**
 * A fresh in-memory D1. Options:
 *   migrations  true (default) applies every worker/migrations file; false applies none.
 *   upTo        '0009' applies only migrations numbered up to that one (an older database).
 *   sql         extra SQL run after the migrations (a fragment, fixtures).
 *   limit       throw like Cloudflare once more than this many queries run (default: no limit).
 *   vars        extra env fields (HUB_KEY and the like).
 * Returns {env, DB, db (the raw DatabaseSync), stats, run(sql, ...params) for fixtures, close()}.
 */
// The migrations' text, read once per test process and kept (1 Nov 2026). Every createD1 used to list the folder and
// read every file again, many times a file: slower, and a test run open while the checkout changed (a pull, a branch
// switch, a worktree being set up) could list a file and then not find it ("ENOENT ... worker/migrations/...").
const migrationSql = new Map();
function migrationsText(upTo) {
  const key = upTo || '';
  if (!migrationSql.has(key)) migrationSql.set(key, migrationFiles(upTo).map(f => fs.readFileSync(f, 'utf8')));
  return migrationSql.get(key);
}

export function createD1({ migrations = true, upTo = null, sql = '', limit = 0, vars = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  if (migrations) for (const text of migrationsText(upTo)) db.exec(text);
  if (sql) db.exec(sql);
  const stats = {
    queries: 0, batches: 0, statements: 0, limit,
    reset() { this.queries = 0; this.batches = 0; this.statements = 0; },
  };
  const DB = new FakeD1(db, stats);
  return {
    env: { DB, ...vars }, DB, db, stats,
    // Fixture helpers that do not count against the budget.
    run: (q, ...params) => db.prepare(q).run(...params.map(toSql)),
    rows: (q, ...params) => db.prepare(q).all(...params.map(toSql)).map(plain),
    row: (q, ...params) => plain(db.prepare(q).get(...params.map(toSql))) ?? null,
    hasTable: name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name),
    close: () => db.close(),
  };
}
