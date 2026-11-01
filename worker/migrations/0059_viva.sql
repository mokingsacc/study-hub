CREATE TABLE viva_rubrics (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')), topic_kind TEXT, sources_hash TEXT,
  points_json TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, usd REAL NOT NULL DEFAULT 0,
  requested_at INTEGER, built_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id));
CREATE INDEX idx_viva_rubrics_status ON viva_rubrics (user_id, status, requested_at);

CREATE TABLE viva_results (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('lesson','audit')),
  topic_id TEXT, topic_name TEXT, lesson_id TEXT, surface TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('awaiting','pending','graded','failed','expired')),
  prompt TEXT, transcript TEXT, said_at INTEGER, rubric_version INTEGER,
  pred_p REAL, pred_band TEXT, pred_json TEXT,
  coverage REAL, grade TEXT CHECK (grade IS NULL OR grade IN ('good','hard','again')), said_n INTEGER, wrong_n INTEGER, missing_n INTEGER,
  result_json TEXT, surprise REAL, surprise_word TEXT CHECK (surprise_word IS NULL OR surprise_word IN ('matched','too_red','too_green')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, usd REAL NOT NULL DEFAULT 0, batch_id TEXT,
  graded_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX idx_viva_results_status ON viva_results (user_id, status, updated_at);
CREATE INDEX idx_viva_results_topic ON viva_results (user_id, topic_id, graded_at);
CREATE INDEX idx_viva_results_lesson ON viva_results (user_id, lesson_id);
