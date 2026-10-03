/**
 * Upgrade authorisation of `/ws` (SPEC section 7.2 steps 1-3), all BEFORE the 101 (plain HTTP problem+json answers), in this
 * order: Origin in CORS_ORIGINS (a missing Origin is rejected too) -> 403; the `snapland.v1` subprotocol -> 400; one-time
 * ticket (GETDEL) -> 401 TOKEN_INVALID; session active (revocation marker + the DB read port) -> 401 SESSION_REVOKED;
 * capacity (instance -> 503, user -> 429). Every rejection is counted and audited as a coalesced `ws.reject`, then thrown
 * to the problem handler. The per-IP `ws_upgrade` rate limit runs earlier (onRequest), so a flood consumes no tickets.
 */
import { REALTIME } from '@snapland/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppConfig } from '../../config/env.js';
import type { SessionRevocationStore } from '../../infra/auth/revocations.js';
import type { WsTicketClaims, WsTicketStore } from '../../infra/auth/ws-tickets.js';
import type { SessionReader } from '../../infra/directory/types.js';
import type { AppError } from '../../infra/http/errors.js';
import {
  DependencyUnavailableError,
  ForbiddenError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../../infra/http/errors.js';
import { normalizeIp, normalizeUserAgent } from '../../infra/http/request-context.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { ConnectionRegistry, Reservation } from './connection-registry.js';
import type { RealtimeAudit, RejectContext, WsRejectReason } from './realtime-audit.js';

export interface UpgradeAuthDeps {
  config: Pick<AppConfig, 'CORS_ORIGINS' | 'WS_MAX_CONNECTIONS_PER_INSTANCE' | 'WS_MAX_CONNECTIONS_PER_USER'>;
  wsTickets: WsTicketStore;
  revocations: SessionRevocationStore;
  sessions: SessionReader;
  registry: ConnectionRegistry;
  metrics: Metrics;
  audit: RealtimeAudit;
}

/** What the checks proved, handed to the upgrade handler. */
export interface UpgradeGrant {
  claims: WsTicketClaims;
  reservation: Reservation;
}

/** The ticket is the only query parameter; its format is checked by the ticket store (43 base64url chars). */
const UpgradeQuerySchema = z.object({ ticket: z.string().min(1).max(128) });

/** A refusal with its audit reason; `authorizeUpgrade` counts and audits it, then throws the AppError. */
class UpgradeRejection extends Error {
  constructor(
    readonly reason: WsRejectReason,
    readonly error: AppError,
  ) {
    super(error.detail);
    this.name = 'UpgradeRejection';
  }
}

export async function authorizeUpgrade(
  request: FastifyRequest,
  deps: UpgradeAuthDeps,
): Promise<UpgradeGrant> {
  const context: RejectContext = {
    ip: normalizeIp(request.ip),
    userAgent: normalizeUserAgent(request.headers['user-agent']),
    requestId: request.id,
  };
  try {
    checkOrigin(request.headers.origin, deps.config.CORS_ORIGINS);
    checkSubprotocol(request.headers['sec-websocket-protocol']);
    const claims = await consumeTicket(request.query, deps.wsTickets);
    context.userId = claims.userId;
    context.sessionId = claims.sessionId;
    await checkSession(claims, deps);
    const reservation = reserve(claims.userId, deps);
    // Returns the slot if the upgrade never completes (aborted handshake); a no-op once the socket is registered.
    request.raw.socket.once('close', () => {
      reservation.release();
    });
    return { claims, reservation };
  } catch (error) {
    if (!(error instanceof UpgradeRejection)) throw error;
    deps.metrics.wsConnectionsTotal.inc({ result: `rejected_${error.reason}` });
    deps.audit.rejected(error.reason, context);
    throw error.error;
  }
}

export function offeredSubprotocols(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== '');
}

function checkOrigin(origin: string | undefined, allowed: readonly string[]): void {
  if (origin === undefined || !allowed.includes(origin)) {
    throw new UpgradeRejection(
      'origin',
      new ForbiddenError('ORIGIN_NOT_ALLOWED', 'The WebSocket Origin is not allowed.'),
    );
  }
}

function checkSubprotocol(header: string | undefined): void {
  if (!offeredSubprotocols(header).includes(REALTIME.subprotocol)) {
    throw new UpgradeRejection(
      'protocol',
      new ValidationError(`The ${REALTIME.subprotocol} WebSocket subprotocol is required.`, [
        {
          path: 'headers.sec-websocket-protocol',
          code: 'SUBPROTOCOL_REQUIRED',
          message: `Request Sec-WebSocket-Protocol: ${REALTIME.subprotocol}.`,
        },
      ]),
    );
  }
}

function invalidTicket(): UpgradeRejection {
  return new UpgradeRejection(
    'ticket',
    new UnauthorizedError('TOKEN_INVALID', 'The WebSocket ticket is missing, expired or already used.'),
  );
}

async function consumeTicket(query: unknown, wsTickets: WsTicketStore): Promise<WsTicketClaims> {
  const parsed = UpgradeQuerySchema.safeParse(query);
  if (!parsed.success) throw invalidTicket();
  let claims: WsTicketClaims | null;
  try {
    claims = await wsTickets.consume(parsed.data.ticket);
  } catch (error) {
    throw new UpgradeRejection(
      'ticket',
      new DependencyUnavailableError('WebSocket tickets are temporarily unavailable.', error),
    );
  }
  if (claims === null) throw invalidTicket();
  return claims;
}

function sessionRevoked(): UpgradeRejection {
  return new UpgradeRejection(
    'session',
    new UnauthorizedError('SESSION_REVOKED', 'The session has been revoked or has expired.'),
  );
}

/** The revocation marker (fail-open) and the authoritative DB read port (section 0 "Active session"). */
async function checkSession(claims: WsTicketClaims, deps: UpgradeAuthDeps): Promise<void> {
  if (await deps.revocations.isRevoked(claims.sessionId)) throw sessionRevoked();
  let active;
  try {
    active = await deps.sessions.getActive(claims.sessionId);
  } catch (error) {
    throw new UpgradeRejection(
      'session',
      new DependencyUnavailableError('Sessions cannot be verified right now.', error),
    );
  }
  if (active?.userId !== claims.userId) throw sessionRevoked();
}

function reserve(userId: string, deps: UpgradeAuthDeps): Reservation {
  const { config, registry } = deps;
  const result = registry.tryReserve(userId, {
    maxPerInstance: config.WS_MAX_CONNECTIONS_PER_INSTANCE,
    maxPerUser: config.WS_MAX_CONNECTIONS_PER_USER,
  });
  if (result.ok) return result.reservation;
  if (result.reason === 'instance_full') {
    throw new UpgradeRejection(
      'capacity',
      new ServiceUnavailableError('This instance has no WebSocket capacity left.', 5),
    );
  }
  throw new UpgradeRejection(
    'capacity',
    new RateLimitedError({
      scope: 'ws_upgrade',
      limit: config.WS_MAX_CONNECTIONS_PER_USER,
      retryAfterMs: 5000,
      detail: `At most ${config.WS_MAX_CONNECTIONS_PER_USER} WebSocket connections per user on this instance.`,
    }),
  );
}
