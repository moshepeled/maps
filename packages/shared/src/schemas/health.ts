/** Health endpoints (SPEC section 10.9). */
import { z } from 'zod';

export const LiveResponseSchema = z.object({
  status: z.literal('ok'),
  instanceId: z.string(),
  uptimeS: z.number().int(),
});

const CheckStatusSchema = z.enum(['ok', 'fail']);

const DependencyCheckSchema = z.object({
  status: CheckStatusSchema,
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'fail']),
  instanceId: z.string(),
  version: z.string(),
  uptimeS: z.number().int(),
  checks: z.object({
    database: DependencyCheckSchema,
    redis: DependencyCheckSchema,
    migrations: z.object({
      status: CheckStatusSchema,
      pending: z.number().int().optional(),
      error: z.string().optional(),
    }),
    shutdown: z.object({ status: CheckStatusSchema }),
    /** Informational: the L2 cache never changes the overall status. */
    cacheRedis: z.object({ status: z.enum(['ok', 'fail', 'disabled']), error: z.string().optional() }),
  }),
});

export type LiveResponse = z.infer<typeof LiveResponseSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
