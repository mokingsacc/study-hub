CREATE TABLE clusters (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone')),
  name TEXT NOT NULL, name_by TEXT NOT NULL DEFAULT 'code' CHECK (name_by IN ('code', 'claude')),
  name_status TEXT NOT NULL DEFAULT 'done' CHECK (name_status IN ('done', 'pending')),
  root_id TEXT, root_kind TEXT, members_json TEXT NOT NULL DEFAULT '[]', pairs_json TEXT NOT NULL DEFAULT '[]',
  cost REAL NOT NULL DEFAULT 0, detail_json TEXT NOT NULL DEFAULT '{}',
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_clusters_status ON clusters (user_id, status, cost);

-- A lesson on a cluster (teach_next mode cluster, or a Teach me tap on one): kind stays 'lesson' (the viva-first flow),
-- topic_id is the cluster's root, cluster_id the cluster; its vivas are marked on the cluster's rubric and counted on
-- every member topic.
ALTER TABLE lessons ADD COLUMN cluster_id TEXT;
