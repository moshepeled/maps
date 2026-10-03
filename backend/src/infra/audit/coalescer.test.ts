import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowedAuditCoalescer } from './coalescer.js';
import type { AuditEvent, AuditLogger } from './types.js';

function sink() {
  const events: AuditEvent[] = [];
  const logger: AuditLogger = { record: (event) => events.push(event), flush: () => Promise.resolve() };
  return { events, logger };
}

const HIT: AuditEvent = {
  action: 'ratelimit.hit',
  outcome: 'denied',
  actorId: 'u1',
  details: { scope: 'draw', transport: 'rest' },
};

describe('WindowedAuditCoalescer (section 10.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the first hit at once and the later hits of the window as ONE row with their count', async () => {
    const { events, logger } = sink();
    const coalescer = new WindowedAuditCoalescer({ sink: logger, clock: { now: () => Date.now() } });
    coalescer.start();
    for (let i = 0; i < 5; i += 1) coalescer.record('ratelimit:draw:u1', HIT);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ scope: 'draw', transport: 'rest', count: 1 });

    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.details?.['count']).toBe(4);
    expect(events.reduce((sum, event) => sum + Number(event.details?.['count']), 0)).toBe(5);

    coalescer.record('ratelimit:draw:u1', HIT);
    expect(events).toHaveLength(3);
    await coalescer.close();
    await coalescer.close();
  });

  it('coalesces per key and writes nothing extra for a single hit', () => {
    const { events, logger } = sink();
    const coalescer = new WindowedAuditCoalescer({ sink: logger, clock: { now: () => Date.now() } });
    coalescer.record('ws.reject:origin:10.0.0.1', { ...HIT, action: 'ws.reject' });
    coalescer.record('ws.reject:ticket:10.0.0.1', { ...HIT, action: 'ws.reject' });
    expect(events).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    coalescer.sweep();
    expect(events).toHaveLength(2);
    // The swept window is gone: the key's next hit opens a new window and is written at once.
    coalescer.record('ws.reject:origin:10.0.0.1', { ...HIT, action: 'ws.reject' });
    expect(events).toHaveLength(3);
    expect(events[2]?.details?.['count']).toBe(1);
  });

  it('flushes pending counters on flush() (shutdown)', async () => {
    const { events, logger } = sink();
    const coalescer = new WindowedAuditCoalescer({ sink: logger, clock: { now: () => Date.now() } });
    coalescer.record('k', HIT);
    coalescer.record('k', HIT);
    coalescer.record('k', HIT);
    await coalescer.flush();
    expect(events.map((event) => event.details?.['count'])).toEqual([1, 2]);
  });

  it('bounds the key map, flushing the oldest window early', () => {
    const { events, logger } = sink();
    const coalescer = new WindowedAuditCoalescer({
      sink: logger,
      clock: { now: () => Date.now() },
      maxKeys: 2,
    });
    coalescer.record('a', HIT);
    coalescer.record('a', HIT);
    coalescer.record('b', HIT);
    expect(events).toHaveLength(2);
    // A third key evicts the oldest window ('a'), whose later hit is written early.
    coalescer.record('c', HIT);
    expect(events.map((event) => event.details?.['count'])).toEqual([1, 1, 1, 1]);
  });
});
