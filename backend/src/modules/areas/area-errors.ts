/**
 * The typed errors of area mutations with the extension members clients act on (SPEC section 3.5 catalog, section 10.3): every 409
 * carries `current` (the full AreaDto) so the UI can offer Keep mine / Take theirs / Restore without another request.
 */
import type { AreaDto, ChangedField, MergeField } from '@snapland/shared';

import { ConflictError, ForbiddenError, NotFoundError } from '../../infra/http/errors.js';

export function areaNotFound(id: string): NotFoundError {
  return new NotFoundError('AREA_NOT_FOUND', `Area ${id} does not exist.`);
}

export function versionNotFound(id: string, version: number): NotFoundError {
  return new NotFoundError('VERSION_NOT_FOUND', `Area ${id} has no version ${version}.`);
}

/** 409 AREA_DELETED: the tombstone as `current`, plus who deleted it and when (UX C-20). */
export function areaDeleted(current: AreaDto): ConflictError {
  return new ConflictError('AREA_DELETED', `Area ${current.id} was deleted.`, {
    current,
    deletedAt: current.deletedAt,
    deletedBy: current.deletedBy,
  });
}

/** 409 AREA_NOT_DELETED: `current` lets a retried restore be recognised as success (SG-15). */
export function areaNotDeleted(current: AreaDto): ConflictError {
  return new ConflictError('AREA_NOT_DELETED', `Area ${current.id} is not deleted.`, { current });
}

export function areaIdConflict(id: string, reason: 'draft' | 'content'): ConflictError {
  const detail =
    reason === 'draft'
      ? `Area id ${id} is a live draft of another user.`
      : `Area id ${id} already exists with different content or another creator.`;
  return new ConflictError('AREA_ID_CONFLICT', detail);
}

export interface VersionConflictFacts {
  current: AreaDto;
  baseVersion: number;
  conflictingFields: readonly (MergeField | ChangedField)[];
  serverChangedFields: readonly MergeField[];
}

/** 409 VERSION_CONFLICT (section 6.3 example): base and current versions, the colliding fields and the current state. */
export function versionConflict(facts: VersionConflictFacts): ConflictError {
  const { current, baseVersion } = facts;
  const detail =
    baseVersion > current.version
      ? `baseVersion ${baseVersion} is ahead of the current version ${current.version}.`
      : `Fields [${facts.conflictingFields.join(', ')}] were changed by another user since version ${baseVersion}.`;
  return new ConflictError('VERSION_CONFLICT', detail, {
    baseVersion,
    currentVersion: current.version,
    conflictingFields: [...facts.conflictingFields],
    serverChangedFields: [...facts.serverChangedFields],
    current,
  });
}

export function notCreatorOrAdmin(): ForbiddenError {
  return new ForbiddenError('FORBIDDEN', 'Only the creator of an area or an admin may delete or restore it.');
}
