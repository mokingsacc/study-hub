// The board_* tools (plan §13, v1b): the Review page for Claude, as thin wrappers over review's board.js
// (errorLog, tally, checklist), so Claude's numbers are the page's numbers. board_tick changes the checklist
// or marks misses reviewed through applyChange (review's ops checklist.tick and miss.review). None of them
// returns right reasoning or other options: those are fetched live on the page only, and the reply layer
// strips the keys anyway.
import * as board from '../map/board.js';
import { TALLY_ORDERS, YIELD_ORDERS, CHECK_FILTERS, ERROR_KEYS } from '../../../public/js/board/shape.js';
import { readOnly, additive } from './annotations.js';
import { claudeChange, MO_SAID, CONFIRM } from './map.js';

const LANES = ['A', 'B', 'C', 'off'];
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const OFFSET = { type: 'integer', minimum: 0, maximum: 5000 };
export const TICK_STEPS = ['Recognise', 'Distinguish', 'Test', 'Treat', 'Trap', 'done', 'studied'];

// review's board.js, by its literal path (wrangler bundles only literal imports); tests swap it with _setIo.
const NOT_YET = 'That part of the Review page is not on the hub yet. Use map_weakest and map_queue instead.';
const noModule = e => /Cannot find|No such module|Failed to (load|resolve)|is not a function/i.test(String(e && e.message));
const io = {
  board: async (fn, ...a) => {
    if (typeof board[fn] !== 'function') throw new Error(`${fn} is not a function in board.js`);
    return board[fn](...a);
  },
};
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

async function read(fn, env, user, args, ctx) {
  try {
    return await io.board(fn, env, user, args, { ...ctx, audience: 'claude' });
  } catch (e) {
    if (noModule(e)) return { refused: true, reason: NOT_YET };
    throw e;
  }
}

/** board_tick's change: a checklist step (or done, or studied) for a unit, or misses marked reviewed. */
export function tickChange(args) {
  const value = args.value !== false;
  if (args.miss != null) {
    const ids = Array.isArray(args.miss) ? args.miss : [args.miss];
    if (!ids.length || ids.length > 25) return { problems: ['miss is one miss id or a list of up to 25.'] };
    if (args.unit != null || args.step != null) return { problems: ['Tick a unit or mark misses reviewed, not both in one call.'] };
    return { op: 'miss.review', args: { ids, reviewed: args.reviewed != null ? !!args.reviewed : value } };
  }
  if (args.unit == null || args.step == null) return { problems: ['Say which unit and step (Recognise, Distinguish, Test, Treat, Trap, done or studied), or which misses.'] };
  const step = args.step === 'done' ? 'all' : args.step.toLowerCase();
  return { op: 'checklist.tick', args: { unit_id: String(args.unit), step, value } };
}

export const BOARD_TOOLS = [
  {
    name: 'board_error_log', title: 'Error log', annotations: readOnly('Error log'), cap: 20000, trim: ['rows:10'],
    moreCall: args => `board_error_log with offset ${(args.offset || 0) + (args.limit || 15)}`,
    description: 'The Review page\'s error log: misses by system, newest first: label, topic, error type, confidence, slow, card, re-test, band, week. detail: his thinking, look-alikes, learning point.',
    inputSchema: { type: 'object', properties: {
      since_day: DAY, category: { type: 'string', maxLength: 40 }, topic: { type: 'string', maxLength: 120 }, error_type: { type: 'string', enum: ERROR_KEYS },
      confidence: { type: 'string', enum: ['sure', 'lean', 'guess', 'unknown'] }, result: { type: 'string', enum: ['wrong', 'flawed'] }, slow_only: { type: 'boolean' },
      sure_wrong_only: { type: 'boolean' }, retest_due: { type: 'boolean' }, reviewed: { type: 'boolean' }, query: { type: 'string', maxLength: 80 },
      detail: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 40 }, offset: OFFSET }, additionalProperties: false },
    run: (env, user, args, ctx) => read('errorLog', env, user, args, ctx),
  },
  {
    name: 'board_tallies', title: 'Topic tally', annotations: readOnly('Topic tally'), cap: 15000, trim: ['units:10', 'rows:10'],
    moreCall: args => `board_tallies with offset ${(args.offset || 0) + (args.limit || 30)}`,
    description: 'Review page. topics: missed units, lane, rank, band. high_yield: unstudied since missed. calibration: right % by confidence, system, week.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['topics', 'high_yield', 'calibration'] }, group: { type: 'string', enum: ['checklist', 'category'] },
      sort: { type: 'string', enum: [...TALLY_ORDERS, ...YIELD_ORDERS] }, since_day: DAY,
      category: { type: 'string', maxLength: 40 }, lane: { type: 'string', enum: LANES }, include_studied: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 60 }, offset: OFFSET }, additionalProperties: false },
    run: (env, user, args, ctx) => read('tally', env, user, args, ctx),
  },
  {
    name: 'board_checklist', title: 'Master checklist', annotations: readOnly('Master checklist'), cap: 15000, trim: ['units:10'],
    moreCall: args => `board_checklist with offset ${(args.offset || 0) + (args.limit || 40)}`,
    description: 'His Master Checklist: done by lane, each unit\'s five steps, Mehlman rank, misses, band.',
    inputSchema: { type: 'object', properties: {
      lane: { type: 'string', enum: LANES }, category: { type: 'string', maxLength: 40 }, system: { type: 'string', maxLength: 60 },
      filter: { type: 'string', enum: CHECK_FILTERS }, unit: { type: 'string', maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 60 }, offset: OFFSET }, additionalProperties: false },
    run: (env, user, args, ctx) => read('checklist', env, user, args, ctx),
  },
  {
    name: 'board_tick', title: 'Tick the checklist', annotations: additive('Tick the checklist'), cap: 800,
    description: 'When Mo asks: tick (value true) or untick a unit\'s step (done: all five; studied: the High yield tick), or mark misses reviewed (miss: an id or ≤25).',
    inputSchema: { type: 'object', properties: {
      unit: { type: 'string', maxLength: 40 }, step: { type: 'string', enum: TICK_STEPS },
      miss: { type: ['string', 'array'], maxLength: 60, maxItems: 25, items: { type: 'string', maxLength: 60 } }, reviewed: { type: 'boolean' },
      value: { type: 'boolean' }, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['value'], additionalProperties: false },
    run: async (env, user, args, ctx) => {
      const c = tickChange(args);
      if (c.problems) return c;
      return claudeChange(env, user, c.op, { ...c.args, surface: args.surface, mo_said: args.mo_said, confirm_token: args.confirm_token }, ctx);
    },
  },
];
