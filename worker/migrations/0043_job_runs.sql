CREATE TABLE job_runs (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, job TEXT NOT NULL, ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('ok','fallback','held','failed')), counts_json TEXT NOT NULL DEFAULT '{}', detail TEXT,
  at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_job_runs_at ON job_runs (user_id, at);
