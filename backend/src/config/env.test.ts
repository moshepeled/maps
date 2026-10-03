import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS, ConfigError, JWT_SECRET_PLACEHOLDER, loadConfig } from './env.js';
import { APP_VERSION } from './version.js';

const BASE = {
  DATABASE_URL: 'postgres://snapland:snapland@127.0.0.1:55432/snapland',
  REDIS_URL: 'redis://127.0.0.1:56379/0',
  JWT_SECRET: 'a'.repeat(48),
};

function problemsOf(source: Record<string, unknown>): readonly string[] {
  try {
    loadConfig(source);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig (section 11.3)', () => {
  it('applies every documented default, including the v1.2 variables', () => {
    const config = loadConfig(BASE);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3100,
      LOG_PRETTY: true,
      TRUST_PROXY: ['loopback'],
      HTTP_REQUEST_TIMEOUT_MS: 15_000,
      REQUEST_TIMEOUT_MS: 10_000,
      REALTIME_DRAFT_TOUCH_INTERVAL_MS: 20_000,
      REALTIME_DRAFT_IDLE_MS: 120_000,
      REALTIME_SESSION_REVALIDATE_MS: 60_000,
      WS_UPGRADE_RATE_LIMIT_MAX: 60,
      WS_MAX_LOCKS_PER_CONNECTION: 3,
      WS_PERMESSAGE_DEFLATE: false,
      CACHE_L1_MAX_ENTRY_BYTES: 5_242_880,
      CACHE_L2_MAX_BODY_BYTES: 524_288,
      CACHE_REDIS_URL: null,
      REDIS_KEY_PREFIX: 'snap:',
    });
    expect(config.CORS_ORIGINS).toContain('http://localhost:5173');
    expect(config.INSTANCE_ID).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });

  it('parses typed env strings: booleans, integers, lists, hop counts and proxy lists', () => {
    const config = loadConfig({
      ...BASE,
      LOG_PRETTY: 'FALSE',
      PORT: ' 8081 ',
      CORS_ORIGINS: 'http://a.test, https://b.test:8443',
      TRUST_PROXY: '1',
      CACHE_REDIS_URL: 'redis://127.0.0.1:56380/0',
      INSTANCE_ID: '',
    });
    expect(config).toMatchObject({
      LOG_PRETTY: false,
      PORT: 8081,
      TRUST_PROXY: 1,
    });
    expect(config.CORS_ORIGINS).toEqual(['http://a.test', 'https://b.test:8443']);
    expect(config.CACHE_REDIS_URL).toBe('redis://127.0.0.1:56380/0');
    expect(loadConfig({ ...BASE, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...BASE, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(loadConfig({ ...BASE, TRUST_PROXY: 2, LOG_PRETTY: false }).TRUST_PROXY).toBe(2);
  });

  it('fails fast listing EVERY invalid variable', () => {
    const problems = problemsOf({
      DATABASE_URL: 'mysql://nope',
      REDIS_URL: 'not a url',
      JWT_SECRET: 'short',
      PORT: '70000',
      LOG_PRETTY: 'maybe',
      CORS_ORIGINS: '*',
      REDIS_KEY_PREFIX: 'Bad Prefix',
      DB_POOL_MAX: '1.5',
    });
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'PORT',
      'LOG_PRETTY',
      'CORS_ORIGINS',
      'REDIS_KEY_PREFIX',
      'DB_POOL_MAX',
    ]) {
      expect(
        problems.some((problem) => problem.startsWith(name)),
        name,
      ).toBe(true);
    }
    expect(() => loadConfig({})).toThrow(/Invalid configuration:\n {2}- /);
  });

  it('refuses the example JWT secret in production', () => {
    const problems = problemsOf({ ...BASE, NODE_ENV: 'production', JWT_SECRET: JWT_SECRET_PLACEHOLDER });
    expect(problems).toEqual([
      expect.stringMatching(/^JWT_SECRET: must not be the \.env\.example placeholder/),
    ]);
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'development', JWT_SECRET: JWT_SECRET_PLACEHOLDER }),
    ).not.toThrow();
  });

  it('forces LOG_PRETTY off in production (pino-pretty is dev-only)', () => {
    expect(loadConfig({ ...BASE, NODE_ENV: 'production', LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(false);
  });

  it('requires the draft touch interval to be below half the idle timeout', () => {
    expect(
      problemsOf({ ...BASE, REALTIME_DRAFT_TOUCH_INTERVAL_MS: 60_000, REALTIME_DRAFT_IDLE_MS: 120_000 }),
    ).toEqual([
      expect.stringMatching(
        /^REALTIME_DRAFT_TOUCH_INTERVAL_MS: must be less than REALTIME_DRAFT_IDLE_MS \/ 2/,
      ),
    ]);
    expect(() =>
      loadConfig({ ...BASE, REALTIME_DRAFT_TOUCH_INTERVAL_MS: 300, REALTIME_DRAFT_IDLE_MS: 1000 }),
    ).not.toThrow();
  });

  it('checks cross-field rules: refresh <= absolute TTL, presence stale > refresh', () => {
    expect(problemsOf({ ...BASE, REFRESH_TOKEN_TTL_S: 100, SESSION_ABSOLUTE_TTL_S: 50 })[0]).toMatch(
      /^REFRESH_TOKEN_TTL_S/,
    );
    expect(
      problemsOf({ ...BASE, REALTIME_PRESENCE_STALE_MS: 100, REALTIME_PRESENCE_REFRESH_MS: 200 })[0],
    ).toMatch(/^REALTIME_PRESENCE_STALE_MS/);
  });

  it('CONFIG_KEYS lists every backend variable of .env.example (the harness clears exactly these)', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const exampleKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    // Compose ports/credentials, the test harness, E2E and the SPA build flags are read by other tools.
    const otherTools =
      /^(POSTGRES_|PG_HOST_PORT|REDIS_HOST_PORT|REDIS_CACHE_HOST_PORT|HTTP_HOST_PORT|TEST_|E2E_|VITE_)/;
    const backendKeys = exampleKeys.filter((key) => key !== undefined && !otherTools.test(key));
    expect(new Set(CONFIG_KEYS)).toEqual(new Set([...backendKeys, 'INSTANCE_ID']));
  });

  it('keeps APP_VERSION equal to the backend package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(APP_VERSION).toBe(pkg.version);
  });
});
