-- Up Migration
CREATE TABLE audit_logs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  action       text        NOT NULL,
  outcome      text        NOT NULL,
  actor_id     uuid,                                  -- no FK: audit rows must outlive/ignore user changes
  session_id   uuid,
  target_type  text,
  target_id    text,
  request_id   text,
  instance_id  text        NOT NULL,
  ip           inet,
  user_agent   text,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_logs_outcome_ck      CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT audit_logs_action_ck       CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT audit_logs_target_type_ck  CHECK (target_type IS NULL OR
                                               target_type IN ('area', 'user', 'session', 'ws_connection', 'draft', 'system')),
  -- Size is checked on the JSON text, not pg_column_size: jsonb's binary form of 4 KB of text can exceed 24 KB (measured).
  CONSTRAINT audit_logs_details_size_ck CHECK (octet_length(details::text) <= 8192),
  CONSTRAINT audit_logs_user_agent_ck   CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);
-- Append-only, time-correlated: BRIN is tiny and ideal for time-range scans and retention deletes. autosummarize: new block ranges
-- are summarized by autovacuum as they fill (a BRIN created on an empty table otherwise leaves new ranges unsummarized - every
-- query reads them lossily - until a manual VACUUM).
CREATE INDEX audit_logs_occurred_at_brin ON audit_logs USING brin (occurred_at) WITH (autosummarize = on);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_logs;
