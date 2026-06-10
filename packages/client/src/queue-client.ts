import type { PanqueueConfig } from "@panqueue/config";
import {
  assertJsonSerializable,
  type ConnectionOptions,
  generateJobId,
  type JobOptions,
  type QueueMap,
  queueHashTag,
  queueKeys,
} from "@panqueue/core";

import { RedisConnection } from "./redis-connection.js";

/** Options for enqueuing a job. */
export type EnqueueOptions = JobOptions;

/** Per-queue configuration for the client-only config. */
export interface ClientQueueConfig {
  /** Concurrency settings for this queue. Defaults to automatic scope detection. */
  concurrency?: {
    /** Queue concurrency scope. */
    scope?: "global" | "auto";
  };
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

    const jobId = generateJobId();

    await this.#redis.connect();

    await this.#redis.client.enqueue(queueKeys(queueId), {
      jobId,
      payload: JSON.stringify(data),
      queueId,
      maxRetries: options?.retries ?? 0,
      maxStalls: options?.maxStalls ?? 5,
      tag: queueHashTag(queueId),
    });

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
 * import { pq } from "./panqueue.config.js";
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
 * configuration separate from the worker. Scope defaults to `"auto"` per queue.
 *
 * @example
 * ```ts
 * const client = createQueueClient<MyQueues>({
 *   redis: "redis://localhost:6379",
 *   queues: { emails: {}, thumbnails: { concurrency: { scope: "global" } } },
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
