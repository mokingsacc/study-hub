CREATE TABLE xq (rid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  coll TEXT NOT NULL CHECK (coll IN ('nbme','cms')), form TEXT NOT NULL, block TEXT, num INTEGER, cite TEXT NOT NULL,
  status TEXT, also TEXT, unit_id TEXT, topic TEXT, category TEXT, off_title TEXT, task TEXT,
  ans TEXT NOT NULL DEFAULT '', ans_status TEXT, claims_json TEXT, stem TEXT NOT NULL DEFAULT '', qs TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]', expl TEXT, clue TEXT, distractor TEXT, why_wrong TEXT, source TEXT, flags TEXT,
  vec TEXT, vec_scale REAL,
  UNIQUE (user_id, id));
CREATE INDEX ix_xq_unit ON xq (user_id, unit_id, coll);
CREATE INDEX ix_xq_form ON xq (user_id, coll, form);
CREATE INDEX ix_xq_vec ON xq (user_id, vec_scale);
CREATE VIRTUAL TABLE xq_fts USING fts5(body, study, topic, tokenize='porter unicode61 remove_diacritics 2');
CREATE TABLE xq_rank (user_id TEXT NOT NULL DEFAULT 'mo', unit_id TEXT NOT NULL, coll TEXT NOT NULL CHECK (coll IN ('nbme','cms')),
  rank INTEGER NOT NULL, n INTEGER NOT NULL, of_n INTEGER NOT NULL, PRIMARY KEY (user_id, unit_id, coll));
