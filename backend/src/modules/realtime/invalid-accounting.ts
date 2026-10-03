/**
 * Invalid-message accounting of one connection (SPEC section 7.6, section 7.8), pure and clock-driven. Malformed JSON, schema
 * failures, unknown types and DRAFT_NOT_FOUND for draft ids this connection NEVER owned count as invalid; more than
 * `limit` of them within `windowMs` means the socket is closed with 4400.
 *
 * A connection remembers the last `ownedMemory` draft ids it owned for `ownedTtlMs` (the draft resume window), so its
 * own late `draft.update`/`draft.touch` after an expiry, an end or a takeover are answered with DRAFT_NOT_FOUND but
 * never push an honest client toward the 4400 close.
 */
import { WindowCounter } from './token-bucket.js';

export interface InvalidAccountingOptions {
  /** More than this many invalid messages inside the window -> close (default 20). */
  limit: number;
  windowMs: number;
  /** Size of the owned-draft ring (default 8). */
  ownedMemory: number;
  /** How long a formerly owned draft id stays exempt (REALTIME_DRAFT_RESUME_WINDOW_S). */
  ownedTtlMs: number;
}

export interface DraftNotFoundVerdict {
  /** False for a recently owned id (answered, but not counted). */
  counted: boolean;
  /** True when this message pushed the connection over the limit (close 4400). */
  close: boolean;
}

interface OwnedDraft {
  draftId: string;
  /** Exempt until this time (ms). */
  until: number;
}

export class InvalidAccounting {
  readonly #counter: WindowCounter;
  readonly #ownedMemory: number;
  readonly #ownedTtlMs: number;
  /** Most recently owned last. */
  readonly #owned: OwnedDraft[] = [];
  #total = 0;

  constructor({ limit, windowMs, ownedMemory, ownedTtlMs }: InvalidAccountingOptions) {
    this.#counter = new WindowCounter(limit, windowMs);
    this.#ownedMemory = ownedMemory;
    this.#ownedTtlMs = ownedTtlMs;
  }

  /** Invalid messages counted over the connection's lifetime (the `invalid` count of `ws.disconnect`). */
  get total(): number {
    return this.#total;
  }

  /**
   * Records that the connection owns (or has just stopped owning) a draft: called on claim/resume and again when the
   * ownership ends, so the exemption lasts a full window after the end.
   */
  rememberOwned(draftId: string, now: number): void {
    const existing = this.#owned.findIndex((entry) => entry.draftId === draftId);
    if (existing !== -1) this.#owned.splice(existing, 1);
    this.#owned.push({ draftId, until: now + this.#ownedTtlMs });
    while (this.#owned.length > this.#ownedMemory) this.#owned.shift();
  }

  /** Counts one invalid message; true when the connection must be closed with 4400. */
  recordInvalid(now: number): boolean {
    this.#total += 1;
    return this.#counter.hit(now);
  }

  /** DRAFT_NOT_FOUND accounting: counted only for ids this connection never (recently) owned. */
  recordDraftNotFound(draftId: string, now: number): DraftNotFoundVerdict {
    if (this.#owned.some((entry) => entry.draftId === draftId && entry.until > now)) {
      return { counted: false, close: false };
    }
    return { counted: true, close: this.recordInvalid(now) };
  }
}
