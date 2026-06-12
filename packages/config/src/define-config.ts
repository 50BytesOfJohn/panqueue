import type { QueueMap } from "@panqueue/core";

import type { PanqueueConfig } from "./types.js";

/**
 * Identity function for defining a type-safe panqueue configuration.
 *
 * Returns the config object unchanged. Exists purely for type inference so
 * that `QueueClient`, `defineWorker`, and `WorkerPool` can derive queue
 * IDs and payload types from the shared config.
 *
 * No connections are opened and no side effects occur.
 *
 * @example
 * ```ts
 * type MyQueues = {
 *   email: { to: string; subject: string; body: string };
 *   image: { url: string; width: number };
 * };
 *
 * export const pq = definePanqueueConfig<MyQueues>({
 *   redis: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
 *   queues: {
 *     email: {},
 *     image: {},
 *   },
 * });
 * ```
 */
export function definePanqueueConfig<TQueues extends QueueMap>(
  config: PanqueueConfig<TQueues>,
): PanqueueConfig<TQueues> {
  return config;
}
