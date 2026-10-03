/**
 * Per-connection outbound queue (SPEC section 7.8, section 10.11). Two lanes:
 *  - critical: FIFO, never dropped or coalesced (welcome, ack, error, pong, snapshots, area.changed, draft.ended,
 *    lock.acquired, resync.required); bounded by messages and bytes - overflowing it means the client is too slow, and
 *    the connection is closed with 1013 (it resyncs after reconnecting), so committed changes are never dropped silently;
 *  - ephemeral: latest-wins by key (`draft:<id>`, `presence:<connectionId>`, `lock:<areaId>`) in insertion order,
 *    bounded by keys (the oldest key is dropped on overflow).
 * Flushing (scheduled once per burst) sends critical messages first, then ephemeral ones, while the socket's
 * `bufferedAmount` is below the high-water mark; several messages share one `batch` frame of <= 64 KiB, assembled by
 * string concatenation of the pre-serialised messages (serialize once per instance). If the socket stays above the
 * high-water mark for longer than the slow-consumer timeout, the connection is reported as a slow consumer.
 */
import type { WebSocket } from 'ws';

import type { Clock } from '../../infra/clock.js';
import { unrefImmediate, unrefTimeout } from './timers.js';
import type { Cancel } from './timers.js';

export type OutboundLane = 'critical' | 'ephemeral';

export interface OutboundMessage {
  readonly type: string;
  /** The whole message, serialised once. */
  readonly json: string;
  /** UTF-8 size of `json`. */
  readonly bytes: number;
  readonly lane: OutboundLane;
  /** Latest-wins key (ephemeral lane only). */
  readonly key?: string;
  /** A critical message that makes a pending ephemeral message obsolete (draft.ended supersedes `draft:<id>`). */
  readonly supersedes?: string;
}

export interface OutboundQueueLimits {
  maxCriticalMessages: number;
  maxCriticalBytes: number;
  maxEphemeralKeys: number;
  /** Stop sending while the socket buffers at least this many bytes. */
  highWaterBytes: number;
  /** Buffered above the high-water mark for longer than this -> slow consumer. */
  slowConsumerTimeoutMs: number;
  /** Size cap of one batch frame. */
  maxFrameBytes: number;
}

export type DropReason = 'coalesced' | 'overflow';
export type SlowConsumerCause = 'critical_overflow' | 'buffered';

export interface OutboundQueueHooks {
  /** A frame was handed to the socket: the message types it carried and its size. */
  onSent(types: readonly string[], bytes: number): void;
  onDropped(type: string, reason: DropReason): void;
  /** The connection cannot keep up; the owner closes it with 1013. Called at most once. */
  onSlowConsumer(cause: SlowConsumerCause): void;
}

export interface OutboundQueueDeps {
  socket: Pick<WebSocket, 'bufferedAmount' | 'send'>;
  limits: OutboundQueueLimits;
  hooks: OutboundQueueHooks;
  clock: Clock;
}

const BATCH_PREFIX = '{"type":"batch","data":{"messages":[';
const BATCH_SUFFIX = ']}}';
const BATCH_OVERHEAD = BATCH_PREFIX.length + BATCH_SUFFIX.length;
/** Upper bound of the poll interval while the socket is above its high-water mark. */
const MAX_BLOCKED_POLL_MS = 50;

export class OutboundQueue {
  readonly #deps: OutboundQueueDeps;
  readonly #critical: OutboundMessage[] = [];
  #criticalBytes = 0;
  readonly #ephemeral = new Map<string, OutboundMessage>();
  #scheduled: Cancel | null = null;
  #blockedSince: number | null = null;
  #closed = false;
  #slowConsumerReported = false;

  constructor(deps: OutboundQueueDeps) {
    this.#deps = deps;
  }

