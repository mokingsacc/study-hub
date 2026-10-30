-- 0014_read_indexes.sql (release 2, PERF5): indexes for the reads that scanned whole tables on the live hub (D1 insights,
-- 25 Oct 2026: 47.6 million rows read in a day). Indexes only: no table, column or row changes, safe to apply at any time.
--   ix_events_user_batch  a batch's events (resolve.js requeueAfter, undo.js): "user_id = ? AND batch_id = ?" was planned
--                         on ix_events_actor (user_id) and read every event (6,720 rows a call); now only the batch's own.
--   ix_dirty_at           the dirty-topic drain (recompute.js, every minute): "ORDER BY at, topic_id LIMIT 20" read and
--                         sorted the whole backlog (805 rows a call); now the first 20 in order.
--   ix_ev_held_user, ix_gaps_held_user   the release sweep (sync.js sweepReleases, every minute): held rows by user were
--                         read through ix_ev_updated, every evidence row (465 rows a call); now only the held ones.
CREATE INDEX IF NOT EXISTS ix_events_user_batch ON map_events (user_id, batch_id);
CREATE INDEX IF NOT EXISTS ix_dirty_at ON topic_dirty (user_id, at, topic_id);
CREATE INDEX IF NOT EXISTS ix_ev_held_user ON evidence (user_id, sitting_id) WHERE held = 1;
CREATE INDEX IF NOT EXISTS ix_gaps_held_user ON gaps (user_id, sitting_id) WHERE held = 1;
