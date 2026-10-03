/**
 * Operator CLI for admin roles and account state (SPEC section 6.2): `grant-admin | revoke-admin | disable | enable
 * --username <name>` - the only way to create admins (registration always creates role `user`).
 *
 *   local:   npm run user-admin -w @snapland/backend -- grant-admin --username alice
 *   compose: docker compose exec backend-1 node dist/scripts/user-admin.js grant-admin --username alice
 *
 * Exit codes: 0 when every step succeeded; 1 for invalid arguments, an unknown user, a configuration/database failure,
 * or - after the database change committed - any failed Redis step (revocation mark or `sessions` bus event). In that
 * last case the CLI names each failed step and states that the database change is final: open sockets still close
 * within REALTIME_SESSION_REVALIDATE_MS, REST access ends when the <= 15-min access tokens expire, and re-running the
 * same command once Redis is back delivers the missing steps (idempotent). A failed shutdown (audit flush, closing the
 * connections) also exits 1 without hiding the outcome already reported. A one-line JSON summary goes to stdout.
 */
import { userInfo } from 'node:os';

import { UsernameSchema } from '@snapland/shared';
import { z } from 'zod';

import { loadConfigFromEnv } from '../config/env.js';
import { createContainer } from '../container.js';
import type { AuditLogger } from '../infra/audit/types.js';
import type { SessionRevocationStore } from '../infra/auth/revocations.js';
import { EXIT_FAILURE, EXIT_OK, createScriptLogger, isEntryPoint, parseScriptArgs } from '../infra/cli.js';
import type { ScriptIo } from '../infra/cli.js';
import type { Db } from '../infra/db/types.js';
import type { EventBus } from '../infra/events/types.js';
import type { Logger } from '../infra/logger.js';
import { waitUntilReady } from '../infra/redis/client.js';
import {
  USER_ADMIN_OPS,
  UnknownUserError,
  createRevocationNotifier,
  createUserAdminService,
} from '../modules/auth/index.js';
import type { UserAdminOp, UserAdminResult } from '../modules/auth/index.js';

const USAGE = `Usage: user-admin <grant-admin|revoke-admin|disable|enable> --username <name>

  grant-admin    give the user the admin role
  revoke-admin   return the user to the user role
  disable        disable the account and revoke every active session (open sockets close with 4401)
  enable         re-enable a disabled account
  --username     the account (case-insensitive)
  -h, --help     show this help

Reads DATABASE_URL, REDIS_URL and the rest of the validated configuration from the environment / repository .env.`;

const ArgsSchema = z.object({
  positionals: z.tuple([z.enum(USER_ADMIN_OPS)], {
    message: `expected one command: ${USER_ADMIN_OPS.join(' | ')}`,
  }),
  // The registration rule itself (one source of truth): every account the CLI can address matches it.
  username: UsernameSchema,
});

/** How long the CLI waits for Redis before applying the database change anyway (Redis steps then fail -> exit 1). */
const REDIS_READY_TIMEOUT_MS = 3000;

/** What one run needs from the application: the database (authoritative) and the Redis-backed side effects. */
export interface UserAdminContext {
  db: Db;
  revocations: SessionRevocationStore;
  events: EventBus;
  audit: AuditLogger;
  accessTokenTtlS: number;
  /** Flushes the audit trail and releases every connection. */
  close(): Promise<void>;
}

export interface UserAdminDeps extends ScriptIo {
  logger: Logger;
  /** Default: load the validated configuration and build the application container. */
  openContext(logger: Logger): Promise<UserAdminContext>;
  /** The OS user recorded as `details.operator` (null when unknown). */
  operator(): string | null;
}

async function openApplicationContext(logger: Logger): Promise<UserAdminContext> {
  const config = loadConfigFromEnv();
  const container = createContainer(config, { logger });
  if (!(await waitUntilReady(container.redis, REDIS_READY_TIMEOUT_MS))) {
    logger.warn('Redis is not reachable: the database change will be applied, but the Redis steps may fail');
  }
  return {
    db: container.db,
    revocations: container.revocations,
    events: container.events,
    audit: container.audit,
    accessTokenTtlS: config.ACCESS_TOKEN_TTL_S,
    close: () => container.close(),
  };
}

function currentOsUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    // userInfo() throws for users without a passwd entry (some containers).
    return null;
  }
}

