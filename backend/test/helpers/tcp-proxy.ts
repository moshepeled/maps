/**
 * TCP proxy for dependency-outage tests (SPEC section 12.2): an app under test points REDIS_URL / CACHE_REDIS_URL /
 * DATABASE_URL at the proxy, never at a stopped shared service.
 *  - `pause()`  destroys live sockets and refuses new ones (a dead dependency);
 *  - `stall()`  keeps every socket open but stops forwarding in both directions (a hung dependency);
 *  - `resume()` forwards again (existing stalled sockets included).
 */
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

export type ProxyMode = 'forward' | 'paused' | 'stalled';

export interface TcpProxy {
  /** The target URL with host/port replaced by the proxy's. */
  readonly url: string;
  readonly port: number;
  readonly mode: ProxyMode;
  pause(): void;
  stall(): void;
  resume(): void;
  close(): Promise<void>;
}

interface Pair {
  client: Socket;
  upstream: Socket | null;
}

export async function createTcpProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = Number(target.port);
  const pairs = new Set<Pair>();
  let mode: ProxyMode = 'forward';

  const link = (pair: Pair): void => {
    if (pair.upstream === null) {
      const upstream = connect({ host: targetHost, port: targetPort });
      pair.upstream = upstream;
      upstream.on('error', () => pair.client.destroy());
      upstream.on('close', () => pair.client.destroy());
    }
    pair.client.pipe(pair.upstream);
    pair.upstream.pipe(pair.client);
    pair.client.resume();
    pair.upstream.resume();
  };

  const unlink = (pair: Pair): void => {
    pair.client.unpipe();
    pair.client.pause();
    if (pair.upstream !== null) {
      pair.upstream.unpipe();
      pair.upstream.pause();
    }
  };

  const server: Server = createServer((client) => {
    if (mode === 'paused') {
      client.destroy();
      return;
    }
    const pair: Pair = { client, upstream: null };
    pairs.add(pair);
    client.on('error', () => pair.upstream?.destroy());
    client.on('close', () => {
      pair.upstream?.destroy();
      pairs.delete(pair);
    });
    if (mode === 'forward') link(pair);
    else client.pause();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);

  return {
    url: proxied.toString(),
    port,
    get mode() {
      return mode;
    },
    pause() {
      mode = 'paused';
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream?.destroy();
      }
      pairs.clear();
    },
    stall() {
      mode = 'stalled';
      for (const pair of pairs) unlink(pair);
    },
    resume() {
      mode = 'forward';
      for (const pair of pairs) link(pair);
    },
    close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream?.destroy();
      }
      pairs.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
