import { changesByBatch } from '../map/overview.js';
import { hubSettings } from '../settings.js';
import { readOnly, additive, destructive } from './annotations.js';
import { claudeChange, MO_SAID, CONFIRM } from './map.js';
import { changeReply } from './reply.js';
import { uworldReview } from '../uworld-review.js';
import { captureReply } from '../uworld-capture.js';
import { judgeMode } from '../uworld-review.js';
import { chatJudgeRead, chatJudgeSubmit, chatReviewSubmit } from '../uworld-chat-judge.js';

const ACTORS = ['claude', 'mo', 'code', 'anki', 'extractor', 'cron', 'any'];

async function hubUndo(env, user, args, ctx) {
  if (args.seq != null && args.last != null) return { problems: ['Give seq or last, not both.'] };
  const target = args.seq != null ? { seq: args.seq } : { last: args.last || 1 };
  return claudeChange(env, user, 'undo', { ...target, confirm_token: args.confirm_token, surface: args.surface, mo_said: args.mo_said }, ctx);
}

export const HUB_TOOLS = [
  {
    name: 'teach_debrief', title: 'UWorld review', annotations: additive('UWorld review', { idempotent: true }), cap: 30000, trim: ['packs:4', 'history:2'],
    description: 'UWorld review. No id (once a chat, beside get_page_text): the list, every pack. uworld_id: its pack, marked reviewed (not with peek). log: true logs it ("log this"; error_type, confidence word, said). "Send the block": judge: true, then steps; items: judged questions; review: a save per review message.',
    inputSchema: { type: 'object', properties: {
      uworld_id: { type: 'string', maxLength: 12 }, q: { type: 'integer', minimum: 1, maximum: 60 }, block: { type: 'string', maxLength: 40 },
      log: { type: 'boolean' }, error_type: { type: 'string' }, confidence: { type: ['integer', 'string'] },
      said: { type: 'string' }, peek: { type: 'boolean' }, send: { type: 'boolean' },
      judge: { type: 'boolean' }, script: { type: 'boolean' }, items: { type: 'array', maxItems: 60 }, review: { type: 'object' } }, additionalProperties: false },
    run: async (env, user, args, ctx) => {
      if (args.review != null) return chatReviewSubmit(env, args, ctx);
      if (args.judge === true || (args.send === true && (await judgeMode(env)) === 'chat')) return chatJudgeRead(env, args, ctx);
      if (args.items != null) return chatJudgeSubmit(env, args, ctx);
      return args.send ? captureReply(env) : uworldReview(env, args, ctx);
    },
  },
  {
    name: 'hub_changes', title: 'What changed', annotations: readOnly('What changed'), cap: 6000, trim: ['changes:5'],
    description: 'What changed, one row per change, newest first: who, what, seq, undoable or undone. since_seq: after a reply\'s as_of_seq.',
    inputSchema: { type: 'object', properties: {
      since_seq: { type: 'integer', minimum: 0 }, actor: { type: 'string', enum: ACTORS }, kinds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
      limit: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    run: (env, user, args) => changesByBatch(env, user, args),
  },
  {
    name: 'hub_undo', title: 'Undo a change', annotations: destructive('Undo a change'), cap: 1500,
    description: '"Undo that": reverse a whole change. last: your latest 1-5 (default 1); seq: the change holding it (hub_changes). Older ones ask Mo first. Undoing an undo redoes it.',
    inputSchema: { type: 'object', properties: {
      seq: { type: 'integer', minimum: 1 }, last: { type: 'integer', minimum: 1, maximum: 5 }, mo_said: MO_SAID, confirm_token: CONFIRM }, additionalProperties: false },
    run: (env, user, args, ctx) => hubUndo(env, user, args, ctx),
  },
  {
    name: 'hub_settings', title: 'Hub settings and looks', annotations: additive('Hub settings and looks'), cap: 4000, trim: ['ui.schema'],
    description: 'Hub settings and page looks. get first: every setting and ui.* look, with values. set: key and value, or values (≤10). Raising a spend cap, check mode or exam date asks Mo first.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set'] }, key: { type: 'string', maxLength: 80 }, value: {},
      values: { type: 'object', maxProperties: 10 }, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['action'], additionalProperties: false },
    run: async (env, user, args, ctx) => {
      const r = await hubSettings(env, user, args, { surface: args.surface || ctx.surface, via: 'mcp:hub_settings' });
      return args.action === 'set' ? changeReply(r) : r;
    },
  },
];
