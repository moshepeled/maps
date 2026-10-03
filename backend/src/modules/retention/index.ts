/**
 * Retention module (SPEC section 5.6, section 10.5): the scheduled purge of soft-deleted areas, old audit rows and dead sessions,
 * coordinated across instances by a PostgreSQL advisory lock. `RETENTION_ENABLED=false` keeps the timer off (the
 * integration harness does, and runs `createRetentionService(container).runOnce()` explicitly).
 */
import type { Container } from '../../container.js';
import type { ModuleFactory } from '../types.js';
import { createRetentionRepository } from './retention.repository.js';
import { RetentionJob } from './retention.job.js';
import { RetentionService } from './retention.service.js';

export type { RetentionRunResult } from './retention.service.js';

/** The retention service of a container (the module's job and tests share this one construction). */
export function createRetentionService(container: Container): RetentionService {
  return new RetentionService({
    db: container.db,
    repository: createRetentionRepository(container.db, container.metrics),
    audit: container.audit,
    metrics: container.metrics,
    logger: container.logger.child({ module: 'retention' }),
    clock: container.clock,
    settings: container.config,
  });
}

export const createRetentionModule: ModuleFactory = (container) => {
  const { config } = container;
  const register = () => Promise.resolve();
  if (!config.RETENTION_ENABLED) return { name: 'retention', register };
  const job = new RetentionJob({
    runner: createRetentionService(container),
    initialDelayMs: config.RETENTION_INITIAL_DELAY_MS,
    intervalMs: config.RETENTION_INTERVAL_MS,
    logger: container.logger.child({ module: 'retention' }),
  });
  return {
    name: 'retention',
    register,
    start: () => {
      job.start();
      return Promise.resolve();
    },
    stop: () => job.stop(),
  };
};
