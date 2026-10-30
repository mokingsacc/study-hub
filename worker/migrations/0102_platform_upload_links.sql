-- Study Hub platform (Alex, 25 Oct): a one-time upload link her own Claude makes ("add these photos to my library").
-- The link opens the hub's upload screen without signing in, adds files to her library only, and ends after an hour
-- or 30 files. id is sha256 of the token (the token itself is never stored).
CREATE TABLE upload_links (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('exam_paper','mark_scheme','notes','other')),
  title TEXT, subject_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  files INTEGER NOT NULL DEFAULT 0, max_files INTEGER NOT NULL DEFAULT 30,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_upload_links_id ON upload_links (id);
