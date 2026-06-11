import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  JobCompletedEvent,
  JobErrorEvent,
  JobFailedEvent,
  JobRetryEvent,
  JobStaleEvent,
  Processor,
  WorkerErrorEvent,
  WorkerEventHandlers,
} from "../define-worker.js";
import type { PanqueueWorkerClient } from "../redis-connection.js";
import type { QueueRetention } from "../scheduler/base.js";
import { WorkerRunner } from "./worker-runner.js";

const RETENTION: QueueRetention = {
  completed: { mode: "trim", ttl: 5000, count: 100 },
  failed: { mode: "trim", ttl: 5000, count: 100 },
};

/** Flat `[field, value, …]` job hash as Lua HGETALL returns it. */
function jobHash(overrides: Record<string, string> = {}): string[] {
  const fields: Record<string, string> = {
    id: "j1",
    queueId: "q",
    status: "active",
    payload: JSON.stringify({ n: 1 }),
    runs: "1",
    failures: "0",
    stalls: "0",
    maxRetries: "2",
    maxStalls: "5",
    createdAt: "1",
    lockToken: "tok",
    leaseDeadline: "9999999999999",
    ...overrides,
  };
  return Object.entries(fields).flat();
}

interface HarnessOptions {
  processor?: Processor;
  events: WorkerEventHandlers;
  /** Result of the fail script. Default: "waiting". */
  failResult?: string;
  /** Result of the complete script. Default: "completed". */
  completeResult?: string;
  /** Claimed job hash. Pass null to never claim. Default: jobHash(). */
  claim?: string[] | null;
  /** Entries returned by the first recovery sweep; enables the sweep timer. */
  recover?: unknown[];
}

const startedRunners: WorkerRunner[] = [];

afterEach(async () => {
  for (const runner of startedRunners.splice(0)) {
    await runner.stopClaiming();
    await runner.drainInflight(1000);
    runner.finalize();
  }
});

/** Build a runner over a scripted fake client. Claims at most one job. */
function makeRunner(options: HarnessOptions): WorkerRunner {
  let claimed = false;
  let recovered = false;
  const client: PanqueueWorkerClient = {
    disconnect: async () => {},
    claimGlobal: async () => {
      if (claimed || options.claim === null) return null;
      claimed = true;
      return options.claim ?? jobHash();
    },
    complete: async () => options.completeResult ?? "completed",
    fail: async () => options.failResult ?? "waiting",
    recover: async () => {
      if (recovered || !options.recover) return [];
      recovered = true;
      return options.recover;
    },
    extendLock: async () => "extended",
    requeueActive: async () => "waiting",
  };

  const runner = new WorkerRunner(
    "q",
    options.processor ?? (async () => {}),
    {
      pollInterval: 60_000,
      recoverIntervalMs: options.recover ? 5 : 0,
      events: options.events,
    },
    client,
    RETENTION,
  );
  startedRunners.push(runner);
  return runner;
}

/** Poll until `count` events were captured. */
async function captured(events: unknown[], count = 1): Promise<void> {
  await vi.waitFor(() => {
    if (events.length < count) throw new Error("event not emitted yet");
  });
}

