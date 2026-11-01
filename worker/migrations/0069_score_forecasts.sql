CREATE TABLE score_forecasts (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, at INTEGER NOT NULL,
  mid INTEGER NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL, low50 INTEGER, high50 INTEGER, sd REAL, p_target REAL,
  level REAL, trend REAL, state_json TEXT NOT NULL DEFAULT '{}', inflation REAL NOT NULL DEFAULT 1, pct REAL,
  n_forms INTEGER NOT NULL DEFAULT 0, rough INTEGER NOT NULL DEFAULT 1 CHECK (rough IN (0, 1)),
  model_version INTEGER NOT NULL DEFAULT 2, top_json TEXT NOT NULL DEFAULT '[]', inputs_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, day));

CREATE TABLE score_forecast_checks (user_id TEXT NOT NULL DEFAULT 'mo', sitting_id TEXT NOT NULL, label TEXT, form_day TEXT,
  forecast_day TEXT NOT NULL, forecast_mid INTEGER, pred_mean INTEGER, pred_sd REAL, kind TEXT CHECK (kind IS NULL OR kind IN ('score','pct')),
  actual INTEGER, error INTEGER, z REAL, pit REAL, hit50 INTEGER, hit80 INTEGER, crps REAL, actual_pct REAL, score INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sitting_id));

CREATE TABLE score_plan_log (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
  chosen_id TEXT NOT NULL, chosen_kind TEXT NOT NULL, rule TEXT NOT NULL CHECK (rule IN ('thompson','coin')), propensity REAL, other_id TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]', targets_json TEXT NOT NULL DEFAULT '[]', model_version INTEGER NOT NULL DEFAULT 2,
  outcome_json TEXT, evaluated_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_score_plan_log_open ON score_plan_log (user_id, evaluated_at, at);
