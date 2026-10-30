ALTER TABLE analyses ADD COLUMN decided_at INTEGER;
CREATE INDEX idx_analyses_decided ON analyses (decided_at);
