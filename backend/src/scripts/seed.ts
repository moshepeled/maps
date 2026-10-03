/**
 * Benchmark dataset (docs/BENCHMARKS.md): `npm run seed -w @snapland/backend -- --count 15000 --region-count 12000`;
 * in compose, `docker compose --profile tools run --rm seed --count 15000 --region-count 12000 --seed 42`.
 *
 * Creates `--users` accounts bench-001... (role user, password SEED_USER_PASSWORD) and `--count` valid polygons:
 * `--region-count` inside the Tel Aviv region, the rest in southern Israel. Areas are written by the production
 * statements (AREAS_SQL.insert + insertVersionFromCurrent under the change-feed lock), so measurements, version 1 and
 * change_seq are exactly what POST /api/v1/areas writes. Deterministic and idempotent: one --seed always yields the same
 * ids and shapes, and a re-run inserts nothing new. The bbox cache is not invalidated, so seed before serving reads
 * (cached pages expire within CACHE_BBOX_TTL_S anyway). Prints a one-line JSON summary on stdout.
 */
import { createHash, randomUUID } from 'node:crypto';

import { USER_PALETTE } from '@snapland/shared';
import type { Bbox, PolygonGeometry, Position } from '@snapland/shared';
import { z } from 'zod';

import { loadConfigFromEnv } from '../config/env.js';
import { EXIT_FAILURE, EXIT_OK, createScriptLogger, isEntryPoint, parseScriptArgs } from '../infra/cli.js';
import type { ScriptIo } from '../infra/cli.js';
import { createDb, createPool } from '../infra/db/pool.js';
import type { Db } from '../infra/db/types.js';
import type { Logger } from '../infra/logger.js';
import { createMetrics } from '../infra/metrics/metrics.js';
import { AREAS_SQL } from '../modules/areas/areas.repository.js';
import { validateGeometryInput } from '../modules/areas/geometry-pipeline.js';
import { MERGE_FIELDS } from '../modules/areas/merge.js';
import { createPasswordHasher } from '../modules/auth/passwords.js';
import { USERS_SQL } from '../modules/auth/users.repository.js';

const USAGE = `Usage: seed [--count <n>] [--region-count <n>] [--seed <n>] [--users <n>]

  --count <n>          polygons in total (default 15000)
  --region-count <n>   of which inside the Tel Aviv region [34.7, 31.95, 34.95, 32.2] (default 12000)
  --seed <n>           PRNG seed: the same seed gives the same ids and shapes (default 42)
  --users <n>          accounts bench-001... with password SEED_USER_PASSWORD (default 50, at most 999)
  -h, --help           show this help

Reads DATABASE_URL, SEED_USER_PASSWORD and the rest of the validated configuration from the environment / .env.`;

/** The benchmark region (the EXPLAIN acceptance test uses the same one) and a disjoint box for the other areas. */
export const REGION: Bbox = [34.7, 31.95, 34.95, 32.2];
export const ELSEWHERE: Bbox = [34.3, 29.6, 35.4, 31.8];

/** Areas per transaction: each one holds the change-feed lock, so API writers wait at most one batch. */
const BATCH_SIZE = 500;
const METERS_PER_DEGREE_LAT = 111_320;

