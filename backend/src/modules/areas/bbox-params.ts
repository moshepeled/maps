/**
 * Parsing of the `bbox` query parameter of `GET /api/v1/areas` (SPEC section 5.5 "Bbox parameter rules", section 6.3). The
 * transport schema only bounds `bbox` as a short string; the domain rules live here, so every failure is a 400
 * INVALID_BBOX with a precise detail instead of a generic VALIDATION_FAILED.
 */
import { LIMITS, bboxSpanPx } from '@snapland/shared';
import type { Bbox } from '@snapland/shared';

import { BadRequestError } from '../../infra/http/errors.js';

/**
 * A plain decimal number, optionally signed and with an exponent. `Number()` alone would also accept `''`, `' 1 '`,
 * `0x10`, `Infinity` and `1_0`, none of which a client should send as a coordinate.
 */
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function invalidBbox(detail: string): BadRequestError {
  return new BadRequestError('INVALID_BBOX', detail);
}

/** One coordinate: a finite decimal number (an exponent overflowing to Infinity, e.g. `1e999`, is rejected). */
function parseCoordinate(text: string, label: string): number {
  const value = DECIMAL_NUMBER.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) throw invalidBbox(`bbox ${label} must be a finite number, got "${text}".`);
  return value;
}

function assertRanges([west, south, east, north]: Bbox): void {
  const maxLng = LIMITS.maxLongitude;
  const maxLat = LIMITS.maxLatitude;
  if (west < -maxLng || east > maxLng) {
    throw invalidBbox(`bbox longitudes must be within [-${maxLng}, ${maxLng}].`);
  }
  if (south < -maxLat || north > maxLat) {
    throw invalidBbox(`bbox latitudes must be within [-${maxLat}, ${maxLat}].`);
  }
  if (west >= east) throw invalidBbox('bbox west must be less than east (split antimeridian viewports).');
  if (south >= north) throw invalidBbox('bbox south must be less than north.');
}

/** The span cap: one request may cover at most `LIMITS.bboxMaxSpanPx` Web-Mercator pixels at its zoom (section 5.5). */
function assertSpan(bbox: Bbox, zoom: number): void {
  const spanPx = bboxSpanPx(bbox, zoom);
  if (spanPx > LIMITS.bboxMaxSpanPx) {
    throw invalidBbox(
      `bbox spans ${Math.ceil(spanPx)} px at zoom ${zoom}; at most ${LIMITS.bboxMaxSpanPx} px are allowed (zoom in or split the request).`,
    );
  }
}

/**
 * Parses `west,south,east,north` and enforces the section 5.5 rules: exactly four finite numbers, `-180 <= west < east <= 180`,
 * `-85.05112878 <= south < north <= 85.05112878`, and a pixel span <= `LIMITS.bboxMaxSpanPx` at `zoom`.
 * @throws BadRequestError INVALID_BBOX
 */
export function parseBboxParam(raw: string, zoom: number): Bbox {
  const parts = raw.split(',');
  if (parts.length !== 4) {
    throw invalidBbox(`bbox must be "west,south,east,north" (4 numbers), got ${parts.length} value(s).`);
  }
  const [westText = '', southText = '', eastText = '', northText = ''] = parts;
  const bbox: Bbox = [
    parseCoordinate(westText, 'west'),
    parseCoordinate(southText, 'south'),
    parseCoordinate(eastText, 'east'),
    parseCoordinate(northText, 'north'),
  ];
  assertRanges(bbox);
  assertSpan(bbox, zoom);
  return bbox;
}
