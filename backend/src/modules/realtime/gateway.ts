/**
 * The `/ws` WebSocket gateway (SPEC section 7.1, section 7.2, section 10.12) on @fastify/websocket (raw `ws`). The upgrade is authorised
 * before the 101 (upgrade-auth.ts). After it, the handshake is the first task of the connection's serial inbound
 * queue: `welcome` (serverTime in epoch ms, limits incl. draftTouchIntervalMs), `presence.snapshot` and
 * `lock.snapshot` are queued first, then presence is registered (`presence.joined` to the others) and `ws.connect` is
 * audited; frames received meanwhile are validated on arrival and handled behind it. A per-connection timer closes
 * the socket with 4401 at the session's absolute expiry; `sessions` bus events and the periodic DB re-validation close
 * revoked sessions with 4401.
 * On close: drafts are marked disconnected, locks released, presence removed, `ws.disconnect` audited with the per-type
 * counts. Shutdown closes every socket with 1001 and awaits that cleanup (locks and presence of this instance removed).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { CLOSE_CODES, LIMITS, REALTIME } from '@snapland/shared';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import type { AppConfig } from '../../config/env.js';
import type { Clock } from '../../infra/clock.js';
import { ServiceUnavailableError } from '../../infra/http/errors.js';
import { rateLimitRoute } from '../../infra/http/rate-limits.js';
import { normalizeIp, normalizeUserAgent } from '../../infra/http/request-context.js';
import type { AppInstance } from '../../infra/http/types.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { ChangeSeqTracker } from './change-seq.js';
import { Connection } from './connection.js';
import type { ConnectionDeps } from './connection.js';
import type { ConnectionRegistry } from './connection-registry.js';
import type { InboundDispatcher } from './dispatch.js';
import type { DraftService } from './drafts.js';
import type { LockService } from './locks.js';
import { criticalMessage } from './messages.js';
import type { PresenceService } from './presence.js';
import type { RealtimeAudit } from './realtime-audit.js';
import { MAX_TIMER_DELAY_MS, unrefTimeout } from './timers.js';
import { authorizeUpgrade } from './upgrade-auth.js';
import type { UpgradeAuthDeps, UpgradeGrant } from './upgrade-auth.js';

export interface GatewayDeps {
  config: ConnectionDeps['config'] &
    UpgradeAuthDeps['config'] &
    Pick<
      AppConfig,
      | 'WS_PING_INTERVAL_MS'
      | 'WS_MAX_PAYLOAD_BYTES'
      | 'DRAW_RATE_LIMIT_MAX'
      | 'DRAW_RATE_LIMIT_WINDOW_MS'
      | 'REALTIME_DRAFT_TOUCH_INTERVAL_MS'
    >;
  instanceId: string;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  upgradeAuth: Omit<UpgradeAuthDeps, 'config' | 'registry' | 'metrics' | 'audit'>;
  registry: ConnectionRegistry;
  dispatcher: InboundDispatcher;
  drafts: DraftService;
  locks: LockService;
  presence: PresenceService;
  changeSeq: ChangeSeqTracker;
  audit: RealtimeAudit;
}

export class RealtimeGateway {
  readonly #deps: GatewayDeps;
  readonly #log: Logger;
  readonly #connectionDeps: ConnectionDeps;
  readonly #upgradeDeps: UpgradeAuthDeps;
  readonly #grants = new WeakMap<IncomingMessage, UpgradeGrant>();
  /** Close cleanups in flight: stop() awaits them before the container closes Redis. */
  readonly #cleanups = new Set<Promise<void>>();
  #shuttingDown = false;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: 'ws-gateway' });
    this.#connectionDeps = {
      config: deps.config,
      clock: deps.clock,
      metrics: deps.metrics,
      logger: deps.logger.child({ component: 'ws' }),
    };
    this.#upgradeDeps = {
      ...deps.upgradeAuth,
      config: deps.config,
      registry: deps.registry,
      metrics: deps.metrics,
      audit: deps.audit,
    };
  }

  /** Registers `GET /ws` (the URL is logged without its query string by the request log). */
  register(app: AppInstance): void {
    app.get(
      REALTIME.wsPath,
      {
        websocket: true,
        config: { rateLimit: rateLimitRoute('ws_upgrade') },
        preValidation: async (request) => {
          // A plain GET /ws (no upgrade) is answered 404 by the websocket plugin; nothing to authorise or consume.
          if (!request.ws) return;
          if (this.#shuttingDown) throw new ServiceUnavailableError('The instance is shutting down.', 1);
          this.#grants.set(request.raw, await authorizeUpgrade(request, this.#upgradeDeps));
        },
      },
      (socket, request) => {
        this.#accept(socket, request);
      },
    );
  }

  /** Closes every socket of a revoked session with 4401 (bus `sessions` event). */
  revokeSession(sessionId: string): void {
    for (const connection of this.#deps.registry.bySession(sessionId)) {
      connection.close(CLOSE_CODES.SESSION_REVOKED, 'session revoked');
    }
  }

  /** Re-validation found the session inactive: 4401 + a coalesced `ws.reject {reason: 'revalidation'}`. */
  closeInactive(connection: Connection): void {
    this.#deps.audit.rejected('revalidation', {
      ip: connection.ip,
      userAgent: connection.userAgent,
      requestId: connection.requestId,
      userId: connection.identity.userId,
      sessionId: connection.identity.sessionId,
    });
    connection.close(CLOSE_CODES.SESSION_REVOKED, 'session revoked');
  }

  /** `resync.required` to every local connection (the bus subscriber reconnected, section 7.10). */
  async broadcastResync(): Promise<void> {
    const latestChangeSeq = await this.#deps.changeSeq.current();
    const message = criticalMessage('resync.required', { reason: 'bus_reconnected', latestChangeSeq });
    for (const connection of this.#deps.registry.values()) connection.send(message);
  }

  /** Graceful shutdown (section 10.12): refuse upgrades, close every socket with 1001 and await the cleanups. */
  async stop(): Promise<void> {
    this.#shuttingDown = true;
    this.#log.info({ connections: this.#deps.registry.size }, 'closing WebSocket connections (1001)');
    for (const connection of [...this.#deps.registry.values()]) {
      connection.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
      this.#onClose(connection, CLOSE_CODES.GOING_AWAY);
    }
    await Promise.allSettled([...this.#cleanups]);
  }

  /** Samples the connection and outbound queue depth gauges (scrape time). */
  sampleQueueDepth(): void {
    let critical = 0;
    let ephemeral = 0;
    for (const connection of this.#deps.registry.values()) {
      const depth = connection.outbound.depth;
      critical += depth.critical;
      ephemeral += depth.ephemeral;
    }
    this.#deps.metrics.wsOutboundQueueDepth.set({ lane: 'critical' }, critical);
    this.#deps.metrics.wsOutboundQueueDepth.set({ lane: 'ephemeral' }, ephemeral);
    this.#deps.metrics.wsConnections.set(this.#deps.registry.size);
  }

  #accept(socket: WebSocket, request: FastifyRequest): void {
    const grant = this.#grants.get(request.raw);
    this.#grants.delete(request.raw);
    if (grant === undefined) {
      // Unreachable through the route (preValidation always grants or rejects); never serve an unauthorised socket.
      socket.close(CLOSE_CODES.INTERNAL_ERROR, 'internal error');
      return;
    }
    if (this.#shuttingDown) {
      // The upgrade was authorised just before stop() ran: stop() already awaited its cleanups, so never register it.
      grant.reservation.release();
      socket.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
      return;
    }
    const connection = new Connection(
      {
        id: randomUUID(),
        socket,
        identity: grant.claims,
        ip: normalizeIp(request.ip),
        userAgent: normalizeUserAgent(request.headers['user-agent']),
        requestId: request.id,
      },
      this.#connectionDeps,
    );
    const { registry, metrics, dispatcher } = this.#deps;
    registry.add(connection, grant.reservation);
    metrics.wsConnectionsTotal.inc({ result: 'accepted' });

    socket.on('message', (data, isBinary) => {
      dispatcher.onFrame(connection, data, isBinary);
    });
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('close', (code) => {
      this.#onClose(connection, code);
    });
    // The plugin's default error handler terminate()s the socket, which would discard the close frame ws already
    // queued for protocol errors (1009 oversize frame, 1007 invalid UTF-8). ws closes the socket itself on errors,
    // so the gateway only logs them; an 'error' listener must stay attached.
    socket.removeAllListeners('error');
    socket.on('error', (error) => {
      connection.log.info({ err: error }, 'WebSocket protocol error');
    });
    this.#armAbsoluteExpiry(connection);
    // The handshake is the first inbound task: every frame that arrives meanwhile is handled after it.
    connection.inbound.push(() =>
      this.#open(connection).catch((error: unknown) => {
        connection.log.error({ err: error }, 'WebSocket handshake failed');
        connection.close(CLOSE_CODES.INTERNAL_ERROR, 'internal error');
      }),
    );
  }

  /** welcome -> presence.snapshot -> lock.snapshot, then presence registration and the ws.connect audit row. */
  async #open(connection: Connection): Promise<void> {
    const { changeSeq, presence, locks, config, clock, instanceId } = this.#deps;
    const [latestChangeSeq, presenceSnapshot, lockItems] = await Promise.all([
      changeSeq.current(),
      presence.snapshot(),
      locks.snapshot(),
    ]);
    if (!connection.isOpen) return;
    const { identity } = connection;
    connection.becomeReady([
      criticalMessage('welcome', {
        connectionId: connection.id,
        instanceId,
        user: { id: identity.userId, displayName: identity.displayName, color: identity.color },
        serverTime: clock.now(),
        latestChangeSeq,
        heartbeatIntervalMs: config.WS_PING_INTERVAL_MS,
        // The same values /api/v1/config publishes (section 7.5).
        limits: {
          maxPayloadBytes: config.WS_MAX_PAYLOAD_BYTES,
          drawActionsPerWindow: config.DRAW_RATE_LIMIT_MAX,
          drawWindowMs: config.DRAW_RATE_LIMIT_WINDOW_MS,
          draftUpdateMinIntervalMs: REALTIME.draftUpdateMinIntervalMs,
          draftTouchIntervalMs: config.REALTIME_DRAFT_TOUCH_INTERVAL_MS,
          maxPositions: LIMITS.maxPositionsTotal,
        },
      }),
      criticalMessage('presence.snapshot', presenceSnapshot),
      criticalMessage('lock.snapshot', { items: lockItems }),
    ]);
    this.#deps.audit.connected(connection);
    await presence.join(connection);
  }

  /** A per-connection timer at the session's absolute expiry (re-armed past Node's 24.8-day timer limit). */
  #armAbsoluteExpiry(connection: Connection): void {
    const expiresAt = Date.parse(connection.identity.absoluteExpiresAt);
    const arm = (): void => {
      const remainingMs = expiresAt - this.#deps.clock.now();
      if (remainingMs <= 0) {
        connection.close(CLOSE_CODES.SESSION_REVOKED, 'session expired');
        return;
      }
      connection.cancelExpiry = unrefTimeout(() => {
        if (remainingMs > MAX_TIMER_DELAY_MS) arm();
        else connection.close(CLOSE_CODES.SESSION_REVOKED, 'session expired');
      }, remainingMs);
    };
    arm();
  }

  #onClose(connection: Connection, code: number): void {
    if (!this.#deps.registry.remove(connection)) return;
    connection.markClosed();
    connection.cancelExpiry?.();
    connection.cancelExpiry = null;
    const finalCode = connection.intendedCloseCode ?? code;
    this.#deps.metrics.wsDisconnectsTotal.inc({ code: String(finalCode) });
    const cleanup = this.#cleanup(connection, finalCode)
      .catch((error: unknown) => {
        connection.log.error({ err: error }, 'WebSocket close cleanup failed');
      })
      .finally(() => {
        this.#cleanups.delete(cleanup);
      });
    this.#cleanups.add(cleanup);
  }

  /** Drafts -> locks -> presence, after the handshake and every queued inbound handler have settled. */
  async #cleanup(connection: Connection, code: number): Promise<void> {
    await connection.inbound.idle();
    await this.#deps.drafts.disconnect(connection);
    await this.#deps.locks.releaseAll(connection);
    await this.#deps.presence.leave(connection);
    this.#deps.audit.disconnected(connection, code, this.#deps.clock.now());
    connection.log.info({ code }, 'WebSocket closed');
  }
}
