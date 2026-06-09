import { createClient, type RedisClientOptions } from "redis";

import type { ConnectionOptions, QueueKeys } from "@panqueue/core";

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

async function openRawClient(options: ConnectionOptions) {
  const client = createClient({
    ...buildClientOptions(options),
    scripts: WORKER_SCRIPTS,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}

/** Thin wrapper around the command-mode redis client for lifecycle management. */
export class RedisConnection {
  #options: ConnectionOptions;
  #client: PanqueueWorkerClient | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
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
    this.#client = await openRawClient(this.#options);
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
      throw new Error("[panqueue] Redis client is not connected. Call connect() first.");
    }
    return this.#client;
  }

  /** Open a separate subscriber connection sharing this connection's config. */
  async duplicate(): Promise<RedisSubscriberConnection> {
    const dup = new RedisSubscriberConnection(this.#options);
    await dup.connect();
    return dup;
  }
}

/** Subscriber-mode connection. Exposes only pub/sub operations. */
export class RedisSubscriberConnection {
  #options: ConnectionOptions;
  #client: PanqueueSubscriber | null = null;
  #connectPromise: Promise<void> | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
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
    this.#client = await openRawClient(this.#options);
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
      throw new Error("[panqueue] Redis subscriber is not connected. Call connect() first.");
    }
    return this.#client;
  }
}
