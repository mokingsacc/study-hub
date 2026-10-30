
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin','student','viewer')),
  profile TEXT NOT NULL DEFAULT 'step2', profile_json TEXT NOT NULL DEFAULT '{}', prefs_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO users (id, name, role, profile, created_at, updated_at) VALUES ('mo','Hub','admin','step2', CAST(strftime('%s','now') AS INTEGER)*1000, CAST(strftime('%s','now') AS INTEGER)*1000);

CREATE TABLE categories (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT NOT NULL,
  sort INTEGER NOT NULL, exam_profile TEXT NOT NULL DEFAULT 'step2', cms_subject TEXT, onenote_section TEXT, checklist_system TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), source TEXT NOT NULL DEFAULT 'seed', source_ref TEXT,
  created_by TEXT NOT NULL DEFAULT 'seed' CHECK (created_by IN ('seed','code','extractor','claude','mo')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE TABLE category_aliases (user_id TEXT NOT NULL DEFAULT 'mo',
  vocab TEXT NOT NULL CHECK (vocab IN ('uworld_system','uworld_subject','checklist_system','onenote_section','hub_system','amboss','other')),
  alias TEXT NOT NULL, alias_key TEXT NOT NULL, category_id TEXT, confidence REAL NOT NULL DEFAULT 1,   -- category_id NULL: a known name with no default
  source TEXT NOT NULL DEFAULT 'seed', source_ref TEXT, created_by TEXT NOT NULL DEFAULT 'seed', created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vocab, alias_key));
