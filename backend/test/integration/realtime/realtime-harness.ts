/**
 * Shared helpers of the realtime integration suites (SPEC section 12.2, section 12.3). Tickets are issued straight through
 * `container.wsTickets` (the realtime suites must not depend on the auth module's routes), sessions, users and areas are
 * fixture rows, and every socket sends an allowed Origin, the snapland.v1 subprotocol and - for per-IP limits - its own
 * `X-Forwarded-For` address (TRUST_PROXY=loopback trusts the loopback hop).
 */
import { randomUUID } from 'node:crypto';

import { REALTIME, parseServerMessage } from '@snapland/shared';
import type { AreaDto, Bbox } from '@snapland/shared';
import WebSocket from 'ws';

import type { AppConfigInput } from '../../../src/config/env.js';
import type { Container } from '../../../src/container.js';
import type { WsTicketClaims } from '../../../src/infra/auth/ws-tickets.js';
import { sql } from '../../../src/infra/db/types.js';
import type { AreasBusPayload } from '../../../src/infra/events/payloads.js';
import { serializeEntry } from '../../../src/modules/realtime/presence-store.js';
import type { TestApp } from '../../helpers/test-app.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { WsHandshakeError, newWs, untilOpen } from '../../helpers/ws-client.js';
import type { OpenWsOptions } from '../../helpers/ws-client.js';

/** Sub-second realtime timings (section 11.3 test values) shared by the suites. */
export const FAST_REALTIME: AppConfigInput = {
  REALTIME_PRESENCE_REFRESH_MS: 200,
  REALTIME_PRESENCE_SWEEP_MS: 200,
  REALTIME_PRESENCE_STALE_MS: 600,
  REALTIME_DRAFT_IDLE_MS: 1000,
  REALTIME_DRAFT_KEYFRAME_MS: 300,
  REALTIME_DRAFT_COALESCE_MS: 20,
  REALTIME_DRAFT_TOUCH_INTERVAL_MS: 300,
  REALTIME_SESSION_REVALIDATE_MS: 500,
  REALTIME_DRAFT_RESUME_WINDOW_S: 2,
  REALTIME_LOCK_TTL_MS: 1000,
};

/** Tel Aviv viewport used by most suites, and a far-away one (Eilat) that intersects nothing there. */
export const TEL_AVIV_VIEWPORT: Bbox = [34.76, 32.06, 34.81, 32.1];
export const EILAT_VIEWPORT: Bbox = [34.9, 29.5, 34.99, 29.6];

export interface ServerMessage {
  type: string;
  ref?: string;
  data: Record<string, unknown>;
}

export interface WsClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Close code once closed (null while open). */
  readonly closeCode: number | null;
  send(message: unknown): void;
  /** Sends `{ type, ref, data }` with a fresh ref and resolves with the reply carrying that ref. */
  request(type: string, data: unknown, timeoutMs?: number): Promise<ServerMessage>;
  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  ofType(type: string): ServerMessage[];
  close(code?: number): Promise<{ code: number; reason: string }>;
}

export type OpenOptions = Omit<OpenWsOptions, 'headers'>;

let refCounter = 0;

function unwrap(raw: unknown): ServerMessage[] {
  const parsed = parseServerMessage(raw);
  if (parsed.kind === 'batch') {
    return ((raw as ServerMessage).data['messages'] as unknown[]).flatMap(unwrap);
  }
  return [raw as ServerMessage];
}

