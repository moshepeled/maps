/**
 * Live drafts (SPEC section 7.6 v1.2 lifecycle, section 7.8 invalid accounting, section 10.1 drawing actions): keepalive and idle expiry
 * with the owner notice, uncounted DRAFT_NOT_FOUND for own ids, resume rules, ordering of draft.ended, and the v1.1
 * behaviour (coalescing, stale revs, no echo, resume costs, rate limit, hijack, foreign updates).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { systemClock } from '../../../src/infra/clock.js';
import { InMemoryDrawRateLimiter } from '../../../src/infra/ratelimit/in-memory.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createSession, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { FAST_REALTIME, clientPool, delay, newId } from './realtime-harness.js';
import type { ClientPool, ServerMessage, WsClient } from './realtime-harness.js';

let testApp: TestApp;
let pool: ClientPool;
let audit: InMemoryAuditLogger;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({
    config: FAST_REALTIME,
    overrides: {
      audit,
      drawRateLimiter: new InMemoryDrawRateLimiter({ limit: 50, windowMs: 60_000, clock: systemClock }),
    },
  });
  pool = clientPool(testApp);
  [alice, bob, carol] = await Promise.all([
    createUser(testApp.container, { displayName: 'Alice' }),
    createUser(testApp.container, { displayName: 'Bob' }),
    createUser(testApp.container, { displayName: 'Carol' }),
  ]);
});

afterAll(async () => {
  await pool.closeAll();
  await testApp.close();
});

function vertices(count: number, offset = 0): [number, number][] {
  return Array.from({ length: count }, (_, i) => [34.78 + i * 0.001 + offset, 32.08 + i * 0.0005]);
}

async function start(
  client: WsClient,
  draftId: string,
  options: { areaId?: string | null; resume?: boolean } = {},
) {
  return client.request('draft.start', {
    draftId,
    areaId: options.areaId ?? null,
    resume: options.resume ?? false,
  });
}

function update(client: WsClient, draftId: string, rev: number, points = 3): void {
  client.send({
    type: 'draft.update',
    data: { draftId, rev, vertices: vertices(points), cursor: [34.79, 32.09] },
  });
}

const isUpdated = (draftId: string) => (message: ServerMessage) =>
  message.type === 'draft.updated' && message.data['draftId'] === draftId;
const isEnded = (draftId: string, outcome?: string) => (message: ServerMessage) =>
  message.type === 'draft.ended' &&
  message.data['draftId'] === draftId &&
  (outcome === undefined || message.data['outcome'] === outcome);
const isNotFound = (message: ServerMessage) =>
  message.type === 'error' && message.data['code'] === 'DRAFT_NOT_FOUND';

describe('keepalive, idle expiry and own-id accounting (section 7.6 v1.2)', () => {
  it('draft.touch keeps a quiet draft alive; without it the OWNER gets draft.ended expired; own late updates are not counted, foreign ones close 4400', async () => {
    const owner = await pool.connect(alice);
    const viewer = await pool.connect(bob);
    const draftId = newId();
    expect((await start(owner, draftId)).type).toBe('ack');
    update(owner, draftId, 1);
    await viewer.waitFor(isUpdated(draftId));

    // Idle 1 s, touch every 300 ms: alive for 3 s, and touches are never relayed.
    const relayedBefore = viewer.messages.filter(isUpdated(draftId)).length;
    for (let elapsed = 0; elapsed < 3000; elapsed += 300) {
      owner.send({ type: 'draft.touch', data: { draftId } });
      await delay(300);
    }
    expect(owner.messages.some(isEnded(draftId))).toBe(false);
    expect(viewer.messages.some(isEnded(draftId))).toBe(false);
    expect(owner.messages.some(isNotFound)).toBe(false);
    // Only keyframes (every 300 ms) may have been relayed meanwhile - never a touch-driven rev bump.
    expect(viewer.messages.filter(isUpdated(draftId)).every((message) => message.data['rev'] === 1)).toBe(
      true,
    );
    expect(viewer.messages.filter(isUpdated(draftId)).length).toBeGreaterThanOrEqual(relayedBefore);

    // Silence -> expiry, delivered to the owner AND the viewers.
    const expired = await owner.waitFor(isEnded(draftId, 'expired'), 3000);
    expect(expired.data).toMatchObject({ userId: alice.id, areaId: null });
    await viewer.waitFor(isEnded(draftId, 'expired'));

    // 25 late updates for the formerly owned id: each answered, none counted.
    for (let rev = 2; rev < 27; rev += 1) update(owner, draftId, rev);
    await waitFor(() => owner.messages.filter(isNotFound).length >= 25);
    expect(owner.messages.filter(isNotFound)).toHaveLength(25);
    await delay(200);
    expect(owner.closeCode).toBeNull();

    // A never-owned id: the 21st DRAFT_NOT_FOUND inside 60 s closes the socket with 4400.
    await delay(1200); // refill the inbound bucket (20 tokens/s) so nothing is throttled
    const foreign = newId();
    for (let rev = 1; rev <= 21; rev += 1) update(owner, foreign, rev);
    expect((await owner.closed).code).toBe(4400);
  });
});

describe('resume (section 7.6)', () => {
  it('a NEW session of the same user resumes the draft for free once its socket closed (record disconnected)', async () => {
    const viewer = await pool.connect(carol);
    const first = await pool.connect(alice);
    const draftId = newId();
    expect((await start(first, draftId)).type).toBe('ack');
    update(first, draftId, 1);
    await viewer.waitFor(isUpdated(draftId));
    await first.close();
    await viewer.waitFor(isEnded(draftId, 'disconnected'));

    const secondSession = await createSession(testApp.container, alice.id);
    const second = await pool.connect(alice, { sessionId: secondSession });
    const resumed = await start(second, draftId, { resume: true });
    expect(resumed.type).toBe('ack');
    expect(resumed.data).not.toHaveProperty('drawActionsRemaining');
    update(second, draftId, 7);
    await viewer.waitFor((message) => isUpdated(draftId)(message) && message.data['rev'] === 7);
  });

  it('another LIVE session of the same user cannot take an active draft (DRAFT_NOT_FOUND)', async () => {
    const owner = await pool.connect(alice);
    const draftId = newId();
    expect((await start(owner, draftId)).type).toBe('ack');
    const otherTab = await pool.connect(alice, {
      sessionId: await createSession(testApp.container, alice.id),
    });
    const reply = await start(otherTab, draftId, { resume: true });
    expect(reply).toMatchObject({ type: 'error', data: { code: 'DRAFT_NOT_FOUND' } });
  });

  it('a same-session resume after a reconnect is free; end -> resume is not (costs 1 via a new start)', async () => {
    const first = await pool.connect(alice);
    const draftId = newId();
    const started = await start(first, draftId);
    const remaining = Number(started.data['drawActionsRemaining']);
    await first.close();

    const second = await pool.connect(alice);
    await waitFor(async () => {
      const reply = await start(second, draftId, { resume: true });
      return reply.type === 'ack' ? reply : null;
    });
    const next = newId();
    expect(Number((await start(second, next)).data['drawActionsRemaining'])).toBe(remaining - 1);

    expect(
      (await second.request('draft.end', { draftId: next, outcome: 'cancelled', areaId: null })).type,
    ).toBe('ack');
    expect(await start(second, next, { resume: true })).toMatchObject({
      type: 'error',
      data: { code: 'DRAFT_NOT_FOUND' },
    });
    expect(Number((await start(second, newId())).data['drawActionsRemaining'])).toBe(remaining - 2);
  });
});

describe('ordering (section 7.6, MI27)', () => {
  it('after draft.end no draft.updated of that draft reaches a third client (coalescer + keyframes cancelled)', async () => {
    const third = await pool.connect(carol);
    const owner = await pool.connect(bob);
    const draftId = newId();
    expect((await start(owner, draftId)).type).toBe('ack');
    update(owner, draftId, 1);
    await third.waitFor(isUpdated(draftId));
    // A trailing update is pending (20 ms coalescing) when the end arrives.
    update(owner, draftId, 2, 5);
    owner.send({ type: 'draft.end', ref: 'end', data: { draftId, outcome: 'cancelled', areaId: null } });
    await third.waitFor(isEnded(draftId, 'cancelled'));
    await delay(600); // longer than the 300 ms keyframe interval
    const endedAt = third.messages.findIndex(isEnded(draftId));
    expect(third.messages.slice(endedAt).some(isUpdated(draftId))).toBe(false);
  });
});

describe('v1.1 behaviour (section 7.6, section 10.1)', () => {
  it('coalesces a burst, drops stale revs and never echoes to the sender', async () => {
    const viewer = await pool.connect(carol);
    const owner = await pool.connect(bob);
    const draftId = newId();
    expect((await start(owner, draftId)).type).toBe('ack');
    for (let rev = 1; rev <= 20; rev += 1) update(owner, draftId, rev);
    await viewer.waitFor((message) => isUpdated(draftId)(message) && message.data['rev'] === 20);
    const relayed = viewer.messages.filter(isUpdated(draftId));
    expect(relayed.length).toBeLessThan(20);
    const payload = relayed.at(-1)?.data ?? {};
    expect(payload['user']).toEqual({ id: bob.id, displayName: 'Bob', color: bob.color });
    expect(payload['cursor']).toEqual([34.79, 32.09]);

    update(owner, draftId, 30);
    await viewer.waitFor((message) => isUpdated(draftId)(message) && message.data['rev'] === 30);
    update(owner, draftId, 25);
    update(owner, draftId, 31);
    await viewer.waitFor((message) => isUpdated(draftId)(message) && message.data['rev'] === 31);
    await delay(100);
    expect(viewer.messages.some((message) => isUpdated(draftId)(message) && message.data['rev'] === 25)).toBe(
      false,
    );
    expect(owner.messages.some(isUpdated(draftId))).toBe(false);
  });

  it('a non-resume start of an id owned by someone else is DRAFT_ID_IN_USE; foreign updates are never relayed', async () => {
    const viewer = await pool.connect(carol);
    const owner = await pool.connect(alice);
    const intruder = await pool.connect(bob);
    const draftId = newId();
    expect((await start(owner, draftId)).type).toBe('ack');
    expect(await start(intruder, draftId)).toMatchObject({
      type: 'error',
      data: { code: 'DRAFT_ID_IN_USE' },
    });
    intruder.send({
      type: 'draft.update',
      ref: 'hijack',
      data: { draftId, rev: 99, vertices: vertices(3), cursor: null },
    });
    expect(await intruder.waitFor((message) => message.ref === 'hijack')).toMatchObject({
      data: { code: 'DRAFT_NOT_FOUND' },
    });
    await delay(200);
    expect(
      viewer.messages.some(
        (message) => isUpdated(draftId)(message) && (message.data['user'] as { id: string }).id === bob.id,
      ),
    ).toBe(false);
  });

  it('the 51st draft.start in the window is RATE_LIMITED (and audited through the coalescer)', async () => {
    const dave = await createUser(testApp.container, { displayName: 'Dave' });
    const client = await pool.connect(dave);
    for (let i = 1; i <= 50; i += 1) {
      if (i > 30) await delay(60); // stay under the 20 msg/s inbound bucket
      const reply = await start(client, newId());
      expect(reply.data['drawActionsRemaining']).toBe(50 - i);
    }
    await delay(60);
    const rejected = await start(client, newId());
    expect(rejected).toMatchObject({ type: 'error', data: { code: 'RATE_LIMITED' } });
    expect(Number(rejected.data['retryAfterMs'])).toBeGreaterThan(0);
    await testApp.container.auditCoalescer.flush();
    expect(
      audit.find((event) => event.action === 'ratelimit.hit' && event.actorId === dave.id)[0]?.details,
    ).toMatchObject({ scope: 'draw', transport: 'ws', kind: 'draft.start' });
    expect(
      audit.find(
        (event) => event.action === 'draft.start' && event.outcome === 'denied' && event.actorId === dave.id,
      )[0]?.details,
    ).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('audits the draft lifecycle (start, end) as success rows', async () => {
    const client = await pool.connect(carol);
    const draftId = newId();
    expect((await start(client, draftId)).type).toBe('ack');
    expect((await client.request('draft.end', { draftId, outcome: 'committed', areaId: newId() })).type).toBe(
      'ack',
    );
    await waitFor(() => audit.find((event) => event.action === 'draft.end' && event.targetId === draftId)[0]);
    expect(
      audit.find((event) => event.action === 'draft.start' && event.targetId === draftId)[0],
    ).toMatchObject({
      outcome: 'success',
      details: { resume: false, areaId: null },
    });
  });
});
