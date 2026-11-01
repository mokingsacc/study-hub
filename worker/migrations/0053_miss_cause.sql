ALTER TABLE misses ADD COLUMN cause TEXT CHECK (cause IS NULL OR cause IN ('confusion','missing_fact','reasoning','ignored_clue','misread','guess'));
ALTER TABLE misses ADD COLUMN cause_quote TEXT;
ALTER TABLE misses ADD COLUMN cause_inferred INTEGER;
ALTER TABLE misses ADD COLUMN cause_detail TEXT;
-- shared/cause.js CAUSE_VERSION of the rules it was judged under, so the overseer never mixes two sets of rules.
ALTER TABLE misses ADD COLUMN cause_version INTEGER;

ALTER TABLE analyses ADD COLUMN cause TEXT;
ALTER TABLE analyses ADD COLUMN cause_quote TEXT;
ALTER TABLE analyses ADD COLUMN cause_inferred INTEGER;
ALTER TABLE analyses ADD COLUMN cause_detail TEXT;

-- The re-judge (map/rejudge.js, POST /api/map/rejudge): the cause the judge named for an existing miss from its stored
-- words, kept so the real run applies exactly what the dry run showed (words_hash: the words it was judged on; a
-- miss whose words changed since is judged again). applied_at and batch_id: the undoable batch that wrote it.
CREATE TABLE cause_judgements (user_id TEXT NOT NULL DEFAULT 'mo', miss_id TEXT NOT NULL, words_hash TEXT NOT NULL,
  cause TEXT, cause_quote TEXT, cause_inferred INTEGER, cause_detail TEXT, version INTEGER NOT NULL,
  judged_at INTEGER NOT NULL, applied_at INTEGER, batch_id TEXT,
  PRIMARY KEY (user_id, miss_id));

-- Before and after (map/snapshots.js): each topic's band and t1000 just before its first recompute under a new
-- WEIGHTS_VERSION, with the look-alike penalty rows it had then (cw_json: [labels]), so "what changed overnight and
-- why" can be told once on the map and to Claude.
CREATE TABLE score_snapshots (user_id TEXT NOT NULL DEFAULT 'mo', version INTEGER NOT NULL, topic_id TEXT NOT NULL,
  band TEXT, t1000 INTEGER, seen INTEGER NOT NULL DEFAULT 0, why_json TEXT NOT NULL DEFAULT '[]', cw_json TEXT NOT NULL DEFAULT '[]',
  taken_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version, topic_id));
