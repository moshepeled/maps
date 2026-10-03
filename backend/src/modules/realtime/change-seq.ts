/**
 * The latest global change sequence for `welcome` and `resync.required` (SPEC section 5.5, section 7.5), read through the
 * `container.areasReader` port (the single definition shared with REST). While PostgreSQL is unreachable the gateway
 * keeps working (section 10.6): it answers with the highest value it has seen (DB reads and `areas` bus events) instead.
 */
import type { Clock } from '../../infra/clock.js';
import type { AreaReader } from '../../infra/directory/types.js';
import { KeyedThrottle } from '../../infra/keyed-throttle.js';
import type { Logger } from '../../infra/logger.js';

const WARN_INTERVAL_MS = 30_000;

export class ChangeSeqTracker {
  readonly #reader: AreaReader;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #warnings = new KeyedThrottle(WARN_INTERVAL_MS, 1);
  #latest = 0;

  constructor(reader: AreaReader, logger: Logger, clock: Clock) {
    this.#reader = reader;
    this.#logger = logger;
    this.#clock = clock;
  }

  /** Records a sequence seen on the bus (never moves backwards). */
  observe(changeSeq: number): void {
    if (changeSeq > this.#latest) this.#latest = changeSeq;
  }

  /** The authoritative value from the DB; the last known one when the DB fails. Never throws. */
  async current(): Promise<number> {
    try {
      const latest = await this.#reader.latestChangeSeq();
      this.observe(latest);
      return latest;
    } catch (error) {
      if (this.#warnings.shouldFire('latestChangeSeq', this.#clock.now())) {
        this.#logger.warn(
          { err: error },
          'latestChangeSeq unavailable (PostgreSQL); using the last known value',
        );
      }
      return this.#latest;
    }
  }
}
