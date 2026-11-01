// Realtime (events, undo, feed, recompute, rebuild) registry (owner: RTC). The shapes are at the top of
// registry/index.js. Handlers are wrapped so this file only touches the modules at call time.
import { changesRoute, syncStatusRoute, syncKickRoute, liveTicketRoute } from '../feed.js';
import { rebuildRoute } from '../rebuild.js';

export const ROUTES = [
  ['GET', '/api/map/changes', (...a) => changesRoute(...a)],
  ['GET', '/api/map/sync', (...a) => syncStatusRoute(...a)],
  ['POST', '/api/map/sync', (...a) => syncKickRoute(...a)],
  ['GET', '/api/map/live-ticket', (...a) => liveTicketRoute(...a)],
  ['POST', '/api/map/rebuild', (...a) => rebuildRoute(...a)],
];

// realtime's own reversal, restoreRow, is undo.js's default and needs no entry. Other areas register theirs
// (undoMerge, undoLesson, unplace, undoImport, links') in their own registry file, by event kind or 'target:<type>'.
export const UNDO = {};

// Import types as export.js: t text, i whole number, r number, d a day, j / ja / jo JSON text, or allowed values.
const T = 't', I = 'i', R = 'r', D = 'd';
const ERROR_TYPES = ['knowledge_gap', 'misread', 'premature_closure', 'faulty_synthesis', 'test_taking', 'threshold', 'calculation'];
// The five checklist steps (map/teach-save.js FIVE_STEPS): the one that broke, on a miss or a gap (0035).
const FIVE_STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
const ACTORS = ['mo', 'claude', 'code', 'anki', 'extractor', 'cron'];

