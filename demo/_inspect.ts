/**
 * Internal demo helper. Opens a raw `npm:redis` client for state inspection
 * in scripted tests and load runs. The public `QueueClient` deliberately
 * narrows away raw Redis access so it does not leak into the library surface.
 */

import { createClient } from "redis";
import type { ConnectionOptions } from "@panqueue/core";

export type RawRedis = ReturnType<typeof createClient>;

function asClientOptions(options: ConnectionOptions) {
  if (typeof options === "string") return { url: options };
  if ("url" in options) return { url: options.url };
  return {
    password: options.password,
    database: options.db,
    socket: {
      host: options.host ?? "localhost",
      port: options.port ?? 6379,
    },
  };
}

/** Open a connected raw Redis client. Caller is responsible for disconnect. */
export async function openInspector(
  options: ConnectionOptions,
): Promise<RawRedis> {
  const client = createClient(asClientOptions(options));
  await client.connect();
  return client;
}

/** Open a raw Redis client, run `fn` against it, then disconnect. */
export async function withInspector<T>(
  options: ConnectionOptions,
  fn: (redis: RawRedis) => Promise<T>,
): Promise<T> {
  const redis = await openInspector(options);
  try {
    return await fn(redis);
  } finally {
    await redis.disconnect();
  }
}
