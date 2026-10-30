import { changeKinds as mergedKinds } from './registry/index.js';

export const TIERS = ['free', 'confirm', 'refused'];
export const OP_RE = /^[a-z_]+(\.[a-z_]+)+$/;

// Problems with one map of entries, as sentences ([] when all is well). The tests require none.
export function problems(kinds) {
  const out = [];
  for (const [op, e] of Object.entries(kinds)) {
    if (!OP_RE.test(op) && op !== 'undo') out.push(`change ${op}: ops look like "area.verb"`);
    if (!e || typeof e !== 'object') { out.push(`change ${op}: entry must be an object`); continue; }
    if (!(TIERS.includes(e.tier) || typeof e.tier === 'function')) out.push(`change ${op}: tier must be free, confirm, refused or a function`);
    if (e.tier !== 'refused' && typeof e.plan !== 'function') out.push(`change ${op}: plan(env, user, args, ctx) is missing`);
    if (e.apply != null && typeof e.apply !== 'function') out.push(`change ${op}: apply must be a function`);
    if (typeof e.kind !== 'string' || !/^[a-z_]+(\.[a-z_]+)?$/.test(e.kind)) out.push(`change ${op}: kind must be an event kind such as "topic.added"`);
    if (e.undoable != null && typeof e.undoable !== 'boolean') out.push(`change ${op}: undoable must be true or false`);
    for (const k of ['allowKeys', 'codeMarks']) if (e[k] != null && !(Array.isArray(e[k]) && e[k].every(x => typeof x === 'string'))) out.push(`change ${op}: ${k} must be a list of names`);
    if (e.codeMarks && !e.codeMarks.every(c => /^[a-z_]+\.[a-z_]+$/.test(c))) out.push(`change ${op}: codeMarks are "table.column"`);
  }
  return out;
}

// Every registered change, from the area registries.
export function changeKinds() {
  return mergedKinds();
}

// One entry by op, or null.
export function lookup(op, kinds = changeKinds()) {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(kinds, op) ? kinds[op] : null;
}

// The entry's tier for this call: a fixed tier, or its function's answer (a bad answer counts as confirm).
export function tierOf(entry, args, plan, ctx) {
  const t = typeof entry.tier === 'function' ? entry.tier(args, plan, ctx) : entry.tier;
  return TIERS.includes(t) ? t : 'confirm';
}
