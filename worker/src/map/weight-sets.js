import * as W from './weights.js';
import {
  WEIGHTS, GATE_CREDIT, GATES, CAPS, ERROR_MULT, HALF_LIFE, BUCKETS, WEIGHT_SETS, SHIPPED_WEIGHTS_VERSION, _setWeightsVersion,
} from './weights.js';
import { REVIEW_W, FIT, CARD_DAY_W, TREND, MODEL, makeModel, modelFor } from './fsrs.js';
import { CAUSE_MULT } from '../../../public/js/shared/cause.js';

export const TABLES = { WEIGHTS, GATE_CREDIT, GATES, CAPS, ERROR_MULT, HALF_LIFE, REVIEW_W, FIT, CARD_DAY_W, TREND, CAUSE_MULT };
// Which half-life each stored bucket takes (weights.js BUCKETS, derived from HALF_LIFE at load).
export const BUCKET_HALF = { q_pass: 'q', q_fail: 'q', card_pass: 'card', card_fail: 'card', card_state: 'card_state', lesson_pass: 'lesson_pass',
  lesson_fail: 'lesson_fail', self_pass: 'self', self_fail: 'self', gap_fail: 'gap', gate_nq: 'gate' };
export const LIVE_KEY = 'scoring_set';
export const LIVE_TTL_MS = 60_000;
export const ID_RE = /^v(\d+)(-[a-z0-9-]{1,30})?$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : structuredClone(v));

// The constants as shipped, before any set touches them, and the shared model's own methods.
const BASE = clone(TABLES);
const BASE_FIT = JSON.stringify(BASE.FIT);
const MODEL_BASE = { ...MODEL };
const MODELS_BY_FIT = new Map([[BASE_FIT, MODEL_BASE]]);

// Keys sorted at every level, so the same changes always hash the same.
const stable = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ the sets

/** The shipped set: the WEIGHT_SETS entry whose version is WEIGHTS_VERSION as shipped (a plain one when it is missing). */
export function champion(sets = WEIGHT_SETS, shipped = SHIPPED_WEIGHTS_VERSION) {
  return sets.find(s => s && s.version === shipped) || { id: `v${shipped}`, version: shipped, changes: {}, note: 'the constants as shipped' };
}
/** The set above the shipped one (the newest, should there be more than one), or null. */
export function challenger(sets = WEIGHT_SETS, shipped = SHIPPED_WEIGHTS_VERSION) {
  const up = sets.filter(s => s && s.version > shipped).sort((a, b) => a.version - b.version);
  return up.length ? up[up.length - 1] : null;
}
export const isChallenger = (set, shipped = SHIPPED_WEIGHTS_VERSION) => !!set && set.version > shipped;
export const setById = (id, sets = WEIGHT_SETS) => sets.find(s => s && s.id === id) || null;
export const setByVersion = (v, sets = WEIGHT_SETS) => sets.find(s => s && s.version === Number(v)) || null;
/** The id of one shadow test: the challenger, a hash of its changes, the champion it is tested against. */
export const testIdOf = (ch, champ = champion()) => `${ch.id}:${fnv(stable(ch.changes || {}))}@${champ.id}`;
export const currentTestId = () => { const ch = challenger(); return ch ? testIdOf(ch) : null; };
/** 'rules v9', from a stored formula_version (null: none recorded). */
export const rulesWords = version => (version == null || !Number.isFinite(Number(version)) ? null : `rules v${Number(version)}`);

// A value a set may hold: a number, null, or a list or object of those; a short word only where the shipped value is a
// word (FIT.same_day).
const okValue = v => v === null || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every(okValue)) || (isObj(v) && Object.values(v).every(okValue));
const okWord = v => typeof v === 'string' && v.length > 0 && v.length <= 20;

