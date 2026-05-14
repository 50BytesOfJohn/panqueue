import type { ConnectionOptions, QueueMap } from "@panqueue/internal";

/** Per-queue configuration within the shared config. */
export interface QueueConfig {
  /** Concurrency settings for this queue. Defaults to global scope. */
  concurrency?: {
    /** Queue-wide concurrency scope. */
    scope: "global";
  };
}

/** Configuration object returned by `definePanqueueConfig`. */
export interface PanqueueConfig<TQueues extends QueueMap> {
  /** Redis connection configuration shared by client and worker. */
  redis: ConnectionOptions;

  /** Per-queue settings. Keys must match `keyof TQueues`. */
  queues: { [K in keyof TQueues]: QueueConfig };
}
