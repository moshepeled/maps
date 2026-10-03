/**
 * Environment configuration (SPEC section 11.3) - the ONLY module that reads `process.env` (lint-enforced). Every variable is
 * validated at boot; an invalid configuration fails fast with one message listing every problem. The process entry
 * and the scripts call `loadConfigFromEnv()`; tests call `loadConfig(source)` with typed overrides.
 *
 * `AppConfig` keys are the environment variable names themselves, so operators, `.env.example`, tests
 * (`createTestApp({ config: { REQUEST_TIMEOUT_MS: 1000 } })`) and code all use one vocabulary. Values accept both the
 * raw env strings and typed values (test overrides), and are validated by the same schema either way.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** The committed placeholder of `.env.example`; production refuses to boot with it (section 10.7.7). */
export const JWT_SECRET_PLACEHOLDER = 'replace-me-run-node-scripts-setup-env-mjs';

// -- Value parsers (accept env strings and typed overrides) -------------------------------------

function integer(min: number, max: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .trim()
        .regex(/^-?\d+$/, 'must be an integer')
        .transform(Number),
    ])
    .pipe(z.number().int().min(min).max(max));
}

const boolean = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['true', 'false'], { message: 'must be true or false' }))
    .transform((value) => value === 'true'),
]);

function commaList() {
  return z.union([
    z.array(z.string()),
    z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ]);
}

