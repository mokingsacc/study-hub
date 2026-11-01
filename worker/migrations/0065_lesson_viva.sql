ALTER TABLE viva_results ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN ('before', 'after'));
CREATE INDEX idx_viva_results_lesson_phase ON viva_results (user_id, lesson_id, phase);

ALTER TABLE lessons ADD COLUMN viva_before REAL;
ALTER TABLE lessons ADD COLUMN viva_after REAL;
ALTER TABLE lessons ADD COLUMN viva_json TEXT;
