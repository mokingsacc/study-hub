CREATE TABLE exams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, question_count INTEGER NOT NULL, questions_json TEXT NOT NULL);
CREATE TABLE sittings (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('hub','external')), exam_id TEXT, external_label TEXT, scheduled_date TEXT, preset TEXT, block_size INTEGER, block_minutes INTEGER, break_minutes INTEGER, voice_mode TEXT DEFAULT 'quick', status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','done')), score_pct REAL, official_score INTEGER, notes TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE blocks (id TEXT PRIMARY KEY, sitting_id TEXT NOT NULL, idx INTEGER NOT NULL, q_from INTEGER NOT NULL, q_to INTEGER NOT NULL, state_json TEXT NOT NULL DEFAULT '{}', started_at INTEGER, ended_at INTEGER, correct INTEGER, scored INTEGER, UNIQUE (sitting_id, idx));
CREATE TABLE transcripts (block_id TEXT NOT NULL, q_index INTEGER NOT NULL, segments_json TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (block_id, q_index));
CREATE TABLE analyses (block_id TEXT NOT NULL, q_index INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', verdict TEXT, flaw_kind TEXT, error_type TEXT, error_confirmed TEXT, paraphrase TEXT, gap TEXT, mo_quote TEXT, cleaned_transcript TEXT, spoken_answer TEXT, topic TEXT, system TEXT, rule TEXT, look_alike TEXT, mehlman_note TEXT, mehlman_src TEXT, card_json TEXT, card_decision TEXT DEFAULT 'pending', existing_card_json TEXT, agreement TEXT, checker_json TEXT, decided_by TEXT, mo_override TEXT, error TEXT, created_at INTEGER, PRIMARY KEY (block_id, q_index));
CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, idem_key TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, result_json TEXT, created_at INTEGER NOT NULL, done_at INTEGER);
CREATE TABLE usage (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, whisper_seconds REAL NOT NULL DEFAULT 0);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX idx_sittings_exam ON sittings (exam_id);
CREATE INDEX idx_sittings_status ON sittings (status, scheduled_date);
CREATE INDEX idx_analyses_created ON analyses (created_at);
CREATE INDEX idx_analyses_verdict ON analyses (verdict, created_at);
CREATE INDEX idx_outbox_status ON outbox (status, created_at);
CREATE INDEX idx_outbox_created ON outbox (created_at);
