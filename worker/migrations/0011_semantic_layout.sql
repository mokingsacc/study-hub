CREATE TABLE topic_embeddings (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  model TEXT NOT NULL, dims INTEGER NOT NULL, vec TEXT NOT NULL, scale REAL NOT NULL,
  text_key TEXT NOT NULL, topic_updated_at INTEGER NOT NULL DEFAULT 0,
  neighbours TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id));
