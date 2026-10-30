CREATE TABLE uworld_log (id TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'first_pass' CHECK (kind IN ('first_pass', 'incorrect')), created_at INTEGER NOT NULL);
CREATE INDEX idx_uworld_day ON uworld_log (day);
CREATE TABLE cms_log (id TEXT PRIMARY KEY, subject TEXT NOT NULL, form TEXT NOT NULL, score_pct REAL, day TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (subject, form));
ALTER TABLE sittings ADD COLUMN timing TEXT NOT NULL DEFAULT 'strict';
