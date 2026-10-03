/**
 * Migrations 0001-0010 (SPEC section 5.2-section 5.4, R9/R16/R17/R18): up -> down -> up on a scratch database through the real CLI,
 * the v1.2 DDL details (BRIN autosummarize, actor_id without ON DELETE, immutability trigger, CHECKs), the create
 * statement's CCW storage and exact area, and the EXPLAIN acceptance of section 5.3 on 12,000 + 3,000 synthetic areas.
 */
import { LIMITS, lodForZoom } from '@snapland/shared';
import type { Bbox } from '@snapland/shared';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planBboxQuery } from '../../../src/infra/cache/key-plan.js';
import { DIRECTORY_SQL } from '../../../src/infra/directory/queries.js';
import { AREAS_SQL } from '../../../src/modules/areas/areas.repository.js';
import { run as migrate } from '../../../src/scripts/migrate.js';
import { TestDatabaseManager } from '../../setup/test-database.js';
import { fixture } from '../../helpers/fixtures.js';
import { testConfig, testRunId } from '../../helpers/test-app.js';

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

async function tables(): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  );
  return rows.map((row) => row.tablename);
}

async function explain(bbox: Bbox, zoom: number): Promise<{ plan: string; ms: number }> {
  const plan = planBboxQuery(bbox, zoom);
  const lod = lodForZoom(zoom);
  const params = [
    ...plan.queryBbox,
    lod.simplifyDeg,
    lod.digits,
    lod.minExtentDeg,
    null,
    2001,
    LIMITS.bboxPagePositionBudget,
  ];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
    const result = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${AREAS_SQL.findInBbox.text}`,
      params,
    );
    const text = result.rows.map((row) => row['QUERY PLAN']).join('\n');
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? Number.NaN);
    return { plan: text, ms };
  } finally {
    await client.query('ROLLBACK');
  }
}

beforeAll(async () => {
  databases = new TestDatabaseManager(process.env['TEST_DATABASE_ADMIN_URL'] ?? '', logger);
  scratchName = `snapland_it_${testRunId()}_mig`;
  scratchUrl = await databases.createScratchDatabase(scratchName);
  client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await databases.dropRunDatabase(scratchName);
});

describe('migrations 0001-0010 (section 5.4)', () => {
  it('apply up, revert with down --count 10, and re-apply cleanly', async () => {
    const up = await runMigrate(['up']);
    expect(up.code).toBe(0);
    expect(up.ran).toEqual([
      '0001_extensions',
      '0002_users',
      '0003_sessions',
      '0004_areas',
      '0005_area_versions',
      '0006_audit_logs',
      '0007_system_state',
      '0008_audit_analytics',
      '0009_studio_palette_colors',
      '0010_email_usernames',
    ]);
    expect(await tables()).toEqual(
      expect.arrayContaining(['area_versions', 'areas', 'audit_logs', 'sessions', 'system_state', 'users']),
    );

    const down = await runMigrate(['down', '--count', '10']);
    expect(down.code).toBe(0);
    expect(down.ran).toHaveLength(10);
    expect(
      (await tables()).filter((table) => table !== 'pgmigrations' && !table.startsWith('spatial')),
    ).toEqual([]);

    expect((await runMigrate(['up'])).ran).toHaveLength(10);
    expect((await runMigrate(['up'])).ran).toEqual([]);
  });

  it('rejects bad CLI arguments with exit 1', async () => {
    expect((await runMigrate(['sideways'])).code).toBe(1);
    expect((await runMigrate(['down', '--count', '0'])).code).toBe(1);
  });
});

describe('v1.2 DDL (section 5.2)', () => {
  let userId: string;

  beforeAll(async () => {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO users (username, display_name, password_hash, color) VALUES ('mig_user', 'Mig', 'x', '#c44f9d') RETURNING id",
    );
    userId = rows[0]?.id ?? '';
  });

  it('creates the BRIN index with autosummarize = on', async () => {
    const { rows } = await client.query<{ reloptions: string[] }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'audit_logs_occurred_at_brin'",
    );
    expect(rows[0]?.reloptions).toEqual(['autosummarize=on']);
  });

  it('declares area_versions.actor_id without an ON DELETE action', async () => {
    const { rows } = await client.query<{ confdeltype: string }>(
      "SELECT confdeltype FROM pg_constraint WHERE conname = 'area_versions_actor_id_fkey'",
    );
    expect(rows[0]?.confdeltype).toBe('a');
  });

  it('stores a clockwise ring counter-clockwise with the exact spheroid area, and keeps versions immutable', async () => {
    const ring = [...(fixture('tel_aviv_1km_square').geojson.coordinates[0] ?? [])].reverse();
    const id = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    await client.query(AREAS_SQL.insert.text, [
      id,
      'Rabin Square',
      null,
      JSON.stringify({ type: 'Polygon', coordinates: [ring] }),
      userId,
    ]);
    const { rows } = await client.query<{ area_km2: number; ccw: boolean }>(
      'SELECT area_km2, ST_IsPolygonCCW(geom) AS ccw FROM areas WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ area_km2: 0.9987007904701233, ccw: true });
    await client.query(AREAS_SQL.insertVersionFromCurrent.text, [
      id,
      'create',
      ['name', 'geometry'],
      false,
      null,
      userId,
      'req-1',
      null,
    ]);
    await expect(
      client.query("UPDATE area_versions SET name = 'x' WHERE area_id = $1", [id]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('rejects GEOS-invalid geometry through areas_geom_valid_ck', async () => {
    // The spike keeps a positive area, so the validity CHECK (not the area-range CHECK, evaluated first by name) fires.
    const spike = fixture('spike').geojson;
    await expect(
      client.query(AREAS_SQL.insert.text, [
        '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
        'Spike',
        null,
        JSON.stringify(spike),
        userId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'areas_geom_valid_ck' });
  });

  it('bounds audit details by JSON text size: 4,009 bytes accepted, 9 KB rejected', async () => {
    const insert =
      "INSERT INTO audit_logs (occurred_at, action, outcome, instance_id, details) VALUES (now(), 'area.create', 'success', 'it', $1)";
    await client.query(insert, [JSON.stringify({ blob: 'x'.repeat(3998) })]);
    await expect(client.query(insert, [JSON.stringify({ blob: 'x'.repeat(9000) })])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      client.query(
        "INSERT INTO audit_logs (occurred_at, action, outcome, instance_id) VALUES (now(), 'Bad Action', 'success', 'it')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('latestChangeSeq never falls below the purge watermark', async () => {
    const { rows: before } = await client.query<{ latest: string }>(DIRECTORY_SQL.latestChangeSeq.text);
    await client.query(
      "UPDATE system_state SET value = to_jsonb(1000000::bigint) WHERE key = 'change_feed_purge_watermark'",
    );
    const { rows: after } = await client.query<{ latest: string }>(DIRECTORY_SQL.latestChangeSeq.text);
    expect(Number(after[0]?.latest)).toBe(1_000_000);
    expect(Number(before[0]?.latest)).toBeLessThan(1_000_000);
    await client.query(
      "UPDATE system_state SET value = to_jsonb(0::bigint) WHERE key = 'change_feed_purge_watermark'",
    );
  });
});

describe('EXPLAIN acceptance with 12,000 region areas + 3,000 elsewhere (section 5.3)', () => {
  beforeAll(async () => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE username = 'mig_user'");
    const owner = rows[0]?.id ?? '';
    const insertSynthetic = `
      INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, change_seq, created_by, updated_by)
      SELECT gen_random_uuid(), 'synthetic ' || i, g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4,
             GREATEST(ST_XMax(g) - ST_XMin(g), ST_YMax(g) - ST_YMin(g)), nextval('area_change_seq'), $1, $1
      FROM (SELECT i, ST_MakeEnvelope(x, y, x + s, y + s, 4326) AS g
            FROM (SELECT i, $2::float8 + random() * $3::float8 AS x, $4::float8 + random() * $5::float8 AS y,
                         0.0002 + random() * 0.008 AS s
                  FROM generate_series(1, $6::int) AS i) AS p) AS q`;
    await client.query('SELECT setseed(0.42)');
    await client.query(insertSynthetic, [owner, 34.7, 0.24, 31.95, 0.24, 12_000]);
    await client.query(insertSynthetic, [owner, 34.3, 1.2, 29.6, 2.2, 3000]);
    await client.query('ANALYZE areas');
  });

  /** A ~700x500 px z14 window at Rabin Square: it snaps to one level-12 cache tile (~11 % of the region). */
  const telAvivZ14: Bbox = [34.76, 32.07, 34.79, 32.085];
  /** A 1280x720 px z16 window over the same spot. */
  const telAvivZ16: Bbox = [34.766, 32.074, 34.794, 32.087];
  /** A 1280x720 px z14 window: its snapped bbox (~25 % of the region) matches more rows than the 2,001-row page. */
  const telAvivZ14FullHd: Bbox = [34.725, 32.054, 34.835, 32.106];

  it.each([
    ['zoom 14', telAvivZ14, 14],
    ['zoom 16', telAvivZ16, 16],
  ] as const)(
    '%s viewport over Tel Aviv uses areas_geom_live_gist and never a Seq Scan on areas',
    async (_label, bbox, zoom) => {
      const { plan } = await explain(bbox, zoom);
      expect(plan).toMatch(/(Bitmap Index Scan on|Index Scan using) areas_geom_live_gist/);
      expect(plan).not.toContain('Seq Scan on areas');
    },
  );

  it('a larger zoom-14 window never seq-scans and stays fast (the planner may pick the id-ordered pkey scan)', async () => {
    // When the snapped bbox matches more rows than LIMIT, walking areas_pkey in id order and stopping at the page
    // limit is a legitimate plan (the section 5.3 rationale for zoom 12); the plan is logged for the benchmark record.
    const { plan, ms } = await explain(telAvivZ14FullHd, 14);
    process.stdout.write(`
[migrations.int] zoom-14 1280×720 plan (${ms} ms):
${plan}
`);
    expect(plan).not.toContain('Seq Scan on areas');
    expect(ms).toBeLessThanOrEqual(250);
  });

  it('the zoom-12 whole-region query completes within 250 ms (plan logged)', async () => {
    const { plan, ms } = await explain([34.7, 31.95, 34.95, 32.2], 12);
    process.stdout.write(`\n[migrations.int] zoom-12 region plan (${ms} ms):\n${plan}\n`);
    expect(ms).toBeLessThanOrEqual(250);
  });
});
