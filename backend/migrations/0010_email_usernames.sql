-- Decision D-8: a username may also be an email address. The pattern is LIMITS.usernamePattern
-- (packages/shared/src/constants.ts). Uniqueness stays case-insensitive through users_username_lower_uq.
-- The down section restores the handle-only rule. It fails (and changes nothing) while email usernames exist:
-- they would violate the old CHECK, and silently deleting accounts is not an option.

-- Up Migration
ALTER TABLE users DROP CONSTRAINT users_username_format_ck;
ALTER TABLE users ADD CONSTRAINT users_username_format_ck CHECK (
  username ~ '^(?:[A-Za-z0-9_.-]{3,32}|(?=.{6,128}$)[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$'
);

-- Down Migration
ALTER TABLE users DROP CONSTRAINT users_username_format_ck;
ALTER TABLE users ADD CONSTRAINT users_username_format_ck CHECK (username ~ '^[A-Za-z0-9_.-]{3,32}$');
