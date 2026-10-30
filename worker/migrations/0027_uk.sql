CREATE TABLE uk_entries (
  user_id TEXT NOT NULL DEFAULT 'mo',
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('condition', 'exam', 'skill', 'interpretation', 'investigation', 'law')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  sections_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX uk_entries_kind ON uk_entries (user_id, kind, category) WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE uk_fts USING fts5(user_id UNINDEXED, id UNINDEXED, title, aliases, body, joined, tokenize='porter unicode61 remove_diacritics 2');

CREATE TRIGGER uk_entries_ai AFTER INSERT ON uk_entries WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO uk_fts (user_id, id, title, aliases, body, joined)
  SELECT u, i, t, a, b, replace(replace(replace(replace(replace(t || ' ' || coalesce(a, '') || ' ' || b, '-', ''), char(8208), ''), char(8209), ''), char(8211), ''), char(8722), '') FROM (SELECT new.user_id AS u, new.id AS i, new.title AS t,
    (SELECT group_concat(value, ' ') FROM json_each(new.aliases_json)) AS a,
    coalesce(new.summary, '') || ' ' || coalesce((SELECT group_concat(atom, ' ') FROM json_tree(new.sections_json) WHERE type = 'text'), '') AS b);
END;
CREATE TRIGGER uk_entries_au AFTER UPDATE ON uk_entries BEGIN
  DELETE FROM uk_fts WHERE user_id = old.user_id AND id = old.id;
  INSERT INTO uk_fts (user_id, id, title, aliases, body, joined)
  SELECT u, i, t, a, b, replace(replace(replace(replace(replace(t || ' ' || coalesce(a, '') || ' ' || b, '-', ''), char(8208), ''), char(8209), ''), char(8211), ''), char(8722), '') FROM (SELECT new.user_id AS u, new.id AS i, new.title AS t,
    (SELECT group_concat(value, ' ') FROM json_each(new.aliases_json)) AS a,
    coalesce(new.summary, '') || ' ' || coalesce((SELECT group_concat(atom, ' ') FROM json_tree(new.sections_json) WHERE type = 'text'), '') AS b)
  WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER uk_entries_ad AFTER DELETE ON uk_entries BEGIN
  DELETE FROM uk_fts WHERE user_id = old.user_id AND id = old.id;
END;
