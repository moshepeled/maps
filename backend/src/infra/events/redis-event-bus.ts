/**
 * Redis pub/sub event bus (SPEC section 7.10): local subscribers first (synchronously), then one PUBLISH of the envelope
 * serialised once. Remote messages are validated, messages from this instance are skipped, and subscribers are told
 * when the subscriber connection comes back (so they can resync clients and re-validate sessions).
 */
import { z } from 'zod';

import type { Clock } from '../clock.js';
import type { Lifecycle } from '../lifecycle.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import type { RedisClients } from '../redis/client.js';
import type { RedisKeys } from '../redis/keys.js';
import { BUS_PAYLOAD_SCHEMAS } from './payloads.js';
import { SubscriberRegistry } from './subscribers.js';
import { BUS_CHANNELS } from './types.js';
import type { BusChannel, BusEnvelope, BusPayload, EventBus } from './types.js';

const EnvelopeSchema = z.object({
  v: z.literal(1),
  origin: z.string().min(1),
  ts: z.number(),
  payload: z.unknown(),
});

export interface RedisEventBusDeps {
  instanceId: string;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  redis: RedisClients;
  keys: RedisKeys;
}

export class RedisEventBus implements EventBus, Lifecycle {
  readonly #deps: RedisEventBusDeps;
  readonly #subscribers: SubscriberRegistry;
  readonly #subscribedChannels = new Set<BusChannel>();
  readonly #channelByKey: Map<string, BusChannel>;
  readonly #logger: Logger;
  #hasBeenReady = false;
  #closed = false;

  constructor(deps: RedisEventBusDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'event-bus' });
    this.#subscribers = new SubscriberRegistry(this.#logger);
    this.#channelByKey = new Map(BUS_CHANNELS.map((channel) => [deps.keys.channel(channel), channel]));
    deps.redis.sub.on('message', this.#onMessage);
    deps.redis.sub.on('ready', this.#onSubscriberReady);
    if (deps.redis.sub.status === 'ready') this.#hasBeenReady = true;
  }

  async publish<C extends BusChannel>(channel: C, payload: BusPayload<C>): Promise<boolean> {
    const envelope: BusEnvelope<BusPayload<C>> = {
      v: 1,
      origin: this.#deps.instanceId,
      ts: this.#deps.clock.now(),
      payload,
    };
    this.#subscribers.deliver(channel, envelope);
    try {
      await this.#deps.redis.cmd.publish(this.#deps.keys.channel(channel), JSON.stringify(envelope));
      this.#deps.metrics.busMessagesTotal.inc({ channel, direction: 'published', result: 'ok' });
      return true;
    } catch (error) {
      this.#deps.metrics.busMessagesTotal.inc({ channel, direction: 'published', result: 'error' });
      this.#logger.warn({ err: error, channel }, 'bus publish failed; remote instances rely on resync');
      return false;
    }
  }

  subscribe<C extends BusChannel>(
    channel: C,
    handler: (msg: BusEnvelope<BusPayload<C>>) => void,
  ): () => void {
    const unsubscribe = this.#subscribers.add(channel, handler);
    this.#ensureRedisSubscription(channel);
    return unsubscribe;
  }

  onReconnect(handler: () => void): () => void {
    return this.#subscribers.addReconnect(handler);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#deps.redis.sub.off('message', this.#onMessage);
    this.#deps.redis.sub.off('ready', this.#onSubscriberReady);
    this.#subscribers.clear();
    return Promise.resolve();
  }

  #ensureRedisSubscription(channel: BusChannel): void {
    if (this.#subscribedChannels.has(channel)) return;
    this.#subscribedChannels.add(channel);
    // ioredis re-subscribes automatically after reconnects; the offline queue holds this until connected.
    this.#deps.redis.sub.subscribe(this.#deps.keys.channel(channel)).catch((error: unknown) => {
      this.#subscribedChannels.delete(channel);
      this.#logger.warn({ err: error, channel }, 'bus subscribe failed; will retry on the next subscribe');
    });
  }

  readonly #onSubscriberReady = (): void => {
    if (!this.#hasBeenReady) {
      this.#hasBeenReady = true;
      return;
    }
    this.#logger.warn('bus subscriber reconnected; notifying consumers');
    this.#subscribers.fireReconnect();
  };

  readonly #onMessage = (redisChannel: string, message: string): void => {
    const channel = this.#channelByKey.get(redisChannel);
    if (channel === undefined) return;
    const envelope = this.#parse(channel, message);
    if (envelope === null) {
      this.#deps.metrics.busMessagesTotal.inc({ channel, direction: 'received', result: 'invalid' });
      return;
    }
    if (envelope.origin === this.#deps.instanceId) return;
    this.#deps.metrics.busMessagesTotal.inc({ channel, direction: 'received', result: 'ok' });
    this.#subscribers.deliver(channel, envelope);
  };

  #parse(channel: BusChannel, message: string): BusEnvelope<unknown> | null {
    try {
      const envelope = EnvelopeSchema.parse(JSON.parse(message));
      const payload = BUS_PAYLOAD_SCHEMAS[channel].parse(envelope.payload);
      return { v: 1, origin: envelope.origin, ts: envelope.ts, payload };
    } catch (error) {
      this.#logger.warn({ err: error, channel }, 'invalid bus message dropped');
      return null;
    }
  }
}
