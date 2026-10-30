CREATE TABLE learn_points (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ajmonics',
  module TEXT, text TEXT NOT NULL, corrected INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id, id));
CREATE TABLE learn_summaries (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, body_json TEXT NOT NULL, cites_json TEXT NOT NULL DEFAULT '[]',
  ev_mark INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, change_note TEXT, trigger TEXT, model TEXT, usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, topic_id));
CREATE TABLE learn_cards (user_id TEXT NOT NULL DEFAULT 'mo', a_id TEXT NOT NULL, b_id TEXT NOT NULL, body_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  change_note TEXT, model TEXT, usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, a_id, b_id));
CREATE TABLE learn_faq (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, topic_id TEXT NOT NULL, other_id TEXT, q TEXT NOT NULL, a TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_learn_faq_topic ON learn_faq (user_id, topic_id, created_at);
