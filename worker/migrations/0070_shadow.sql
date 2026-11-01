CREATE TABLE shadow_tests (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, champion TEXT NOT NULL, challenger TEXT NOT NULL,
  champion_version INTEGER NOT NULL, challenger_version INTEGER NOT NULL, started_at INTEGER NOT NULL, backtest_done_at INTEGER,
  n INTEGER NOT NULL DEFAULT 0, ll_champion REAL, ll_challenger REAL, brier_champion REAL, brier_challenger REAL,
  verdict TEXT NOT NULL DEFAULT 'collecting' CHECK (verdict IN ('collecting', 'better', 'not_better')), verdict_at INTEGER,
  report_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));

-- shadow_scores: one row per answer the honesty check scored (forecasts, question stratum) and test: the chance each set
-- gives from the evidence strictly before the answer, with the forecast's own m0. id: the forecast's id (obs_key#slot);
-- y is read from forecasts, so a re-judged answer needs no new row. p_*: the ungated chance; c_*: the colour's chance
-- (gated mastery, p for an unseen topic), which the verdict reads. phase: backtest (before the test started) | live.
CREATE TABLE shadow_scores (user_id TEXT NOT NULL DEFAULT 'mo', test_id TEXT NOT NULL, id TEXT NOT NULL, topic_id TEXT NOT NULL,
  at INTEGER NOT NULL, day TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('backtest', 'live')),
  p_champion REAL NOT NULL, p_challenger REAL NOT NULL, c_champion REAL NOT NULL, c_challenger REAL NOT NULL, scored_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, test_id, id));
CREATE INDEX ix_shadow_scores_at ON shadow_scores (user_id, test_id, at);
