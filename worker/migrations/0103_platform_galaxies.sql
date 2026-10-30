-- Study Hub v2 (docs/platform/v2-plan.md 2.1): a person's own galaxies on their map. A galaxy is a named group of their
-- topics ("Energy", "Mock 1"); a topic sits in at most one (galaxy_topics key), leaves its subject's galaxy on the map
-- only, and stays in its subject everywhere else. Written through map/events.js writeBatch, so one change is one undo.
CREATE TABLE galaxies (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE TABLE galaxy_topics (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, galaxy_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, PRIMARY KEY (user_id, topic_id));
CREATE INDEX ix_galaxy_topics ON galaxy_topics (user_id, galaxy_id);
