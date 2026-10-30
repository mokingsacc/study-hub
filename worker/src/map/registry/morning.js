// Release 2.5 teaching registry (owner: MORNING): the morning choice of two topics (morning.js) and each topic's
// "What you know" page (knowledge.js). The shapes are at the top of registry/index.js. Handlers are wrapped so this
// file touches the modules only at call time (registry import cycles stay harmless).
import * as morning from '../morning.js';
import * as knowledge from '../knowledge.js';

// Columns a pick may write: the requested lesson (lesson.request's planner) and the offer rows.
const LESSON_REQUEST_COLS = ['topic_id', 'topic_name', 'pair_topic_id', 'link_id', 'kind', 'status', 'abandon_reason', 'ended_at', 'requested_by', 'request_from',
  'surface_hint', 'requested_at'];

export const CHANGE_KINDS = {
  'today.pick': {
    // Claude has no tool for it (page_only keeps it out of map_rules), and is refused if anything ever tries.
    tier: (args, plan, ctx) => (ctx.actor === 'claude' ? 'refused' : 'free'), reason: 'Mo picks from his own offer.', kind: 'lesson.requested', undoable: false, page_only: true, plan: (...a) => morning.planTodayPick(...a),
    writes: { lessons: { actions: 'iu', cols: LESSON_REQUEST_COLS }, teach_offers: { actions: 'u', cols: ['state', 'decided_at', 'via', 'lesson_id'] } },
  },
};

export const ROUTES = [
  ['GET', '/api/teach/today', (...a) => morning.todayRoute(...a)],
  ['POST', '/api/teach/today/choose', (...a) => morning.todayChooseRoute(...a)],
  ['POST', '/api/teach/today/refresh', (...a) => morning.todayRefreshRoute(...a)],
  ['GET', '/api/teach/today/more', (...a) => morning.todayMoreRoute(...a)],
  ['GET', '/api/map/topic/:id/knowledge', (...a) => knowledge.knowledgeRoute(...a)],
];

const T = 't', I = 'i', D = 'd', J = 'j';
export const EXPORT = {
  teach_offers: {
    cols: ['user_id', 'day', 'slot', 'topic_id', 'topic_name', 'category_id', 'pick', 'reason', 'why_json', 'state', 'offered_at', 'decided_at', 'via', 'lesson_id',
      'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'day', 'slot', 'topic_id', 'pick', 'reason', 'why_json', 'state', 'offered_at', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, day: D, slot: ['a', 'b'], topic_id: T, topic_name: T, category_id: T, pick: ['top', 'contrast', 'runner_up'], reason: T, why_json: J,
      state: ['open', 'chosen', 'declined', 'ignored'], offered_at: I, decided_at: I, via: T, lesson_id: T, created_by: T, created_at: I, updated_at: I },
  },
  teach_skips: {
    cols: ['user_id', 'day', 'topic_id', 'n', 'at', 'via', 'created_at', 'updated_at'],
    required: ['user_id', 'day', 'topic_id', 'n', 'at', 'created_at', 'updated_at'],
    types: { user_id: T, day: D, topic_id: T, n: I, at: I, via: T, created_at: I, updated_at: I },
  },
};
