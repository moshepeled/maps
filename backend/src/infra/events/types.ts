/**
 * Cross-instance event bus contract (SPEC section 3.3, section 7.10). Delivery is at-most-once; loss is repaired by the change-feed
 * resync, anti-entropy polling, `resync.required` on subscriber reconnect and the DB-backed session re-validation.
 */
import type { z } from 'zod';

import { BUS_PAYLOAD_SCHEMAS } from './payloads.js';

export type BusChannel = keyof typeof BUS_PAYLOAD_SCHEMAS;

export type BusPayload<C extends BusChannel> = z.infer<(typeof BUS_PAYLOAD_SCHEMAS)[C]>;

// Object.keys() is typed string[]; the schema map is the single source of channel names, so the cast is exact.
export const BUS_CHANNELS = Object.keys(BUS_PAYLOAD_SCHEMAS) as readonly BusChannel[];

/** Wire envelope: `{ v: 1, origin: <instanceId>, ts: <epoch ms>, payload }`. */
export interface BusEnvelope<P> {
  v: 1;
  origin: string;
  ts: number;
  payload: P;
}

export interface EventBus {
  /**
   * Delivers to local subscribers synchronously, then publishes to Redis. Never throws; failures are logged and
   * counted. Resolves `true` when the Redis PUBLISH succeeded, `false` otherwise (callers that must report delivery - * the user-admin CLI - check it; services ignore it and rely on resync/re-validation).
   */
  publish<C extends BusChannel>(channel: C, payload: BusPayload<C>): Promise<boolean>;
  /** Subscribes to local + remote messages (remote messages whose origin === instanceId are skipped). */
  subscribe<C extends BusChannel>(channel: C, handler: (msg: BusEnvelope<BusPayload<C>>) => void): () => void;
  /** Fired after the Redis subscriber reconnects (consumers push resync.required and re-validate sessions). */
  onReconnect(handler: () => void): () => void;
}
