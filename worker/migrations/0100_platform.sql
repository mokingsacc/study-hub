

-- One password per user (PBKDF2, crypto.js), chosen by the person from their invite link; password_hash is
-- 'unset' (which never verifies) until then. email is optional, used only for self-service resets.
CREATE TABLE credentials (user_id TEXT NOT NULL DEFAULT 'mo' PRIMARY KEY,
  password_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, email TEXT,
  changed_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX ix_credentials_email ON credentials (email) WHERE email IS NOT NULL;

-- Signed-in browsers. id = sha256 of the cookie token (the token itself is never stored); csrf goes in X-CSRF-Token.
CREATE TABLE sessions (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  device TEXT, revoked_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_sessions_id ON sessions (id);

CREATE TABLE auth_codes (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset','email_reset')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_auth_codes_id ON auth_codes (id);

-- Sign-in and reset attempts in fixed windows. bucket: 'login:user:<name>', 'login:ip:<sha256>', 'reset:...'.
-- user_id is '-' for buckets that belong to no signed-in user yet.
CREATE TABLE rate_limits (user_id TEXT NOT NULL DEFAULT 'mo', bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  PRIMARY KEY (user_id, bucket));

-- Each person's own Claude connector address (/mcp/u/<token>). id = sha256 of the token.
CREATE TABLE connector_keys (user_id TEXT NOT NULL DEFAULT 'mo', id TEXT NOT NULL, label TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
  PRIMARY KEY (user_id, id));
CREATE INDEX ix_connector_keys_id ON connector_keys (id);

-- Bring-your-own AI keys, sealed with AES-GCM (crypto.js seal; associated data '<user>|ai_key|<provider>').
-- Never sent to the client: hint is the last four characters only.
CREATE TABLE ai_keys (user_id TEXT NOT NULL DEFAULT 'mo', provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai','gemini')),
  sealed TEXT NOT NULL, hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked','ok','invalid','no_credit')),
  checked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider));

CREATE TABLE ai_settings (user_id TEXT NOT NULL DEFAULT 'mo' PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'workers_ai' CHECK (provider IN ('workers_ai','anthropic','openai','gemini')),
  model TEXT, daily_cap_usd REAL NOT NULL DEFAULT 1, monthly_cap_usd REAL NOT NULL DEFAULT 10,
  admin_cap_usd REAL NOT NULL DEFAULT 30, updated_at INTEGER NOT NULL);

-- Spend per user, London day and provider (Workers AI is counted too, in neurons priced as USD).
CREATE TABLE ai_usage (user_id TEXT NOT NULL DEFAULT 'mo', day TEXT NOT NULL, provider TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, provider));
