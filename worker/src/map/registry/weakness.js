// Weakness (scores, cards) registry (owner: WEA). Both tables are exported and imported; both can also be rebuilt
// from evidence (recomputeTopics and refreshPriors), so an import that leaves them out loses nothing.
import { BAND_CODES } from '../../../../public/js/map/scale.js';
import * as move from '../miss-move.js';
import * as linkStore from '../links-store.js';
// labeller.js calls the API (claude.js), so it is loaded only when its route runs: nothing the connector loads imports it.
const labeller = () => import('../labeller.js');

// miss.move (release-2 fixes): a miss onto the topic it is really about. Free and undoable; its answer moves with it.
// It writes links' code-computed columns when the miss's look-alike support on its old topic is dropped
// (staleSupportParts), as queue.resolve does; writes is a getter so links-store is read at call time.
export const CHANGE_KINDS = {
  'miss.move': { tier: 'free', kind: move.MOVE_KIND, undoable: true, get writes() { return { ...linkStore.LINK_WRITES }; },
    evidence: { remove: [], repoint: true }, plan: (...a) => move.planMissMove(...a) },
};
export const UNDO = { [`target:${move.MOVE_TARGET}`]: (...a) => move.undoMissMove(...a) };
export const ROUTES = [
  ['POST', '/api/map/misses/:id/move', (...a) => move.moveRoute(...a)],
  ['GET', '/api/map/labeller', async (...a) => (await labeller()).statusRoute(...a)],
  ['POST', '/api/map/labeller/run', async (...a) => (await labeller()).runRoute(...a)],
];

const SCORE_REALS = ['prior_mastery', 'q_pass', 'q_fail', 'card_pass', 'card_fail', 'card_state', 'lesson_pass', 'lesson_fail',
  'self_pass', 'self_fail', 'gap_fail', 'mastery', 'weakness', 'weakness_raw', 't', 'certainty', 'fsrs_s', 'fsrs_d', 'fsrs_n'];
const SCORE_INTS = ['seen', 'first_seen_at', 'last_seen_at', 'last_question_at', 'last_miss_at', 'ref_at', 'n_seen', 'questions_n', 'right_n',
  'misses_n', 'sure_wrong_n', 'slow_n', 'cards_n', 'lapses_n', 'lessons_n', 'retests_n', 'gaps_n', 'evidence_at', 'ev_rev', 'computed_at',
  'refreshed_at', 'formula_version', 'fsrs_at', 'trend'];
const SCORE_COLS = ['user_id', 'topic_id', 'seen', 'first_seen_at', 'last_seen_at', 'last_question_at', 'last_miss_at', 'category_id',
  'prior_mastery', 'ref_at', 'q_pass', 'q_fail', 'card_pass', 'card_fail', 'card_state', 'lesson_pass', 'lesson_fail', 'self_pass',
  'self_fail', 'gap_fail', 'strong_fails_json', 'mastery', 'weakness', 'weakness_raw', 't', 'band', 'certainty', 'certainty_level',
  'n_seen', 'questions_n', 'right_n', 'misses_n', 'sure_wrong_n', 'slow_n', 'cards_n', 'lapses_n', 'lessons_n', 'retests_n', 'gaps_n',
  'why_json', 'evidence_at', 'ev_rev', 'computed_at', 'refreshed_at', 'formula_version',
  'fsrs_s', 'fsrs_d', 'fsrs_at', 'fsrs_n', 'trend'];   // 0013: FSRS memory per topic (WEA2)

export const EXPORT = {
  topic_scores: {
    cols: SCORE_COLS,
    required: ['user_id', 'topic_id', 'prior_mastery', 'ref_at', 'computed_at', 'refreshed_at'],
    types: {
      user_id: 't', topic_id: 't', category_id: 't', strong_fails_json: 'ja', why_json: 'ja', band: BAND_CODES,
      certainty_level: ['low', 'medium', 'high'],
      ...Object.fromEntries(SCORE_REALS.map(c => [c, 'r'])), ...Object.fromEntries(SCORE_INTS.map(c => [c, 'i'])),
    },
  },
  exam_topics: {
    cols: ['user_id', 'exam_id', 'q_index', 'topic_raw', 'system_raw', 'topic_id', 'status', 'model', 'labelled_at'],
    required: ['user_id', 'exam_id', 'q_index', 'status', 'labelled_at'],
    types: { user_id: 't', exam_id: 't', q_index: 'i', topic_raw: 't', system_raw: 't', topic_id: 't', status: ['labelled', 'refused', 'failed'],
      model: 't', labelled_at: 'i' },
  },
  category_priors: {
    cols: ['user_id', 'category_id', 'prior', 'right_n', 'n', 'g', 'updated_at'],
    required: ['user_id', 'category_id', 'prior', 'right_n', 'n', 'g', 'updated_at'],
    types: { user_id: 't', category_id: 't', prior: 'r', right_n: 'i', n: 'i', g: 'r', updated_at: 'i' },
  },
};
