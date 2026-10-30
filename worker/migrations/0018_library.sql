CREATE TABLE library_docs (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  title TEXT NOT NULL, file_name TEXT, collection TEXT, source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','import')),
  sha256 TEXT, bytes INTEGER, page_count INTEGER, r2_key TEXT, upload_id TEXT, parts_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','uploaded','extracting','indexing','ready','refused','failed')),
  status_note TEXT, extractor TEXT, pages_in INTEGER NOT NULL DEFAULT 0, n_pages_text INTEGER NOT NULL DEFAULT 0,
  n_ocr INTEGER NOT NULL DEFAULT 0, n_passages INTEGER NOT NULL DEFAULT 0, n_embedded INTEGER NOT NULL DEFAULT 0,
  n_linked INTEGER NOT NULL DEFAULT 0, chunker_version INTEGER, embed_model TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE UNIQUE INDEX ux_library_docs_sha ON library_docs (user_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX ix_library_docs_status ON library_docs (user_id, status);
CREATE TABLE library_pages (user_id TEXT NOT NULL DEFAULT 'mo', doc_id TEXT NOT NULL, n INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '', chars INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','ocr','image','empty')),
  ocr_state TEXT NOT NULL DEFAULT 'none' CHECK (ocr_state IN ('none','pending','done','skipped','failed')),
  PRIMARY KEY (user_id, doc_id, n));
CREATE INDEX ix_library_pages_ocr ON library_pages (user_id, ocr_state);
CREATE TABLE library_passages (pid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL, page INTEGER NOT NULL, page_to INTEGER NOT NULL, heading TEXT, kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, tokens INTEGER NOT NULL,
  vec TEXT, vec_scale REAL, vec_state INTEGER NOT NULL DEFAULT 0, linked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (user_id, doc_id, seq));
CREATE INDEX ix_library_passages_page ON library_passages (user_id, doc_id, page);
CREATE INDEX ix_library_passages_vec ON library_passages (user_id, vec_state);
CREATE INDEX ix_library_passages_linked ON library_passages (user_id, linked);
CREATE VIRTUAL TABLE library_fts USING fts5(heading, text, content='library_passages', content_rowid='pid',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE TABLE library_links (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, pid INTEGER NOT NULL,
  score REAL NOT NULL, method TEXT NOT NULL CHECK (method IN ('match','vector','search')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id, pid));
CREATE INDEX ix_library_links_pid ON library_links (user_id, pid);
CREATE TABLE library_terms (user_id TEXT NOT NULL DEFAULT 'mo', abbr_key TEXT NOT NULL, abbr TEXT NOT NULL, long TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, abbr_key, long));
CREATE TABLE library_coverage (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  lib_at INTEGER NOT NULL DEFAULT 0, built_at INTEGER NOT NULL, ms INTEGER, PRIMARY KEY (user_id, topic_id));
