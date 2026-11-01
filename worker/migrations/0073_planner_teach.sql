ALTER TABLE score_plan_log ADD COLUMN source TEXT NOT NULL DEFAULT 'home';
ALTER TABLE score_plan_log ADD COLUMN lesson_id TEXT;

-- score_plan_coefs: one row a user, replaced by the hourly forecast job (minute 17) and by teach_next when the row is over
--   2 hours old: each topic's lesson and pair-test value as the planner sees them, so teach_next reads one row.
--   plan_json: {model_version, at, k, mean: {lesson, pair}, minutes: {lesson, pair}, validated: {lesson, pair}, unit,
--   topics: {id: {l, p, ls, pr?, v?, pt?}}} (l and v points an hour at the mean effects; unit the median lesson value).
--   Derived: worked out again every hour, so it is not exported.
CREATE TABLE score_plan_coefs (user_id TEXT NOT NULL DEFAULT 'mo', at INTEGER NOT NULL, model_version INTEGER NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id));
