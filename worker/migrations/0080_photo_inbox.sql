CREATE TABLE photo_inbox (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, r2_key TEXT NOT NULL, thumb_key TEXT,
  mime TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'paste' CHECK (source IN ('paste','drop','file','camera')),
  created_at INTEGER NOT NULL, filed_at INTEGER, topic_id TEXT, photo_id TEXT, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX ix_photo_inbox_waiting ON photo_inbox (user_id, deleted_at, filed_at, created_at);
