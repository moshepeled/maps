/**
 * ioredis clients of one instance (SPEC section 3.3, section 10.2): `cmd` for commands (critical Redis, fail fast: no offline
 * queue, command timeout), `sub` for pub/sub (queues SUBSCRIBE until connected, resubscribes after reconnects) and
 * `cache` for the L2 bodies (separate allkeys-lru Redis; null when CACHE_REDIS_URL is empty). Connection names are
 * `snapland-<role>-<instanceId>` so tests can `CLIENT KILL` exactly this instance's connections.
 */
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

import type { AppConfig } from '../../config/env.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import { withTimeout } from '../timeout.js';

export interface RedisClients {
  readonly cmd: Redis;
  readonly sub: Redis;
  readonly cache: Redis | null;
}

export type RedisRole = 'cmd' | 'sub' | 'cache';

const CONNECT_TIMEOUT_MS = 3000;
const QUIT_TIMEOUT_MS = 1000;
/** Connection errors repeat on every retry; log at most once per client per window. */
const ERROR_LOG_INTERVAL_MS = 10_000;

export function connectionName(role: RedisRole, instanceId: string): string {
  return `snapland-${role}-${instanceId}`;
}

function baseOptions(config: AppConfig): RedisOptions {
  return {
    commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
  };
}

interface ClientDeps {
  config: AppConfig;
  instanceId: string;
  logger: Logger;
  metrics: Metrics;
}

/** Clients being shut down on purpose: their connection errors are expected and not worth a warning. */
const closing = new WeakSet<Redis>();

function observe(client: Redis, role: RedisRole, { logger, metrics }: ClientDeps): void {
  let lastErrorLogAt = 0;
  metrics.redisUp.set({ client: role }, 0);
  client.on('ready', () => {
    metrics.redisUp.set({ client: role }, 1);
    logger.info({ redisClient: role }, 'Redis client ready');
  });
  client.on('close', () => {
    metrics.redisUp.set({ client: role }, 0);
  });
  client.on('error', (error: Error) => {
    metrics.redisCommandErrorsTotal.inc();
    const now = Date.now();
    if (!closing.has(client) && now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = now;
      logger.warn({ redisClient: role, err: error }, 'Redis client error (degraded until it reconnects)');
    }
  });
}

/** Parses `used_memory:<bytes>` out of an `INFO memory` reply. */
export function parseUsedMemory(info: string): number | null {
  const match = /^used_memory:(\d+)\s*$/m.exec(info);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function createRedisClients(deps: ClientDeps): RedisClients {
  const { config, instanceId, metrics } = deps;
  const base = baseOptions(config);
  const cmd = new Redis(config.REDIS_URL, { ...base, connectionName: connectionName('cmd', instanceId) });
  // The subscriber is not latency-critical: SUBSCRIBE may wait for the connection instead of failing.
  const sub = new Redis(config.REDIS_URL, {
    ...base,
    enableOfflineQueue: true,
    commandTimeout: undefined,
    maxRetriesPerRequest: null,
    connectionName: connectionName('sub', instanceId),
  });
  const cache =
    config.CACHE_REDIS_URL === null
      ? null
      : new Redis(config.CACHE_REDIS_URL, { ...base, connectionName: connectionName('cache', instanceId) });

  observe(cmd, 'cmd', deps);
  observe(sub, 'sub', deps);
  if (cache !== null) observe(cache, 'cache', deps);

  metrics.onScrape('redisMemory', async () => {
    for (const [role, client] of [
      ['cmd', cmd],
      ['cache', cache],
    ] as const) {
      if (client?.status !== 'ready') continue;
      const used = parseUsedMemory(await client.info('memory'));
      if (used !== null) metrics.redisUsedMemoryBytes.set({ client: role }, used);
    }
  });
  return { cmd, sub, cache };
}

/**
 * Waits until every client is ready (bounded). Commands fail fast while a client is still connecting (no offline
 * queue), so the process waits briefly before serving; after the timeout it starts degraded instead of failing.
 * Resolves true when all clients became ready in time.
 */
export function waitUntilReady(clients: RedisClients, timeoutMs: number): Promise<boolean> {
  const pending = [clients.cmd, clients.sub, clients.cache].filter(
    (c): c is Redis => c !== null && c.status !== 'ready',
  );
  const ready = Promise.all(
    pending.map(
      (client) =>
        new Promise<void>((resolve) => {
          client.once('ready', () => {
            resolve();
          });
        }),
    ),
  );
  return withTimeout(ready, timeoutMs).then(
    () => true,
    () => false,
  );
}

/** Closes one client gracefully (QUIT), falling back to an immediate disconnect when Redis does not answer. */
async function closeClient(client: Redis): Promise<void> {
  closing.add(client);
  if (client.status === 'end') return;
  if (client.status === 'ready') await withTimeout(client.quit(), QUIT_TIMEOUT_MS).catch(() => undefined);
  client.disconnect();
}

export async function closeRedisClients(clients: RedisClients): Promise<void> {
  await Promise.all(
    [clients.cmd, clients.sub, clients.cache].filter((c): c is Redis => c !== null).map(closeClient),
  );
}
