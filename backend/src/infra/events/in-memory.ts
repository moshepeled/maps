/**
 * Single-process event bus: local delivery only (unit tests, and tests that must not depend on Redis). Its `publish`
 * always resolves true because there is no remote leg that could fail.
 */
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import { SubscriberRegistry } from './subscribers.js';
import type { BusChannel, BusEnvelope, BusPayload, EventBus } from './types.js';

export interface InMemoryEventBusDeps {
  instanceId: string;
  clock: Clock;
  logger: Logger;
}

export class InMemoryEventBus implements EventBus {
  readonly #subscribers: SubscriberRegistry;
  readonly #instanceId: string;
  readonly #clock: Clock;
  /** Every envelope published through this bus with its channel, in order (test inspection). */
  readonly publishedWithChannel: { channel: BusChannel; envelope: BusEnvelope<unknown> }[] = [];

  constructor({ instanceId, clock, logger }: InMemoryEventBusDeps) {
    this.#instanceId = instanceId;
    this.#clock = clock;
    this.#subscribers = new SubscriberRegistry(logger);
  }

  publish<C extends BusChannel>(channel: C, payload: BusPayload<C>): Promise<boolean> {
    const envelope: BusEnvelope<BusPayload<C>> = {
      v: 1,
      origin: this.#instanceId,
      ts: this.#clock.now(),
      payload,
    };
    this.publishedWithChannel.push({ channel, envelope });
    this.#subscribers.deliver(channel, envelope);
    return Promise.resolve(true);
  }

  /** Payloads published on one channel, in order (test inspection). */
  publishedOn<C extends BusChannel>(channel: C): BusPayload<C>[] {
    return (
      this.publishedWithChannel
        .filter((entry) => entry.channel === channel)
        // The entry's channel was C when it was published, so its payload is a BusPayload<C>.
        .map((entry) => entry.envelope.payload as BusPayload<C>)
    );
  }

  subscribe<C extends BusChannel>(
    channel: C,
    handler: (msg: BusEnvelope<BusPayload<C>>) => void,
  ): () => void {
    return this.#subscribers.add(channel, handler);
  }

  onReconnect(handler: () => void): () => void {
    return this.#subscribers.addReconnect(handler);
  }
}
