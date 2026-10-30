CREATE TABLE uworld_blocks (id TEXT PRIMARY KEY, day TEXT NOT NULL, mode TEXT NOT NULL, minutes INTEGER, count INTEGER,
  segments_json TEXT NOT NULL, manual_json TEXT NOT NULL, results_json TEXT NOT NULL, questions_json TEXT NOT NULL DEFAULT '[]', words INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_uworld_blocks_day ON uworld_blocks (day);
