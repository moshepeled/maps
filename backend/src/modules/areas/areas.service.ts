/**
 * Area mutations (SPEC section 6.3, section 5.5 write path, section 10.3). Each one runs the normative pipeline after the route's
 * authentication, transport validation and drawing-action charge:
 *   domain input (sanitise -> 428 -> 422) -> [POST: draft-owner squatting guard, 409] -> transaction (row lock ->
 *   change-feed advisory lock 7210001 -> write -> version snapshot; GEOS / CHECK -> 422) -> COMMIT -> cache invalidation
 *   -> bus event (both awaited, before the reply) -> audit + metrics.
 * Lock order is always row lock -> advisory lock, so concurrent writers cannot deadlock.
 */
import { randomUUID } from 'node:crypto';

import type {
  AreaDto,
  AreaOp,
  ChangedField,
  CreateAreaRequest,
  MergeField,
  UpdateAreaRequest,
} from '@snapland/shared';

import type { Db, DbTx } from '../../infra/db/types.js';
import type { UserDirectory } from '../../infra/directory/types.js';
import type { DraftRegistry } from '../../infra/drafts/types.js';
import { AppError } from '../../infra/http/errors.js';
import { isSameCreate, prepareCreate, prepareUpdate, requireBaseVersion } from './area-input.js';
import type { CreateInput, UpdateInput } from './area-input.js';
import {
  areaDeleted,
  areaIdConflict,
  areaNotDeleted,
  areaNotFound,
  notCreatorOrAdmin,
  versionConflict,
} from './area-errors.js';
import { areasRepository } from './areas.repository.js';
import type { AreasActor, MutationResult } from './areas.types.js';
import { assertGeosAccepts, translateCheckViolation } from './geometry-pipeline.js';
import { MERGE_FIELDS, mergeFieldsOf, mergeState, planUpdate } from './merge.js';
import type { MutationEffects } from './mutation-effects.js';
import type { CommittedChange } from './mutation-effects.js';

export interface AreasServiceDeps {
  db: Db;
  drafts: DraftRegistry;
  users: UserDirectory;
  effects: MutationEffects;
}

type CreateOutcome =
  | { kind: 'created'; change: CommittedChange }
  | { kind: 'replay'; area: AreaDto; serverChangedFields: MergeField[] };

type UpdateOutcome =
  | { kind: 'applied'; change: CommittedChange; serverChangedFields: MergeField[] }
  | { kind: 'noop'; area: AreaDto; serverChangedFields: MergeField[] };

const DELETED_FIELD: readonly ChangedField[] = ['deleted'];

function mutationResult(area: AreaDto, flags: Partial<Omit<MutationResult, 'area'>> = {}): MutationResult {
  return { area, merged: false, noop: false, serverChangedFields: [], replay: false, ...flags };
}

export class AreasService {
  readonly #deps: AreasServiceDeps;

  constructor(deps: AreasServiceDeps) {
    this.#deps = deps;
  }

