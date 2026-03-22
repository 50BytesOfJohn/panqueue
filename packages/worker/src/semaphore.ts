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
  #max: number;
  #current: number = 0;
  #waiters: Waiter[] = [];
  #drainWaiters: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new RangeError("Semaphore max must be >= 1");
    this.#max = max;
  }

  /** Number of permits currently available. */
  get available(): number {
    return this.#max - this.#current;
  }

  /** Number of waiters blocked on acquire(). */
  get pending(): number {
    return this.#waiters.length;
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

  /** Release a permit and wake the next waiter (FIFO). */
  release(): void {
    if (this.#waiters.length > 0) {
      const next = this.#waiters.shift()!;
      next.cleanup?.();
      next.resolve();
    } else {
      this.#current--;
      if (this.#current === 0) {
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters = [];
      }
    }
  }

  /** Resolves when all permits have been returned (current === 0). */
  drain(): Promise<void> {
    if (this.#current === 0 && this.#waiters.length === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }
}
