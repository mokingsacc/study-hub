CREATE TABLE forecasts (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, obs_key TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 0,
  topic_id TEXT NOT NULL, category_id TEXT, source TEXT NOT NULL, stratum TEXT NOT NULL CHECK (stratum IN ('question','card')), kind TEXT NOT NULL,
  at INTEGER NOT NULL, day TEXT NOT NULL,
  p REAL NOT NULL, mastery REAL, band TEXT, cert REAL, n_eff REAL, m0 REAL NOT NULL,
  prior_real_n INTEGER NOT NULL DEFAULT 0, prior_right_n INTEGER NOT NULL DEFAULT 0, last_y INTEGER, days_since_last REAL,
  same_day_feedback INTEGER NOT NULL DEFAULT 0, error_type TEXT, conf TEXT, trend_label TEXT,
  y INTEGER NOT NULL CHECK (y IN (0, 1)), p_shown REAL, model_id TEXT NOT NULL, scored_at INTEGER NOT NULL,
  retracted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_forecasts_at ON forecasts (user_id, stratum, retracted, at);
CREATE INDEX ix_forecasts_topic ON forecasts (user_id, topic_id);

-- model_versions: the colour model's settings over time (review 2, section 6: a refit is adopted only when it predicts
-- better, at most weekly, with one-step rollback). The nightly job records the shipped model the first time it sees it;
-- a later refit adds its own row. id: the model_id hash. params_json: the settings it hashes. adopted_at: when the map
-- started using it (null: tried, not adopted). note: why, in a line.
CREATE TABLE model_versions (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, created_at INTEGER NOT NULL, model_id TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}', adopted_at INTEGER, note TEXT,
  PRIMARY KEY (user_id, id));
