import { describe, expect, it, vi } from 'vitest';

import { InMemoryRequestAuditTracker, createTrackingAuditLogger } from './request-audit-tracker.js';
import type { AuditEvent } from './types.js';

function tracker(maxEntries = 10_000) {
  let now = 0;
  return {
    instance: new InMemoryRequestAuditTracker({ now: () => now }, 60_000, maxEntries),
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('RequestAuditTracker (section 3.3, section 10.4)', () => {
  it('remembers marked request ids until released or 60 s old', () => {
    const { instance, at } = tracker();
    instance.mark('r1');
    instance.mark('r2');
    expect(instance.wasRecorded('r1')).toBe(true);
    expect(instance.wasRecorded('unknown')).toBe(false);
    instance.release('r1');
    expect(instance.wasRecorded('r1')).toBe(false);
    at(60_000);
    expect(instance.wasRecorded('r2')).toBe(false);
  });

  it('is bounded (oldest entries evicted first)', () => {
    const { instance } = tracker(2);
    instance.mark('a');
    instance.mark('b');
    instance.mark('c');
    expect(instance.wasRecorded('a')).toBe(false);
    expect(instance.wasRecorded('b')).toBe(true);
    expect(instance.wasRecorded('c')).toBe(true);
  });

  it('trusts a mark only while one request holds the id (a reused x-request-id cannot suppress a row)', () => {
    const { instance } = tracker();
    instance.begin('dup');
    instance.mark('dup');
    expect(instance.wasRecorded('dup')).toBe(true);
    instance.begin('dup');
    expect(instance.wasRecorded('dup')).toBe(false);
    instance.release('dup');
    // One request still holds the id: it stays shared, so even a fresh mark is not trusted.
    instance.mark('dup');
    expect(instance.wasRecorded('dup')).toBe(false);
    // The last release forgets the id: a later mark counts again.
    instance.release('dup');
    instance.mark('dup');
    expect(instance.wasRecorded('dup')).toBe(true);
  });

  it('counts overlapping requests: the first release keeps the entry; extra releases are harmless', () => {
    const { instance } = tracker();
    instance.begin('solo');
    instance.mark('solo');
    instance.release('solo');
    instance.release('solo');
    expect(instance.wasRecorded('solo')).toBe(false);
    instance.begin('solo');
    instance.begin('solo');
    instance.mark('solo');
    instance.release('solo');
    // The entry survives the first release: the id is still shared, so a new mark is not trusted.
    instance.mark('solo');
    expect(instance.wasRecorded('solo')).toBe(false);
    instance.release('solo');
    expect(instance.wasRecorded('solo')).toBe(false);
  });

  it('a new request ignores a late mark left by an earlier request with the same id', () => {
    const { instance, at } = tracker();
    instance.mark('late');
    at(10);
    instance.begin('late');
    expect(instance.wasRecorded('late')).toBe(false);
    instance.mark('late');
    expect(instance.wasRecorded('late')).toBe(true);
  });

  it('expires in-flight entries that are never released (aborted requests)', () => {
    const { instance, at } = tracker();
    instance.begin('aborted');
    at(60_000);
    instance.begin('next');
    // The expired entry is gone: a new request with that id is not taken for an overlap with the aborted one.
    instance.begin('aborted');
    instance.mark('aborted');
    expect(instance.wasRecorded('aborted')).toBe(true);
  });

  it('wraps the audit logger: marks request ids, delegates every call', async () => {
    const { instance } = tracker();
    const recorded: AuditEvent[] = [];
    const inner = {
      record: (event: AuditEvent) => recorded.push(event),
      flush: vi.fn(() => Promise.resolve()),
      start: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    };
    const logger = createTrackingAuditLogger(inner, instance);
    logger.record({ action: 'area.create', outcome: 'success', requestId: 'req-1' });
    logger.record({ action: 'retention.run', outcome: 'success' });
    expect(recorded).toHaveLength(2);
    expect(instance.wasRecorded('req-1')).toBe(true);
    logger.start?.();
    await logger.flush();
    await logger.close?.();
    expect(inner.start).toHaveBeenCalledOnce();
    expect(inner.flush).toHaveBeenCalledOnce();
    expect(inner.close).toHaveBeenCalledOnce();
    const bare = createTrackingAuditLogger(
      { record: () => undefined, flush: () => Promise.resolve() },
      instance,
    );
    await expect(bare.close?.()).resolves.toBeUndefined();
  });
});
