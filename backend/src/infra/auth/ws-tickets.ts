/**
 * One-time WebSocket tickets (SPEC section 6.2, section 7.2): 32 random bytes (base64url, 43 chars) handed to the client; Redis
 * stores only `snap:wsticket:<sha256hex>` -> the claims JSON (profile + absolute expiry), `EX` WS_TICKET_TTL_S, `NX`.
 * Consumption is an atomic GETDEL, so a ticket works once and for at most 30 s - long-lived bearer tokens never appear
 * in URLs.
 */
import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { Clock } from '../clock.js';
import type { RedisClients } from '../redis/client.js';
import type { RedisKeys } from '../redis/keys.js';

export interface WsTicketClaims {
  userId: string;
  sessionId: string;
  displayName: string;
  color: string;
  role: 'user' | 'admin';
  /** ISO timestamp of the session's absolute expiry (the socket is closed with 4401 then). */
  absoluteExpiresAt: string;
}

export interface WsTicketStore {
  /** Throws when Redis fails (the auth module answers 503). */
  issue(claims: WsTicketClaims): Promise<{ ticket: string; expiresAt: Date }>;
  /** Single use; null for an unknown, expired, reused or malformed ticket. Throws when Redis fails. */
  consume(ticket: string): Promise<WsTicketClaims | null>;
}

const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ClaimsSchema = z.object({
  userId: z.uuid(),
  sessionId: z.uuid(),
  displayName: z.string(),
  color: z.string(),
  role: z.enum(['user', 'admin']),
  absoluteExpiresAt: z.iso.datetime({ offset: true }),
});

export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export interface RedisWsTicketStoreDeps {
  redis: RedisClients;
  keys: RedisKeys;
  clock: Clock;
  ttlS: number;
}

export function createWsTicketStore({ redis, keys, clock, ttlS }: RedisWsTicketStoreDeps): WsTicketStore {
  return {
    async issue(claims) {
      const ticket = randomBytes(32).toString('base64url');
      const stored = await redis.cmd.set(
        keys.wsTicket(hashTicket(ticket)),
        JSON.stringify(claims),
        'EX',
        ttlS,
        'NX',
      );
      // 256 random bits cannot collide in practice; NX only guarantees that a ticket is never silently replaced.
      if (stored !== 'OK') throw new Error('WebSocket ticket collision');
      return { ticket, expiresAt: new Date(clock.now() + ttlS * 1000) };
    },

    async consume(ticket) {
      if (!TICKET_PATTERN.test(ticket)) return null;
      const raw = await redis.cmd.getdel(keys.wsTicket(hashTicket(ticket)));
      if (raw === null) return null;
      try {
        const parsed = ClaimsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