  /** POST /areas: 201 created, or 200 replay of the same create (section 6.3 idempotency). */
  create(actor: AreasActor, body: CreateAreaRequest): Promise<MutationResult> {
    return this.#audited('create', actor, body.id ?? null, async () => {
      const input = prepareCreate(body);
      const id = input.id ?? randomUUID();
      if (input.id !== null) await this.#assertNotSquatted(id, actor);
      const outcome = await this.#deps.db.withTransaction((tx) => this.#createInTx(tx, id, input, actor));
      if (outcome.kind === 'replay') {
        const { area } = outcome;
        this.#deps.effects.recordSuccess('create', actor, id, this.#createDetails(area, true), 'replay');
        return mutationResult(area, { serverChangedFields: outcome.serverChangedFields, replay: true });
      }
      await this.#deps.effects.afterCommit(outcome.change);
      this.#deps.effects.recordSuccess('create', actor, id, this.#createDetails(outcome.change.area, false));
      return mutationResult(outcome.change.area);
    });
  }

  /** PATCH /areas/{id}: optimistic concurrency with the field-level three-way merge (section 10.3). */
  update(actor: AreasActor, id: string, body: UpdateAreaRequest): Promise<MutationResult> {
    return this.#audited('update', actor, id, async () => {
      const input = prepareUpdate(body);
      const outcome = await this.#deps.db.withTransaction((tx) => this.#updateInTx(tx, id, input, actor));
      if (outcome.kind === 'noop') {
        const { area } = outcome;
        const details = {
          fromVersion: input.baseVersion,
          toVersion: area.version,
          changedFields: [],
          merged: false,
        };
        this.#deps.effects.recordSuccess('update', actor, id, { ...details, noop: true }, 'noop');
        // Only a no-op against a newer server version is a (convergent) concurrent edit.
        if (input.baseVersion < area.version) this.#deps.effects.countResolution('noop');
        return mutationResult(area, { noop: true, serverChangedFields: outcome.serverChangedFields });
      }
      const { change } = outcome;
      await this.#deps.effects.afterCommit(change);
      this.#deps.effects.recordSuccess('update', actor, id, {
        fromVersion: input.baseVersion,
        toVersion: change.area.version,
        changedFields: change.changedFields,
        merged: change.merged,
        noop: false,
      });
      if (change.merged) this.#deps.effects.countResolution('merged');
      return mutationResult(change.area, {
        merged: change.merged,
        serverChangedFields: outcome.serverChangedFields,
      });
    });
  }

  /** DELETE /areas/{id}?baseVersion=: soft delete by the creator or an admin; versions must match (no merge). */
  remove(actor: AreasActor, id: string, baseVersion: number | undefined): Promise<MutationResult> {
    return this.#tombstoneTransition('delete', actor, id, baseVersion);
  }

  /** POST /areas/{id}/restore: the inverse of remove, on a tombstone only. */
  restore(actor: AreasActor, id: string, baseVersion: number | undefined): Promise<MutationResult> {
    return this.#tombstoneTransition('restore', actor, id, baseVersion);
  }

  // -- create ---------------------------------------------------------------------------------------------------

  /** Draft ids are visible to every viewer; without this guard any viewer could pre-empt another user's save. */
  async #assertNotSquatted(id: string, actor: AreasActor): Promise<void> {
    const owner = await this.#deps.drafts.getOwner(id);
    if (owner !== null && owner.userId !== actor.userId) throw areaIdConflict(id, 'draft');
  }

  async #createInTx(tx: DbTx, id: string, input: CreateInput, actor: AreasActor): Promise<CreateOutcome> {
    const geoJson = JSON.stringify(input.geometry);
    assertGeosAccepts(await areasRepository.checkGeometry(tx, geoJson));
    await areasRepository.lockChangeFeed(tx);
    const inserted = await this.#write(() =>
      areasRepository.insert(tx, {
        id,
        name: input.name,
        description: input.description,
        geoJson,
        actorId: actor.userId,
      }),
    );
    if (!inserted) return this.#replayOrConflict(tx, id, input, actor);
    await areasRepository.insertVersionFromCurrent(tx, {
      areaId: id,
      op: 'create',
      changedFields: MERGE_FIELDS,
      merged: false,
      baseVersion: null,
      actorId: actor.userId,
      requestId: actor.requestId,
      revertedFrom: null,
    });
    const area = await this.#reload(tx, id);
    const change: CommittedChange = {
      op: 'create',
      area,
      previous: null,
      changedFields: MERGE_FIELDS,
      merged: false,
    };
    return { kind: 'created', change };
  }

  /** The id exists: a replay answers with the CURRENT state (maybe a later version or a tombstone), else 409. */
  async #replayOrConflict(
    tx: DbTx,
    id: string,
    input: CreateInput,
    actor: AreasActor,
  ): Promise<CreateOutcome> {
    const snapshot = await areasRepository.versionOneSnapshot(tx, id);
    if (snapshot === null || !isSameCreate(snapshot, input, actor.userId)) {
      throw areaIdConflict(id, 'content');
    }
    const area = await this.#reload(tx, id);
    const sinceCreate = await areasRepository.changedFieldsBetween(tx, id, 1, area.version);
    return { kind: 'replay', area, serverChangedFields: mergeFieldsOf(sinceCreate) };
  }

  #createDetails(area: AreaDto, replay: boolean): Record<string, unknown> {
    return { version: area.version, areaKm2: area.areaKm2, vertexCount: area.vertexCount, replay };
  }

  // -- update ---------------------------------------------------------------------------------------------------

  async #updateInTx(tx: DbTx, id: string, input: UpdateInput, actor: AreasActor): Promise<UpdateOutcome> {
    const current = await this.#lockExisting(tx, id);
    if (current.deletedAt !== null) throw areaDeleted(current);
    const behind = input.baseVersion < current.version;
    const serverChanged = behind
      ? mergeFieldsOf(await areasRepository.changedFieldsBetween(tx, id, input.baseVersion, current.version))
      : [];
    const base = behind ? await areasRepository.versionSnapshot(tx, id, input.baseVersion) : null;
    const plan = planUpdate({
      current,
      baseVersion: input.baseVersion,
      base,
      serverChanged: new Set(serverChanged),
      patch: input.patch,
    });
    switch (plan.kind) {
      case 'conflict':
        throw versionConflict({
          current,
          baseVersion: input.baseVersion,
          conflictingFields: plan.conflictingFields,
          serverChangedFields: serverChanged,
        });
      case 'noop':
        return { kind: 'noop', area: current, serverChangedFields: serverChanged };
      case 'apply':
        return {
          kind: 'applied',
          change: await this.#applyUpdate(tx, current, input, plan, actor),
          serverChangedFields: serverChanged,
        };
    }
  }

  async #applyUpdate(
    tx: DbTx,
    current: AreaDto,
    input: UpdateInput,
    plan: { fields: MergeField[]; merged: boolean },
    actor: AreasActor,
  ): Promise<CommittedChange> {
    const next = mergeState(current, input.patch, plan.fields);
    const geoJson = plan.fields.includes('geometry') ? JSON.stringify(next.geometry) : null;
    if (geoJson !== null) assertGeosAccepts(await areasRepository.checkGeometry(tx, geoJson));
    await areasRepository.lockChangeFeed(tx);
    await this.#write(() =>
      areasRepository.updateContent(tx, current.id, {
        name: next.name,
        description: next.description,
        geoJson,
        actorId: actor.userId,
      }),
    );
    await areasRepository.insertVersionFromCurrent(tx, {
      areaId: current.id,
      op: 'update',
      changedFields: plan.fields,
      merged: plan.merged,
      baseVersion: input.baseVersion,
      actorId: actor.userId,
      requestId: actor.requestId,
      revertedFrom: input.revertedFrom,
    });
    const area = await this.#reload(tx, current.id);
    return { op: 'update', area, previous: current, changedFields: plan.fields, merged: plan.merged };
  }

  // -- delete / restore ----------------------------------------------------------------------------------------

  #tombstoneTransition(
    op: 'delete' | 'restore',
    actor: AreasActor,
    id: string,
    rawBaseVersion: number | undefined,
  ): Promise<MutationResult> {
    return this.#audited(op, actor, id, async () => {
      const baseVersion = requireBaseVersion(rawBaseVersion);
      const isAdmin = await this.#isCurrentAdmin(actor);
      const change = await this.#deps.db.withTransaction((tx) =>
        this.#tombstoneInTx(tx, op, id, baseVersion, actor, isAdmin),
      );
      await this.#deps.effects.afterCommit(change);
      this.#deps.effects.recordSuccess(op, actor, id, { version: change.area.version });
      return mutationResult(change.area);
    });
  }

  /**
   * 404 -> 403 (creator or admin) -> 409 wrong state -> 409 stale version, then the transition and its snapshot.
   * `isAdmin` is the caller's CURRENT admin role, read before the transaction.
   */
  async #tombstoneInTx(
    tx: DbTx,
    op: 'delete' | 'restore',
    id: string,
    baseVersion: number,
    actor: AreasActor,
    isAdmin: boolean,
  ): Promise<CommittedChange> {
    const current = await this.#lockExisting(tx, id);
    if (current.createdBy.id !== actor.userId && !isAdmin) throw notCreatorOrAdmin();
    if (op === 'delete' && current.deletedAt !== null) throw areaDeleted(current);
    if (op === 'restore' && current.deletedAt === null) throw areaNotDeleted(current);
    await this.#assertVersionMatches(tx, current, baseVersion);
    await areasRepository.lockChangeFeed(tx);
    if (op === 'delete') await areasRepository.softDelete(tx, id, actor.userId);
    else await areasRepository.restore(tx, id, actor.userId);
    await areasRepository.insertVersionFromCurrent(tx, {
      areaId: id,
      op,
      changedFields: DELETED_FIELD,
      merged: false,
      baseVersion,
      actorId: actor.userId,
      requestId: actor.requestId,
      revertedFrom: null,
    });
    const area = await this.#reload(tx, id);
    return { op, area, previous: current, changedFields: DELETED_FIELD, merged: false };
  }

  /** Deletes and restores never merge: any version other than the current one is a conflict (section 10.3 #8). */
  async #assertVersionMatches(tx: DbTx, current: AreaDto, baseVersion: number): Promise<void> {
    if (baseVersion === current.version) return;
    const changed =
      baseVersion < current.version
        ? await areasRepository.changedFieldsBetween(tx, current.id, baseVersion, current.version)
        : [];
    throw versionConflict({
      current,
      baseVersion,
      conflictingFields: changed,
      serverChangedFields: mergeFieldsOf(changed),
    });
  }

  /**
   * Admin rights are read from the directory (the CURRENT role, like `requireRole`), so a demoted admin loses them on
   * the next request instead of when the access token expires. Only a token that claims admin costs the extra read.
   */
  async #isCurrentAdmin(actor: AreasActor): Promise<boolean> {
    if (actor.role !== 'admin') return false;
    const profile = (await this.#deps.users.getProfiles([actor.userId])).get(actor.userId);
    return profile?.role === 'admin' && !profile.disabled;
  }

  // -- shared ---------------------------------------------------------------------------------------------------

  async #lockExisting(tx: DbTx, id: string): Promise<AreaDto> {
    const current = await areasRepository.lockById(tx, id);
    if (current === null) throw areaNotFound(id);
    return current;
  }

  /** The committed state with its user references (inside the transaction, so it is exactly what was written). */
  async #reload(tx: DbTx, id: string): Promise<AreaDto> {
    const area = await areasRepository.findById(tx, id);
    if (area === null) throw new Error(`area ${id} vanished inside its own transaction`);
    return area;
  }

  /** A CHECK violation raised by a write is a client error (GEOS / CHECK -> 422, section 6.3), not a 500. */
  async #write<T>(statement: () => Promise<T>): Promise<T> {
    try {
      return await statement();
    } catch (error) {
      throw translateCheckViolation(error) ?? error;
    }
  }

  /** Records the 4xx outcomes the service produced (success rows are recorded by each operation). */
  async #audited<T>(
    op: AreaOp,
    actor: AreasActor,
    areaId: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        this.#deps.effects.recordFailure(op, actor, areaId, error);
      }
      throw error;
    }
  }
}
