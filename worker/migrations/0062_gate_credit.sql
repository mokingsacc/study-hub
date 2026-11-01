ALTER TABLE topic_scores ADD COLUMN gate_nq REAL NOT NULL DEFAULT 0;

-- forecasts.gate_lift: the gate the topic's non-question credit had lifted just before the answer ('blue': blue only
-- because of vivas and card days; 'deep': deep blue the same), else NULL, so the honesty report can test the change
-- against what happened next ("Blue without a real question: N topics, right on M of K later questions").
ALTER TABLE forecasts ADD COLUMN gate_lift TEXT CHECK (gate_lift IS NULL OR gate_lift IN ('blue', 'deep'));
