CREATE TABLE debug_traces (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, route TEXT, status INTEGER, ms INTEGER, why TEXT NOT NULL, error TEXT,
  trace_json TEXT NOT NULL, bug_id TEXT, expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_debug_traces_at ON debug_traces (at);
CREATE INDEX ix_debug_traces_expires ON debug_traces (expires_at);
CREATE INDEX ix_debug_traces_bug ON debug_traces (bug_id) WHERE bug_id IS NOT NULL;

CREATE TABLE bug_reports (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, at INTEGER NOT NULL,
  source TEXT NOT NULL, page TEXT, note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fixed', 'dropped')),
  bundle_json TEXT NOT NULL DEFAULT '{}', trace_ids TEXT NOT NULL DEFAULT '[]',
  shot_key TEXT, shot_mime TEXT, shot_data TEXT, fix TEXT, closed_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_bug_reports_state ON bug_reports (user_id, state, at);
