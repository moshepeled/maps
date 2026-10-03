/**
 * Audit trail contracts (SPEC section 3.3, section 10.4). `record()` never blocks and never throws; the writer batches rows into
 * `audit_logs`. High-frequency denials go through the `AuditCoalescer` instead of one row each.
 */

/** The action catalog (section 10.4), format `<domain>.<verb>`. `auth.session_list` is a read and is never audited. */
export const AUDIT_ACTIONS = [
  'auth.register',
  'auth.login',
  'auth.refresh',
  'auth.token_reuse',
  'auth.logout',
  'auth.session_revoke',
  'auth.ws_ticket',
  'area.create',
  'area.update',
  'area.conflict',
  'area.delete',
  'area.restore',
  'ws.connect',
  'ws.disconnect',
  'ws.reject',
  'draft.start',
  'draft.end',
  'lock.acquire',
  'lock.release',
  'ratelimit.hit',
  'admin.audit_query',
  'admin.user_update',
  'retention.run',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = 'success' | 'failure' | 'denied';

export type AuditTargetType = 'area' | 'user' | 'session' | 'ws_connection' | 'draft' | 'system';

export interface AuditEvent {
  action: AuditAction;
  outcome: AuditOutcome;
  actorId?: string | null;
  sessionId?: string | null;
  targetType?: AuditTargetType | null;
  targetId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** No secrets and no geometry; truncated to <= 4 KiB of JSON text by the pipeline. */
  details?: Record<string, unknown>;
  /** Defaults to clock.now(). */
  occurredAt?: Date;
}

export interface AuditLogger {
  /** Never blocks, never throws. */
  record(event: AuditEvent): void;
  flush(): Promise<void>;
}

export interface AuditCoalescer {
  /**
   * First event per key in a 10 s window is recorded at once; later ones only increment a counter that is flushed as
   * ONE row (`details.count` = the later hits) when the window closes. The map is bounded to 10,000 keys (the oldest
   * window is flushed early). Keys: `ratelimit:<scope>:<userId|ip>`, `ws.reject:<reason>:<ip>`,
   * `<action>:denied:<code>:<connectionId>`.
   */
  record(key: string, event: AuditEvent): void;
  flush(): Promise<void>;
}

export interface RequestAuditTracker {
  /**
   * Called by the audit hook in onRequest. Request ids come from the client (a valid inbound `x-request-id` is kept),
   * so several in-flight requests may share one; while they overlap, a mark cannot be attributed to one of them.
   */
  begin(requestId: string): void;
  /**
   * True once an event with this requestId went through `container.audit.record` - but false while the id is shared
   * by overlapping requests, so a client cannot suppress its own failure rows by reusing the id of an audited request
   * (the hook then writes the generic row: a possible duplicate is preferred over a missing row).
   */
  wasRecorded(requestId: string): boolean;
  /** Called by the audit hook in onResponse (once per begin); entries also expire after 60 s (bounded 10,000). */
  release(requestId: string): void;
}
