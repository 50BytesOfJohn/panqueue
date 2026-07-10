import type { PanqueueConfig } from "@panqueue/config";
import { PanqueueError, type QueueMap } from "@panqueue/core";
import { describe, expect, it } from "vitest";

import { defineWorker, type WorkerConcurrency } from "./define-worker.js";
import { WorkerPool } from "./worker-pool.js";

const config = {
  redis: "redis://localhost",
  queues: {},
} as unknown as PanqueueConfig<QueueMap>;

function poolWith(concurrency: WorkerConcurrency): () => WorkerPool {
  const def = defineWorker(config, "q", async () => {}, { concurrency });
  return () => new WorkerPool(config, { workers: [def] });
}

describe("WorkerPool constructor concurrency validation", () => {
  it("rejects a zero concurrency", () => {
    // Arrange / Act / Assert
    expect(poolWith(0)).toThrow(PanqueueError);
  });

  it("rejects a fractional concurrency", () => {
    // Arrange / Act / Assert
    expect(poolWith(1.5)).toThrow(PanqueueError);
  });

  it("rejects a global limit below 1", () => {
    // Arrange / Act / Assert
    expect(poolWith({ global: { limit: 0, version: 1 } })).toThrow(PanqueueError);
  });

  it("rejects a global version below 1", () => {
    // Arrange / Act / Assert
    expect(poolWith({ global: { limit: 10, version: 0 } })).toThrow(PanqueueError);
  });

  it("accepts a valid local + global concurrency", () => {
    // Arrange / Act / Assert
    expect(poolWith({ local: 2, global: { limit: 10, version: 1 } })).not.toThrow();
  });
});
