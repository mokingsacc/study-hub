ALTER TABLE gaps ADD COLUMN review_id INTEGER;
CREATE INDEX idx_gaps_review ON gaps (user_id, card_id, review_id);
