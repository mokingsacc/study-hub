
ALTER TABLE analyses ADD COLUMN heard TEXT;
ALTER TABLE analyses ADD COLUMN confidence TEXT;
ALTER TABLE analyses ADD COLUMN confidence_words TEXT;
ALTER TABLE analyses ADD COLUMN confidence_inferred INTEGER;
ALTER TABLE analyses ADD COLUMN other_json TEXT;
ALTER TABLE analyses ADD COLUMN cause_check TEXT;
ALTER TABLE analyses ADD COLUMN form_version INTEGER;

ALTER TABLE uworld_reviews ADD COLUMN heard TEXT;
ALTER TABLE uworld_reviews ADD COLUMN form_version INTEGER;

ALTER TABLE anki_cards ADD COLUMN cause TEXT;
ALTER TABLE anki_cards ADD COLUMN heard TEXT;
ALTER TABLE anki_cards ADD COLUMN form_version INTEGER;
ALTER TABLE gaps ADD COLUMN cause TEXT;
ALTER TABLE gaps ADD COLUMN cause_quote TEXT;
ALTER TABLE gaps ADD COLUMN cause_inferred INTEGER;
ALTER TABLE gaps ADD COLUMN cause_detail TEXT;
ALTER TABLE gaps ADD COLUMN heard TEXT;
ALTER TABLE gaps ADD COLUMN form_version INTEGER;

ALTER TABLE uworld_review_talks ADD COLUMN form_version INTEGER;
ALTER TABLE viva_results ADD COLUMN heard TEXT;
ALTER TABLE viva_results ADD COLUMN form_version INTEGER;

ALTER TABLE misses ADD COLUMN cause_disputed INTEGER;

-- A concept tag from a right answer that showed the concept understood (concepts.js): polarity right writes a light
-- Good on the concept topic (kind concept_right); miss (the default) is every tag before.
ALTER TABLE concept_tags ADD COLUMN polarity TEXT NOT NULL DEFAULT 'miss';