function urlWithProtocols(protocols: readonly string[]) {
  return z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must be a ${protocols.join(' or ')} URL` },
    );
}

/** An empty string means "not set" for optional values. */
function emptyAsUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/** Host names may contain characters outside the INSTANCE_ID pattern; they are made safe, not rejected. */
function defaultInstanceId(): string {
  const safe = hostname()
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 64);
  return safe === '' ? 'snapland' : safe;
}

/** `false`, a hop count (integer >= 1) or a proxy-addr list such as `loopback` or `10.0.0.0/8,127.0.0.1`. */
const trustProxy = z.union([
  z.boolean(),
  z.number().int().min(1),
  z.array(z.string().min(1)),
  z
    .string()
    .trim()
    .min(1)
    .transform((value): boolean | number | string[] => {
      if (value.toLowerCase() === 'false') return false;
      if (/^\d+$/.test(value)) return Number(value);
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }),
]);

/** Exact origins (scheme + host + port), never `*` (section 10.7.2). */
const origins = commaList().pipe(
  z
    .array(
      z.string().refine(
        (value) => {
          try {
            const url = new URL(value);
            return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
          } catch {
            return false;
          }
        },
        { message: 'must be an exact origin such as http://localhost:5173 (no path, no *)' },
      ),
    )
    .min(1),
);

// -- Schema -----------------------------------------------------------------------------------

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: boolean.default(true),
    INSTANCE_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,64}$/)
        .default(defaultInstanceId),
    ),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: integer(1, 65_535).default(3100),
    TRUST_PROXY: trustProxy.default(['loopback']),
    CORS_ORIGINS: origins.default([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]),
    BODY_LIMIT_BYTES: integer(1024, 1_048_576).default(262_144),
    REQUEST_TIMEOUT_MS: integer(1000, 60_000).default(10_000),
    HTTP_REQUEST_TIMEOUT_MS: integer(1000, 120_000).default(15_000),
    SHUTDOWN_GRACE_MS: integer(1000, 120_000).default(10_000),
    DOCS_ENABLED: boolean.default(true),
    METRICS_ENABLED: boolean.default(true),

    DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:']),
    DB_POOL_MAX: integer(1, 100).default(20),
    DB_STATEMENT_TIMEOUT_MS: integer(100, 600_000).default(5000),
    DB_CONNECTION_TIMEOUT_MS: integer(100, 60_000).default(5000),
    DB_IDLE_TIMEOUT_MS: integer(1000, 600_000).default(30_000),

    REDIS_URL: urlWithProtocols(['redis:', 'rediss:']),
    /** null disables the L2 cache (L1 only, section 10.2). */
    CACHE_REDIS_URL: z
      .preprocess(emptyAsUndefined, urlWithProtocols(['redis:', 'rediss:']).optional())
      .transform((value) => value ?? null),
    CACHE_L2_MAX_BODY_BYTES: integer(1024, 4_194_304).default(524_288),
    CACHE_L1_MAX_ENTRY_BYTES: integer(65_536, 16_777_216).default(5_242_880),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]{1,24}:$/, 'must match ^[a-z0-9_-]{1,24}:$')
      .default('snap:'),
    REDIS_COMMAND_TIMEOUT_MS: integer(50, 60_000).default(1000),

    JWT_SECRET: z.string().min(32, 'must be at least 32 characters (run node scripts/setup-env.mjs)'),
    JWT_ISSUER: z.string().min(1).default('snapland'),
    JWT_AUDIENCE: z.string().min(1).default('snapland-api'),
    ACCESS_TOKEN_TTL_S: integer(60, 3600).default(900),
    REFRESH_TOKEN_TTL_S: integer(2, 31_536_000).default(1_209_600),
    SESSION_ABSOLUTE_TTL_S: integer(2, 31_536_000).default(2_592_000),
    COOKIE_SECURE: boolean.default(true),

    WS_TICKET_TTL_S: integer(5, 120).default(30),
    WS_MAX_PAYLOAD_BYTES: integer(1024, 1_048_576).default(65_536),
    WS_PING_INTERVAL_MS: integer(100, 600_000).default(20_000),
    WS_MAX_CONNECTIONS_PER_INSTANCE: integer(1, 1_000_000).default(5000),
    WS_MAX_CONNECTIONS_PER_USER: integer(1, 1000).default(10),
    WS_SEND_HIGH_WATER_BYTES: integer(1024, 67_108_864).default(262_144),
    WS_SLOW_CONSUMER_TIMEOUT_MS: integer(100, 600_000).default(10_000),
    WS_OUTBOUND_MAX_MESSAGES: integer(1, 100_000).default(500),
    WS_OUTBOUND_MAX_BYTES: integer(1024, 67_108_864).default(1_048_576),
    WS_UPGRADE_RATE_LIMIT_MAX: integer(1, 1_000_000).default(60),
    WS_MAX_LOCKS_PER_CONNECTION: integer(1, 50).default(3),
    WS_PERMESSAGE_DEFLATE: boolean.default(false),

    REALTIME_PRESENCE_REFRESH_MS: integer(100, 600_000).default(15_000),
    REALTIME_PRESENCE_SWEEP_MS: integer(100, 600_000).default(15_000),
    REALTIME_PRESENCE_STALE_MS: integer(100, 600_000).default(45_000),
    REALTIME_DRAFT_IDLE_MS: integer(10, 600_000).default(120_000),
    REALTIME_DRAFT_KEYFRAME_MS: integer(10, 600_000).default(5000),
    REALTIME_DRAFT_COALESCE_MS: integer(10, 600_000).default(50),
    REALTIME_DRAFT_TOUCH_INTERVAL_MS: integer(100, 300_000).default(20_000),
    REALTIME_SESSION_REVALIDATE_MS: integer(100, 600_000).default(60_000),
    REALTIME_DRAFT_RESUME_WINDOW_S: integer(1, 3600).default(120),
    REALTIME_LOCK_TTL_MS: integer(500, 600_000).default(30_000),

    DRAW_RATE_LIMIT_MAX: integer(1, 100_000).default(50),
    DRAW_RATE_LIMIT_WINDOW_MS: integer(1000, 3_600_000).default(60_000),
    API_RATE_LIMIT_MAX: integer(1, 1_000_000).default(300),
    AUTH_RATE_LIMIT_MAX: integer(1, 1_000_000).default(10),
    REFRESH_RATE_LIMIT_MAX: integer(1, 1_000_000).default(60),

    CACHE_ENABLED: boolean.default(true),
    CACHE_BBOX_TTL_S: integer(1, 86_400).default(120),
    CACHE_L1_MAX_ENTRIES: integer(1, 100_000).default(500),
    CACHE_L1_TTL_MS: integer(100, 3_600_000).default(30_000),

    RETENTION_ENABLED: boolean.default(true),
    RETENTION_INTERVAL_MS: integer(1000, 86_400_000).default(3_600_000),
    RETENTION_BATCH_SIZE: integer(1, 100_000).default(1000),
    RETENTION_INITIAL_DELAY_MS: integer(0, 3_600_000).default(60_000),
    RETENTION_STATEMENT_TIMEOUT_MS: integer(1000, 600_000).default(60_000),
    AREA_PURGE_AFTER_DAYS: integer(1, 36_500).default(30),
    AUDIT_RETENTION_DAYS: integer(1, 36_500).default(90),
    SESSION_PURGE_AFTER_DAYS: integer(1, 36_500).default(7),

    AUDIT_QUEUE_MAX: integer(1, 1_000_000).default(10_000),
    AUDIT_BATCH_SIZE: integer(1, 10_000).default(500),
    AUDIT_FLUSH_INTERVAL_MS: integer(10, 600_000).default(1000),

    /** Seed and load-test identities (test-only value; `backend/src/scripts/seed.ts`). */
    SEED_USER_PASSWORD: z.preprocess(emptyAsUndefined, z.string().min(8).max(128).optional()),
  })
  .superRefine((env, context) => {
    const fail = (path: string, message: string): void => {
      context.addIssue({ code: 'custom', path: [path], message });
    };
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.includes(JWT_SECRET_PLACEHOLDER)) {
      fail('JWT_SECRET', 'must not be the .env.example placeholder in production');
    }
    if (env.REFRESH_TOKEN_TTL_S > env.SESSION_ABSOLUTE_TTL_S) {
      fail('REFRESH_TOKEN_TTL_S', 'must not exceed SESSION_ABSOLUTE_TTL_S');
    }
    if (env.REALTIME_PRESENCE_STALE_MS <= env.REALTIME_PRESENCE_REFRESH_MS) {
      fail('REALTIME_PRESENCE_STALE_MS', 'must be greater than REALTIME_PRESENCE_REFRESH_MS');
    }
    if (env.REALTIME_DRAFT_TOUCH_INTERVAL_MS * 2 >= env.REALTIME_DRAFT_IDLE_MS) {
      fail(
        'REALTIME_DRAFT_TOUCH_INTERVAL_MS',
        'must be less than REALTIME_DRAFT_IDLE_MS / 2, so an open, quiet draft is always kept alive',
      );
    }
  })
  // pino-pretty is a devDependency absent from the production image, so a copied dev .env must not break the boot.
  .transform((env) => ({ ...env, LOG_PRETTY: env.LOG_PRETTY && env.NODE_ENV !== 'production' }));

/**
 * Every environment variable the schema reads (`.in` is the object before the transform); the integration harness
 * clears these to stay hermetic (section 12.2).
 */
export const CONFIG_KEYS: readonly string[] = Object.freeze(Object.keys(EnvSchema.in.shape));

/** The validated configuration. Keys are the environment variable names (section 11.3). */
export type AppConfig = z.output<typeof EnvSchema>;

/** Typed configuration overrides accepted by `loadConfig` sources (tests pass these on top of the env). */
export type AppConfigInput = { [K in keyof AppConfig]?: AppConfig[K] | string };

/** Thrown when the environment is invalid; `message` lists every problem, one per line. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Validates a configuration source; throws `ConfigError` listing every invalid variable. */
export function loadConfig(source: Readonly<Record<string, unknown>>): AppConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** `<repo>/.env`, written by `node scripts/setup-env.mjs`; absent in the container image, where compose sets the env. */
const REPO_DOTENV = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Loads `<repo>/.env` when it exists (variables already in the environment win), then validates the process env. */
export function loadConfigFromEnv(): AppConfig {
  if (existsSync(REPO_DOTENV)) process.loadEnvFile(REPO_DOTENV);
  return loadConfig(process.env);
}
