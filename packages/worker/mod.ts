export {
  defineWorker,
  isWorkerDefinition,
  WORKER_DEFINITION_BRAND,
} from "./src/define_worker.ts";
export type {
  Processor,
  WorkerDefinition,
  WorkerDefinitionOptions,
  WorkerEventHandlers,
  WorkerState,
} from "./src/define_worker.ts";

export { WorkerPool } from "./src/worker_pool.ts";
export type {
  ShutdownOptions,
  ShutdownResult,
  WorkerPoolOptions,
} from "./src/worker_pool.ts";

export type { PanqueueConfig, QueueConfig } from "@panqueue/config";
