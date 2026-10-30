CREATE TABLE uworld_judging (user_id TEXT NOT NULL DEFAULT 'mo', block_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  judged_json TEXT NOT NULL DEFAULT '[]', verdicts_json TEXT, usd REAL NOT NULL DEFAULT 0, error TEXT, next_at INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, done_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, block_id));
CREATE TABLE uworld_reviews (user_id TEXT NOT NULL DEFAULT 'mo', block_id TEXT NOT NULL, q INTEGER NOT NULL, uworld_id TEXT, pile TEXT NOT NULL, verdict TEXT,
  error_type TEXT, why TEXT, quote TEXT, teach_json TEXT, topic_id TEXT, pack_json TEXT, pack_tries INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER, logged_at INTEGER, log_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, block_id, q));
CREATE INDEX idx_uworld_reviews_qid ON uworld_reviews (user_id, uworld_id);
