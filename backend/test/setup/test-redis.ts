/**
 * Redis isolation for integration tests (SPEC section 12.2): every run uses its own key prefix `snaptest<runId>:` on the test
 * database index of both Redis roles; teardown deletes exactly that prefix (SCAN + UNLINK), and prefixes of crashed
 * runs older than STALE_RUN_MS are garbage-collected.
 */
import { Redis } from 'ioredis';

import { STALE_RUN_MS, runIdTimestamp } from './test-database.js';

export const TEST_PREFIX_ROOT = 'snaptest';
const SCAN_COUNT = 1000;

export function testKeyPrefix(runId: string): string {
  return `${TEST_PREFIX_ROOT}${runId}:`;
}

async function withRedis<T>(url: string, fn: (client: Redis) => Promise<T>): Promise<T> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectionName: 'snapland-it-admin',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

async function scanKeys(
  client: Redis,
  match: string,
  onBatch: (keys: string[]) => Promise<void>,
): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', SCAN_COUNT);
    cursor = next;
    if (keys.length > 0) await onBatch(keys);
  } while (cursor !== '0');
}

/** Deletes every key under `prefix`; returns how many were removed. */
export async function deletePrefix(url: string, prefix: string): Promise<number> {
  return withRedis(url, async (client) => {
    let removed = 0;
    await scanKeys(client, `${prefix}*`, async (keys) => {
      removed += await client.unlink(...keys);
    });
    return removed;
  });
}

/** Deletes keys of test runs older than STALE_RUN_MS (crashed runs that never reached their teardown). */
export async function deleteStaleTestPrefixes(url: string, now: number = Date.now()): Promise<number> {
  return withRedis(url, async (client) => {
    let removed = 0;
    await scanKeys(client, `${TEST_PREFIX_ROOT}*`, async (keys) => {
      const stale = keys.filter((key) => {
        const runId = key.slice(TEST_PREFIX_ROOT.length, key.indexOf(':'));
        const timestamp = runIdTimestamp(runId);
        return timestamp !== null && now - timestamp > STALE_RUN_MS;
      });
      if (stale.length > 0) removed += await client.unlink(...stale);
    });
    return removed;
  });
}
