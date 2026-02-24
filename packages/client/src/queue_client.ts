import type {
  ConnectionOptions,
  JobOptions,
  QueueMap,
} from "@panqueue/internal";
import { RedisConnection } from "./redis_connection.ts";

/** Options for constructing a QueueClient. */
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
 * await mq.connect();
 * await mq.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * await mq.disconnect();
 * ```
 */
export class QueueClient<TQueues extends QueueMap = QueueMap> {
  #redis: RedisConnection;

  constructor(options: QueueClientOptions) {
    this.#redis = new RedisConnection(options.connection);
  }

  /** Connect to Redis. Must be called before enqueuing jobs. */
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
   * Implementation will be completed with Lua scripts in a subsequent PR.
   */
  async enqueue<K extends keyof TQueues & string>(
    _queueId: K,
    _data: TQueues[K],
    _options?: JobOptions,
  ): Promise<void> {
    // TODO: Implement via Lua script (addJob)
    // This will atomically:
    // 1. Generate a job ID
    // 2. Store the job data in the jobs hash
    // 3. Push the job ID to the waiting list (or delayed sorted set)
    // 4. Publish a notification on the notify channel
    throw new Error("Not implemented — Lua scripts required");
  }

  /** Access the underlying Redis connection (for internal/advanced use). */
  get redis(): RedisConnection {
    return this.#redis;
  }
}
