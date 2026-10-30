CREATE TABLE mehlman_summaries (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, passages_key TEXT NOT NULL,
  summary TEXT NOT NULL, pages_json TEXT NOT NULL DEFAULT '[]', model TEXT, usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id, passages_key));
