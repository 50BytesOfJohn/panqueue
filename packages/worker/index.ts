export {
  defineWorker,
  isWorkerDefinition,
  WORKER_DEFINITION_BRAND,
} from "./src/define-worker.js";
export type {
  Processor,
  WorkerDefinition,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "./src/define-worker.js";

export { WorkerPool } from "./src/worker-pool.js";
export type {
  ShutdownOptions,
  ShutdownResult,
  WorkerPoolOptions,
} from "./src/worker-pool.js";

export type { PanqueueConfig, QueueConfig } from "@panqueue/config";