CREATE TABLE units (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, num INTEGER,          -- 'u007'; pseudo-units 'x-<slug>'
  kind TEXT NOT NULL DEFAULT 'checklist' CHECK (kind IN ('checklist','onenote_core','onenote_mehlman')),
  name TEXT NOT NULL, heading TEXT, lane TEXT CHECK (lane IN ('A','B','C')), mehlman_rank INTEGER,
  checklist_system TEXT, checklist_order INTEGER, category_id TEXT NOT NULL,
  onenote_section TEXT, onenote_page_id TEXT, onenote_object_id TEXT, onenote_link TEXT,
  coverage_json TEXT NOT NULL DEFAULT '{}', nbme_images INTEGER NOT NULL DEFAULT 0, notes_gap INTEGER NOT NULL DEFAULT 0,
  yield REAL NOT NULL DEFAULT 0, yield_json TEXT NOT NULL DEFAULT '{}',
  locked_json TEXT NOT NULL DEFAULT '[]',
  exam_profile TEXT NOT NULL DEFAULT 'step2', source TEXT NOT NULL DEFAULT 'onenote', source_ref TEXT,
  created_by TEXT NOT NULL DEFAULT 'seed', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX idx_units_cat ON units (user_id, category_id, lane);
CREATE INDEX idx_units_yield ON units (user_id, yield DESC);
CREATE TABLE unit_topics (user_id TEXT NOT NULL DEFAULT 'mo', unit_id TEXT NOT NULL, topic_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','also')), source TEXT NOT NULL DEFAULT 'seed',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, unit_id, topic_id));
CREATE INDEX idx_unit_topics_topic ON unit_topics (user_id, topic_id);
CREATE TABLE topics (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('condition','approach','drug','organism','concept','finding','procedure')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','merged','retired')),
  merged_into TEXT, suspect_dupe_of TEXT, category_id TEXT NOT NULL, category2_id TEXT, unit_id TEXT, parent_id TEXT,
  amboss_url TEXT, amboss_src TEXT CHECK (amboss_src IN ('tally','claude','guess','mo')), amboss_checked_at INTEGER,
  yield REAL NOT NULL DEFAULT 0, yield_json TEXT NOT NULL DEFAULT '{}', q_seen INTEGER NOT NULL DEFAULT 0,
  anking_cards INTEGER NOT NULL DEFAULT 0, mehlman_match TEXT CHECK (mehlman_match IN ('strong','weak')),
  nbme_images_own INTEGER NOT NULL DEFAULT 0, exam_profile TEXT NOT NULL DEFAULT 'step2', source TEXT NOT NULL, source_ref TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('seed','code','extractor','claude','mo')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, confirmed_at INTEGER, confirmed_by TEXT, PRIMARY KEY (user_id, id));
CREATE INDEX idx_topics_cat ON topics (user_id, category_id, status);
CREATE INDEX idx_topics_unit ON topics (user_id, unit_id);
CREATE INDEX idx_topics_yield ON topics (user_id, status, yield DESC);
CREATE TABLE topic_aliases (user_id TEXT NOT NULL DEFAULT 'mo', alias_key TEXT NOT NULL, topic_id TEXT NOT NULL, alias TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('name','abbrev','british','synonym','uworld_label','truncated','log_topic','analysis_topic',
    'gap_topic','tally_condition','amboss_title','nbme_term','merge','typo')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  source TEXT NOT NULL, source_ref TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias_key, topic_id));
CREATE INDEX idx_aliases_topic ON topic_aliases (user_id, topic_id);

CREATE TABLE misses (id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'mo', source TEXT NOT NULL CHECK (source IN ('hub','uworld','anki','claude','onenote')), source_ref TEXT,
  label TEXT NOT NULL,
  qbank TEXT CHECK (qbank IS NULL OR qbank IN ('uworld','nbme','uwsa','free120','cms','amboss','other')),
  day TEXT NOT NULL, at INTEGER NOT NULL, uw_qid TEXT, sitting_id TEXT, block_id TEXT, q_index INTEGER,
  uworld_block_id TEXT, uworld_q INTEGER, anki_mistake_id INTEGER,
  result TEXT NOT NULL CHECK (result IN ('wrong','flawed')), outcome TEXT, flaw_kind TEXT,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('sure','lean','guess')), confidence_source TEXT,
  error_type TEXT CHECK (error_type IS NULL OR error_type IN ('knowledge_gap','misread','premature_closure','faulty_synthesis',
    'test_taking','threshold','calculation')),
  time_s INTEGER, slow INTEGER NOT NULL DEFAULT 0, others_pct INTEGER, time_source TEXT,
  topic_raw TEXT, condition_raw TEXT, system_raw TEXT, label_norm TEXT, topic_id TEXT, category_id TEXT, queue_id TEXT,
  match_status TEXT NOT NULL DEFAULT 'open' CHECK (match_status IN ('matched','proposed','open','queued','rejected')),
  match_method TEXT,
  rule TEXT, my_reasoning TEXT, reasoning_source TEXT,
  right_reasoning TEXT,                            -- hub rows only: the analysis's own leak-checked gap; never sent through MCP
  look_alikes TEXT, look_alike_names_json TEXT NOT NULL DEFAULT '[]', learning_point TEXT,
  retests_json TEXT NOT NULL DEFAULT '[]', next_retest_day TEXT, anki_note_ids_json TEXT NOT NULL DEFAULT '[]',
  held INTEGER NOT NULL DEFAULT 0, reviewed_at INTEGER, reviewed_by TEXT, src_hash TEXT, gen INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'code', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE UNIQUE INDEX ux_misses_anki ON misses (user_id, anki_mistake_id) WHERE anki_mistake_id IS NOT NULL;
CREATE UNIQUE INDEX ux_misses_hubq ON misses (user_id, block_id, q_index) WHERE block_id IS NOT NULL;
CREATE INDEX ix_misses_uw ON misses (user_id, uw_qid, day) WHERE uw_qid IS NOT NULL;
CREATE INDEX ix_misses_topic ON misses (user_id, topic_id, at);
CREATE INDEX ix_misses_at ON misses (user_id, held, at);
CREATE INDEX ix_misses_queue ON misses (user_id, queue_id) WHERE topic_id IS NULL;
CREATE INDEX ix_misses_sitting ON misses (sitting_id) WHERE sitting_id IS NOT NULL;
CREATE VIEW misses_live AS SELECT * FROM misses WHERE held = 0 AND deleted_at IS NULL;

CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo',
  obs_key TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 0,   -- one observation however many sources report it; slot 1-2 = look-alike / pair partner
  topic_id TEXT, queue_id TEXT, label_norm TEXT, category_id TEXT,
  kind TEXT NOT NULL,                                       -- plan §7.2; unknown kinds: zero mass, still 'seen'
  at INTEGER NOT NULL, day TEXT NOT NULL,
  source TEXT NOT NULL, source_ref TEXT,                    -- open text, first creator (§5.3); never changes a mass
  miss_id TEXT, sitting_id TEXT, card_id INTEGER, note_id INTEGER, gap_id TEXT, lesson_id TEXT,
  held INTEGER NOT NULL DEFAULT 0,
  result TEXT, outcome TEXT, verdict TEXT, confidence TEXT, error_type TEXT, flaw_kind TEXT,
  time_s INTEGER, others_pct INTEGER, amount REAL, rating TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',                   -- short labels only, leak-guarded: {"label":"UW 19038","from_block":1,"pred":0.52}
  gen INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT 'code', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (user_id, obs_key, slot));
