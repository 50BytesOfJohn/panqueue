import { createClient, type RedisClientOptions } from "redis";

import { type ConnectionOptions, PanqueueError, type QueueKeys } from "@panqueue/core";

import type { ClaimGlobalBatchArgs } from "./lua/claim-global-batch.js";
import type { CompleteArgs } from "./lua/complete.js";
import type { DeclareConcurrencyLimitArgs } from "./lua/declare-concurrency-limit.js";
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
  claimGlobalBatch(keys: QueueKeys, args: ClaimGlobalBatchArgs): Promise<unknown>;
  complete(keys: QueueKeys, args: CompleteArgs): Promise<unknown>;
  declareConcurrencyLimit(keys: QueueKeys, args: DeclareConcurrencyLimitArgs): Promise<unknown>;
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

/** The single client both roles open; each class exposes only its own half. */
type RawClient = PanqueueWorkerClient & PanqueueSubscriber;

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
async function openRawClient(
  options: ConnectionOptions,
  hooks: ConnectionLifecycleHooks,
): Promise<RawClient> {
  let everConnected = false;

  const base = buildClientOptions(options);
  const client = createClient({
    ...base,
    // RESP3 (redis v6 default). Safe for our schedulers: HGETALL is only ever
    // called inside Lua, and the Lua→reply conversion yields a flat array under
    // both protocols (no `redis.setresp(3)`), so deserializeJobHash is unaffected.
    RESP: 3,
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

/**
 * Lifecycle for one socket. Command and subscriber roles open the identical
 * raw client and differ only in the surface they expose, so the narrowing
 * lives in the subclass `client` getter.
 */
abstract class Connection {
  protected readonly options: ConnectionOptions;
  readonly #hooks: ConnectionLifecycleHooks;
  readonly #role: string;
  #client: RawClient | null = null;
  #connectPromise: Promise<void> | null = null;

  protected constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks, role: string) {
    this.options = options;
    this.#hooks = hooks;
    this.#role = role;
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
    this.#client = await openRawClient(this.options, this.#hooks);
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

  /** The connected client. Throws if not connected. */
  protected get raw(): RawClient {
    if (!this.#client) {
      throw new PanqueueError(`Redis ${this.#role} is not connected. Call connect() first.`);
    }
    return this.#client;
  }
}

/** Command-mode connection. Exposes the queue scripts, never pub/sub. */
export class RedisConnection extends Connection {
  constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks = {}) {
    super(options, hooks, "client");
  }

  get client(): PanqueueWorkerClient {
    return this.raw;
  }

  /** Open a separate subscriber connection sharing this connection's config. */
  async duplicate(hooks: ConnectionLifecycleHooks = {}): Promise<RedisSubscriberConnection> {
    const dup = new RedisSubscriberConnection(this.options, hooks);
    await dup.connect();
    return dup;
  }
}

/** Subscriber-mode connection. Exposes only pub/sub operations. */
export class RedisSubscriberConnection extends Connection {
  constructor(options: ConnectionOptions, hooks: ConnectionLifecycleHooks = {}) {
    super(options, hooks, "subscriber");
  }

  get client(): PanqueueSubscriber {
    return this.raw;
  }
}
