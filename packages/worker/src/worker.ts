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
  /** Called when a job's lease was lost (recovery requeued it under us). */
  onJobStale?: (job: JobData<T>, phase: "complete" | "fail") => void;
  /** Called when stalled jobs are recovered by this worker's sweep. */
  onJobRecovered?: (jobIds: string[]) => void;
  /** Called on internal errors. Falls back to console.error when not provided. */
  onError?: (context: string, error: unknown) => void;
  /** Called on every lifecycle state transition. */
  onStateChange?: (from: WorkerState, to: WorkerState) => void;
}

/** Options accepted by {@link Worker.shutdown}. */
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
   * library never silently exits under live work. Ignored when
   * `drain` is false. Default: no timeout (wait indefinitely).
   */
  timeout?: number;
}

/** Result returned by shutdown(). */
export interface ShutdownResult {
  /** The mode this shutdown ran in. */
  mode: "force" | "drain";
  /** Whether a drain timed out before all jobs finished (drain mode only). */
  timedOut: boolean;
  /** Number of jobs still in-flight locally when shutdown returned. */
  unfinishedJobs: number;
  /** Number of in-flight jobs successfully requeued for another worker. */
  requeued: number;
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
  /**
   * Lease duration in ms for claimed jobs. The job's lease is extended
   * periodically while the handler runs; a crashed worker that fails to
   * extend its lease loses the job to stalled-job recovery after this
   * window. Default: 30_000.
   */
  leaseMs?: number;
  /**
   * Interval in ms between lock renewals for in-flight jobs. Defaults to
   * leaseMs / 3, which gives two retries before the lease can expire.
   */
  lockRenewMs?: number;
  /**
   * Interval in ms between stalled-job recovery sweeps. Each sweep is a
   * single atomic Lua script and is safe to run concurrently across
   * multiple workers on the same queue. Default: 30_000. Set to 0 to
   * disable recovery on this worker.
   */
  recoverIntervalMs?: number;
  /** Maximum jobs processed per recovery sweep. Default: 100. */
  recoverBatchSize?: number;
  /** Event handlers for observability. */
  events?: WorkerEventHandlers<T>;
}

/** Brand symbol for WorkerPool detection. */
const WORKER_BRAND = Symbol.for("panqueue.worker");

