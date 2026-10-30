// Teaching (teach_next, lessons, teaching memory, misconceptions, tactics, the Teaching page) registry (owner: TEA).
// The shapes are at the top of registry/index.js. Handlers are wrapped so this file touches the modules only at
// call time (registry import cycles stay harmless).
import * as brief from '../teach-brief.js';
import * as save from '../teach-save.js';
import * as memory from '../teach-memory.js';
import { LINK_WRITES } from '../links-store.js';

// Columns the redesign added to lessons (guard.js's WRITABLE lists the older ones).
const LESSON_COLS = ['content_type', 'tactics_suggested_json', 'misc_ids_json', 'final_explain_json', 'teach_back_json', 'mo_rating', 'mo_rating_why',
  'what_clicked', 'claude_view_json', 'questions_asked', 'tactics_json', 'facts_json', 'blend', 'blend_json', 'tactic_delta_json', 'stick_json',
  'teach_back_text',
  'memory_brought_json',   // the pinned notes the brief brought in (migration 0039)
  'checkpoint_json'];   // what lesson_save's checkpoints hold beyond the probe and steps (migration 0042)
const MISC_COLS = ['topic_id', 'topic_name', 'belief', 'belief_key', 'words', 'ref', 'status', 'first_seen', 'last_seen', 'seen_n', 'targeted_at',
  'closed_at', 'closed_by', 'first_lesson_id', 'lesson_ids_json', 'note'];
const TACTIC_COLS = ['content_type', 'tactic', 'wins', 'losses', 'uses', 'clicked_n', 'last_used_at'];
const MISC_WRITES = { misconceptions: { actions: 'iu', cols: MISC_COLS } };
const RETEST_COLS = ['kind', 'miss_id', 'lesson_id', 'topic_id', 'due', 'source', 'done_at', 'done_by', 'card_state'];
// teach-memory.js's TACTIC_VOCAB and FAVOURITES, written out because this file must not read a module at load time
// (tests/worker/teach-registry.test.mjs keeps them equal).
const VOCAB = ['analogy', 'picture', 'mnemonic', 'contrast_pair', 'mechanism_first', 'worked_example', 'socratic', 'rule_then_cases'];
const FAVS = ['analogy', 'picture', 'mnemonic', 'contrast_pair'];

export const CHANGE_KINDS = {
  // A Teach me tap on the map or the Review page: a requested lesson, served first for 24 h. Free.
  'lesson.request': { tier: 'free', kind: 'lesson.requested', undoable: false, plan: (...a) => brief.planLessonRequest(...a) },
  // teach_next's lessons row (or the tap's row, converted). Free, and not undone (lesson_save or the 3 h timeout ends it).
  'lesson.start': { tier: 'free', kind: 'lesson.started', undoable: false, plan: (...a) => brief.planLessonStart(...a),
    writes: { lessons: { actions: 'iu', cols: LESSON_COLS } } },
  // lesson_save: the probe, step and final results and Claude's judgements are Claude's record ('result' and
  // 'verdict' keys); outcome, blend, minutes, the pair marks and the note scores are code's (codeMarks). One batch,
  // with the tidy (tactic scores, later evidence, misconceptions, duplicate notes), undone with hub_undo.
  'lesson.save': {
    tier: 'free', kind: 'lesson.saved', undoable: true, plan: (...a) => save.planLessonSave(...a),
    allowKeys: ['result', 'verdict'], codeMarks: ['lessons.outcome', 'evidence.result', 'evidence.outcome', 'teach_memory.score', 'retests.result'],
    evidence: true,
    writes: { ...LINK_WRITES, lessons: { actions: 'iu', cols: LESSON_COLS }, ...MISC_WRITES, tactic_scores: { actions: 'iu', cols: TACTIC_COLS },
      // The final case closes the topic's due re-tests and a lesson that only partly landed books its own (0036, retests.js).
      retests: { actions: 'iu', cols: RETEST_COLS }, misses: { actions: 'u', cols: ['next_retest_day'] } },
  },
  'lesson.close': {
    tier: (args, plan, ctx) => (ctx.actor === 'code' ? 'free' : 'refused'), kind: 'lesson.saved', undoable: false, page_only: true,
    allowKeys: ['result', 'verdict'], codeMarks: ['lessons.outcome', 'evidence.result', 'evidence.outcome'], evidence: true,
    writes: { lessons: { actions: 'u', cols: LESSON_COLS }, ...MISC_WRITES },
    reason: 'Stale lessons are closed by the hub itself.', plan: (...a) => save.planLessonClose(...a),
  },
  // The minute-29 clean-up of stale lessons: code only.
  'lesson.expire': {
    tier: (args, plan, ctx) => (ctx.actor === 'code' ? 'free' : 'refused'), kind: 'lesson.saved', undoable: false,
    writes: { lessons: { actions: 'u', cols: ['status', 'abandon_reason', 'ended_at'] } },
    reason: 'Stale lessons are closed by the hub itself.', plan: (...a) => save.planLessonExpire(...a),
  },
  // teach_memory_save and PATCH /api/teach/memory/:id. Claude retiring or unpinning a pinned note is confirmed.
  'teach_memory.save': { tier: (...a) => memory.memoryTier(...a), kind: 'teach_memory.saved', undoable: true, plan: (...a) => memory.planMemorySave(...a) },
  'misconception.add': { tier: 'free', kind: 'teach_memory.saved', undoable: true, plan: (...a) => memory.planMisconceptionAdd(...a), writes: MISC_WRITES },
  'misconception.target': { tier: 'free', kind: 'teach_memory.saved', undoable: true, plan: (...a) => memory.planMisconceptionTarget(...a), writes: MISC_WRITES },
  'misconception.close': { tier: (...a) => memory.misconceptionTier(...a), kind: 'teach_memory.saved', undoable: true, plan: (...a) => memory.planMisconceptionClose(...a), writes: MISC_WRITES },
  'misconception.update': { tier: (...a) => memory.misconceptionTier(...a), kind: 'teach_memory.saved', undoable: true, plan: (...a) => memory.planMisconceptionUpdate(...a), writes: MISC_WRITES },
};

