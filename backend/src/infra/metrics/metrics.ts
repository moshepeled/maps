/**
 * Every Prometheus metric of the backend (SPEC section 10.8), created once per container with its OWN registry - never the
 * prom-client global `register` - so several app instances can live in one process (two-instances test). `/metrics`
 * serves `metrics.registry` after running the scrape-time samplers (pool gauges, Redis memory, queue depths).
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { AppConfig } from '../../config/env.js';
import { withTimeout } from '../timeout.js';

/** A sampler refreshes gauges right before a scrape (e.g. pool counts, `INFO memory`). */
export type ScrapeSampler = () => Promise<void> | void;

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const FANOUT_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];
const DB_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const ROW_BUCKETS = [0, 10, 50, 100, 250, 500, 1000, 1500, 2000];
/** A sampler that takes longer than this is abandoned for the current scrape. */
const SAMPLER_TIMEOUT_MS = 1000;

function buildMetrics(registry: Registry) {
  const registers = [registry];
  return {
    // HTTP
    httpRequestDuration: new Histogram({
      name: 'snapland_http_request_duration_seconds',
      help: 'REST latency by route pattern',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: HTTP_BUCKETS,
      registers,
    }),
    httpRequestsInFlight: new Gauge({
      name: 'snapland_http_requests_in_flight',
      help: 'Concurrent HTTP requests',
      registers,
    }),

    // WebSocket
    wsConnections: new Gauge({
      name: 'snapland_ws_connections',
      help: 'Open WebSocket connections on this instance',
      registers,
    }),
    wsConnectionsTotal: new Counter({
      name: 'snapland_ws_connections_total',
      help: 'WebSocket handshakes by result',
      labelNames: ['result'] as const,
      registers,
    }),
    wsDisconnectsTotal: new Counter({
      name: 'snapland_ws_disconnects_total',
      help: 'WebSocket closes by code',
      labelNames: ['code'] as const,
      registers,
    }),
    wsMessagesReceivedTotal: new Counter({
      name: 'snapland_ws_messages_received_total',
      help: 'Inbound WebSocket messages by type',
      labelNames: ['type'] as const,
      registers,
    }),
    wsMessagesSentTotal: new Counter({
      name: 'snapland_ws_messages_sent_total',
      help: 'Outbound WebSocket messages by type (after batch unwrap)',
      labelNames: ['type'] as const,
      registers,
    }),
    wsMessagesDroppedTotal: new Counter({
      name: 'snapland_ws_messages_dropped_total',
      help: 'Dropped WebSocket messages (coalesced, overflow, throttled, invalid)',
      labelNames: ['type', 'reason'] as const,
      registers,
    }),
    wsSentBytesTotal: new Counter({
      name: 'snapland_ws_sent_bytes_total',
      help: 'Outbound WebSocket bytes',
      registers,
    }),
    wsOutboundQueueDepth: new Gauge({
      name: 'snapland_ws_outbound_queue_depth',
      help: 'Queued outbound messages summed over connections',
      labelNames: ['lane'] as const,
      registers,
    }),
    wsSlowConsumerDisconnectsTotal: new Counter({
      name: 'snapland_ws_slow_consumer_disconnects_total',
      help: 'Connections closed with 1013 (slow consumer)',
      registers,
    }),
    wsFanoutLatency: new Histogram({
      name: 'snapland_ws_fanout_latency_seconds',
      help: 'Bus envelope ts -> local enqueue',
      labelNames: ['channel'] as const,
      buckets: FANOUT_BUCKETS,
      registers,
    }),
    wsRevalidationRunsTotal: new Counter({
      name: 'snapland_ws_revalidation_runs_total',
      help: 'WebSocket session re-validation rounds',
      labelNames: ['result'] as const,
      registers,
    }),
    wsRevalidationClosesTotal: new Counter({
      name: 'snapland_ws_revalidation_closes_total',
      help: 'Sockets closed 4401 by session re-validation (non-zero means bus events were lost)',
      registers,
    }),

    // Bus and presence
    busMessagesTotal: new Counter({
      name: 'snapland_bus_messages_total',
      help: 'Redis pub/sub traffic',
      labelNames: ['channel', 'direction', 'result'] as const,
      registers,
    }),
    presenceOnlineUsers: new Gauge({
      name: 'snapland_presence_online_users',
      help: 'Distinct online users',
      registers,
    }),

    // Rate limiting
    rateLimitRejectionsTotal: new Counter({
      name: 'snapland_rate_limit_rejections_total',
      help: '429s and WebSocket rate-limit errors',
      labelNames: ['scope', 'transport'] as const,
      registers,
    }),
    rateLimiterFallbackTotal: new Counter({
      name: 'snapland_rate_limiter_fallback_total',
      help: 'Draw-limiter decisions taken by the in-process fallback because Redis failed',
      registers,
    }),

    // Bbox cache
    cacheRequestsTotal: new Counter({
      name: 'snapland_cache_requests_total',
      help: 'Cache lookups by outcome',
      labelNames: ['cache', 'outcome'] as const,
      registers,
    }),
    cacheInvalidateFailuresTotal: new Counter({
      name: 'snapland_cache_invalidate_failures_total',
      help: 'Invalidations that could not reach Redis (an epoch bump follows on recovery)',
      registers,
    }),
    cacheEpochResetsTotal: new Counter({
      name: 'snapland_cache_epoch_resets_total',
      help: 'gen:global initialised or bumped',
      labelNames: ['reason'] as const,
      registers,
    }),
    areaBboxPageBudgetCutsTotal: new Counter({
      name: 'snapland_area_bbox_page_budget_cuts_total',
      help: 'Bbox pages shortened by the position budget',
      registers,
    }),

    // PostgreSQL and Redis
    dbQueryDuration: new Histogram({
      name: 'snapland_db_query_duration_seconds',
      help: 'Per-statement latency (NamedSql.name)',
      labelNames: ['query'] as const,
      buckets: DB_BUCKETS,
      registers,
    }),
    dbPoolConnections: new Gauge({
      name: 'snapland_db_pool_connections',
      help: 'pg pool connections by state',
      labelNames: ['state'] as const,
      registers,
    }),
    dbErrorsTotal: new Counter({
      name: 'snapland_db_errors_total',
      help: 'PostgreSQL errors by SQLSTATE or driver code',
      labelNames: ['code'] as const,
      registers,
    }),
    redisCommandErrorsTotal: new Counter({
      name: 'snapland_redis_command_errors_total',
      help: 'Redis failures',
      registers,
    }),
    redisUp: new Gauge({
      name: 'snapland_redis_up',
      help: '1 when the Redis client is ready',
      labelNames: ['client'] as const,
      registers,
    }),
    redisUsedMemoryBytes: new Gauge({
      name: 'snapland_redis_used_memory_bytes',
      help: 'INFO memory used_memory, sampled on scrape',
      labelNames: ['client'] as const,
      registers,
    }),

    // Domain
    clientErrorsTotal: new Counter({
      name: 'snapland_client_errors_total',
      help: 'POST /client-errors reports by kind',
      labelNames: ['kind'] as const,
      registers,
    }),
    areaMutationsTotal: new Counter({
      name: 'snapland_area_mutations_total',
      help: 'Area writes by op and result',
      labelNames: ['op', 'result'] as const,
      registers,
    }),
    areaConflictsTotal: new Counter({
      name: 'snapland_area_conflicts_total',
      help: 'Merge outcomes',
      labelNames: ['resolution'] as const,
      registers,
    }),
    areaBboxQueryRows: new Histogram({
      name: 'snapland_area_bbox_query_rows',
      help: 'Bbox page sizes',
      labelNames: ['zoom_bucket'] as const,
      buckets: ROW_BUCKETS,
      registers,
    }),

    // Audit and retention
    auditQueueDepth: new Gauge({
      name: 'snapland_audit_queue_depth',
      help: 'Pending audit events',
      registers,
    }),
    auditEventsTotal: new Counter({
      name: 'snapland_audit_events_total',
      help: 'Audit events by result (written, rejected = poison rows dropped by the per-row fallback, dropped = queue full, failed = lost at shutdown)',
      labelNames: ['result'] as const,
      registers,
    }),
    auditFlushDuration: new Histogram({
      name: 'snapland_audit_flush_duration_seconds',
      help: 'Audit batch insert latency',
      buckets: DB_BUCKETS,
      registers,
    }),
    retentionPurgedTotal: new Counter({
      name: 'snapland_retention_purged_total',
      help: 'Rows purged by the retention job',
      labelNames: ['entity'] as const,
      registers,
    }),
  };
}

