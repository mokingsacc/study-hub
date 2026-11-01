CREATE TABLE plan_days (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, minutes INTEGER NOT NULL,
  low_energy INTEGER NOT NULL DEFAULT 0 CHECK (low_energy IN (0, 1)), steps_json TEXT NOT NULL DEFAULT '[]', decision_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day));

CREATE TABLE plan_feedback (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
  option_id TEXT NOT NULL, kind TEXT, topic_id TEXT, partner_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('done', 'skip')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('too_tired', 'know_it', 'not_now', 'disagree')),
  until_day TEXT, decision_id TEXT, created_by TEXT NOT NULL DEFAULT 'mo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_plan_feedback_day ON plan_feedback (user_id, day);

-- lessons.plan_id: the planner decision a lesson was started from ("Teach me ... (plan: d1761...)", the sheet's Start in
--   Claude), so its outcome is measured against that decision (score_plan_log.lesson_id when that column is there).
ALTER TABLE lessons ADD COLUMN plan_id TEXT;
