CREATE TABLE concept_tags (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, source TEXT NOT NULL,
  miss_id TEXT, block_id TEXT, q_index INTEGER, uworld_block_id TEXT, uworld_q INTEGER, misconception_id TEXT,
  clinical_topic_id TEXT, clinical_name TEXT, ref TEXT,
  concept TEXT, concept_key TEXT, discipline TEXT, quote TEXT, cause TEXT, confidence TEXT, weight REAL,
  concept_topic_id TEXT, queue_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('judged','pending','queued','applied','none','skipped','undone')),
  reason TEXT, words_hash TEXT, batch_id TEXT, run_key TEXT, at INTEGER,
  judged_at INTEGER NOT NULL, applied_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX idx_concept_tags_status ON concept_tags (user_id, status, updated_at);
CREATE INDEX idx_concept_tags_concept ON concept_tags (user_id, concept_topic_id, status);
CREATE INDEX idx_concept_tags_miss ON concept_tags (user_id, miss_id);
