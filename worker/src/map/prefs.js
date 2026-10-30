// ui_prefs: how each page looks, per user, in users.prefs_json (plan §9 Prefs, §14). Each page's owner
// registers its keys as PREFS in its registry file; this file validates values against them and plans
// op 'pref.set' for applyChange. Reading (defaults merged with the stored values) is users.js getPrefs.
// A spec is {path, type?: bool|int|num|enum|list, min?, max?, enum?, max_items?, default, label?, owner?};
// a missing type is read from the default (and enum).
import { prefSpecs } from './registry/index.js';
import { Refusal } from './guard.js';
import { safeParse } from '../util.js';

export const TYPES = ['bool', 'int', 'num', 'enum', 'list'];
export const MAX_PER_CALL = 10;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function typeOf(spec) {
  if (TYPES.includes(spec.type)) return spec.type;
  const d = spec.default;
  if (Array.isArray(d)) return 'list';
  if (typeof d === 'boolean') return 'bool';
  if (Array.isArray(spec.enum)) return 'enum';
  if (Number.isInteger(d)) return 'int';
  if (typeof d === 'number') return 'num';
  return null;
}

// Problems with the registered specs, as sentences ([] when all is well).
export function specProblems(specs = prefSpecs()) {
  const out = [];
  for (const [path, s] of Object.entries(specs)) {
    const t = typeOf(s);
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(path)) out.push(`pref ${path}: paths look like "page.name"`);
    if (!t) { out.push(`pref ${path}: no type, and none can be read from its default`); continue; }
    if ((t === 'enum' || t === 'list') && !(Array.isArray(s.enum) && s.enum.length)) { out.push(`pref ${path}: ${t} needs an enum list`); continue; }
    if (s.default !== undefined) {
      try { validatePref(path, s.default, specs); } catch (e) { out.push(`pref ${path}: its default is not valid (${e.message})`); }
    }
  }
  return out;
}

const label = (path, spec) => spec.label || path;

/**
 * The value to store for one pref, or undefined to clear it back to the default (value null).
 * Throws Refusal with a plain sentence naming the allowed values.
 */
export function validatePref(path, value, specs = prefSpecs()) {
  const spec = specs[path];
  if (!spec) throw new Refusal(`There is no page setting called ${path}. Ask for hub_settings get to see them.`, path);
  if (value === null) return undefined;
  const name = label(path, spec);
  switch (typeOf(spec)) {
    case 'bool':
      if (typeof value !== 'boolean') throw new Refusal(`${name} is on or off (true or false).`, path);
      return value;
    case 'int':
    case 'num': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      const whole = typeOf(spec) === 'int';
      const range = `${spec.min ?? '…'} to ${spec.max ?? '…'}`;
      if (typeof n !== 'number' || !Number.isFinite(n) || (whole && !Number.isInteger(n))) throw new Refusal(`${name} must be a ${whole ? 'whole ' : ''}number from ${range}.`, path);
      if ((spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) throw new Refusal(`${name} must be from ${range}.`, path);
      return n;
    }
    case 'enum':
      if (!spec.enum.includes(value)) throw new Refusal(`${name} must be one of: ${spec.enum.join(', ')}.`, path);
      return value;
    case 'list': {
      if (!Array.isArray(value) || !value.every(v => spec.enum.includes(v))) throw new Refusal(`${name} is a list from: ${spec.enum.join(', ')}.`, path);
      if (new Set(value).size !== value.length) throw new Refusal(`${name} lists each item once.`, path);
      if (spec.max_items != null && value.length > spec.max_items) throw new Refusal(`${name} holds at most ${spec.max_items}.`, path);
      return [...value];
    }
    default:
      throw new Refusal(`${name} cannot be set.`, path);
  }
}

// The schema for hub_settings get: one short line per pref.
export function prefsSchema(specs = prefSpecs()) {
  return Object.entries(specs).map(([path, s]) => {
    const t = typeOf(s);
    const o = { path, type: t, default: s.default ?? null };
    if (s.label) o.label = s.label;
    if (t === 'enum' || t === 'list') o.values = s.enum;
    if (s.min != null) o.min = s.min;
    if (s.max != null) o.max = s.max;
    return o;
  });
}

// Set (or with undefined, remove) one dotted path in a nested object, in place.
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = isObj(o[p]) ? o[p] : (o[p] = {});
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last]; else o[last] = value;
  return obj;
}
export function getPath(obj, path) {
  let o = obj;
  for (const p of path.split('.')) { if (!isObj(o) || !(p in o)) return undefined; o = o[p]; }
  return o;
}

const shown = v => (v === undefined ? 'default' : typeof v === 'boolean' ? (v ? 'on' : 'off') : Array.isArray(v) ? v.join(', ') || 'none' : String(v));

/**
 * The planner for op 'pref.set': args {path, value} or {values: {path: value}} (up to 10).
 * One row on users.prefs_json (before and after as whole JSON text, so undo is a plain row restore) and
 * one pref.changed event per path, its summary built from the label and values.
 */
export async function planPref(env, user, args) {
  const values = args.values != null ? args.values : (args.path != null ? { [args.path]: args.value } : null);
  for (const k of Object.keys(args)) if (!['path', 'value', 'values'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  if (!isObj(values) || !Object.keys(values).length) return { refuse: 'Say which page setting to change: path and value.' };
  if (Object.keys(values).length > MAX_PER_CALL) return { refuse: `At most ${MAX_PER_CALL} page settings in one call.` };
  const specs = prefSpecs();
  const clean = Object.entries(values).map(([path, v]) => [path, validatePref(path, v, specs)]);

  let row;
  try {
    row = await env.DB.prepare('SELECT prefs_json FROM users WHERE id = ?').bind(user).first();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return { refuse: 'Page settings arrive with the map update (migration 0010).' };
    throw e;
  }
  if (!row) return { refuse: 'There is no such user.' };
  const before = safeParse(row.prefs_json, {});
  const prefs = structuredClone(isObj(before) ? before : {});
  const lines = [], paths = [];
  for (const [path, v] of clean) {
    const old = getPath(prefs, path);
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    setPath(prefs, path, v);
    paths.push(path);
    lines.push(`${label(path, specs[path])}: ${shown(old)} → ${shown(v)}`);
  }
  if (!paths.length) return { noop: true, summary: 'Those page settings are already set.' };
  // One row, one event (same order), so writeBatch copies the row's before and after onto the event.
  const summary = lines.join('; ');
  return {
    rows: [{ table: 'users', op: 'update', key: { id: user }, before: { prefs_json: row.prefs_json }, after: { prefs_json: JSON.stringify(prefs) } }],
    events: [{ kind: 'pref.changed', target_type: 'user', target_id: user, summary: summary.length > 160 ? `${paths.length} page settings changed` : summary }],
    count: paths.length, reply: { changed: paths },
  };
}
