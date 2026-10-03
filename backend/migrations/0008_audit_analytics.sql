-- Up Migration
CREATE VIEW audit_actions_hourly AS
  SELECT date_trunc('hour', occurred_at) AS hour, action, outcome, count(*)::bigint AS events,
         count(DISTINCT actor_id)::bigint AS actors
  FROM audit_logs GROUP BY 1, 2, 3;

CREATE VIEW audit_editor_activity_daily AS
  SELECT date_trunc('day', occurred_at) AS day, actor_id,
         count(*) FILTER (WHERE action = 'area.create' AND outcome = 'success')::bigint AS creates,
         count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success')::bigint AS updates,
         count(*) FILTER (WHERE action IN ('area.delete', 'area.restore') AND outcome = 'success')::bigint AS deletes_restores
  FROM audit_logs WHERE actor_id IS NOT NULL AND action LIKE 'area.%' GROUP BY 1, 2;

CREATE VIEW audit_conflict_rate_daily AS
  SELECT date_trunc('day', occurred_at) AS day,
         count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success')::bigint AS updates,
         count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success' AND details ->> 'merged' = 'true')::bigint AS merged,
         count(*) FILTER (WHERE action = 'area.conflict')::bigint AS conflicts
  FROM audit_logs WHERE action IN ('area.update', 'area.conflict') GROUP BY 1;

CREATE VIEW audit_rate_limit_hits_daily AS
  SELECT date_trunc('day', occurred_at) AS day, details ->> 'scope' AS scope, actor_id,
         sum(COALESCE((details ->> 'count')::bigint, 1))::bigint AS hits
  FROM audit_logs WHERE action = 'ratelimit.hit' GROUP BY 1, 2, 3;

-- Down Migration
DROP VIEW IF EXISTS audit_rate_limit_hits_daily;
DROP VIEW IF EXISTS audit_conflict_rate_daily;
DROP VIEW IF EXISTS audit_editor_activity_daily;
DROP VIEW IF EXISTS audit_actions_hourly;
