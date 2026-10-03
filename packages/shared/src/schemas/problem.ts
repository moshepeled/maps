/**
 * RFC 9457 problem details (SPEC section 3.5). Code-specific extension members (`retryAfterMs`, `current`,
 * `conflictingFields`, `watermark`, ...) are allowed, so the schema is loose.
 */
import { z } from 'zod';

import { ERROR_CODES } from '../errors.js';
import { PositionSchema } from './common.js';

export const ProblemFieldErrorSchema = z.looseObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  location: PositionSchema.optional(),
  ring: z.number().int().optional(),
  edgeIndices: z.tuple([z.number().int(), z.number().int()]).optional(),
});

export const ProblemSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(ERROR_CODES),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(ProblemFieldErrorSchema).optional(),
});

export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
