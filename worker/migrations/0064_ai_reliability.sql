CREATE TABLE claude_usage (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, role TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'direct',
  calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, role, mode));

-- claude_calls: the calls sent through the Message Batches API (claude.js). A job's call is queued under the hash of
-- its request (id), the minute cron sends the queued ones as one batch and reads the results back when it ends; the
-- job, run again, finds its answer here. status: queued | submitted | done | failed (errored, expired, or the batch
-- could not be sent: the job then makes the call directly). params_json is kept only until it is sent; result_json is
-- the answer (the model's message). read_at: when the job first took the answer (its cost is counted once).
CREATE TABLE claude_calls (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  batch_id TEXT, params_json TEXT, result_json TEXT, usd REAL NOT NULL DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, submitted_at INTEGER, done_at INTEGER, read_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX claude_calls_status ON claude_calls (user_id, status, batch_id);

CREATE TABLE ai_audits (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, job TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL,
  items INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, reasked INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  parts_json TEXT, failing_json TEXT, PRIMARY KEY (user_id, id));
CREATE INDEX ai_audits_at ON ai_audits (user_id, at);