export const UNDO = {
  'lesson.saved': (...a) => save.undoLesson(...a),
  'target:misconception': (...a) => memory.undoMisconception(...a),
  'target:tactic_score': (...a) => memory.undoTacticScore(...a),
  'target:note_use': (...a) => memory.undoNoteUse(...a),
};

export const ROUTES = [
  ['POST', '/api/teach/request', (...a) => brief.requestRoute(...a)],
  ['GET', '/api/teach/lessons', (...a) => brief.lessonsRoute(...a)],
  ['GET', '/api/teach/next', (...a) => brief.nextRoute(...a)],
  ['GET', '/api/teach/memory', (...a) => memory.memoryRoute(...a)],
  ['PATCH', '/api/teach/memory/:id', (...a) => memory.memoryPatchRoute(...a)],
  ['GET', '/api/teach/profile', (...a) => memory.profileRoute(...a)],
  ['PATCH', '/api/teach/prefs', (...a) => memory.prefsPatchRoute(...a)],
  ['GET', '/api/teach/misconceptions', (...a) => memory.misconceptionsRoute(...a)],
  ['POST', '/api/teach/misconceptions', (...a) => memory.misconceptionPostRoute(...a)],
  ['PATCH', '/api/teach/misconceptions/:id', (...a) => memory.misconceptionPatchRoute(...a)],
];

export const PREFS = {
  'teach.lesson_minutes': { type: 'int', min: 0, max: 30, default: 0, label: 'Lesson length in minutes (0: the phase default)', owner: 'teach' },
  'teach.turn_words': { type: 'int', min: 40, max: 150, default: 90, label: 'Words before each check', owner: 'teach' },
  'teach.favourites': { type: 'list', enum: VOCAB, max_items: 8, default: FAVS, label: 'Tactics Mo likes (they start with strong priors)', owner: 'teach' },
};

