ALTER TABLE uworld_blocks ADD COLUMN complete INTEGER;

-- misses.merged_into: the miss a duplicate was merged into by the clean-up (map/hygiene.js, one miss per question).
-- The duplicate is kept, deleted (deleted_at), so undo can put it back; ingestion never brings it back to life: a block
-- re-save goes to the miss it was merged into, and an Anki-log record that owns it is left alone.
ALTER TABLE misses ADD COLUMN merged_into TEXT;

-- integrity_runs: one row a London day, the nightly integrity check's counts (counts over time) and its report.
--   counts_json: {I1: n, ..., I9: n, F: n} (rows that break each rule); report_json: the checks with a few examples
--   each (labels and ids only, never question text) and the one-line verdict; state: ok | failed.
CREATE TABLE integrity_runs (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','failed')), counts_json TEXT NOT NULL DEFAULT '{}',
  report_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (user_id, day));