export const EXPORT = {
  misses: {
    cols: ['id', 'user_id', 'source', 'source_ref', 'label', 'qbank', 'day', 'at', 'uw_qid', 'sitting_id', 'block_id', 'q_index', 'uworld_block_id',
      'uworld_q', 'anki_mistake_id', 'result', 'outcome', 'flaw_kind', 'confidence', 'confidence_source', 'error_type', 'time_s', 'slow', 'others_pct',
      'time_source', 'topic_raw', 'condition_raw', 'system_raw', 'label_norm', 'topic_id', 'category_id', 'queue_id', 'match_status', 'match_method',
      'rule', 'my_reasoning', 'reasoning_source', 'right_reasoning', 'look_alikes', 'look_alike_names_json', 'learning_point', 'retests_json',
      'next_retest_day', 'anki_note_ids_json', 'held', 'reviewed_at', 'reviewed_by', 'src_hash', 'gen', 'created_by', 'created_at', 'updated_at', 'deleted_at', 'step',
      'cause', 'cause_quote', 'cause_inferred', 'cause_detail', 'cause_version', 'merged_into',
      'his_words', 'his_words_at', 'his_words_src', 'mo_corrected_json', 'cause_disputed'],
    required: ['id', 'user_id', 'source', 'label', 'day', 'at', 'result', 'created_at', 'updated_at'],
    types: {
      id: T, user_id: T, source: ['hub', 'uworld', 'anki', 'claude', 'onenote'], source_ref: T, label: T,
      qbank: ['uworld', 'nbme', 'uwsa', 'free120', 'cms', 'amboss', 'other'], day: D, at: I, uw_qid: T, sitting_id: T, block_id: T, q_index: I,
      uworld_block_id: T, uworld_q: I, anki_mistake_id: I, result: ['wrong', 'flawed'], outcome: T, flaw_kind: T, confidence: ['sure', 'lean', 'guess'],
      confidence_source: T, error_type: ERROR_TYPES, time_s: I, slow: [0, 1], others_pct: I, time_source: T, topic_raw: T, condition_raw: T,
      system_raw: T, label_norm: T, topic_id: T, category_id: T, queue_id: T, match_status: ['matched', 'proposed', 'open', 'queued', 'rejected'],
      match_method: T, rule: T, my_reasoning: T, reasoning_source: T, right_reasoning: T, look_alikes: T, look_alike_names_json: 'ja',
      learning_point: T, retests_json: 'ja', next_retest_day: D, anki_note_ids_json: 'ja', held: [0, 1], reviewed_at: I, reviewed_by: T,
      src_hash: T, gen: I, created_by: T, created_at: I, updated_at: I, deleted_at: I, step: FIVE_STEPS,
      cause: ['confusion', 'missing_fact', 'reasoning', 'ignored_clue', 'misread', 'guess'], cause_quote: T, cause_inferred: [0, 1], cause_detail: T, cause_version: I, cause_disputed: [0, 1],
      // The miss a duplicate was merged into by the clean-up (0054; map/hygiene.js).
      merged_into: T,
      his_words: T, his_words_at: I, his_words_src: ['uworld', 'exam', 'mo', 'none'], mo_corrected_json: 'jo',
    },
  },
  evidence: {
    cols: ['id', 'user_id', 'obs_key', 'slot', 'topic_id', 'queue_id', 'label_norm', 'category_id', 'kind', 'at', 'day', 'source', 'source_ref',
      'miss_id', 'sitting_id', 'card_id', 'note_id', 'gap_id', 'lesson_id', 'held', 'result', 'outcome', 'verdict', 'confidence', 'error_type',
      'flaw_kind', 'time_s', 'others_pct', 'amount', 'rating', 'detail_json', 'gen', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'obs_key', 'slot', 'kind', 'at', 'day', 'source', 'created_at', 'updated_at'],
    types: {
      id: I, user_id: T, obs_key: T, slot: I, topic_id: T, queue_id: T, label_norm: T, category_id: T, kind: T, at: I, day: D, source: T,
      source_ref: T, miss_id: T, sitting_id: T, card_id: I, note_id: I, gap_id: T, lesson_id: T, held: [0, 1], result: T, outcome: T, verdict: T,
      confidence: T, error_type: T, flaw_kind: T, time_s: I, others_pct: I, amount: R, rating: T, detail_json: 'jo', gen: I, created_by: T,
      created_at: I, updated_at: I,
    },
  },
  map_events: {
    cols: ['seq', 'user_id', 'at', 'actor', 'surface', 'via', 'kind', 'target_type', 'target_id', 'topic_id', 'summary', 'before_json', 'after_json',
      'batch_id', 'source', 'source_ref', 'undoable', 'undo_of', 'undone_by', 'mo_said', 'request_id'],
    required: ['seq', 'user_id', 'at', 'actor', 'kind', 'target_type', 'summary', 'batch_id'],
    types: {
      seq: I, user_id: T, at: I, actor: ACTORS, surface: T, via: T, kind: T, target_type: T, target_id: T, topic_id: T, summary: T,
      before_json: 'j', after_json: 'j', batch_id: T, source: T, source_ref: T, undoable: [0, 1], undo_of: T, undone_by: T, mo_said: T, request_id: T,
    },
  },
  topic_queue: {
    cols: ['id', 'user_id', 'kind', 'label_norm', 'label_raw', 'context_json', 'candidates_json', 'refs', 'first_seen_at', 'last_seen_at', 'status',
      'resolved_topic_id', 'resolved_by', 'result_json', 'run_id', 'attempts'],
    required: ['id', 'user_id', 'kind', 'label_norm', 'label_raw', 'first_seen_at', 'last_seen_at'],
    types: {
      id: T, user_id: T, kind: ['label', 'gap', 'card', 'lookalike', 'unit', 'versus', 'review_row'], label_norm: T, label_raw: T, context_json: 'jo',
      candidates_json: 'ja', refs: I, first_seen_at: I, last_seen_at: I, status: ['open', 'claimed', 'resolved', 'rejected'], resolved_topic_id: T,
      resolved_by: T, result_json: 'j', run_id: T, attempts: I,
    },
  },
  topic_dirty: {
    cols: ['user_id', 'topic_id', 'reason', 'at'],
    required: ['user_id', 'topic_id', 'at'],
    types: { user_id: T, topic_id: T, reason: T, at: I },
  },
  sync_state: {
    cols: ['user_id', 'source', 'cursor', 'last_ok_at', 'next_at', 'fails', 'last_error', 'lock_until'],
    required: ['user_id', 'source'],
    types: { user_id: T, source: T, cursor: T, last_ok_at: I, next_at: I, fails: I, last_error: T, lock_until: I },
  },
};
