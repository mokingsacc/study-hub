CREATE TABLE retests (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'miss' CHECK (kind IN ('miss','lesson')),
  miss_id TEXT, lesson_id TEXT, topic_id TEXT, due TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('hub','anki','lesson')),
  result TEXT CHECK (result IS NULL OR result IN ('got_it','missed_again')), done_at INTEGER, done_by TEXT,
  card_state TEXT NOT NULL DEFAULT 'pending' CHECK (card_state IN ('pending','written','made','done','failed')),
  case_json TEXT, card_id INTEGER, note_id INTEGER, card_at INTEGER, card_tries INTEGER NOT NULL DEFAULT 0, card_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_retests_open ON retests (user_id, result, due);
CREATE INDEX ix_retests_miss ON retests (user_id, miss_id);
CREATE INDEX ix_retests_card ON retests (user_id, card_id);
CREATE INDEX ix_misses_next_retest ON misses (user_id, next_retest_day);
