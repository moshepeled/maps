import { parseServerMessage } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from '../../infra/clock.js';
import { criticalMessage, ephemeralKey, ephemeralMessage } from './messages.js';
import { OutboundQueue } from './outbound-queue.js';
import type {
  DropReason,
  OutboundMessage,
  OutboundQueueLimits,
  SlowConsumerCause,
} from './outbound-queue.js';

const DRAFT_ID = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER = { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' };

const LIMITS: OutboundQueueLimits = {
  maxCriticalMessages: 500,
  maxCriticalBytes: 1024 * 1024,
  maxEphemeralKeys: 500,
  highWaterBytes: 256 * 1024,
  slowConsumerTimeoutMs: 10_000,
  maxFrameBytes: 64 * 1024,
};

interface Harness {
  queue: OutboundQueue;
  frames: string[];
  socket: { bufferedAmount: number };
  dropped: { type: string; reason: DropReason }[];
  slow: SlowConsumerCause[];
  sent: string[][];
}

function harness(limits: Partial<OutboundQueueLimits> = {}): Harness {
  const frames: string[] = [];
  const dropped: { type: string; reason: DropReason }[] = [];
  const slow: SlowConsumerCause[] = [];
  const sent: string[][] = [];
  /** The two members of a ws socket the queue reads. */
  const socket = {
    bufferedAmount: 0,
    send(frame: string) {
      frames.push(frame);
    },
  };
  const queue = new OutboundQueue({
    socket,
    limits: { ...LIMITS, ...limits },
    hooks: {
      onSent: (types) => sent.push([...types]),
      onDropped: (type, reason) => dropped.push({ type, reason }),
      onSlowConsumer: (cause) => slow.push(cause),
    },
    clock: systemClock,
  });
  return { queue, frames, socket, dropped, slow, sent };
}

function ack(ref: string): OutboundMessage {
  return criticalMessage('ack', {}, { ref });
}

function draftUpdated(rev: number, draftId = DRAFT_ID): OutboundMessage {
  return ephemeralMessage(
    'draft.updated',
    { draftId, user: USER, areaId: null, rev, vertices: [[34.78, 32.08]], cursor: null },
    ephemeralKey.draft(draftId),
  );
}

/** Every message delivered, batches unwrapped, in order. */
function delivered(
  frames: readonly string[],
): { type: string; ref?: string; data: Record<string, unknown> }[] {
  return frames.flatMap((frame) => {
    const parsed = JSON.parse(frame) as { type: string; ref?: string; data: Record<string, unknown> };
    if (parsed.type !== 'batch') return [parsed];
    return parsed.data['messages'] as { type: string; ref?: string; data: Record<string, unknown> }[];
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboundQueue (section 7.8)', () => {
  it('flushes once per burst (setImmediate) and batches the burst into one frame', () => {
    const { queue, frames } = harness();
    queue.enqueue(ack('a'));
    queue.enqueue(ack('b'));
    queue.enqueue(ack('c'));
    expect(frames).toHaveLength(0);
    vi.runOnlyPendingTimers();
    expect(frames).toHaveLength(1);
    const batch = parseServerMessage(JSON.parse(frames[0] ?? 'null'));
    expect(batch.kind).toBe('batch');
    expect(delivered(frames).map((message) => message.ref)).toEqual(['a', 'b', 'c']);
  });

  it('sends a single message as is (no batch wrapper)', () => {
    const { queue, frames, sent } = harness();
    queue.enqueue(ack('only'));
    queue.flush();
    expect(JSON.parse(frames[0] ?? 'null')).toEqual({ type: 'ack', ref: 'only', data: {} });
    expect(sent).toEqual([['ack']]);
  });

  it('sends critical messages first, in FIFO order, then ephemeral ones', () => {
    const { queue, frames } = harness();
    queue.enqueue(draftUpdated(1));
    queue.enqueue(ack('1'));
    queue.enqueue(criticalMessage('lock.snapshot', { items: [] }));
    queue.flush();
    expect(delivered(frames).map((message) => message.type)).toEqual([
      'ack',
      'lock.snapshot',
      'draft.updated',
    ]);
  });

  it('coalesces ephemeral messages per key (latest wins, position kept) and counts the drops', () => {
    const { queue, frames, dropped } = harness();
    const other = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
    queue.enqueue(draftUpdated(1));
    queue.enqueue(draftUpdated(1, other));
    queue.enqueue(draftUpdated(2));
    queue.enqueue(draftUpdated(3));
    queue.flush();
    const messages = delivered(frames);
    expect(messages.map((message) => [message.data['draftId'], message.data['rev']])).toEqual([
      [DRAFT_ID, 3],
      [other, 1],
    ]);
    expect(dropped).toEqual([
      { type: 'draft.updated', reason: 'coalesced' },
      { type: 'draft.updated', reason: 'coalesced' },
    ]);
  });

  it('never drops or coalesces critical messages (lock.snapshot included) under ephemeral overflow', () => {
    const { queue, frames, dropped } = harness({ maxEphemeralKeys: 3 });
    const snapshot = criticalMessage('lock.snapshot', { items: [] });
    queue.enqueue(snapshot);
    queue.enqueue(snapshot);
    for (let i = 0; i < 10; i += 1) {
      queue.enqueue(draftUpdated(1, `4b0e1c2d-3e4f-4a5b-8c6d-${String(i).padStart(12, '0')}`));
    }
    queue.flush();
    const types = delivered(frames).map((message) => message.type);
    expect(types.filter((type) => type === 'lock.snapshot')).toHaveLength(2);
    expect(types.filter((type) => type === 'draft.updated')).toHaveLength(3);
    expect(dropped.filter((drop) => drop.reason === 'overflow')).toHaveLength(7);
    expect(dropped.every((drop) => drop.type === 'draft.updated')).toBe(true);
  });

  it('a critical message removes the pending ephemeral message it supersedes (draft.ended after draft.updated)', () => {
    const { queue, frames } = harness();
    queue.enqueue(draftUpdated(5));
    queue.enqueue(
      criticalMessage(
        'draft.ended',
        { draftId: DRAFT_ID, userId: USER.id, outcome: 'cancelled', areaId: null },
        { supersedes: ephemeralKey.draft(DRAFT_ID) },
      ),
    );
    queue.flush();
    expect(delivered(frames).map((message) => message.type)).toEqual(['draft.ended']);
  });

  it('keeps batch frames within maxFrameBytes and sends an oversized message alone', () => {
    const { queue, frames } = harness({ maxFrameBytes: 200 });
    for (let i = 0; i < 10; i += 1) queue.enqueue(ack(`ref-${i}`));
    const big = criticalMessage('error', { code: 'VALIDATION_FAILED', message: 'x'.repeat(500) });
    queue.enqueue(big);
    queue.flush();
    for (const frame of frames.slice(0, -1)) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(200);
    expect(frames.at(-1)).toBe(big.json);
    expect(delivered(frames)).toHaveLength(11);
  });

  it('stops sending above the high-water mark and resumes once the socket drained', () => {
    const { queue, frames, socket, slow } = harness({ highWaterBytes: 1000, slowConsumerTimeoutMs: 10_000 });
    socket.bufferedAmount = 5000;
    queue.enqueue(ack('held'));
    queue.flush();
    expect(frames).toHaveLength(0);
    expect(queue.depth).toEqual({ critical: 1, ephemeral: 0 });
    vi.advanceTimersByTime(500);
    expect(frames).toHaveLength(0);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    expect(delivered(frames).map((message) => message.ref)).toEqual(['held']);
    expect(slow).toEqual([]);
  });

  it('reports a slow consumer (1013) when the socket stays above the high-water mark beyond the timeout', () => {
    const { queue, socket, slow } = harness({ highWaterBytes: 1000, slowConsumerTimeoutMs: 400 });
    socket.bufferedAmount = 5000;
    queue.enqueue(ack('held'));
    queue.flush();
    vi.advanceTimersByTime(1000);
    expect(slow).toEqual(['buffered']);
  });

  it('reports a slow consumer when the critical lane overflows while blocked (the message is not dropped silently)', () => {
    const { queue, socket, slow, dropped } = harness({ maxCriticalMessages: 3, highWaterBytes: 1000 });
    socket.bufferedAmount = 5000;
    for (let i = 0; i < 4; i += 1) queue.enqueue(ack(String(i)));
    expect(slow).toEqual(['critical_overflow']);
    expect(dropped).toEqual([{ type: 'ack', reason: 'overflow' }]);
    queue.enqueue(ack('5'));
    expect(slow).toHaveLength(1);
  });

  it('enforces the critical byte bound too', () => {
    const { queue, socket, slow } = harness({ maxCriticalBytes: 100, highWaterBytes: 1000 });
    socket.bufferedAmount = 5000;
    queue.enqueue(criticalMessage('error', { code: 'THROTTLED', message: 'y'.repeat(120) }));
    expect(slow).toEqual(['critical_overflow']);
  });

  it('drains synchronously instead of overflowing when a burst fills the lane but the socket is writable', () => {
    const { queue, frames, slow } = harness({ maxCriticalMessages: 3 });
    for (let i = 0; i < 10; i += 1) queue.enqueue(ack(String(i)));
    queue.flush();
    expect(slow).toEqual([]);
    expect(delivered(frames)).toHaveLength(10);
  });

  it('close() discards pending messages, cancels the flush and sends nothing afterwards', () => {
    const { queue, frames } = harness();
    queue.enqueue(ack('a'));
    queue.close();
    queue.close();
    queue.enqueue(ack('b'));
    vi.runAllTimers();
    queue.flush();
    expect(frames).toEqual([]);
    expect(queue.depth).toEqual({ critical: 0, ephemeral: 0 });
  });
});
