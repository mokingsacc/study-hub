CREATE TABLE subjects (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,          -- '<track>-<subject>' = categories.id
  track TEXT NOT NULL CHECK (track IN ('gcse','alevel','language','uk_med')), subject TEXT NOT NULL, name TEXT NOT NULL,
  board TEXT NOT NULL DEFAULT 'other' CHECK (board IN ('aqa','edexcel','ocr','wjec','eduqas','ccea','other')),
  tier TEXT CHECK (tier IS NULL OR tier IN ('foundation','higher')), spec_code TEXT, exam_year INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')), sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE TABLE result_logs (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, bank TEXT NOT NULL, subject_id TEXT,
  day TEXT NOT NULL, label TEXT, how TEXT NOT NULL CHECK (how IN ('screenshot','typed','claude','paper')),
  rows_json TEXT NOT NULL DEFAULT '[]',                  -- numbers and labels only, never question text
  right_n INTEGER NOT NULL DEFAULT 0, total_n INTEGER NOT NULL DEFAULT 0, marks REAL, out_of REAL, batch_id TEXT,
  created_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX ix_results_day ON result_logs (user_id, day);
CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', subject_id TEXT, topic_id TEXT,
  front TEXT NOT NULL, back TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'mine' CHECK (source IN ('mine','ai','gap','claude','paper','anki')),
  ext_id INTEGER, fsrs_json TEXT NOT NULL, due_at INTEGER NOT NULL, state INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX ix_cards_due ON cards (user_id, suspended, due_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_cards_topic ON cards (user_id, topic_id);
CREATE UNIQUE INDEX ux_cards_ext ON cards (user_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE card_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL,
  at INTEGER NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4), state_before INTEGER, due_before INTEGER,
  stability REAL, difficulty REAL, scheduled_days REAL, duration_ms INTEGER, via TEXT);
CREATE INDEX ix_card_reviews ON card_reviews (user_id, card_id, at);
CREATE TABLE papers (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, subject_id TEXT NOT NULL, title TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}', paper_json TEXT NOT NULL, marks_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','marking','marked')), provider TEXT, model TEXT,
  usd REAL NOT NULL DEFAULT 0, result_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
