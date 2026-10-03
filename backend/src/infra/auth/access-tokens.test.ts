import { SignJWT, base64url } from 'jose';
import { describe, expect, it } from 'vitest';

import { UnauthorizedError } from '../http/errors.js';
import { createAccessTokenService } from './access-tokens.js';
import type { AccessClaims } from './access-tokens.js';

const SECRET = 's'.repeat(48);
const NOW = Date.UTC(2026, 8, 27, 10, 0, 0);
const CLAIMS: AccessClaims = {
  userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
};

function service(now = NOW, overrides: Partial<Parameters<typeof createAccessTokenService>[0]> = {}) {
  return createAccessTokenService({
    secret: SECRET,
    issuer: 'snapland',
    audience: 'snapland-api',
    ttlS: 900,
    clock: { now: () => now },
    ...overrides,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnauthorizedError) return error.code;
    throw error;
  }
  throw new Error('expected an UnauthorizedError');
}

describe('access tokens (section 6.2, ADR-0006)', () => {
  it('signs HS256 tokens that verify to the same claims, expiring after the TTL', async () => {
    const { token, expiresAt } = await service().sign(CLAIMS);
    expect(expiresAt.getTime()).toBe(NOW + 900_000);
    const [header] = token.split('.');
    expect(JSON.parse(new TextDecoder().decode(base64url.decode(header ?? '')))).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    await expect(service(NOW + 60_000).verify(token)).resolves.toEqual(CLAIMS);
  });

  it('rejects an expired token with TOKEN_EXPIRED (5 s clock tolerance)', async () => {
    const { token } = await service().sign(CLAIMS);
    await expect(service(NOW + 900_000 + 4000).verify(token)).resolves.toEqual(CLAIMS);
    expect(await codeOf(service(NOW + 900_000 + 6000).verify(token))).toBe('TOKEN_EXPIRED');
  });

  it('rejects a wrong issuer, a wrong audience, another secret and a tampered token with TOKEN_INVALID', async () => {
    const { token } = await service().sign(CLAIMS);
    expect(await codeOf(service(NOW, { issuer: 'other' }).verify(token))).toBe('TOKEN_INVALID');
    expect(await codeOf(service(NOW, { audience: 'other' }).verify(token))).toBe('TOKEN_INVALID');
    expect(await codeOf(service(NOW, { secret: 'x'.repeat(48) }).verify(token))).toBe('TOKEN_INVALID');
    const [header, , signature] = token.split('.');
    const forgedPayload = base64url.encode(
      JSON.stringify({
        sub: CLAIMS.userId,
        sid: CLAIMS.sessionId,
        name: 'Alice',
        usr: 'alice',
        role: 'admin',
        iss: 'snapland',
        aud: 'snapland-api',
        iat: NOW / 1000,
        exp: NOW / 1000 + 900,
      }),
    );
    expect(await codeOf(service().verify(`${header ?? ''}.${forgedPayload}.${signature ?? ''}`))).toBe(
      'TOKEN_INVALID',
    );
    expect(await codeOf(service().verify('not.a.jwt'))).toBe('TOKEN_INVALID');
  });

  it('rejects alg: none', async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64url.encode(
      JSON.stringify({
        sub: CLAIMS.userId,
        sid: CLAIMS.sessionId,
        name: 'A',
        usr: 'a',
        role: 'user',
        iss: 'snapland',
        aud: 'snapland-api',
        exp: NOW / 1000 + 900,
      }),
    );
    expect(await codeOf(service().verify(`${header}.${payload}.`))).toBe('TOKEN_INVALID');
  });

  it('rejects a correctly signed token whose claims do not match the schema', async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ sid: 'not-a-uuid', name: 'A', usr: 'a', role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(CLAIMS.userId)
      .setIssuer('snapland')
      .setAudience('snapland-api')
      .setIssuedAt(NOW / 1000)
      .setExpirationTime(NOW / 1000 + 900)
      .sign(key);
    expect(await codeOf(service().verify(token))).toBe('TOKEN_INVALID');
  });
});