// Each changed key must already be in the shipped table (a new rule's key goes into the constants first with a value that
// changes nothing, then the challenger moves it), so a misspelt key never passes as a change that does nothing.
function changeProblems(id, base, changes, path) {
  const out = [];
  for (const [k, v] of Object.entries(changes)) {
    const where = `${path}.${k}`;
    if (!isObj(base) || !(k in base)) { out.push(`set ${id}: ${where} is not in the shipped table (add it there first with a value that changes nothing)`); continue; }
    if (typeof base[k] === 'string' ? !okWord(v) : !okValue(v)) out.push(`set ${id}: ${where} must be ${typeof base[k] === 'string' ? 'a short word' : 'numbers (or lists and objects of numbers)'}`);
    else if (isObj(v) && isObj(base[k])) out.push(...changeProblems(id, base[k], v, where));
    else if (isObj(v) !== isObj(base[k])) out.push(`set ${id}: ${where} has a different shape from the shipped value`);
  }
  return out;
}

/** What is wrong with a list of sets, as sentences ([] when all is well). shipped: WEIGHTS_VERSION as shipped. */
export function problems(sets = WEIGHT_SETS, shipped = SHIPPED_WEIGHTS_VERSION, base = BASE) {
  const out = [];
  if (!Array.isArray(sets) || !sets.length) return ['WEIGHT_SETS must list at least the champion'];
  const ids = new Set(), versions = new Set();
  for (const s of sets) {
    if (!isObj(s)) { out.push('every set must be an object'); continue; }
    const m = ID_RE.exec(String(s.id || ''));
    if (!m) out.push(`set ${s.id}: ids look like v9 or v9-heard`);
    else if (Number(m[1]) !== s.version) out.push(`set ${s.id}: its id must start with its version (v${s.version})`);
    if (!Number.isInteger(s.version) || s.version < 1) out.push(`set ${s.id}: version must be a whole number`);
    if (ids.has(s.id)) out.push(`set ${s.id}: listed twice`);
    if (versions.has(s.version)) out.push(`version ${s.version} is used by two sets`);
    ids.add(s.id); versions.add(s.version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || ''))) out.push(`set ${s.id}: date looks like 2026-11-01`);
    if (typeof s.note !== 'string' || !s.note.trim()) out.push(`set ${s.id}: note says what it changes, in a line`);
    if (!isObj(s.changes)) { out.push(`set ${s.id}: changes must be an object ({} for none)`); continue; }
    if (s.version > shipped) {
      if (!Object.keys(s.changes).length) out.push(`set ${s.id}: a challenger must change something`);
      for (const [t, ch] of Object.entries(s.changes)) {
        if (!(t in base)) out.push(`set ${s.id}: ${t} is not a table a set may change (${Object.keys(base).join(', ')})`);
        else if (!isObj(ch)) out.push(`set ${s.id}: ${t} changes must be an object`);
        else out.push(...changeProblems(s.id, base[t], ch, t));
      }
    }
  }
  if (!sets.some(s => s && s.version === shipped)) out.push(`WEIGHTS_VERSION is ${shipped} but WEIGHT_SETS has no set with that version: add one (CONTRACT.md "Shadow mode")`);
  if (sets.filter(s => s && s.version > shipped).length > 1) out.push('only one challenger at a time: one set above WEIGHTS_VERSION');
  return out;
}

// ------------------------------------------------------------------ applying a set

// t merged with changes (a new object; t is never touched).
function merged(t, changes) {
  const out = clone(t);
  for (const [k, v] of Object.entries(changes || {})) out[k] = isObj(v) && isObj(out[k]) ? merged(out[k], v) : clone(v);
  return out;
}
// Fills a live table in place with values (keys not in values go), so every module holding the table sees them.
function fill(target, values) {
  for (const k of Object.keys(target)) if (!(k in values)) delete target[k];
  for (const [k, v] of Object.entries(values)) target[k] = clone(v);
}

/** A set's values: every table, the challenger's changes over the shipped constants, and its version (pure). */
export function valuesOf(set, shipped = SHIPPED_WEIGHTS_VERSION) {
  const changes = isChallenger(set, shipped) ? set.changes || {} : {};
  const tables = {};
  for (const [name, t] of Object.entries(BASE)) tables[name] = changes[name] ? merged(t, changes[name]) : clone(t);
  return { tables, version: set ? set.version : shipped };
}

