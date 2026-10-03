-- Up Migration
CREATE SEQUENCE area_change_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE areas (
  id               uuid                    PRIMARY KEY,
  name             text                    NOT NULL,
  description      text,
  geom             geometry(Polygon, 4326) NOT NULL,
  area_km2         double precision        NOT NULL,   -- ST_Area(geom::geography) / 1e6 (WGS84 ellipsoid)
  perimeter_km     double precision        NOT NULL,   -- ST_Perimeter(geom::geography) / 1e3
  vertex_count     integer                 NOT NULL,   -- ST_NPoints - ST_NRings (closing positions excluded)
  bbox_extent_deg  double precision        NOT NULL,   -- max(bbox width, bbox height) in degrees, for LOD culling
  version          integer                 NOT NULL DEFAULT 1,
  change_seq       bigint                  NOT NULL,   -- change_seq of the latest mutation
  created_by       uuid                    NOT NULL REFERENCES users (id),
  updated_by       uuid                    NOT NULL REFERENCES users (id),
  created_at       timestamptz             NOT NULL DEFAULT now(),
  updated_at       timestamptz             NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid                    REFERENCES users (id),
  CONSTRAINT areas_name_len_ck           CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT areas_description_len_ck    CHECK (description IS NULL OR char_length(description) <= 2000),
  CONSTRAINT areas_geom_valid_ck         CHECK (ST_IsValid(geom)),
  CONSTRAINT areas_geom_npoints_ck       CHECK (ST_NPoints(geom) <= 2000),
  CONSTRAINT areas_area_range_ck         CHECK (area_km2 >= 0.000001 AND area_km2 <= 100000),
  CONSTRAINT areas_version_ck            CHECK (version >= 1),
  CONSTRAINT areas_deleted_consistency_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

-- Hot path: bbox queries over live areas only.
CREATE INDEX areas_geom_live_gist ON areas USING gist (geom) WHERE deleted_at IS NULL;
-- Retention job: find soft-deleted rows older than N days.
CREATE INDEX areas_deleted_at_idx ON areas (deleted_at) WHERE deleted_at IS NOT NULL;

-- Updates rewrite geometry often: vacuum/analyze earlier than the 20%/10% defaults.
ALTER TABLE areas SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);

-- Down Migration
DROP TABLE IF EXISTS areas;
DROP SEQUENCE IF EXISTS area_change_seq;
