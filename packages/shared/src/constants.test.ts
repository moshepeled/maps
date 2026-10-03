import { describe, expect, it } from 'vitest';

import { COLOR_PATTERN, USER_PALETTE } from './constants.js';
import { ERRORS, ERROR_CODES, problemType } from './errors.js';
import { readTokensCss } from './testing/fixtures.js';

describe('USER_PALETTE', () => {
  it('equals --collab-1...12 of docs/design/tokens.css, in order (tokens.css is the single source)', () => {
    const css = readTokensCss();
    const tokens = [...css.matchAll(/--collab-(\d+):\s*(#[0-9a-f]{6})/g)].map((match) => ({
      index: Number(match[1]),
      color: match[2],
    }));
    expect(tokens.map((token) => token.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(tokens.map((token) => token.color)).toEqual([...USER_PALETTE]);
  });

  it('uses the users_color_ck format for every colour', () => {
    const format = new RegExp(COLOR_PATTERN);
    for (const color of USER_PALETTE) expect(color).toMatch(format);
    expect(new Set(USER_PALETTE).size).toBe(12);
  });
});

describe('error catalog', () => {
  it('maps every code to a status and a title', () => {
    for (const code of ERROR_CODES) {
      expect(ERRORS[code].status).toBeGreaterThanOrEqual(400);
      expect(ERRORS[code].title.length).toBeGreaterThan(0);
    }
    expect(ERRORS.INVALID_GEOMETRY.status).toBe(422);
    expect(ERRORS.PRECONDITION_REQUIRED.status).toBe(428);
  });

  it('builds kebab-case problem type URNs', () => {
    expect(problemType('INVALID_GEOMETRY')).toBe('urn:snapland:problem:invalid-geometry');
  });
});
