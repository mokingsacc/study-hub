ALTER TABLE gaps ADD COLUMN step TEXT CHECK (step IS NULL OR step IN ('recognise','distinguish','test','treat','trap'));
ALTER TABLE gaps ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('sure','lean','guess'));
-- misses_live is SELECT * FROM misses, so it carries the new column with no change.
ALTER TABLE misses ADD COLUMN step TEXT CHECK (step IS NULL OR step IN ('recognise','distinguish','test','treat','trap'));
