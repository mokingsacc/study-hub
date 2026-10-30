CREATE TABLE topic_photos (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, topic_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  mime TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('paste','drop','file','camera')),
  created_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX ix_topic_photos_topic ON topic_photos (user_id, topic_id, deleted_at);
CREATE TABLE topic_pictures (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('anki','nbme_hy','anking')),
  ref TEXT NOT NULL, title TEXT, matched_by TEXT, created_at INTEGER NOT NULL, hidden_at INTEGER, PRIMARY KEY (user_id, topic_id, source, ref));
