/**
 * Raw WebSocket test client (SPEC section 12.2): `newWs(url, options)` builds a socket with the `snapland.v1` subprotocol
 * and, when given, an Origin, a client address (X-Forwarded-For through the trusted loopback hop) and extra headers;
 * `untilOpen(socket)` resolves once it is open and rejects with `WsHandshakeError` (HTTP status + body) when the
 * server refuses the upgrade. Attach `message` listeners BEFORE awaiting `untilOpen`: a `welcome` that arrives in the
 * same TCP segment as the 101 response would otherwise be missed. `openWs` combines both for callers without
 * listeners.
 */
import { REALTIME } from '@snapland/shared';
import WebSocket from 'ws';

export class WsHandshakeError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`WebSocket handshake rejected with HTTP ${statusCode}: ${body}`);
    this.name = 'WsHandshakeError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export interface OpenWsOptions {
  /** Origin header; undefined or null sends none (the gateway rejects that). */
  origin?: string | null;
  protocols?: string[];
  headers?: Record<string, string>;
  /** Client IP seen by the server (X-Forwarded-For through the trusted loopback hop). */
  ip?: string;
  /** false: the client does not answer protocol pings (heartbeat tests). */
  autoPong?: boolean;
}

export function newWs(url: string, options: OpenWsOptions = {}): WebSocket {
  return new WebSocket(url, options.protocols ?? [REALTIME.subprotocol], {
    ...(options.origin === undefined || options.origin === null ? {} : { origin: options.origin }),
    headers: { ...options.headers, ...(options.ip === undefined ? {} : { 'x-forwarded-for': options.ip }) },
    autoPong: options.autoPong ?? true,
  });
}

/** Resolves once the socket is open; rejects with WsHandshakeError when the server answers with an HTTP status. */
export function untilOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        reject(new WsHandshakeError(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')));
      });
    });
    socket.once('error', reject);
  });
}

/** Opens a raw socket with no listeners attached (for suites that only need the handshake or the close). */
export async function openWs(url: string, options: OpenWsOptions = {}): Promise<WebSocket> {
  const socket = newWs(url, options);
  await untilOpen(socket);
  return socket;
}
