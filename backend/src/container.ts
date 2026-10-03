/**
 * Composition root (SPEC section 3.3) - the only place that wires implementations. `createContainer` touches no
 * process-global state: every container owns its logger, metric registry, pool, Redis clients and timers, so several
 * app instances can run in one process (cross-instance and two-instance tests).
 *
 * Wiring order: config -> logger -> metrics -> db -> redis -> keys -> events -> limiter / cache / audit (audit wrapped by
 * the request tracker) -> audit coalescer -> access tokens / ws tickets / revocations -> read ports -> drafts. `close()`
 * runs the section 10.12 order and is idempotent.
 */
import type { AppConfig } from './config/env.js';
import { createAccessTokenService } from './infra/auth/access-tokens.js';
import type { AccessTokenService } from './infra/auth/access-tokens.js';
import { createRevocationStore } from './infra/auth/revocations.js';
import type { SessionRevocationStore } from './infra/auth/revocations.js';
import { createWsTicketStore } from './infra/auth/ws-tickets.js';
import type { WsTicketStore } from './infra/auth/ws-tickets.js';
import { BufferedAuditWriter } from './infra/audit/buffered-writer.js';
import { WindowedAuditCoalescer } from './infra/audit/coalescer.js';
import {
  InMemoryRequestAuditTracker,
  createTrackingAuditLogger,
} from './infra/audit/request-audit-tracker.js';
import type { AuditCoalescer, AuditLogger, RequestAuditTracker } from './infra/audit/types.js';
import { RedisAreaQueryCache } from './infra/cache/redis-area-cache.js';
import type { AreaQueryCache } from './infra/cache/types.js';
import { systemClock } from './infra/clock.js';
import type { Clock } from './infra/clock.js';
import { createDb, createPool } from './infra/db/pool.js';
import type { Db } from './infra/db/types.js';
import { createAreaReader, createSessionReader, createUserDirectory } from './infra/directory/directory.js';
import type { AreaReader, SessionReader, UserDirectory } from './infra/directory/types.js';
import { RedisDraftRegistry } from './infra/drafts/redis-draft-registry.js';
import type { DraftRegistry } from './infra/drafts/types.js';
import { RedisEventBus } from './infra/events/redis-event-bus.js';
import type { EventBus } from './infra/events/types.js';
import { idempotent } from './infra/lifecycle.js';
import type { Lifecycle } from './infra/lifecycle.js';
import { createLogger } from './infra/logger.js';
import type { Logger } from './infra/logger.js';
import { createMetrics } from './infra/metrics/metrics.js';
import type { Metrics } from './infra/metrics/metrics.js';
import { RedisDrawRateLimiter } from './infra/ratelimit/redis-draw-limiter.js';
import type { DrawRateLimiter } from './infra/ratelimit/types.js';
import { closeRedisClients, createRedisClients } from './infra/redis/client.js';
import type { RedisClients } from './infra/redis/client.js';
import { createRedisKeys } from './infra/redis/keys.js';
import type { RedisKeys } from './infra/redis/keys.js';

export interface Container {
  /** Validated env (section 11.3). */
  readonly config: AppConfig;
  /** pino root logger (child per module). */
  readonly logger: Logger;
  /** `{ now(): number }` epoch ms. */
  readonly clock: Clock;
  readonly db: Db;
  /** `{ cmd, sub, cache | null }` (cache = CACHE_REDIS_URL, section 10.2). */
  readonly redis: RedisClients;
  /** Key/channel builders with the prefix. */
  readonly keys: RedisKeys;
  /** Every metric (section 10.8) + its own prom-client Registry. */
  readonly metrics: Metrics;
  readonly events: EventBus;
  readonly drawRateLimiter: DrawRateLimiter;
  readonly areaCache: AreaQueryCache;
  /** Tracking wrapper: marks requestIds for the audit hook (section 10.4). */
  readonly audit: AuditLogger;
  /** ratelimit.hit, ws.reject, lock/draft denials (section 10.4). */
  readonly auditCoalescer: AuditCoalescer;
  /** Which requests were audited by their service (read by the generic onResponse audit hook). */
  readonly auditTracker: RequestAuditTracker;
  readonly accessTokens: AccessTokenService;
  readonly wsTickets: WsTicketStore;
  readonly revocations: SessionRevocationStore;
  /** Read port (infra/directory) - realtime, health of sockets. */
  readonly sessions: SessionReader;
  /** Read port (infra/directory) - presence/lock profiles, requireRole. */
  readonly users: UserDirectory;
  /** Read port (infra/directory) - lock bbox, welcome.latestChangeSeq. */
  readonly areasReader: AreaReader;
  /** infra/drafts - draft ownership (realtime writes, areas reads). */
  readonly drafts: DraftRegistry;
  readonly instanceId: string;
  /** Stops every Lifecycle component in section 10.12 order (audit flush, cache timers, bus, Redis, pool). Idempotent. */
  close(): Promise<void>;
}

