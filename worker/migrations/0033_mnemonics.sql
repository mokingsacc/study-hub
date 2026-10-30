CREATE TABLE mnemonics (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  cue TEXT NOT NULL, about TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'acronym' CHECK (kind IN ('acronym','hook','rule')),
  items_json TEXT NOT NULL DEFAULT '[]', topics_json TEXT NOT NULL DEFAULT '[]', category_id TEXT, notes TEXT,
  source TEXT NOT NULL DEFAULT 'mo' CHECK (source IN ('onenote','ajmonics','mo','claude')), source_ref TEXT,
  created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_mnemonics_cat ON mnemonics (user_id, category_id, deleted_at);
CREATE INDEX ix_mnemonics_ref ON mnemonics (user_id, source, source_ref);
-- One FSRS schedule per mnemonic and direction: fwd = cue to expansion, rev = about to cue. Written by op
-- mnemonic.rate (undoable: the row as it was comes back). first_at: the first test, for the daily cap on new ones.
CREATE TABLE mnemonic_reviews (user_id TEXT NOT NULL DEFAULT 'mo', mnemonic_id TEXT NOT NULL, dir TEXT NOT NULL CHECK (dir IN ('fwd','rev')),
  due INTEGER NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0, last_review INTEGER, last_rating TEXT, last_missed_json TEXT NOT NULL DEFAULT '[]',
  first_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mnemonic_id, dir));
CREATE INDEX ix_mnemonic_reviews_due ON mnemonic_reviews (user_id, due);
