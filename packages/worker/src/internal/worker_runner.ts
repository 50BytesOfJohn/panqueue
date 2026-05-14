import type { JobData } from "@panqueue/internal";
import type {
  Processor,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "../define_worker.ts";
import type { PanqueueWorkerClient } from "../redis_connection.ts";
import { GlobalJobScheduler } from "../scheduler/global.ts";
import type { BaseJobScheduler } from "../scheduler/base.ts";
import { Semaphore } from "../semaphore.ts";

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
  readonly #stopController = new AbortController();
  readonly #inFlight = new Set<InFlightEntry>();

  #state: WorkerState = "idle";
  #claimLoopPromise: Promise<void> | null = null;
  #wakeResolve: (() => void) | null = null;
  #recoverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    queueId: string,
    processor: Processor,
    options: WorkerDefinitionOptions,
    client: PanqueueWorkerClient,
  ) {
    this.queueId = queueId;
    this.#processor = processor;
    this.#concurrency = options.concurrency ?? 1;
    this.#pollInterval = options.pollInterval ?? 5000;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#lockRenewMs = options.lockRenewMs ??
      Math.max(1, Math.floor(this.#leaseMs / 3));
    this.#recoverIntervalMs = options.recoverIntervalMs ?? 30_000;
    this.#recoverBatchSize = options.recoverBatchSize ?? 100;
    this.#events = options.events ?? {};

    this.#scheduler = new GlobalJobScheduler(queueId, client);
    this.#semaphore = new Semaphore(this.#concurrency);
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
    this.#startRecoveryTimer();
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
    if (this.#recoverTimer) {
      clearInterval(this.#recoverTimer);
      this.#recoverTimer = null;
    }
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
      } catch { /* swallow */ }
    }

    let requeued = 0;
    const results = await Promise.allSettled(
      stillRunning.map((e) =>
        this.#scheduler.requeueActive(e.jobId, e.lockToken, reason)
      ),
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

    const drainPromise = Promise.allSettled(
      [...this.#inFlight].map((e) => e.promise),
    );

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
        const claimResult = await this.#scheduler.claim(this.#leaseMs);
        if (claimResult?.status === "corrupt") {
          this.#emitJobCorrupt(claimResult.jobId, claimResult.reason);
          this.#semaphore.release();
          continue;
        }
        jobData = claimResult;
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
      const renewer = this.#startLockRenewer(jobData.id, lockToken);
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
        if (result === "completed") {
          this.#emitJobComplete(jobData);
          return;
        }
        if (result === "stale") {
          try {
            this.#events.onJobStale?.(jobData, "complete");
          } catch { /* swallow */ }
          return;
        }
        if (result === "corrupt") {
          this.#emitJobCorrupt(jobData.id, "invalid-json");
          this.#emitJobAckError(jobData, "complete", result);
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

    const message = handlerError instanceof Error
      ? handlerError.message
      : String(handlerError);
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
        } catch { /* swallow */ }
        return;
      }
      if (result === "corrupt") {
        this.#emitJobCorrupt(jobData.id, "invalid-json");
        this.#emitJobAckError(jobData, "fail", result);
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

  #startLockRenewer(
    jobId: string,
    lockToken: string,
  ): { stop: () => void } {
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
        if (ok !== "extended") {
          if (ok === "corrupt") {
            this.#emitJobCorrupt(jobId, "invalid-json");
          }
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
        const recoveredJobIds = recovered.filter((id) =>
          !id.startsWith("corrupt:")
        );
        for (const id of recovered) {
          if (id.startsWith("corrupt:")) {
            this.#emitJobCorrupt(id.slice("corrupt:".length), "invalid-json");
          }
        }
        if (recoveredJobIds.length === 0) return;
        try {
          this.#events.onJobRecovered?.(recoveredJobIds);
        } catch { /* swallow */ }
      }
    } catch (err) {
      this.#emitError("recover", err);
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
    } catch { /* swallow */ }
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

  #emitJobRetry(job: JobData, error: string): void {
    try {
      this.#events.onJobRetry?.(job, error);
    } catch { /* swallow */ }
  }

  #emitJobCorrupt(jobId: string, reason: string): void {
    if (this.#events.onJobCorrupt) {
      try {
        this.#events.onJobCorrupt(jobId, reason);
      } catch { /* swallow */ }
      return;
    }
    this.#emitError(`corrupt:${jobId}`, new Error(reason));
  }

  #emitJobAckError(
    job: JobData,
    phase: "complete" | "fail",
    error: unknown,
  ): void {
    try {
      this.#events.onJobAckError?.(job, phase, error);
    } catch { /* swallow */ }
  }
}
