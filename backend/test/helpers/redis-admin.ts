/**
 * Redis server administration for tests (SPEC section 12.2 isolation rule 2). `CLIENT LIST`/`CLIENT KILL` are server-global,
 * so `killClientByName` only ever kills connections whose name contains THIS run's id (it throws otherwise) - e.g.
 * `snapland-sub-<runId>-3` to simulate a subscriber reconnect without touching another run.
 */
import { Redis } from 'ioredis';

import { testRunId } from './test-app.js';

/** Parses `CLIENT LIST` output into `{ id, name }` entries. */
export function parseClientList(list: string): { id: string; name: string }[] {
  return list
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const fields = new Map(line.split(' ').map((pair) => pair.split('=') as [string, string]));
      return { id: fields.get('id') ?? '', name: fields.get('name') ?? '' };
    });
}

export interface RedisAdmin {
  /** Kills every connection named exactly `name`; returns how many were killed. */
  killClientByName(name: string): Promise<number>;
  clientNames(): Promise<string[]>;
  close(): Promise<void>;
}

export function createRedisAdmin(
  url: string = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:56379/1',
): RedisAdmin {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectionName: `snapland-it-admin-${testRunId()}`,
  });
  const runId = testRunId();
  return {
    async killClientByName(name) {
      if (!name.includes(runId)) {
        throw new Error(`refusing to kill ${name}: only connections of run ${runId} may be killed`);
      }
      const clients = parseClientList(String(await client.call('CLIENT', 'LIST')));
      let killed = 0;
      for (const entry of clients.filter((candidate) => candidate.name === name)) {
        killed += Number(await client.call('CLIENT', 'KILL', 'ID', entry.id));
      }
      return killed;
    },
    async clientNames() {
      return parseClientList(String(await client.call('CLIENT', 'LIST'))).map((entry) => entry.name);
    },
    async close() {
      await client.quit();
    },
  };
}
