import { describe, expect, it } from 'vitest';

import { AppError } from '../../infra/http/errors.js';
import { assertGeosAccepts, geosIssues, translateCheckViolation } from './geometry-pipeline.js';

describe('stage 13: PostGIS verdict (section 9.2)', () => {
  it('accepts a valid geometry with an area in range', () => {
    expect(geosIssues({ valid: true, reason: 'Valid Geometry', areaKm2: 1 })).toEqual([]);
    expect(() => {
      assertGeosAccepts({ valid: true, reason: null, areaKm2: 1 });
    }).not.toThrow();
  });

  it('maps ST_IsValid = false to GEOS_INVALID with the reason', () => {
    expect(geosIssues({ valid: false, reason: 'Self-intersection[1 2]', areaKm2: 1 })).toEqual([
      { code: 'GEOS_INVALID', message: 'Self-intersection[1 2]', path: 'geometry' },
    ]);
    expect(geosIssues({ valid: false, reason: null, areaKm2: null })[0]?.code).toBe('GEOS_INVALID');
    expect(() => {
      assertGeosAccepts({ valid: false, reason: 'x', areaKm2: 1 });
    }).toThrow(AppError);
  });

  it('maps an out-of-range PostGIS area to AREA_TOO_SMALL / AREA_TOO_LARGE', () => {
    expect(geosIssues({ valid: true, reason: null, areaKm2: 1e-7 })[0]?.code).toBe('AREA_TOO_SMALL');
    expect(geosIssues({ valid: true, reason: null, areaKm2: null })[0]?.code).toBe('AREA_TOO_SMALL');
    expect(geosIssues({ valid: true, reason: null, areaKm2: 100_001 })[0]?.code).toBe('AREA_TOO_LARGE');
  });
});

describe('translateCheckViolation (GEOS / CHECK -> 422, section 6.3)', () => {
  const violation = (constraint: string, table = 'areas') => ({ code: '23514', table, constraint });

  it('a geometry CHECK on areas is 422 INVALID_GEOMETRY (GEOS_INVALID)', () => {
    const error = translateCheckViolation(violation('areas_geom_valid_ck'));
    expect(error?.code).toBe('INVALID_GEOMETRY');
    expect(error?.status).toBe(422);
    expect(JSON.stringify(error?.extensions)).toContain('areas_geom_valid_ck');
    expect(translateCheckViolation(violation('areas_area_range_ck'))?.code).toBe('INVALID_GEOMETRY');
  });

  it('a text CHECK is a 400 on the field', () => {
    const error = translateCheckViolation(violation('areas_name_len_ck'));
    expect(error?.code).toBe('VALIDATION_FAILED');
    expect(error?.extensions['errors']).toEqual([
      { path: 'name', code: 'check_violation', message: 'violates areas_name_len_ck' },
    ]);
  });

  it('anything else is left to the caller', () => {
    expect(translateCheckViolation(violation('area_versions_op_ck', 'area_versions'))).toBeNull();
    expect(translateCheckViolation({ code: '23505', table: 'areas' })).toBeNull();
    expect(translateCheckViolation(new Error('boom'))).toBeNull();
    expect(translateCheckViolation(null)).toBeNull();
    expect(translateCheckViolation({ code: '23514', table: 'areas' })?.code).toBe('INVALID_GEOMETRY');
  });
});
