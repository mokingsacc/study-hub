// The teaching tools (plan §2.3, §2.5, §10.3, and the teaching-loop redesign of 24 Oct): teach_next, lesson_save,
// teach_memory_list and teach_memory_save, thin wrappers over teach's own functions. teach_next and lesson_save
// check their own keys (outcome and minutes from Claude are refused there), so the connector lets unknown keys
// through to them and teach's message comes back; the enums here come from teach's constants, so they never
// drift. teach_memory_save also logs a misconception (from a lesson, "log this" or "gap:"), so no new tool is
// needed (tools/list stays under 36,000 characters). Schemas are kept bare (no descriptions) for the same reason.
import { teachNext, TEACH_MODES, SURFACES } from '../map/teach-brief.js';
import { lessonSave, CHECKS, FINAL_RESULTS, CARD_ACTIONS, EFFECTS, TOPIC_KINDS } from '../map/teach-save.js';
import { memoryList, memorySave, SCOPES, TACTICS, STATUSES, NOTE_MAX, TACTIC_VOCAB, MISC_STATUSES, CORRECTION_MAX } from '../map/teach-memory.js';
import { readOnly, additive, ALWAYS_LOAD } from './annotations.js';
import { MO_SAID, REASON, CONFIRM } from './map.js';

const s = (max, extra = {}) => ({ type: 'string', maxLength: max, ...extra });
// An enum alone (no "type": every value is a string): tools/list stays under 36,000 characters with room for the
// fields the skill sends (LRN4-6). checkArgs checks enum without a type.
const e = (list, extra = {}) => ({ enum: list, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const arr = (items, max) => ({ type: 'array', maxItems: max, items });
const int = (minimum, maximum) => ({ type: 'integer', minimum, ...(maximum != null ? { maximum } : {}) });

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const withoutMoSaid = args => { const { mo_said, ...rest } = isObj(args) ? args : {}; return [rest, mo_said || null]; };

export const TEACH_TOOLS = [
  {
    name: 'teach_next', title: 'Start a lesson', annotations: additive('Start a lesson'), _meta: ALWAYS_LOAD, cap: 14000, unknownOk: true,
    trim: ['queue:2', 'past_lessons:1', 'mehlman.passages:3', 'cards:2', 'misses:3', 'memory:4', 'ready_questions'],
    description: 'For "teach me" (Anki Voice too), "teach me X", "test me on this pair", a Teach me tap, or "audit me" (mode audit); a cluster lesson: mode cluster. Call first, once. Picks the topic; holds the lesson: viva, gaps, misses, UWorld objectives, misconceptions, look-alikes, cards, Mehlman, tactics, method. Then lesson_save. "Next": again with skip. peek writes nothing.',
    inputSchema: obj({
      topic: s(200), pair: s(120), from_miss: s(40), mode: e(TEACH_MODES), surface: e(SURFACES),
      skip: arr(s(120), 10), lesson_id: s(40), peek: { type: 'boolean' },
    }),
    run: (env, user, args, ctx) => teachNext(env, user, args, { ...ctx, actor: 'claude', via: 'mcp:teach_next' }),
  },
  {
    name: 'lesson_save', title: 'Save the lesson', annotations: additive('Save the lesson', { idempotent: true }), _meta: ALWAYS_LOAD, cap: 4000, unknownOk: true,
    description: 'phase before/after + viva: his words verbatim (skip_viva: "don\'t know it"); the hub marks it, or pending: call again with {lesson_id, phase}. status in_progress after each check. At the end, once: all of it. Never outcome or minutes.',
    inputSchema: obj({
      lesson_id: s(40), status: e(['done', 'abandoned', 'in_progress']),
      steps: arr(obj({ title: s(80), check: e(CHECKS), repair_angle: s(80) }, ['check']), 5),
      // A patch's or pair lesson's closing check (open, so an older skill's fuller final case still passes).
      final_case: { type: 'object', properties: { result: e(FINAL_RESULTS) }, required: ['result'] },
      tactics_used: arr(e(TACTIC_VOCAB), 4),
      items: arr(obj({ case_for: e(['a', 'b']), said: e(['a', 'b', 'unsure']) }, ['case_for', 'said']), 4),
      misconceptions: obj({ add: arr(obj({ belief: s(200), ref: s(60) }, ['belief']), 2), closed: arr(s(40), 4), worked: arr(s(40), 3) }),
      // Anki ids, whole numbers lesson_save checks itself (no minimum listed: tools/list stays under 36,000).
      card: obj({ note_id: { type: 'integer' }, card_id: { type: 'integer' }, action: e(CARD_ACTIONS) }, ['action']),
      summary: s(1200),
      memory: obj({
        used: arr(obj({ id: s(40), effect: e(EFFECTS) }, ['id', 'effect']), 6),
        new: arr(obj({ scope: e(SCOPES), scope_ref: s(80), tactic: e(TACTICS), note: s(NOTE_MAX), from_mo: { type: 'boolean' } }, ['scope', 'tactic', 'note']), 2),
      }),
      new_topic: obj({ name: s(80), kind: e(TOPIC_KINDS), category_id: s(60) }, ['name', 'kind', 'category_id']),
      media_shown: arr(s(60), 6), viva: s(8000), phase: e(['before', 'after']), skip_viva: { type: 'boolean' },
      corrections: { type: 'array', maxItems: 3 },
    }, ['lesson_id']),
    run: (env, user, args, ctx) => lessonSave(env, user, args, { ...ctx, actor: 'claude', via: 'mcp:lesson_save' }),
  },
  {
    name: 'teach_memory_list', title: 'How to teach Mo', annotations: readOnly('How to teach Mo'), cap: 6000, trim: ['notes:5'],
    description: 'What the hub has learned about teaching Mo, with how often each note helped.',
    inputSchema: obj({ scope: e([...SCOPES, 'all']), topic: s(120), include_retired: { type: 'boolean' }, limit: int(1, 30) }),
    run: (env, user, args) => memoryList(env, user, args),
  },
  {
    name: 'teach_memory_save', title: 'Save a teaching note', annotations: additive('Save a teaching note'), cap: 1000,
    description: 'A note on teaching Mo (quote him in reason to pin it), or misconception {topic, belief, ref}: a wrong belief seen in "log this" or "gap:".',
    inputSchema: obj({
      // note: up to CORRECTION_MAX for a correction ("Correction: ..."), NOTE_MAX for any other note (checkNote says which).
      id: s(40), scope: e(SCOPES), scope_ref: s(80), tactic: e(TACTICS), note: s(CORRECTION_MAX), status: e(STATUSES), reason: REASON,
      misconception: obj({ id: s(40), topic: s(120), belief: s(200), ref: s(60), status: e(MISC_STATUSES) }),
      mo_said: MO_SAID, confirm_token: CONFIRM,
    }),
    run: (env, user, args, ctx) => {
      const [rest, mo_said] = withoutMoSaid(args);
      return memorySave(env, user, rest, { ...ctx, actor: 'claude', mo_said, via: 'mcp:teach_memory_save' });
    },
  },
];
