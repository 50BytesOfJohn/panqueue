import type { JobData } from "@panqueue/core";

import type {
  Processor,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "../define-worker.js";
import type { PanqueueWorkerClient } from "../redis-connection.js";
import type { BaseJobScheduler, QueueRetention } from "../scheduler/base.js";
import { GlobalJobScheduler } from "../scheduler/global.js";
import { Semaphore } from "../semaphore.js";
import { LeaseRenewer, type LeaseRenewal } from "./lease-renewer.js";
import { StalledRecoverySweep } from "./stalled-recovery-sweep.js";

interface InFlightEntry {
  promise: Promise<void>;
  jobId: string;
  lockToken: string;
  stopRenewer: () => void;
}

/** Result of a force-requeue handoff. */
export interface ForceRequeueResult {
  unfinishedJobs: number;
  requeued: number;
}

/** Result of a drain. */
export interface DrainResult {
  timedOut: boolean;
}

/**
 * Per-queue execution unit owned by a `WorkerPool`. Drives the claim loop,
 * lock renewal, and recovery sweep against a shared Redis client.
 */
export class WorkerRunner {
  readonly queueId: string;

  readonly #processor: Processor;
  readonly #concurrency: number;
  readonly #pollInterval: number;
  readonly #leaseMs: number;
  readonly #lockRenewMs: number;
  readonly #recoverIntervalMs: number;
  readonly #recoverBatchSize: number;
  readonly #events: WorkerEventHandlers;

  readonly #scheduler: BaseJobScheduler;
  readonly #semaphore: Semaphore;
  readonly #leaseRenewer: LeaseRenewer;
  readonly #recoverySweep: StalledRecoverySweep;
  readonly #stopController = new AbortController();
  readonly #inFlight = new Set<InFlightEntry>();

  #state: WorkerState = "idle";
  #claimLoopPromise: Promise<void> | null = null;
  #wakeResolve: (() => void) | null = null;

  constructor(
    queueId: string,
    processor: Processor,
    options: WorkerDefinitionOptions,
    client: PanqueueWorkerClient,
    retention: QueueRetention,
  ) {
    this.queueId = queueId;
    this.#processor = processor;
    this.#concurrency = options.concurrency ?? 1;
    this.#pollInterval = options.pollInterval ?? 5000;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#lockRenewMs = options.lockRenewMs ?? Math.max(1, Math.floor(this.#leaseMs / 3));
    this.#recoverIntervalMs = options.recoverIntervalMs ?? 30_000;
    this.#recoverBatchSize = options.recoverBatchSize ?? 100;
    this.#events = options.events ?? {};

    this.#scheduler = new GlobalJobScheduler(queueId, client, retention);
    this.#semaphore = new Semaphore(this.#concurrency);
    this.#leaseRenewer = new LeaseRenewer({
      scheduler: this.#scheduler,
      leaseMs: this.#leaseMs,
      lockRenewMs: this.#lockRenewMs,
      onError: (context, error) => this.#emitError(context, error),
    });
    this.#recoverySweep = new StalledRecoverySweep({
      scheduler: this.#scheduler,
      intervalMs: this.#recoverIntervalMs,
      batchSize: this.#recoverBatchSize,
      isActive: () => this.#state === "running",
      onJobRecovered: (jobIds) => this.#emitJobRecovered(jobIds),
      onError: (context, error) => this.#emitError(context, error),
    });
  }

  /** Current lifecycle state. */
  get state(): WorkerState {
    return this.#state;
  }

  /** Number of jobs currently being processed. */
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  /** Begin consuming jobs. */
  start(): void {
    if (this.#state !== "idle") {
      throw new Error(
        `WorkerRunner.start called in state "${this.#state}"; runners are single-shot`,
      );
    }
    this.#transition("running");
    this.#claimLoopPromise = this.#claimLoop();
    this.#recoverySweep.start();
  }

  /** Wake the claim loop. */
  wake(): void {
    const resolve = this.#wakeResolve;
    if (resolve) {
      this.#wakeResolve = null;
      resolve();
    }
  }

  /**
   * Stop claiming new jobs and stop the recovery timer. Returns when the
   * claim loop has exited. In-flight handlers continue running.
   */
  async stopClaiming(): Promise<void> {
    if (this.#state !== "running") return;
    this.#transition("stopping");
    this.#stopController.abort();
    this.#recoverySweep.stop();
    this.wake();
    await this.#claimLoopPromise;
    this.#claimLoopPromise = null;
  }

  /**
   * Atomically requeue every in-flight job (fenced on lockToken) so other
   * workers can pick them up immediately. Local handlers keep running to
   * completion; their eventual complete/fail no-op as `stale`.
   */
  async forceRequeueInflight(reason = "shutdown"): Promise<ForceRequeueResult> {
    const stillRunning = [...this.#inFlight];
    if (stillRunning.length === 0) {
      return { unfinishedJobs: 0, requeued: 0 };
    }

    for (const entry of stillRunning) {
      try {
        entry.stopRenewer();
      } catch {
        /* swallow */
      }
    }

    let requeued = 0;
    const results = await Promise.allSettled(
      stillRunning.map((e) => this.#scheduler.requeueActive(e.jobId, e.lockToken, reason)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        if (r.value === "waiting") requeued++;
      } else {
        this.#emitError(`requeue:${stillRunning[i].jobId}`, r.reason);
      }
    }

    return { unfinishedJobs: stillRunning.length, requeued };
  }

  /**
   * Wait for in-flight jobs to acknowledge. If `timeoutMs` is supplied and
   * elapses, returns with `timedOut: true` so the caller can fall through
   * to {@link forceRequeueInflight}.
   */
  async drainInflight(timeoutMs?: number): Promise<DrainResult> {
    if (this.#inFlight.size === 0) return { timedOut: false };

    const drainPromise = Promise.allSettled([...this.#inFlight].map((e) => e.promise));

    if (timeoutMs === undefined) {
      await drainPromise;
      return { timedOut: false };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([
      drainPromise.then(() => "drained" as const),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);
    return { timedOut: result === "timeout" };
  }

  /** Mark the runner stopped. Called by the pool after disconnect. */
  finalize(): void {
    if (this.#state !== "stopped") this.#transition("stopped");
  }

  async #claimLoop(): Promise<void> {
    const signal = this.#stopController.signal;

    while (this.#state === "running") {
      try {
        await this.#semaphore.acquire(signal);
      } catch {
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

      const lockToken = jobData.lockToken ?? "";
      const renewer = this.#leaseRenewer.start(jobData.id, lockToken);
      const entry: InFlightEntry = {
        promise: Promise.resolve(),
        jobId: jobData.id,
        lockToken,
        stopRenewer: renewer.stop,
      };
      entry.promise = this.#processJob(jobData, renewer).finally(() => {
        this.#inFlight.delete(entry);
        this.#semaphore.release();
      });
      this.#inFlight.add(entry);
    }
  }

  async #processJob(jobData: JobData, renewer: LeaseRenewal): Promise<void> {
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
        if (result === "completed") {
          this.#emitJobComplete(jobData);
          return;
        }
        if (result === "stale") {
          try {
            this.#events.onJobStale?.(jobData, "complete");
          } catch {
            /* swallow */
          }
          return;
        }
        this.#emitJobAckError(jobData, "complete", result);
        return;
      } catch (err) {
        this.#emitError(`complete:${jobData.id}`, err);
        this.#emitJobAckError(jobData, "complete", err);
        return;
      }
    }

    const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
    try {
      const result = await this.#scheduler.fail(jobData.id, message, lockToken);
      if (result === "waiting") {
        this.#emitJobRetry(jobData, message);
        return;
      }
      if (result === "failed") {
        this.#emitJobFail(jobData, message);
        return;
      }
      if (result === "stale") {
        try {
          this.#events.onJobStale?.(jobData, "fail");
        } catch {
          /* swallow */
        }
        return;
      }
      this.#emitJobAckError(jobData, "fail", result);
      return;
    } catch (err) {
      this.#emitError(`fail:${jobData.id}`, err);
      this.#emitJobAckError(jobData, "fail", err);
      return;
    }
  }

  #waitForNotification(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.#wakeResolve = null;
      resolve();
    }, this.#pollInterval);

    this.#wakeResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    return promise;
  }

  #transition(to: WorkerState): void {
    const from = this.#state;
    this.#state = to;
    try {
      this.#events.onStateChange?.(from, to);
    } catch {
      /* swallow */
    }
  }

  #emitError(context: string, error: unknown): void {
    if (this.#events.onError) {
      try {
        this.#events.onError(context, error);
      } catch {
        /* swallow */
      }
    }
  }

  #emitJobStart(job: JobData): void {
    try {
      this.#events.onJobStart?.(job);
    } catch {
      /* swallow */
    }
  }

  #emitJobComplete(job: JobData): void {
    try {
      this.#events.onJobComplete?.(job);
    } catch {
      /* swallow */
    }
  }

  #emitJobFail(job: JobData, error: string): void {
    try {
      this.#events.onJobFail?.(job, error);
    } catch {
      /* swallow */
    }
  }

  #emitJobRetry(job: JobData, error: string): void {
    try {
      this.#events.onJobRetry?.(job, error);
    } catch {
      /* swallow */
    }
  }

  #emitJobRecovered(jobIds: string[]): void {
    try {
      this.#events.onJobRecovered?.(jobIds);
    } catch {
      /* swallow */
    }
  }

  #emitJobAckError(job: JobData, phase: "complete" | "fail", error: unknown): void {
    try {
      this.#events.onJobAckError?.(job, phase, error);
    } catch {
      /* swallow */
    }
  }
}
