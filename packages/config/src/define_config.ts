import type { QueueMap } from "@panqueue/internal";
import type { PanqueueConfig } from "./types.ts";

/**
 * Identity function for defining a type-safe panqueue configuration.
 *
 * Returns the config object unchanged. Exists purely for type inference so
 * that `createQueueClient` and `createWorkerPool` can derive queue IDs and
 * payload types from the shared config.
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
 *   redis: { url: Deno.env.get("REDIS_URL")! },
 *   queues: {
 *     email: { mode: "simple" },
 *     image: { mode: "simple" },
 *   },
 * });
 * ```
 */
export function definePanqueueConfig<TQueues extends QueueMap>(
  config: PanqueueConfig<TQueues>,
): PanqueueConfig<TQueues> {
  return config;
}