CREATE INDEX ix_ev_topic ON evidence (user_id, topic_id, held, at);
CREATE INDEX ix_ev_updated ON evidence (user_id, updated_at);
CREATE INDEX ix_ev_cat ON evidence (user_id, category_id, kind, at);
CREATE INDEX ix_ev_held ON evidence (sitting_id) WHERE held = 1;
CREATE INDEX ix_ev_queue ON evidence (user_id, queue_id) WHERE topic_id IS NULL;
CREATE INDEX ix_ev_gap ON evidence (gap_id) WHERE gap_id IS NOT NULL;
CREATE INDEX ix_ev_card ON evidence (user_id, card_id, day) WHERE card_id IS NOT NULL;
CREATE VIEW evidence_live AS SELECT * FROM evidence WHERE held = 0;

CREATE TABLE map_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('mo','claude','code','anki','extractor','cron')),
  surface TEXT,                                    -- free text, checked in code: chat|voice|code|web|cron|anki|hook|routine|anki_desktop|ankimobile|anki_voice
  via TEXT, kind TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, topic_id TEXT,
  summary TEXT NOT NULL,                           -- ≤160, built by code from labels and names; never question or gap text
  before_json TEXT, after_json TEXT, batch_id TEXT NOT NULL, source TEXT, source_ref TEXT,
  undoable INTEGER NOT NULL DEFAULT 0, undo_of TEXT, undone_by TEXT, mo_said TEXT, request_id TEXT);
CREATE INDEX ix_events_feed ON map_events (user_id, seq);
CREATE INDEX ix_events_target ON map_events (user_id, target_type, target_id, seq);
CREATE INDEX ix_events_topic ON map_events (user_id, topic_id, seq) WHERE topic_id IS NOT NULL;
CREATE INDEX ix_events_batch ON map_events (batch_id);
CREATE INDEX ix_events_actor ON map_events (user_id, actor, at);

CREATE TABLE topic_queue (id TEXT PRIMARY KEY,     -- userKey(user, 'label:<norm>'|'gap:<gap_id>'|'card:<card_id>'|'lookalike:<norm>'|'unit:<unit_id>'|'versus:<ref>'|'review_row:<page>:<n>')
  user_id TEXT NOT NULL DEFAULT 'mo',
  kind TEXT NOT NULL CHECK (kind IN ('label','gap','card','lookalike','unit','versus','review_row')),
  label_norm TEXT NOT NULL, label_raw TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]', refs INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','resolved','rejected')),
  resolved_topic_id TEXT, resolved_by TEXT, result_json TEXT, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX ix_queue_open ON topic_queue (user_id, status, kind, first_seen_at);
CREATE TABLE topic_dirty (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id));
CREATE TABLE sync_state (user_id TEXT NOT NULL DEFAULT 'mo', source TEXT NOT NULL, cursor TEXT, last_ok_at INTEGER, next_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0, last_error TEXT, lock_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, source));

-- The committed gaps table gains its map columns; it is never recreated.
ALTER TABLE gaps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'mo';
ALTER TABLE gaps ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('stated','review'));
ALTER TABLE gaps ADD COLUMN topic_id TEXT;
ALTER TABLE gaps ADD COLUMN sitting_id TEXT;
ALTER TABLE gaps ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gaps ADD COLUMN map_state TEXT CHECK (map_state IS NULL OR map_state IN ('placed','queued'));  -- NULL = not yet mapped
ALTER TABLE gaps ADD COLUMN mapped_at INTEGER;
ALTER TABLE gaps ADD COLUMN mixed_with TEXT;
UPDATE gaps SET origin = CASE WHEN source IN ('chat','spoken_cue') THEN 'stated' WHEN source = 'anki_mac' THEN 'review'
  WHEN source = 'anki_voice' AND (card_id IS NOT NULL OR said IS NOT NULL) THEN 'review' ELSE 'stated' END;
