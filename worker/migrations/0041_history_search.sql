CREATE TABLE history_items (rid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('miss','gap','uworld_words','anki_words','lesson','teach_note','misconception','retest','mnemonic')),
  src_id TEXT NOT NULL, day TEXT, at INTEGER, source TEXT, label TEXT, topic_id TEXT, topic TEXT, category_id TEXT, system TEXT,
  text TEXT NOT NULL, open TEXT, sig TEXT NOT NULL, text_key TEXT NOT NULL, vec TEXT, vec_scale REAL, model TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key));
CREATE INDEX ix_history_src ON history_items (user_id, kind, src_id);
CREATE INDEX ix_history_day ON history_items (user_id, day);
CREATE INDEX ix_history_vec ON history_items (user_id, model);
CREATE VIRTUAL TABLE history_fts USING fts5(body, topic, label, tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER history_items_ai AFTER INSERT ON history_items BEGIN
  INSERT INTO history_fts (rowid, body, topic, label) VALUES (new.rid, new.text, coalesce(new.topic, ''), coalesce(new.label, ''));
END;
CREATE TRIGGER history_items_au AFTER UPDATE OF text, topic, label ON history_items BEGIN
  DELETE FROM history_fts WHERE rowid = old.rid;
  INSERT INTO history_fts (rowid, body, topic, label) VALUES (new.rid, new.text, coalesce(new.topic, ''), coalesce(new.label, ''));
END;
CREATE TRIGGER history_items_ad AFTER DELETE ON history_items BEGIN
  DELETE FROM history_fts WHERE rowid = old.rid;
END;
