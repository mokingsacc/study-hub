CREATE TABLE topic_picture_checks (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('found','none','error')), added INTEGER NOT NULL DEFAULT 0, ai INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0, error TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY (user_id, topic_id));
