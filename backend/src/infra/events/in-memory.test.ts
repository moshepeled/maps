import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { InMemoryEventBus } from './in-memory.js';
import type { BusPayload } from './types.js';

const EVENT: BusPayload<'sessions'> = {
  kind: 'revoked',
  sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
  userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  reason: 'admin',
};

function bus() {
  return new InMemoryEventBus({
    instanceId: 'unit-1',
    clock: { now: () => 42 },
    logger: pino({ level: 'silent' }),
  });
}

describe('InMemoryEventBus', () => {
  it('delivers synchronously to subscribers of the channel with a v1 envelope and resolves true', async () => {
    const instance = bus();
    const received: unknown[] = [];
    const other: unknown[] = [];
    instance.subscribe('sessions', (message) => received.push(message));
    instance.subscribe('areas', (message) => other.push(message));
    const result = instance.publish('sessions', EVENT);
    expect(received).toEqual([{ v: 1, origin: 'unit-1', ts: 42, payload: EVENT }]);
    expect(other).toEqual([]);
    await expect(result).resolves.toBe(true);
    expect(instance.publishedOn('sessions')).toEqual([EVENT]);
    expect(instance.publishedOn('areas')).toEqual([]);
  });

  it('isolates a failing subscriber and supports unsubscribe', async () => {
    const instance = bus();
    const received: unknown[] = [];
    instance.subscribe('sessions', () => {
      throw new Error('subscriber bug');
    });
    const unsubscribe = instance.subscribe('sessions', (message) => received.push(message));
    await instance.publish('sessions', EVENT);
    unsubscribe();
    await instance.publish('sessions', EVENT);
    expect(received).toHaveLength(1);
  });
});
