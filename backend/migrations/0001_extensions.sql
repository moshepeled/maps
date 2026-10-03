-- Up Migration
CREATE EXTENSION IF NOT EXISTS postgis;

-- Down Migration
-- Intentionally a no-op: the postgis/postgis image pre-installs postgis in the default database together with
-- postgis_topology and postgis_tiger_geocoder, which depend on it (verified: DROP EXTENSION postgis fails there).
-- Dropping it with CASCADE would destroy objects this project does not own.
SELECT 1;
