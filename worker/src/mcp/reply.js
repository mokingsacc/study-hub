// Replies from the hub's connector tools (plan §10.2). The 12 original tools keep their prose text block;
// every new tool answers with one JSON envelope, the same in the text block and structuredContent:
//   {as_of_seq, as_of, ...the tool's fields, undo?{batch_id, say}, say?, next_step?, more?{left, call}}
// needs_confirm comes back as a normal reply; refused, problems and errors come back with isError.
// Every reply is held to its tool's cap (characters of JSON) by dropping whole list items in the tool's
// trim order, never cutting a field, and the question-bank keys can never ride along.
export const FORBIDDEN_KEYS = ['correct_reasoning', 'why_wrong_options', 'right_reasoning', 'other_options', 'stem'];
export const UNDO_SAY = "Say 'undo that' to reverse it.";
export const DEFAULT_CAP = 4000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const STAMP = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
/** "Sat 24 Oct 16:05", London time. */
export function londonStamp(ms = Date.now()) {
  const p = Object.fromEntries(STAMP.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** The original tools' reply: prose text, the payload as structuredContent. */
export function legacy(payload, text = null, isError = false) {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(payload) }], structuredContent: payload, isError };
}

/** A copy of v with the question-bank keys removed at every depth. */
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!FORBIDDEN_KEYS.includes(k) && x !== undefined) out[k] = scrub(x);
  return out;
}

/** Whether a payload is a failure the client should see as isError (needs_confirm is not). */
export function isErrorPayload(p) {
  if (!isObj(p) || p.needs_confirm) return false;
  if (p.refused === true || p.error != null) return true;
  return Array.isArray(p.problems) && p.problems.length > 0 && p.ok !== true && p.saved !== true && !(p.resolved > 0);
}

const size = v => JSON.stringify(v).length;
function at(obj, path) {
  let cur = obj;
  for (const k of path) { if (!isObj(cur) && !Array.isArray(cur)) return undefined; cur = cur[k]; }
  return cur;
}

/**
 * Holds payload to cap characters of JSON. trim: ['list', 'a.b:2', ...] in order, each a dot path to a list
 * and the fewest items to keep (default 0); items go from the end, a pass at a time, then a second pass to zero.
 * Returns {payload, trimmed: {path: n}}. The payload is copied, never changed in place.
 */
export function fitCap(payload, cap = DEFAULT_CAP, trim = []) {
  let p = JSON.parse(JSON.stringify(payload));
  const trimmed = {};
  if (size(p) <= cap) return { payload: p, trimmed };
  const specs = trim.map(s => { const [path, min] = String(s).split(':'); return { path: path.split('.'), key: path, min: Number(min) || 0 }; });
  for (const pass of [0, 1]) {
    for (const s of specs) {
      const list = at(p, s.path);
      if (!Array.isArray(list)) continue;
      const keep = pass === 0 ? s.min : 0;
      while (list.length > keep && size(p) > cap) { list.pop(); trimmed[s.key] = (trimmed[s.key] || 0) + 1; }
      if (size(p) <= cap) return { payload: p, trimmed };
    }
  }
  return { payload: p, trimmed };
}

/**
 * The JSON reply for a new tool: scrubbed, held to cap, `more` added when anything was dropped
 * (more.call from the tool's moreCall(args, payload) when it has one).
 */
export function jsonResult(payload, { cap = DEFAULT_CAP, trim = [], moreCall = null, args = {} } = {}) {
  const clean = scrub(isObj(payload) ? payload : { value: payload });
  const { payload: fitted, trimmed } = fitCap(clean, cap, trim);
  const left = Object.values(trimmed).reduce((a, b) => a + b, 0);
  if (left) {
    const prev = isObj(fitted.more) ? fitted.more : {};
    fitted.more = { ...prev, left: (prev.left || 0) + left, trimmed: Object.keys(trimmed), ...(moreCall ? { call: moreCall(args, fitted) } : prev.call ? { call: prev.call } : {}) };
  }
  return { content: [{ type: 'text', text: JSON.stringify(fitted) }], structuredContent: fitted, isError: isErrorPayload(fitted) };
}

/**
 * applyChange's answer as a tool payload: ok results gain undo {batch_id, say}; needs_confirm and refused pass
 * through as they are.
 */
export function changeReply(r, extra = {}) {
  if (!isObj(r)) return { error: 'The hub gave no answer.' };
  if (r.needs_confirm || r.refused) return { ...r, ...extra };
  const out = { ...r, ...extra };
  delete out.undo_hint;
  if (r.ok && r.batch_id && !r.nothing && !out.undo) out.undo = { batch_id: r.batch_id, say: UNDO_SAY };
  if (out.seq != null && out.as_of_seq == null) out.as_of_seq = out.seq;
  return out;
}
