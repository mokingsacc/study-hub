CREATE TABLE pattern_runs (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('uworld','anki','nbme','daily','catchup')),
  ref TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','capped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, next_at INTEGER NOT NULL DEFAULT 0, since_at INTEGER, items_n INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, summary TEXT, started_at INTEGER, done_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_pattern_runs_status ON pattern_runs (user_id, status, next_at);
CREATE TABLE pattern_items (user_id TEXT NOT NULL DEFAULT 'mo', item_kind TEXT NOT NULL CHECK (item_kind IN ('miss','gap')), item_id TEXT NOT NULL,
  run_id TEXT NOT NULL, topic_id TEXT, category_id TEXT, day TEXT NOT NULL, label TEXT, traps_json TEXT NOT NULL DEFAULT '[]', note TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (user_id, item_kind, item_id));
CREATE INDEX ix_pattern_items_topic ON pattern_items (user_id, topic_id, day);
CREATE INDEX ix_pattern_items_day ON pattern_items (user_id, day);
CREATE TABLE habits (user_id TEXT NOT NULL DEFAULT 'mo', trap TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quiet' CHECK (status IN ('active','quiet')),
  n INTEGER NOT NULL DEFAULT 0, topics_n INTEGER NOT NULL DEFAULT 0, systems_n INTEGER NOT NULL DEFAULT 0, first_seen TEXT, last_seen TEXT,
  examples_json TEXT NOT NULL DEFAULT '[]', systems_json TEXT NOT NULL DEFAULT '[]', note TEXT, active_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, trap));
CREATE TABLE learner_profile (user_id TEXT NOT NULL DEFAULT 'mo', text TEXT NOT NULL, insight TEXT, insight_at INTEGER, facts_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id));
