CREATE TABLE uworld_pages (user_id TEXT NOT NULL DEFAULT 'mo', block_id TEXT NOT NULL, q INTEGER NOT NULL, uworld_id TEXT,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, block_id, q));
CREATE INDEX ix_uworld_pages_at ON uworld_pages (created_at);
ALTER TABLE uworld_judging ADD COLUMN seen_json TEXT;
