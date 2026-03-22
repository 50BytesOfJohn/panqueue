import type { PanqueueConfig } from "@panqueue/config";
import type {
  ConnectionOptions,
  JobData,
  JsonSerializable,
  QueueMap,
} from "@panqueue/internal";
import { notifyKey } from "@panqueue/internal";
import { RedisConnection } from "./redis_connection.ts";
import { GlobalJobScheduler } from "./scheduler/global.ts";
import { Semaphore } from "./semaphore.ts";
import type { BaseJobScheduler } from "./scheduler/base.ts";

/** Processor function invoked for each claimed job. */
export type Processor<T extends JsonSerializable = JsonSerializable> = (
  job: JobData<T>,
) => Promise<void>;

/** Lifecycle states of a Worker. */
export type WorkerState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/** Event handlers for observability and logging. */
export interface WorkerEventHandlers<
  T extends JsonSerializable = JsonSerializable,
> {
  /** Called when a job begins processing. */
  onJobStart?: (job: JobData<T>) => void;
  /** Called when a job completes successfully. */
  onJobComplete?: (job: JobData<T>) => void;
  /** Called when a job fails (handler threw). */
  onJobFail?: (job: JobData<T>, error: string) => void;
  /** Called on internal errors. Falls back to console.error when not provided. */
  onError?: (context: string, error: unknown) => void;
  /** Called on every lifecycle state transition. */
  onStateChange?: (from: WorkerState, to: WorkerState) => void;
}

/** Result returned by shutdown(). */
export interface ShutdownResult {
  /** Whether the shutdown timed out before all jobs finished. */
  timedOut: boolean;
  /** Number of jobs still in-flight when shutdown completed. */
  unfinishedJobs: number;
}

/** Options for constructing a Worker. */
export interface WorkerOptions<
  T extends JsonSerializable = JsonSerializable,
> {
  /** Redis connection. Required for Tier 1 (standalone), optional override for Tier 2. */
  connection?: ConnectionOptions;
  /** Maximum number of concurrent jobs. Default: 1. */
  concurrency?: number;
  /** Fallback polling interval in ms. Default: 5000. */
  pollInterval?: number;
  /** Hard shutdown timeout in ms. Default: 5000. */
  shutdownTimeout?: number;
  /** Event handlers for observability. */
  events?: WorkerEventHandlers<T>;
}

/** Brand symbol for WorkerPool detection. */
const WORKER_BRAND = Symbol.for("panqueue.worker");

/**
 * Consumes jobs from a queue and executes a processor function.
 *
 * Supports two constructor forms:
 * - **Tier 1** (standalone): `new Worker(queueId, processor, options)`
 * - **Tier 2** (shared config): `new Worker(config, queueId, processor, options?)`
 */
export class Worker<
  TQueues extends QueueMap = QueueMap,
  K extends keyof TQueues & string = keyof TQueues & string,