function wholeNumber(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

export const SeedArgsSchema = z
  .object({
    count: wholeNumber(1, 1_000_000).default(15_000),
    'region-count': wholeNumber(0, 1_000_000).default(12_000),
    seed: wholeNumber(0, 0xffff_ffff).default(42),
    users: wholeNumber(1, 999).default(50),
  })
  .refine((args) => args['region-count'] <= args.count, {
    message: 'must not exceed --count',
    path: ['region-count'],
  });

type SeedArgs = z.output<typeof SeedArgsSchema>;

/** mulberry32: a tiny deterministic PRNG in [0, 1), so one --seed always produces the same dataset. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A star-shaped polygon inside `box`: 5-40 vertices at strictly increasing angles around a random centre, each at
 * 60-100 % of a radius drawn log-uniformly from [minRadiusM, maxRadiusM]. Vertices on distinct rays, in angular order,
 * can never make edges cross, so the ring is always simple.
 */
function randomPolygon(
  random: () => number,
  box: Bbox,
  minRadiusM: number,
  maxRadiusM: number,
): PolygonGeometry {
  const [west, south, east, north] = box;
  const radiusM = minRadiusM * (maxRadiusM / minRadiusM) ** random();
  const marginLat = maxRadiusM / METERS_PER_DEGREE_LAT;
  const lat = south + marginLat + random() * (north - south - 2 * marginLat);
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const marginLng = maxRadiusM / metersPerDegreeLng;
  const lng = west + marginLng + random() * (east - west - 2 * marginLng);
  const vertices = 5 + Math.floor(random() * 36);

  const vertex = (k: number): Position => {
    const angle = ((k + 0.1 + 0.8 * random()) / vertices) * 2 * Math.PI;
    const r = radiusM * (0.6 + 0.4 * random());
    return [
      lng + (r * Math.cos(angle)) / metersPerDegreeLng,
      lat + (r * Math.sin(angle)) / METERS_PER_DEGREE_LAT,
    ];
  };
  const first = vertex(0);
  const ring = [first];
  for (let k = 1; k < vertices; k += 1) ring.push(vertex(k));
  ring.push(first);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Region polygons are 15 m-800 m in radius (the smallest are culled at low zoom), the others 30 m-3 km. */
export function seedPolygon(random: () => number, inRegion: boolean): PolygonGeometry {
  return inRegion ? randomPolygon(random, REGION, 15, 800) : randomPolygon(random, ELSEWHERE, 30, 3000);
}

/** A deterministic UUID (version 4 layout) per seed and index: re-runs hit `ON CONFLICT (id) DO NOTHING`. */
export function seedAreaId(seed: number, index: number): string {
  const hex = createHash('sha256').update(`snapland-seed:${seed}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Finds or creates bench-001...; existing accounts are left unchanged. Returns every id and how many were new. */
async function seedUsers(
  db: Db,
  count: number,
  password: string,
): Promise<{ ids: string[]; created: number }> {
  const passwords = createPasswordHasher();
  const ids: string[] = [];
  let created = 0;
  for (let n = 1; n <= count; n += 1) {
    const suffix = String(n).padStart(3, '0');
    const username = `bench-${suffix}`;
    const [existing] = await db.query<{ id: string }>(USERS_SQL.findByUsername, [username]);
    if (existing !== undefined) {
      ids.push(existing.id);
      continue;
    }
    const passwordHash = await passwords.hash(password);
    const color = USER_PALETTE[(n - 1) % USER_PALETTE.length];
    const [row] = await db.query<{ id: string }>(USERS_SQL.insert, [
      randomUUID(),
      username,
      `Bench ${suffix}`,
      passwordHash,
      color,
    ]);
    if (row === undefined) throw new Error(`${USERS_SQL.insert.name} returned no row`);
    ids.push(row.id);
    created += 1;
  }
  return { ids, created };
}

/** Inserts the polygons in batched transactions, exactly as the create path does. Returns how many were new. */
async function seedAreas(
  db: Db,
  args: SeedArgs,
  userIds: readonly string[],
  logger: Logger,
): Promise<number> {
  const random = seededRandom(args.seed);
  let inserted = 0;
  for (let start = 0; start < args.count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, args.count);
    inserted += await db.withTransaction(async (tx) => {
      // Held to COMMIT, as in the API, so change_seq order equals commit order (gap-free change feed).
      await tx.query(AREAS_SQL.lockChangeFeed);
      let batchInserted = 0;
      for (let index = start; index < end; index += 1) {
        const id = seedAreaId(args.seed, index);
        const actorId = userIds[index % userIds.length];
        // The server's validation and normalisation (7 dp, RFC 7946 winding): throws if a shape were ever invalid.
        const geometry = validateGeometryInput(seedPolygon(random, index < args['region-count']));
        const rows = await tx.query(AREAS_SQL.insert, [
          id,
          `Bench area ${index + 1}`,
          null,
          JSON.stringify(geometry),
          actorId,
        ]);
        if (rows.length === 0) continue; // already seeded
        await tx.query(AREAS_SQL.insertVersionFromCurrent, [
          id,
          'create',
          [...MERGE_FIELDS],
          false,
          null,
          actorId,
          null,
          null,
        ]);
        batchInserted += 1;
      }
      return batchInserted;
    });
    logger.info({ done: end, of: args.count }, 'areas batch committed');
  }
  return inserted;
}

export interface SeedDeps extends ScriptIo {
  logger: Logger;
}

export async function run(argv: readonly string[], overrides: Partial<SeedDeps> = {}): Promise<number> {
  const deps: SeedDeps = {
    stdout: process.stdout,
    stderr: process.stderr,
    logger: createScriptLogger('seed'),
    ...overrides,
  };
  const cli = parseScriptArgs({
    argv,
    options: {
      count: { type: 'string' },
      'region-count': { type: 'string' },
      seed: { type: 'string' },
      users: { type: 'string' },
    },
    usage: USAGE,
    io: deps,
    schema: SeedArgsSchema,
  });
  if (cli.kind === 'exit') return cli.code;
  const args = cli.args;

  let db: Db | undefined;
  try {
    const config = loadConfigFromEnv();
    if (config.SEED_USER_PASSWORD === undefined) {
      deps.stderr.write('error: SEED_USER_PASSWORD is not set (see .env.example)\n');
      return EXIT_FAILURE;
    }
    db = createDb({
      pool: createPool(config, 'seed'),
      metrics: createMetrics(config, 'seed'),
      logger: deps.logger,
    });
    const users = await seedUsers(db, args.users, config.SEED_USER_PASSWORD);
    const inserted = await seedAreas(db, args, users.ids, deps.logger);
    // Fresh planner statistics after a bulk load, so the first measured queries use the real plans.
    await db.pool.query('ANALYZE areas');
    const summary = {
      users: { total: users.ids.length, created: users.created },
      areas: { total: args.count, region: args['region-count'], inserted },
      seed: args.seed,
    };
    deps.logger.info(summary, 'seed finished');
    deps.stdout.write(`${JSON.stringify(summary)}\n`);
    return EXIT_OK;
  } catch (error) {
    deps.logger.error({ err: error }, 'seed failed');
    return EXIT_FAILURE;
  } finally {
    await db?.pool.end();
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
