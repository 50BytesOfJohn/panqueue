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

  /** Backoff strategy for retries. */
  backoff?: {
    type: "fixed" | "exponential";
    /** Base delay in milliseconds. */
    delay: number;
  };

  /** Delay in milliseconds before the job becomes available for processing. */
  delay?: number;

  /** Optional idempotency/deduplication key. */
  jobId?: string;
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

  /** Number of processing attempts so far. */
  attempts: number;

  /** Maximum number of retries allowed. */
  maxRetries: number;

  /** Backoff configuration, if any. */
  backoff?: {
    type: "fixed" | "exponential";
    delay: number;
  };

  /** Unix timestamp (ms) when the job was created. */
  createdAt: number;

  /** Unix timestamp (ms) when the job was last processed (claimed). */
  processedAt?: number;

  /** Unix timestamp (ms) when the job completed or permanently failed. */
  finishedAt?: number;

  /** Error message from the most recent failure, if any. */
  failedReason?: string;
}

/**
 * Redis connection configuration.
 *
 * Either a URL string (e.g. `"redis://localhost:6379"`) or an object
 * with individual connection parameters.
 */
export type ConnectionOptions =
  | string
  | {
      host?: string;
      port?: number;
      password?: string;
      db?: number;
      tls?: boolean;
    };
