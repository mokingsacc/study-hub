// Moving in (30 Oct): their own copy takes the export file from the shared Study Hub (GET /api/p/me/export), a
// table at a time in parts, so a year of study moves without going over a free-plan request. Only in owner mode
// (auth.ownerMode: the copy has a SETUP_CODE), where the hub is theirs alone, so the ids in the file are free.
// Every row is written as theirs (user_id is always the signed-in person), only into the tables an export holds,
// only into columns those tables have, and never over a row that is already there (INSERT OR IGNORE).
// Left out: library files, photos and page pictures (the files are not in the export; they upload them again).
//   POST /api/p/me/import  {table, rows}  ->  {table, sent, added}
import { HttpError, json, readJson } from '../util.js';
import { ownerMode } from './auth.js';
import { PLATFORM_EXPORT } from './export-tables.js';
import { MAP_EXPORT } from './me.js';

// In the order the page sends them.
export const MOVE_TABLES = [...Object.keys(PLATFORM_EXPORT).filter(n => n !== 'study_pictures'), ...MAP_EXPORT];
export const MAX_ROWS = 1000;
const PARAMS = 100;   // D1's bound parameters per statement

const columns = new Map();
async function columnsOf(env, table) {
  if (!columns.has(table)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    columns.set(table, new Set((results || []).map(c => c.name)));
  }
  return columns.get(table);
}

const value = v => (v == null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? (Number.isFinite(v) ? v : null)
  : typeof v === 'string' ? v : JSON.stringify(v));

export async function importRows(env, user, table, rows) {
  if (!ownerMode(env)) throw new HttpError(404, 'Moving data in is for your own copy of the Study Hub.');
  if (!MOVE_TABLES.includes(table)) throw new HttpError(400, `${String(table).slice(0, 40)} cannot be moved in.`);
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new HttpError(400, `Send rows as a list of at most ${MAX_ROWS}.`);
  const have = await columnsOf(env, table);
  const keys = new Set(['user_id']);
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'Each row must be an object.');
    for (const k of Object.keys(r)) if (have.has(k)) keys.add(k);
  }
  if (!have.has('user_id')) throw new HttpError(400, `${table} cannot be moved in.`);
  const cols = [...keys];
  const per = Math.max(1, Math.floor(PARAMS / cols.length));
  const statements = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const binds = part.flatMap(r => cols.map(c => (c === 'user_id' ? user : value(r[c]))));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`).bind(...binds));
  }
  const res = statements.length ? await env.DB.batch(statements) : [];
  return { table, sent: rows.length, added: res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0) };
}

export const ROUTES = [
  ['POST', '/api/p/me/import', async (rq, env, ctx, params, url, user) => {
    const b = await readJson(rq, 4_000_000);
    return json(await importRows(env, user, b && b.table, b && b.rows));
  }],
];
