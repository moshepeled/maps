-- Query statistics for EXPLAIN/benchmark evidence (SPEC section 11.1). The library is preloaded via
-- `-c shared_preload_libraries=pg_stat_statements` on the postgres command line.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
