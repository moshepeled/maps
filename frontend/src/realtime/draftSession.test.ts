import type { AreaMutationResponse, ClientMessage, CreateAreaRequest } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { areaDto, uuid } from '../test/factories';
import type { DraftTransport, SharingStatus } from './draftSession';
import { DraftSession, saveDraftAsArea } from './draftSession';
import type { RequestResult } from './RealtimeClient';

type Outbound = Omit<ClientMessage, 'ref'>;

class FakeTransport implements DraftTransport {
  isLive = true;
  readonly sent: Outbound[] = [];
  readonly requests: { message: Outbound; resolve(result: RequestResult): void }[] = [];

  send(message: Outbound): boolean {
    this.sent.push(message);
    return this.isLive;
  }

  request(message: Outbound): Promise<RequestResult> {
    return new Promise((resolve) => {
      this.requests.push({ message, resolve });
    });
  }

  /** Answers the oldest unanswered request. */
  answer(result: RequestResult): void {
    const pending = this.requests.shift();
    if (pending === undefined) throw new Error('no pending request');
    pending.resolve(result);
  }

  starts(): { draftId: string; resume: boolean }[] {
    return [...this.sent, ...this.requests.map((request) => request.message)]
      .filter((message) => message.type === 'draft.start')
      .map((message) => message.data as { draftId: string; resume: boolean });
  }

  ofType(type: string): Outbound[] {
    return this.sent.filter((message) => message.type === type);
  }
}

const POINTS: [number, number][] = [
  [34.7812012, 32.0811021],
  [34.7851334, 32.0813441],
  [34.7849771, 32.0846211],
];

let ids = 0;
function harness() {
  const transport = new FakeTransport();
  const statuses: SharingStatus[] = [];
  const allStarts: { draftId: string; resume: boolean }[] = [];
  const originalRequest = transport.request.bind(transport);
  transport.request = (message) => {
    if (message.type === 'draft.start') allStarts.push(message.data as { draftId: string; resume: boolean });
    return originalRequest(message);
  };
  const session = new DraftSession({
    transport,
    scheduler: systemScheduler,
    newId: () => {
      ids += 1;
      return uuid(1000 + ids);
    },
    touchIntervalMs: () => 20_000,
    updateIntervalMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });
  return { transport, session, statuses, allStarts };
}

