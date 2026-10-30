// The map's shared registries (plan §17.1). Each build area owns one file here and exports any of:
//   ROUTES          [[method, pattern, handler, opts?]]; handler(request, env, ctx, params, url, user), like router.js
//                   handlers plus the user worked out once by the router. Patterns use explicit paths
//                   ('/api/map/seed/vocab'), never a ':step' param that would shadow another route.
//   CHANGE_KINDS    {op: {tier, kind, undoable, plan}}   read by change-kinds.js (SUB)
//   UNDO            {key: fn}                            read by undo.js (RTC)
//   EXPORT          {table: {cols, required, types, check?}}   read by export.js; types as export.js TYPES
//   EXPORT_SKIP     {table: 'why it is not exported'}
//   PREFS           {path: spec} or [{path, ...spec}]    read by prefs.js (SUB) and users.js getPrefs
//   QUEUE_HANDLERS  {kind: handler}                      read by topics.js (TAX)
//   MINUTE          async (env, ctx, scheduledTime)      the minute dispatcher (one area only: ingest's sync.js)
// Everything is read at call time, never at module load, so import cycles between areas and their
// registries are harmless. Merging never throws: a duplicate keeps the first owner and is listed by
// problems(), which tests/worker/conventions.test.mjs requires to be empty.
import * as orbits from './orbits.js';
import * as family from './family.js';
import * as subscription from './subscription.js';
import * as realtime from './realtime.js';
import * as ingest from './ingest.js';
import * as weakness from './weakness.js';
import * as taxonomy from './taxonomy.js';
import * as teach from './teach.js';
import * as mcp from './mcp.js';
import * as panel from './panel.js';
import * as links from './links.js';
import * as look from './look.js';
import * as review from './review.js';
import * as onenote from './onenote.js';
import * as media from './media.js';
import * as morning from './morning.js';
import * as uworldTrack from './uworld-track.js';
import * as library from './library.js';
import * as ukLabs from './uk-labs.js';
import * as cards from './cards.js';
import * as learn from './learn.js';
import * as notes from './notes.js';
import * as uk from './uk.js';
import * as mnemonics from './mnemonics.js';
import * as history from './history.js';
import * as platform from './platform.js';

// Area name -> module, in merge order (the first owner of a key wins).
const AREAS = { family, subscription, realtime, ingest, weakness, taxonomy, teach, mcp, panel, links, look, review, onenote, media, morning, 'uworld-track': uworldTrack, library, cards, learn, notes, uk, mnemonics, history, platform };
export const KEYS = ['ROUTES', 'CHANGE_KINDS', 'UNDO', 'EXPORT', 'EXPORT_SKIP', 'PREFS', 'QUEUE_HANDLERS', 'MINUTE'];
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
AREAS['uk-labs'] = ukLabs;
// export.js column types: text, whole number, number, day, any JSON, JSON list, JSON object (or a list of values).
export const EXPORT_TYPES = ['t', 'i', 'r', 'd', 'j', 'ja', 'jo'];
AREAS.orbits = orbits;

export function areas() { return AREAS; }

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// {key: value} parts merged across areas; returns {merged, owner, problems}.
function mergeMaps(name, areaMods) {
  const merged = {}, owner = {}, problems = [];
  for (const [area, mod] of Object.entries(areaMods)) {
    const part = mod[name];
    if (part == null) continue;
    if (!isObj(part)) { problems.push(`${area}: ${name} must be an object`); continue; }
    for (const [k, v] of Object.entries(part)) {
      if (Object.prototype.hasOwnProperty.call(merged, k)) { problems.push(`${name} "${k}" is defined by both ${owner[k]} and ${area}`); continue; }
      merged[k] = v;
      owner[k] = area;
    }
  }
  return { merged, owner, problems };
}

// Each takes the area modules only so the tests can pass their own; callers use the default.
export const changeKinds = (mods = AREAS) => mergeMaps('CHANGE_KINDS', mods).merged;
export const undoHandlers = (mods = AREAS) => mergeMaps('UNDO', mods).merged;
export const exportTables = (mods = AREAS) => mergeMaps('EXPORT', mods).merged;
export const exportSkip = (mods = AREAS) => mergeMaps('EXPORT_SKIP', mods).merged;
export const queueHandlers = (mods = AREAS) => mergeMaps('QUEUE_HANDLERS', mods).merged;

