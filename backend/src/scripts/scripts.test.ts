/**
 * Unit tests of the backend scripts' argument contracts and core failures (SPEC section 3.8 rule 6): `--help` -> 0, a bad flag
 * -> 1, and each script's main failure path -> 1, with injected I/O (no database, Redis or network). The user-admin CLI
 * is covered against the real database by test/integration/auth/user-admin-script.int.test.ts.
 */
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config/env.js';
import { run as exportOpenApi } from './export-openapi.js';
import { run as migrate } from './migrate.js';

const logger = pino({ level: 'silent' });
const config = loadConfig({
  DATABASE_URL: 'postgres://x:x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(40),
});

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('migrate', () => {
  it('prints the usage on --help (0) and rejects bad flags / directions (1)', async () => {
    const help = io();
    expect(await migrate(['--help'], { ...help, logger })).toBe(0);
    expect(help.out()).toContain('Usage: migrate <up|down>');
    for (const argv of [['--bogus'], ['sideways'], [], ['up', 'down'], ['down', '--count', 'x']]) {
      const bad = io();
      expect(await migrate(argv, { ...bad, logger }), argv.join(' ')).toBe(1);
      expect(bad.err()).toContain('Usage:');
    }
  });

  it('exits 1 when the migration fails', async () => {
    const runMigrations = vi.fn().mockRejectedValue(new Error('lock timeout'));
    expect(await migrate(['up'], { ...io(), logger, loadConfig: () => config, runMigrations })).toBe(1);
  });
});

describe('export-openapi', () => {
  it('handles --help and rejects conflicting or unknown flags', async () => {
    expect(await exportOpenApi(['--help'], { ...io(), logger })).toBe(0);
    expect(await exportOpenApi(['--stdout', '--out', 'x.json'], { ...io(), logger })).toBe(1);
    expect(await exportOpenApi(['--nope'], { ...io(), logger })).toBe(1);
  });

  it('exits 1 when the document cannot be generated', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await exportOpenApi(['--stdout'], { ...io(), logger, loadConfig: () => config, generate })).toBe(
      1,
    );
  });
});
