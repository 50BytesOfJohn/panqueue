import type { PanqueueConfig } from "@panqueue/config";
import type { JobData, JsonSerializable, QueueMap } from "@panqueue/internal";

/** Processor function invoked for each claimed job. */
export type Processor<T extends JsonSerializable = JsonSerializable> = (
  job: JobData<T>,
) => Promise<void>;

/** Lifecycle states reported by a runner via `onStateChange`. */
export type WorkerState = "idle" | "running" | "stopping" | "stopped";

/** Event handlers for observability and logging. */
export interface WorkerEventHandlers<
  T extends JsonSerializable = JsonSerializable,
> {
  /** Called when a job begins processing. */
  onJobStart?(job: JobData<T>): void;
  /** Called when a job completes successfully. */
  onJobComplete?(job: JobData<T>): void;
  /** Called when a job fails (handler threw). */
  onJobFail?(job: JobData<T>, error: string): void;
  /** Called when a handler failure is durably recorded and the job is retried. */
  onJobRetry?(job: JobData<T>, error: string): void;
  /** Called when a job's lease was lost (recovery requeued it under us). */
  onJobStale?(job: JobData<T>, phase: "complete" | "fail"): void;
  /** Called when Redis job data is unreadable and has been quarantined. */
  onJobCorrupt?(jobId: string, reason: string): void;
  /** Called when a complete/fail acknowledgement fails or returns unusable state. */
  onJobAckError?(
    job: JobData<T>,
    phase: "complete" | "fail",
    error: unknown,
  ): void;
  /** Called when stalled jobs are recovered by this runner's sweep. */
  onJobRecovered?(jobIds: string[]): void;
  /** Called on internal errors. Falls back to console.error when not provided. */
  onError?(context: string, error: unknown): void;
  /** Called on every lifecycle state transition for this runner. */
  onStateChange?(from: WorkerState, to: WorkerState): void;
}

/** Options accepted by a worker definition. Connection lives on the pool. */
export interface WorkerDefinitionOptions<
  T extends JsonSerializable = JsonSerializable,
> {
  /** Maximum number of concurrent jobs for this queue. Default: 1. */
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

/** Brand symbol identifying objects produced by `defineWorker`. */
export const WORKER_DEFINITION_BRAND: unique symbol = Symbol.for(
  "panqueue.workerDefinition",
);

/**
 * Pure data definition of a worker. Holds no connections and owns no
 * lifecycle — materialized by a `WorkerPool`.
 */
export interface WorkerDefinition<
  TQueues extends QueueMap = QueueMap,
  K extends keyof TQueues & string = keyof TQueues & string,
> {
  readonly [WORKER_DEFINITION_BRAND]: true;
  readonly queueId: K;
  processor(job: JobData): Promise<void>;
  readonly options: WorkerDefinitionOptions;
}

/**
 * Define a typed worker for a queue declared in a shared `PanqueueConfig`.
 *
 * The returned definition is a frozen, branded data object. It does not
 * open Redis connections or schedule work — pass it to a `WorkerPool` via
 * the `workers` option to materialize it.
 *
 * @example
 * ```ts
 * const emailWorker = defineWorker(pq, "email", async (job) => {
 *   await sendEmail(job.data);
 * }, { concurrency: 10 });
 * ```
 */
export function defineWorker<
  TQueues extends QueueMap,
  K extends keyof TQueues & string,
>(
  _config: PanqueueConfig<TQueues>,
  queueId: K,
  processor: Processor<TQueues[K]>,
  options: WorkerDefinitionOptions<TQueues[K]> = {},
): WorkerDefinition<TQueues, K> {
  const definition: WorkerDefinition<TQueues, K> = {
    [WORKER_DEFINITION_BRAND]: true,
    queueId,
    processor,
    options,
  };
  return Object.freeze(definition);
}

/** Type guard that narrows an unknown value to a `WorkerDefinition`. */
export function isWorkerDefinition(
  value: unknown,
): value is WorkerDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    WORKER_DEFINITION_BRAND in value &&
    value[WORKER_DEFINITION_BRAND] === true
  );
}
