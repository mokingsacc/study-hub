// checkArgs: the connector's own check of a tool call's arguments against the tool's inputSchema, before any
// area function runs (plan §10.2). It covers the JSON Schema the hub's tools use: type (or a list of types),
// enum, required, properties, additionalProperties false, maxProperties, items, minItems/maxItems, minLength/maxLength,
// minimum/maximum and pattern. Everything else (meaning, caps on stored text, the leak guard) is the area's
// and guard.js's job. Pure; returns a list of short sentences, [] when the arguments are fine.
const MAX_PROBLEMS = 8;
const TEXT_MAX = 1900;   // the problems' text stays under 2,000 characters

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);
const show = v => (typeof v === 'string' ? `"${v.length > 40 ? v.slice(0, 37) + '...' : v}"` : JSON.stringify(v));

function walk(schema, v, where, out, { unknownOk }) {
  if (out.length >= MAX_PROBLEMS || !isObj(schema)) return;
  const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types && !types.some(t => fits(v, t))) {
    out.push(`${where} must be ${types.map(t => (t === 'integer' ? 'a whole number' : t === 'array' ? 'a list' : t === 'object' ? 'an object' : t)).join(' or ')}.`);
    return;
  }
  if (schema.enum && !schema.enum.some(e => e === v)) {
    out.push(`${where} must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')} (got ${show(v)}).`);
    return;
  }
  if (typeof v === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) out.push(`${where} is empty.`);
    if (schema.maxLength != null && v.length > schema.maxLength) out.push(`${where} is ${v.length} characters; at most ${schema.maxLength}. Say it shorter in your own words.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${where} does not look right (got ${show(v)}).`);
  }
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) out.push(`${where} must be at least ${schema.minimum}.`);
    if (schema.maximum != null && v > schema.maximum) out.push(`${where} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) out.push(`${where} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}.`);
    if (schema.maxItems != null && v.length > schema.maxItems) out.push(`${where} holds at most ${schema.maxItems} items (got ${v.length}).`);
    if (schema.items) v.forEach((x, i) => walk(schema.items, x, `${where}[${i}]`, out, { unknownOk }));
  }
  if (isObj(v)) {
    const props = schema.properties || {};
    if (schema.maxProperties != null && Object.keys(v).length > schema.maxProperties) out.push(`${where} holds at most ${schema.maxProperties} keys.`);
    for (const k of schema.required || []) if (v[k] === undefined) out.push(`${where === 'arguments' ? '' : `${where}.`}${k} is needed.`);
    for (const [k, x] of Object.entries(v)) {
      // An optional field sent as null counts as left out (Claude often sends null for "none").
      if (x === undefined || (x === null && !(schema.required || []).includes(k) && !(props[k] && [].concat(props[k].type || []).includes('null')))) continue;
      if (props[k]) walk(props[k], x, where === 'arguments' ? k : `${where}.${k}`, out, { unknownOk });
      else if (schema.additionalProperties === false && !unknownOk) out.push(`${where === 'arguments' ? '' : `${where} has no field `}${where === 'arguments' ? `Unknown argument ${k}` : k}${['outcome', 'minutes', 'result', 'verdict', 'score'].includes(k) ? ': code works that out' : ''}.`);
    }
  }
}

/**
 * The problems with `args` for `schema`, as sentences ([] when fine). opts.unknownOk: unknown keys are let
 * through (for tools whose area function checks its own keys, such as lesson_save).
 */
export function checkArgs(schema, args, opts = {}) {
  if (!isObj(args)) return ['arguments must be an object.'];
  const out = [];
  walk(schema || { type: 'object' }, args, 'arguments', out, { unknownOk: !!opts.unknownOk });
  const list = out.slice(0, MAX_PROBLEMS);
  while (list.join(' ').length > TEXT_MAX && list.length > 1) list.pop();
  return list;
}