CREATE INDEX idx_gaps_map ON gaps (user_id, map_state, held);
CREATE INDEX idx_gaps_topic ON gaps (user_id, topic_id, at);
CREATE INDEX idx_gaps_held ON gaps (sitting_id) WHERE held = 1;

CREATE TABLE topic_scores (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER, last_seen_at INTEGER, last_question_at INTEGER, last_miss_at INTEGER,
  category_id TEXT, prior_mastery REAL NOT NULL, ref_at INTEGER NOT NULL,   -- group masses below are decayed to ref_at
  q_pass REAL NOT NULL DEFAULT 0, q_fail REAL NOT NULL DEFAULT 0, card_pass REAL NOT NULL DEFAULT 0, card_fail REAL NOT NULL DEFAULT 0,
  card_state REAL NOT NULL DEFAULT 0, lesson_pass REAL NOT NULL DEFAULT 0, lesson_fail REAL NOT NULL DEFAULT 0,
  self_pass REAL NOT NULL DEFAULT 0, self_fail REAL NOT NULL DEFAULT 0, gap_fail REAL NOT NULL DEFAULT 0,
  strong_fails_json TEXT NOT NULL DEFAULT '[]',
  mastery REAL, weakness REAL, weakness_raw REAL,  -- unseen: mastery and weakness NULL, weakness_raw = 1 - prior
  t REAL, band TEXT NOT NULL DEFAULT 'unseen', certainty REAL NOT NULL DEFAULT 0, certainty_level TEXT NOT NULL DEFAULT 'low',
  n_seen INTEGER NOT NULL DEFAULT 0, questions_n INTEGER, right_n INTEGER, misses_n INTEGER, sure_wrong_n INTEGER, slow_n INTEGER,
  cards_n INTEGER, lapses_n INTEGER, lessons_n INTEGER, retests_n INTEGER, gaps_n INTEGER,
  why_json TEXT NOT NULL DEFAULT '[]', evidence_at INTEGER, ev_rev INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL, formula_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, topic_id));
CREATE INDEX ix_ts_t ON topic_scores (user_id, seen, t);
CREATE INDEX ix_ts_cat ON topic_scores (user_id, category_id);
CREATE TABLE category_priors (user_id TEXT NOT NULL DEFAULT 'mo', category_id TEXT NOT NULL, prior REAL NOT NULL,
  right_n INTEGER NOT NULL, n INTEGER NOT NULL, g REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, category_id));

-- ==== 40-links.sql ====
-- 40-links.sql (LNK): links between topics and the observations behind them (plan §5.2, §8).
-- links: one row per (user, type, from, to); versus is stored with from_id < to_id. strength, confusion and the
-- other counts are recomputed by code from link_support in the batch of the change that moved them.
-- status 'held' means the only support is from an unreleased hub sitting; every reader filters
-- status IN ('active','proposed'). 'removed' is a tombstone that code never revives.
CREATE TABLE links (id TEXT PRIMARY KEY,         -- 'l_' + first 12 hex of sha256(user|type|from|to); kept through merges
  user_id TEXT NOT NULL DEFAULT 'mo', type TEXT NOT NULL CHECK (type IN ('versus','treated_by','adverse_effect','causes')),
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, directed INTEGER NOT NULL, how TEXT,
  a_vs_b TEXT, b_vs_a TEXT, note TEXT, picture TEXT,
  strength REAL NOT NULL DEFAULT 0, support_n INTEGER NOT NULL DEFAULT 0,
  confusion REAL NOT NULL DEFAULT 0, confusion_at INTEGER, confused_n INTEGER NOT NULL DEFAULT 0,
  last_confused_at INTEGER, last_truth_id TEXT, last_tested_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('held','proposed','active','removed')),
  source TEXT NOT NULL, source_ref TEXT, created_by TEXT NOT NULL CHECK (created_by IN ('seed','code','extractor','claude','mo')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT, removed_reason TEXT);
