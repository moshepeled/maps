/**
 * Realtime module (SPEC section 7): the `/ws` gateway (snapland.v1 on raw `ws`), presence, drafts, soft locks, cross-instance
 * fan-out, heartbeat, session re-validation and `GET /api/v1/presence`. This file is the module's composition root:
 * it wires the components from the container's ports (no SQL anywhere in the module - sessions, profiles, bboxes and
 * the latest change seq come from the read ports and the ticket claims; draft ownership from `container.drafts`).
 *
 * Lifecycle: `register` adds the routes; `start` subscribes to the bus and starts the heartbeat, re-validation and
 * presence loops; `stop` (graceful shutdown, section 10.12) stops the timers, closes every socket with 1001 and waits until
 * this instance's drafts, locks and presence entries are cleaned up, before the container closes Redis.
 */
import { runDetached } from '../../infra/lifecycle.js';
import type { AppModule, ModuleFactory } from '../types.js';
import { ChangeSeqTracker } from './change-seq.js';
import { ConnectionRegistry } from './connection-registry.js';
import { InboundDispatcher } from './dispatch.js';
import { DraftService } from './drafts.js';
import { Fanout } from './fanout.js';
import { RealtimeGateway } from './gateway.js';
import { startHeartbeat } from './heartbeat.js';
import { LockStore } from './lock-store.js';
import { LockService } from './locks.js';
import { PresenceStore } from './presence-store.js';
import { PresenceService } from './presence.js';
import { registerPresenceRoutes } from './presence.routes.js';
import { PROTOCOL_LIMITS } from './protocol-limits.js';
import { RealtimeAudit } from './realtime-audit.js';
import { SessionRevalidator } from './session-revalidation.js';
import type { Cancel } from './timers.js';

export const createRealtimeModule: ModuleFactory = (container): AppModule => {
  const { config, clock, metrics, events, instanceId } = container;
  const logger = container.logger.child({ module: 'realtime' });

  const registry = new ConnectionRegistry();
  const audit = new RealtimeAudit(container.audit, container.auditCoalescer, instanceId);
  const changeSeq = new ChangeSeqTracker(container.areasReader, logger, clock);
  const presence = new PresenceService({
    store: new PresenceStore(container.redis.cmd, container.keys, instanceId),
    events,
    registry,
    clock,
    logger,
    metrics,
    config,
  });
  const onStatusChanged = presence.changed.bind(presence);
  const drafts = new DraftService({
    registry: container.drafts,
    limiter: container.drawRateLimiter,
    events,
    clock,
    logger,
    metrics,
    config,
    audit,
    instanceId,
    onStatusChanged,
  });
  const locks = new LockService({
    store: new LockStore(container.redis.cmd, container.keys),
    areasReader: container.areasReader,
    events,
    clock,
    logger,
    config,
    audit,
    instanceId,
    onStatusChanged,
  });
  const dispatcher = new InboundDispatcher({ drafts, locks, presence, clock, metrics });
  const gateway = new RealtimeGateway({
    config,
    instanceId,
    clock,
    logger,
    metrics,
    upgradeAuth: {
      wsTickets: container.wsTickets,
      revocations: container.revocations,
      sessions: container.sessions,
    },
    registry,
    dispatcher,
    drafts,
    locks,
    presence,
    changeSeq,
    audit,
  });
  const revalidator = new SessionRevalidator({
    sessions: container.sessions,
    registry,
    intervalMs: config.REALTIME_SESSION_REVALIDATE_MS,
    jitter: PROTOCOL_LIMITS.revalidationJitter,
    batchSize: PROTOCOL_LIMITS.revalidationBatchSize,
    random: Math.random,
    logger,
    metrics,
    onInactive: (connection) => {
      gateway.closeInactive(connection);
    },
  });
  const fanout = new Fanout({
    events,
    registry,
    changeSeq,
    clock,
    metrics,
    logger,
    onSessionRevoked: (sessionId) => {
      gateway.revokeSession(sessionId);
    },
    onBusReconnect: () => {
      runDetached(gateway.broadcastResync(), logger, 'ws.resync');
      runDetached(revalidator.runNow(), logger, 'ws.revalidation');
    },
  });

  /** The heartbeat and the queue-depth sampler, stopped first on shutdown. */
  const stops: Cancel[] = [];
  return {
    name: 'realtime',
    register: (app) => {
      gateway.register(app);
      registerPresenceRoutes(app, presence);
      return Promise.resolve();
    },
    start: () => {
      fanout.start();
      revalidator.start();
      presence.start();
      stops.push(
        startHeartbeat(registry, config.WS_PING_INTERVAL_MS, logger),
        metrics.onScrape('realtime', () => {
          gateway.sampleQueueDepth();
        }),
      );
      return Promise.resolve();
    },
    stop: async () => {
      for (const stop of stops.splice(0)) stop();
      revalidator.stop();
      presence.stop();
      await gateway.stop();
      fanout.stop();
    },
  };
};
