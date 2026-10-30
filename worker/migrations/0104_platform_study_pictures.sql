-- Study Hub v2 WP3b (docs/platform/v2-plan.md 8.1): pictures on a topic, up to 12 each. A picture is a photo they add
-- (kept in R2 under u/<user>/pictures/, the library's bucket) or a page of a PDF in their own library (doc_id, page,
-- optional crop), drawn in the browser by pdf.js. Written through map/events.js writeBatch, so a delete can be undone
-- (the R2 object stays until the account goes).
CREATE TABLE study_pictures (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, topic_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo','page')), r2_key TEXT, mime TEXT, bytes INTEGER,
  doc_id TEXT, page INTEGER, crop_json TEXT, caption TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')), sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX ix_study_pictures ON study_pictures (user_id, topic_id, status);
