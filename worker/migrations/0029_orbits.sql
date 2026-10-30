CREATE TABLE atlas_pages (user_id TEXT NOT NULL DEFAULT 'mo', deck TEXT NOT NULL CHECK (deck IN ('pharm','pathogens')),
  page INTEGER NOT NULL, book_page INTEGER, title TEXT NOT NULL, md_w INTEGER NOT NULL, md_h INTEGER NOT NULL,
  sizes TEXT NOT NULL DEFAULT '', uploaded_at INTEGER, PRIMARY KEY (user_id, deck, page));
-- orbit_sections: a satellite. kind pharm = a pharm diagram or a region of one; kind microbes = a pathogen family page.
CREATE TABLE orbit_sections (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pharm','microbes')),
  title TEXT NOT NULL, short TEXT NOT NULL, deck TEXT NOT NULL, page INTEGER NOT NULL, book_page INTEGER,
  region TEXT,                                   -- 'x0,y0,x1,y1' page fractions; NULL = the whole page
  category_id TEXT NOT NULL, also_json TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')), updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
-- orbit_items: a drug (or class) or an organism.
CREATE TABLE orbit_items (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('drug','class','organism')),
  name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', sections_json TEXT NOT NULL DEFAULT '[]',
  book_pages_json TEXT NOT NULL DEFAULT '[]', topic_id TEXT,      -- the same thing as a hub topic (Lithium, Clindamycin)
  pin TEXT,                                      -- organisms: 'x,y' page fractions on their atlas page (optional)
  updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
-- orbit_links: an item to a topic. topic_id is NULL until a topic of that name exists (to_name keeps the name).
CREATE TABLE orbit_links (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,    -- 'ol_' + 12 hex of sha256(user|item|rel|norm(to_name))
  item_id TEXT NOT NULL, rel TEXT NOT NULL CHECK (rel IN ('treats','adverse_effect','avoid_in','causes')),
  how TEXT CHECK (how IS NULL OR how IN ('first_line','alternative','prophylaxis','antidote','adjunct','common','serious','teratogen','classic','complication')),
  topic_id TEXT, to_name TEXT NOT NULL, why TEXT NOT NULL DEFAULT '' CHECK (length(why) <= 200), source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')), created_by TEXT NOT NULL DEFAULT 'seed',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_orbit_links_topic ON orbit_links (user_id, topic_id, status);
CREATE INDEX ix_orbit_links_item ON orbit_links (user_id, item_id, status);
-- card_due: Anki's schedule for each card the hub can place (bookkeeping, like card_cache; written directly).
CREATE TABLE card_due (user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL, note_id INTEGER, deck TEXT,
  ctype TEXT CHECK (ctype IN ('new','learning','review','relearning')), due_day TEXT, due_at INTEGER, ivl INTEGER, r REAL,
  suspended INTEGER NOT NULL DEFAULT 0, buried INTEGER NOT NULL DEFAULT 0, last_review_day TEXT, checked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id));
CREATE INDEX ix_card_due_day ON card_due (user_id, due_day) WHERE suspended = 0;
CREATE TABLE card_subjects (user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL, category_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('topic','tag')), PRIMARY KEY (user_id, card_id, category_id));
CREATE INDEX ix_card_subjects_cat ON card_subjects (user_id, category_id);
