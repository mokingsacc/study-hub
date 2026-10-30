ALTER TABLE topic_scores ADD COLUMN fsrs_s REAL;
ALTER TABLE topic_scores ADD COLUMN fsrs_d REAL;
ALTER TABLE topic_scores ADD COLUMN fsrs_at INTEGER;
ALTER TABLE topic_scores ADD COLUMN fsrs_n REAL NOT NULL DEFAULT 0;
ALTER TABLE topic_scores ADD COLUMN trend INTEGER CHECK (trend IS NULL OR trend IN (-1, 0, 1));
CREATE TABLE exam_topics (user_id TEXT NOT NULL DEFAULT 'mo', exam_id TEXT NOT NULL, q_index INTEGER NOT NULL,
  topic_raw TEXT, system_raw TEXT, topic_id TEXT,
  status TEXT NOT NULL DEFAULT 'labelled' CHECK (status IN ('labelled', 'refused', 'failed')),
  model TEXT, labelled_at INTEGER NOT NULL, PRIMARY KEY (user_id, exam_id, q_index));
