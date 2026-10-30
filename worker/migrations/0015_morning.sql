CREATE TABLE teach_offers (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a','b')), topic_id TEXT NOT NULL, topic_name TEXT, category_id TEXT,
  pick TEXT NOT NULL DEFAULT 'top' CHECK (pick IN ('top','contrast','runner_up')),
  reason TEXT NOT NULL, why_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','chosen','declined','ignored')),
  offered_at INTEGER NOT NULL, decided_at INTEGER, via TEXT, lesson_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'code', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, slot));
CREATE INDEX teach_offers_topic ON teach_offers (user_id, topic_id, day);
CREATE TABLE teach_skips (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, topic_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, via TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, topic_id));
CREATE INDEX teach_skips_topic ON teach_skips (user_id, topic_id, day);
ALTER TABLE lessons ADD COLUMN teach_back_text TEXT;