/** Test overrides: in-memory doubles for the components whose decisions or events a test asserts on. */
export type ContainerOverrides = Partial<Pick<Container, 'events' | 'drawRateLimiter' | 'audit' | 'logger'>>;

/** Closes a component, logging (never propagating) its failure so the remaining steps still run. */
async function closeQuietly(label: string, component: Lifecycle, logger: Logger): Promise<void> {
  try {
    await component.close?.();
  } catch (error) {
    logger.error({ err: error, component: label }, 'close failed');
  }
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config);
  const clock = systemClock;
  const instanceId = config.INSTANCE_ID;
  const metrics = createMetrics(config, instanceId);

  const pool = createPool(config, instanceId);
  const db = createDb({ pool, metrics, logger });
  const redis = createRedisClients({ config, instanceId, logger, metrics });
  const keys = createRedisKeys(config.REDIS_KEY_PREFIX);
  const events: EventBus & Lifecycle =
    overrides.events ?? new RedisEventBus({ instanceId, clock, logger, metrics, redis, keys });

  const drawRateLimiter =
    overrides.drawRateLimiter ??
    new RedisDrawRateLimiter({
      redis: redis.cmd,
      keys,
      clock,
      logger,
      metrics,
      limit: config.DRAW_RATE_LIMIT_MAX,
      windowMs: config.DRAW_RATE_LIMIT_WINDOW_MS,
    });
  const areaCache = new RedisAreaQueryCache({
    cmd: redis.cmd,
    cache: redis.cache,
    keys,
    metrics,
    logger,
    clock,
    enabled: config.CACHE_ENABLED,
    l1MaxEntries: config.CACHE_L1_MAX_ENTRIES,
    l1TtlMs: config.CACHE_L1_TTL_MS,
    l1MaxEntryBytes: config.CACHE_L1_MAX_ENTRY_BYTES,
    l2TtlS: config.CACHE_BBOX_TTL_S,
    l2MaxBodyBytes: config.CACHE_L2_MAX_BODY_BYTES,
  });
  // An override may be a plain test double without lifecycle methods; Lifecycle members are optional, so both fit.
  const rawAudit: AuditLogger & Lifecycle =
    overrides.audit ??
    new BufferedAuditWriter({
      db,
      logger,
      metrics,
      clock,
      instanceId,
      queueMax: config.AUDIT_QUEUE_MAX,
      batchSize: config.AUDIT_BATCH_SIZE,
      flushIntervalMs: config.AUDIT_FLUSH_INTERVAL_MS,
    });
  areaCache.start();
  rawAudit.start?.();

  const auditTracker = new InMemoryRequestAuditTracker(clock);
  const audit = createTrackingAuditLogger(rawAudit, auditTracker);
  const auditCoalescer = new WindowedAuditCoalescer({ sink: audit, clock });
  auditCoalescer.start();

  const accessTokens = createAccessTokenService({
    secret: config.JWT_SECRET,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    ttlS: config.ACCESS_TOKEN_TTL_S,
    clock,
  });
  const wsTickets = createWsTicketStore({ redis, keys, clock, ttlS: config.WS_TICKET_TTL_S });
  const revocations = createRevocationStore({ redis, keys, clock, logger, ttlS: config.ACCESS_TOKEN_TTL_S });

  const sessions = createSessionReader(db);
  const users = createUserDirectory(db);
  const areasReader = createAreaReader(db);
  const drafts = new RedisDraftRegistry({
    redis,
    keys,
    clock,
    logger,
    resumeWindowS: config.REALTIME_DRAFT_RESUME_WINDOW_S,
  });

  const close = idempotent(async () => {
    await closeQuietly('auditCoalescer', auditCoalescer, logger);
    await closeQuietly('audit', rawAudit, logger);
    await closeQuietly('areaCache', areaCache, logger);
    await closeQuietly('events', events, logger);
    await closeRedisClients(redis);
    try {
      await pool.end();
    } catch (error) {
      logger.error({ err: error }, 'closing the PostgreSQL pool failed');
    }
  });

  return {
    config,
    logger,
    clock,
    db,
    redis,
    keys,
    metrics,
    events,
    drawRateLimiter,
    areaCache,
    audit,
    auditCoalescer,
    auditTracker,
    accessTokens,
    wsTickets,
    revocations,
    sessions,
    users,
    areasReader,
    drafts,
    instanceId,
    close,
  };
}