  get depth(): { critical: number; ephemeral: number } {
    return { critical: this.#critical.length, ephemeral: this.#ephemeral.size };
  }

  enqueue(message: OutboundMessage): void {
    if (this.#closed) return;
    if (message.lane === 'critical') this.#enqueueCritical(message);
    else this.#enqueueEphemeral(message);
    this.#schedule();
  }

  /** Sends as much as the socket accepts now. Normally scheduled; public for deterministic tests. */
  flush(): void {
    this.#scheduled?.();
    this.#scheduled = null;
    if (this.#closed) return;
    while (this.#hasPending()) {
      if (this.#deps.socket.bufferedAmount >= this.#deps.limits.highWaterBytes) {
        this.#onBlocked();
        return;
      }
      this.#blockedSince = null;
      this.#sendFrame();
    }
    if (this.#deps.socket.bufferedAmount < this.#deps.limits.highWaterBytes) this.#blockedSince = null;
  }

  /** Discards everything and cancels the pending flush; later enqueues are ignored. Idempotent. */
  close(): void {
    this.#closed = true;
    this.#scheduled?.();
    this.#scheduled = null;
    this.#critical.length = 0;
    this.#criticalBytes = 0;
    this.#ephemeral.clear();
  }

  #enqueueCritical(message: OutboundMessage): void {
    if (message.supersedes !== undefined && this.#ephemeral.delete(message.supersedes)) {
      this.#deps.hooks.onDropped(message.type, 'coalesced');
    }
    if (this.#criticalIsFullFor(message)) {
      // A burst may fill the lane before the scheduled flush ran: try to drain once before declaring overflow.
      this.flush();
      if (this.#closed) return;
      if (this.#criticalIsFullFor(message)) {
        this.#deps.hooks.onDropped(message.type, 'overflow');
        this.#reportSlowConsumer('critical_overflow');
        return;
      }
    }
    this.#critical.push(message);
    this.#criticalBytes += message.bytes;
  }

  #criticalIsFullFor(message: OutboundMessage): boolean {
    const { maxCriticalMessages, maxCriticalBytes } = this.#deps.limits;
    return (
      this.#critical.length >= maxCriticalMessages || this.#criticalBytes + message.bytes > maxCriticalBytes
    );
  }

  #enqueueEphemeral(message: OutboundMessage): void {
    const key = message.key ?? message.type;
    const previous = this.#ephemeral.get(key);
    // Map.set on an existing key keeps its position: latest wins, insertion order is preserved.
    this.#ephemeral.set(key, message);
    if (previous !== undefined) {
      this.#deps.hooks.onDropped(previous.type, 'coalesced');
      return;
    }
    if (this.#ephemeral.size > this.#deps.limits.maxEphemeralKeys) {
      const oldest = this.#ephemeral.entries().next();
      if (oldest.done !== true) {
        this.#ephemeral.delete(oldest.value[0]);
        this.#deps.hooks.onDropped(oldest.value[1].type, 'overflow');
      }
    }
  }

  #hasPending(): boolean {
    return this.#critical.length > 0 || this.#ephemeral.size > 0;
  }

  #peek(): OutboundMessage | undefined {
    if (this.#critical.length > 0) return this.#critical[0];
    return this.#ephemeral.values().next().value;
  }

  #take(message: OutboundMessage): void {
    if (message.lane === 'critical' && this.#critical[0] === message) {
      this.#critical.shift();
      this.#criticalBytes -= message.bytes;
      return;
    }
    this.#ephemeral.delete(message.key ?? message.type);
  }

  /** Builds and sends one frame: a single message as is, several as one `batch` of at most maxFrameBytes. */
  #sendFrame(): void {
    const parts: OutboundMessage[] = [];
    let size = BATCH_OVERHEAD;
    for (let next = this.#peek(); next !== undefined; next = this.#peek()) {
      const added = next.bytes + (parts.length > 0 ? 1 : 0);
      if (parts.length > 0 && size + added > this.#deps.limits.maxFrameBytes) break;
      this.#take(next);
      parts.push(next);
      size += added;
    }
    const [only] = parts;
    if (only === undefined) return;
    if (parts.length === 1) {
      this.#deps.socket.send(only.json);
      this.#deps.hooks.onSent([only.type], only.bytes);
      return;
    }
    const frame = `${BATCH_PREFIX}${parts.map((part) => part.json).join(',')}${BATCH_SUFFIX}`;
    this.#deps.socket.send(frame);
    this.#deps.hooks.onSent(
      parts.map((part) => part.type),
      size,
    );
  }

  #onBlocked(): void {
    const now = this.#deps.clock.now();
    this.#blockedSince ??= now;
    if (now - this.#blockedSince > this.#deps.limits.slowConsumerTimeoutMs) {
      this.#reportSlowConsumer('buffered');
      return;
    }
    // ws exposes no drain event for bufferedAmount: poll until the socket has drained below the mark.
    const pollMs = Math.max(
      1,
      Math.min(MAX_BLOCKED_POLL_MS, Math.floor(this.#deps.limits.slowConsumerTimeoutMs / 4)),
    );
    this.#scheduled = unrefTimeout(() => {
      this.#scheduled = null;
      this.flush();
    }, pollMs);
  }

  #reportSlowConsumer(cause: SlowConsumerCause): void {
    if (this.#slowConsumerReported) return;
    this.#slowConsumerReported = true;
    this.#deps.hooks.onSlowConsumer(cause);
  }

  #schedule(): void {
    if (this.#scheduled !== null || this.#closed) return;
    this.#scheduled = unrefImmediate(() => {
      this.#scheduled = null;
      this.flush();
    });
  }
}
