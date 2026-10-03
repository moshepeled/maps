/**
 * Serial task queue of one connection: the handshake first, then the inbound messages, which are validated on arrival
 * but handled strictly one after the other, so a `draft.update` sent right after a `draft.start` is never evaluated
 * before the start's registry claim has completed (which would answer an honest client with DRAFT_NOT_FOUND).
 * Bounded: a full queue refuses new tasks and the dispatcher throttles them.
 */
export class SerialTaskQueue {
  readonly #maxPending: number;
  readonly #onError: (error: unknown) => void;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(maxPending: number, onError: (error: unknown) => void) {
    this.#maxPending = maxPending;
    this.#onError = onError;
  }

  /** Queues `task` behind the previous ones; false (and nothing queued) when the queue is full. */
  push(task: () => Promise<void> | void): boolean {
    if (this.#pending >= this.#maxPending) return false;
    this.#pending += 1;
    this.#tail = this.#tail
      .then(() => task())
      .catch((error: unknown) => {
        this.#onError(error);
      })
      .finally(() => {
        this.#pending -= 1;
      });
    return true;
  }

  /** Resolves once every task queued so far has finished. */
  idle(): Promise<void> {
    return this.#tail;
  }
}