const modelProps = () => ({ ...MODEL });
function modelForFit(fitJson) {
  if (!MODELS_BY_FIT.has(fitJson)) MODELS_BY_FIT.set(fitJson, { ...makeModel() });   // FIT already holds these values
  return MODELS_BY_FIT.get(fitJson);
}

// Puts values in the live tables: BUCKETS follows HALF_LIFE, the version follows the set, and MODEL takes the methods
// of a model made under the set's FIT (its own methods when FIT is as shipped).
function put({ tables, version, model = null }) {
  for (const [name, values] of Object.entries(tables)) fill(TABLES[name], values);
  for (const [b, h] of Object.entries(BUCKET_HALF)) if (b in BUCKETS) BUCKETS[b] = HALF_LIFE[h] === undefined ? null : HALF_LIFE[h];
  _setWeightsVersion(version);
  Object.assign(MODEL, model || modelForFit(JSON.stringify(FIT)));
}
// WEIGHTS_VERSION is a live binding (weights.js): W.WEIGHTS_VERSION is the value now.
const snapshot = () => ({ tables: clone(TABLES), version: W.WEIGHTS_VERSION, model: modelProps() });

export function modelUnder(base) {
  if (!base || !base.cfg || !Array.isArray(base.cfg.w)) return MODEL;
  return modelFor(base.cfg.w);
}

/**
 * Runs fn with the set's values in the live tables and puts every table back as it was afterwards, whatever fn does.
 * fn({set, model}) must be synchronous: model(base) is modelUnder.
 */
export function withWeightSet(set, fn) {
  const saved = snapshot();
  put(valuesOf(set));
  try {
    const out = fn({ set, model: modelUnder });
    if (out && typeof out.then === 'function') throw new Error('withWeightSet: fn must not be async (other requests would see the set)');
    return out;
  } finally {
    put(saved);
  }
}

// ------------------------------------------------------------------ the live set

let live = null;       // the set applied for every reader in this isolate (null: the shipped constants, never touched)
let liveAt = 0;

/** The set a stored scoring_set value makes live: the current challenger when it names it and its test, else the champion. */
export function resolveLive(stored, sets = WEIGHT_SETS, shipped = SHIPPED_WEIGHTS_VERSION) {
  const champ = champion(sets, shipped), ch = challenger(sets, shipped);
  if (ch && stored && stored.id === ch.id && (!stored.test_id || stored.test_id === testIdOf(ch, champ))) return ch;
  return champ;
}

/** Makes a set live for every reader in this isolate (the shipped constants for the champion). */
export function applyLive(set) {
  put(valuesOf(set));
  live = set;
  return set;
}

/** The set live now in this isolate. */
export const liveSet = () => live || champion();

/**
 * The request's and the cron's first step: the live set from the hub setting scoring_set, read at most once a minute
 * per isolate (force: now). No challenger in WEIGHT_SETS: nothing is read and the champion is live. Never throws: a
 * failed read keeps the set already live.
 */
export async function ensureLiveSet(env, { now = Date.now(), force = false } = {}) {
  if (!challenger()) {
    if (live && live.version !== SHIPPED_WEIGHTS_VERSION) applyLive(champion());
    return liveSet();
  }
  if (!force && live && now - liveAt < LIVE_TTL_MS) return live;
  let stored = null;
  try {
    const r = env && env.DB ? await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(LIVE_KEY).first() : null;
    stored = r && r.value ? JSON.parse(r.value) : null;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) console.error('scoring set not read', e && e.message);
    return liveSet();
  }
  const set = resolveLive(stored);
  if (!live || live.id !== set.id) applyLive(set);
  liveAt = now;
  return set;
}

/** For the tests: the shipped constants live again, and the next ensureLiveSet reads afresh. */
export function _resetLive() {
  put({ ...valuesOf(champion()), model: MODEL_BASE });
  live = null;
  liveAt = 0;
}

export { WEIGHT_SETS, SHIPPED_WEIGHTS_VERSION };
