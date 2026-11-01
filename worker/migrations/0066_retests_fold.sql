ALTER TABLE retests ADD COLUMN card_deck TEXT;
ALTER TABLE retests ADD COLUMN card_moved_at INTEGER;
ALTER TABLE retests ADD COLUMN covered TEXT;

UPDATE retests SET card_deck = 'retests' WHERE card_id IS NOT NULL;

-- One card per miss: a later booking of a miss (the 28-day one, or a week after "missed again") with no card yet goes.
DELETE FROM retests WHERE kind = 'miss' AND result IS NULL AND card_id IS NULL AND card_state IN ('pending', 'written', 'failed')
  AND EXISTS (SELECT 1 FROM retests o WHERE o.user_id = retests.user_id AND o.miss_id = retests.miss_id AND o.id <> retests.id
    AND (o.due < retests.due OR (o.due = retests.due AND o.id < retests.id)));

-- Lessons no longer book them: a lesson's booking with no card yet goes.
DELETE FROM retests WHERE kind = 'lesson' AND result IS NULL AND card_id IS NULL;

-- misses.next_retest_day follows what is left.
UPDATE misses SET next_retest_day = (SELECT min(r.due) FROM retests r WHERE r.user_id = misses.user_id AND r.miss_id = misses.id AND r.result IS NULL)
  WHERE next_retest_day IS NOT NULL;
