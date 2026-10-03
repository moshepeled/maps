/**
 * Migrations (SPEC section 5.4): node-pg-migrate over the SQL files in `backend/migrations/`, one transaction per file,
 * advisory lock in `wait` mode so concurrent runners serialise, order checked. Shared by the migrate CLI, the
 * integration-test global setup and the readiness check (pending migrations).
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';

import type { Logger } from '../logger.js';
import { pgErrorCode } from './execute.js';
import type { Db } from './types.js';
import { sql } from './types.js';

/** `backend/migrations`, resolved from this module (identical layout under `src/` and `dist/`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));
const MIGRATIONS_TABLE = 'pgmigrations';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const UNDEFINED_TABLE = '42P01';

const APPLIED_MIGRATIONS = sql(
  'migrations.applied',
  `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on, id`,
);

export type MigrationDirection = 'up' | 'down';

export interface RunMigrationsOptions {
  databaseUrl: string;
  direction: MigrationDirection;
  /** Number of migrations to apply/revert; default: all pending (up) or 1 (down). */
  count?: number;
  logger: Logger;
  dir?: string;
}

/** Migration names (file names without `.sql`), in order. */
export async function listMigrationNames(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
    .map((file) => file.slice(0, -'.sql'.length));
}

/** Applies or reverts migrations; returns the names that ran. */
export async function runMigrations(options: RunMigrationsOptions): Promise<string[]> {
  const log = options.logger.child({ component: 'migrations' });
  const ran = await runner({
    databaseUrl: options.databaseUrl,
    dir: options.dir ?? MIGRATIONS_DIR,
    direction: options.direction,
    count: options.count ?? (options.direction === 'up' ? Number.POSITIVE_INFINITY : 1),
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    singleTransaction: false,
    advisoryLockMode: 'wait',
    logger: {
      debug: (message: string) => {
        log.debug(message);
      },
      info: (message: string) => {
        log.info(message);
      },
      warn: (message: string) => {
        log.warn(message);
      },
      error: (message: string) => {
        log.error(message);
      },
    },
  });
  return ran.map((migration) => migration.name);
}

/** Number of migration files not yet applied (readiness, section 5.4). A missing migrations table means all are pending. */
export async function countPendingMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<number> {
  const names = await listMigrationNames(dir);
  let applied: Set<string>;
  try {
    applied = new Set((await db.query<{ name: string }>(APPLIED_MIGRATIONS)).map((row) => row.name));
  } catch (error) {
    if (pgErrorCode(error) === UNDEFINED_TABLE) return names.length;
    throw error;
  }
  return names.filter((name) => !applied.has(name)).length;
}
