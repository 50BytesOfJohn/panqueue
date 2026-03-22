import type { PanqueueConfig } from "@panqueue/config";
import type {
  ConnectionOptions,
  JobData,
  JobOptions,
  JsonSerializable,
  QueueMap,
} from "@panqueue/internal";
import {
  assertJsonSerializable,
  generateJobId,
  jobsKey,
  notifyKey,
  waitingKey,
} from "@panqueue/internal";
import { RedisConnection } from "./redis_connection.ts";

/** Options for enqueuing a job. */
export type EnqueueOptions = JobOptions;

/** Per-queue configuration for the client-only config. */
export interface ClientQueueConfig {
  /** Concurrency mode for this queue. Defaults to `"auto"`. */
  mode?: "global" | "auto";
}

/** Client-specific configuration (for codebases that don't share a PanqueueConfig). */
export interface QueueClientConfig<TQueues extends QueueMap> {
  /** Redis connection configuration. */
  redis: ConnectionOptions;

  /** Per-queue settings. Keys must match `keyof TQueues`. */
  queues: { [K in keyof TQueues]: ClientQueueConfig };
}

/** Options for constructing a QueueClient directly. */
export interface QueueClientOptions {
  /** Redis connection configuration. */
  connection: ConnectionOptions;
}

/**
 * Type-safe client for enqueuing jobs into Panqueue.
 *
 * @example
 * ```ts
 * type MyQueues = {
 *   emails: { to: string; subject: string };
 *   thumbnails: { url: string; width: number };
 * };
 *
 * const mq = new QueueClient<MyQueues>({
 *   connection: "redis://localhost:6379",
 * });
 *
 * await mq.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * await mq.disconnect();
 * ```
 */
export class QueueClient<TQueues extends QueueMap = QueueMap> {
  #redis: RedisConnection;

  constructor(options: QueueClientOptions) {
    this.#redis = new RedisConnection(options.connection);
  }

  /**
   * Explicitly connect to Redis.
   *
   * Not required — the client connects lazily on the first `enqueue` call.
   * Use this if you want to verify connectivity at startup.
   */
  async connect(): Promise<void> {
    await this.#redis.connect();
  }

  /** Gracefully disconnect from Redis. */
  async disconnect(): Promise<void> {
    await this.#redis.disconnect();
  }

  /**
   * Enqueue a job into the specified queue.
   *
   * The queue name is type-checked against the QueueMap generic, and the
   * payload must match the type declared for that queue.
   *
   * @returns The job ID.
   */
  async enqueue<K extends keyof TQueues & string>(
    queueId: K,
    data: TQueues[K],
    options?: EnqueueOptions,
  ): Promise<string> {
    assertJsonSerializable(data);

    if (options?.backoff) {
      throw new Error(
        "[panqueue] Backoff is not yet supported and will be available when delayed retry " +
        "scheduling is implemented. Remove the backoff option to enqueue.",
      );
    }

    const jobId = options?.jobId ?? generateJobId();

    const jobData: JobData<TQueues[K]> = {
      id: jobId,
      queueId,
      data,
      status: "waiting",
      attempts: 0,
      maxRetries: options?.retries ?? 0,
      createdAt: Date.now(),
    };

    const serialized = JSON.stringify(jobData);

    await this.#redis.connect();

    await this.#redis.client.enqueue(
      jobsKey(queueId),
      waitingKey(queueId),
      notifyKey(queueId),
      jobId,
      serialized,
    );

    return jobId;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  /** Access the underlying Redis connection (for internal/advanced use). */
  get redis(): RedisConnection {
    return this.#redis;
  }
}

/**
 * Create a type-safe QueueClient from a shared PanqueueConfig.
 *
 * The `TQueues` generic is inferred from the config, so queue names and
 * payload types are automatically available on the returned client.
 *
 * @example
 * ```ts
 * import { pq } from "./panqueue.config.ts";
 * const client = createQueueClient(pq);
 * await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });
 * ```
 */
export function createQueueClient<TQueues extends QueueMap>(
  config: PanqueueConfig<TQueues>,
): QueueClient<TQueues>;

/**
 * Create a type-safe QueueClient from a client-specific config.
 *
 * Use this overload in distributed systems where the client has its own
 * configuration separate from the worker. Mode defaults to `"auto"` per queue.
 *
 * @example
 * ```ts
 * const client = createQueueClient<MyQueues>({
 *   redis: "redis://localhost:6379",
 *   queues: { emails: {}, thumbnails: { mode: "global" } },
 * });
 * ```
 */
export function createQueueClient<TQueues extends QueueMap>(
  config: QueueClientConfig<TQueues>,
): QueueClient<TQueues>;

export function createQueueClient<TQueues extends QueueMap>(
  config: PanqueueConfig<TQueues> | QueueClientConfig<TQueues>,
): QueueClient<TQueues> {
  return new QueueClient<TQueues>({ connection: config.redis });
}
