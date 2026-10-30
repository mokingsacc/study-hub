-- Cards (#cards, 26 Oct 2026): every rating and bury the hub's Cards page sent to Anki, by the page's review_id (its
-- idempotency key), so a resent one is never applied twice. status: sent (on its way, or its reply was lost), applied,
-- superseded (Anki already had a newer review of the card, so it was skipped) or refused (Anki said no). Only ids,
-- the ease and times: never card text. Rows over 30 days old are deleted as new ones arrive.
CREATE TABLE card_rates (user_id TEXT NOT NULL DEFAULT 'mo', review_id TEXT NOT NULL, card_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'rate',
  ease INTEGER NOT NULL DEFAULT 0, shown_at INTEGER, status TEXT NOT NULL DEFAULT 'sent', at INTEGER NOT NULL, PRIMARY KEY (user_id, review_id));
CREATE INDEX idx_card_rates_at ON card_rates (at);
