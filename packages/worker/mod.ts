export {
  defineWorker,
  isWorkerDefinition,
  WORKER_DEFINITION_BRAND,
} from "./src/define_worker.js";
export type {
  Processor,
  WorkerDefinition,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "./src/define_worker.js";

export { WorkerPool } from "./src/worker_pool.js";
export type {
  ShutdownOptions,
  ShutdownResult,
  WorkerPoolOptions,
} from "./src/worker_pool.js";

export type { PanqueueConfig, QueueConfig } from "@panqueue/config";
