import type { JobData, JobStatus } from "@panqueue/core";

import type {
  Processor,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "../define-worker.js";
import type { PanqueueWorkerClient } from "../redis-connection.js";
import type { BaseJobScheduler, QueueRetention, RecoveredJob } from "../scheduler/base.js";
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
      onError: (scope, error) => this.#emitWorkerError(scope, error),
    });
    this.#recoverySweep = new StalledRecoverySweep({
      scheduler: this.#scheduler,
      intervalMs: this.#recoverIntervalMs,
      batchSize: this.#recoverBatchSize,
      isActive: () => this.#state === "running",
      onRecovered: (jobs) => this.#handleRecovered(jobs),
      onError: (scope, error) => this.#emitWorkerError(scope, error),
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
        this.#emitWorkerError(`requeue:${stillRunning[i].jobId}`, r.reason);
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
        this.#emitWorkerError("claim", err);
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
    this.#safeEmit(this.#events.onJobStarted, { job: jobData });

    const lockToken = jobData.lockToken ?? "";

    let handlerError: unknown;
    let handlerThrew = false;
    try {
      await this.#processor(jobData);
    } catch (err) {
      handlerError = err;
      handlerThrew = true;
    } finally {
      renewer.stop();
    }

    if (!handlerThrew) {
      try {
        const result = await this.#scheduler.complete(jobData.id, lockToken);
        if (result === "completed") {
          this.#safeEmit(this.#events.onJobCompleted, {
            job: settledSnapshot(jobData, "completed"),
          });
          return;
        }
        if (result === "stale") {
          this.#safeEmit(this.#events.onJobStale, { job: jobData, phase: "complete" });
          return;
        }
        this.#safeEmit(this.#events.onJobAckError, {
          job: jobData,
          phase: "complete",
          error: result,
        });
        return;
      } catch (err) {
        this.#emitWorkerError(`complete:${jobData.id}`, err);
        this.#safeEmit(this.#events.onJobAckError, { job: jobData, phase: "complete", error: err });
        return;
      }
    }

    const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
    const attempt = jobData.runs;
    try {
      const result = await this.#scheduler.fail(jobData.id, message, lockToken);
      if (result === "waiting" || result === "failed") {
        // The snapshot predates the fail script; fold its durable writes in
        // so handlers see authoritative counters and status.
        const failures = jobData.failures + 1;
        const job: JobData = {
          ...settledSnapshot(jobData, result),
          failures,
          failureKind: "handler",
          failedReason: message,
          lastError: message,
        };
        this.#safeEmit(this.#events.onJobError, {
          job,
          error: handlerError,
          attempt,
          willRetry: result === "waiting",
        });
        if (result === "waiting") {
          this.#safeEmit(this.#events.onJobRetry, {
            job,
            error: handlerError,
            attempt,
            retriesLeft: Math.max(0, job.maxRetries - failures),
            cause: "handler",
          });
        } else {
          this.#safeEmit(this.#events.onJobFailed, {
            job,
            error: handlerError,
            attempts: jobData.runs,
            cause: "handler",
          });
        }
        return;
      }
      if (result === "stale") {
        this.#safeEmit(this.#events.onJobStale, { job: jobData, phase: "fail" });
        return;
      }
      this.#safeEmit(this.#events.onJobAckError, { job: jobData, phase: "fail", error: result });
      return;
    } catch (err) {
      this.#emitWorkerError(`fail:${jobData.id}`, err);
      this.#safeEmit(this.#events.onJobAckError, { job: jobData, phase: "fail", error: err });
      return;
    }
  }

  /**
   * Translate sweep results into per-job events. These fire on the worker
   * that swept the queue, which is not necessarily the one that ran the job.
   */
  #handleRecovered(jobs: RecoveredJob[]): void {
    for (const { outcome, job } of jobs) {
      const error = new Error(job.failedReason ?? "lease expired");
      if (outcome === "waiting") {
        this.#safeEmit(this.#events.onJobRetry, {
          job,
          error,
          attempt: job.runs,
          retriesLeft: Math.max(0, job.maxStalls - job.stalls),
          cause: "stalled",
        });
      } else {
        this.#safeEmit(this.#events.onJobFailed, {
          job,
          error,
          attempts: job.runs,
          cause: "stalled",
        });
      }
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
    this.#safeEmit(this.#events.onStateChange, { from, to });
  }

  #emitWorkerError(scope: string, error: unknown): void {
    this.#safeEmit(this.#events.onWorkerError, { scope, error });
  }

  /** Invoke a user-provided handler; handler errors must never affect jobs. */
  #safeEmit<E>(handler: ((event: E) => void) | undefined, event: E): void {
    if (!handler) return;
    try {
      handler(event);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Post-acknowledgement view of a claim-time snapshot: the terminal scripts
 * release the lease, so handlers must not see a live lock on a settled job.
 */
function settledSnapshot(job: JobData, status: JobStatus): JobData {
  const { lockToken: _lockToken, leaseDeadline: _leaseDeadline, ...rest } = job;
  return { ...rest, status };
}