CREATE UNIQUE INDEX ux_links_key ON links (user_id, type, from_id, to_id);
CREATE INDEX ix_links_from ON links (user_id, from_id, status);
CREATE INDEX ix_links_to ON links (user_id, to_id, status);
CREATE INDEX ix_links_confused ON links (user_id, confusion) WHERE type = 'versus' AND status IN ('active','proposed');
CREATE TABLE link_support (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'mo', link_id TEXT NOT NULL,
  obs_key TEXT NOT NULL, src TEXT NOT NULL,
  role TEXT NOT NULL, w REAL NOT NULL DEFAULT 0, cw REAL NOT NULL DEFAULT 0, truth_id TEXT, text TEXT,
  miss_id TEXT, card_id INTEGER, note_id INTEGER, gap_id TEXT, lesson_id TEXT, sitting_id TEXT,
  held INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE (user_id, link_id, obs_key));
CREATE INDEX ix_ls_link ON link_support (link_id, held, at);
CREATE INDEX ix_ls_held ON link_support (sitting_id) WHERE held = 1;
CREATE INDEX ix_ls_miss ON link_support (user_id, miss_id) WHERE miss_id IS NOT NULL;

CREATE TABLE lessons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'mo',
  topic_id TEXT, topic_name TEXT, pair_topic_id TEXT, link_id TEXT,
  kind TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson','pair','pair_test','patch')),
  status TEXT NOT NULL CHECK (status IN ('requested','in_progress','done','abandoned')),
  abandon_reason TEXT, served_by TEXT, requested_by TEXT, request_from TEXT, surface_hint TEXT,
  requested_at INTEGER, started_at INTEGER, ended_at INTEGER, minutes REAL, surface TEXT, day TEXT,
  goal TEXT, five_step TEXT, why_chosen TEXT, priority REAL, priority_json TEXT,
  content_type TEXT CHECK (content_type IN ('physiology','management','pattern')),   -- the tactic bandit's arm set
  tactics_suggested_json TEXT,                    -- the brief's Thompson picks [{tactic, mean}]
  misc_ids_json TEXT,                             -- the topic's open misconceptions the brief listed
  probe_json TEXT, steps_json TEXT, items_json TEXT, gap_ids_json TEXT,
  final_result TEXT, final_conf TEXT,
  final_explain_json TEXT,
  teach_back_json TEXT,                           -- Claude's judgement of the 30 s teach-back {judgement, missing[]}
  mo_rating INTEGER CHECK (mo_rating BETWEEN 1 AND 10), mo_rating_why TEXT, what_clicked TEXT,
  claude_view_json TEXT,                          -- {verdict, reasons}
  questions_asked INTEGER, tactics_json TEXT,     -- tactics used, from the fixed vocabulary
  facts_json TEXT,                                -- code: {checks, first_time, repairs, wrong_twice, probe_right, probe_n, minutes}
  blend REAL, blend_json TEXT,                    -- code: 0-1 and its parts; outcome comes from it
  outcome TEXT CHECK (outcome IN ('landed','partial','not_landed')),
  tactic_delta_json TEXT,                         -- what this lesson added to tactic_scores (re-saves and undo are exact)
  stick_json TEXT,                                -- later evidence on the topic {at, pass, fail, stick, delta}, applied once
  weak_spot TEXT, card_note_id INTEGER, card_id INTEGER, card_action TEXT,
  miss_ids_json TEXT, media_shown_json TEXT, memory_used_json TEXT, memory_written_json TEXT,
  mo_feedback TEXT, method_version TEXT,
  source TEXT, source_ref TEXT, created_by TEXT NOT NULL DEFAULT 'claude', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX lessons_topic ON lessons (user_id, topic_id, ended_at);
