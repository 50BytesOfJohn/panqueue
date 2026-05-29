import { createClient, type RedisClientOptions } from "redis";
import type { ConnectionOptions } from "@panqueue/core";
import { WORKER_SCRIPTS } from "./scripts.js";

/**
 * Subscriber surface exposed to the WorkerPool. A pub/sub connection cannot
 * run queue commands.
 */
export interface PanqueueSubscriber {
  disconnect(): Promise<void>;
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void>;
  unsubscribe(channel: string | string[]): Promise<void>;
}

/**
 * Command surface exposed to schedulers and runners. A command connection
 * cannot subscribe to pub/sub channels.
 */
export interface PanqueueWorkerClient {
  disconnect(): Promise<void>;
  claimGlobal(
    waitingKey: string,
    activeKey: string,
    jobsKey: string,
    corruptKey: string,
    corruptDataKey: string,
    leaseMs: string,
  ): Promise<unknown>;
  complete(
    activeKey: string,
    completedKey: string,
    jobsKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    lockToken: string,
  ): Promise<unknown>;
  fail(
    activeKey: string,
    failedKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    error: string,
    lockToken: string,
  ): Promise<unknown>;
  recover(
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    failedKey: string,
    corruptKey: string,
    corruptDataKey: string,
    batchSize: string,
    reason: string,
  ): Promise<unknown>;
  extendLock(
    activeKey: string,
    jobsKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    lockToken: string,
    leaseMs: string,
  ): Promise<unknown>;
  requeueActive(
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    lockToken: string,
    reason: string,
  ): Promise<unknown>;
}

/** @internal Exposed for test stubbing only. */
export const _internals: { createClient: typeof createClient } = {
  createClient,
};

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
  const client = _internals.createClient({
    ...buildClientOptions(options),
    scripts: WORKER_SCRIPTS,
  });
  client.on("error", (err: Error) => {
    console.error("[panqueue] Redis connection error:", err.message);
  });
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
      throw new Error(
        "[panqueue] Redis client is not connected. Call connect() first.",
      );
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
      throw new Error(
        "[panqueue] Redis subscriber is not connected. Call connect() first.",
      );
    }
    return this.#client;
  }
}
