import { createClient, type RedisClientOptions } from "redis";

import { type ConnectionOptions, PanqueueError, type QueueKeys } from "@panqueue/core";

import { ClientClosedError, ClientConnectionError } from "./errors.js";
import type { EnqueueArgs } from "./lua/enqueue.js";
import { CLIENT_SCRIPTS } from "./scripts.js";

/**
 * Producer-side command surface exposed to {@link QueueClient}. A narrow
 * interface over the underlying redis client so the public API does not leak
 * arbitrary node-redis methods.
 */
export interface PanqueueProducerClient {
  disconnect(): Promise<void>;
  enqueue(keys: QueueKeys, args: EnqueueArgs): Promise<unknown>;
}

/**
 * Connection lifecycle callbacks wired to the underlying socket. Callers must
 * pass handlers that never throw — they are invoked directly from node-redis
 * event listeners.
 */
export interface ConnectionLifecycleHooks {
  onError?(error: unknown): void;
  onReconnecting?(): void;
  onReady?(): void;
}

/** Reconnect attempts allowed before the *initial* connect gives up. */
const INITIAL_CONNECT_ATTEMPTS = 3;

/** Exponential backoff capped at 2s plus jitter (mirrors the node-redis default). */
function reconnectDelay(retries: number): number {
  return Math.min(retries * 50, 2000) + Math.floor(Math.random() * 200);
}

function buildClientOptions(options: ConnectionOptions): RedisClientOptions {
  if (typeof options === "string") {
    return { url: options };
  }

  if ("url" in options) {
    return { url: options.url };
  }

  return {
    password: options.password,
    database: options.db,
    socket: options.tls
      ? {
          host: options.host ?? "localhost",
          port: options.port ?? 6379,
          tls: true,
        }
      : {
          host: options.host ?? "localhost",
          port: options.port ?? 6379,
        },
  } satisfies RedisClientOptions;
}

/**
 * Thin wrapper around the `npm:redis` client for connection lifecycle
 * management, configured with producer-appropriate defaults:
 *
 * - The offline queue is disabled, so commands issued while the socket is
 *   down reject immediately instead of buffering — an enqueue never hangs
 *   waiting for Redis to come back.
 * - The initial connect fails fast after a few attempts; once a connection
 *   has been established, reconnection retries forever in the background so
 *   the client self-heals after an outage.
 * - Single-shot: after {@link disconnect} the connection is closed for good.
 */
export class RedisConnection {
  #options: ConnectionOptions;
  #hooks: ConnectionLifecycleHooks;
  #client: PanqueueProducerClient | null = null;
  #connectPromise: Promise<void> | null = null;
  #closed = false;

  constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks = {}) {
    this.#options = options;
    this.#hooks = hooks;
  }

  /**
   * Connect to Redis. Rejects with {@link ClientConnectionError} when Redis
   * is unreachable and {@link ClientClosedError} after {@link disconnect}.
   * A failed connect leaves the connection reusable: a later call retries.
   */
  async connect(): Promise<void> {
    if (this.#closed) throw new ClientClosedError();
    if (this.#client) return;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = this.#doConnect();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  async #doConnect(): Promise<void> {
    let everConnected = false;

    const base = buildClientOptions(this.#options);
    const client = createClient({
      ...base,
      // RESP2 is required: Lua scripts return HGETALL as flat arrays, and RESP3
      // would decode them as Maps (breaking Array.isArray checks in schedulers).
      RESP: 2,
      scripts: CLIENT_SCRIPTS,
      disableOfflineQueue: true,
      socket: {
        ...base.socket,
        reconnectStrategy: (retries: number, cause: Error) => {
          // Fail the initial connect fast; reconnect forever once established.
          if (!everConnected && retries >= INITIAL_CONNECT_ATTEMPTS) return cause;
          return reconnectDelay(retries);
        },
      },
    });

    client.on("error", (err: unknown) => this.#hooks.onError?.(err));
    client.on("reconnecting", () => this.#hooks.onReconnecting?.());
    client.on("ready", () => {
      everConnected = true;
      this.#hooks.onReady?.();
    });

    try {
      await client.connect();
    } catch (err) {
      throw new ClientConnectionError(err);
    }
    if (this.#closed) {
      // disconnect() raced the in-flight connect; don't leak the socket.
      await client.disconnect();
      throw new ClientClosedError();
    }
    this.#client = client;
  }

  /** Disconnect from Redis and close this connection permanently. */
  async disconnect(): Promise<void> {
    this.#closed = true;
    if (!this.#client) return;
    const client = this.#client;
    this.#client = null;
    await client.disconnect();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  /** The underlying Redis client. Throws if not connected. */
  get client(): PanqueueProducerClient {
    if (this.#closed) throw new ClientClosedError();
    if (!this.#client) {
      throw new PanqueueError("Redis client is not connected. Call connect() first.");
    }
    return this.#client;
  }
}