CREATE INDEX lessons_status ON lessons (user_id, status, requested_at);
CREATE TABLE teach_memory (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'mo',
  scope TEXT NOT NULL CHECK (scope IN ('global','category','topic','kind','surface')), scope_ref TEXT,
  tactic TEXT NOT NULL,   -- analogy|picture|mnemonic|contrast_pair|mechanism_first|worked_example|socratic|rule_then_cases|pacing|other
  note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pinned','retired')),
  uses INTEGER NOT NULL DEFAULT 0, wins REAL NOT NULL DEFAULT 0, losses REAL NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0.5,
  evidence_json TEXT NOT NULL DEFAULT '[]', retired_reason TEXT, source TEXT, source_ref TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX teach_memory_scope ON teach_memory (user_id, scope, scope_ref, status);
-- (the original hub seeded its owner's teaching notes here; none in this copy)

CREATE TABLE misconceptions (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  topic_id TEXT, topic_name TEXT, belief TEXT NOT NULL, belief_key TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT 'claude' CHECK (words IN ('mo','claude')), ref TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','targeted','closed')),
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, seen_n INTEGER NOT NULL DEFAULT 1,
  targeted_at INTEGER, closed_at INTEGER, closed_by TEXT, first_lesson_id TEXT, lesson_ids_json TEXT NOT NULL DEFAULT '[]',
  note TEXT, source TEXT, source_ref TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX misconceptions_topic ON misconceptions (user_id, topic_id, status, last_seen);
CREATE INDEX misconceptions_status ON misconceptions (user_id, status, last_seen);
CREATE TABLE tactic_scores (user_id TEXT NOT NULL DEFAULT 'mo',
  content_type TEXT NOT NULL CHECK (content_type IN ('physiology','management','pattern')),
  tactic TEXT NOT NULL CHECK (tactic IN ('analogy','picture','mnemonic','contrast_pair','mechanism_first','worked_example','socratic','rule_then_cases')),
  wins REAL NOT NULL DEFAULT 0, losses REAL NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, clicked_n INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER, source TEXT, source_ref TEXT, created_by TEXT NOT NULL DEFAULT 'code', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, content_type, tactic));

CREATE TABLE card_cache (user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL, note_id INTEGER, deck TEXT,
  question TEXT, answer TEXT, vs TEXT, notes TEXT, schedule TEXT, lapses INTEGER, image_count INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]', full INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY (user_id, card_id));
CREATE TABLE card_topics (user_id TEXT NOT NULL DEFAULT 'mo', card_id INTEGER NOT NULL, topic_id TEXT NOT NULL,
  match TEXT NOT NULL CHECK (match IN ('miss','search','claude','gap')), strong INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'code', created_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT,
  PRIMARY KEY (user_id, card_id, topic_id));
CREATE INDEX ix_card_topics_topic ON card_topics (user_id, topic_id);
CREATE TABLE resources (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mehlman_pdf','onenote','pdf','note','web')), title TEXT NOT NULL, subject TEXT, exam TEXT,
  pages INTEGER, file_name TEXT, r2_key TEXT, url TEXT, bytes INTEGER,
  text_status TEXT NOT NULL DEFAULT 'none' CHECK (text_status IN ('none','pages','indexed')), exam_profile TEXT NOT NULL DEFAULT 'step2',
  source TEXT, source_ref TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE TABLE resource_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mehlman','pdf','note')),          -- never 'amboss'
  resource_id TEXT NOT NULL, page INTEGER, page_to INTEGER, label TEXT, section TEXT,
  snippet TEXT CHECK (snippet IS NULL OR length(snippet) <= 600), query TEXT, rank REAL,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','wrong','hidden')), fetched_at INTEGER,
  source TEXT, source_ref TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (user_id, topic_id, kind, resource_id, page));
CREATE INDEX ix_resource_links_topic ON resource_links (user_id, topic_id, kind);
CREATE TABLE source_fetches (user_id TEXT NOT NULL DEFAULT 'mo', topic_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cards','mehlman','pictures')), fetched_at INTEGER NOT NULL, n INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','weak','error')), error TEXT, list_sha TEXT, queries_json TEXT,
  PRIMARY KEY (user_id, topic_id, kind));

CREATE TABLE topic_positions (user_id TEXT NOT NULL DEFAULT 'mo',
  kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic','category')), ref_id TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, placed_by TEXT NOT NULL DEFAULT 'rule' CHECK (placed_by IN ('rule','layout','mo')),
  pinned INTEGER NOT NULL DEFAULT 0, layout_version INTEGER NOT NULL DEFAULT 0,
  source TEXT, source_ref TEXT, created_by TEXT NOT NULL DEFAULT 'code', updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind, ref_id));

CREATE TABLE checklist_progress (user_id TEXT NOT NULL DEFAULT 'mo',
  unit_id TEXT NOT NULL,                           -- units.id, or 'topic:<topic_id>' for an off-checklist topic's Studied tick
  step TEXT NOT NULL CHECK (step IN ('recognise','distinguish','test','treat','trap','studied','overall')),
  mastered INTEGER NOT NULL DEFAULT 0 CHECK (mastered IN (0,1)),
  rating TEXT CHECK (rating IS NULL OR rating IN ('red','amber','green')),   -- family's school checklist only
  mastered_at INTEGER, source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','onenote')), source_ref TEXT,
  created_by TEXT NOT NULL DEFAULT 'mo' CHECK (created_by IN ('seed','code','claude','mo')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, unit_id, step));

