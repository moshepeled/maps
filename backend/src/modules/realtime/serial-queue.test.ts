import { describe, expect, it, vi } from 'vitest';

import { SerialTaskQueue } from './serial-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SerialTaskQueue', () => {
  it('runs tasks strictly one after the other, in order', async () => {
    const queue = new SerialTaskQueue(10, () => undefined);
    const order: string[] = [];
    const gate = deferred();
    queue.push(async () => {
      order.push('start:1');
      await gate.promise;
      order.push('end:1');
    });
    queue.push(() => {
      order.push('run:2');
    });
    await Promise.resolve();
    expect(order).toEqual(['start:1']);
    gate.resolve();
    await queue.idle();
    expect(order).toEqual(['start:1', 'end:1', 'run:2']);
  });

  it('refuses tasks beyond the bound and accepts again once they ran', async () => {
    const queue = new SerialTaskQueue(2, () => undefined);
    const gate = deferred();
    expect(queue.push(() => gate.promise)).toBe(true);
    expect(queue.push(() => undefined)).toBe(true);
    expect(queue.push(() => undefined)).toBe(false);
    gate.resolve();
    await queue.idle();
    expect(queue.push(() => undefined)).toBe(true);
    await queue.idle();
  });

  it('reports a failing task and keeps running the next ones', async () => {
    const onError = vi.fn();
    const queue = new SerialTaskQueue(10, onError);
    const ran: number[] = [];
    queue.push(() => {
      throw new Error('boom');
    });
    queue.push(() => {
      ran.push(2);
    });
    await queue.idle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(ran).toEqual([2]);
  });
});
