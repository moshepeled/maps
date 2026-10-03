-- Up Migration
CREATE TABLE area_versions (
  area_id         uuid                    NOT NULL REFERENCES areas (id) ON DELETE CASCADE,
  version         integer                 NOT NULL,
  op              text                    NOT NULL,
  name            text                    NOT NULL,
  description     text,
  geom            geometry(Polygon, 4326) NOT NULL,
  area_km2        double precision        NOT NULL,
  perimeter_km    double precision        NOT NULL,
  vertex_count    integer                 NOT NULL,
  changed_fields  text[]                  NOT NULL,   -- subset of {name, description, geometry, deleted}
  merged          boolean                 NOT NULL DEFAULT false,
  base_version    integer,                            -- client's base version for updates (audit of merges)
  reverted_from   integer,                            -- set when the update restores the content of an older version
  change_seq      bigint                  NOT NULL,
  -- No ON DELETE action: users are never deleted (only disabled, section 6.2). An `ON DELETE SET NULL` could never fire anyway - the
  -- referential action runs as an UPDATE, which the immutability trigger below rejects (verified by QA on postgis 17-3.5).
  actor_id        uuid                    REFERENCES users (id),
  request_id      text,
  created_at      timestamptz             NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, version),
  CONSTRAINT area_versions_op_ck             CHECK (op IN ('create', 'update', 'delete', 'restore')),
  CONSTRAINT area_versions_changed_fields_ck CHECK (changed_fields <@ ARRAY['name', 'description', 'geometry', 'deleted']::text[])
);
-- Change feed: GET /areas/changes?since=N scans by change_seq.
CREATE UNIQUE INDEX area_versions_change_seq_uq ON area_versions (change_seq);

-- History is append-only: updates are rejected; deletes happen only via ON DELETE CASCADE from the retention purge.
CREATE FUNCTION area_versions_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'area_versions rows are immutable' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER area_versions_immutable BEFORE UPDATE ON area_versions
  FOR EACH ROW EXECUTE FUNCTION area_versions_reject_update();

-- Down Migration
DROP TABLE IF EXISTS area_versions;
DROP FUNCTION IF EXISTS area_versions_reject_update();
