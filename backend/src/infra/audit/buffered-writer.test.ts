import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../config/env.js';
import type { NamedSql } from '../db/types.js';
import { createMetrics } from '../metrics/metrics.js';
import type { Metrics } from '../metrics/metrics.js';
import {
  BufferedAuditWriter,
  INSERT_AUDIT_BATCH,
  RETRY_MAX_MS,
  isTransientAuditError,
  retryDelayMs,
  toInsertParams,
} from './buffered-writer.js';
import { normalizeAuditEvent } from './normalize.js';
import type { AuditAction, AuditEvent } from './types.js';

interface Row {
  occurredAt: unknown;
  action: unknown;
  outcome: unknown;
  actorId: unknown;
  sessionId: unknown;
  targetType: unknown;
  targetId: unknown;
  requestId: unknown;
  instanceId: unknown;
  ip: unknown;
  userAgent: unknown;
  details: unknown;
}

const POISON_ACTION = 'bad.row' as string as AuditAction;

/** A Db double: records every attempted batch, can fail on demand and rejects "poison" rows like a CHECK would. */
class FakeDb {
  readonly rows: Row[] = [];
  /** Size of every attempted INSERT, in order. */
  readonly attempts: number[] = [];
  /** Errors thrown by the next calls, one per call. */
  readonly failNext: Error[] = [];
  /** While set, every call fails with this error. */
  failAll: Error | undefined = undefined;
  gate: Promise<void> | undefined;

  query(stmt: NamedSql, params: readonly unknown[] = []): Promise<never[]> {
    return this.#run(stmt, params);
  }

  async #run(stmt: NamedSql, params: readonly unknown[]): Promise<never[]> {
    expect(stmt).toBe(INSERT_AUDIT_BATCH);
    const columns = params as unknown[][];
    const actions = columns[1] ?? [];
    this.attempts.push(actions.length);
    if (this.gate !== undefined) await this.gate;
    if (this.failAll !== undefined) throw this.failAll;
    const next = this.failNext.shift();
    if (next !== undefined) throw next;
    if (actions.includes(POISON_ACTION)) {
      throw Object.assign(new Error('new row violates check constraint'), {
        code: '23514',
        constraint: 'audit_logs_action_ck',
      });
    }
    actions.forEach((_, index) => {
      const at = (column: number): unknown => columns[column]?.[index];
      this.rows.push({
        occurredAt: at(0),
        action: at(1),
        outcome: at(2),
        actorId: at(3),
        sessionId: at(4),
        targetType: at(5),
        targetId: at(6),
        requestId: at(7),
        instanceId: at(8),
        ip: at(9),
        userAgent: at(10),
        details: at(11),
      });
    });
    return [];
  }
}

const TEST_CONFIG = loadConfig({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SECRET: 'x'.repeat(40),
  METRICS_ENABLED: 'false',
});

function event(index: number, action: AuditAction = 'area.create'): AuditEvent {
  return { action, outcome: 'success', actorId: null, targetType: 'area', targetId: `a-${index}` };
}

function transientError(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
}

interface Setup {
  writer: BufferedAuditWriter;
  db: FakeDb;
  metrics: Metrics;
  logs: Record<string, unknown>[];
  count: (result: 'written' | 'dropped' | 'rejected' | 'failed') => Promise<number>;
}

function setup(options: { queueMax?: number; batchSize?: number; flushIntervalMs?: number } = {}): Setup {
  const db = new FakeDb();
  const metrics = createMetrics(TEST_CONFIG, 'unit');
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (chunk: string) => logs.push(JSON.parse(chunk) as Record<string, unknown>) },
  );
  const writer = new BufferedAuditWriter({
    db,
    logger,
    metrics,
    clock: { now: () => Date.now() },
    instanceId: 'unit-1',
    queueMax: options.queueMax ?? 10_000,
    batchSize: options.batchSize ?? 500,
    flushIntervalMs: options.flushIntervalMs ?? 1000,
  });
  const count = async (result: string): Promise<number> =>
    (await metrics.auditEventsTotal.get()).values.find((value) => value.labels.result === result)?.value ?? 0;
  return { writer, db, metrics, logs, count };
}

