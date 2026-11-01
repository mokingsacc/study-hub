ALTER TABLE cards ADD COLUMN fix_reason TEXT CHECK (fix_reason IS NULL OR fix_reason IN ('badly_worded', 'wrong', 'low_value', 'duplicate'));
ALTER TABLE cards ADD COLUMN fix_at INTEGER;