export type MetricSet = ReturnType<typeof buildMetrics>;

export type Metrics = MetricSet & {
  readonly registry: Registry;
  /** Registers a sampler run before each scrape; returns an unregister function. */
  onScrape(name: string, sampler: ScrapeSampler): () => void;
  /** Runs every sampler (each bounded by 1 s; failures are ignored) - called by the /metrics route. */
  sample(): Promise<void>;
};

/**
 * Creates the metric set of one container: a new Registry, default process metrics (event-loop lag, GC, memory) with
 * the `snapland_` prefix and an `instance` default label.
 */
export function createMetrics(config: AppConfig, instanceId: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance: instanceId });
  if (config.METRICS_ENABLED) collectDefaultMetrics({ register: registry, prefix: 'snapland_' });
  const samplers = new Map<string, ScrapeSampler>();
  return {
    ...buildMetrics(registry),
    registry,
    onScrape(name, sampler) {
      samplers.set(name, sampler);
      return () => {
        samplers.delete(name);
      };
    },
    async sample() {
      // Promise.resolve().then(...) also turns a synchronous throw into an ignored rejection.
      await Promise.all(
        [...samplers.values()].map((sampler) =>
          withTimeout(Promise.resolve().then(sampler), SAMPLER_TIMEOUT_MS).catch(() => undefined),
        ),
      );
    },
  };
}