function defaultDeps(): UserAdminDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    logger: createScriptLogger('user-admin'),
    openContext: openApplicationContext,
    operator: currentOsUser,
  };
}

/** The operator-facing explanation of a partial success (SPEC section 6.2 exit code 1 after commit). */
function describeRedisFailures(result: UserAdminResult): string {
  const steps = result.redisFailures.map((failure) =>
    failure.step === 'markRevoked'
      ? `  - revocations.markRevoked(${failure.sessionId}) failed`
      : `  - events.publish('sessions', ${failure.sessionId}) failed`,
  );
  return [
    `error: ${result.op} ${result.username}: the database change is committed and final, but ${result.redisFailures.length} Redis step(s) failed:`,
    ...steps,
    'Open sockets still close within REALTIME_SESSION_REVALIDATE_MS (the gateways re-validate sessions against the',
    'database) and REST access ends when the access tokens expire (<= ACCESS_TOKEN_TTL_S). Re-run the same command',
    'once Redis is reachable to deliver the missing steps.',
  ].join('\n');
}

async function applyOperation(
  deps: UserAdminDeps,
  context: UserAdminContext,
  op: UserAdminOp,
  username: string,
): Promise<number> {
  const service = createUserAdminService({
    db: context.db,
    audit: context.audit,
    notifier: createRevocationNotifier({
      revocations: context.revocations,
      events: context.events,
      logger: deps.logger,
    }),
    accessTokenTtlS: context.accessTokenTtlS,
    operator: deps.operator(),
  });
  try {
    const result = await service.apply(op, username);
    deps.stdout.write(`${JSON.stringify({ ok: result.redisFailures.length === 0, ...result })}\n`);
    if (result.redisFailures.length > 0) {
      deps.logger.error(
        { op, userId: result.userId, redisFailures: result.redisFailures },
        'Redis steps failed',
      );
      deps.stderr.write(`${describeRedisFailures(result)}\n`);
      return EXIT_FAILURE;
    }
    deps.logger.info({ op, userId: result.userId, revokedSessions: result.revokedSessions }, 'user updated');
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UnknownUserError) {
      deps.stderr.write(`error: no user named ${username} (nothing changed)\n`);
      return EXIT_FAILURE;
    }
    // Everything after the commit reports failures instead of throwing: this is the database transaction failing.
    deps.logger.error({ err: error, op }, 'user-admin failed: the database transaction did not complete');
    deps.stderr.write(
      `error: ${op} failed: the database transaction did not complete (see the log); re-running is safe\n`,
    );
    return EXIT_FAILURE;
  }
}

/**
 * Flushes the audit trail and releases the connections. A failure here cannot undo what the run did, so it is reported
 * (and fails the exit code: the audit row may be missing) instead of rejecting `run` and hiding the run's outcome.
 */
async function closeContext(deps: UserAdminDeps, context: UserAdminContext): Promise<boolean> {
  try {
    await context.close();
    return true;
  } catch (error) {
    deps.logger.error({ err: error }, 'user-admin could not shut down cleanly (audit flush or connections)');
    deps.stderr.write(
      'error: shutdown failed: the outcome reported above stands, but its audit row may not have been written\n',
    );
    return false;
  }
}

export async function run(argv: readonly string[], overrides: Partial<UserAdminDeps> = {}): Promise<number> {
  const deps: UserAdminDeps = { ...defaultDeps(), ...overrides };
  const cli = parseScriptArgs({
    argv,
    options: { username: { type: 'string' } },
    allowPositionals: true,
    usage: USAGE,
    io: deps,
    schema: ArgsSchema,
  });
  if (cli.kind === 'exit') return cli.code;
  const [op] = cli.args.positionals;

  let context: UserAdminContext;
  try {
    context = await deps.openContext(deps.logger);
  } catch (error) {
    deps.logger.error({ err: error }, 'could not start (configuration or connections)');
    deps.stderr.write('error: could not start: invalid configuration or unreachable dependencies\n');
    return EXIT_FAILURE;
  }
  let code: number;
  let closed: boolean;
  try {
    code = await applyOperation(deps, context, op, cli.args.username);
  } finally {
    // Also on an unexpected throw, so the connections never keep the process alive.
    closed = await closeContext(deps, context);
  }
  return closed ? code : EXIT_FAILURE;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
