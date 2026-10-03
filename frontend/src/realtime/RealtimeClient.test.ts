import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { FakeSocket } from '../test/fakeSocket';
import { seededRandom } from './backoff';
import type { ConnectionState, RealtimeHandlers, TicketResult } from './RealtimeClient';
import { OFFLINE_AFTER_REST_FAILURES, RealtimeClient } from './RealtimeClient';

interface Harness {
  client: RealtimeClient;
  sockets: FakeSocket[];
  states: ConnectionState[];
  welcomes: { isReconnect: boolean; outageMs: number | null }[];
  messages: string[];
  reports: { kind: string; code?: number | string | undefined }[];
  pollChanges: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  pollPresence: ReturnType<typeof vi.fn<() => Promise<void>>>;
  antiEntropy: ReturnType<typeof vi.fn<() => void>>;
  signedOut: ReturnType<typeof vi.fn<() => void>>;
  channelLost: ReturnType<typeof vi.fn<() => void>>;
  ticket: { next: TicketResult };
  refresh: { ok: boolean };
  /** When true, every new socket is closed (1006) as soon as it is created (a blocked /ws). */
  block: { ws: boolean };
  online: { value: boolean };
  latest(): FakeSocket;
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const welcomes: { isReconnect: boolean; outageMs: number | null }[] = [];
  const messages: string[] = [];
  const reports: { kind: string; code?: number | string | undefined }[] = [];
  const ticket: { next: TicketResult } = { next: { ok: true, ticket: 't'.repeat(43) } };
  const refresh = { ok: true };
  const block = { ws: false };
  const online = { value: true };
  const pollChanges = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
  const pollPresence = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const antiEntropy = vi.fn<() => void>();
  const signedOut = vi.fn<() => void>();
  const channelLost = vi.fn<() => void>();
  const handlers: RealtimeHandlers = {
    onState: (state) => states.push(state),
    onWelcome: (_welcome, info) => welcomes.push(info),
    onChannelLost: channelLost,
    onMessage: (message) => messages.push(message.type),
    onSignedOut: signedOut,
    onPollChanges: pollChanges,
    onPollPresence: pollPresence,
    onAntiEntropy: antiEntropy,
    reportClientError: (report) => reports.push({ kind: report.kind, code: report.code }),
  };
  const client = new RealtimeClient({
    scheduler: systemScheduler,
    random: seededRandom(42),
    fetchTicket: () => Promise.resolve(ticket.next),
    refreshSession: () => Promise.resolve(refresh.ok),
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      if (block.ws) {
        queueMicrotask(() => {
          socket.drop(1006);
        });
      }
      return socket;
    },
    isOnline: () => online.value,
    handlers,
  });
  return {
    client,
    sockets,
    states,
    welcomes,
    messages,
    reports,
    pollChanges,
    pollPresence,
    antiEntropy,
    signedOut,
    channelLost,
    ticket,
    refresh,
    block,
    online,
    latest: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error('no socket');
      return socket;
    },
  };
}

