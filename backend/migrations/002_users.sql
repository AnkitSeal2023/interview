-- 002: user accounts. Anonymous sessions (candidate_id cookie only) may be claimed
-- by a user at register/login time; claimable history becomes user-scoped.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  password_hash TEXT NOT NULL,              -- pbkdf2_hmac-sha256, format: salt$hash
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE deleted = FALSE;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id UUID
  REFERENCES users(id);  -- denormalized for fast list-by-user
