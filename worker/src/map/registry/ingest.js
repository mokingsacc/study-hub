// Ingestion (hub, gaps, Anki, minute dispatcher) registry (owner: ING). The shapes are at the top of registry/index.js.
// Wrapped so this file only touches the modules at call time (registry import cycles stay harmless).
import { dispatchMinute } from '../sync.js';
import { unplace } from '../queue.js';

// The minute cron: cron.js calls it as dispatchMinute(env, ctx, scheduledTime) on every minute but the
// quarter-hour's second (the Anki session check's own slot).
export const MINUTE = (...a) => dispatchMinute(...a);

// Undo of a placement made through map_resolve (taxonomy's queue.resolve emits queue.resolved): the row waits
// on its queue item again and its evidence points back at no topic.
export const UNDO = { 'queue.resolved': (...a) => unplace(...a) };

export const EXPORT = {
  retests: {
    cols: ['user_id', 'id', 'kind', 'miss_id', 'lesson_id', 'topic_id', 'due', 'source', 'result', 'done_at', 'done_by', 'card_state', 'case_json', 'card_id',
      'note_id', 'card_at', 'card_tries', 'card_error', 'created_at', 'updated_at', 'card_deck', 'card_moved_at', 'covered'],
    required: ['user_id', 'id', 'kind', 'due', 'source', 'card_state', 'created_at', 'updated_at'],
    types: {
      user_id: 't', id: 't', kind: ['miss', 'lesson'], miss_id: 't', lesson_id: 't', topic_id: 't', due: 'd', source: ['hub', 'anki', 'lesson'],
      result: ['got_it', 'missed_again'], done_at: 'i', done_by: 't', card_state: ['pending', 'written', 'made', 'done', 'failed'], case_json: 'jo',
      card_id: 'i', note_id: 'i', card_at: 'i', card_tries: 'i', card_error: 't', created_at: 'i', updated_at: 'i',
      card_deck: ['retests', 'mine'], card_moved_at: 'i', covered: ['own_card'],
    },
  },
  pattern_runs: {
    cols: ['user_id', 'id', 'kind', 'ref', 'status', 'attempts', 'error', 'next_at', 'since_at', 'items_n', 'calls', 'usd', 'summary', 'started_at', 'done_at', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'kind', 'status', 'created_at', 'updated_at'],
    types: { user_id: 't', id: 't', kind: ['uworld', 'anki', 'nbme', 'daily', 'catchup'], ref: 't', status: ['pending', 'running', 'done', 'capped', 'failed'], attempts: 'i',
      error: 't', next_at: 'i', since_at: 'i', items_n: 'i', calls: 'i', usd: 'r', summary: 't', started_at: 'i', done_at: 'i', created_at: 'i', updated_at: 'i' },
  },
  pattern_items: {
    cols: ['user_id', 'item_kind', 'item_id', 'run_id', 'topic_id', 'category_id', 'day', 'label', 'traps_json', 'note', 'created_at'],
    required: ['user_id', 'item_kind', 'item_id', 'run_id', 'day', 'created_at'],
    types: { user_id: 't', item_kind: ['miss', 'gap'], item_id: 't', run_id: 't', topic_id: 't', category_id: 't', day: 'd', label: 't', traps_json: 'ja', note: 't', created_at: 'i' },
  },
  habits: {
    cols: ['user_id', 'trap', 'status', 'n', 'topics_n', 'systems_n', 'first_seen', 'last_seen', 'examples_json', 'systems_json', 'note', 'active_at', 'created_at', 'updated_at'],
    required: ['user_id', 'trap', 'status', 'created_at', 'updated_at'],
    types: { user_id: 't', trap: 't', status: ['active', 'quiet'], n: 'i', topics_n: 'i', systems_n: 'i', first_seen: 'd', last_seen: 'd', examples_json: 'ja', systems_json: 'ja',
      note: 't', active_at: 'i', created_at: 'i', updated_at: 'i' },
  },
  learner_profile: {
    cols: ['user_id', 'text', 'insight', 'insight_at', 'facts_json', 'run_id', 'updated_at'],
    required: ['user_id', 'text', 'updated_at'],
    types: { user_id: 't', text: 't', insight: 't', insight_at: 'i', facts_json: 'jo', run_id: 't', updated_at: 'i' },
  },
};
