import { createClient } from "redis";
import type { ConnectionOptions } from "@panqueue/internal";

/** The return type of `createClient()`. */
export type RedisClient = ReturnType<typeof createClient>;

/** Thin wrapper around the `npm:redis` client for connection lifecycle management. */
export class RedisConnection {
  #options: ConnectionOptions;
  #client: RedisClient | null = null;
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
    const client = createClient(this.#buildClientOptions());

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

  /** The underlying redis client. Throws if not connected. */
  get client(): RedisClient {
    if (!this.#client) {
      throw new Error(
        "[panqueue] Redis client is not connected. Call connect() first.",
      );
    }
    return this.#client;
  }

  /** Create a duplicate connection (e.g. for pub/sub). */
  async duplicate(): Promise<RedisConnection> {
    const dup = new RedisConnection(this.#options);
    await dup.connect();
    return dup;
  }

  #buildClientOptions(): Parameters<typeof createClient>[0] {
    if (typeof this.#options === "string") {
      return { url: this.#options };
    }

    const { host, port, password, db, tls } = this.#options;
    return {
      socket: {
        host: host ?? "localhost",
        port: port ?? 6379,
        tls: tls ?? false,
      },
      password,
      database: db,
    };
  }
}
