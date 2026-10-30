// The teaching tools (plan §2.3, §2.5, §10.3, and the teaching-loop redesign of 24 Oct): teach_next, lesson_save,
// teach_memory_list and teach_memory_save, thin wrappers over teach's own functions. teach_next and lesson_save
// check their own keys (outcome and minutes from Claude are refused there), so the connector lets unknown keys
// through to them and teach's message comes back; the enums here come from teach's constants, so they never
// drift. teach_memory_save also logs a misconception (from a lesson, "log this" or "gap:"), so no new tool is
// needed (tools/list stays under 36,000 characters). Schemas are kept bare (no descriptions) for the same reason.
import { teachNext, MODES, SURFACES } from '../map/teach-brief.js';
import { lessonSave, FIVE_STEPS, PROBE_RESULTS, PROBE_FROM, CHECKS, FINAL_RESULTS, CONFIDENCES, CARD_ACTIONS, EFFECTS, LINK_TYPES, TOPIC_KINDS, CLAUDE_VIEWS } from '../map/teach-save.js';
import { memoryList, memorySave, SCOPES, TACTICS, STATUSES, NOTE_MAX, TACTIC_VOCAB, CONTENT_TYPES, MISC_STATUSES } from '../map/teach-memory.js';
import { readOnly, additive, ALWAYS_LOAD } from './annotations.js';
import { MO_SAID, REASON, CONFIRM } from './map.js';

const s = (max, extra = {}) => ({ type: 'string', maxLength: max, ...extra });
// An enum alone (no "type": every value is a string): tools/list stays under 36,000 characters with room for the
// fields the skill sends (LRN4-6). checkArgs checks enum without a type.
const e = (list, extra = {}) => ({ enum: list, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const arr = (items, max) => ({ type: 'array', maxItems: max, items });
const int = (minimum, maximum) => ({ type: 'integer', minimum, ...(maximum != null ? { maximum } : {}) });
const JUDGED = ['complete', 'partial', 'wrong'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const withoutMoSaid = args => { const { mo_said, ...rest } = isObj(args) ? args : {}; return [rest, mo_said || null]; };

export const TEACH_TOOLS = [
  {
    name: 'teach_next', title: 'Start a lesson', annotations: additive('Start a lesson'), _meta: ALWAYS_LOAD, cap: 14000, unknownOk: true,
    trim: ['queue:2', 'past_lessons:1', 'mehlman.passages:3', 'cards:2', 'misses:3', 'memory:4', 'ready_questions'],
    description: 'For "teach me" anywhere (Anki Voice too), "teach me X", "test me on this pair" or a Teach me tap: call first, once. Picks the topic; holds the lesson: gaps, misses, UWorld objectives, misconceptions, look-alikes, cards, Mehlman, tactics, method. Then lesson_save. "Next": again with skip. peek writes nothing.',
    inputSchema: obj({
      topic: s(120), pair: s(120), from_miss: s(40), mode: e(MODES), surface: e(SURFACES),
      skip: arr(s(120), 10), lesson_id: s(40), peek: { type: 'boolean' },
    }),
    run: (env, user, args, ctx) => teachNext(env, user, args, { ...ctx, actor: 'claude', via: 'mcp:teach_next' }),
  },
  {
    name: 'lesson_save', title: 'Save the lesson', annotations: additive('Save the lesson', { idempotent: true }), _meta: ALWAYS_LOAD, cap: 3000, unknownOk: true,
    description: 'status in_progress after the probe and each check (parts so far). At the end or on "done", once: all of it, final case and his why, teach-back, 1-10 and why, clicked, your view. Never outcome or minutes.',
    inputSchema: obj({
      lesson_id: s(40), status: e(['done', 'abandoned', 'in_progress']), goal: s(200),
      five_step: arr(e(FIVE_STEPS), 2),
      probe: arr(obj({ summary: s(120), result: e(PROBE_RESULTS), from: e(PROBE_FROM), ref: s(60) }, ['result']), 4),
      steps: arr(obj({ title: s(80), check: e(CHECKS), repair_angle: s(80) }, ['check']), 5),
      final_case: obj({ result: e(FINAL_RESULTS), confidence: e(CONFIDENCES),
        explanation_judgement: obj({ verdict: e(JUDGED), missing: arr(s(80), 4) }, ['verdict']) }, ['result']),
      teach_back: obj({ judgement: e(JUDGED), missing: arr(s(80), 4) }, ['judgement']),
      mo_rating: int(1, 10), mo_rating_why: s(200), what_clicked: s(200),
      claude_view: obj({ verdict: e(CLAUDE_VIEWS), reasons: s(300) }, ['verdict']),
      questions_asked: int(0, 50), tactics_used: arr(e(TACTIC_VOCAB), 4), content_type: e(CONTENT_TYPES),
      items: arr(obj({ case_for: e(['a', 'b']), said: e(['a', 'b', 'unsure']) }, ['case_for', 'said']), 4),
      weak_spot: s(200),
      misconceptions: obj({ add: arr(obj({ belief: s(200), ref: s(60) }, ['belief']), 2), closed: arr(s(40), 4), worked: arr(s(40), 3) }),
      // Anki ids, whole numbers lesson_save checks itself (no minimum listed: tools/list stays under 36,000).
      card: obj({ note_id: { type: 'integer' }, card_id: { type: 'integer' }, action: e(CARD_ACTIONS) }, ['action']),
      summary: s(1200),
      links: arr(obj({ type: e(LINK_TYPES), other: s(120), a_vs_b: s(240) }, ['type', 'other']), 2),
      memory: obj({
        used: arr(obj({ id: s(40), effect: e(EFFECTS) }, ['id', 'effect']), 6),
        new: arr(obj({ scope: e(SCOPES), scope_ref: s(80), tactic: e(TACTICS), note: s(NOTE_MAX), from_mo: { type: 'boolean' } }, ['scope', 'tactic', 'note']), 2),
      }),
      new_topic: obj({ name: s(80), kind: e(TOPIC_KINDS), category_id: s(60) }, ['name', 'kind', 'category_id']),
      kind: e(MODES), media_shown: arr(s(60), 6),
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
      id: s(40), scope: e(SCOPES), scope_ref: s(80), tactic: e(TACTICS), note: s(NOTE_MAX), status: e(STATUSES), reason: REASON,
      misconception: obj({ id: s(40), topic: s(120), belief: s(200), ref: s(60), status: e(MISC_STATUSES) }),
      mo_said: MO_SAID, confirm_token: CONFIRM,
    }),
    run: (env, user, args, ctx) => {
      const [rest, mo_said] = withoutMoSaid(args);
      return memorySave(env, user, rest, { ...ctx, actor: 'claude', mo_said, via: 'mcp:teach_memory_save' });
    },
  },
];