/** Lets background drains (promise chains) run without moving the fake clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('BufferedAuditWriter (section 10.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes full batches of at most AUDIT_BATCH_SIZE as soon as they fill', async () => {
    const { writer, db, count } = setup({ batchSize: 500 });
    writer.start();
    for (let i = 0; i < 1200; i += 1) writer.record(event(i));
    await settle();
    expect(db.attempts.every((size) => size <= 500)).toBe(true);
    expect(db.attempts.slice(0, 2)).toEqual([500, 500]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.attempts).toEqual([500, 500, 200]);
    expect(db.rows).toHaveLength(1200);
    expect(await count('written')).toBe(1200);
    expect(writer.depth).toBe(0);
    await writer.close();
  });

  it('flushes a partial batch on the interval, not before', async () => {
    const { writer, db } = setup({ flushIntervalMs: 1000 });
    writer.start();
    writer.record(event(1));
    writer.record(event(2));
    await vi.advanceTimersByTimeAsync(999);
    expect(db.attempts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.attempts).toEqual([2]);
    await writer.close();
  });

  it('maps every column of a normalised event onto the unnest parameters', async () => {
    const { writer, db } = setup();
    const occurredAt = new Date('2026-09-27T10:00:00.000Z');
    writer.record({
      action: 'area.update',
      outcome: 'failure',
      actorId: '8d7c1f53-0b1e-4c27-9d2a-6c6f2e0a1b11',
      sessionId: '1b1c7d9e-2f3a-4b5c-8d6e-7f8091a2b3c4',
      targetType: 'area',
      targetId: 'area-42',
      requestId: 'req-1',
      ip: '10.1.2.3',
      userAgent: 'u'.repeat(600),
      details: { code: 'VERSION_CONFLICT', status: 409 },
      occurredAt,
    });
    await writer.flush();
    expect(db.rows).toEqual([
      {
        occurredAt,
        action: 'area.update',
        outcome: 'failure',
        actorId: '8d7c1f53-0b1e-4c27-9d2a-6c6f2e0a1b11',
        sessionId: '1b1c7d9e-2f3a-4b5c-8d6e-7f8091a2b3c4',
        targetType: 'area',
        targetId: 'area-42',
        requestId: 'req-1',
        instanceId: 'unit-1',
        ip: '10.1.2.3',
        userAgent: 'u'.repeat(512),
        details: JSON.stringify({ code: 'VERSION_CONFLICT', status: 409 }),
      },
    ]);
  });

  it('truncates details above 4 KiB of JSON text and defaults the timestamp to the clock', async () => {
    const { writer, db } = setup();
    writer.record({ ...event(1), details: { blob: 'x'.repeat(5000), other: 1 } });
    await writer.flush();
    const row = db.rows[0];
    expect(JSON.parse(String(row?.details))).toEqual({ truncated: true, keys: ['blob', 'other'] });
    expect(row?.occurredAt).toEqual(new Date(Date.now()));
    expect(row?.actorId).toBeNull();
  });

  it('logs every event with audit: true (the second trail) and never throws from record()', async () => {
    const { writer, logs } = setup();
    writer.record(event(1, 'auth.login'));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => {
      writer.record({ ...event(2), details: circular });
    }).not.toThrow();
    expect(logs.some((line) => line['audit'] === true && line['action'] === 'auth.login')).toBe(true);
    expect(logs.some((line) => line['msg'] === 'audit event could not be recorded')).toBe(true);
    await writer.close();
  });

  it('keeps events queued on transient errors and retries after 1 s, 2 s, ... until it succeeds', async () => {
    const { writer, db, count } = setup();
    writer.start();
    db.failNext.push(transientError(), transientError());
    for (let i = 0; i < 3; i += 1) writer.record(event(i));
    await writer.flush();
    expect(db.attempts).toEqual([3]);
    expect(writer.depth).toBe(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(db.attempts).toEqual([3]);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.attempts).toEqual([3, 3]);
    expect(writer.depth).toBe(3);

    await vi.advanceTimersByTimeAsync(1999);
    expect(db.attempts).toEqual([3, 3]);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.attempts).toEqual([3, 3, 3]);
    expect(db.rows).toHaveLength(3);
    expect(writer.depth).toBe(0);
    expect(await count('written')).toBe(3);
    expect(await count('rejected')).toBe(0);
    await writer.close();
  });

  it('falls back to one INSERT per row on a non-transient failure: the poison row is rejected, the rest written', async () => {
    const { writer, db, count, logs } = setup();
    for (let i = 0; i < 4; i += 1) writer.record(event(i, i === 2 ? POISON_ACTION : 'area.create'));
    await writer.flush();
    expect(db.attempts).toEqual([4, 1, 1, 1, 1]);
    expect(db.rows.map((row) => row.targetId)).toEqual(['a-0', 'a-1', 'a-3']);
    expect(await count('rejected')).toBe(1);
    expect(await count('written')).toBe(3);
    expect(writer.depth).toBe(0);
    const rejection = logs.find((line) => line['constraint'] === 'audit_logs_action_ck');
    expect(rejection).toMatchObject({ action: POISON_ACTION, code: '23514' });
  });

  it('a transient failure during the per-row fallback requeues the rows not written yet', async () => {
    const { writer, db, count } = setup();
    for (let i = 0; i < 4; i += 1) writer.record(event(i, i === 0 ? POISON_ACTION : 'area.create'));
    // Call 1: the batch (poison) -> per row; call 2: the poison row (rejected); call 3: the next row -> DB gone.
    const original = db.query.bind(db);
    let calls = 0;
    vi.spyOn(db, 'query').mockImplementation((stmt, params) => {
      calls += 1;
      return calls === 3 ? Promise.reject(transientError()) : original(stmt, params);
    });
    await writer.flush();
    expect(await count('rejected')).toBe(1);
    expect(writer.depth).toBe(3);
    expect(db.rows).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    await writer.flush();
    expect(db.rows.map((row) => row.targetId)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(writer.depth).toBe(0);
  });

  it('drops the NEWEST event when the queue is full, counts it and logs at most every 10 s', async () => {
    const { writer, db, count, logs } = setup({ queueMax: 5, batchSize: 500 });
    db.failAll = transientError();
    for (let i = 0; i < 7; i += 1) writer.record(event(i));
    expect(writer.depth).toBe(5);
    expect(await count('dropped')).toBe(2);
    const dropLogs = (): number =>
      logs.filter((line) => line['msg'] === 'audit queue full: newest event dropped').length;
    expect(dropLogs()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    writer.record(event(8));
    expect(dropLogs()).toBe(2);

    db.failAll = undefined;
    await writer.flush();
    expect(db.rows.map((row) => row.targetId)).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4']);
  });

  it('counts the batch in flight against the bound', async () => {
    const { writer, db, count } = setup({ queueMax: 3, batchSize: 3 });
    let open: () => void = () => undefined;
    db.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    for (let i = 0; i < 3; i += 1) writer.record(event(i));
    await settle();
    expect(db.attempts).toEqual([3]);
    writer.record(event(99));
    expect(await count('dropped')).toBe(1);
    open();
    await writer.flush();
    expect(db.rows).toHaveLength(3);
  });

  it('flushes everything on close(), is idempotent and drops events recorded after it', async () => {
    const { writer, db, count } = setup({ flushIntervalMs: 600_000 });
    writer.start();
    for (let i = 0; i < 10; i += 1) writer.record(event(i));
    const first = writer.close();
    const second = writer.close();
    expect(second).toBe(first);
    await first;
    expect(db.rows).toHaveLength(10);
    writer.record(event(11));
    expect(await count('dropped')).toBe(1);
    expect(db.rows).toHaveLength(10);
  });

  it('counts the events still queued after the shutdown flush as failed, without retrying', async () => {
    const { writer, db, count, logs } = setup();
    db.failAll = transientError();
    for (let i = 0; i < 4; i += 1) writer.record(event(i));
    await writer.close();
    expect(db.attempts).toEqual([4]);
    expect(await count('failed')).toBe(4);
    expect(logs.some((line) => line['lost'] === 4)).toBe(true);
    expect(writer.depth).toBe(0);
  });

  it('gives up on a batch still in flight after the 5 s budget; if it then fails it is counted failed once', async () => {
    const { writer, db, count } = setup({ batchSize: 2 });
    let open: () => void = () => undefined;
    db.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    for (let i = 0; i < 4; i += 1) writer.record(event(i));
    await settle();
    expect(db.attempts).toEqual([2]);
    const closing = writer.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(await count('failed')).toBe(2);

    db.failAll = Object.assign(new Error('violates check constraint'), { code: '23514' });
    open();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.attempts).toEqual([2]);
    expect(await count('failed')).toBe(4);
    expect(await count('rejected')).toBe(0);
    expect(writer.depth).toBe(0);
  });

  it("unref's its timers so a forgotten writer cannot keep the process alive", async () => {
    vi.useRealTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const { writer, db } = setup({ flushIntervalMs: 50 });
    writer.start();
    db.failNext.push(transientError());
    writer.record(event(1));
    await writer.flush();
    // The flush interval (50 ms) and the transient-retry timer (1 s) are the writer's own timers.
    const ownHandles = (spy: typeof intervals | typeof timeouts, delay: number): NodeJS.Timeout[] =>
      spy.mock.calls.flatMap((call, index) =>
        call[1] === delay ? [spy.mock.results[index]?.value as NodeJS.Timeout] : [],
      );
    const handles = [...ownHandles(intervals, 50), ...ownHandles(timeouts, 1000)];
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => !handle.hasRef())).toBe(true);
    await writer.close();
    intervals.mockRestore();
    timeouts.mockRestore();
  });
});

describe('audit write error classification (section 10.4)', () => {
  it.each([
    ['22P02', false],
    ['22001', false],
    ['23514', false],
    ['23502', false],
    ['42501', false],
    ['08006', true],
    ['08001', true],
    ['57P01', true],
    ['57P03', true],
    ['53300', true],
    ['57014', true],
    ['40P01', true],
    ['ECONNREFUSED', true],
    ['ETIMEDOUT', true],
    ['EAI_AGAIN', true],
  ])('%s -> transient: %s', (code, expected) => {
    expect(isTransientAuditError(Object.assign(new Error('x'), { code }))).toBe(expected);
  });

  it('recognises driver connection failures by message and treats the rest as poison', () => {
    expect(isTransientAuditError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientAuditError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientAuditError(new Error('Query read timeout'))).toBe(true);
    expect(isTransientAuditError(new Error('boom'))).toBe(false);
    expect(isTransientAuditError('not an error')).toBe(false);
  });

  it('backs off 1 s, 2 s, 4 s ... capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((failures) => retryDelayMs(failures))).toEqual([
      1000,
      2000,
      4000,
      8000,
      16_000,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ]);
  });

  it('builds 12 parallel arrays in column order', () => {
    const normalized = normalizeAuditEvent(
      { action: 'ws.connect', outcome: 'success', targetType: 'ws_connection', targetId: 'c1' },
      0,
    );
    const params = toInsertParams([normalized, normalized], 'i-1');
    expect(params).toHaveLength(12);
    expect(params.every((column) => column.length === 2)).toBe(true);
    expect(params[8]).toEqual(['i-1', 'i-1']);
    expect(params[11]).toEqual(['{}', '{}']);
  });
});
