/**
 * The server side of the polygon validation pipeline (SPEC section 9.2). Stages 1-12 run the shared `validatePolygon` (the
 * same function the client runs for live feedback) and yield the normalised polygon; stage 13 interprets PostGIS'
 * verdict. Every domain failure is 422 INVALID_GEOMETRY with the stage's sub-codes - never 400, which is reserved for
 * the transport shape (stage 0, Fastify). A CHECK violation raised while writing is mapped here as well (third line of
 * defence), so the service can audit it like any other outcome.
 */
import { LIMITS, validatePolygon } from '@snapland/shared';
import type { GeometryIssue, PolygonGeometry, PolygonGeometryIn } from '@snapland/shared';

import { InvalidGeometryError, ValidationError } from '../../infra/http/errors.js';
import type { AppError } from '../../infra/http/errors.js';

/**
 * Stages 1-12: structure, numbers, ranges, closure, normalisation (7 dp, deduplication), counts, antimeridian, extent,
 * ring simplicity, holes, winding and geodesic area.
 * @returns the normalised polygon (7 dp, consecutive duplicates removed, RFC 7946 winding)
 * @throws InvalidGeometryError with every issue of the first failing stage
 */
export function validateGeometryInput(geometry: PolygonGeometryIn): PolygonGeometry {
  const result = validatePolygon(geometry);
  if (!result.ok) throw new InvalidGeometryError(result.issues);
  return result.polygon;
}

/** Stage 13 of section 9.2: PostGIS' verdict on a candidate geometry (`areas.checkGeometry`). */
export interface GeometryCheck {
  valid: boolean;
  reason: string | null;
  areaKm2: number | null;
}

/** Stage 13: PostGIS disagreed with the shared validator (`ST_IsValid`), or its geodesic area is out of range. */
export function geosIssues(check: GeometryCheck): GeometryIssue[] {
  if (!check.valid) {
    return [
      {
        code: 'GEOS_INVALID',
        message: check.reason ?? 'PostGIS reports the geometry as invalid.',
        path: 'geometry',
      },
    ];
  }
  const areaKm2 = check.areaKm2 ?? 0;
  if (areaKm2 < LIMITS.minAreaKm2) {
    return [
      {
        code: 'AREA_TOO_SMALL',
        message: `The area must be at least ${LIMITS.minAreaKm2} km² (1 m²).`,
        path: 'geometry.coordinates',
      },
    ];
  }
  if (areaKm2 > LIMITS.maxAreaKm2) {
    return [
      {
        code: 'AREA_TOO_LARGE',
        message: `The area must be at most ${LIMITS.maxAreaKm2} km².`,
        path: 'geometry.coordinates',
      },
    ];
  }
  return [];
}

/** @throws InvalidGeometryError when stage 13 fails */
export function assertGeosAccepts(check: GeometryCheck): void {
  const issues = geosIssues(check);
  if (issues.length > 0) throw new InvalidGeometryError(issues);
}

const CHECK_VIOLATION = '23514';
/** Text constraints: after sanitisation they cannot fail, but if they ever do, the field is named in a 400. */
const TEXT_CONSTRAINTS: Readonly<Record<string, string>> = {
  areas_name_len_ck: 'name',
  areas_description_len_ck: 'description',
};

function pgField(error: unknown, field: 'code' | 'constraint' | 'table'): string | undefined {
  if (typeof error !== 'object' || error === null || !(field in error)) return undefined;
  const value: unknown = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps a CHECK violation (`23514`) on the `areas` table to the client error it stands for: a text constraint -> 400
 * VALIDATION_FAILED, any other (geometry validity, point count, area range) -> 422 INVALID_GEOMETRY (GEOS_INVALID).
 * Returns null for anything else (the caller rethrows it unchanged).
 */
export function translateCheckViolation(error: unknown): AppError | null {
  if (pgField(error, 'code') !== CHECK_VIOLATION || pgField(error, 'table') !== 'areas') return null;
  const constraint = pgField(error, 'constraint') ?? 'unknown';
  const textField = TEXT_CONSTRAINTS[constraint];
  if (textField !== undefined) {
    return new ValidationError(`${textField} was rejected by the database.`, [
      { path: textField, code: 'check_violation', message: `violates ${constraint}` },
    ]);
  }
  return new InvalidGeometryError([
    { code: 'GEOS_INVALID', message: `PostgreSQL rejected the geometry (${constraint}).`, path: 'geometry' },
  ]);
}
