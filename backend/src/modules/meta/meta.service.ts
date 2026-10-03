/**
 * Client configuration and client error reports (SPEC section 6.4). `/api/v1/config` publishes the runtime limits the SPA
 * enforces locally, derived from the shared constants and the validated config.
 */
import { COMMITTED_DECIMALS, LIMITS, REALTIME, sanitizeText } from '@snapland/shared';
import type { ClientErrorReport, ConfigResponse } from '@snapland/shared';

import type { AppConfig } from '../../config/env.js';
import { APP_VERSION } from '../../config/version.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { ActorContext } from '../../infra/http/request-context.js';

export function buildClientConfig(config: AppConfig): ConfigResponse {
  return {
    version: APP_VERSION,
    limits: {
      maxPositions: LIMITS.maxPositionsTotal,
      maxRings: LIMITS.maxRings,
      minAreaKm2: LIMITS.minAreaKm2,
      maxAreaKm2: LIMITS.maxAreaKm2,
      maxExtentDeg: LIMITS.maxExtentDeg,
      nameMaxLength: LIMITS.nameMaxLength,
      descriptionMaxLength: LIMITS.descriptionMaxLength,
      coordDecimals: COMMITTED_DECIMALS,
      bboxMaxSpanPx: LIMITS.bboxMaxSpanPx,
    },
    rateLimits: {
      drawActionsPerWindow: config.DRAW_RATE_LIMIT_MAX,
      drawWindowMs: config.DRAW_RATE_LIMIT_WINDOW_MS,
    },
    realtime: {
      wsPath: REALTIME.wsPath,
      subprotocol: REALTIME.subprotocol,
      heartbeatIntervalMs: config.WS_PING_INTERVAL_MS,
      draftUpdateMinIntervalMs: REALTIME.draftUpdateMinIntervalMs,
      draftTouchIntervalMs: config.REALTIME_DRAFT_TOUCH_INTERVAL_MS,
      maxPayloadBytes: config.WS_MAX_PAYLOAD_BYTES,
      draftResumeWindowMs: config.REALTIME_DRAFT_RESUME_WINDOW_S * 1000,
    },
  };
}

/** Logs a client error report (never stored in PostgreSQL) and counts it. */
export function recordClientError(
  report: ClientErrorReport,
  actor: ActorContext,
  deps: { logger: Logger; metrics: Metrics },
): void {
  const message = sanitizeText(report.message, {
    maxLength: LIMITS.clientErrorMessageMaxLength,
    truncate: true,
    allowEmpty: true,
  });
  deps.metrics.clientErrorsTotal.inc({ kind: report.kind });
  deps.logger.warn(
    {
      clientError: true,
      kind: report.kind,
      code: report.code,
      message: message.ok ? message.value : '',
      context: report.context,
      appVersion: report.appVersion,
      userId: actor.userId,
      requestId: actor.requestId,
    },
    'client error reported',
  );
}
