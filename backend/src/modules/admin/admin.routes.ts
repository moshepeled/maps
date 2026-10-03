/**
 * `GET /api/v1/admin/audit-logs` and `GET /api/v1/admin/audit-stats` (SPEC section 6.4): authenticated (default `api` rate
 * limit), `requireRole('admin')` reads the caller's CURRENT role, and every outcome is audited as `admin.audit_query`
 * - successes by the service, refusals and failures by the generic audit hook (`config.auditAction`).
 */
import {
  AuditLogListResponseSchema,
  AuditLogQuerySchema,
  AuditStatsQuerySchema,
  AuditStatsResponseSchema,
} from '@snapland/shared';

import { SECURITY_BEARER, withProblems } from '../../infra/http/openapi.js';
import type { AppInstance } from '../../infra/http/types.js';
import type { AdminService } from './admin.service.js';

export function registerAdminRoutes(app: AppInstance, service: AdminService): void {
  app.get(
    '/api/v1/admin/audit-logs',
    {
      onRequest: [app.authenticate],
      // preValidation, not preHandler: the role is checked BEFORE the querystring is validated, so a non-admin always
      // gets 403 (audited as denied) and never learns anything from this endpoint's validation errors.
      preValidation: [app.requireRole('admin')],
      config: { auditAction: 'admin.audit_query' },
      schema: {
        summary: 'Query the audit trail (filters + keyset on id DESC); audited as admin.audit_query',
        tags: ['admin'],
        security: SECURITY_BEARER,
        querystring: AuditLogQuerySchema,
        response: withProblems({ 200: AuditLogListResponseSchema }, 401, 403),
      },
    },
    (request) => service.listAuditLogs(request.query, request.actor()),
  );

  app.get(
    '/api/v1/admin/audit-stats',
    {
      onRequest: [app.authenticate],
      // preValidation, not preHandler: the role is checked BEFORE the querystring is validated, so a non-admin always
      // gets 403 (audited as denied) and never learns anything from this endpoint's validation errors.
      preValidation: [app.requireRole('admin')],
      config: { auditAction: 'admin.audit_query' },
      schema: {
        summary:
          'Audit analytics over a window <= 31 days (default: last 24 h); audited as admin.audit_query',
        tags: ['admin'],
        security: SECURITY_BEARER,
        querystring: AuditStatsQuerySchema,
        response: withProblems({ 200: AuditStatsResponseSchema }, 401, 403),
      },
    },
    (request) => service.auditStats(request.query, request.actor()),
  );
}
