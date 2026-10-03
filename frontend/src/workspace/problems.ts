/**
 * Reading RFC 9457 problems for the UI: field errors of 400 VALIDATION_FAILED (mapped to form fields by `path`),
 * the first geometry sub-code and its location of 422 INVALID_GEOMETRY (UX F-03 step 9), and the merge fields of a
 * 409 VERSION_CONFLICT (UX F-09).
 */
import type { MergeField, Position, ProblemFieldError } from '@snapland/shared';
import { MergeFieldSchema } from '@snapland/shared';
import { z } from 'zod';

import type { ApiError } from '../api/http';

export function fieldErrors(error: ApiError): ProblemFieldError[] {
  return error.problem?.errors ?? [];
}

/** The first field error whose `path` starts with `field` (e.g. `name`, `body.name`). */
export function fieldError(error: ApiError, field: string): ProblemFieldError | null {
  return (
    fieldErrors(error).find(
      (item) => item.path === field || item.path.endsWith(`.${field}`) || item.path.startsWith(`${field}.`),
    ) ?? null
  );
}

export interface GeometryProblem {
  code: string | null;
  location: Position | null;
}

export function geometryProblem(error: ApiError): GeometryProblem {
  const first = fieldErrors(error)[0];
  return { code: first?.code ?? null, location: first?.location ?? null };
}

const MergeFieldListSchema = z.array(MergeFieldSchema);

export function mergeFields(
  error: ApiError,
  name: 'conflictingFields' | 'serverChangedFields',
): MergeField[] {
  const parsed = MergeFieldListSchema.safeParse(error.extension(name));
  return parsed.success ? parsed.data : [];
}