interface InFlightEntry {
  promise: Promise<void>;
  jobId: string;
  lockToken: string;
  stopRenewer: () => void;
}

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
  readonly #leaseMs: number;
  readonly #lockRenewMs: number;
  readonly #recoverIntervalMs: number;
  readonly #recoverBatchSize: number;
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
  #inFlight = new Set<InFlightEntry>();
  #stopController: AbortController | null = null;
  #recoverTimer: ReturnType<typeof setInterval> | null = null;

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
    this.#leaseMs = options?.leaseMs ?? 30_000;
    this.#lockRenewMs = options?.lockRenewMs ??
      Math.max(1, Math.floor(this.#leaseMs / 3));
    this.#recoverIntervalMs = options?.recoverIntervalMs ?? 30_000;
    this.#recoverBatchSize = options?.recoverBatchSize ?? 100;
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
    this.#startRecoveryTimer();
  }

  #startRecoveryTimer(): void {
    if (this.#recoverIntervalMs <= 0) return;
    this.#recoverTimer = setInterval(() => {
      this.#runRecoverySweep();
    }, this.#recoverIntervalMs);
  }

  async #runRecoverySweep(): Promise<void> {
    if (this.#state !== "running") return;
    try {
      const recovered = await this.#scheduler.recover(this.#recoverBatchSize);
      if (recovered.length > 0) {
        try {
          this.#events.onJobRecovered?.(recovered);
        } catch { /* swallow */ }
      }
    } catch (err) {
      this.#emitError("recover", err);
    }
  }

  /**
   * Stop consuming jobs and disconnect from Redis.
   *
   * **Default (force) shutdown:** stops the claim loop, atomically requeues
   * every in-flight job so another worker can pick it up immediately, and
   * disconnects. Local handlers keep running until the process exits; their
   * eventual complete/fail no-ops because the lockToken has been cleared.
   * This relies on the at-least-once contract — processors must be
   * idempotent.
   *
   * **Drain (`{ drain: true, timeout? }`):** waits for in-flight jobs to
   * finish before disconnecting. If `timeout` is provided and elapses, any
   * still-in-flight jobs are force-requeued and the worker disconnects so
   * it never exits silently under live work.
   */
  async shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
    const drain = options?.drain ?? false;
    const mode: "force" | "drain" = drain ? "drain" : "force";

    // If start() is in progress, wait for it to finish (or fail) before
    // proceeding. Without this, shutdown would no-op while startup continues.
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch { /* start failed — nothing to shut down */ }
    }

    if (this.#state !== "running") {
      return { mode, timedOut: false, unfinishedJobs: 0, requeued: 0 };
    }

    this.#transition("stopping");
    this.#stopController?.abort();
    if (this.#recoverTimer) {
      clearInterval(this.#recoverTimer);
      this.#recoverTimer = null;
    }
    this.#wakeClaimLoop();
    await this.#claimLoopPromise;

    let timedOut = false;

    if (drain && this.#inFlight.size > 0) {
      const drainPromise = Promise.allSettled(
        [...this.#inFlight].map((e) => e.promise),
      );

      if (options?.timeout !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), options.timeout);
        });
        const result = await Promise.race([
          drainPromise.then(() => "drained" as const),
          timeoutPromise,
        ]);
        if (timer) clearTimeout(timer);
        timedOut = result === "timeout";
      } else {
        await drainPromise;
      }
    }

    // Force-requeue any still-in-flight jobs. In drain mode this only fires
    // on timeout; in force mode it is the normal path.
    let requeued = 0;
    const stillRunning = [...this.#inFlight];
    if (stillRunning.length > 0) {
      // Stop renewers up front so they cannot race the requeue script.
      for (const entry of stillRunning) {
        try {
          entry.stopRenewer();
        } catch { /* swallow */ }
      }

      const reason = drain ? "shutdown-timeout" : "shutdown";
      const results = await Promise.allSettled(
        stillRunning.map((e) =>
          this.#scheduler.requeueActive(e.jobId, e.lockToken, reason)
        ),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          if (r.value === "waiting" || r.value === "failed") requeued++;
        } else {
          this.#emitError(
            `requeue:${stillRunning[i].jobId}`,
            r.reason,
          );
        }
      }
    }
    const unfinishedJobs = stillRunning.length;

    try {
      const channel = notifyKey(this.#queueId);
      await this.#subscriber.client.unsubscribe(channel);
    } catch { /* ignore */ }

    await this.#subscriber.disconnect();
    await this.#redis.disconnect();

    this.#transition("stopped");
    this.#claimLoopPromise = null;

    return { mode, timedOut, unfinishedJobs, requeued };
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
        jobData = await this.#scheduler.claim(this.#leaseMs);
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

      // Capture per-run state so a late-completing job from a force shutdown
      // cannot corrupt a subsequent run's semaphore or inFlight set.
      const inFlight = this.#inFlight;
      const semaphore = this.#semaphore;

      const lockToken = jobData.lockToken ?? "";
      const renewer = this.#startLockRenewer(jobData.id, lockToken);
      const entry: InFlightEntry = {
        promise: undefined as unknown as Promise<void>,
        jobId: jobData.id,
        lockToken,
        stopRenewer: renewer.stop,
      };
      entry.promise = this.#processJob(jobData, renewer).finally(() => {
        inFlight.delete(entry);
        semaphore.release();
      });
      inFlight.add(entry);
    }
  }

  async #processJob(
    jobData: JobData,
    renewer: { stop: () => void },
  ): Promise<void> {
    this.#emitJobStart(jobData);

    const lockToken = jobData.lockToken ?? "";

    let handlerError: unknown;
    try {
      await this.#processor(jobData);
    } catch (err) {
      handlerError = err;
    } finally {
      renewer.stop();
    }

    if (handlerError === undefined) {
      try {
        const result = await this.#scheduler.complete(jobData.id, lockToken);
        if (result === "stale") {
          try {
            this.#events.onJobStale?.(jobData, "complete");
          } catch { /* swallow */ }
          return;
        }
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
      const result = await this.#scheduler.fail(jobData.id, message, lockToken);
      if (result === "stale") {
        try {
          this.#events.onJobStale?.(jobData, "fail");
        } catch { /* swallow */ }
        this.#emitJobFail(jobData, message);
        return;
      }
    } catch (err) {
      this.#emitError(
        `fail:${jobData.id}`,
        err,
      );
    }
    this.#emitJobFail(jobData, message);
  }

  /**
   * Periodically extend the lease on an in-flight job. The renewer stops
   * itself if the lease is lost (recovery already requeued the job),
   * which surfaces to operators via onError but does not abort the
   * handler — the late completion will be detected as "stale".
   */
  #startLockRenewer(jobId: string, lockToken: string): { stop: () => void } {
    if (!lockToken || this.#lockRenewMs <= 0) {
      return { stop: () => {} };
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const ok = await this.#scheduler.extendLock(
          jobId,
          this.#leaseMs,
          lockToken,
        );
        if (!ok) {
          this.#emitError(
            `lease-lost:${jobId}`,
            new Error(
              "Lease lost while job was running. Recovery may have requeued it; complete/fail will be no-ops.",
            ),
          );
          stopped = true;
          return;
        }
      } catch (err) {
        this.#emitError(`extend:${jobId}`, err);
      }
      if (!stopped) {
        timer = setTimeout(tick, this.#lockRenewMs);
      }
    };

    timer = setTimeout(tick, this.#lockRenewMs);

    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
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