async function connectLive(h: Harness): Promise<FakeSocket> {
  h.client.start();
  await vi.advanceTimersByTimeAsync(0);
  const socket = h.latest();
  socket.open();
  socket.welcome();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient - connection state machine (SPEC section 7.12)', () => {
  it('connects with a fresh ticket, goes live on welcome and reports the first connection', async () => {
    const h = harness();
    await connectLive(h);
    expect(h.client.connectionState).toBe('live');
    expect(h.states.at(-1)).toBe('live');
    expect(h.welcomes).toEqual([{ isReconnect: false, outageMs: null }]);
  });

  it('welcome timeout -> closes with 4408 after 5 s and backs off', async () => {
    const h = harness();
    h.client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = h.latest();
    socket.open();
    await vi.advanceTimersByTimeAsync(4999);
    expect(socket.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closedWith).toBe(4408);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets.length).toBe(2);
  });

  it('a blip shorter than 3 s is invisible (no reconnecting state)', async () => {
    const h = harness();
    const first = await connectLive(h);
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(1000); // attempt 1: full jitter below 1 s
    const second = h.latest();
    expect(second).not.toBe(first);
    second.open();
    second.welcome();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.states).not.toContain('reconnecting');
    expect(h.welcomes.at(-1)?.isReconnect).toBe(true);
  });

  it('outage: reconnecting after 3 s, limited (REST polling) after 10 s, then live again with a resync', async () => {
    const h = harness();
    const first = await connectLive(h);
    h.block.ws = true;
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.client.connectionState).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.client.connectionState).toBe('limited');
    expect(h.pollChanges).toHaveBeenCalledTimes(1);
    expect(h.pollPresence).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.pollChanges.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(h.pollPresence.mock.calls.length).toBeGreaterThanOrEqual(2);
    h.block.ws = false;
    h.client.retryNow();
    await vi.advanceTimersByTimeAsync(40_000);
    const socket = h.latest();
    socket.open();
    socket.welcome();
    expect(h.client.connectionState).toBe('live');
    const info = h.welcomes.at(-1);
    expect(info?.isReconnect).toBe(true);
    expect(info?.outageMs ?? 0).toBeGreaterThan(10_000);
    const pollsBefore = h.pollChanges.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.pollChanges.mock.calls.length).toBe(pollsBefore);
  });

  it('offline mode after 3 REST failures, and back when REST works', async () => {
    const h = harness();
    h.ticket.next = { ok: false, reason: 'network' };
    h.pollChanges.mockImplementation(() => Promise.resolve(false));
    h.client.start();
    for (let i = 0; i < OFFLINE_AFTER_REST_FAILURES; i += 1) await vi.advanceTimersByTimeAsync(31_000);
    expect(h.client.connectionState).toBe('offline');
    h.ticket.next = { ok: true, ticket: 't'.repeat(43) };
    h.pollChanges.mockImplementation(() => Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.client.connectionState).toBe('limited');
  });

  it('browser offline / online events', async () => {
    const h = harness();
    const socket = await connectLive(h);
    h.client.handleOffline();
    expect(h.client.connectionState).toBe('offline');
    h.client.handleOnline();
    expect(h.client.connectionState).toBe('live');
    // The socket stayed open through the blip: nothing it owned on the server was lost (QA-T5-06).
    expect(h.channelLost).not.toHaveBeenCalled();
    socket.drop(1006);
    expect(h.channelLost).toHaveBeenCalledTimes(1);
    h.client.handleOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets.length).toBe(2);
  });

  it('4401 -> refresh once -> reconnect; a failed refresh signs out', async () => {
    const h = harness();
    const first = await connectLive(h);
    first.drop(4401);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets.length).toBe(2);
    const second = h.latest();
    second.open();
    second.welcome();
    h.refresh.ok = false;
    second.drop(4401);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.client.connectionState).toBe('signed-out');
    expect(h.signedOut).toHaveBeenCalledTimes(1);
    expect(h.sockets.length).toBe(2);
  });

  it('a ticket refused because the session ended signs out', async () => {
    const h = harness();
    h.ticket.next = { ok: false, reason: 'session-ended' };
    h.client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.connectionState).toBe('signed-out');
  });

  it('close codes: 1003 is reported; 4429 waits at least 10 s', async () => {
    const h = harness();
    const first = await connectLive(h);
    first.drop(1003);
    expect(h.reports).toEqual([{ kind: 'ws_close', code: 1003 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const second = h.latest();
    second.open();
    second.welcome();
    second.drop(4429);
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.sockets.length).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets.length).toBe(3);
  });

  it('endSession() (a REST refresh failed, F-11 step 2) closes with 1000, reads Signed out, and start() reconnects', async () => {
    const h = harness();
    const socket = await connectLive(h);
    h.client.endSession();
    expect(socket.closedWith).toBe(1000);
    expect(h.client.connectionState).toBe('signed-out');
    expect(h.states.at(-1)).toBe('signed-out');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets.length).toBe(1);
    h.client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets.length).toBe(2);
  });

  it('stop() closes with 1000 and never reconnects', async () => {
    const h = harness();
    const socket = await connectLive(h);
    h.client.stop();
    expect(socket.closedWith).toBe(1000);
    expect(h.channelLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets.length).toBe(1);
  });
});

