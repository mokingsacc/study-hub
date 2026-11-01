CREATE TABLE anking_catalogue (user_id TEXT NOT NULL DEFAULT 'mo', ref TEXT NOT NULL, title TEXT NOT NULL, kind TEXT,
  subject TEXT, category_id TEXT, seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ref));
CREATE INDEX ix_anking_catalogue_cat ON anking_catalogue (user_id, category_id);
CREATE TABLE anking_tables (user_id TEXT NOT NULL DEFAULT 'mo', ref TEXT NOT NULL, table_json TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0, model TEXT, usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ref));
CREATE TABLE anking_reviews (user_id TEXT NOT NULL DEFAULT 'mo', ref TEXT NOT NULL, row_id TEXT NOT NULL,
  due INTEGER NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0, last_review INTEGER, last_rating TEXT, last_missed_json TEXT NOT NULL DEFAULT '[]',
  first_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ref, row_id));
CREATE INDEX ix_anking_reviews_due ON anking_reviews (user_id, due);
