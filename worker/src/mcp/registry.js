// The connector's tool registry (plan §10.2): every tool in one list, in the order tools/list shows them.
// An entry is {name, title, description, inputSchema, annotations, _meta?, legacy?, cap?, trim?, moreCall?,
// unknownOk?, unlisted?, run(env, user, args, ctx)}. unlisted: callable by name, left out of tools/list (a tool another
// one now does, kept for older chats and pastes). legacy tools (the 12 originals) build their own MCP result; every
// other run returns a payload that reply.js turns into the JSON envelope.
import { EXAM_TOOLS } from './exams.js';
import { MAP_TOOLS } from './map.js';
import { TEACH_TOOLS } from './teach.js';
import { HUB_TOOLS } from './hub.js';
import { BOARD_TOOLS } from './board.js';
import { HISTORY_TOOLS } from './history.js';
import { buildInstructions } from './instructions.js';
import { withKnowledge } from './knowledge.js';
import { withLibrary } from './library.js';
import { withExams } from './exam-bank.js';
import { CODE_TOOLS, ALL_CLIENT_TOOLS } from './bugs.js';
import { PHOTO_TOOLS } from './photos.js';

export const TOOLS = [...EXAM_TOOLS, ...TEACH_TOOLS, ...MAP_TOOLS, ...BOARD_TOOLS, ...HUB_TOOLS, ...HISTORY_TOOLS, ...PHOTO_TOOLS, ...ALL_CLIENT_TOOLS].map(withKnowledge).map(withExams).map(withLibrary);
export const LEGACY_NAMES = EXAM_TOOLS.map(t => t.name);
export const NEW_PREFIXES = ['map_', 'teach_', 'lesson_', 'board_', 'hub_', 'screen_', 'media_'];
export const LIST_MAX = 36_000, DESCRIPTION_MAX = 1_800;

// The fix loop's tools (mcp/bugs.js, 1 Nov 2026): listed only when Claude Code calls (env.MCP_CLIENT 'code'), so the
// Claude app's list and its cap stay as they are; callable by name from any client.
export { CODE_TOOLS };
const BY_NAME = new Map([...TOOLS, ...CODE_TOOLS].map(t => [t.name, t]));
export const toolByName = name => BY_NAME.get(name) || null;

/**
 * The schema a new tool advertises: types, enums, required keys, top-level lengths and descriptions. Nested
 * lengths, item counts and closed objects are still enforced by checkArgs (and the areas) with a plain
 * message, so 36 tools fit the 36,000-character list. The 12 original tools are listed exactly as they are.
 */
const NESTED_DROP = ['maxLength', 'minLength', 'maxItems', 'minItems', 'additionalProperties', 'maxProperties', 'pattern'];
export function advertise(schema, depth = 0) {
  if (Array.isArray(schema)) return schema.map(x => advertise(x, depth));
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if ((depth >= 1 && NESTED_DROP.includes(k)) || (k === 'additionalProperties' && v === false)) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, advertise(x, depth + 1)]));
    else if (k === 'items') out[k] = advertise(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

// What tools/list sends: the MCP fields only.
const LISTED = ['name', 'title', 'description', 'inputSchema', 'annotations', '_meta'];
const listed = list => list.map(t => Object.fromEntries(LISTED.filter(k => t[k] !== undefined).map(k => [k, k === 'inputSchema' && !t.legacy ? advertise(t[k]) : t[k]])));
const LIST = listed(TOOLS.filter(t => !t.unlisted));
const LIST_CODE = LIST.concat(listed(CODE_TOOLS));
export function listTools(env = null) {
  return env && env.MCP_CLIENT === 'code' ? LIST_CODE : LIST;
}

export const INSTRUCTIONS = buildInstructions(TOOLS.filter(t => !t.unlisted).map(t => t.name));
