/**
 * Database migrations CLI (SPEC section 5.4): `npm run migrate -w @snapland/backend -- up|down [--count N]`; in the image,
 * `node dist/scripts/migrate.js up` (the compose `migrate` one-shot). Concurrent runners serialise on the advisory
 * lock. Prints a one-line JSON summary on stdout.
 */
import { z } from 'zod';

import { loadConfigFromEnv } from '../config/env.js';
import type { AppConfig } from '../config/env.js';
import { EXIT_FAILURE, EXIT_OK, createScriptLogger, isEntryPoint, parseScriptArgs } from '../infra/cli.js';
import type { ScriptIo } from '../infra/cli.js';
import { runMigrations } from '../infra/db/migrations.js';
import type { RunMigrationsOptions } from '../infra/db/migrations.js';
import type { Logger } from '../infra/logger.js';

const USAGE = `Usage: migrate <up|down> [--count <n>]

  up            apply every pending migration (or the next <n>)
  down          revert the last migration (or the last <n>)
  --count <n>   number of migrations (positive integer)
  -h, --help    show this help

Reads DATABASE_URL (and the rest of the validated configuration) from the environment / repository .env.`;

const ArgsSchema = z.object({
  positionals: z.tuple([z.enum(['up', 'down'])], { message: 'expected exactly one direction: up or down' }),
  count: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .transform(Number)
    .optional(),
});

export interface MigrateDeps extends ScriptIo {
  loadConfig(): AppConfig;
  runMigrations(options: RunMigrationsOptions): Promise<string[]>;
  logger: Logger;
}

function defaultDeps(): MigrateDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    loadConfig: loadConfigFromEnv,
    runMigrations,
    logger: createScriptLogger('migrate'),
  };
}

export async function run(argv: readonly string[], overrides: Partial<MigrateDeps> = {}): Promise<number> {
  const deps: MigrateDeps = { ...defaultDeps(), ...overrides };
  const cli = parseScriptArgs({
    argv,
    options: { count: { type: 'string' } },
    allowPositionals: true,
    usage: USAGE,
    io: deps,
    schema: ArgsSchema,
  });
  if (cli.kind === 'exit') return cli.code;
  const [direction] = cli.args.positionals;

  try {
    const config = deps.loadConfig();
    const ran = await deps.runMigrations({
      databaseUrl: config.DATABASE_URL,
      direction,
      ...(cli.args.count === undefined ? {} : { count: cli.args.count }),
      logger: deps.logger,
    });
    deps.logger.info({ direction, ran }, 'migrations finished');
    deps.stdout.write(`${JSON.stringify({ direction, ran })}\n`);
    return EXIT_OK;
  } catch (error) {
    deps.logger.error({ err: error, direction }, 'migration failed');
    return EXIT_FAILURE;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
