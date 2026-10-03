/**
 * Integration-test global setup (SPEC section 12.2), run once per `vitest` invocation in the main process:
 *  - runId = base36(Date.now()) + base36(pid) (<= 12 chars, asserted);
 *  - database `snapland_it_<runId>` cloned from the migrated template (`test-database.ts`);
 *  - Redis prefix `snaptest<runId>:` on the test database index of both Redis roles;
 *  - a random JWT secret per run (tests sign their own tokens);
 *  - high generic rate limits (every `inject` comes from 127.0.0.1) - tests that assert limits lower them per app;
 *  - the worker environment is handed over with `project.provide('snaplandTestEnv', ...)` (applied by `env.ts`).
 * Teardown drops the database and deletes the prefix on both Redis roles. Tests NEVER stop or reconfigure the shared
 * compose services; outages are simulated per app instance (TCP proxy, bogus URLs).
 *
 * Hermetic: only the harness settings (`TEST_*`) are taken from the developer's `.env` (never loaded into this
 * process), and `env.ts` clears every other inherited backend variable in the workers, so a local `.env` or shell
 * export (DOCS_ENABLED=false, a short REQUEST_TIMEOUT_MS, ...) cannot change test outcomes.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { destination, pino } from 'pino';
import type { TestProject } from 'vitest/node';

import { TestDatabaseManager, withDatabase } from './test-database.js';
import { deletePrefix, deleteStaleTestPrefixes, testKeyPrefix } from './test-redis.js';

declare module 'vitest' {
  export interface ProvidedContext {
    snaplandTestEnv: Record<string, string>;
  }
}

const REPO_DOTENV = fileURLToPath(new URL('../../../.env', import.meta.url));
/** Generic limits high enough that suites never fail by volume (section 11.3 "integration env: 100000 each"). */
const HIGH_LIMIT = '100000';

const DEFAULTS = {
  TEST_DATABASE_ADMIN_URL: 'postgres://snapland:snapland@127.0.0.1:55432/postgres',
  TEST_REDIS_URL: 'redis://127.0.0.1:56379/1',
  TEST_CACHE_REDIS_URL: 'redis://127.0.0.1:56380/1',
} as const;

function createRunId(): string {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  if (runId.length > 12 || !/^[a-z0-9]+$/.test(runId))
    throw new Error(`run id ${runId} must be <= 12 base36 characters`);
  return runId;
}

/** The only `.env` entries the harness honours: its own settings (every other key is ignored). */
const DEVELOPER_SETTING = /^TEST_[A-Z0-9_]+$/;

/** Harness settings from the developer's `.env`, without touching `process.env` (the file is optional). */
function readDeveloperSettings(): Record<string, string> {
  if (!existsSync(REPO_DOTENV)) return {};
  const parsed = parseEnv(readFileSync(REPO_DOTENV, 'utf8'));
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => DEVELOPER_SETTING.test(entry[0]) && entry[1] !== undefined,
    ),
  );
}

/** A shell export wins over the `.env` entry, which wins over the built-in default. */
function setting(name: keyof typeof DEFAULTS, developer: Record<string, string>): string {
  const value = process.env[name] ?? developer[name];
  return value === undefined || value.trim() === '' ? DEFAULTS[name] : value;
}

export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const developer = readDeveloperSettings();
  const logger = pino({ level: 'warn', base: { component: 'it-global-setup' } }, destination(2));
  const adminUrl = setting('TEST_DATABASE_ADMIN_URL', developer);
  const redisUrl = setting('TEST_REDIS_URL', developer);
  const cacheRedisUrl = setting('TEST_CACHE_REDIS_URL', developer);
  const runId = createRunId();
  const prefix = testKeyPrefix(runId);

  const databases = new TestDatabaseManager(adminUrl, logger);
  const runDatabase = await databases.createRunDatabase(runId);
  await Promise.all([deleteStaleTestPrefixes(redisUrl), deleteStaleTestPrefixes(cacheRedisUrl)]);

  project.provide('snaplandTestEnv', {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    LOG_PRETTY: 'false',
    TEST_RUN_ID: runId,
    TEST_DATABASE_ADMIN_URL: adminUrl,
    TEST_REDIS_URL: redisUrl,
    TEST_CACHE_REDIS_URL: cacheRedisUrl,
    DATABASE_URL: withDatabase(adminUrl, runDatabase),
    REDIS_URL: redisUrl,
    CACHE_REDIS_URL: cacheRedisUrl,
    REDIS_KEY_PREFIX: prefix,
    JWT_SECRET: randomBytes(48).toString('base64url'),
    API_RATE_LIMIT_MAX: HIGH_LIMIT,
    AUTH_RATE_LIMIT_MAX: HIGH_LIMIT,
    REFRESH_RATE_LIMIT_MAX: HIGH_LIMIT,
    WS_UPGRADE_RATE_LIMIT_MAX: HIGH_LIMIT,
    // Background purges would race with other suites' fixtures; the retention tests enable it per app.
    RETENTION_ENABLED: 'false',
  });

  return async () => {
    const results = await Promise.allSettled([
      databases.dropRunDatabase(runDatabase),
      deletePrefix(redisUrl, prefix),
      deletePrefix(cacheRedisUrl, prefix),
    ]);
    for (const result of results) {
      if (result.status === 'rejected')
        logger.error({ err: result.reason }, 'integration-test teardown step failed');
    }
  };
}
