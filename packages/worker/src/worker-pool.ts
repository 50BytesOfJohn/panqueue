import type { PanqueueConfig } from "@panqueue/config";
import type { ConnectionOptions, QueueMap } from "@panqueue/core";
import { notifyKey } from "@panqueue/core";
import { isWorkerDefinition, type WorkerDefinition } from "./define-worker.js";
import {
  RedisConnection,
  type RedisSubscriberConnection,
} from "./redis-connection.js";
import { WorkerRunner } from "./internal/worker-runner.js";

/** Options accepted by {@link WorkerPool.shutdown}. */
export interface ShutdownOptions {
  /**
   * When true, wait for in-flight jobs to acknowledge (complete/fail) before
   * disconnecting Redis. When false (the default), in-flight jobs are
   * immediately handed back to the queue via an atomic requeue script so
   * another worker can pick them up without waiting for the lease to expire.
   *
   * Force shutdown (the default) relies on the at-least-once contract:
   * processors must be idempotent because a force-shutdown job is
   * re-executed on the next worker that claims it. The local handler keeps
   * running until the process exits, but its eventual complete/fail
   * no-ops because the lockToken has been cleared.
   *
   * Default: `false` (force).
   */
  drain?: boolean;
  /**
   * Drain timeout in milliseconds. If the drain does not finish in time,
   * still-in-flight jobs are requeued and Redis is disconnected so the
   * pool never silently exits under live work. The timeout is a single
   * pool-wide budget — not per-runner. Ignored when `drain` is false.
   * Default: no timeout (wait indefinitely).
   */
  timeout?: number;
}

/** Result returned by `WorkerPool.shutdown`. */
export interface ShutdownResult {
  /** The mode this shutdown ran in. */
  mode: "force" | "drain";
  /** Whether a drain timed out before all jobs finished (drain mode only). */
  timedOut: boolean;
  /** Number of jobs still in-flight when shutdown returned (across all queues). */
  unfinishedJobs: number;
  /** Number of in-flight jobs successfully requeued for another worker. */
  requeued: number;
}

/** Options for constructing a {@link WorkerPool}. */
export interface WorkerPoolOptions<TQueues extends QueueMap = QueueMap> {
  /** Worker definitions to materialize when the pool starts. */
  workers: WorkerDefinition<TQueues, keyof TQueues & string>[];
  /**
   * Redis connection used by every runner in this pool. Overrides
   * `config.redis` when provided.
   */
  connection?: ConnectionOptions;
}

/** Lifecycle states of the pool. */
type PoolState = "idle" | "starting" | "running" | "stopping" | "stopped";

/**
 * Owns Redis connections and runs the workers attached at construction
 * time. A pool opens exactly one command client and one subscriber socket,
 * shared across every registered queue.
 *
 * Pools are single-shot: after `shutdown()` resolves, `start()` rejects.
 * Construct a fresh pool to run again.
 *
 * @example
 * ```ts
 * await using pool = new WorkerPool(pq, {
 *   workers: [emailWorker, imageWorker],
 * });
 * await pool.start();
 * ```
 */
export class WorkerPool<TQueues extends QueueMap = QueueMap> {
  readonly #connectionOptions: ConnectionOptions;
  readonly #definitions: ReadonlyArray<WorkerDefinition<TQueues>>;

  #state: PoolState = "idle";
  #startPromise: Promise<void> | null = null;
  #shutdownPromise: Promise<ShutdownResult> | null = null;

  #redis: RedisConnection | null = null;
  #subscriber: RedisSubscriberConnection | null = null;
  #runners: WorkerRunner[] = [];

  constructor(
    config: PanqueueConfig<TQueues>,
    options: WorkerPoolOptions<TQueues>,
  ) {
    if (!options.workers || options.workers.length === 0) {
      throw new Error("WorkerPool requires at least one worker definition");
    }

    const seen = new Set<string>();
    for (const def of options.workers) {
      if (!isWorkerDefinition(def)) {
        throw new TypeError(
          "WorkerPool workers must be created with defineWorker(...)",
        );
      }
      if (seen.has(def.queueId)) {
        throw new Error(
          `Duplicate worker definition for queue "${def.queueId}"`,
        );
      }
      seen.add(def.queueId);
    }

    this.#connectionOptions = options.connection ?? config.redis;
    this.#definitions = options.workers;
  }

