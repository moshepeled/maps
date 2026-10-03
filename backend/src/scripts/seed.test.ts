/**
 * Unit tests of the seed script's pure parts: the argument contract and the polygon generator. The database writes are
 * proven by running the script against the benchmark stack (docs/BENCHMARKS.md), where a second run inserts nothing.
 */
import { validatePolygon } from '@snapland/shared';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { ELSEWHERE, REGION, SeedArgsSchema, run, seedAreaId, seedPolygon, seededRandom } from './seed.js';

const logger = pino({ level: 'silent' });

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

describe('seed arguments', () => {
  it('prints the usage on --help (0)', async () => {
    const help = io();
    expect(await run(['--help'], { ...help, logger })).toBe(0);
    expect(help.out()).toContain('Usage: seed');
  });

  it.each([
    ['--bogus'],
    ['extra-positional'],
    ['--count', 'x'],
    ['--count', '0'],
    ['--count', '-5'],
    ['--users', '1000'],
    ['--count', '10', '--region-count', '11'],
  ])('rejects %s (1, usage on stderr)', async (...argv) => {
    const bad = io();
    expect(await run(argv, { ...bad, logger })).toBe(1);
    expect(bad.err()).toContain('Usage: seed');
  });

  it('applies the documented defaults and parses the compose flags', () => {
    expect(SeedArgsSchema.parse({})).toEqual({ count: 15_000, 'region-count': 12_000, seed: 42, users: 50 });
    expect(SeedArgsSchema.parse({ count: '50000', 'region-count': '12000', seed: '7', users: '20' })).toEqual(
      {
        count: 50_000,
        'region-count': 12_000,
        seed: 7,
        users: 20,
      },
    );
  });
});

describe('seed polygons', () => {
  it.each([
    ['region', true, REGION],
    ['elsewhere', false, ELSEWHERE],
  ] as const)('%s polygons pass the shared validator and stay inside their box', (_label, inRegion, box) => {
    const random = seededRandom(42);
    for (let i = 0; i < 500; i += 1) {
      const polygon = seedPolygon(random, inRegion);
      const result = validatePolygon(polygon);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const ring = polygon.coordinates[0] ?? [];
      expect(ring.length - 1).toBeGreaterThanOrEqual(5);
      expect(ring.length - 1).toBeLessThanOrEqual(40);
      const [west, south, east, north] = box;
      for (const [lng, lat] of ring) {
        expect(lng >= west && lng <= east && lat >= south && lat <= north).toBe(true);
      }
    }
  });

  it('is deterministic per seed', () => {
    expect(seedPolygon(seededRandom(42), true)).toEqual(seedPolygon(seededRandom(42), true));
    expect(seedPolygon(seededRandom(42), true)).not.toEqual(seedPolygon(seededRandom(43), true));
  });

  it('derives stable, distinct UUIDs from the seed and the index', () => {
    const id = seedAreaId(42, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedAreaId(42, 0)).toBe(id);
    expect(new Set([id, seedAreaId(42, 1), seedAreaId(43, 0)]).size).toBe(3);
  });
});
