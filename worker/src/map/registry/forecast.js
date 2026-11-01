const forecast = () => import('../../forecast/data.js');

export const ROUTES = [
  ['GET', '/api/forecast', async (...a) => (await forecast()).forecastRoute(...a)],
];

export const EXPORT = {
  score_forecasts: {
    cols: ['user_id', 'day', 'at', 'mid', 'low', 'high', 'low50', 'high50', 'sd', 'p_target', 'level', 'trend', 'state_json', 'inflation', 'pct', 'n_forms', 'rough',
      'model_version', 'top_json', 'inputs_json'],
    required: ['user_id', 'day', 'at', 'mid', 'low', 'high'],
    types: { user_id: 't', day: 'd', at: 'i', mid: 'i', low: 'i', high: 'i', low50: 'i', high50: 'i', sd: 'r', p_target: 'r', level: 'r', trend: 'r', state_json: 'jo',
      inflation: 'r', pct: 'r', n_forms: 'i', rough: [0, 1], model_version: 'i', top_json: 'ja', inputs_json: 'jo' },
  },
  score_forecast_checks: {
    cols: ['user_id', 'sitting_id', 'label', 'form_day', 'forecast_day', 'forecast_mid', 'pred_mean', 'pred_sd', 'kind', 'actual', 'error', 'z', 'pit', 'hit50', 'hit80', 'crps',
      'actual_pct', 'score', 'created_at', 'updated_at'],
    required: ['user_id', 'sitting_id', 'forecast_day', 'created_at', 'updated_at'],
    types: { user_id: 't', sitting_id: 't', label: 't', form_day: 'd', forecast_day: 'd', forecast_mid: 'i', pred_mean: 'i', pred_sd: 'r', kind: ['score', 'pct'], actual: 'i',
      error: 'i', z: 'r', pit: 'r', hit50: [0, 1], hit80: [0, 1], crps: 'r', actual_pct: 'r', score: 'i', created_at: 'i', updated_at: 'i' },
  },
  score_plan_log: {
    cols: ['user_id', 'id', 'at', 'day', 'chosen_id', 'chosen_kind', 'rule', 'propensity', 'other_id', 'candidates_json', 'targets_json', 'model_version', 'outcome_json', 'evaluated_at',
      'source', 'lesson_id'],
    required: ['user_id', 'id', 'at', 'day', 'chosen_id', 'chosen_kind', 'rule'],
    types: { user_id: 't', id: 't', at: 'i', day: 'd', chosen_id: 't', chosen_kind: 't', rule: ['thompson', 'coin'], propensity: 'r', other_id: 't', candidates_json: 'ja',
      targets_json: 'ja', model_version: 'i', outcome_json: 'jo', evaluated_at: 'i', source: ['home', 'teach'], lesson_id: 't' },
  },
};

export const EXPORT_SKIP = {
  score_plan_coefs: 'The planner\'s per-topic values for teach me (forecast/teach-plan.js): worked out again every hour from the map.',
};
