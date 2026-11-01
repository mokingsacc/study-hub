const panel = () => import('../../forecast/panel.js');
const W = {
  plan_days: { actions: 'iu', cols: ['day', 'minutes', 'low_energy', 'steps_json', 'decision_id'] },
  plan_feedback: { actions: 'i', cols: ['at', 'day', 'option_id', 'kind', 'topic_id', 'partner_id', 'action', 'reason', 'until_day', 'decision_id'] },
};
const moOnly = (args, plan, ctx) => (ctx && ctx.actor === 'mo' ? 'free' : 'refused');

export const CHANGE_KINDS = {
  'plan.day': { tier: moOnly, reason: 'Mo sets his day plan on the hub page.', kind: 'plan.changed', undoable: true, page_only: true, writes: W,
    plan: async (...a) => (await panel()).planDayPlanner(...a) },
  'plan.step': { tier: moOnly, reason: 'Mo marks his own steps done or skipped on the hub page.', kind: 'plan.step', undoable: true, page_only: true, writes: W,
    evidence: { remove: ['plan:'], repoint: false }, plan: async (...a) => (await panel()).planStepPlanner(...a) },
};

export const ROUTES = [
  ['POST', '/api/forecast/day', async (...a) => (await panel()).dayRoute(...a)],
  ['POST', '/api/forecast/step', async (...a) => (await panel()).stepRoute(...a)],
  ['POST', '/api/forecast/target', async (...a) => (await panel()).targetRoute(...a)],
];

const T = 't', I = 'i', D = 'd', JA = 'ja';
export const EXPORT = {
  plan_days: {
    cols: ['user_id', 'day', 'minutes', 'low_energy', 'steps_json', 'decision_id', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'day', 'minutes', 'created_at', 'updated_at'],
    types: { user_id: T, day: D, minutes: I, low_energy: [0, 1], steps_json: JA, decision_id: T, created_by: T, created_at: I, updated_at: I },
  },
  plan_feedback: {
    cols: ['user_id', 'id', 'at', 'day', 'option_id', 'kind', 'topic_id', 'partner_id', 'action', 'reason', 'until_day', 'decision_id', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'at', 'day', 'option_id', 'action', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, at: I, day: D, option_id: T, kind: T, topic_id: T, partner_id: T, action: ['done', 'skip'], reason: ['too_tired', 'know_it', 'not_now', 'disagree'],
      until_day: D, decision_id: T, created_by: T, created_at: I, updated_at: I },
  },
};
