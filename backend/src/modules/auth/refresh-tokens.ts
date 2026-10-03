/**
 * Refresh tokens and their cookie (SPEC section 6.2): 32 random bytes, base64url (43 characters), stored only as SHA-256 in
 * `sessions.refresh_token_hash`, sent as `snap_rt` - `HttpOnly; Secure` (unless COOKIE_SECURE=false for plain-HTTP
 * development)`; SameSite=Strict; Path=/api/v1/auth`. The narrow path keeps the cookie off every other request, and
 * SameSite=Strict keeps it off cross-site requests (CSRF on /auth/refresh and /auth/logout).
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CookieSerializeOptions } from '@fastify/cookie';

export const REFRESH_COOKIE_NAME = 'snap_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
const REFRESH_TOKEN_BYTES = 32;

/** 32 bytes in unpadded base64url are exactly 43 characters. */
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RefreshTokenPair {
  /** Sent to the client once, never stored. */
  token: string;
  /** SHA-256 of the token (the only form the database sees). */
  hash: Buffer;
}

export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function generateRefreshToken(): RefreshTokenPair {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** Cheap shape check before any hashing or SQL: anything else cannot be a token we issued. */
export function isWellFormedRefreshToken(value: string): boolean {
  return REFRESH_TOKEN_PATTERN.test(value);
}

/** The attributes of `snap_rt`; `maxAgeS` is omitted when clearing the cookie. */
export function refreshCookieOptions(secure: boolean, maxAgeS?: number): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    ...(maxAgeS === undefined ? {} : { maxAge: maxAgeS }),
  };
}

/** Cookie lifetime = the session's remaining sliding lifetime after a rotation. */
export function refreshCookieMaxAgeS(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000));
}
