CREATE TABLE gaps (id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL,
  card_id INTEGER, note_id INTEGER, ref TEXT, topic TEXT, gap TEXT NOT NULL, said TEXT, error_type TEXT,
  verdict TEXT NOT NULL DEFAULT 'gap', created_at INTEGER NOT NULL);
CREATE INDEX idx_gaps_at ON gaps (at);
CREATE TABLE anki_sessions (id TEXT PRIMARY KEY, device TEXT NOT NULL, day TEXT NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER, segments_json TEXT NOT NULL, events_json TEXT NOT NULL, cards_json TEXT, words INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aligned', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_anki_sessions_day ON anki_sessions (day);
CREATE TABLE anki_cards (session_id TEXT NOT NULL, n INTEGER NOT NULL, card_id INTEGER NOT NULL, note_id INTEGER,
  deck TEXT, tags TEXT, shown_at INTEGER, revealed_at INTEGER, answered_at INTEGER, ease INTEGER,
  before_json TEXT NOT NULL DEFAULT '[]', after_json TEXT NOT NULL DEFAULT '[]', words INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'pending', error_type TEXT, gap TEXT, said TEXT, topic TEXT, checked_by TEXT,
  PRIMARY KEY (session_id, n));
CREATE INDEX idx_anki_cards_card ON anki_cards (card_id);
