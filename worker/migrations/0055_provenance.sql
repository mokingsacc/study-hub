ALTER TABLE misses ADD COLUMN his_words TEXT;
ALTER TABLE misses ADD COLUMN his_words_at INTEGER;
ALTER TABLE misses ADD COLUMN his_words_src TEXT;
ALTER TABLE misses ADD COLUMN mo_corrected_json TEXT;
ALTER TABLE gaps ADD COLUMN mo_corrected_json TEXT;

ALTER TABLE topic_scores ADD COLUMN fsrs_real_n REAL;
ALTER TABLE topic_scores ADD COLUMN trend_basis_json TEXT;
