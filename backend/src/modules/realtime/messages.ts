/**
 * Server -> client message construction (SPEC section 7.3, section 7.5, section 7.8): every message is serialised ONCE into an
 * `OutboundMessage` whose lane follows the critical/ephemeral classification below, so a bus event fanned out to many
 * connections shares one string.
 */
import type { ServerMessageOf, ServerMessageType, WsErrorCode } from '@snapland/shared';

import type { OutboundMessage } from './outbound-queue.js';

type SingleServerMessageType = Exclude<ServerMessageType, 'batch'>;
/**
 * Lanes of the outbound queue (section 7.8): critical messages are FIFO and never dropped; the other (ephemeral) ones are
 * latest-wins by key. `batch` is a wrapper produced by the flusher and belongs to neither.
 */
export type CriticalMessageType =
  | 'welcome'
  | 'ack'
  | 'error'
  | 'pong'
  | 'presence.snapshot'
  | 'lock.snapshot'
  | 'area.changed'
  | 'draft.ended'
  | 'lock.acquired'
  | 'resync.required';
export type EphemeralMessageType = Exclude<SingleServerMessageType, CriticalMessageType>;
export type ServerData<T extends SingleServerMessageType> = ServerMessageOf<T>['data'];

function serialize(type: string, data: unknown, ref: string | null | undefined): string {
  return JSON.stringify(ref === null || ref === undefined ? { type, data } : { type, ref, data });
}

/** A critical message (never dropped); `supersedes` removes an obsolete pending ephemeral key. */
export function criticalMessage<T extends CriticalMessageType>(
  type: T,
  data: ServerData<T>,
  options: { ref?: string | null; supersedes?: string } = {},
): OutboundMessage {
  const json = serialize(type, data, options.ref);
  return {
    type,
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    lane: 'critical',
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
  };
}

/** An ephemeral message (latest wins per `key`). */
export function ephemeralMessage<T extends EphemeralMessageType>(
  type: T,
  data: ServerData<T>,
  key: string,
): OutboundMessage {
  const json = serialize(type, data, null);
  return { type, json, bytes: Buffer.byteLength(json, 'utf8'), lane: 'ephemeral', key };
}

export function ackMessage(ref: string, data: ServerData<'ack'> = {}): OutboundMessage {
  return criticalMessage('ack', data, { ref });
}

export interface ErrorExtras {
  ref?: string | null;
  retryAfterMs?: number;
  details?: unknown;
}

export function errorMessage(code: WsErrorCode, message: string, extras: ErrorExtras = {}): OutboundMessage {
  const data: ServerData<'error'> = {
    code,
    message,
    ...(extras.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: Math.max(0, Math.ceil(extras.retryAfterMs)) }),
    ...(extras.details === undefined ? {} : { details: extras.details }),
  };
  return criticalMessage('error', data, { ref: extras.ref ?? null });
}

/** Latest-wins keys of the ephemeral lane (section 7.8). */
export const ephemeralKey = {
  draft: (draftId: string) => `draft:${draftId}`,
  presence: (connectionId: string) => `presence:${connectionId}`,
  lock: (areaId: string) => `lock:${areaId}`,
} as const;
