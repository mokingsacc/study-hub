import { readOnly, additive } from './annotations.js';
import { bugList, bugGet, bugClose, shotOf } from '../debug/bugs.js';
import { legacy } from './reply.js';

const SHOT_INLINE_MAX = 1_500_000;
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

async function getRaw(env, user, args) {
  try {
    const r = await bugGet(env, user, args.id, { origin: env.HUB_ORIGIN || null });
    const content = [{ type: 'text', text: JSON.stringify(r) }];
    if (r.shot) {
      const s = await shotOf(env, user, r.id).catch(() => null);
      if (s && s.bytes.length <= SHOT_INLINE_MAX) content.push({ type: 'image', data: b64(s.bytes), mimeType: s.mime });
    }
    return { content, structuredContent: r, isError: false };
  } catch (e) {
    return legacy({ error: e && e.message ? e.message : 'The hub could not read that report.' }, null, true);
  }
}

export const CODE_TOOLS = [
  {
    name: 'bug_list', title: 'Problem reports', annotations: readOnly(), cap: 8000, trim: ['reports:5'],
    description: 'Mo\'s problem reports, newest first. state: open (default), fixed, dropped or all.',
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'fixed', 'dropped', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    run: (env, user, args) => bugList(env, user, args),
  },
  {
    name: 'bug_get', title: 'One problem report', annotations: readOnly(), raw: true,
    description: 'One report in full: note, page state, last calls with traces (route, SQL, error), versions, topic context; the screenshot as an image.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'], additionalProperties: false },
    run: (env, user, args) => getRaw(env, user, args),
  },
  {
    name: 'bug_close', title: 'Close a problem report', annotations: additive('Close a problem report', { idempotent: true }), cap: 1500,
    description: 'Mark a report fixed with the commit or PR link (fix). state dropped: closed without a change.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, fix: { type: 'string', maxLength: 300 }, state: { type: 'string', enum: ['fixed', 'dropped'] } },
      required: ['id'], additionalProperties: false },
    run: (env, user, args) => bugClose(env, user, args.id, { fix: args.fix, state: args.state }),
  },
];

// One small tool for every client (1 Nov 2026): the scheduled claude.ai routine reaches the connector through the app,
// whose User-Agent is not claude-code, so it never saw the three tools above. hub_bugs folds them into one entry that
// fits the 36,000-character list: action list, get (with the screenshot) or close.
export const ALL_CLIENT_TOOLS = [
  {
    name: 'hub_bugs', title: 'Problem reports', annotations: additive('Problem reports', { idempotent: true }), raw: true,
    description: 'Mo\'s problem reports (fix-bugs skill). list; get {id}: report and screenshot; close {id, fix}.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'close'] }, id: { type: 'string', maxLength: 64 },
      fix: { type: 'string', maxLength: 300 }, state: { type: 'string', enum: ['open', 'fixed', 'dropped', 'all'] } }, required: ['action'], additionalProperties: false },
    run: async (env, user, args) => {
      if (args.action === 'get') return getRaw(env, user, args);
      try {
        const r = args.action === 'close'
          ? await bugClose(env, user, args.id, { fix: args.fix, state: args.state === 'dropped' ? 'dropped' : undefined })
          : await bugList(env, user, { state: args.state });
        return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, isError: false };
      } catch (e) {
        return legacy({ error: e && e.message ? e.message : 'The hub could not do that.' }, null, true);
      }
    },
  },
];
