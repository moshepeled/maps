/**
 * Domain preparation of area write requests, in the one normative order of section 6.3 step 4: sanitise text (section 10.7.1; an
 * empty or too long value is a 400 that still costs a drawing action) -> `baseVersion` present (PATCH/DELETE/restore,
 * else 428) -> normalise and validate the geometry (section 9, 422). Transport validation already happened in Fastify.
 */
import { LIMITS, polygonsEqual, sanitizeText } from '@snapland/shared';
import type { CreateAreaRequest, PolygonGeometry, UpdateAreaRequest } from '@snapland/shared';

import { PreconditionRequiredError, ValidationError } from '../../infra/http/errors.js';
import type { VersionOneSnapshot } from './areas.repository.js';
import { validateGeometryInput } from './geometry-pipeline.js';
import type { AreaPatch } from './merge.js';

export interface CreateInput {
  /** Client-supplied id (the draft id, section 6.3), or null for a server-generated one. */
  id: string | null;
  name: string;
  description: string | null;
  geometry: PolygonGeometry;
}

export interface UpdateInput {
  baseVersion: number;
  patch: AreaPatch;
  revertedFrom: number | null;
}

/** Name: 1-120 code points after sanitisation. @throws ValidationError (path `name`) */
export function sanitizeName(raw: string): string {
  const result = sanitizeText(raw, { maxLength: LIMITS.nameMaxLength });
  if (result.ok) return result.value;
  const message =
    result.reason === 'empty'
      ? 'name is empty after sanitisation'
      : `name has ${result.length} characters; at most ${result.maxLength} are allowed`;
  throw new ValidationError(`Invalid name: ${message}.`, [{ path: 'name', code: result.reason, message }]);
}

/**
 * Description: 0-2,000 code points after sanitisation (line breaks kept). An empty result is stored as null, so ""
 * and null compare equal in merges and idempotent replays. @throws ValidationError (path `description`)
 */
export function sanitizeDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const result = sanitizeText(raw, {
    maxLength: LIMITS.descriptionMaxLength,
    multiline: true,
    allowEmpty: true,
  });
  if (result.ok) return result.value === '' ? null : result.value;
  const message = `description has ${result.length} characters; at most ${result.maxLength} are allowed`;
  throw new ValidationError(`Invalid description: ${message}.`, [
    { path: 'description', code: result.reason, message },
  ]);
}

/** PATCH/DELETE/restore must name the version they were based on (optional in transport, section 3.5). */
export function requireBaseVersion(baseVersion: number | undefined): number {
  if (baseVersion === undefined) throw new PreconditionRequiredError();
  return baseVersion;
}

export function prepareCreate(body: CreateAreaRequest): CreateInput {
  const name = sanitizeName(body.name);
  const description = sanitizeDescription(body.description);
  return { id: body.id ?? null, name, description, geometry: validateGeometryInput(body.geometry) };
}

export function prepareUpdate(body: UpdateAreaRequest): UpdateInput {
  const patch: AreaPatch = {};
  if (body.name !== undefined) patch.name = sanitizeName(body.name);
  if (body.description !== undefined) patch.description = sanitizeDescription(body.description);
  const baseVersion = requireBaseVersion(body.baseVersion);
  if (body.geometry !== undefined) patch.geometry = validateGeometryInput(body.geometry);
  return { baseVersion, patch, revertedFrom: body.revertedFrom ?? null };
}

/**
 * Idempotent create (section 6.3, `areas.versionOneSnapshot`): a POST whose id already exists is a replay of THIS create
 * only if the caller created it and version 1 - the state this very create produced - has the same sanitised name
 * and description and the same normalised 7-dp geometry. Comparing with version 1 instead of the current row keeps
 * "response lost, someone edited meanwhile" a replay instead of a 409 and a duplicate area (UX-AC-25).
 */
export function isSameCreate(snapshot: VersionOneSnapshot, input: CreateInput, actorId: string): boolean {
  return (
    snapshot.createdBy === actorId &&
    snapshot.name === input.name &&
    snapshot.description === input.description &&
    polygonsEqual(snapshot.geometry.coordinates, input.geometry.coordinates)
  );
}
