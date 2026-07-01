import { createClient, type RedisClientOptions } from "redis";

import { type ConnectionOptions, PanqueueError, type QueueKeys } from "@panqueue/core";

import type { ClaimGlobalArgs } from "./lua/claim-global.js";
import type { CompleteArgs } from "./lua/complete.js";
import type { ExtendLockArgs } from "./lua/extend-lock.js";
import type { FailArgs } from "./lua/fail.js";
import type { RecoverArgs } from "./lua/recover.js";
import type { RequeueActiveArgs } from "./lua/requeue-active.js";
import { WORKER_SCRIPTS } from "./scripts.js";

/**
 * Subscriber surface exposed to the WorkerPool. A pub/sub connection cannot
 * run queue commands.
 */
export interface PanqueueSubscriber {
  disconnect(): Promise<void>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string | string[]): Promise<void>;
}

/**
 * Command surface exposed to schedulers and runners. A command connection
 * cannot subscribe to pub/sub channels.
 */
export interface PanqueueWorkerClient {
  disconnect(): Promise<void>;
  claimGlobal(keys: QueueKeys, args: ClaimGlobalArgs): Promise<unknown>;
  complete(keys: QueueKeys, args: CompleteArgs): Promise<unknown>;
  fail(keys: QueueKeys, args: FailArgs): Promise<unknown>;
  recover(keys: QueueKeys, args: RecoverArgs): Promise<unknown>;
  extendLock(keys: QueueKeys, args: ExtendLockArgs): Promise<unknown>;
  requeueActive(keys: QueueKeys, args: RequeueActiveArgs): Promise<unknown>;
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
 * Open a raw node-redis client with worker-appropriate defaults: the initial
 * connect fails fast after a few attempts (so `WorkerPool.start()` reports
 * an unreachable Redis instead of hanging), while an established connection
 * reconnects indefinitely. The offline queue stays enabled — a worker is a
 * daemon, so commands issued during an outage wait for the reconnect rather
 * than failing.
 */
async function openRawClient(options: ConnectionOptions, hooks: ConnectionLifecycleHooks) {
  let everConnected = false;

  const base = buildClientOptions(options);
  const client = createClient({
    ...base,
    // RESP2 is required: Lua scripts return HGETALL as flat arrays, and RESP3
    // would decode them as Maps (breaking Array.isArray checks in schedulers).
    RESP: 2,
    scripts: WORKER_SCRIPTS,
    socket: {
      ...base.socket,
      reconnectStrategy: (retries: number, cause: Error) => {
        // Fail the initial connect fast; reconnect forever once established.
        if (!everConnected && retries >= INITIAL_CONNECT_ATTEMPTS) return cause;
        return reconnectDelay(retries);
      },
    },
  });

  client.on("error", (err: unknown) => hooks.onError?.(err));
  client.on("reconnecting", () => hooks.onReconnecting?.());
  client.on("ready", () => {
    everConnected = true;
    hooks.onReady?.();
  });

  await client.connect();
  return client;
}

/** Thin wrapper around the command-mode redis client for lifecycle management. */
export class RedisConnection {
  #options: ConnectionOptions;
  #hooks: ConnectionLifecycleHooks;
  #client: PanqueueWorkerClient | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks = {}) {
    this.#options = options;
    this.#hooks = hooks;
  }

  /** Connect to Redis. Must be called before using the client. */
  async connect(): Promise<void> {
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
    this.#client = await openRawClient(this.#options, this.#hooks);
  }

  /** Gracefully disconnect from Redis. */
  async disconnect(): Promise<void> {
    if (!this.#client) return;
    await this.#client.disconnect();
    this.#client = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  /** The command-mode client. Throws if not connected. */
  get client(): PanqueueWorkerClient {
    if (!this.#client) {
      throw new PanqueueError("Redis client is not connected. Call connect() first.");
    }
    return this.#client;
  }

  /** Open a separate subscriber connection sharing this connection's config. */
  async duplicate(hooks: ConnectionLifecycleHooks = {}): Promise<RedisSubscriberConnection> {
    const dup = new RedisSubscriberConnection(this.#options, hooks);
    await dup.connect();
    return dup;
  }
}

/** Subscriber-mode connection. Exposes only pub/sub operations. */
export class RedisSubscriberConnection {
  #options: ConnectionOptions;
  #hooks: ConnectionLifecycleHooks;
  #client: PanqueueSubscriber | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks = {}) {
    this.#options = options;
    this.#hooks = hooks;
  }

  /** Connect to Redis. Must be called before using the client. */
  async connect(): Promise<void> {
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
    this.#client = await openRawClient(this.#options, this.#hooks);
  }

  /** Gracefully disconnect from Redis. */
  async disconnect(): Promise<void> {
    if (!this.#client) return;
    await this.#client.disconnect();
    this.#client = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  /** The subscriber-mode client. Throws if not connected. */
  get client(): PanqueueSubscriber {
    if (!this.#client) {
      throw new PanqueueError("Redis subscriber is not connected. Call connect() first.");
    }
    return this.#client;
  }
}
