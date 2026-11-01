CREATE TABLE topic_queue_0077 (id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'mo',
  kind TEXT NOT NULL CHECK (kind IN ('label','gap','card','lookalike','unit','versus','review_row','card_fix')),
  label_norm TEXT NOT NULL, label_raw TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]', refs INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','resolved','rejected')),
  resolved_topic_id TEXT, resolved_by TEXT, result_json TEXT, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0);
INSERT INTO topic_queue_0077 (id, user_id, kind, label_norm, label_raw, context_json, candidates_json, refs, first_seen_at, last_seen_at,
  status, resolved_topic_id, resolved_by, result_json, run_id, attempts)
  SELECT id, user_id, kind, label_norm, label_raw, context_json, candidates_json, refs, first_seen_at, last_seen_at,
    status, resolved_topic_id, resolved_by, result_json, run_id, attempts FROM topic_queue;
DROP TABLE topic_queue;
ALTER TABLE topic_queue_0077 RENAME TO topic_queue;
CREATE INDEX ix_queue_open ON topic_queue (user_id, status, kind, first_seen_at);
