/**
 * Recursive type constraining values to JSON-safe primitives, arrays, and plain objects.
 */
export type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

/**
 * Maps queue IDs to their payload types. Used as the generic parameter for
 * QueueClient to get type-safe enqueue/dequeue operations.
 *
 * @example
 * ```ts
 * type MyQueues = {
 *   emails: { to: string; subject: string; body: string };
 *   thumbnails: { imageUrl: string; width: number };
 * };
 * const mq = new QueueClient<MyQueues>({ connection: { url: "..." } });
 * ```
 */
export type QueueMap = Record<string, JsonSerializable>;

/** Status of a job in the queue lifecycle. */
export type JobStatus =
  | "waiting"
  | "delayed"
  | "active"
  | "completed"
  | "failed";

/** Per-job options provided at enqueue time. */
export interface JobOptions {
  /** Number of retry attempts before moving to failed. Defaults to 0 (no retries). */
  retries?: number;

  /** Number of stalled lease recoveries allowed before moving to failed. Defaults to 5. */
  maxStalls?: number;
}

/** The full job record as stored in Redis. */
export interface JobData<T extends JsonSerializable = JsonSerializable> {
  /** Unique job identifier. */
  id: string;

  /** The queue this job belongs to. */
  queueId: string;

  /** Job payload. */
  data: T;

  /** Current status in the job lifecycle. */
  status: JobStatus;

  /** Number of successful durable claims. Incremented only by claim scripts. */
  runs: number;

  /** Number of handler failures durably recorded for this job. */
  failures: number;

  /** Number of lease-expiry recoveries durably recorded for this job. */
  stalls: number;

  /** Maximum number of handler retries after the first failure. */
  maxRetries: number;

  /** Maximum number of stalled lease recoveries before terminal failure. */
  maxStalls: number;

  /** Unix timestamp (ms) when the job was created. */
  createdAt: number;

  /** Unix timestamp (ms) when the job was last claimed. */
  lastStartedAt?: number;

  /** Unix timestamp (ms) when the last handler failure was recorded. */
  lastFailedAt?: number;

  /** Unix timestamp (ms) when the last lease-expiry recovery was recorded. */
  lastStalledAt?: number;

  /** Unix timestamp (ms) when active work was explicitly requeued. */
  lastRequeuedAt?: number;

  /** Reason for the last explicit active requeue. */
  lastRequeueReason?: string;

  /** Unix timestamp (ms) when the job completed or permanently failed. */
  finishedAt?: number;

  /** Kind of the most recent durable failure signal. */
  failureKind?: "handler" | "stalled";

  /** Error message from the most recent failure, if any. */
  failedReason?: string;

  /** Raw error message from the most recent handler failure, if any. */
  lastError?: string;

  /**
   * Server-generated lease token written on every claim. Used to fence
   * complete/fail/extend operations against stalled-job recovery: a worker
   * must present a matching token to mutate the job's terminal state.
   */
  lockToken?: string;

  /** Unix timestamp (ms) at which the current lease expires. */
  leaseDeadline?: number;
}

/**
 * Redis connection configuration.
 *
 * Either a URL string (e.g. `"redis://localhost:6379"`), a `{ url }` object,
 * or an object with individual connection parameters.
 */
export type ConnectionOptions =
  | string
  | { url: string }
  | {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    tls?: boolean;
  };
