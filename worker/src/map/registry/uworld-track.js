import { routes } from '../../uworld-track.js';

// Looked up at call time, so an import cycle through the registries never meets an unfinished module.
const call = name => (...args) => routes[name](...args);
export const ROUTES = [
  ['GET', '/api/uworld-track', call('get')],
  ['POST', '/api/uworld-track/screenshot', call('screenshot')],
  ['POST', '/api/uworld-track/reading', call('reading')],
  ['POST', '/api/uworld-track/readings/:id', call('decide')],
  ['POST', '/api/uworld-track/adjust', call('adjust')],
  ['POST', '/api/uworld-track/block-kind', call('blockKind')],
  ['POST', '/api/uworld-track/retally', call('retally')],
];

const KIND = ['first_pass', 'incorrect'];
export const EXPORT = {
  uworld_readings: {
    cols: ['user_id', 'id', 'taken_at', 'day', 'source', 'pages', 'used', 'unused', 'total', 'pct_correct', 'tests_created', 'tests_completed',
      'tests_json', 'rows_saved', 'block_id', 'status', 'check_json', 'usd', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'taken_at', 'day', 'created_at', 'updated_at'],
    types: { user_id: 't', id: 't', taken_at: 'i', day: 'd', source: ['screenshot', 'claude', 'mo'], pages: 'ja', used: 'i', unused: 'i', total: 'i',
      pct_correct: 'r', tests_created: 'i', tests_completed: 'i', tests_json: 'ja', rows_saved: 'i', block_id: 't',
      status: ['applied', 'pending', 'discarded'], check_json: 'jo', usd: 'r', created_at: 'i', updated_at: 'i' },
  },
  uworld_adjust: {
    cols: ['user_id', 'day', 'kind', 'n', 'set_at', 'absorbed_json', 'created_at', 'updated_at'],
    required: ['user_id', 'day', 'kind', 'n', 'set_at', 'created_at', 'updated_at'],
    types: { user_id: 't', day: 'd', kind: KIND, n: 'i', set_at: 'i', absorbed_json: 'ja', created_at: 'i', updated_at: 'i' },
  },
  uworld_block_kind: {
    cols: ['user_id', 'block_id', 'kind', 'set_at'],
    required: ['user_id', 'block_id', 'kind', 'set_at'],
    types: { user_id: 't', block_id: 't', kind: KIND, set_at: 'i' },
  },
  uworld_judging: {
    cols: ['user_id', 'block_id', 'status', 'attempts', 'judged_json', 'verdicts_json', 'seen_json', 'usd', 'error', 'next_at', 'started_at', 'done_at', 'updated_at', 'chat_json'],
    required: ['user_id', 'block_id', 'status', 'attempts', 'judged_json', 'usd', 'next_at', 'updated_at'],
    types: { user_id: 't', block_id: 't', status: ['pending', 'running', 'packing', 'done', 'failed', 'capped'], attempts: 'i', judged_json: 'ja',
      verdicts_json: 'ja', seen_json: 'ja', usd: 'r', error: 't', next_at: 'i', started_at: 'i', done_at: 'i', updated_at: 'i', chat_json: 'jo' },
  },
  uworld_reviews: {
    cols: ['user_id', 'block_id', 'q', 'uworld_id', 'pile', 'verdict', 'error_type', 'why', 'quote', 'teach_json', 'topic_id', 'pack_json', 'pack_tries',
      'reviewed_at', 'logged_at', 'log_json', 'words', 'created_at', 'updated_at', 'heard', 'form_version'],
    required: ['user_id', 'block_id', 'q', 'pile', 'pack_tries', 'created_at', 'updated_at'],
    types: { user_id: 't', block_id: 't', q: 'i', uworld_id: 't', pile: ['wrong', 'shaky', 'sound', 'silent'], verdict: ['sound', 'right_flawed', 'wrong', 'no_speech'],
      error_type: 't', why: 't', quote: 't', teach_json: 'jo', topic_id: 't', pack_json: 'jo', pack_tries: 'i', reviewed_at: 'i', logged_at: 'i', log_json: 'jo', words: 'i',
      created_at: 'i', updated_at: 'i', heard: ['clear', 'partial', 'unclear', 'not_said'], form_version: 'i' },
  },
  uworld_review_talks: {
    cols: ['user_id', 'block_id', 'segments_json', 'words', 'minutes', 't0', 'status', 'attempts', 'next_at', 'words_sig', 'analysis_json', 'counts_json', 'usd', 'error',
      'sent_at', 'started_at', 'done_at', 'created_at', 'updated_at', 'form_version'],
    required: ['user_id', 'block_id', 'segments_json', 'words', 'status', 'attempts', 'next_at', 'usd', 'created_at', 'updated_at'],
    types: { user_id: 't', block_id: 't', segments_json: 'ja', words: 'i', minutes: 'i', t0: 'i', status: ['pending', 'waiting', 'running', 'done', 'failed', 'capped', 'chat'], attempts: 'i',
      next_at: 'i', words_sig: 't', analysis_json: 'jo', counts_json: 'jo', usd: 'r', error: 't', sent_at: 'i', started_at: 'i', done_at: 'i', created_at: 'i', updated_at: 'i', form_version: 'i' },
  },
};
export const EXPORT_SKIP = {
  uworld_pages: 'UWorld\'s review pages, held for the judge only and deleted once read (or after a day): never exported or restored.',
};
