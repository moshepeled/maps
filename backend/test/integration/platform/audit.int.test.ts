/**
 * BufferedAuditWriter against the real PostgreSQL (SPEC section 10.4): the production writer stores batches <= 500 with one
 * unnest INSERT, flushes on its interval, keeps events through a PostgreSQL outage (TCP proxy paused, the shared
 * service untouched), isolates a poison row, drops the newest event when full and flushes on shutdown.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuditAction, AuditEvent } from '../../../src/infra/audit/types.js';
import { sql } from '../../../src/infra/db/types.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';
import { metricValue } from './support/metrics.js';

interface AuditRow {
  occurred_at: Date;
  action: string;
  outcome: string;
  actor_id: string | null;
  session_id: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  instance_id: string;
  ip: string | null;
  user_agent: string | null;
  details: Record<string, unknown>;
}

/** Rows of one test, identified by a marker in `request_id` (`<marker>:<n>`). */
const ROWS_BY_MARKER = sql(
  'platformAudit.rowsByMarker',
  `SELECT occurred_at, action, outcome, actor_id, session_id, target_type, target_id, request_id, instance_id,
          host(ip) AS ip, user_agent, details
   FROM audit_logs WHERE request_id LIKE $1 || ':%' ORDER BY id`,
);

let reader: TestApp;

beforeAll(async () => {
  reader = await createTestApp({ modules: [] });
});

afterAll(async () => {
  await reader.close();
});

function rowsOf(marker: string): Promise<AuditRow[]> {
  return reader.container.db.query<AuditRow>(ROWS_BY_MARKER, [marker]);
}

function event(marker: string, index: number, action: AuditAction = 'area.create'): AuditEvent {
  return {
    action,
    outcome: 'success',
    targetType: 'area',
    targetId: `t-${index}`,
    requestId: `${marker}:${index}`,
  };
}

