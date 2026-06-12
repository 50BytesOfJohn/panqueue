export { defineWorker, isWorkerDefinition, WORKER_DEFINITION_BRAND } from "./src/define-worker.js";
export type {
  JobAckErrorEvent,
  JobAckPhase,
  JobCompletedEvent,
  JobErrorEvent,
  JobFailedEvent,
  JobFailureCause,
  JobRetryEvent,
  JobStaleEvent,
  JobStartedEvent,
  JobTiming,
  Processor,
  StateChangeEvent,
  WorkerDefinition,
  WorkerDefinitionOptions,
  WorkerErrorEvent,
  WorkerErrorKind,
  WorkerEventHandlers,
  WorkerState,
} from "./src/define-worker.js";

export { WorkerPool } from "./src/worker-pool.js";
export type {
  NotificationsDegradedEvent,
  PoolConnection,
  PoolConnectionErrorEvent,
  PoolConnectionEvent,
  ShutdownOptions,
  ShutdownResult,
  WorkerPoolEventHandlers,
  WorkerPoolOptions,
} from "./src/worker-pool.js";

export { WorkerConnectionError } from "./src/errors.js";

export type { PanqueueConfig, QueueConfig } from "@panqueue/config";

export { PanqueueError, SerializationError } from "@panqueue/core";