describe("WorkerRunner job events", () => {
  it("emits onJobCompleted with a completed-status snapshot", async () => {
    // Arrange
    const events: JobCompletedEvent[] = [];
    const runner = makeRunner({ events: { onJobCompleted: (e) => events.push(e) } });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].job).toMatchObject({ id: "j1", status: "completed" });
  });

  it("omits the lease fields from the settled snapshot", async () => {
    // Arrange
    const events: JobCompletedEvent[] = [];
    const runner = makeRunner({ events: { onJobCompleted: (e) => events.push(e) } });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].job.lockToken).toBeUndefined();
  });

  it("includes handler timing on onJobCompleted", async () => {
    // Arrange
    const before = Date.now();
    const events: JobCompletedEvent[] = [];
    const runner = makeRunner({ events: { onJobCompleted: (e) => events.push(e) } });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].timing.startedAt).toBeGreaterThanOrEqual(before);
    expect(events[0].timing.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes handler timing on onJobError", async () => {
    // Arrange
    const events: JobErrorEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      events: { onJobError: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].timing.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the original thrown error to onJobError", async () => {
    // Arrange
    const boom = new Error("boom");
    const events: JobErrorEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw boom;
      },
      events: { onJobError: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].error).toBe(boom);
  });

  it("marks onJobError willRetry true when the job is requeued", async () => {
    // Arrange
    const events: JobErrorEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "waiting",
      events: { onJobError: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].willRetry).toBe(true);
  });

  it("marks onJobError willRetry false on terminal failure", async () => {
    // Arrange
    const events: JobErrorEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "failed",
      events: { onJobError: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].willRetry).toBe(false);
  });

  it("emits onJobError even when the handler throws undefined", async () => {
    // Arrange
    const events: JobErrorEvent[] = [];
    const runner = makeRunner({
      processor: () => Promise.reject(undefined),
      events: { onJobError: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events).toHaveLength(1);
  });

  it("emits onJobRetry with handler cause and authoritative counters", async () => {
    // Arrange
    const events: JobRetryEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "waiting",
      events: { onJobRetry: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert — maxRetries 2, first failure recorded: one retry left.
    await captured(events);
    expect(events[0]).toMatchObject({
      retriesLeft: 1,
      cause: "handler",
      job: { runs: 1, failures: 1, status: "waiting" },
    });
  });

  it("emits onJobFailed with handler cause when retries are exhausted", async () => {
    // Arrange
    const events: JobFailedEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "failed",
      events: { onJobFailed: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0]).toMatchObject({
      cause: "handler",
      job: { runs: 1, status: "failed" },
    });
  });

  it("does not emit onJobFailed when the job will retry", async () => {
    // Arrange
    const retries: JobRetryEvent[] = [];
    const failures: JobFailedEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "waiting",
      events: {
        onJobRetry: (e) => retries.push(e),
        onJobFailed: (e) => failures.push(e),
      },
    });

    // Act
    runner.start();

    // Assert
    await captured(retries);
    expect(failures).toHaveLength(0);
  });

  it("emits onJobStale when the fail acknowledgement is fenced off", async () => {
    // Arrange
    const events: JobStaleEvent[] = [];
    const runner = makeRunner({
      processor: async () => {
        throw new Error("boom");
      },
      failResult: "stale",
      events: { onJobStale: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0].phase).toBe("fail");
  });
});

describe("WorkerRunner event handler failures", () => {
  it("reports a throwing event handler to onWorkerError with an events scope", async () => {
    // Arrange
    const errors: WorkerErrorEvent[] = [];
    const runner = makeRunner({
      events: {
        onJobCompleted: () => {
          throw new Error("hook boom");
        },
        onWorkerError: (e) => errors.push(e),
      },
    });

    // Act
    runner.start();

    // Assert
    await captured(errors);
    expect(errors[0]).toMatchObject({
      scope: "events:onJobCompleted",
      error: new Error("hook boom"),
    });
  });

  it("reports a rejecting async event handler to onWorkerError", async () => {
    // Arrange
    const errors: WorkerErrorEvent[] = [];
    const runner = makeRunner({
      events: {
        onJobCompleted: () => Promise.reject(new Error("async hook boom")) as unknown as void,
        onWorkerError: (e) => errors.push(e),
      },
    });

    // Act
    runner.start();

    // Assert
    await captured(errors);
    expect(errors[0].scope).toBe("events:onJobCompleted");
  });

  it("drops failures thrown by onWorkerError itself", async () => {
    // Arrange
    const completed: JobCompletedEvent[] = [];
    const runner = makeRunner({
      events: {
        onJobStarted: () => {
          throw new Error("hook boom");
        },
        onWorkerError: () => {
          throw new Error("reporter boom");
        },
        onJobCompleted: (e) => completed.push(e),
      },
    });

    // Act
    runner.start();

    // Assert — the job still completes despite both handlers throwing.
    await captured(completed);
    expect(completed[0].job.status).toBe("completed");
  });
});

describe("WorkerRunner recovery sweep events", () => {
  it("emits onJobRetry with stalled cause for a requeued stalled job", async () => {
    // Arrange
    const events: JobRetryEvent[] = [];
    const runner = makeRunner({
      claim: null,
      recover: [["waiting", ...jobHash({ status: "waiting", stalls: "1", runs: "1" })]],
      events: { onJobRetry: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert — maxStalls 5, one stall recorded: four recoveries left.
    await captured(events);
    expect(events[0]).toMatchObject({ cause: "stalled", retriesLeft: 4, job: { runs: 1 } });
  });

  it("emits onJobFailed with stalled cause for a terminally stalled job", async () => {
    // Arrange
    const events: JobFailedEvent[] = [];
    const runner = makeRunner({
      claim: null,
      recover: [["failed", ...jobHash({ status: "failed", stalls: "6", runs: "3" })]],
      events: { onJobFailed: (e) => events.push(e) },
    });

    // Act
    runner.start();

    // Assert
    await captured(events);
    expect(events[0]).toMatchObject({ cause: "stalled", job: { runs: 3 } });
  });
});
