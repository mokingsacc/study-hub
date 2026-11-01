// The map's honesty check (map/honesty.js, 0051_forecasts.sql): its report and a run now. forecasts is derived (the
// nightly job rebuilds it from evidence by itself), so it is not exported; model_versions is the record of which colour
// model was in use and is exported.
// The nightly integrity check (map/integrity.js, wave 2 D) runs right after it and has its report here too, and so does
// the data clean-up (map/hygiene.js, wave 2 B: dry run first, undoable batches).
const honesty = () => import('../honesty.js');
const integrity = () => import('../integrity.js');
const hygiene = () => import('../hygiene.js');
// Shadow mode for scoring changes (1 Nov 2026, map/shadow.js, 0070_shadow.sql): a new rule runs beside the live one on
// the honesty check's answers and goes live only when it predicts them better.
const shadow = () => import('../shadow.js');

export const ROUTES = [
  ['GET', '/api/map/honesty', async (...a) => (await honesty()).honestyRoute(...a)],
  ['POST', '/api/map/honesty/run', async (...a) => (await honesty()).honestyRunRoute(...a)],
  ['GET', '/api/map/integrity', async (...a) => (await integrity()).integrityRoute(...a)],
  // The map's Tidy runs the checks now (and the clean-up's dry run below), without waiting for 02:08.
  ['POST', '/api/map/integrity/run', async (...a) => (await integrity()).integrityRunRoute(...a)],
  ['POST', '/api/map/hygiene', async (...a) => (await hygiene()).hygieneRoute(...a)],
  ['GET', '/api/map/scoring', async (...a) => (await shadow()).scoringRoute(...a)],
  ['POST', '/api/map/scoring/run', async (...a) => (await shadow()).scoringRunRoute(...a)],
  ['POST', '/api/map/scoring/switch', async (...a) => (await shadow()).scoringSwitchRoute(...a)],
  ['POST', '/api/map/scoring/drop', async (...a) => (await shadow()).scoringDropRoute(...a)],
];

const SETTINGS_ROW = { settings: { actions: 'iu', cols: ['key', 'value'] } };
const moOrCode = (args, plan, ctx) => (ctx.actor === 'claude' ? 'confirm' : 'free');
export const CHANGE_KINDS = {
  'scoring.switch': { tier: moOrCode, kind: 'setting.changed', undoable: true, page_only: true, writes: SETTINGS_ROW,
    plan: async (...a) => (await shadow()).planSwitch(...a), apply: async (...a) => (await shadow()).applySwitch(...a) },
  'scoring.drop': { tier: moOrCode, kind: 'setting.changed', undoable: true, page_only: true, writes: SETTINGS_ROW,
    plan: async (...a) => (await shadow()).planDrop(...a) },
};

// A clean-up's row changes go back as they were (hygiene.js undoHygiene), by batch like any change.
export const UNDO = {
  'target:hygiene': async (...a) => (await hygiene()).undoHygiene(...a),
  // A switch of the scoring rules goes back, and every colour is queued to be worked out again under the old rules.
  'target:scoring': async (...a) => (await shadow()).undoScoring(...a),
};

export const EXPORT_SKIP = {
  forecasts: 'The honesty check\'s forecasts: one per answer, worked out again from evidence by the nightly job (map/honesty.js).',
  integrity_runs: 'The nightly integrity check\'s counts and report (map/integrity.js): worked out again from the rows themselves each night.',
  // Wave 3 (0058): derived like forecasts.
  topic_facets: 'Each topic\'s Diagnose / Manage parts: worked out again from evidence as it lands, and by the hourly job (map/facets.js).',
  claude_usage: 'Claude spend per day and role (claude.js): a cost record, kept beside the usage table, not study data.',
  claude_calls: 'Calls waiting in or answered by a Message Batch (claude.js): working state, kept a week, not study data.',
  ai_audits: 'The completeness record of each AI analysis run (ai-audit.js): checked again on every run, kept 30 days.',
  // Shadow mode (0070): derived from the forecasts by replaying the evidence under two weight sets (shadow.js).
  shadow_scores: 'Each answer\'s chance under the live scoring rules and a challenger (shadow.js): worked out again from evidence by the job.',
  shadow_tests: 'Each shadow test\'s running log loss, Brier and verdict (shadow.js): worked out again from shadow_scores.',
};

export const EXPORT = {
  model_versions: {
    cols: ['user_id', 'id', 'created_at', 'model_id', 'params_json', 'adopted_at', 'note'],
    required: ['user_id', 'id', 'created_at', 'model_id'],
    types: { user_id: 't', id: 't', created_at: 'i', model_id: 't', params_json: 'jo', adopted_at: 'i', note: 't' },
  },
};
