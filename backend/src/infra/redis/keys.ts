/**
 * The single source of every Redis key and pub/sub channel name (SPEC section 3.3, section 3.7), all under REDIS_KEY_PREFIX so a
 * test run (prefix `snaptest<runId>:`) can delete exactly its own keys.
 */
import type { BusChannel } from '../events/types.js';

/** The generic (fixed-window) rate-limit scopes of section 10.1; the drawing-action limiter has its own keys. */
export const RATE_LIMIT_SCOPES = ['api', 'auth', 'refresh', 'client_errors', 'ws_upgrade'] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export interface RedisKeys {
  /** e.g. `snap:` */
  readonly prefix: string;
  /** `<p>ch:<c>` */
  channel(c: BusChannel): string;
  /** `<p>rl:<scope>:` - the @fastify/rate-limit namespace of a generic scope. */
  rateLimit(scope: RateLimitScope): string;
  /** `<p>rl:draw:<userId>` (ZSET, section 10.1) */
  drawLimiter(userId: string): string;
  /** `<p>rl:login:ui:<sha1>` (section 6.2) */
  loginFailuresUserIp(sha1hex: string): string;
  /** `<p>rl:login:u:<sha1>` */
  loginFailuresUser(sha1hex: string): string;
  /** `<p>wsticket:<sha256>` */
  wsTicket(sha256hex: string): string;
  /** `<p>revoked:<sessionId>` */
  revokedSession(sessionId: string): string;
  /** `<p>draft:<draftId>` (section 7.6) */
  draft(draftId: string): string;
  /** `<p>presence:conns` (HASH, section 7.7) */
  presenceConns(): string;
  /** `<p>presence:seen` (ZSET) */
  presenceSeen(): string;
  /** `<p>locks` (HASH with field TTLs, section 7.9) */
  locks(): string;
  /** `<p>cache:gen:<L>:<x>:<y>` (section 10.2) */
  cacheGenTile(level: number, x: number, y: number): string;
  /** `<p>cache:gen:<L>:big` */
  cacheGenBig(level: number): string;
  /** `<p>cache:gen:global` (random epoch, section 10.2) */
  cacheGenGlobal(): string;
  /** `<p>cache:bbox:<sha1>` (on redis-cache) */
  cacheBody(hash: string): string;
}

export function createRedisKeys(prefix: string): RedisKeys {
  return {
    prefix,
    channel: (c) => `${prefix}ch:${c}`,
    rateLimit: (scope) => `${prefix}rl:${scope}:`,
    drawLimiter: (userId) => `${prefix}rl:draw:${userId}`,
    loginFailuresUserIp: (sha1hex) => `${prefix}rl:login:ui:${sha1hex}`,
    loginFailuresUser: (sha1hex) => `${prefix}rl:login:u:${sha1hex}`,
    wsTicket: (sha256hex) => `${prefix}wsticket:${sha256hex}`,
    revokedSession: (sessionId) => `${prefix}revoked:${sessionId}`,
    draft: (draftId) => `${prefix}draft:${draftId}`,
    presenceConns: () => `${prefix}presence:conns`,
    presenceSeen: () => `${prefix}presence:seen`,
    locks: () => `${prefix}locks`,
    cacheGenTile: (level, x, y) => `${prefix}cache:gen:${level}:${x}:${y}`,
    cacheGenBig: (level) => `${prefix}cache:gen:${level}:big`,
    cacheGenGlobal: () => `${prefix}cache:gen:global`,
    cacheBody: (hash) => `${prefix}cache:bbox:${hash}`,
  };
}