describe('RealtimeClient - heartbeat judged on inbound traffic (SPEC section 7.11)', () => {
  it('continuous outbound traffic with no inbound for 60 s -> pings at 20 s and 40 s, pongs answered, no 4408', async () => {
    const h = harness();
    const socket = await connectLive(h);
    const start = Date.now();
    const pingTimes: number[] = [];
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string) => {
      if (data.includes('"type":"ping"')) pingTimes.push(Date.now() - start);
      originalSend(data);
    };
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      h.client.send({ type: 'viewport.set', data: { bbox: [34.7, 32, 34.8, 32.1], zoom: 14 } });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(pingTimes.slice(0, 2)).toEqual([20_000, 40_000]);
    expect(socket.closedWith).toBeNull();
    expect(h.client.connectionState).toBe('live');
  });

  it('no inbound at all (pong suppressed) -> 4408 at 45 s', async () => {
    const h = harness();
    const socket = await connectLive(h);
    socket.answerPings = false;
    await vi.advanceTimersByTimeAsync(44_999);
    expect(socket.sentOfType('ping')).toHaveLength(2);
    expect(socket.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closedWith).toBe(4408);
  });

  it('runs the 60 s anti-entropy pull while live', async () => {
    const h = harness();
    await connectLive(h);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.antiEntropy).toHaveBeenCalledTimes(1);
  });
});

describe('RealtimeClient - messages, requests and the send queue', () => {
  it('flattens batches, ignores unknown types, reports invalid messages', async () => {
    const h = harness();
    const socket = await connectLive(h);
    socket.receive({
      type: 'batch',
      data: {
        messages: [
          {
            type: 'presence.left',
            data: {
              connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
              userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
            },
          },
          { type: 'something.new', data: {} },
        ],
      },
    });
    socket.receive({ type: 'draft.ended', data: { draftId: 'nope' } });
    socket.receiveRaw('{not json');
    expect(h.messages).toEqual(['presence.left']);
    expect(h.reports.map((report) => report.kind)).toEqual(['ws_schema', 'ws_schema']);
  });

  it('correlates ack / error by ref; pending requests fail on close; requests time out', async () => {
    const h = harness();
    const socket = await connectLive(h);
    const acked = h.client.request({
      type: 'lock.release',
      data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' },
    });
    const sent = socket.sent.at(-1);
    socket.receive({ type: 'ack', ref: sent?.ref, data: {} });
    expect((await acked).ok).toBe(true);
    const failed = h.client.request({
      type: 'lock.release',
      data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' },
    });
    socket.receive({
      type: 'error',
      ref: socket.sent.at(-1)?.ref,
      data: { code: 'LOCK_UNAVAILABLE', message: 'x' },
    });
    const failure = await failed;
    expect(failure.ok).toBe(false);
    const timedOut = h.client.request({
      type: 'lock.release',
      data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const timeout = await timedOut;
    expect(!timeout.ok && timeout.error.code).toBe('TIMEOUT');
    const pending = h.client.request({
      type: 'lock.release',
      data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' },
    });
    socket.drop(1006);
    const closed = await pending;
    expect(!closed.ok && closed.error.code).toBe('NOT_CONNECTED');
    const offline = await h.client.request({ type: 'ping', data: { t: 1 } });
    expect(!offline.ok && offline.error.code).toBe('NOT_CONNECTED');
  });

  it('queues non-restated messages while connecting and flushes them after welcome', async () => {
    const h = harness();
    h.client.start();
    expect(
      h.client.send({ type: 'lock.release', data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' } }),
    ).toBe(true);
    expect(
      h.client.send({ type: 'draft.touch', data: { draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' } }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const socket = h.latest();
    socket.open();
    socket.welcome();
    expect(socket.sentOfType('lock.release')).toHaveLength(1);
    expect(socket.sentOfType('draft.touch')).toHaveLength(0);
  });
});
