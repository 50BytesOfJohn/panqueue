import { createClient, type RedisClientOptions } from "redis";
import type { ConnectionOptions } from "@panqueue/internal";
import { CLIENT_SCRIPTS } from "./scripts.ts";

/**
 * Producer-side command surface exposed to {@link QueueClient}. A narrow
 * interface over the underlying redis client so the public API does not leak
 * arbitrary node-redis methods.
 */
export interface PanqueueProducerClient {
  disconnect(): Promise<void>;
  enqueue(
    jobsKey: string,
    waitingKey: string,
    notifyKey: string,
    jobId: string,
    serialized: string,
  ): Promise<unknown>;
}

/** @internal Exposed for test stubbing only. */
export const _internals = { createClient };

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

/** Thin wrapper around the `npm:redis` client for connection lifecycle management. */
export class RedisConnection {
  #options: ConnectionOptions;
  #client: PanqueueProducerClient | null = null;
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
    const client = _internals.createClient({
      ...buildClientOptions(this.#options),
      scripts: CLIENT_SCRIPTS,
    });

    client.on("error", (err: Error) => {
      console.error("[panqueue] Redis connection error:", err.message);
    });

    await client.connect();
    this.#client = client;
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

  /** The underlying Redis client. Throws if not connected. */
  get client(): PanqueueProducerClient {
    if (!this.#client) {
      throw new Error(
        "[panqueue] Redis client is not connected. Call connect() first.",
      );
    }
    return this.#client;
  }
}
