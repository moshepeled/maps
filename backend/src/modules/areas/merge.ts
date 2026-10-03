/**
 * Field-level three-way merge of area updates (SPEC section 10.3, ADR-0005). Pure: the service loads the current row (under
 * its row lock), the snapshot at `baseVersion` and the fields the server changed since then, and this module decides
 * whether the PATCH applies, merges, converges to a no-op, or conflicts. Geometry is atomic (no vertex-level merge).
 */
import { polygonsEqual } from '@snapland/shared';
import type { ChangedField, MergeField, PolygonGeometry } from '@snapland/shared';

/** The mergeable state of an area. Text is already sanitised and geometry normalised (7 dp, RFC 7946 winding). */
export interface MergeFields {
  name: string;
  description: string | null;
  geometry: PolygonGeometry;
}

/** The fields present in a PATCH (absent = not sent). */
export type AreaPatch = Partial<MergeFields>;

export interface MergeCurrent extends MergeFields {
  version: number;
}

export interface UpdatePlanInput {
  current: MergeCurrent;
  baseVersion: number;
  /** Snapshot at `baseVersion` (from `area_versions`); null when it is missing, which is treated as a full conflict. */
  base: MergeFields | null;
  /** Union of `changed_fields` of the versions in (baseVersion, current.version]. */
  serverChanged: ReadonlySet<MergeField>;
  patch: AreaPatch;
}

export type UpdatePlan =
  | { kind: 'noop' }
  | { kind: 'apply'; fields: MergeField[]; merged: boolean }
  | { kind: 'conflict'; conflictingFields: MergeField[] };

/** Every mergeable field, in the order used for responses and audit details (a create sets all of them). */
export const MERGE_FIELDS: readonly MergeField[] = ['name', 'description', 'geometry'];

/** The mergeable subset of a version's `changed_fields` (drops `deleted`), in `MERGE_FIELDS` order. */
export function mergeFieldsOf(fields: Iterable<ChangedField>): MergeField[] {
  const changed = new Set(fields);
  return MERGE_FIELDS.filter((field) => changed.has(field));
}

/** The fields a PATCH carries, in `MERGE_FIELDS` order. */
export function patchFields(patch: AreaPatch): MergeField[] {
  return MERGE_FIELDS.filter((field) => patch[field] !== undefined);
}

/**
 * Whether the patch value of `field` equals the value in `state`. Geometry compares normalised 7-dp coordinates;
 * strings compare exactly (both sides are sanitised).
 */
export function patchValueEquals(patch: AreaPatch, state: MergeFields, field: MergeField): boolean {
  switch (field) {
    case 'name':
      return patch.name === state.name;
    case 'description':
      return patch.description === state.description;
    case 'geometry':
      return (
        patch.geometry !== undefined && polygonsEqual(patch.geometry.coordinates, state.geometry.coordinates)
      );
  }
}

function applyOrNoop(effective: MergeField[], merged: boolean): UpdatePlan {
  return effective.length === 0 ? { kind: 'noop' } : { kind: 'apply', fields: effective, merged };
}

/** Plans an update (section 10.3): conflict -> 409 VERSION_CONFLICT, noop -> 200 without a new version, else apply. */
export function planUpdate({
  current,
  baseVersion,
  base,
  serverChanged,
  patch,
}: UpdatePlanInput): UpdatePlan {
  const sent = patchFields(patch);
  const differsFromCurrent = (field: MergeField): boolean => !patchValueEquals(patch, current, field);

  // A client ahead of the server is impossible unless forged; a missing base cannot be merged safely.
  if (baseVersion > current.version) return { kind: 'conflict', conflictingFields: sent };
  if (baseVersion === current.version) return applyOrNoop(sent.filter(differsFromCurrent), false);
  if (base === null) return { kind: 'conflict', conflictingFields: sent };

  const clientChanged = sent.filter((field) => !patchValueEquals(patch, base, field));
  // The same value on both sides converges instead of conflicting.
  const conflicting = clientChanged.filter((field) => serverChanged.has(field) && differsFromCurrent(field));
  if (conflicting.length > 0) return { kind: 'conflict', conflictingFields: conflicting };
  return applyOrNoop(clientChanged.filter(differsFromCurrent), true);
}

/** The state to write: the current values with the planned fields taken from the patch. */
export function mergeState(
  current: MergeFields,
  patch: AreaPatch,
  fields: readonly MergeField[],
): MergeFields {
  const take = (field: MergeField): boolean => fields.includes(field);
  return {
    name: take('name') && patch.name !== undefined ? patch.name : current.name,
    description:
      take('description') && patch.description !== undefined ? patch.description : current.description,
    geometry: take('geometry') && patch.geometry !== undefined ? patch.geometry : current.geometry,
  };
}
