/** The few types of the areas module that are not API DTOs: the caller of a mutation and what a mutation returns. */
import type { AreaDto, MergeField } from '@snapland/shared';

import type { ActorContext } from '../../infra/http/request-context.js';

/** An authenticated caller (routes guarantee the user part is present). */
export type AreasActor = ActorContext & { userId: string; sessionId: string; role: 'user' | 'admin' };

/** Result of a successful mutation (the route turns it into an `AreaMutationResponse`). */
export interface MutationResult {
  area: AreaDto;
  merged: boolean;
  noop: boolean;
  serverChangedFields: MergeField[];
  /** POST only: true when the id already held this very create (200 + `Idempotent-Replay`). */
  replay: boolean;
}