// PREFS as {path: spec}, whichever of the two shapes an area used.
function prefsParts(areaMods) {
  const asMaps = {};
  const problems = [];
  for (const [area, mod] of Object.entries(areaMods)) {
    const p = mod.PREFS;
    if (p == null) continue;
    if (Array.isArray(p)) {
      const m = {};
      for (const spec of p) {
        if (!isObj(spec) || typeof spec.path !== 'string') { problems.push(`${area}: every PREFS entry needs a path`); continue; }
        if (m[spec.path]) { problems.push(`PREFS "${spec.path}" is defined twice by ${area}`); continue; }
        m[spec.path] = spec;
      }
      asMaps[area] = { PREFS: m };
    } else asMaps[area] = { PREFS: p };
  }
  const r = mergeMaps('PREFS', asMaps);
  for (const [path, spec] of Object.entries(r.merged)) r.merged[path] = { ...spec, path };
  return { ...r, problems: problems.concat(r.problems) };
}
export const prefSpecs = (mods = AREAS) => prefsParts(mods).merged;

// Registry routes as [{area, method, pattern, handler, opts}].
export function routes(mods = AREAS) {
  const out = [];
  for (const [area, mod] of Object.entries(mods)) {
    if (!Array.isArray(mod.ROUTES)) continue;
    for (const r of mod.ROUTES) {
      if (!Array.isArray(r)) continue;
      const [method, pattern, handler, opts] = r;
      out.push({ area, method, pattern, handler, opts: opts || {} });
    }
  }
  return out;
}

// The minute dispatchers, as [{area, run}] (ingest's sync.js dispatchMinute, once it is registered).
export function minuteJobs(mods = AREAS) {
  return Object.entries(mods).filter(([, m]) => typeof m.MINUTE === 'function').map(([area, m]) => ({ area, run: m.MINUTE }));
}

// Everything wrong with the merged registries, as plain sentences; [] when all is well.
export function problems(mods = AREAS) {
  const out = [];
  for (const [area, mod] of Object.entries(mods)) {
    for (const k of Object.keys(mod)) if (!KEYS.includes(k)) out.push(`${area}: unknown registry export ${k}`);
  }
  for (const name of ['CHANGE_KINDS', 'UNDO', 'EXPORT', 'EXPORT_SKIP', 'QUEUE_HANDLERS']) out.push(...mergeMaps(name, mods).problems);
  out.push(...prefsParts(mods).problems);

  const seen = new Map();
  for (const [area, mod] of Object.entries(mods)) {
    if (mod.ROUTES == null) continue;
    if (!Array.isArray(mod.ROUTES)) { out.push(`${area}: ROUTES must be a list`); continue; }
    for (const r of mod.ROUTES) {
      const [method, pattern, handler] = Array.isArray(r) ? r : [];
      if (!METHODS.includes(method) || typeof pattern !== 'string' || !pattern.startsWith('/api/') || typeof handler !== 'function') {
        out.push(`${area}: a route is not [method, '/api/...', handler]`);
        continue;
      }
      const key = `${method} ${pattern}`;
      if (seen.has(key)) out.push(`route ${key} is defined by both ${seen.get(key)} and ${area}`);
      else seen.set(key, area);
    }
  }

  const exported = exportTables(mods);
  for (const [t, spec] of Object.entries(exported)) {
    if (!isObj(spec) || !Array.isArray(spec.cols) || !spec.cols.length) { out.push(`EXPORT ${t} needs a cols list`); continue; }
    if (spec.required && !spec.required.every(c => spec.cols.includes(c))) out.push(`EXPORT ${t}: a required column is not in cols`);
    if (spec.types && !Object.keys(spec.types).every(c => spec.cols.includes(c))) out.push(`EXPORT ${t}: a typed column is not in cols`);
    for (const [c, ty] of Object.entries(spec.types || {})) {
      if (!(Array.isArray(ty) ? ty.length : EXPORT_TYPES.includes(ty))) out.push(`EXPORT ${t}.${c}: unknown type ${JSON.stringify(ty)}`);
    }
    if (spec.check != null && typeof spec.check !== 'function') out.push(`EXPORT ${t}: check must be a function`);
  }
  for (const t of Object.keys(exportSkip(mods))) if (t in exported) out.push(`${t} is both exported and in EXPORT_SKIP`);
  const minute = minuteJobs(mods);
  if (minute.length > 1) out.push(`MINUTE is exported by ${minute.map(m => m.area).join(' and ')}; only one dispatcher may run each minute`);
  return out;
}
