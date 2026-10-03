import { randomUUID } from 'node:crypto';

import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NormalizedAuditEvent } from '../../../src/infra/audit/normalize.js';
import { fixture } from '../../helpers/fixtures.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { createArea, createAreasKit, polygon, request, uniqueSquare } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

let kit: AreasKit;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  alice = await createUser(kit.testApp.container);
  bob = await createUser(kit.testApp.container);
});

afterAll(async () => {
  await kit.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Sends a request with its own x-request-id and returns the single audit row written for it. */
async function audited(
  user: TestUser,
  method: Method,
  url: string,
  body?: unknown,
): Promise<{ response: LightMyRequestResponse; row: NormalizedAuditEvent }> {
  const requestId = `audit-${randomUUID()}`;
  const response = await request(kit, user, method, url, body, { 'x-request-id': requestId });
  // The generic hook writes in onResponse, which may run just after inject() resolved.
  const rows = await waitFor(() => {
    const found = kit.audit.find((event) => event.requestId === requestId);
    return found.length > 0 ? found : null;
  });
  expect(rows, `exactly one audit row for ${method} ${url}`).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('unreachable');
  expect(row).toMatchObject({ actorId: user.id, sessionId: user.sessionId, targetType: 'area' });
  return { response, row };
}

const BOWTIE = fixture('bowtie_self_intersection').geojson;

describe('audit rows of area mutations (section 10.4 catalog)', () => {
  it('area.create: success, replay, 400 text, 422, 409 and a transport 400 (generic hook row)', async () => {
    const id = randomUUID();
    const body = { id, name: 'Audited', geometry: polygon(uniqueSquare()) };
    const created = await audited(alice, 'POST', '/api/v1/areas', body);
    expect(created.row).toMatchObject({
      action: 'area.create',
      outcome: 'success',
      targetId: id,
      details: { version: 1, vertexCount: 4, replay: false },
    });
    const replay = await audited(alice, 'POST', '/api/v1/areas', body);
    expect(replay.row).toMatchObject({
      action: 'area.create',
      outcome: 'success',
      details: { replay: true },
    });

    const text = await audited(alice, 'POST', '/api/v1/areas', {
      name: '',
      geometry: polygon(uniqueSquare()),
    });
    expect(text.row).toMatchObject({
      action: 'area.create',
      outcome: 'failure',
      details: { code: 'VALIDATION_FAILED', status: 400 },
    });
    const geometry = await audited(alice, 'POST', '/api/v1/areas', { name: 'bowtie', geometry: BOWTIE });
    expect(geometry.row).toMatchObject({
      action: 'area.create',
      outcome: 'failure',
      details: { code: 'INVALID_GEOMETRY', status: 422, subCodes: ['SELF_INTERSECTION'] },
    });
    const idConflict = await audited(bob, 'POST', '/api/v1/areas', body);
    expect(idConflict.row).toMatchObject({
      action: 'area.create',
      outcome: 'failure',
      targetId: id,
      details: { code: 'AREA_ID_CONFLICT', status: 409 },
    });
    const transport = await audited(alice, 'POST', '/api/v1/areas', { ...body, extra: 1 });
    expect(transport.response.statusCode).toBe(400);
    expect(transport.row).toMatchObject({
      action: 'area.create',
      outcome: 'failure',
      details: { code: 'VALIDATION_FAILED', status: 400 },
    });
  });

  it('area.update and area.conflict: success, 404, 409 AREA_DELETED, 422, 428, VERSION_CONFLICT', async () => {
    const { area } = await createArea(kit, alice);
    const url = `/api/v1/areas/${area.id}`;
    const success = await audited(bob, 'PATCH', url, { baseVersion: 1, name: 'Renamed' });
    expect(success.row).toMatchObject({
      action: 'area.update',
      outcome: 'success',
      targetId: area.id,
      details: { fromVersion: 1, toVersion: 2, changedFields: ['name'], merged: false, noop: false },
    });
    const conflict = await audited(alice, 'PATCH', url, { baseVersion: 1, name: 'Mine' });
    expect(conflict.row).toMatchObject({
      action: 'area.conflict',
      outcome: 'failure',
      details: { code: 'VERSION_CONFLICT', baseVersion: 1, currentVersion: 2, conflictingFields: ['name'] },
    });
    const invalid = await audited(alice, 'PATCH', url, { baseVersion: 2, geometry: BOWTIE });
    expect(invalid.row).toMatchObject({
      action: 'area.update',
      outcome: 'failure',
      details: { status: 422 },
    });
    const precondition = await audited(alice, 'PATCH', url, { name: 'x' });
    expect(precondition.row).toMatchObject({
      action: 'area.update',
      outcome: 'failure',
      details: { code: 'PRECONDITION_REQUIRED', status: 428 },
    });
    const missing = await audited(alice, 'PATCH', `/api/v1/areas/${randomUUID()}`, {
      baseVersion: 1,
      name: 'x',
    });
    expect(missing.row).toMatchObject({
      action: 'area.update',
      details: { code: 'AREA_NOT_FOUND', status: 404 },
    });

    expect((await request(kit, alice, 'DELETE', `${url}?baseVersion=2`)).statusCode).toBe(200);
    const deleted = await audited(bob, 'PATCH', url, { baseVersion: 2, name: 'late' });
    expect(deleted.row).toMatchObject({
      action: 'area.update',
      outcome: 'failure',
      details: { code: 'AREA_DELETED', status: 409 },
    });
  });

  it('area.delete and area.restore: success, denied 403, 404, 409 and 428', async () => {
    const { area } = await createArea(kit, alice);
    const url = `/api/v1/areas/${area.id}`;
    const denied = await audited(bob, 'DELETE', `${url}?baseVersion=1`);
    expect(denied.row).toMatchObject({
      action: 'area.delete',
      outcome: 'denied',
      details: { code: 'FORBIDDEN', status: 403 },
    });
    const precondition = await audited(alice, 'DELETE', url);
    expect(precondition.row).toMatchObject({ action: 'area.delete', details: { status: 428 } });
    const stale = await audited(alice, 'DELETE', `${url}?baseVersion=5`);
    expect(stale.row).toMatchObject({ action: 'area.conflict', details: { code: 'VERSION_CONFLICT' } });
    const missing = await audited(alice, 'DELETE', `/api/v1/areas/${randomUUID()}?baseVersion=1`);
    expect(missing.row).toMatchObject({
      action: 'area.delete',
      outcome: 'failure',
      details: { status: 404 },
    });
    const success = await audited(alice, 'DELETE', `${url}?baseVersion=1`);
    expect(success.row).toMatchObject({ action: 'area.delete', outcome: 'success', details: { version: 2 } });
    const again = await audited(alice, 'DELETE', `${url}?baseVersion=2`);
    expect(again.row).toMatchObject({
      action: 'area.delete',
      details: { code: 'AREA_DELETED', status: 409 },
    });

    const restoreDenied = await audited(bob, 'POST', `${url}/restore`, { baseVersion: 2 });
    expect(restoreDenied.row).toMatchObject({ action: 'area.restore', outcome: 'denied' });
    const restorePrecondition = await audited(alice, 'POST', `${url}/restore`, {});
    expect(restorePrecondition.row).toMatchObject({ action: 'area.restore', details: { status: 428 } });
    const restored = await audited(alice, 'POST', `${url}/restore`, { baseVersion: 2 });
    expect(restored.row).toMatchObject({
      action: 'area.restore',
      outcome: 'success',
      details: { version: 3 },
    });
    const notDeleted = await audited(alice, 'POST', `${url}/restore`, { baseVersion: 3 });
    expect(notDeleted.row).toMatchObject({
      action: 'area.restore',
      outcome: 'failure',
      details: { code: 'AREA_NOT_DELETED', status: 409 },
    });
  });

  it('reads are not audit rows (request log only, section 10.4 trail 2)', async () => {
    const { area } = await createArea(kit, alice);
    const requestId = `read-${randomUUID()}`;
    await request(kit, alice, 'GET', `/api/v1/areas/${area.id}`, undefined, { 'x-request-id': requestId });
    await request(kit, alice, 'GET', `/api/v1/areas/${area.id}/versions`, undefined, {
      'x-request-id': requestId,
    });
    expect(kit.audit.find((event) => event.requestId === requestId)).toEqual([]);
  });
});
