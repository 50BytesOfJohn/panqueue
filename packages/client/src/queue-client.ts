import { ErrorReply } from "redis";

import type { PanqueueConfig } from "@panqueue/config";
import {
  assertJsonSerializable,
  type ConnectionOptions,
  generateJobId,
  type JobOptions,
  PanqueueError,
  type QueueMap,
  queueHashTag,
  queueKeys,
} from "@panqueue/core";

import { ClientConnectionError, EnqueueError } from "./errors.js";
import { RedisConnection } from "./redis-connection.js";

/** Options for enqueuing a job. */
export type EnqueueOptions = JobOptions;

/** Client-specific configuration (for codebases that don't share a PanqueueConfig). */
export interface QueueClientConfig {
  /** Redis connection configuration. */
  redis: ConnectionOptions;
}

/** Payload for {@link ClientEventHandlers.onConnectionError}. */
export interface ConnectionErrorEvent {
  error: unknown;
}

/**
 * Connection observability handlers. All handlers are fire-and-forget: a
 * throwing handler is swallowed and never affects enqueueing.
 */
export interface ClientEventHandlers {
  /** Called on every socket-level error, including during reconnection. */
  onConnectionError?(event: ConnectionErrorEvent): void;
  /** Called when the connection is lost and a reconnect attempt is scheduled. */
  onConnectionReconnecting?(): void;
  /** Called when the connection is established or re-established. */
  onConnectionReady?(): void;
}

/** Options accepted by the {@link QueueClient} constructor. */
export interface QueueClientOptions {
  /** Connection event handlers for observability. */
  events?: ClientEventHandlers;
}

/** Invoke an observability handler; handler failures never affect callers. */
function safeEmit(emit: () => void): void {
  try {
    emit();
  } catch {
    /* observability handlers must not break enqueueing */
  }
}

/**
 * Type-safe client for enqueuing jobs into Panqueue.
 *
 * Pass a shared `PanqueueConfig` to infer queue names and payload types
 * automatically, or a client-specific config with the queue map as the type
 * argument.
 *
 * Connection behavior is managed by Panqueue with producer-appropriate
 * defaults: `enqueue` fails fast with a {@link ClientConnectionError} while
 * Redis is unreachable (instead of hanging), and the connection self-heals
 * in the background once established. Clients are single-shot — after
 * `disconnect()`, construct a fresh client.
 *
 * @example Shared config
 * ```ts
 * import { pq } from "./panqueue.config.js";
 *
 * const client = new QueueClient(pq);
 * await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * ```
 *
 * @example Client-specific config with connection events
 * ```ts
 * type MyQueues = {
 *   emails: { to: string; subject: string };
 *   thumbnails: { url: string; width: number };
 * };
 *
 * const client = new QueueClient<MyQueues>(
 *   { redis: "redis://localhost:6379" },
 *   {
 *     events: {
 *       onConnectionError: ({ error }) => log.warn({ error }, "redis error"),
 *     },
 *   },
 * );
 *
 * await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });
 * await client.disconnect();
 * ```
 */
export class QueueClient<TQueues extends QueueMap = QueueMap> {
  #redis: RedisConnection;

  constructor(config: PanqueueConfig<TQueues> | QueueClientConfig, options?: QueueClientOptions) {
    const events = options?.events ?? {};
    this.#redis = new RedisConnection(config.redis, {
      onError: (error) => safeEmit(() => events.onConnectionError?.({ error })),
      onReconnecting: () => safeEmit(() => events.onConnectionReconnecting?.()),
      onReady: () => safeEmit(() => events.onConnectionReady?.()),
    });
  }

  /**
   * Explicitly connect to Redis.
   *
   * Not required — the client connects lazily on the first `enqueue` call.
   * Use this to verify connectivity at startup: it rejects with a
   * {@link ClientConnectionError} when Redis is unreachable.
   */
  async connect(): Promise<void> {
    await this.#redis.connect();
  }

  /**
   * Gracefully disconnect from Redis and close this client permanently.
   * Clients are single-shot: subsequent `enqueue`/`connect` calls reject
   * with a `ClientClosedError`.
   */
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
   * @throws {SerializationError} when the payload is not JSON-serializable.
   * @throws {ClientConnectionError} when Redis is unreachable.
   * @throws {ClientClosedError} when the client has been disconnected.
   * @throws {EnqueueError} when Redis rejects the enqueue command itself.
   */
  async enqueue<K extends keyof TQueues & string>(
    queueId: K,
    data: TQueues[K],
    options?: EnqueueOptions,
  ): Promise<string> {
    assertJsonSerializable(data);

    const jobId = generateJobId();

    await this.#redis.connect();

    try {
      await this.#redis.client.enqueue(queueKeys(queueId), {
        jobId,
        payload: JSON.stringify(data),
        queueId,
        maxRetries: options?.retries ?? 0,
        maxStalls: options?.maxStalls ?? 5,
        tag: queueHashTag(queueId),
      });
    } catch (err) {
      if (err instanceof PanqueueError) throw err;
      // An error *reply* means Redis received and rejected the command;
      // anything else is a transport-level failure.
      if (err instanceof ErrorReply) throw new EnqueueError(queueId, err);
      throw new ClientConnectionError(err);
    }

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
