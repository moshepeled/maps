/** Local subscriber bookkeeping shared by the in-memory and the Redis event bus. */
import type { Logger } from '../logger.js';
import type { BusChannel, BusEnvelope, BusPayload } from './types.js';

type AnyHandler = (msg: BusEnvelope<unknown>) => void;

export class SubscriberRegistry {
  readonly #handlers = new Map<BusChannel, Set<AnyHandler>>();
  readonly #reconnectHandlers = new Set<() => void>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  add<C extends BusChannel>(channel: C, handler: (msg: BusEnvelope<BusPayload<C>>) => void): () => void {
    const set = this.#handlers.get(channel) ?? new Set<AnyHandler>();
    this.#handlers.set(channel, set);
    const erased = handler as AnyHandler;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  /** Calls every handler of the channel; a throwing handler is logged and never affects the others or the caller. */
  deliver(channel: BusChannel, envelope: BusEnvelope<unknown>): void {
    for (const handler of this.#handlers.get(channel) ?? []) {
      try {
        handler(envelope);
      } catch (error) {
        this.#logger.error({ err: error, channel }, 'event bus subscriber failed');
      }
    }
  }

  addReconnect(handler: () => void): () => void {
    this.#reconnectHandlers.add(handler);
    return () => {
      this.#reconnectHandlers.delete(handler);
    };
  }

  fireReconnect(): void {
    for (const handler of this.#reconnectHandlers) {
      try {
        handler();
      } catch (error) {
        this.#logger.error({ err: error }, 'event bus reconnect handler failed');
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
    this.#reconnectHandlers.clear();
  }
}
