/**
 * `POST /api/v1/client-errors` (SPEC section 6.4): SPA protocol-bug reports, logged and counted, never stored in PostgreSQL.
 * `message` is sanitised by the service before it is logged.
 */
import { z } from 'zod';

import { LIMITS } from '../constants.js';

export const ClientErrorKindSchema = z.enum(['ws_close', 'ws_schema', 'unhandled', 'render']);

export const ClientErrorReportSchema = z.strictObject({
  kind: ClientErrorKindSchema,
  code: z.union([z.number().int(), z.string().max(64)]).optional(),
  message: z.string().max(LIMITS.clientErrorMessageMaxLength),
  context: z
    .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
    .refine((context) => Object.keys(context).length <= LIMITS.clientErrorContextMaxKeys, {
      message: `at most ${LIMITS.clientErrorContextMaxKeys} context keys`,
    })
    .optional(),
  appVersion: z.string().min(1).max(64),
});

export type ClientErrorKind = z.infer<typeof ClientErrorKindSchema>;
export type ClientErrorReport = z.infer<typeof ClientErrorReportSchema>;
