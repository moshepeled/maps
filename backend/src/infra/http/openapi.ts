/**
 * OpenAPI helpers (SPEC section 6 intro, S6): every route documents its success schema AND each error status with the
 * problem schema. `withProblems` adds the global statuses (400, 429, 500, 503) plus the route's own ones.
 */
import { ProblemSchema } from '@snapland/shared';
import type { z } from 'zod';

/** Statuses every `/api/v1` route can answer (section 6.1: "besides 400 VALIDATION_FAILED, 429, 500, 503"). */
const GLOBAL_PROBLEM_STATUSES = [400, 429, 500, 503] as const;

export type ResponseSchemas = Record<number, z.ZodType>;

type GlobalProblemStatus = (typeof GLOBAL_PROBLEM_STATUSES)[number];

/** `{ ...success, 400|429|500|503|<extra>: ProblemSchema }` for a route's `schema.response`. */
export function withProblems<T extends ResponseSchemas, E extends number = never>(
  success: T,
  ...extraStatuses: E[]
): T & Record<GlobalProblemStatus | E, typeof ProblemSchema> {
  const problems: Partial<Record<number, typeof ProblemSchema>> = {};
  for (const status of [...GLOBAL_PROBLEM_STATUSES, ...extraStatuses]) problems[status] = ProblemSchema;
  return { ...problems, ...success };
}

export const SECURITY_BEARER = [{ bearerAuth: [] }];

/** The refresh route is authenticated by the `snap_rt` HttpOnly cookie (scheme `refreshCookie`, declared in app.ts). */
export const SECURITY_REFRESH_COOKIE = [{ refreshCookie: [] }];
