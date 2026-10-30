import * as ops from '../../mnemonics/ops.js';
import * as routes from '../../mnemonics/routes.js';
import * as seed from '../../mnemonics/seed.js';

const anyone = 'free';
const notClaude = (a, p, c) => (c && c.actor === 'claude' ? 'refused' : 'free');
const W = ops.WRITES;

export const CHANGE_KINDS = {
  'mnemonic.add': { tier: anyone, kind: 'mnemonic.added', undoable: true, page_only: true, writes: W, plan: (...a) => ops.planAdd(...a) },
  'mnemonic.import': { tier: anyone, kind: 'mnemonic.added', undoable: true, page_only: true, writes: W, plan: (...a) => ops.planImport(...a) },
  'mnemonic.edit': { tier: anyone, kind: 'mnemonic.updated', undoable: true, page_only: true, writes: W, plan: (...a) => ops.planEdit(...a) },
  'mnemonic.remove': { tier: (...a) => ops.removeTier(...a), kind: 'mnemonic.removed', undoable: true, page_only: true, writes: W, plan: (...a) => ops.planRemove(...a) },
  'mnemonic.rate': { tier: notClaude, reason: 'Mnemonics are tested on the Mnemonics page: the recall is his.', kind: 'mnemonic.reviewed', undoable: true,
    page_only: true, writes: W, evidence: true, plan: (...a) => ops.planRate(...a) },
};

export const ROUTES = [
  ['GET', '/api/mnemonics', (...a) => routes.listRoute(...a)],
  ['POST', '/api/mnemonics', (...a) => routes.addRoute(...a)],
  ['GET', '/api/mnemonics/counts', (...a) => routes.countsRoute(...a)],
  ['GET', '/api/mnemonics/test', (...a) => routes.testRoute(...a)],
  ['GET', '/api/mnemonics/galaxy', (...a) => routes.galaxyRoute(...a)],
  ['POST', '/api/mnemonics/import', (...a) => routes.importRoute(...a)],
  ['POST', '/api/mnemonics/seed', (...a) => seed.seedRoute(...a)],
  ['PATCH', '/api/mnemonics/:id', (...a) => routes.editRoute(...a)],
  ['DELETE', '/api/mnemonics/:id', (...a) => routes.removeRoute(...a)],
  ['POST', '/api/mnemonics/:id/rate', (...a) => routes.rateRoute(...a)],
];

const T = 't', I = 'i', R = 'r', JA = 'ja';
export const EXPORT = {
  mnemonics: {
    cols: ['user_id', 'id', 'cue', 'about', 'kind', 'items_json', 'topics_json', 'category_id', 'notes', 'source', 'source_ref', 'created_by', 'created_at', 'updated_at', 'deleted_at'],
    required: ['user_id', 'id', 'cue', 'about', 'items_json', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, cue: T, about: T, kind: ['acronym', 'hook', 'rule'], items_json: JA, topics_json: JA, category_id: T, notes: T,
      source: ['onenote', 'ajmonics', 'mo', 'claude'], source_ref: T, created_by: T, created_at: I, updated_at: I, deleted_at: I },
  },
  mnemonic_reviews: {
    cols: ['user_id', 'mnemonic_id', 'dir', 'due', 'stability', 'difficulty', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review',
      'last_rating', 'last_missed_json', 'first_at', 'updated_at'],
    required: ['user_id', 'mnemonic_id', 'dir', 'due', 'stability', 'difficulty', 'first_at', 'updated_at'],
    types: { user_id: T, mnemonic_id: T, dir: ['fwd', 'rev'], due: I, stability: R, difficulty: R, scheduled_days: I, learning_steps: I, reps: I, lapses: I,
      state: I, last_review: I, last_rating: ['again', 'hard', 'good', 'easy'], last_missed_json: JA, first_at: I, updated_at: I },
  },
};
