import type { ConnectionOptions, QueueMap } from "@panqueue/internal";

/** Per-queue configuration within the shared config. */
export interface QueueConfig {
  /** Concurrency mode for this queue. */
  mode: "global";
}

/** Configuration object returned by `definePanqueueConfig`. */
export interface PanqueueConfig<TQueues extends QueueMap> {
  /** Redis connection configuration shared by client and worker. */
  redis: ConnectionOptions;

  /** Per-queue settings. Keys must match `keyof TQueues`. */
  queues: { [K in keyof TQueues]: QueueConfig };
}