/** Opens `/ws?ticket=...` with an allowed Origin; rejects with WsHandshakeError when the upgrade is refused. */
export async function openClient(
  testApp: TestApp,
  ticket: string | null,
  options: OpenOptions = {},
): Promise<WsClient> {
  const baseUrl = await testApp.listen();
  const query = ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`;
  const socket = newWs(`${baseUrl.replace(/^http/, 'ws')}${REALTIME.wsPath}${query}`, {
    origin: testApp.config.CORS_ORIGINS[0],
    ...options,
  });
  const messages: ServerMessage[] = [];
  let closeCode: number | null = null;
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) messages.push(...unwrap(JSON.parse(data.toString('utf8'))));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => {
      closeCode = code;
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  await untilOpen(socket);
  const client: WsClient = {
    socket,
    messages,
    closed,
    get closeCode() {
      return closeCode;
    },
    send(message) {
      socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    },
    async request(type, data, timeoutMs = 5000) {
      refCounter += 1;
      const ref = `r${refCounter}`;
      socket.send(JSON.stringify({ type, ref, data }));
      return client.waitFor((message) => message.ref === ref, timeoutMs);
    },
    waitFor(predicate, timeoutMs = 5000) {
      return waitFor(() => messages.find(predicate), {
        timeoutMs,
        description: 'WebSocket message',
        intervalMs: 10,
      });
    },
    ofType(type) {
      return messages.filter((message) => message.type === type);
    },
    close(code = 1000) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(code);
      return closed;
    },
  };
  return client;
}

/** Issues a one-time ticket for the user's session (profile + absolute expiry from the session read port). */
export async function issueTicket(
  container: Container,
  user: Pick<TestUser, 'id' | 'displayName' | 'color' | 'role'>,
  sessionId: string,
  overrides: Partial<WsTicketClaims> = {},
): Promise<string> {
  const session = await container.sessions.getActive(sessionId);
  const absoluteExpiresAt = (session?.absoluteExpiresAt ?? new Date(Date.now() + 3_600_000)).toISOString();
  const { ticket } = await container.wsTickets.issue({
    userId: user.id,
    sessionId,
    displayName: user.displayName,
    color: user.color,
    role: user.role,
    absoluteExpiresAt,
    ...overrides,
  });
  return ticket;
}

export type ConnectOptions = OpenOptions & { sessionId?: string; viewport?: Bbox };

/** Connects a user (its default session unless given) and waits for welcome, presence.snapshot and lock.snapshot. */
export async function connectUser(
  testApp: TestApp,
  user: TestUser,
  options: ConnectOptions = {},
): Promise<WsClient> {
  const ticket = await issueTicket(testApp.container, user, options.sessionId ?? user.sessionId);
  const client = await openClient(testApp, ticket, options);
  await client.waitFor((message) => message.type === 'lock.snapshot');
  if (options.viewport !== undefined) {
    const ack = await client.request('viewport.set', { bbox: options.viewport, zoom: 15 });
    if (ack.type !== 'ack') throw new Error(`viewport.set failed: ${JSON.stringify(ack)}`);
  }
  return client;
}

export interface ClientPool {
  /** `connectUser` on `app` (default: the pool's app) with the Tel Aviv viewport unless given; closed by closeAll(). */
  connect(user: TestUser, options?: ConnectOptions & { app?: TestApp }): Promise<WsClient>;
  closeAll(): Promise<void>;
}

/** The sockets one suite opens, closed together in its afterAll. */
export function clientPool(testApp: TestApp): ClientPool {
  const clients: WsClient[] = [];
  return {
    async connect(user, { app = testApp, ...options } = {}) {
      const client = await connectUser(app, user, { viewport: TEL_AVIV_VIEWPORT, ...options });
      clients.push(client);
      return client;
    },
    async closeAll() {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

/** Resolves with the handshake status: 101 on success (the socket is closed again), else the HTTP status. */
export async function handshakeStatus(
  testApp: TestApp,
  ticket: string | null,
  options: OpenOptions = {},
): Promise<number> {
  try {
    const client = await openClient(testApp, ticket, options);
    await client.close();
    return 101;
  } catch (error) {
    if (error instanceof WsHandshakeError) return error.statusCode;
    throw error;
  }
}

/** A presence registry entry as another instance would write it (a viewing user without a viewport). */
export function fakePresenceEntry(connectionId: string, user: TestUser, updatedAtMs: number): string {
  const at = new Date(updatedAtMs).toISOString();
  return serializeEntry(
    {
      connectionId,
      userId: user.id,
      displayName: user.displayName,
      color: user.color,
      status: 'viewing',
      activeAreaId: null,
      viewport: null,
      connectedAt: at,
      updatedAt: at,
    },
    'other-instance',
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function newId(): string {
  return randomUUID();
}

// -- Fixture rows (tests only; the realtime module itself contains no SQL) ------------------------

const INSERT_AREA = sql(
  'testRealtime.insertArea',
  `INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, change_seq, created_by, updated_by)
   SELECT $1, 'Realtime probe', g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4, 0.01,
          nextval('area_change_seq'), $2, $2
   FROM (SELECT ST_MakeEnvelope($3, $4, $5, $6, 4326) AS g) s`,
);

/** A live area (for lock bboxes) inside the Tel Aviv viewport by default. */
export async function insertArea(
  container: Container,
  userId: string,
  bbox: Bbox = [34.78, 32.08, 34.79, 32.09],
): Promise<string> {
  const id = randomUUID();
  await container.db.query(INSERT_AREA, [id, userId, ...bbox]);
  return id;
}

/** An `areas` bus payload as the areas service publishes it after COMMIT (section 7.10). */
export function areaChangedPayload(user: TestUser, bbox: Bbox, changeSeq: number): AreasBusPayload {
  const [west, south, east, north] = bbox;
  const actor = { id: user.id, displayName: user.displayName, color: user.color };
  const area: AreaDto = {
    id: randomUUID(),
    name: 'Bus probe',
    description: null,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
    areaKm2: 1,
    perimeterKm: 4,
    vertexCount: 4,
    bbox,
    version: 1,
    changeSeq,
    createdBy: actor,
    updatedBy: actor,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    deletedBy: null,
  };
  return {
    changeSeq,
    op: 'create',
    area,
    prevBbox: null,
    previousName: null,
    changedFields: ['name', 'description', 'geometry'],
    merged: false,
    actor,
  };
}
