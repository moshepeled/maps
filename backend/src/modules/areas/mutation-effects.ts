/**
 * What happens around a committed area mutation (SPEC section 6.3 steps 8-10): cache invalidation of the old and new bboxes
 * (awaited), the `areas` bus event (awaited BEFORE the reply, so a client's later `draft.end` can never overtake the
 * `area.changed` on any subscriber, section 7.6), the audit row and the metrics. Failures of domain rules are audited here
 * too, so the generic audit hook only ever writes rows for outcomes the service never saw (transport 400, 413, 5xx).
 */
import type { AreaDto, AreaOp, Bbox, ChangedField, GeometryIssue } from '@snapland/shared';

import type { AuditLogger } from '../../infra/audit/types.js';
import type { AreaQueryCache } from '../../infra/cache/types.js';
import type { AreasBusPayload } from '../../infra/events/payloads.js';
import type { EventBus } from '../../infra/events/types.js';
import type { AppError } from '../../infra/http/errors.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { AreasActor } from './areas.types.js';

export interface MutationEffectsDeps {
  areaCache: AreaQueryCache;
  events: EventBus;
  audit: AuditLogger;
  metrics: Metrics;
}

/** A mutation that COMMITTED: the new state, the state before it (null for a create) and what changed. */
export interface CommittedChange {
  op: AreaOp;
  area: AreaDto;
  previous: AreaDto | null;
  changedFields: readonly ChangedField[];
  merged: boolean;
}

function sameBbox(a: Bbox, b: Bbox): boolean {
  return a.every((value, index) => value === b[index]);
}

/** Old and new bbox (one entry when the geometry did not move). */
function affectedBboxes(change: CommittedChange): Bbox[] {
  const current = change.area.bbox;
  const previous = change.previous?.bbox;
  return previous === undefined || sameBbox(previous, current) ? [current] : [previous, current];
}

/** The `snap:ch:areas` payload (section 7.10). The actor of every mutation is the row's `updated_by`. */
function toBusPayload(change: CommittedChange): AreasBusPayload {
  const { area, previous } = change;
  return {
    changeSeq: area.changeSeq,
    op: change.op,
    area,
    prevBbox: previous?.bbox ?? null,
    previousName: previous !== null && previous.name !== area.name ? previous.name : null,
    changedFields: [...change.changedFields],
    merged: change.merged,
    actor: area.updatedBy,
  };
}

function actorFields(actor: AreasActor) {
  return {
    actorId: actor.userId,
    sessionId: actor.sessionId,
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  };
}

/** Audit details of a domain failure: its code and status, plus the sub-codes or conflict facts clients act on. */
function failureDetails(error: AppError): Record<string, unknown> {
  const details: Record<string, unknown> = { code: error.code, status: error.status };
  const issues = error.extensions['errors'];
  if (error.code === 'INVALID_GEOMETRY' && Array.isArray(issues)) {
    details['subCodes'] = [...new Set((issues as GeometryIssue[]).map((issue) => issue.code))];
  }
  if (error.code === 'VERSION_CONFLICT') {
    for (const key of ['baseVersion', 'currentVersion', 'conflictingFields'] as const) {
      details[key] = error.extensions[key];
    }
  }
  return details;
}

export class MutationEffects {
  readonly #deps: MutationEffectsDeps;

  constructor(deps: MutationEffectsDeps) {
    this.#deps = deps;
  }

  /** Invalidate, then publish - both awaited, neither throws (section 10.2 step 5, section 3.3 EventBus). */
  async afterCommit(change: CommittedChange): Promise<void> {
    await this.#deps.areaCache.invalidate(affectedBboxes(change));
    await this.#deps.events.publish('areas', toBusPayload(change));
  }

  recordSuccess(
    op: AreaOp,
    actor: AreasActor,
    areaId: string,
    details: Record<string, unknown>,
    result: 'success' | 'noop' | 'replay' = 'success',
  ): void {
    this.#deps.audit.record({
      action: `area.${op}`,
      outcome: 'success',
      ...actorFields(actor),
      targetType: 'area',
      targetId: areaId,
      details,
    });
    this.#deps.metrics.areaMutationsTotal.inc({ op, result });
  }

  /** A 4xx the service produced: VERSION_CONFLICT is `area.conflict`, 403 is `denied`, the rest `failure`. */
  recordFailure(op: AreaOp, actor: AreasActor, areaId: string | null, error: AppError): void {
    const conflict = error.code === 'VERSION_CONFLICT';
    this.#deps.audit.record({
      action: conflict ? 'area.conflict' : `area.${op}`,
      outcome: error.status === 403 ? 'denied' : 'failure',
      ...actorFields(actor),
      targetType: 'area',
      targetId: areaId,
      details: failureDetails(error),
    });
    this.#deps.metrics.areaMutationsTotal.inc({ op, result: error.status === 409 ? 'conflict' : 'invalid' });
    if (conflict && op === 'update') this.#deps.metrics.areaConflictsTotal.inc({ resolution: 'rejected' });
  }

  /** Merge outcomes of concurrent edits (section 10.3): counted only when the client's base was behind the server. */
  countResolution(resolution: 'merged' | 'noop'): void {
    this.#deps.metrics.areaConflictsTotal.inc({ resolution });
  }
}
