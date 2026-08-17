/** Entry in the waiter queue: resolve callback + optional cleanup. */
interface Waiter {
  resolve: () => void;
  cleanup?: () => void;
}

/**
 * Async counting semaphore for concurrency control.
 *
 * Used by the Worker to limit the number of concurrently processing jobs.
 */
export class Semaphore {
  readonly #max: number;
  #current: number = 0;
  #waiters: Waiter[] = [];

  constructor(max: number) {
    if (max < 1) throw new RangeError("Semaphore max must be >= 1");
    this.#max = max;
  }

  /** Number of permits currently available. */
  get available(): number {
    return this.#max - this.#current;
  }

  /**
   * Acquire a permit. Resolves immediately if available, otherwise waits.
   *
   * If an `AbortSignal` is provided and it is aborted while waiting, the
   * waiter is removed from the queue and the returned promise rejects with
   * the signal's reason (an `AbortError` by default).
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    if (this.#current < this.#max) {
      this.#current++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve };
      this.#waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          const idx = this.#waiters.indexOf(waiter);
          if (idx !== -1) {
            this.#waiters.splice(idx, 1);
            reject(signal.reason);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
    });
  }

  /**
   * Try to acquire a permit without waiting. Returns `true` and takes a permit
   * if one is free, `false` otherwise. Used to greedily top up a batch claim.
   */
  tryAcquire(): boolean {
    if (this.#current < this.#max) {
      this.#current++;
      return true;
    }
    return false;
  }

  /** Release a permit and wake the next waiter (FIFO). */
  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next.cleanup?.();
      next.resolve();
    } else {
      this.#current--;
    }
  }
}
