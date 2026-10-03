/**
 * DB-backed session re-validation of live sockets (SPEC section 7.2 step 5, MA7). The `sessions` bus is at-most-once, so a lost
 * revocation event (Redis blip, publisher crash after COMMIT, `user-admin disable` while Redis is down) must not leave
 * a revoked socket open for up to 30 days. Every REALTIME_SESSION_REVALIDATE_MS (+/-10 % jitter, unref'd timer) and
 * immediately after the bus subscriber reconnects, the distinct session ids of the local connections are checked with
 * `SessionReader.getActiveMany` in batches of <= 500; sockets whose session is no longer active (revoked, expired, user
 * disabled) are closed with 4401. A DB error skips the round (fail-open, `warn`); the next round retries.
 */
import type { SessionReader } from '../../infra/directory/types.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { Connection } from './connection.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { repeat } from './timers.js';
import type { Cancel } from './timers.js';

export interface SessionRevalidatorDeps {
  sessions: SessionReader;
  registry: ConnectionRegistry;
  intervalMs: number;
  /** Relative jitter of the interval (0.1 = +/-10 %). */
  jitter: number;
  batchSize: number;
  /** Injected randomness in [0, 1) (section 3.8). */
  random: () => number;
  logger: Logger;
  metrics: Metrics;
  /** Closes a socket whose session is no longer active (4401). */
  onInactive: (connection: Connection) => void;
}

/** The delay before the next round: interval x (1 +/- jitter). */
export function jitteredDelay(intervalMs: number, jitter: number, random: () => number): number {
  return Math.round(intervalMs * (1 - jitter + 2 * jitter * random()));
}

export class SessionRevalidator {
  readonly #deps: SessionRevalidatorDeps;
  readonly #log: Logger;
  #cancel: Cancel | null = null;
  /** Rounds run one after the other: a runNow() during a round queues one more (the reconnect may postdate its reads). */
  #tail: Promise<void> = Promise.resolve();

  constructor(deps: SessionRevalidatorDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: 'session-revalidation' });
  }

  start(): void {
    const { intervalMs, jitter, random } = this.#deps;
    this.#cancel ??= repeat(
      () => jitteredDelay(intervalMs, jitter, random),
      () => this.runNow(),
      (error) => {
        this.#log.error({ err: error }, 'session re-validation failed');
      },
    );
  }

  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
  }

  /** Runs a round once the running one (if any) has finished; resolves when this round is done. */
  runNow(): Promise<void> {
    this.#tail = this.#tail.then(() => this.#round());
    return this.#tail;
  }

  /** Never throws, so the round chain can never get stuck on a rejection. */
  async #round(): Promise<void> {
    const sessionIds = this.#deps.registry.sessionIds();
    const active = new Set<string>();
    try {
      for (let start = 0; start < sessionIds.length; start += this.#deps.batchSize) {
        const batch = sessionIds.slice(start, start + this.#deps.batchSize);
        const found = await this.#deps.sessions.getActiveMany(batch);
        for (const sessionId of found.keys()) active.add(sessionId);
      }
    } catch (error) {
      this.#deps.metrics.wsRevalidationRunsTotal.inc({ result: 'db_error' });
      this.#log.warn({ err: error }, 'session re-validation skipped: the database is unavailable');
      return;
    }
    this.#deps.metrics.wsRevalidationRunsTotal.inc({ result: 'ok' });
    const checked = new Set(sessionIds);
    for (const connection of [...this.#deps.registry.values()]) {
      const sessionId = connection.identity.sessionId;
      // Connections registered after the ids were collected are checked by the next round.
      if (!checked.has(sessionId) || active.has(sessionId) || !connection.isOpen) continue;
      this.#deps.metrics.wsRevalidationClosesTotal.inc();
      this.#log.warn(
        { connectionId: connection.id, sessionId },
        'socket of an inactive session closed by re-validation (a sessions event was lost)',
      );
      try {
        this.#deps.onInactive(connection);
      } catch (error) {
        this.#log.error({ err: error, connectionId: connection.id }, 'closing an inactive session failed');
      }
    }
  }
}