const ACK: RequestResult = { ok: true, data: { drawActionsRemaining: 49 } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('draftSession - streaming (SPEC section 7.6, section 7.8)', () => {
  it('starts on the first point, then streams the latest state at <= 10 Hz with 6-dp coordinates', async () => {
    const { transport, session } = harness();
    session.open(null, { vertices: POINTS.slice(0, 1), cursor: null });
    expect(transport.requests[0]?.message).toMatchObject({
      type: 'draft.start',
      data: { areaId: null, resume: false },
    });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const first = transport.ofType('draft.update')[0];
    expect(first?.data).toMatchObject({ rev: 1, vertices: [[34.781201, 32.081102]], cursor: null });
    for (let i = 0; i < 10; i += 1)
      session.update({ vertices: POINTS.slice(0, 2), cursor: [34.78, 32.08 + i / 1000] }, false);
    expect(transport.ofType('draft.update')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    const updates = transport.ofType('draft.update');
    expect(updates).toHaveLength(2);
    expect(updates[1]?.data).toMatchObject({ rev: 2, cursor: [34.78, 32.089] });
  });

  it('sends draft.touch every 20 s while in Naming with no updates', async () => {
    const { transport, session } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.ofType('draft.touch')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.ofType('draft.touch')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.ofType('draft.touch')).toHaveLength(2);
    // An update resets the keepalive clock.
    await vi.advanceTimersByTimeAsync(10_000);
    session.update({ vertices: POINTS, cursor: [34.78, 32.08] });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(transport.ofType('draft.touch')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.ofType('draft.touch')).toHaveLength(3);
    session.close('cancelled');
    expect(transport.requests.at(-1)?.message).toMatchObject({
      type: 'draft.end',
      data: { outcome: 'cancelled' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.ofType('draft.touch')).toHaveLength(3);
  });

  it('RATE_LIMITED start -> updates held -> start re-sent with the same id after retryAfterMs -> latest update sent', async () => {
    const { transport, session, statuses } = harness();
    session.open(null, { vertices: POINTS.slice(0, 1), cursor: null });
    const firstId = session.draftId;
    transport.answer({ ok: false, error: { code: 'RATE_LIMITED', message: 'limit', retryAfterMs: 8421 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ kind: 'rate-limited', retryAt: Date.now() + 8421 });
    session.update({ vertices: POINTS, cursor: null });
    await vi.advanceTimersByTimeAsync(8420);
    expect(transport.ofType('draft.update')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.requests[0]?.message).toMatchObject({
      type: 'draft.start',
      data: { draftId: firstId, resume: false },
    });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.ofType('draft.update')[0]?.data).toMatchObject({
      draftId: firstId,
      vertices: POINTS.map(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]),
    });
    expect(statuses.at(-1)).toEqual({ kind: 'live' });
  });
});

describe('draftSession - recovery under a new id (SPEC section 7.12 step 11)', () => {
  it('resume refused with DRAFT_NOT_FOUND -> a non-resume start with a new id', async () => {
    const { transport, session, allStarts } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const original = session.draftId;
    session.handleDisconnected();
    session.handleWelcome();
    expect(allStarts.at(-1)).toEqual({ draftId: original, areaId: null, resume: true });
    transport.answer({ ok: false, error: { code: 'DRAFT_NOT_FOUND', message: 'gone' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(allStarts.at(-1)?.resume).toBe(false);
    expect(allStarts.at(-1)?.draftId).not.toBe(original);
    expect(session.draftId).toBe(allStarts.at(-1)?.draftId);
  });

  it('own draft.ended expired -> new id, one non-resume start, latest state sent', async () => {
    const { transport, session, allStarts } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const original = session.draftId ?? '';
    session.update({ vertices: POINTS, cursor: [34.79, 32.09] });
    session.handleOwnDraftEnded(uuid(1), 'expired'); // not mine: ignored
    session.handleOwnDraftEnded(original, 'cancelled'); // not an expiry: ignored
    expect(allStarts).toHaveLength(1);
    session.handleOwnDraftEnded(original, 'expired');
    expect(allStarts).toHaveLength(2);
    expect(allStarts[1]).toMatchObject({ resume: false });
    expect(allStarts[1]?.draftId).not.toBe(original);
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const last = transport.ofType('draft.update').at(-1);
    expect(last?.data).toMatchObject({ draftId: allStarts[1]?.draftId, rev: 1, cursor: [34.79, 32.09] });
  });

  it('the first DRAFT_NOT_FOUND on an update -> the same recovery exactly once', async () => {
    const { transport, session, allStarts } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const original = session.draftId ?? '';
    session.handleServerError({
      code: 'DRAFT_NOT_FOUND',
      message: `Draft ${uuid(9999)} is not active on this connection.`,
    });
    expect(allStarts).toHaveLength(1);
    session.handleServerError({
      code: 'DRAFT_NOT_FOUND',
      message: `Draft ${original} is not active on this connection.`,
    });
    session.handleServerError({
      code: 'DRAFT_NOT_FOUND',
      message: `Draft ${original} is not active on this connection.`,
    });
    session.handleServerError({ code: 'DRAFT_NOT_FOUND', message: 'Draft is not active.' });
    expect(allStarts).toHaveLength(2);
    expect(allStarts[1]?.draftId).not.toBe(original);
  });

  it('DRAFT_ID_IN_USE -> new id with points kept, and the save uses it', async () => {
    const { transport, session } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    const original = session.draftId;
    transport.answer({ ok: false, error: { code: 'DRAFT_ID_IN_USE', message: 'in use' } });
    await vi.advanceTimersByTimeAsync(0);
    const replacement = session.draftId;
    expect(replacement).not.toBe(original);
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.ofType('draft.update')[0]?.data).toMatchObject({
      draftId: replacement,
      vertices: expect.any(Array) as unknown,
    });
    const created: CreateAreaRequest[] = [];
    const response = await saveDraftAsArea(
      session,
      { name: 'North Field', geometry: { type: 'Polygon', coordinates: [[...POINTS, POINTS[0] ?? [0, 0]]] } },
      (request) => {
        created.push(request);
        return Promise.resolve(mutation(request.id ?? ''));
      },
      () => uuid(),
    );
    expect(created[0]?.id).toBe(replacement);
    expect(response.area.id).toBe(replacement);
    expect(transport.requests.at(-1)?.message).toMatchObject({
      type: 'draft.end',
      data: { outcome: 'committed', areaId: replacement },
    });
  });

  it('at most one automatic re-start per 60 s; a second failure pauses sharing until the next point change', async () => {
    const { transport, session, allStarts, statuses } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    session.handleOwnDraftEnded(session.draftId ?? '', 'expired');
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(30_000);
    session.handleOwnDraftEnded(session.draftId ?? '', 'expired');
    expect(allStarts).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ kind: 'paused' });
    session.update({ vertices: POINTS, cursor: [34.79, 32.09] }, false); // a pointer move is not a point change
    expect(allStarts).toHaveLength(2);
    session.update({ vertices: [...POINTS, [34.79, 32.09]], cursor: null }, true);
    expect(allStarts).toHaveLength(3);
  });
});

function mutation(id: string): AreaMutationResponse {
  return { area: areaDto({ id }), merged: false, noop: false, serverChangedFields: [] };
}

describe('saveDraftAsArea - AREA_ID_CONFLICT (SPEC section 7.12 step 10)', () => {
  it('regenerates the id, retries once, then ends the old draft as cancelled', async () => {
    const { transport, session } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    const oldId = session.draftId;
    const attempts: (string | undefined)[] = [];
    const response = await saveDraftAsArea(
      session,
      { name: 'X', geometry: { type: 'Polygon', coordinates: [] } },
      (request) => {
        attempts.push(request.id);
        if (attempts.length === 1)
          return Promise.reject(Object.assign(new Error('conflict'), { code: 'AREA_ID_CONFLICT' }));
        return Promise.resolve(mutation(request.id ?? ''));
      },
      () => uuid(4242),
    );
    expect(attempts).toEqual([oldId, uuid(4242)]);
    expect(response.area.id).toBe(uuid(4242));
    expect(transport.requests.at(-1)?.message).toMatchObject({
      type: 'draft.end',
      data: { draftId: oldId, outcome: 'cancelled' },
    });
    expect(session.isOpen).toBe(false);
  });

  it('a second conflict surfaces to the caller', async () => {
    const { session } = harness();
    const conflict = () => Promise.reject(Object.assign(new Error('conflict'), { code: 'AREA_ID_CONFLICT' }));
    await expect(
      saveDraftAsArea(session, { name: 'X', geometry: { type: 'Polygon', coordinates: [] } }, conflict, () =>
        uuid(),
      ),
    ).rejects.toThrow('conflict');
  });

  it('other errors surface at once and keep the draft open', async () => {
    const { transport, session } = harness();
    session.open(null, { vertices: POINTS, cursor: null });
    transport.answer(ACK);
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      saveDraftAsArea(
        session,
        { name: 'X', geometry: { type: 'Polygon', coordinates: [] } },
        () => Promise.reject(new Error('offline')),
        () => uuid(),
      ),
    ).rejects.toThrow('offline');
    expect(session.isOpen).toBe(true);
  });

  it('an offline start stays local and starts on welcome', () => {
    const { transport, session, statuses, allStarts } = harness();
    transport.isLive = false;
    session.open(null, { vertices: POINTS, cursor: null });
    expect(statuses.at(-1)).toEqual({ kind: 'local' });
    expect(allStarts).toHaveLength(0);
    transport.isLive = true;
    session.handleWelcome();
    expect(allStarts).toEqual([{ draftId: session.draftId, areaId: null, resume: false }]);
  });
});
