import type { AreaDto, AreaMutationResponse } from '@snapland/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createArea, createAreasKit, polygon, problemCode, request, uniqueSquare } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

const DEMOTE = sql('testAreasConcurrency.demote', "UPDATE users SET role = 'user' WHERE id = $1");
/** Backends of this run's database that are blocked on a lock inside a row-locking statement. */
const LOCK_WAITERS = `SELECT count(*)::int AS waiting FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`;

let kit: AreasKit;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let admin: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  const { container } = kit.testApp;
  alice = await createUser(container, { displayName: 'Alice' });
  bob = await createUser(container, { displayName: 'Bob' });
  carol = await createUser(container, { displayName: 'Carol' });
  admin = await createUser(container, { role: 'admin' });
});

afterAll(async () => {
  await kit.close();
});

interface ConflictProblem {
  code: string;
  baseVersion: number;
  currentVersion: number;
  conflictingFields: string[];
  serverChangedFields: string[];
  current: AreaDto;
  deletedBy?: { id: string; color: string } | null;
}

function patch(user: TestUser, id: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return request(kit, user, 'PATCH', `/api/v1/areas/${id}`, body);
}

describe('optimistic concurrency and field-level merge (section 10.3)', () => {
  it('10 concurrent renames from base 1 -> exactly 1 x 200 and 9 x 409 with current and the fields', async () => {
    const { area } = await createArea(kit, alice, { name: 'Contended' });
    const users = [alice, bob, carol];
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        patch(users[index % users.length] ?? alice, area.id, { baseVersion: 1, name: `Name ${index}` }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    const winner = responses.find((response) => response.statusCode === 200);
    const winnerName = winner?.json<AreaMutationResponse>().area.name;
    for (const response of responses.filter((candidate) => candidate.statusCode === 409)) {
      const problem = response.json<ConflictProblem>();
      expect(problem).toMatchObject({
        code: 'VERSION_CONFLICT',
        baseVersion: 1,
        currentVersion: 2,
        conflictingFields: ['name'],
        serverChangedFields: ['name'],
        current: { id: area.id, version: 2, name: winnerName },
      });
    }
    expect(
      kit.audit.find((event) => event.action === 'area.conflict' && event.targetId === area.id),
    ).toHaveLength(9);
  });

  it('a writer queued behind ANOTHER user’s committed rename gets 409, not 404 (row lock re-check, T9)', async () => {
    // Deterministic form of the race above: a test transaction holds the row lock, Bob's rename queues first, Carol's
    // second. When the test releases the lock, Bob commits (updated_by: Alice -> Bob) while Carol is still waiting.
    // A locking SELECT that joined `users` re-checked Bob's new row version against the users row read before the wait
    // and returned no row, so Carol got 404 AREA_NOT_FOUND instead of 409 VERSION_CONFLICT.
    const { area } = await createArea(kit, alice, { name: 'Queued' });
    const { pool } = kit.testApp.container.db;
    const holder = await pool.connect();
    const waitingOn = async (count: number): Promise<void> => {
      await waitFor(
        async () => {
          const result = await pool.query<{ waiting: number }>(LOCK_WAITERS);
          return (result.rows[0]?.waiting ?? 0) >= count;
        },
        { timeoutMs: 5000, description: `${count} PATCH(es) waiting for the row lock` },
      );
    };
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM areas WHERE id = $1 FOR UPDATE', [area.id]);
      const bobs = patch(bob, area.id, { baseVersion: 1, name: 'Bob was first' });
      await waitingOn(1);
      const carols = patch(carol, area.id, { baseVersion: 1, name: 'Carol was second' });
      await waitingOn(2);
      await holder.query('COMMIT');
      const [bobResponse, carolResponse] = await Promise.all([bobs, carols]);
      expect(bobResponse.statusCode, bobResponse.body).toBe(200);
      expect(carolResponse.statusCode, carolResponse.body).toBe(409);
      expect(carolResponse.json<ConflictProblem>()).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 2,
        current: { id: area.id, version: 2, name: 'Bob was first', updatedBy: { id: bob.id } },
      });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('concurrent disjoint edits (name, description) both succeed and exactly one is merged', async () => {
    const { area } = await createArea(kit, alice);
    const [named, described] = await Promise.all([
      patch(alice, area.id, { baseVersion: 1, name: 'Named' }),
      patch(bob, area.id, { baseVersion: 1, description: 'Described' }),
    ]);
    expect(named.statusCode).toBe(200);
    expect(described.statusCode).toBe(200);
    const results = [named, described].map((response) => response.json<AreaMutationResponse>());
    expect(results.filter((result) => result.merged)).toHaveLength(1);
    const final = await request(kit, alice, 'GET', `/api/v1/areas/${area.id}`);
    expect(final.json<AreaDto>()).toMatchObject({ version: 3, name: 'Named', description: 'Described' });
  });

  it('scenario 1: rename (v2) + geometry edit from base 1 -> merged with serverChangedFields ["name"]', async () => {
    const { area } = await createArea(kit, alice);
    expect((await patch(alice, area.id, { baseVersion: 1, name: 'By Alice' })).statusCode).toBe(200);
    const geometry = polygon(uniqueSquare());
    const response = await patch(bob, area.id, { baseVersion: 1, geometry });
    expect(response.statusCode).toBe(200);
    expect(response.json<AreaMutationResponse>()).toMatchObject({
      merged: true,
      noop: false,
      serverChangedFields: ['name'],
      area: { version: 3, name: 'By Alice', geometry },
    });
  });

  it('scenario 2: overlapping geometry edits -> 409 conflictingFields ["geometry"], current = v2', async () => {
    const { area } = await createArea(kit, alice);
    expect(
      (await patch(alice, area.id, { baseVersion: 1, geometry: polygon(uniqueSquare()) })).statusCode,
    ).toBe(200);
    const response = await patch(bob, area.id, { baseVersion: 1, geometry: polygon(uniqueSquare()) });
    expect(response.statusCode).toBe(409);
    expect(response.json<ConflictProblem>()).toMatchObject({
      code: 'VERSION_CONFLICT',
      conflictingFields: ['geometry'],
      current: { version: 2 },
    });
  });

  it('scenarios 3 and 5: convergent and retried PATCHes are no-ops without a new version', async () => {
    const { area } = await createArea(kit, alice);
    expect((await patch(alice, area.id, { baseVersion: 1, name: 'Park' })).statusCode).toBe(200);
    const convergent = await patch(bob, area.id, { baseVersion: 1, name: 'Park' });
    expect(convergent.json<AreaMutationResponse>()).toMatchObject({
      noop: true,
      merged: false,
      area: { version: 2 },
      serverChangedFields: ['name'],
    });
    const retried = await patch(alice, area.id, { baseVersion: 1, name: 'Park' });
    expect(retried.json<AreaMutationResponse>()).toMatchObject({ noop: true, area: { version: 2 } });
    const same = await patch(alice, area.id, { baseVersion: 2, name: 'Park' });
    expect(same.json<AreaMutationResponse>()).toMatchObject({ noop: true, area: { version: 2 } });
  });

  it('a baseVersion ahead of the server -> 409 VERSION_CONFLICT', async () => {
    const { area } = await createArea(kit, alice);
    const response = await patch(alice, area.id, { baseVersion: 7, name: 'Future' });
    expect(response.statusCode).toBe(409);
    expect(response.json<ConflictProblem>()).toMatchObject({ baseVersion: 7, currentVersion: 1 });
  });

  it('scenario 4: a PATCH of a tombstone -> 409 AREA_DELETED carrying current and deletedBy', async () => {
    const { area } = await createArea(kit, alice);
    expect((await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`)).statusCode).toBe(
      200,
    );
    const response = await patch(bob, area.id, { baseVersion: 1, name: 'Too late' });
    expect(response.statusCode).toBe(409);
    const problem = response.json<ConflictProblem>();
    expect(problem).toMatchObject({
      code: 'AREA_DELETED',
      deletedBy: { id: alice.id },
      current: { id: area.id, version: 2, deletedBy: { id: alice.id } },
    });
    expect(problem.current.deletedAt).not.toBeNull();
  });
});

describe('delete and restore (creator or admin, versions must match, section 6.3)', () => {
  it('another user -> 403 FORBIDDEN; an admin -> 200', async () => {
    const { area } = await createArea(kit, alice);
    const denied = await request(kit, bob, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(denied.statusCode).toBe(403);
    expect(problemCode(denied)).toBe('FORBIDDEN');
    const byAdmin = await request(kit, admin, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(byAdmin.statusCode).toBe(200);
    const restoreDenied = await request(kit, bob, 'POST', `/api/v1/areas/${area.id}/restore`, {
      baseVersion: 2,
    });
    expect(restoreDenied.statusCode).toBe(403);
    const restoreByAdmin = await request(kit, admin, 'POST', `/api/v1/areas/${area.id}/restore`, {
      baseVersion: 2,
    });
    expect(restoreByAdmin.statusCode).toBe(200);
  });

  it('a demoted admin (stale admin token) is checked against the current role', async () => {
    const formerAdmin = await createUser(kit.testApp.container, { role: 'admin' });
    await kit.testApp.container.db.query(DEMOTE, [formerAdmin.id]);
    const { area } = await createArea(kit, alice);
    const response = await request(kit, formerAdmin, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(response.statusCode).toBe(403);
  });

  it('a stale baseVersion on DELETE -> 409 VERSION_CONFLICT (deletes never merge)', async () => {
    const { area } = await createArea(kit, alice);
    expect((await patch(bob, area.id, { baseVersion: 1, name: 'Edited' })).statusCode).toBe(200);
    const response = await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(response.statusCode).toBe(409);
    expect(response.json<ConflictProblem>()).toMatchObject({
      code: 'VERSION_CONFLICT',
      baseVersion: 1,
      currentVersion: 2,
      conflictingFields: ['name'],
      serverChangedFields: ['name'],
      current: { version: 2 },
    });
  });

  it('deleting a tombstone -> 409 AREA_DELETED; restoring a live area -> 409 AREA_NOT_DELETED with current', async () => {
    const { area } = await createArea(kit, alice);
    const notDeleted = await request(kit, alice, 'POST', `/api/v1/areas/${area.id}/restore`, {
      baseVersion: 1,
    });
    expect(notDeleted.statusCode).toBe(409);
    expect(notDeleted.json<ConflictProblem>()).toMatchObject({
      code: 'AREA_NOT_DELETED',
      current: { id: area.id, version: 1, deletedAt: null },
    });

    expect((await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`)).statusCode).toBe(
      200,
    );
    const again = await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=2`);
    expect(again.statusCode).toBe(409);
    expect(problemCode(again)).toBe('AREA_DELETED');

    // A restore whose first attempt succeeded is recognisable from AREA_NOT_DELETED (version = base + 1, SG-15).
    expect(
      (await request(kit, alice, 'POST', `/api/v1/areas/${area.id}/restore`, { baseVersion: 2 })).statusCode,
    ).toBe(200);
    const retried = await request(kit, alice, 'POST', `/api/v1/areas/${area.id}/restore`, { baseVersion: 2 });
    expect(retried.statusCode).toBe(409);
    expect(retried.json<ConflictProblem>().current).toMatchObject({ version: 3, deletedAt: null });
  });

  it('delete/restore of an unknown id -> 404 AREA_NOT_FOUND', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const remove = await request(kit, alice, 'DELETE', `/api/v1/areas/${unknown}?baseVersion=1`);
    const restore = await request(kit, alice, 'POST', `/api/v1/areas/${unknown}/restore`, { baseVersion: 1 });
    for (const response of [remove, restore]) {
      expect(response.statusCode).toBe(404);
      expect(problemCode(response)).toBe('AREA_NOT_FOUND');
    }
  });
});
