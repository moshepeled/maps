import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectionName } from '../../../src/infra/redis/client.js';
import { createRedisAdmin } from '../../helpers/redis-admin.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';

let first: TestApp;
let second: TestApp;

beforeAll(async () => {
  first = await createTestApp();
  second = await createTestApp();
});

afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
});

describe('two app instances in one process (section 3.3, R40/R41)', () => {
  it('keep separate metric registries', async () => {
    await first.app.inject({ method: 'GET', url: '/api/v1/config' });
    await first.app.inject({ method: 'GET', url: '/api/v1/config' });
    await second.app.inject({ method: 'GET', url: '/api/v1/config' });
    const scrape = async (testApp: TestApp) =>
      (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    const [a, b] = await Promise.all([scrape(first), scrape(second)]);
    const configCount = (body: string) =>
      /snapland_http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/config"[^}]*\} (\d+)/.exec(
        body,
      )?.[1];
    expect(configCount(a)).toBe('2');
    expect(configCount(b)).toBe('1');
    expect(a).toContain(`instance="${first.container.instanceId}"`);
    expect(a).not.toContain(`instance="${second.container.instanceId}"`);
    expect(first.container.metrics.registry).not.toBe(second.container.metrics.registry);
  });

  it('own distinctly named Redis connections, and close both cleanly', async () => {
    const admin = createRedisAdmin();
    try {
      const names = await admin.clientNames();
      for (const testApp of [first, second]) {
        expect(names).toContain(connectionName('cmd', testApp.container.instanceId));
        expect(names).toContain(connectionName('sub', testApp.container.instanceId));
      }
      await Promise.all([first.close(), second.close()]);
      const after = await admin.clientNames();
      expect(after).not.toContain(connectionName('cmd', first.container.instanceId));
      expect(after).not.toContain(connectionName('cmd', second.container.instanceId));
    } finally {
      await admin.close();
    }
  });
});
