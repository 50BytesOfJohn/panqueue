import type { PanqueueConfig } from "@panqueue/config";
import type { JobData, JsonSerializable, QueueMap } from "@panqueue/core";

/** Processor function invoked for each claimed job. */
export type Processor<T extends JsonSerializable = JsonSerializable> = (
  job: JobData<T>,
) => Promise<void>;

/** Lifecycle states reported by a runner via `onStateChange`. */
export type WorkerState = "idle" | "running" | "stopping" | "stopped";

/** Why a failure was recorded: the handler threw, or the lease expired. */
export type JobFailureCause = "handler" | "stalled";

/** Phase during which a terminal acknowledgement was attempted. */
export type JobAckPhase = "complete" | "fail";

/** Payload for {@link WorkerEventHandlers.onJobStarted}. */
export interface JobStartedEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
}

/** Payload for {@link WorkerEventHandlers.onJobCompleted}. */
export interface JobCompletedEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
}

/** Payload for {@link WorkerEventHandlers.onJobError}. */
export interface JobErrorEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /** The value thrown by the handler, with its stack intact. */
  error: unknown;
  /** 1-based number of the attempt that just threw. */
  attempt: number;
  /** True when the job is requeued for retry; false when this failure is terminal. */
  willRetry: boolean;
}

/** Payload for {@link WorkerEventHandlers.onJobRetry}. */
export interface JobRetryEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /**
   * The value thrown by the handler for cause `"handler"`; an `Error`
   * carrying the recovery reason for cause `"stalled"`.
   */
  error: unknown;
  /** 1-based number of the attempt that just failed or stalled. */
  attempt: number;
  /**
   * Remaining attempts of the same cause before the job fails terminally:
   * handler retries for `"handler"`, stall recoveries for `"stalled"`.
   */
  retriesLeft: number;
  cause: JobFailureCause;
}

/** Payload for {@link WorkerEventHandlers.onJobFailed}. */
export interface JobFailedEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /**
   * The value thrown by the handler for cause `"handler"`; an `Error`
   * carrying the recovery reason for cause `"stalled"`.
   */
  error: unknown;
  /** Total claims the job consumed before failing terminally. */
  attempts: number;
  cause: JobFailureCause;
}

/** Payload for {@link WorkerEventHandlers.onJobStale}. */
export interface JobStaleEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  phase: JobAckPhase;
}

/** Payload for {@link WorkerEventHandlers.onJobAckError}. */
export interface JobAckErrorEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  phase: JobAckPhase;
  error: unknown;
}

/** Payload for {@link WorkerEventHandlers.onWorkerError}. */
export interface WorkerErrorEvent {
  /** Where the error occurred, e.g. `"claim"` or `"extend:<jobId>"`. */
  scope: string;
  error: unknown;
}

/** Payload for {@link WorkerEventHandlers.onStateChange}. */
export interface StateChangeEvent {
  from: WorkerState;
  to: WorkerState;
}

/**
 * Event handlers for observability and logging.
 *
 * All handlers are local to the worker process: they fire on the worker
 * that observed the transition, not globally across the queue. Thrown
 * errors inside handlers are swallowed and never affect job processing.
 */
export interface WorkerEventHandlers<T extends JsonSerializable = JsonSerializable> {
  /** Called when a claimed job begins processing. */
  onJobStarted?(event: JobStartedEvent<T>): void;
  /** Called when a job completes successfully. */
  onJobCompleted?(event: JobCompletedEvent<T>): void;
  /**
   * Called on every handler throw, whether or not the job will be retried —
   * the single place to report all job errors (e.g. to Sentry). Fires before
   * the matching `onJobRetry`/`onJobFailed`. Does not fire for stalls.
   */
  onJobError?(event: JobErrorEvent<T>): void;
  /**
   * Called when a failure is durably recorded and the job is requeued for
   * another attempt — after the failed attempt, before the retry runs.
   * Covers handler failures and stall recoveries (see `cause`); stall
   * recoveries fire on the worker whose sweep requeued the job.
   */
  onJobRetry?(event: JobRetryEvent<T>): void;
  /**
   * Called when a job fails terminally: no retries remain and it has been
   * moved to the failed set (or deleted, per the queue's retention policy).
   * This is the last chance to observe the job. For cause `"stalled"` it
   * fires on the worker whose sweep detected the expired lease, which may
   * not be the worker that ran the job.
   */
  onJobFailed?(event: JobFailedEvent<T>): void;
  /** Called when a job's lease was lost (recovery requeued it under us). */
  onJobStale?(event: JobStaleEvent<T>): void;
  /** Called when a complete/fail acknowledgement fails or returns unusable state. */
  onJobAckError?(event: JobAckErrorEvent<T>): void;
  /** Called on internal worker errors (claiming, lease renewal, recovery sweeps). */
  onWorkerError?(event: WorkerErrorEvent): void;
  /** Called on every lifecycle state transition for this runner. */
  onStateChange?(event: StateChangeEvent): void;
}

/** Options accepted by a worker definition. Connection lives on the pool. */
export interface WorkerDefinitionOptions<T extends JsonSerializable = JsonSerializable> {
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
export const WORKER_DEFINITION_BRAND: unique symbol = Symbol.for("panqueue.workerDefinition");

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
export function defineWorker<TQueues extends QueueMap, K extends keyof TQueues & string>(
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
export function isWorkerDefinition(value: unknown): value is WorkerDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    WORKER_DEFINITION_BRAND in value &&
    value[WORKER_DEFINITION_BRAND] === true
  );
}