describe('BufferedAuditWriter with PostgreSQL (section 10.4)', () => {
  it('is the production writer and stores every column as recorded', async () => {
    const app = await createTestApp({ modules: [] });
    try {
      const marker = randomUUID();
      const actorId = randomUUID();
      const sessionId = randomUUID();
      const occurredAt = new Date('2026-09-20T08:30:00.123Z');
      app.container.audit.record({
        action: 'area.update',
        outcome: 'failure',
        actorId,
        sessionId,
        targetType: 'area',
        targetId: 'area-1',
        requestId: `${marker}:1`,
        ip: '2001:db8::7',
        userAgent: `Mozilla/5.0 ${'x'.repeat(600)}`,
        details: { code: 'VERSION_CONFLICT', status: 409, nested: { ok: true } },
        occurredAt,
      });
      await app.container.audit.flush();
      const [row] = await rowsOf(marker);
      expect(row).toEqual({
        occurred_at: occurredAt,
        action: 'area.update',
        outcome: 'failure',
        actor_id: actorId,
        session_id: sessionId,
        target_type: 'area',
        target_id: 'area-1',
        request_id: `${marker}:1`,
        instance_id: app.container.instanceId,
        ip: '2001:db8::7',
        user_agent: `Mozilla/5.0 ${'x'.repeat(512 - 'Mozilla/5.0 '.length)}`,
        details: { code: 'VERSION_CONFLICT', status: 409, nested: { ok: true } },
      });
    } finally {
      await app.close();
    }
  });

  it('writes batches of at most 500 rows with one INSERT each', async () => {
    const app = await createTestApp({ modules: [], config: { AUDIT_FLUSH_INTERVAL_MS: 600_000 } });
    const query = vi.spyOn(app.container.db, 'query');
    try {
      const marker = randomUUID();
      for (let i = 0; i < 1200; i += 1) app.container.audit.record(event(marker, i));
      await app.container.audit.flush();
      const batches = query.mock.calls
        .filter(([statement]) => statement.name === 'audit.insertBatch')
        .map(([, params]) => ((params?.[0] ?? []) as unknown[]).length);
      expect(batches.reduce((sum, size) => sum + size, 0)).toBe(1200);
      expect(Math.max(...batches)).toBe(500);
      expect(batches).toHaveLength(3);
      expect(await rowsOf(marker)).toHaveLength(1200);
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'written' })).toBe(1200);
    } finally {
      query.mockRestore();
      await app.close();
    }
  });

  it('flushes a partial batch on the interval without an explicit flush', async () => {
    const app = await createTestApp({ modules: [], config: { AUDIT_FLUSH_INTERVAL_MS: 200 } });
    try {
      const marker = randomUUID();
      app.container.audit.record(event(marker, 1));
      app.container.audit.record(event(marker, 2));
      await waitFor(async () => (await rowsOf(marker)).length === 2, {
        timeoutMs: 5000,
        description: 'interval flush',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps events queued while PostgreSQL is unreachable and writes them after it returns', async () => {
    const proxy = await createTcpProxy(reader.config.DATABASE_URL);
    const app = await createTestApp({
      modules: [],
      config: { DATABASE_URL: proxy.url, AUDIT_FLUSH_INTERVAL_MS: 100 },
    });
    try {
      const marker = randomUUID();
      proxy.pause();
      for (let i = 0; i < 3; i += 1) app.container.audit.record(event(marker, i));
      await app.container.audit.flush();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await metricValue(app.container.metrics.auditQueueDepth)).toBe(3);
      expect(await rowsOf(marker)).toHaveLength(0);
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'rejected' })).toBe(0);

      proxy.resume();
      await waitFor(async () => (await rowsOf(marker)).length === 3, {
        timeoutMs: 15_000,
        description: 'queued events written after the outage',
      });
      expect(await metricValue(app.container.metrics.auditQueueDepth)).toBe(0);
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'dropped' })).toBe(0);
    } finally {
      await app.close();
      await proxy.close();
    }
  });

  it('isolates a poison row: the others are written, one is counted as rejected', async () => {
    const app = await createTestApp({ modules: [], config: { AUDIT_FLUSH_INTERVAL_MS: 600_000 } });
    try {
      const marker = randomUUID();
      for (let i = 0; i < 6; i += 1) {
        // A value the normalisation cannot catch: the audit_logs_action_ck CHECK rejects it (SQLSTATE 23514).
        app.container.audit.record(
          event(marker, i, i === 3 ? ('Not An Action' as string as AuditAction) : 'area.create'),
        );
      }
      await app.container.audit.flush();
      const rows = await rowsOf(marker);
      expect(rows.map((row) => row.target_id)).toEqual(['t-0', 't-1', 't-2', 't-4', 't-5']);
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'rejected' })).toBe(1);
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'written' })).toBe(5);
      const rejection = app.logs.find((line) => line['constraint'] === 'audit_logs_action_ck');
      expect(rejection).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('drops the NEWEST events when the queue is full and counts them', async () => {
    const app = await createTestApp({
      modules: [],
      config: { AUDIT_QUEUE_MAX: 5, AUDIT_BATCH_SIZE: 500, AUDIT_FLUSH_INTERVAL_MS: 600_000 },
    });
    try {
      const marker = randomUUID();
      for (let i = 0; i < 7; i += 1) app.container.audit.record(event(marker, i));
      expect(await metricValue(app.container.metrics.auditEventsTotal, { result: 'dropped' })).toBe(2);
      await app.container.audit.flush();
      expect((await rowsOf(marker)).map((row) => row.target_id)).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4']);
      // The dropped events still have their log line (the second trail).
      expect(
        app.logs.find((line) => line['audit'] === true && line['requestId'] === `${marker}:6`),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('flushes queued events on shutdown (container.close())', async () => {
    const app = await createTestApp({ modules: [], config: { AUDIT_FLUSH_INTERVAL_MS: 600_000 } });
    const marker = randomUUID();
    for (let i = 0; i < 4; i += 1) app.container.audit.record(event(marker, i, 'ws.disconnect'));
    expect(await rowsOf(marker)).toHaveLength(0);
    await app.close();
    await app.close();
    expect(await rowsOf(marker)).toHaveLength(4);
  });
});
