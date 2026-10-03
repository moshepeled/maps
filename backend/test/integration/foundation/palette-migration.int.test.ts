/**
 * Migration 0009 (decision D-6, ADR-0010, SPEC section 5.4/section 6.2): the collaborator palette changed from the v1.1 set to the
 * Studio set, and every stored `users.color` moves from v1.1 slot i to Studio slot i, so the colour registration derives
 * from the id (`USER_PALETTE[fnv1a32(id) mod 12]`) and the stored colour keep agreeing. On a scratch database migrated to
 * 0008, users seeded with every v1.1 colour (plus a colour outside the palette) are remapped by `up` and restored
 * exactly by `down`, through the real migrate CLI.
 */
import { USER_PALETTE } from '@snapland/shared';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run as migrate } from '../../../src/scripts/migrate.js';
import { TestDatabaseManager } from '../../setup/test-database.js';
import { testConfig, testRunId } from '../../helpers/test-app.js';

const MIGRATION = '0009_studio_palette_colors';

/** The v1.1 palette (tokens.css v1.1, SPEC v1.2 section 6.2) in slot order: what 0009 migrates away from. */
const V1_1_PALETTE = [
  '#a95208',
  '#6c4b01',
  '#35552a',
  '#0e7c24',
  '#15735c',
  '#2f747e',
  '#156eb0',
  '#641b84',
  '#ad38a0',
  '#7e1750',
  '#c02c52',
  '#572a0e',
];

/** The Studio palette of D-6 in slot order: what 0009 migrates to. Written out so the test does not share the code's list. */
const STUDIO_PALETTE = [
  '#b4f500',
  '#f461ff',
  '#ffab61',
  '#b86e3d',
  '#bcfab2',
  '#a64ef4',
  '#9888d7',
  '#ff8fcb',
  '#f6dd79',
  '#447ec1',
  '#c44f9d',
  '#5eae29',
];

/** Not a palette slot (e.g. a hand-edited row): the migration must leave it alone in both directions. */
const OFF_PALETTE = '#123456';
const SEEDED_UPDATED_AT = '2026-01-01T00:00:00.000Z';

/** One user per v1.1 slot, a second user on slot 11 (duplicates are normal: 12 slots, many users), and one off-palette. */
const SEED: readonly { username: string; color: string }[] = [
  ...V1_1_PALETTE.map((color, slot) => ({ username: `slot_${String(slot + 1).padStart(2, '0')}`, color })),
  { username: 'slot_11_again', color: '#c02c52' },
  { username: 'off_palette', color: OFF_PALETTE },
];

const logger = pino({ level: 'silent' });
let databases: TestDatabaseManager;
let scratchName: string;
let scratchUrl: string;
let client: pg.Client;

async function runMigrate(args: string[]): Promise<{ code: number; ran: string[] }> {
  let stdout = '';
  const code = await migrate(args, {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: () => true },
    loadConfig: () => testConfig({ DATABASE_URL: scratchUrl }),
    logger,
  });
  const summary = stdout.trim() === '' ? { ran: [] } : (JSON.parse(stdout) as { ran: string[] });
  return { code, ran: summary.ran };
}

async function storedColors(): Promise<Record<string, string>> {
  const { rows } = await client.query<{ username: string; color: string }>(
    'SELECT username, color FROM users ORDER BY username',
  );
  return Object.fromEntries(rows.map((row) => [row.username, row.color]));
}

async function updatedAtValues(): Promise<string[]> {
  const { rows } = await client.query<{ updated_at: Date }>('SELECT DISTINCT updated_at FROM users');
  return rows.map((row) => row.updated_at.toISOString());
}

function colorsBySlot(palette: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    SEED.map(({ username, color }) => {
      const slot = V1_1_PALETTE.indexOf(color);
      return [username, slot === -1 ? color : (palette[slot] ?? color)];
    }),
  );
}

beforeAll(async () => {
  databases = new TestDatabaseManager(process.env['TEST_DATABASE_ADMIN_URL'] ?? '', logger);
  scratchName = `snapland_it_${testRunId()}_pal`;
  scratchUrl = await databases.createScratchDatabase(scratchName);
  client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();

  const toPrevious = await runMigrate(['up', '--count', '8']);
  expect(toPrevious.code).toBe(0);
  expect(toPrevious.ran.at(-1)).toBe('0008_audit_analytics');
  await client.query(
    `INSERT INTO users (username, display_name, password_hash, color, updated_at)
     SELECT s.username, s.username, 'x', s.color, $3::timestamptz
     FROM unnest($1::text[], $2::text[]) AS s (username, color)`,
    [SEED.map((row) => row.username), SEED.map((row) => row.color), SEEDED_UPDATED_AT],
  );
});

afterAll(async () => {
  await client.end();
  await databases.dropRunDatabase(scratchName);
});

describe(`migration ${MIGRATION} (D-6)`, () => {
  it('targets the palette registration uses today (USER_PALETTE)', () => {
    // A later palette change needs its own slot-preserving migration; this assertion then moves to that migration's test.
    expect([...USER_PALETTE]).toEqual(STUDIO_PALETTE);
  });

  it('up moves every v1.1 colour to the Studio colour of the same slot and leaves other colours alone', async () => {
    expect(await storedColors()).toEqual(colorsBySlot(V1_1_PALETTE));

    expect(await runMigrate(['up', '--count', '1'])).toEqual({ code: 0, ran: [MIGRATION] });

    const after = await storedColors();
    expect(after).toEqual(colorsBySlot(STUDIO_PALETTE));
    expect(after['slot_11']).toBe('#c44f9d');
    expect(after['off_palette']).toBe(OFF_PALETTE);
    expect(await updatedAtValues()).toEqual([SEEDED_UPDATED_AT]);
  });

  it('keeps users_color_ck validated', async () => {
    const { rows } = await client.query<{ convalidated: boolean; violations: number }>(
      `SELECT c.convalidated, (SELECT count(*)::int FROM users WHERE color !~ '^#[0-9a-f]{6}$') AS violations
       FROM pg_constraint c WHERE c.conname = 'users_color_ck'`,
    );
    expect(rows).toEqual([{ convalidated: true, violations: 0 }]);
  });

  it('down restores the v1.1 colours exactly, and up re-applies', async () => {
    expect(await runMigrate(['down', '--count', '1'])).toEqual({ code: 0, ran: [MIGRATION] });
    expect(await storedColors()).toEqual(colorsBySlot(V1_1_PALETTE));
    expect(await updatedAtValues()).toEqual([SEEDED_UPDATED_AT]);

    expect(await runMigrate(['up', '--count', '1'])).toEqual({ code: 0, ran: [MIGRATION] });
    expect(await storedColors()).toEqual(colorsBySlot(STUDIO_PALETTE));
  });
});
