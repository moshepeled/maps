-- Up Migration
CREATE TABLE sessions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash   bytea       NOT NULL,           -- SHA-256 of the current refresh token
  previous_token_hash  bytea,                          -- SHA-256 of the token it replaced (reuse detection)
  rotated_at           timestamptz,
  user_agent           text,
  ip                   inet,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,           -- sliding: now() + REFRESH_TOKEN_TTL_S on each refresh
  absolute_expires_at  timestamptz NOT NULL,           -- created_at + SESSION_ABSOLUTE_TTL_S, never extended
  revoked_at           timestamptz,
  revoked_reason       text,
  CONSTRAINT sessions_hash_len_ck       CHECK (octet_length(refresh_token_hash) = 32),
  CONSTRAINT sessions_prev_hash_len_ck  CHECK (previous_token_hash IS NULL OR octet_length(previous_token_hash) = 32),
  CONSTRAINT sessions_user_agent_len_ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT sessions_expiry_ck         CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT sessions_revoked_ck        CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_revoked_reason_ck CHECK (revoked_reason IS NULL OR
                                               revoked_reason IN ('logout', 'user_revoked', 'token_reuse', 'admin'))
);
CREATE UNIQUE INDEX sessions_refresh_token_hash_uq ON sessions (refresh_token_hash);
CREATE INDEX sessions_previous_token_hash_idx ON sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;
CREATE INDEX sessions_user_active_idx        ON sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx         ON sessions (expires_at);
CREATE INDEX sessions_revoked_at_idx         ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS sessions;
