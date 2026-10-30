CREATE TABLE note_books (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'us' CHECK (region IN ('us', 'uk')), show_both INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL DEFAULT 0,
  onenote_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));

CREATE TABLE note_sections (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, book_id TEXT NOT NULL, name TEXT NOT NULL, sort REAL NOT NULL DEFAULT 0,
  onenote_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX note_sections_book ON note_sections (user_id, book_id);

-- rev goes up with every batch that touches the page, so an open page knows when to fetch.
CREATE TABLE note_pages (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, section_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', sort REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, onenote_id TEXT, onenote_sha TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX note_pages_section ON note_pages (user_id, section_id);
CREATE INDEX note_pages_onenote ON note_pages (user_id, onenote_id);

-- rev: the page rev of the batch that last wrote the row (GET ...?since=<rev> answers rows above it, deleted ones too).
CREATE TABLE note_blocks (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, page_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'image', 'table')), x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL,
  z INTEGER NOT NULL DEFAULT 0, style TEXT, html TEXT, cells_json TEXT, r2_key TEXT, img_w INTEGER, img_h INTEGER, onenote_ref TEXT,
  rev INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX note_blocks_page ON note_blocks (user_id, page_id, rev);

-- points: "x,y,p x,y,p ..." in world units (one decimal) and pressure (two decimals); x0..y1 the bounding box.
CREATE TABLE note_strokes (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, page_id TEXT NOT NULL,
  tool TEXT NOT NULL CHECK (tool IN ('pen', 'highlighter')), colour TEXT NOT NULL, width REAL NOT NULL, points TEXT NOT NULL,
  x0 REAL NOT NULL, y0 REAL NOT NULL, x1 REAL NOT NULL, y1 REAL NOT NULL, z INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX note_strokes_page ON note_strokes (user_id, page_id, rev);

-- Search over page titles (block_id '') and block text, rewritten in the same batch as the rows.
CREATE VIRTUAL TABLE note_fts USING fts5(user_id UNINDEXED, page_id UNINDEXED, block_id UNINDEXED, text, tokenize = 'porter unicode61');