-- The error log as every Review tab and board_* tool reads it: live misses only (held rows of an unfinished
-- sitting and deleted rows never show), the map topic followed one merge hop (a retired topic leaves the miss
-- "not on the map yet"), with its unit, lane and checklist system. Added to the plan's columns: flaw_kind; created_at
-- (when the miss first reached the hub, which decides whether a Studied tick still holds); block_id and q_index (a
-- hub question's place, for the link into Smart review).
CREATE VIEW board_misses AS
SELECT m.id, m.user_id, m.day, m.at, m.label, m.topic_raw, m.source, m.qbank, m.sitting_id, m.anki_mistake_id,
       m.error_type, m.confidence, m.result, m.outcome, m.time_s, m.slow, (m.confidence = 'sure' AND m.result = 'wrong') AS sure_wrong,
       m.rule, m.my_reasoning, m.look_alikes, m.learning_point, m.right_reasoning, m.retests_json, m.next_retest_day, m.anki_note_ids_json,
       m.reviewed_at, m.reviewed_by, m.match_status, m.flaw_kind, m.created_at, m.block_id, m.q_index,
       t.id AS topic_id, t.name AS topic, t.status AS topic_status, coalesce(t.category_id, m.category_id) AS category_id, t.amboss_url,
       u.id AS unit_id, u.num AS unit_num, u.name AS unit, u.lane, u.mehlman_rank, u.yield AS unit_yield,
       coalesce(u.checklist_system, c.checklist_system) AS checklist_system, u.checklist_order
FROM misses_live m
LEFT JOIN topics t0 ON t0.user_id = m.user_id AND t0.id = m.topic_id
LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = CASE WHEN t0.status = 'merged' THEN t0.merged_into ELSE t0.id END
                  AND t.status IN ('proposed','confirmed')
LEFT JOIN units u ON u.user_id = m.user_id AND u.id = t.unit_id
LEFT JOIN categories c ON c.user_id = m.user_id AND c.id = coalesce(t.category_id, m.category_id);

CREATE TABLE onenote_pages (user_id TEXT NOT NULL DEFAULT 'mo', page_id TEXT NOT NULL, title TEXT, section TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('checklist','tally','system','review_table','mnemonics','derived','skip','dead')),
  parts INTEGER, pictures INTEGER, content_sha TEXT, prev_sha TEXT, section_modified TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'new' CHECK (fetch_status IN ('new','queued','fetching','fetched','error','dead')),
  next_part INTEGER NOT NULL DEFAULT 1, fetched_at INTEGER, parsed_at INTEGER, parser_version INTEGER NOT NULL DEFAULT 1,
  counts_json TEXT NOT NULL DEFAULT '{}', error TEXT,
  fetch_id TEXT, parsed_fetch_id TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY (user_id, page_id));
CREATE TABLE onenote_parts (user_id TEXT NOT NULL DEFAULT 'mo', page_id TEXT NOT NULL, fetch_id TEXT NOT NULL, part INTEGER NOT NULL,
  html TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (user_id, page_id, fetch_id, part));
CREATE TABLE topic_notes (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,   -- 'on_'+sha1(source_ref)[0:16] | 'ls_<lesson_id>' | uuid
  topic_id TEXT, unit_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('need_to_know','recognise','distinguish','test','treat','trap','recall_prompt','mastery_goal',
    'big_picture','mnemonic','reference','lesson_summary','mo_note')),
  step TEXT CHECK (step IN ('recognise','distinguish','test','treat','trap')), title TEXT, body TEXT NOT NULL, answer TEXT,
  hot INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','held','deleted')), locked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, source_ref TEXT NOT NULL, content_sha TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('seed','code','extractor','claude','mo')),
  lesson_id TEXT, card_id INTEGER, gap_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, source, source_ref));
CREATE INDEX idx_topic_notes_topic ON topic_notes (user_id, topic_id, kind, status);
CREATE INDEX idx_topic_notes_unit ON topic_notes (user_id, unit_id, kind, ord);
