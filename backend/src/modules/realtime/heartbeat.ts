/**
 * Server heartbeat (SPEC section 7.11): a protocol-level ping to every connection every WS_PING_INTERVAL_MS; a connection that
 * did not answer the previous ping with a pong is `terminate()`d (no close frame - a dead peer would never answer it).
 */
import type { Logger } from '../../infra/logger.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { repeat } from './timers.js';
import type { Cancel } from './timers.js';

export function startHeartbeat(registry: ConnectionRegistry, intervalMs: number, logger: Logger): Cancel {
  return repeat(
    () => intervalMs,
    () => {
      for (const connection of registry.values()) {
        if (!connection.alive) {
          connection.log.info('WebSocket heartbeat timeout; terminating');
          connection.terminate();
          continue;
        }
        connection.alive = false;
        try {
          connection.socket.ping();
        } catch (error) {
          // ping() throws only when the socket is not open; its close event does the cleanup.
          logger.debug({ err: error, connectionId: connection.id }, 'ping on a closing socket');
        }
      }
    },
    (error) => {
      logger.error({ err: error }, 'heartbeat failed');
    },
  );
}
