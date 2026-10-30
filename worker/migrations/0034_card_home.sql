ALTER TABLE card_due ADD COLUMN new_pos INTEGER;
CREATE TABLE card_home (user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL, category_id TEXT NOT NULL, topic_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('strong','weak','embed','label','nearest','tag')), score REAL, candidates TEXT,
  label_at INTEGER, checked_at INTEGER NOT NULL, PRIMARY KEY (user_id, card_id));
CREATE INDEX ix_card_home_cat ON card_home (user_id, category_id);
