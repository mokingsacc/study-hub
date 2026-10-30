-- UK labs (CONTRACT I34, DESIGN §15.2): the imaging lab's findings and pictures. The ECG lab needs no tables (its
-- tracings are drawn in the browser). Pictures live in R2 under u/<user>/uk-imaging/<id>.<ext>, served behind the
-- hub key with private caching; demo rows (demo = 1, source 'demo') are drawn in the page and only allowed locally.
CREATE TABLE uk_img_findings (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, modality TEXT NOT NULL CHECK (modality IN ('cxr','axr','ct_head','ct','mri','us','xr_msk')),
  title TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', signs_json TEXT NOT NULL DEFAULT '[]',
  versus_json TEXT NOT NULL DEFAULT '[]', uk_json TEXT NOT NULL DEFAULT '[]', sources_json TEXT NOT NULL DEFAULT '[]',
  normal_media_id TEXT, sort INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE TABLE uk_img_media (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, finding_id TEXT NOT NULL, view TEXT,
  r2_key TEXT NOT NULL, mime TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, bytes INTEGER NOT NULL,
  hotspots_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('commons','nih_cxr14','mo','demo')), source_url TEXT, licence TEXT NOT NULL, author TEXT, attribution TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (user_id, id));
CREATE INDEX ix_uk_img_media_finding ON uk_img_media (user_id, finding_id, deleted_at);
