/**
 * Access tokens (SPEC section 6.2, ADR-0006): JWT HS256 signed with JWT_SECRET via jose. Claims
 * `{ sub, sid, name, usr, role, iss, aud, iat, exp }`; verification pins `alg: HS256`, issuer, audience and a 5 s clock
 * tolerance. The client keeps the token in memory only.
 */
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';

import type { Clock } from '../clock.js';
import { UnauthorizedError } from '../http/errors.js';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  username: string;
  displayName: string;
  role: 'user' | 'admin';
}

export interface AccessTokenService {
  sign(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }>;
  /** Throws UnauthorizedError(TOKEN_EXPIRED) for an expired token and TOKEN_INVALID for anything else. */
  verify(token: string): Promise<AccessClaims>;
}

export interface AccessTokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  ttlS: number;
  clock: Clock;
}

const ALGORITHM = 'HS256';
const CLOCK_TOLERANCE_S = 5;

const PayloadSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  name: z.string(),
  usr: z.string(),
  role: z.enum(['user', 'admin']),
});

export function createAccessTokenService(options: AccessTokenOptions): AccessTokenService {
  const key = new TextEncoder().encode(options.secret);
  return {
    async sign(claims) {
      const issuedAtS = Math.floor(options.clock.now() / 1000);
      const expiresAtS = issuedAtS + options.ttlS;
      const token = await new SignJWT({
        sid: claims.sessionId,
        name: claims.displayName,
        usr: claims.username,
        role: claims.role,
      })
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .setSubject(claims.userId)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt(issuedAtS)
        .setExpirationTime(expiresAtS)
        .sign(key);
      return { token, expiresAt: new Date(expiresAtS * 1000) };
    },

    async verify(token) {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: options.issuer,
          audience: options.audience,
          clockTolerance: CLOCK_TOLERANCE_S,
          currentDate: new Date(options.clock.now()),
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired)
          throw new UnauthorizedError('TOKEN_EXPIRED', 'The access token has expired.');
        throw new UnauthorizedError('TOKEN_INVALID', 'The access token is invalid.');
      }
      const parsed = PayloadSchema.safeParse(payload);
      if (!parsed.success) throw new UnauthorizedError('TOKEN_INVALID', 'The access token is invalid.');
      const { sub, sid, name, usr, role } = parsed.data;
      return { userId: sub, sessionId: sid, username: usr, displayName: name, role };
    },
  };
}
