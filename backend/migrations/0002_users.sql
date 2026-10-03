-- Up Migration
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text        NOT NULL,
  display_name   text        NOT NULL,
  password_hash  text        NOT NULL,                 -- argon2id PHC string
  color          text        NOT NULL,                 -- presence/draft colour, from a fixed palette
  role           text        NOT NULL DEFAULT 'user',   -- 'admin' only via backend/src/scripts/user-admin.ts (never registration)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,
  CONSTRAINT users_username_format_ck  CHECK (username ~ '^[A-Za-z0-9_.-]{3,32}$'),
  CONSTRAINT users_display_name_len_ck CHECK (char_length(display_name) BETWEEN 1 AND 64),
  CONSTRAINT users_color_ck            CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT users_role_ck             CHECK (role IN ('user', 'admin'))
);
CREATE UNIQUE INDEX users_username_lower_uq ON users (lower(username));

-- Down Migration
DROP TABLE IF EXISTS users;