const T = 't', I = 'i', R = 'r', D = 'd', JA = 'ja', J = 'j';
export const EXPORT = {
  lessons: {
    cols: ['id', 'user_id', 'topic_id', 'topic_name', 'pair_topic_id', 'link_id', 'kind', 'status', 'abandon_reason', 'served_by', 'requested_by', 'request_from',
      'surface_hint', 'requested_at', 'started_at', 'ended_at', 'minutes', 'surface', 'day', 'goal', 'five_step', 'why_chosen', 'priority', 'priority_json',
      'content_type', 'tactics_suggested_json', 'misc_ids_json', 'probe_json', 'steps_json', 'items_json', 'gap_ids_json', 'final_result', 'final_conf',
      'final_explain_json', 'teach_back_json', 'mo_rating', 'mo_rating_why', 'what_clicked', 'claude_view_json', 'questions_asked', 'tactics_json', 'facts_json',
      'blend', 'blend_json', 'outcome', 'tactic_delta_json', 'stick_json', 'weak_spot', 'card_note_id', 'card_id', 'card_action', 'miss_ids_json', 'media_shown_json',
      'memory_used_json', 'memory_written_json', 'mo_feedback', 'method_version', 'source', 'source_ref', 'created_by', 'created_at', 'updated_at', 'teach_back_text',
      'memory_brought_json', 'checkpoint_json'],
    required: ['id', 'user_id', 'kind', 'status', 'created_by', 'created_at', 'updated_at'],
    types: { id: T, user_id: T, topic_id: T, topic_name: T, pair_topic_id: T, link_id: T, kind: ['lesson', 'pair', 'pair_test', 'patch'],
      status: ['requested', 'in_progress', 'done', 'abandoned'], abandon_reason: T, served_by: T, requested_by: T, request_from: T, surface_hint: T,
      requested_at: I, started_at: I, ended_at: I, minutes: R, surface: T, day: D, goal: T, five_step: T, why_chosen: T, priority: R, priority_json: J,
      content_type: ['physiology', 'management', 'pattern'], tactics_suggested_json: JA, misc_ids_json: JA,
      probe_json: J, steps_json: J, items_json: J, gap_ids_json: J, final_result: T, final_conf: T, final_explain_json: J, teach_back_json: J,
      mo_rating: I, mo_rating_why: T, what_clicked: T, claude_view_json: J, questions_asked: I, tactics_json: JA, facts_json: J, blend: R, blend_json: J,
      outcome: ['landed', 'partial', 'not_landed'], tactic_delta_json: JA, stick_json: J,
      weak_spot: T, card_note_id: I, card_id: I, card_action: T, miss_ids_json: J, media_shown_json: J, memory_used_json: J,
      memory_written_json: J, mo_feedback: T, method_version: T, source: T, source_ref: T, created_by: T, created_at: I, updated_at: I, teach_back_text: T,
      memory_brought_json: JA, checkpoint_json: J },
  },
  teach_memory: {
    cols: ['id', 'user_id', 'scope', 'scope_ref', 'tactic', 'note', 'status', 'uses', 'wins', 'losses', 'score', 'evidence_json', 'retired_reason', 'source',
      'source_ref', 'created_by', 'created_at', 'updated_at'],
    required: ['id', 'user_id', 'scope', 'tactic', 'note', 'status', 'created_by', 'created_at', 'updated_at'],
    types: { id: T, user_id: T, scope: ['global', 'category', 'topic', 'kind', 'surface'], scope_ref: T, tactic: T, note: T, status: ['active', 'pinned', 'retired'],
      uses: I, wins: R, losses: R, score: R, evidence_json: JA, retired_reason: T, source: T, source_ref: T, created_by: T, created_at: I, updated_at: I },
  },
  misconceptions: {
    cols: ['user_id', 'id', 'topic_id', 'topic_name', 'belief', 'belief_key', 'words', 'ref', 'status', 'first_seen', 'last_seen', 'seen_n', 'targeted_at',
      'closed_at', 'closed_by', 'first_lesson_id', 'lesson_ids_json', 'note', 'source', 'source_ref', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'belief', 'belief_key', 'words', 'status', 'first_seen', 'last_seen', 'seen_n', 'lesson_ids_json', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, topic_id: T, topic_name: T, belief: T, belief_key: T, words: ['mo', 'claude'], ref: T, status: ['open', 'targeted', 'closed'],
      first_seen: I, last_seen: I, seen_n: I, targeted_at: I, closed_at: I, closed_by: T, first_lesson_id: T, lesson_ids_json: JA, note: T, source: T, source_ref: T,
      created_by: T, created_at: I, updated_at: I },
  },
  tactic_scores: {
    cols: ['user_id', 'content_type', 'tactic', 'wins', 'losses', 'uses', 'clicked_n', 'last_used_at', 'source', 'source_ref', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'content_type', 'tactic', 'wins', 'losses', 'uses', 'clicked_n', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, content_type: ['physiology', 'management', 'pattern'], tactic: VOCAB, wins: R, losses: R, uses: I, clicked_n: I,
      last_used_at: I, source: T, source_ref: T, created_by: T, created_at: I, updated_at: I },
  },
};