> {
  static readonly [WORKER_BRAND] = true;

  readonly #queueId: string;
  readonly #processor: Processor;
  readonly #concurrency: number;
  readonly #pollInterval: number;
  readonly #shutdownTimeout: number;
  readonly #connectionOptions: ConnectionOptions;
  readonly #events: WorkerEventHandlers;

  #redis!: RedisConnection;
  #subscriber!: RedisConnection;
  #scheduler!: BaseJobScheduler;
  #semaphore!: Semaphore;

  #state: WorkerState = "idle";
  #claimLoopPromise: Promise<void> | null = null;
  #startPromise: Promise<void> | null = null;
  #notifyResolve: (() => void) | null = null;
  #inFlight = new Set<Promise<void>>();
  #stopController: AbortController | null = null;

  /** Tier 1 — standalone (no shared config). */
  constructor(
    queueId: K,
    processor: Processor<TQueues[K]>,
    options: WorkerOptions<TQueues[K]> & { connection: ConnectionOptions },
  );

  /** Tier 2 — with shared PanqueueConfig. */
  constructor(
    config: PanqueueConfig<TQueues>,
    queueId: K,
    processor: Processor<TQueues[K]>,
    options?: WorkerOptions<TQueues[K]>,
  );

  constructor(
    ...args:
      | [
        K,
        Processor<TQueues[K]>,
        WorkerOptions<TQueues[K]> & { connection: ConnectionOptions },
      ]
      | [
        PanqueueConfig<TQueues>,
        K,
        Processor<TQueues[K]>,
        WorkerOptions<TQueues[K]>?,
      ]
  ) {
    let options: WorkerOptions<TQueues[K]> | undefined;

    // Detect overload: Tier 2 if first arg has `redis` and `queues` properties
    if (
      typeof args[0] === "object" &&
      args[0] !== null &&
      "redis" in args[0] &&
      "queues" in args[0]
    ) {
      // Tier 2
      const [config, queueId, processor, opts] = args as [
        PanqueueConfig<TQueues>,
        K,
        Processor<TQueues[K]>,
        WorkerOptions<TQueues[K]>?,
      ];
      options = opts;
      this.#queueId = queueId;
      this.#processor = processor as Processor;
      this.#connectionOptions = opts?.connection ?? config.redis;
    } else {
      // Tier 1
      const [queueId, processor, opts] = args as [
        K,
        Processor<TQueues[K]>,
        WorkerOptions<TQueues[K]> & { connection: ConnectionOptions },
      ];
      options = opts;
      this.#queueId = queueId;
      this.#processor = processor as Processor;
      this.#connectionOptions = opts.connection;
    }

    this.#concurrency = options?.concurrency ?? 1;
    this.#pollInterval = options?.pollInterval ?? 5000;
    this.#shutdownTimeout = options?.shutdownTimeout ?? 5000;
    this.#events = (options?.events ?? {}) as WorkerEventHandlers;
  }

  /** The queue ID this worker is consuming from. */
  get queueId(): string {
    return this.#queueId;
  }

  /** The current lifecycle state. */
  get state(): WorkerState {
    return this.#state;
  }

  /** Whether the worker is currently running. */
  get isRunning(): boolean {
    return this.#state === "running";
  }

  /** Start the worker: connect to Redis, subscribe to notifications, begin claim loop. */
  async start(): Promise<void> {
    if (this.#state === "running") return;
    if (this.#state === "stopping") {
      throw new Error(`Cannot start worker while stopping`);
    }
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#doStart();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #doStart(): Promise<void> {
    this.#transition("starting");
    this.#semaphore = new Semaphore(this.#concurrency);
    this.#inFlight = new Set();
    this.#stopController = new AbortController();

    this.#redis = new RedisConnection(this.#connectionOptions);

    try {
      await this.#redis.connect();
      this.#subscriber = await this.#redis.duplicate();

      this.#scheduler = new GlobalJobScheduler(
        this.#queueId,
        this.#redis.client,
      );

      const channel = notifyKey(this.#queueId);
      await this.#subscriber.client.subscribe(channel, () => {
        this.#wakeClaimLoop();
      });
    } catch (err) {
      try {
        await this.#subscriber?.disconnect();
      } catch { /* ignore */ }
      try {
        await this.#redis.disconnect();
      } catch { /* ignore */ }
      this.#transition("failed");
      throw err;
    }

    this.#transition("running");
    this.#claimLoopPromise = this.#claimLoop();
  }

  /** Graceful shutdown: stop claiming, drain in-flight jobs, disconnect. */
  async shutdown(): Promise<ShutdownResult> {
    const clean: ShutdownResult = { timedOut: false, unfinishedJobs: 0 };

    // If start() is in progress, wait for it to finish (or fail) before
    // proceeding. Without this, shutdown would no-op while startup continues.
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch { /* start failed — nothing to shut down */ }
    }

    if (this.#state !== "running") return clean;

    this.#transition("stopping");
    this.#stopController?.abort();
    this.#wakeClaimLoop();
    await this.#claimLoopPromise;

    // Drain in-flight jobs with timeout
    let timedOut = false;
    let unfinishedJobs = 0;

    if (this.#inFlight.size > 0) {
      const drainPromise = Promise.allSettled(this.#inFlight);
      let shutdownTimer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<void>((resolve) => {
        shutdownTimer = setTimeout(resolve, this.#shutdownTimeout);
      });

      const result = await Promise.race([
        drainPromise.then(() => "drained" as const),
        timeoutPromise.then(() => "timeout" as const),
      ]);
      clearTimeout(shutdownTimer!);

      if (result === "timeout" && this.#inFlight.size > 0) {
        timedOut = true;
        unfinishedJobs = this.#inFlight.size;
        this.#emitError(
          "shutdown-timeout",
          new Error(
            `${unfinishedJobs} job(s) still running. Disconnecting with in-flight work.`,
          ),
        );
      }
    }

    try {
      const channel = notifyKey(this.#queueId);
      await this.#subscriber.client.unsubscribe(channel);
    } catch { /* ignore */ }

    await this.#subscriber.disconnect();
    await this.#redis.disconnect();

    this.#transition("stopped");
    this.#claimLoopPromise = null;

    return { timedOut, unfinishedJobs };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  async #claimLoop(): Promise<void> {
    const signal = this.#stopController!.signal;

    while (this.#state === "running") {
      try {
        await this.#semaphore.acquire(signal);
      } catch {
        // AbortError — shutdown requested while waiting for a permit
        break;
      }

      if (this.#state !== "running") {
        this.#semaphore.release();
        break;
      }

      let jobData: JobData | null;
      try {
        jobData = await this.#scheduler.claim();
      } catch (err) {
        this.#semaphore.release();
        this.#emitError("claim", err);
        await this.#waitForNotification();
        continue;
      }

      if (jobData === null) {
        this.#semaphore.release();
        await this.#waitForNotification();
        continue;
      }

      // Capture per-run state so a late-completing job from a timed-out
      // shutdown cannot corrupt a subsequent run's semaphore or inFlight set.
      const inFlight = this.#inFlight;
      const semaphore = this.#semaphore;

      const promise = this.#processJob(jobData).finally(() => {
        inFlight.delete(promise);
        semaphore.release();
      });
      inFlight.add(promise);
    }
  }

  async #processJob(jobData: JobData): Promise<void> {
    this.#emitJobStart(jobData);

    let handlerError: unknown;
    try {
      await this.#processor(jobData);
    } catch (err) {
      handlerError = err;
    }

    if (handlerError === undefined) {
      try {
        await this.#scheduler.complete(jobData.id);
      } catch (err) {
        this.#emitError(
          `complete:${jobData.id}`,
          err,
        );
      }
      this.#emitJobComplete(jobData);
      return;
    }

    const message = handlerError instanceof Error
      ? handlerError.message
      : String(handlerError);
    try {
      await this.#scheduler.fail(jobData.id, message);
    } catch (err) {
      this.#emitError(
        `fail:${jobData.id}`,
        err,
      );
    }
    this.#emitJobFail(jobData, message);
  }

  #waitForNotification(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#notifyResolve = null;
        resolve();
      }, this.#pollInterval);

      this.#notifyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  #wakeClaimLoop(): void {
    if (this.#notifyResolve) {
      const resolve = this.#notifyResolve;
      this.#notifyResolve = null;
      resolve();
    }
  }

  #transition(to: WorkerState): void {
    const from = this.#state;
    this.#state = to;
    try {
      this.#events.onStateChange?.(from, to);
    } catch { /* swallow user callback error */ }
  }

  #emitError(context: string, error: unknown): void {
    if (this.#events.onError) {
      try {
        this.#events.onError(context, error);
      } catch { /* swallow */ }
    } else {
      console.error(`[panqueue] ${context}:`, error);
    }
  }

  #emitJobStart(job: JobData): void {
    try {
      this.#events.onJobStart?.(job);
    } catch { /* swallow */ }
  }

  #emitJobComplete(job: JobData): void {
    try {
      this.#events.onJobComplete?.(job);
    } catch { /* swallow */ }
  }

  #emitJobFail(job: JobData, error: string): void {
    try {
      this.#events.onJobFail?.(job, error);
    } catch { /* swallow */ }
  }
}
