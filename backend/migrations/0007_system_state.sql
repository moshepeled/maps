-- Up Migration
CREATE TABLE system_state (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Highest change_seq whose versions were purged by retention; change-feed requests with since < watermark get 410.
INSERT INTO system_state (key, value) VALUES
  ('change_feed_purge_watermark', '0'::jsonb),
  ('retention_last_run', 'null'::jsonb);

-- Down Migration
DROP TABLE IF EXISTS system_state;
