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

/** Client-specific configuration (for codebases that don't share a PanqueueConfig). */
export interface QueueClientConfig {
  /** Redis connection configuration. */
  redis: ConnectionOptions;
}

/**
 * Type-safe client for enqueuing jobs into Panqueue.
 *
 * Pass a shared `PanqueueConfig` to infer queue names and payload types
 * automatically, or a client-specific config with the queue map as the type
 * argument.
 *
 * @example Shared config
 * ```ts
 * import { pq } from "./panqueue.config.js";
 *
 * const client = new QueueClient(pq);
 * await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * ```
 *
 * @example Client-specific config
 * ```ts
 * type MyQueues = {
 *   emails: { to: string; subject: string };
 *   thumbnails: { url: string; width: number };
 * };
 *
 * const client = new QueueClient<MyQueues>({
 *   redis: "redis://localhost:6379",
 * });
 *
 * await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * await client.disconnect();
 * ```
 */
export class QueueClient<TQueues extends QueueMap = QueueMap> {
  #redis: RedisConnection;

  constructor(config: PanqueueConfig<TQueues> | QueueClientConfig) {
    this.#redis = new RedisConnection(config.redis);
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
