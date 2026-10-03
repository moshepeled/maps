/**
 * Database port (SPEC section 3.3). Repositories only ever run `NamedSql` statements with `$n` parameters; the name doubles
 * as the server-side prepared statement name and the `query` metric label.
 */
import type pg from 'pg';
import type { QueryResultRow } from 'pg';

export interface NamedSql {
  /** `<module>.<operation>`, e.g. `areas.findInBbox`. */
  readonly name: string;
  readonly text: string;
}

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  /**
   * Overrides both timeouts for this transaction only: `SET LOCAL statement_timeout = <timeoutMs>` and a per-query
   * client `query_timeout` of `timeoutMs + 1000` (the pool-wide `query_timeout` would otherwise abort long retention
   * batches client-side, section 5.6).
   */
  timeoutMs?: number;
}

export interface DbTx {
  query<R extends QueryResultRow>(stmt: NamedSql, params?: readonly unknown[]): Promise<R[]>;
}

export interface Db {
  readonly pool: pg.Pool;
  query<R extends QueryResultRow>(stmt: NamedSql, params?: readonly unknown[]): Promise<R[]>;
  withTransaction<T>(fn: (tx: DbTx) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** Round-trip latency in ms; throws on failure. */
  ping(timeoutMs: number): Promise<number>;
}

/**
 * Text of every statement declared in this process, by name. The name is also the server-side prepared statement
 * name, and PostgreSQL rejects one name with two texts ("Prepared statements must be unique") only on the pooled
 * connections that already prepared the other - intermittent failures. Declarations are module-level constants, so a
 * clash is caught once, at import time, where it is obvious.
 */
const declaredStatements = new Map<string, string>();

/** Declares a named statement (a frozen `{ name, text }`); a name re-declared with another text throws. */
export function sql(name: string, text: string): NamedSql {
  if (!/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`NamedSql name must look like <module>.<operation>, got ${name}`);
  }
  const declared = declaredStatements.get(name);
  if (declared !== undefined && declared !== text) {
    throw new Error(`NamedSql name ${name} is already declared with a different statement text`);
  }
  declaredStatements.set(name, text);
  return Object.freeze({ name, text });
}
