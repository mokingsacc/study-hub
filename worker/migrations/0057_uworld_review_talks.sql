CREATE TABLE uworld_review_talks (user_id TEXT NOT NULL DEFAULT 'mo', block_id TEXT NOT NULL, segments_json TEXT NOT NULL DEFAULT '[]',
  words INTEGER NOT NULL DEFAULT 0, minutes INTEGER, t0 INTEGER, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, words_sig TEXT, analysis_json TEXT, counts_json TEXT, usd REAL NOT NULL DEFAULT 0, error TEXT,
  sent_at INTEGER, started_at INTEGER, done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, block_id));
CREATE INDEX idx_uworld_review_talks_status ON uworld_review_talks (status, next_at);
