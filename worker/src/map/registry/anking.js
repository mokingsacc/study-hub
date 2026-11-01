import * as routes from '../../anking/routes.js';

export const ROUTES = [
  ['GET', '/api/anking', (...a) => routes.listRoute(...a)],
  ['GET', '/api/anking/counts', (...a) => routes.countsRoute(...a)],
  ['GET', '/api/anking/:ref', (...a) => routes.oneRoute(...a)],
  ['POST', '/api/anking/:ref/read', (...a) => routes.readRoute(...a)],
  ['POST', '/api/anking/:ref/rate', (...a) => routes.rateRoute(...a)],
  ['POST', '/api/anking/:ref/boxes', (...a) => routes.boxesRoute(...a)],
];

const T = 't', I = 'i', R = 'r', JA = 'ja', JO = 'jo';
export const EXPORT = {
  anking_tables: {
    cols: ['user_id', 'ref', 'table_json', 'rows', 'model', 'usd', 'created_at'],
    required: ['user_id', 'ref', 'table_json', 'created_at'],
    types: { user_id: T, ref: T, table_json: JO, rows: I, model: T, usd: R, created_at: I },
  },
  anking_reviews: {
    cols: ['user_id', 'ref', 'row_id', 'due', 'stability', 'difficulty', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review',
      'last_rating', 'last_missed_json', 'first_at', 'updated_at'],
    required: ['user_id', 'ref', 'row_id', 'due', 'stability', 'difficulty', 'first_at', 'updated_at'],
    types: { user_id: T, ref: T, row_id: T, due: I, stability: R, difficulty: R, scheduled_days: I, learning_steps: I, reps: I, lapses: I, state: I,
      last_review: I, last_rating: ['again', 'hard', 'good', 'easy'], last_missed_json: JA, first_at: I, updated_at: I },
  },
};
export const EXPORT_SKIP = { anking_catalogue: 'A copy of the Anki server\'s picture_catalogue, read again from Anki at most once a day (anking/routes.js catalogue).' };
