-- Tagging flags per question from PUT /api/transcripts (answer_change, override_out_of_range, mic_gap, ...).
ALTER TABLE transcripts ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]';
