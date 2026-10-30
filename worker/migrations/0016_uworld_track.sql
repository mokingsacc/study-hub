CREATE TABLE uworld_readings (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  taken_at INTEGER NOT NULL, day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'screenshot' CHECK (source IN ('screenshot','claude','mo')),
  pages TEXT NOT NULL DEFAULT '[]',
  used INTEGER, unused INTEGER, total INTEGER, pct_correct REAL, tests_created INTEGER, tests_completed INTEGER,
  tests_json TEXT NOT NULL DEFAULT '[]', rows_saved INTEGER NOT NULL DEFAULT 0, block_id TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','pending','discarded')),
  check_json TEXT NOT NULL DEFAULT '{}', usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX uworld_readings_taken ON uworld_readings (user_id, status, taken_at);
CREATE TABLE uworld_adjust (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_pass','incorrect')), n INTEGER NOT NULL CHECK (n >= 0 AND n <= 2400),
  set_at INTEGER NOT NULL, absorbed_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, kind));
CREATE TABLE uworld_block_kind (user_id TEXT NOT NULL DEFAULT 'mo', block_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_pass','incorrect')), set_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, block_id));