  /** Number of registered queues. */
  get size(): number {
    return this.#definitions.length;
  }

  /** Open Redis connections, subscribe to notifications, and start every runner. */
  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "idle") {
      return Promise.reject(
        new Error(`Cannot start pool in state "${this.#state}"`),
      );
    }

    this.#startPromise = this.#doStart().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async #doStart(): Promise<void> {
    this.#state = "starting";

    const redis = new RedisConnection(this.#connectionOptions);
    let subscriber: RedisSubscriberConnection | null = null;
    const subscribedChannels: string[] = [];

    try {
      await redis.connect();
      subscriber = await redis.duplicate();

      const runners = this.#definitions.map((def) =>
        new WorkerRunner(def.queueId, def.processor, def.options, redis.client)
      );

      for (const runner of runners) {
        const channel = notifyKey(runner.queueId);
        await subscriber.client.subscribe(channel, () => runner.wake());
        subscribedChannels.push(channel);
      }

      for (const runner of runners) runner.start();

      this.#redis = redis;
      this.#subscriber = subscriber;
      this.#runners = runners;
      this.#state = "running";
    } catch (err) {
      if (subscriber && subscribedChannels.length > 0) {
        try {
          await subscriber.client.unsubscribe(subscribedChannels);
        } catch { /* ignore */ }
      }
      try {
        await subscriber?.disconnect();
      } catch { /* ignore */ }
      try {
        await redis.disconnect();
      } catch { /* ignore */ }
      this.#state = "stopped";
      throw err;
    }
  }

  /**
   * Shut down every runner and disconnect Redis. Defaults to force mode —
   * see {@link ShutdownOptions}.
   *
   * Idempotent: subsequent calls return the same result.
   */
  shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
    const drain = options?.drain ?? false;
    const mode: "force" | "drain" = drain ? "drain" : "force";

    if (this.#shutdownPromise) return this.#shutdownPromise;

    if (this.#state === "idle") {
      const result: ShutdownResult = {
        mode,
        timedOut: false,
        unfinishedJobs: 0,
        requeued: 0,
      };
      this.#state = "stopped";
      this.#shutdownPromise = Promise.resolve(result);
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = this.#doShutdown(mode, options);
    return this.#shutdownPromise;
  }

  async #doShutdown(
    mode: "force" | "drain",
    options?: ShutdownOptions,
  ): Promise<ShutdownResult> {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch { /* ignore */ }
    }

    if (this.#state !== "running") {
      const result: ShutdownResult = {
        mode,
        timedOut: false,
        unfinishedJobs: 0,
        requeued: 0,
      };
      this.#state = "stopped";
      return result;
    }

    this.#state = "stopping";
    const runners = this.#runners;

    await Promise.allSettled(runners.map((r) => r.stopClaiming()));

    let timedOut = false;

    if (mode === "drain") {
      const drainResults = await Promise.all(
        runners.map((r) => r.drainInflight(options?.timeout)),
      );
      timedOut = drainResults.some((r) => r.timedOut);
    }

    const reason = mode === "drain" ? "shutdown-timeout" : "shutdown";
    const requeueResults = await Promise.all(
      runners.map((r) => r.forceRequeueInflight(reason)),
    );

    let unfinishedJobs = 0;
    let requeued = 0;
    for (const r of requeueResults) {
      unfinishedJobs += r.unfinishedJobs;
      requeued += r.requeued;
    }

    const channels = runners.map((r) => notifyKey(r.queueId));
    if (this.#subscriber && channels.length > 0) {
      try {
        await this.#subscriber.client.unsubscribe(channels);
      } catch { /* ignore */ }
    }
    try {
      await this.#subscriber?.disconnect();
    } catch { /* ignore */ }
    try {
      await this.#redis?.disconnect();
    } catch { /* ignore */ }

    for (const runner of runners) runner.finalize();

    this.#redis = null;
    this.#subscriber = null;
    this.#runners = [];
    this.#state = "stopped";

    return { mode, timedOut, unfinishedJobs, requeued };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }
}
