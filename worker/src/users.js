import { safeParse, now, HttpError } from './util.js';
import { buildProfile, deepMerge, DEFAULT_PROFILE, ROLES, STATUSES } from './profiles.js';
import { prefSpecs } from './map/registry/index.js';

export const MO = 'mo';
export { ROLES, STATUSES };

export async function currentUser(env, request) {
  if (env && env.HUB_OFF === '1') throw new HttpError(401, 'Please sign in.');
  return MO;
}

export async function activeUsers(env) {
  if (!env || env.HUB_OFF !== '1') return [MO];
  const { results } = await env.DB.prepare("SELECT u.id FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.status = 'active' AND u.id != 'mo' ORDER BY u.id").all();
  return results.map(r => r.id);
}

const COLS = 'id, name, role, profile, profile_json, prefs_json, status, created_at, updated_at';
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const objOf = text => { const v = safeParse(text, {}); return isObj(v) ? v : {}; };

const MO_FALLBACK = { id: MO, name: 'Mo', role: 'admin', profile: DEFAULT_PROFILE, profile_json: {}, prefs_json: {}, status: 'active', created_at: 0, updated_at: 0 };

// One users row with its _json columns parsed to objects, or null. One D1 query.
export async function userRow(env, id) {
  let row;
  try {
    row = await env.DB.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).bind(id).first();
  } catch (e) {
    if (id === MO && /no such table/i.test(String(e && e.message))) return { ...MO_FALLBACK };
    throw e;
  }
  if (!row) return null;
  return { ...row, profile_json: objOf(row.profile_json), prefs_json: objOf(row.prefs_json) };
}

// The short form GET /api/state sends as `me`.
export function meOf(row) {
  return row ? { id: row.id, name: row.name, role: row.role, profile: row.profile } : null;
}

// The user's exam profile: PROFILES[row.profile] deep-merged with row.profile_json. Pass the row when
// it has already been read, to save a query.
export async function profileFor(env, id, row) {
  const r = row || await userRow(env, id);
  return buildProfile(r ? r.profile : DEFAULT_PROFILE, r ? r.profile_json : {});
}

// Every registered pref's default, as a nested object ({map: {always_night: false}}).
export function prefDefaults(specs = prefSpecs()) {
  const out = {};
  for (const [path, spec] of Object.entries(specs)) {
    if (!spec || spec.default === undefined) continue;
    const parts = path.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = isObj(o[p]) ? o[p] : (o[p] = {});
    o[parts[parts.length - 1]] = spec.default;
  }
  return out;
}

// The user's ui_prefs: users.prefs_json over the registered defaults (prefs.js validates writes).
export async function getPrefs(env, id, row) {
  const r = row || await userRow(env, id);
  return deepMerge(prefDefaults(), r ? r.prefs_json : {});
}

const PATH_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;

// A prepared statement that sets (or, with value undefined, clears back to the default) one pref, for
// writeBatch to run beside its map_events row. The caller validates the value (prefs.js validatePref).
export function prefsStatement(env, id, path, value) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) throw new Error(`prefsStatement: invalid pref path ${JSON.stringify(path)}`);
  const base = `CASE WHEN json_valid(prefs_json) AND json_type(prefs_json) = 'object' THEN prefs_json ELSE '{}' END`;
  if (value === undefined) {
    return env.DB.prepare(`UPDATE users SET prefs_json = json_remove(${base}, ?), updated_at = ? WHERE id = ?`).bind('$.' + path, now(), id);
  }
  return env.DB.prepare(`UPDATE users SET prefs_json = json_set(${base}, ?, json(?)), updated_at = ? WHERE id = ?`)
    .bind('$.' + path, JSON.stringify(value), now(), id);
}
