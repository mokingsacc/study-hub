CREATE TABLE subjects_new (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('gcse','alevel','language','uk_med','primary','university','other')), subject TEXT NOT NULL, name TEXT NOT NULL,
  board TEXT NOT NULL DEFAULT 'other' CHECK (board IN ('aqa','edexcel','ocr','wjec','eduqas','ccea','other')),
  tier TEXT CHECK (tier IS NULL OR tier IN ('foundation','higher')), spec_code TEXT, exam_year INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')), sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
INSERT INTO subjects_new SELECT user_id, id, track, subject, name, board, tier, spec_code, exam_year, status, sort, created_at, updated_at FROM subjects;
DROP TABLE subjects;
ALTER TABLE subjects_new RENAME TO subjects;

-- 2. Chat notes: what they and their Claude covered in a chat, saved by their Claude as it goes (chat_save, the same
--    chat_key adds to one note) or pasted by them (Paste from Claude). Kept as written; their Claude reads them before
--    teaching or testing a topic. topic_ids_json: the topics it is about (their own ids).
CREATE TABLE chat_notes (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, chat_key TEXT, source TEXT NOT NULL CHECK (source IN ('claude','paste')),
  title TEXT, body TEXT NOT NULL, topic_ids_json TEXT NOT NULL DEFAULT '[]', saves INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX ix_chat_notes ON chat_notes (user_id, updated_at);
CREATE INDEX ix_chat_notes_key ON chat_notes (user_id, chat_key);

-- 3. The daily tracker: one row a day they used the Study Hub (London day), with the minutes the page was open and
--    in front of them (a beat a minute) and how many things they did (cards, tests, papers: counted from events).
CREATE TABLE activity_days (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, beats INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (user_id, day));
