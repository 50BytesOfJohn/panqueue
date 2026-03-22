import type {
  ConnectionOptions,
  JsonSerializable,
  QueueMap,
} from "@panqueue/internal";
import { type Processor, type ShutdownResult, Worker, type WorkerOptions } from "./worker.ts";

/** Options for constructing a WorkerPool. */
export interface WorkerPoolOptions {
  /** Redis connection used by all workers in this pool. */
  connection: ConnectionOptions;
  /** Default concurrency for all workers. Default: 1. */
  concurrency?: number;
  /** Default poll interval in ms for all workers. Default: 5000. */
  pollInterval?: number;
  /** Default shutdown timeout in ms for all workers. Default: 5000. */
  shutdownTimeout?: number;
}

/** Helper type for defining processor functions in separate files. */
export type QueueProcessor<
  TQueues extends QueueMap,
  K extends keyof TQueues & string,
> = Processor<TQueues[K]>;

interface Registration {
  processor: Processor;
  options?: Omit<WorkerOptions, "connection">;
}

/**
 * Manages a group of workers consuming from typed queues.
 *
 * `TQueues` is set once on the pool. The `.process()` method infers `K`
 * from the queue name argument, giving full type narrowing on `job.data`.
 *
 * ```ts
 * const pool = new WorkerPool<MyQueues>({
 *   connection: { host: "localhost", port: 6379 },
 * });
 * pool.process("emails", async (job) => { job.data.to; });
 * await pool.start();
 * ```
 */
export class WorkerPool<TQueues extends QueueMap = QueueMap> {
  readonly #options: WorkerPoolOptions;
  readonly #registrations = new Map<string, Registration>();
  readonly #workers = new Map<string, Worker>();
  #started = false;

  constructor(options: WorkerPoolOptions) {
    this.#options = options;
  }

  /** Register a processor for a queue. Returns `this` for chaining. */
  process<K extends keyof TQueues & string>(
    queueId: K,
    processor: Processor<TQueues[K]>,
    options?: Omit<WorkerOptions<TQueues[K]>, "connection">,
  ): this {
    if (this.#started) {
      throw new Error("Cannot register processors after the pool has started");
    }
    if (this.#registrations.has(queueId)) {
      throw new Error(`Processor already registered for queue "${queueId}"`);
    }
    this.#registrations.set(queueId, {
      processor: processor as Processor,
      options: options as Omit<WorkerOptions, "connection"> | undefined,
    });
    return this;
  }

  /** Start all registered workers. */
  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Pool is already started");
    }
    if (this.#registrations.size === 0) {
      throw new Error("No processors registered");
    }

    this.#started = true;

    for (const [queueId, reg] of this.#registrations) {
      const worker = new Worker(queueId, reg.processor, {
        connection: this.#options.connection,
        concurrency: reg.options?.concurrency ?? this.#options.concurrency,
        pollInterval: reg.options?.pollInterval ?? this.#options.pollInterval,
        shutdownTimeout: reg.options?.shutdownTimeout ??
          this.#options.shutdownTimeout,
        events: reg.options?.events,
      });
      this.#workers.set(queueId, worker);
    }

    const entries = [...this.#workers.entries()];
    const results = await Promise.allSettled(
      entries.map(([, w]) => w.start()),
    );

    const firstFailure = results.findIndex((r) => r.status === "rejected");
    if (firstFailure !== -1) {
      // Shut down workers that started successfully
      const shutdowns: Promise<ShutdownResult>[] = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
          shutdowns.push(entries[i][1].shutdown());
        }
      }
      await Promise.allSettled(shutdowns);
      this.#workers.clear();
      this.#registrations.clear();
      this.#started = false;

      throw (results[firstFailure] as PromiseRejectedResult).reason;
    }
  }

  /** Graceful shutdown of all workers. */
  async shutdown(): Promise<ShutdownResult> {
    if (!this.#started) {
      return { timedOut: false, unfinishedJobs: 0 };
    }

    const results = await Promise.allSettled(
      [...this.#workers.values()].map((w) => w.shutdown()),
    );

    let timedOut = false;
    let unfinishedJobs = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.timedOut) timedOut = true;
        unfinishedJobs += result.value.unfinishedJobs;
      }
    }

    this.#workers.clear();
    this.#started = false;

    return { timedOut, unfinishedJobs };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }
}
