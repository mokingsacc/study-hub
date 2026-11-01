CREATE TABLE topic_facets (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  facet TEXT NOT NULL CHECK (facet IN ('diagnose', 'manage')),
  p REAL NOT NULL, lo REAL, hi REAL, n INTEGER NOT NULL DEFAULT 0, n_eff REAL NOT NULL DEFAULT 0,
  strength TEXT NOT NULL DEFAULT 'thin' CHECK (strength IN ('thin', 'some', 'solid')), t1000 INTEGER,
  d_system REAL, d_topic REAL, last_at INTEGER, computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id, facet));

-- The honesty check tests the split like everything else: a forecast whose answer has one facet (a miss's step, a
-- re-test of it, a one-question card) carries it, with the facet model's p for that answer (from answers before it).
ALTER TABLE forecasts ADD COLUMN facet TEXT;
ALTER TABLE forecasts ADD COLUMN p_facet REAL;

ALTER TABLE analyses ADD COLUMN step TEXT;

