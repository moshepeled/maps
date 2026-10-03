/**
 * Per-run PostgreSQL databases for integration tests (SPEC section 12.2). A migrated TEMPLATE database, keyed by a hash of
 * the migration files, is built once and reused; each run clones it with `CREATE DATABASE ... TEMPLATE ...` (fast) into
 * `snapland_it_<runId>`, so concurrent runs never share tables. Template work happens under
 * an advisory lock on the admin database. Databases of crashed runs older than `STALE_RUN_MS` are dropped.
 *
 * Database identifiers cannot be bind parameters; every name used here is validated against a strict pattern first.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import { MIGRATIONS_DIR, listMigrationNames, runMigrations } from '../../src/infra/db/migrations.js';
import type { Logger } from '../../src/infra/logger.js';

export const RUN_DATABASE_PREFIX = 'snapland_it_';
export const TEMPLATE_PREFIX = `${RUN_DATABASE_PREFIX}tpl_`;
/** Runs older than this are considered crashed; their databases and Redis keys are garbage-collected. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

/** Arbitrary constant of the template-build advisory lock (admin database). */
const TEMPLATE_LOCK_KEY = 7_210_099;
const SAFE_IDENTIFIER = /^[a-z0-9_]{1,63}$/;

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
}

/** Replaces the database of a connection URL. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Short content hash of every migration file: a new or changed migration yields a new template. */
async function migrationsHash(dir: string = MIGRATIONS_DIR): Promise<string> {
  const hash = createHash('sha256');
  for (const name of await listMigrationNames(dir)) {
    hash.update(name);
    hash.update(await readFile(join(dir, `${name}.sql`)));
  }
  return hash.digest('hex').slice(0, 12);
}

/** The creation time encoded in a run id (`Date.now().toString(36)` prefix), or null. */
export function runIdTimestamp(runId: string): number | null {
  const timestamp = Number.parseInt(runId.slice(0, 8), 36);
  return Number.isFinite(timestamp) && runId.length >= 8 ? timestamp : null;
}

export class TestDatabaseManager {
  readonly #adminUrl: string;
  readonly #logger: Logger;

  constructor(adminUrl: string, logger: Logger) {
    this.#adminUrl = adminUrl;
    this.#logger = logger;
  }

  /** Clones the (possibly freshly built) template into `snapland_it_<runId>` and returns its name. */
  async createRunDatabase(runId: string): Promise<string> {
    const runDatabase = `${RUN_DATABASE_PREFIX}${runId}`;
    const template = `${TEMPLATE_PREFIX}${await migrationsHash()}`;
    await this.#withAdmin(async (admin) => {
      await admin.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
      try {
        await this.#ensureTemplate(admin, template);
        await this.#dropStale(admin, template);
        await admin.query(
          `CREATE DATABASE ${quoteIdentifier(runDatabase)} TEMPLATE ${quoteIdentifier(template)}`,
        );
      } finally {
        await admin.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]);
      }
    });
    return runDatabase;
  }

  async dropRunDatabase(runDatabase: string): Promise<void> {
    await this.#withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(runDatabase)} WITH (FORCE)`);
    });
  }

  /** Creates an empty scratch database (with PostGIS available) for tests that migrate on their own. */
  async createScratchDatabase(name: string): Promise<string> {
    await this.#withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    });
    return withDatabase(this.#adminUrl, name);
  }

  async #withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: this.#adminUrl, application_name: 'snapland-it-admin' });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  async #ensureTemplate(admin: pg.Client, template: string): Promise<void> {
    const existing = await admin.query<{ datistemplate: boolean }>(
      'SELECT datistemplate FROM pg_database WHERE datname = $1',
      [template],
    );
    if (existing.rows[0]?.datistemplate === true) return;
    if (existing.rows.length > 0) {
      // A previous build crashed before marking the database as a template: rebuild it from scratch.
      await admin.query(`DROP DATABASE ${quoteIdentifier(template)} WITH (FORCE)`);
    }
    this.#logger.info({ template }, 'building the migrated integration-test template database');
    await admin.query(`CREATE DATABASE ${quoteIdentifier(template)}`);
    await runMigrations({
      databaseUrl: withDatabase(this.#adminUrl, template),
      direction: 'up',
      logger: this.#logger,
    });
    await admin.query(
      `ALTER DATABASE ${quoteIdentifier(template)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
  }

  /** Drops databases of crashed runs and templates of older migration sets (never the current template). */
  async #dropStale(admin: pg.Client, currentTemplate: string): Promise<void> {
    const { rows } = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${RUN_DATABASE_PREFIX}%`],
    );
    const now = Date.now();
    for (const { datname } of rows) {
      if (datname === currentTemplate) continue;
      if (datname.startsWith(TEMPLATE_PREFIX)) {
        await admin.query(`ALTER DATABASE ${quoteIdentifier(datname)} WITH IS_TEMPLATE false`);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)} WITH (FORCE)`);
        continue;
      }
      const timestamp = runIdTimestamp(datname.slice(RUN_DATABASE_PREFIX.length));
      if (timestamp !== null && now - timestamp > STALE_RUN_MS) {
        this.#logger.warn({ database: datname }, 'dropping the database of a stale integration-test run');
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)} WITH (FORCE)`);
      }
    }
  }
}
