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

/**
 * Handler-execution timing, measured by the worker that ran the handler.
 * Present only on events that mark the end of a handler run; durable
 * transitions observed by other workers (e.g. stall recoveries) carry no
 * timing because the sweeping worker never ran the handler.
 */
export interface JobTiming {
  /** Unix timestamp (ms) when the handler started. */
  startedAt: number;
  /** Handler execution time in ms, measured with a monotonic clock. */
  durationMs: number;
}

/** Payload for {@link WorkerEventHandlers.onJobStarted}. */
export interface JobStartedEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
}

/** Payload for {@link WorkerEventHandlers.onJobCompleted}. */
export interface JobCompletedEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /** Timing of the handler run that completed the job. */
  timing: JobTiming;
}

/** Payload for {@link WorkerEventHandlers.onJobError}. */
export interface JobErrorEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /** The value thrown by the handler, with its stack intact. */
  error: unknown;
  /** True when the job is requeued for retry; false when this failure is terminal. */
  willRetry: boolean;
  /** Timing of the handler run that threw. */
  timing: JobTiming;
}

/** Payload for {@link WorkerEventHandlers.onJobRetry}. */
export interface JobRetryEvent<T extends JsonSerializable = JsonSerializable> {
  job: JobData<T>;
  /**
   * The value thrown by the handler for cause `"handler"`; an `Error`
   * carrying the recovery reason for cause `"stalled"`.
   */
  error: unknown;
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

/**
 * Operation during which an internal worker error occurred.
 *
 * - `"claim"` — claiming the next job from the queue failed.
 * - `"lease-renew"` — extending an in-flight job's lock failed.
 * - `"lease-lost"` — an in-flight job's lease could not be renewed because
 *   another worker (or recovery) took it over; complete/fail will no-op.
 * - `"recovery-sweep"` — a stalled-job recovery pass failed.
 * - `"ack"` — sending a job's terminal complete/fail acknowledgement failed.
 * - `"requeue"` — handing an in-flight job back during shutdown failed.
 * - `"event-handler"` — a user-provided event handler threw or rejected.
 */
export type WorkerErrorKind =
  | "claim"
  | "lease-renew"
  | "lease-lost"
  | "recovery-sweep"
  | "ack"
  | "requeue"
  | "event-handler";

/** Payload for {@link WorkerEventHandlers.onWorkerError}. */
export interface WorkerErrorEvent {
  /** The operation that failed. */
  kind: WorkerErrorKind;
  /** The affected job, when the failure is job-scoped. */
  jobId?: string;
  /** The throwing handler's name, for kind `"event-handler"`. */
  handlerName?: string;
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
 * that observed the transition, not globally across the queue. A throwing
 * or rejecting handler never affects job processing: the failure is caught
 * and reported to `onWorkerError` with kind `"event-handler"`.
 * Failures thrown by `onWorkerError` itself are dropped.
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
  /**
   * Called on internal worker errors (claiming, lease renewal, recovery
   * sweeps) and on failures thrown by other event handlers
   * (kind `"event-handler"`).
   */
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
