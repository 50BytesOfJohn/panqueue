import { expect } from "jsr:@std/expect";
import { type Spy, spy, stub } from "jsr:@std/testing/mock";
import { _internals, type RedisClient } from "./redis_connection.ts";
import { Worker } from "./worker.ts";
import type { WorkerState } from "./worker.ts";

type TestQueues = {
  emails: { to: string; subject: string };
};

/** Creates a fake Redis client with spied methods for worker tests. */
function createFakeClient(options?: {
  evalResults?: unknown[];
  // deno-lint-ignore no-explicit-any
  evalFn?: (...args: any[]) => unknown;
}) {
  const evalResults = options?.evalResults ?? [];
  let evalCallCount = 0;

  // deno-lint-ignore no-explicit-any
  const sharedImpl = options?.evalFn ?? ((..._args: any[]) => {
    const result = evalResults[evalCallCount] ?? null;
    evalCallCount++;
    return Promise.resolve(result);
  });

  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    subscribe: spy((_channel: string, _cb: () => void) => Promise.resolve()),
    unsubscribe: spy(() => Promise.resolve()),
    claimGlobal: spy(sharedImpl),
    complete: spy(sharedImpl),
    fail: spy(sharedImpl),
    recover: spy(sharedImpl),
    extendLock: spy(sharedImpl),
    requeueActive: spy(sharedImpl),
    duplicate: spy(),
  } as unknown as RedisClient & {
    connect: Spy;
    disconnect: Spy;
    on: Spy;
    subscribe: Spy;
    unsubscribe: Spy;
    claimGlobal: Spy;
    complete: Spy;
    fail: Spy;
    recover: Spy;
    extendLock: Spy;
    requeueActive: Spy;
  };
}

/** Stubs createClient to return fake clients in order. */
function stubCreateClients(...fakeClients: RedisClient[]) {
  let callCount = 0;
  return stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() =>
      fakeClients[callCount++] ?? fakeClients[fakeClients.length - 1]) as any,
  );
}

/** Captures errors emitted via the onError event handler. */
function createErrorCapture() {
  const errors: { context: string; error: unknown }[] = [];
  return {
    errors,
    onError: (context: string, error: unknown) => {
      errors.push({ context, error });
    },
  };
}

// --- Constructor & state tests ---

Deno.test("Worker — Tier 1 constructor sets queueId", () => {
  const worker = new Worker<TestQueues>("emails", async () => {}, {
    connection: "redis://localhost:6379",
  });

  expect(worker.queueId).toBe("emails");
  expect(worker.isRunning).toBe(false);
  expect(worker.state).toBe("idle");
});

Deno.test("Worker — Tier 2 constructor sets queueId", () => {
  const config = {
    redis: "redis://localhost:6379" as const,
    queues: { emails: { mode: "global" as const } },
  };

  const worker = new Worker<TestQueues>(config, "emails", async () => {});

  expect(worker.queueId).toBe("emails");
  expect(worker.isRunning).toBe(false);
  expect(worker.state).toBe("idle");
});

// --- Lifecycle state transitions ---

Deno.test("Worker — state transitions: idle → running → stopped", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);
  const transitions: [WorkerState, WorkerState][] = [];

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
      events: {
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    });

    expect(worker.state).toBe("idle");

    await worker.start();
    expect(worker.state).toBe("running");
    expect(worker.isRunning).toBe(true);

    await worker.shutdown();
    expect(worker.state).toBe("stopped");
    expect(worker.isRunning).toBe(false);

    expect(transitions).toEqual([
      ["idle", "starting"],
      ["starting", "running"],
      ["running", "stopping"],
      ["stopping", "stopped"],
    ]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — failed start transitions to failed state", async () => {
  const mainClient = createFakeClient();

  let callCount = 0;
  const createStub = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => {
      callCount++;
      if (callCount === 1) return mainClient;
      return {
        connect: spy(() =>
          Promise.reject(new Error("subscriber connect failed"))
        ),
        disconnect: spy(() => Promise.resolve()),
        on: spy(),
      };
    }) as any,
  );

  const transitions: [WorkerState, WorkerState][] = [];

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
      events: {
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    });

    await expect(worker.start()).rejects.toThrow("subscriber connect failed");
    expect(worker.state).toBe("failed");
    expect(worker.isRunning).toBe(false);

    expect(transitions).toEqual([
      ["idle", "starting"],
      ["starting", "failed"],
    ]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — start from failed state succeeds", async () => {
  const mainClient = createFakeClient();

  let callCount = 0;
  const createStub = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => {
      callCount++;
      if (callCount === 1) return mainClient;
      if (callCount === 2) {
        // First subscriber fails
        return {
          connect: spy(() => Promise.reject(new Error("connect failed"))),
          disconnect: spy(() => Promise.resolve()),
          on: spy(),
        };
      }
      // Subsequent calls succeed
      return createFakeClient();
    }) as any,
  );

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await expect(worker.start()).rejects.toThrow("connect failed");
    expect(worker.state).toBe("failed");

    // Retry from failed state
    await worker.start();
    expect(worker.state).toBe("running");
    expect(worker.isRunning).toBe(true);

    await worker.shutdown();
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — start throws while stopping", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await worker.start();

    // Start shutdown but don't await it yet
    const shutdownPromise = worker.shutdown();

    // Attempting start during stopping should throw
    await expect(worker.start()).rejects.toThrow(
      "Cannot start worker while stopping",
    );

    await shutdownPromise;
  } finally {
    createStub.restore();
  }
});

// --- Structured shutdown result ---

Deno.test("Worker — shutdown returns clean result when no in-flight jobs", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await worker.start();
    const result = await worker.shutdown();

    expect(result).toEqual({
      mode: "force",
      timedOut: false,
      unfinishedJobs: 0,
      requeued: 0,
    });
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — shutdown returns clean result when already idle", async () => {
  const worker = new Worker<TestQueues>("emails", async () => {}, {
    connection: "redis://localhost:6379",
  });

  const result = await worker.shutdown();
  expect(result).toEqual({
    mode: "force",
    timedOut: false,
    unfinishedJobs: 0,
    requeued: 0,
  });
});

Deno.test("Worker — force shutdown requeues in-flight jobs", async () => {
  const jobData = {
    id: "job-slow",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok-1",
  };

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: handlerRelease, resolve: releaseHandler } = Promise
    .withResolvers<void>();

  let disconnected = false;
  let claimCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (disconnected) {
        return Promise.reject(new Error("The client is closed"));
      }
      if (claimCount === 1) {
        return Promise.resolve(JSON.stringify(jobData));
      }
      return Promise.resolve(null);
    },
  });
  // requeueActive returns "waiting" — the requeue succeeded.
  (mainClient as unknown as { requeueActive: Spy }).requeueActive = spy(() =>
    Promise.resolve("waiting" as const)
  );
  const origDisconnect = mainClient.disconnect;
  (mainClient as unknown as { disconnect: Spy }).disconnect = spy(() => {
    disconnected = true;
    return (origDisconnect as Spy).call(mainClient);
  });

  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await handlerRelease;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
      },
    );

    await worker.start();
    await handlerStarted;
    const result = await worker.shutdown();

    expect(result.mode).toBe("force");
    expect(result.timedOut).toBe(false);
    expect(result.unfinishedJobs).toBe(1);
    expect(result.requeued).toBe(1);

    const requeueCalls =
      (mainClient as unknown as { requeueActive: Spy }).requeueActive.calls;
    expect(requeueCalls.length).toBe(1);
    // (activeKey, waitingKey, jobsKey, notifyKey, failedKey, jobId, lockToken, reason, now)
    expect(requeueCalls[0].args[5]).toBe("job-slow");
    expect(requeueCalls[0].args[6]).toBe("tok-1");
    expect(requeueCalls[0].args[7]).toBe("shutdown");

    // Release the handler so it can clean up. complete() is now called against
    // the disconnected client; the test does not assert on that here.
    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — drain shutdown waits for in-flight jobs", async () => {
  const jobData = {
    id: "job-drain",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok-d",
  };

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: handlerRelease, resolve: releaseHandler } = Promise
    .withResolvers<void>();

  let claimCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) return Promise.resolve(JSON.stringify(jobData));
      return Promise.resolve(null);
    },
  });
  (mainClient as unknown as { complete: Spy }).complete = spy(() =>
    Promise.resolve("completed" as const)
  );

  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await handlerRelease;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
      },
    );

    await worker.start();
    await handlerStarted;

    const shutdownPromise = worker.shutdown({ drain: true });
    // Give shutdown a tick to enter drain mode, then release the handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseHandler();
    const result = await shutdownPromise;

    expect(result.mode).toBe("drain");
    expect(result.timedOut).toBe(false);
    expect(result.unfinishedJobs).toBe(0);
    expect(result.requeued).toBe(0);

    // requeueActive must NOT have been called — the drain finished cleanly.
    const requeueCalls =
      (mainClient as unknown as { requeueActive: Spy }).requeueActive.calls;
    expect(requeueCalls.length).toBe(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — drain shutdown times out and falls through to requeue", async () => {
  const jobData = {
    id: "job-drain-stuck",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok-stuck",
  };

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: handlerRelease, resolve: releaseHandler } = Promise
    .withResolvers<void>();

  let disconnected = false;
  let claimCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (disconnected) {
        return Promise.reject(new Error("The client is closed"));
      }
      if (claimCount === 1) return Promise.resolve(JSON.stringify(jobData));
      return Promise.resolve(null);
    },
  });
  (mainClient as unknown as { requeueActive: Spy }).requeueActive = spy(() =>
    Promise.resolve("waiting" as const)
  );
  const origDisconnect = mainClient.disconnect;
  (mainClient as unknown as { disconnect: Spy }).disconnect = spy(() => {
    disconnected = true;
    return (origDisconnect as Spy).call(mainClient);
  });

  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await handlerRelease;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
      },
    );

    await worker.start();
    await handlerStarted;
    const result = await worker.shutdown({ drain: true, timeout: 30 });

    expect(result.mode).toBe("drain");
    expect(result.timedOut).toBe(true);
    expect(result.unfinishedJobs).toBe(1);
    expect(result.requeued).toBe(1);

    const requeueCalls =
      (mainClient as unknown as { requeueActive: Spy }).requeueActive.calls;
    expect(requeueCalls.length).toBe(1);
    expect(requeueCalls[0].args[7]).toBe("shutdown-timeout");

    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    createStub.restore();
  }
});

// --- Job processing ---

Deno.test("Worker — processes a job successfully and calls complete", async () => {
  const jobData = {
    id: "job-1",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalResults: [
      JSON.stringify(jobData), // claim returns the job
      null, // subsequent claims return null
    ],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const processedJobs: string[] = [];
  const processor = spy(async (job: { id: string }) => {
    processedJobs.push(job.id);
    onProcessed();
  });

  try {
    const worker = new Worker<TestQueues>("emails", processor, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await worker.start();
    await processed;
    await worker.shutdown();

    expect(processedJobs).toEqual(["job-1"]);

    // complete() was called with jobId as 4th arg (activeKey, completedKey, jobsKey, jobId, timestamp)
    const completeCalls = (mainClient.complete as Spy).calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0].args[3]).toBe("job-1");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — failed job calls fail script", async () => {
  const jobData = {
    id: "job-2",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalResults: [
      JSON.stringify(jobData), // claim returns the job
      "failed", // fail script result
      null, // subsequent claims return null
    ],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
        throw new Error("processing failed");
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
      },
    );

    await worker.start();
    await processed;
    // Give the fail() call time to complete
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    // fail() was called with (activeKey, failedKey, waitingKey, jobsKey, notifyKey, jobId, timestamp, error)
    const failCalls = (mainClient.fail as Spy).calls;
    expect(failCalls.length).toBe(1);
    expect(failCalls[0].args[5]).toBe("job-2");
    expect(failCalls[0].args[7]).toBe("processing failed");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — retry: failed job with retries left returns waiting", async () => {
  const jobData = {
    id: "job-3",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 2,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalResults: [
      JSON.stringify(jobData), // claim
      "waiting", // fail returns "waiting" (will be retried)
      null, // no more jobs
    ],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
        throw new Error("transient error");
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    // fail() args: (activeKey, failedKey, waitingKey, jobsKey, notifyKey, jobId, timestamp, error)
    const failCalls = (mainClient.fail as Spy).calls;
    expect(failCalls.length).toBe(1);
    expect(failCalls[0].args[2]).toBe("{q:emails}:waiting");
    expect(failCalls[0].args[4]).toBe("{q:emails}:notify");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — concurrency limits parallel processing", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let jobsDone = 0;

  const jobs = Array.from({ length: 3 }, (_, i) => ({
    id: `job-${i}`,
    queueId: "emails",
    data: { to: "a@b.com", subject: `Hi ${i}` },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  }));

  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const mainClient = createFakeClient({
    evalResults: [
      JSON.stringify(jobs[0]),
      JSON.stringify(jobs[1]),
      JSON.stringify(jobs[2]),
      1, // complete
      1, // complete
      1, // complete
      null, // no more
    ],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
        jobsDone++;
        if (jobsDone === 3) onAllDone();
      },
      {
        connection: "redis://localhost:6379",
        concurrency: 2,
        pollInterval: 50,
      },
    );

    await worker.start();
    await allDone;
    await worker.shutdown();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — pub/sub wakes claim loop", async () => {
  const jobData = {
    id: "job-pubsub",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  let claimCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) {
        // First claim returns null (no jobs yet)
        return Promise.resolve(null);
      }
      if (claimCount === 2) {
        // Second claim (after pub/sub wake) returns job
        return Promise.resolve(JSON.stringify(jobData));
      }
      // Complete call and subsequent claims
      return Promise.resolve(claimCount === 3 ? 1 : null);
    },
  });

  const subClient = createFakeClient();
  const holder: { cb: (() => void) | null } = { cb: null };
  (subClient as unknown as { subscribe: Spy }).subscribe = spy(
    (_channel: string, cb: () => void) => {
      holder.cb = cb;
      return Promise.resolve();
    },
  );
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const processedJobs: string[] = [];

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async (job) => {
        processedJobs.push(job.id);
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 5000, // Long poll so pub/sub is the wake mechanism
      },
    );

    await worker.start();

    // Wait a bit, then simulate pub/sub notification
    await new Promise((resolve) => setTimeout(resolve, 50));
    holder.cb?.();

    await processed;
    await worker.shutdown();

    expect(processedJobs).toEqual(["job-pubsub"]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — Symbol.asyncDispose calls shutdown", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await worker.start();
    expect(worker.isRunning).toBe(true);

    await worker[Symbol.asyncDispose]();
    expect(worker.isRunning).toBe(false);
    expect(worker.state).toBe("stopped");
  } finally {
    createStub.restore();
  }
});

// --- Event handlers ---

Deno.test("Worker — onJobStart, onJobComplete fire for successful job", async () => {
  const jobData = {
    id: "job-events",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalResults: [JSON.stringify(jobData), 1, null],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const started: string[] = [];
  const completed: string[] = [];

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: {
          onJobStart: (job) => started.push(job.id),
          onJobComplete: (job) => completed.push(job.id),
        },
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    expect(started).toEqual(["job-events"]);
    expect(completed).toEqual(["job-events"]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — onJobFail fires for failed job", async () => {
  const jobData = {
    id: "job-fail-event",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalResults: [JSON.stringify(jobData), "failed", null],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const failed: { id: string; error: string }[] = [];

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
        throw new Error("boom");
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: {
          onJobFail: (job, error) => failed.push({ id: job.id, error }),
        },
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    expect(failed).toEqual([{ id: "job-fail-event", error: "boom" }]);
  } finally {
    createStub.restore();
  }
});

// --- Error resilience ---

Deno.test("Worker — claim Lua error does not crash worker", async () => {
  let claimCount = 0;
  const jobData = {
    id: "job-after-error",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) {
        return Promise.reject(new Error("PANQUEUE_MISSING_JOB_DATA: ghost-id"));
      }
      if (claimCount === 2) {
        return Promise.resolve(JSON.stringify(jobData));
      }
      // complete + subsequent claims
      return Promise.resolve(claimCount === 3 ? 1 : null);
    },
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onError },
      },
    );

    await worker.start();
    await processed;
    await worker.shutdown();

    const claimErrors = errors.filter((e) => e.context === "claim");
    expect(claimErrors.length).toBeGreaterThanOrEqual(1);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — complete() failure does not call fail()", async () => {
  const jobData = {
    id: "job-complete-fail",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  let evalCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      evalCount++;
      if (evalCount === 1) {
        // claim
        return Promise.resolve(JSON.stringify(jobData));
      }
      if (evalCount === 2) {
        // complete() rejects
        return Promise.reject(new Error("Redis write error"));
      }
      // subsequent claims
      return Promise.resolve(null);
    },
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onError },
      },
    );

    await worker.start();
    await processed;
    // Give the complete() rejection time to be handled
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.shutdown();

    // fail() was never called — complete() failure should not trigger fail()
    expect((mainClient.fail as Spy).calls.length).toBe(0);

    // onError was called for the completion failure
    const completeErrors = errors.filter((e) =>
      e.context.startsWith("complete:")
    );
    expect(completeErrors.length).toBe(1);

    // No fail errors (fail() was never called)
    const failErrors = errors.filter((e) => e.context.startsWith("fail:"));
    expect(failErrors.length).toBe(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — handler + fail() both throw, no unhandled rejection", async () => {
  const jobData = {
    id: "job-double-fail",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
  };

  let evalCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      evalCount++;
      if (evalCount === 1) {
        return Promise.resolve(JSON.stringify(jobData));
      }
      if (evalCount === 2) {
        // fail() also rejects
        return Promise.reject(new Error("Redis connection lost"));
      }
      return Promise.resolve(null);
    },
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
        throw new Error("handler boom");
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onError },
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.shutdown();

    // onError was called for the fail() failure
    const failErrors = errors.filter((e) => e.context.startsWith("fail:"));
    expect(failErrors.length).toBe(1);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — force shutdown: late ack on disconnected client surfaces as error", async () => {
  const jobData = {
    id: "job-slow",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok-late",
  };

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: handlerRelease, resolve: releaseHandler } = Promise
    .withResolvers<void>();

  let disconnected = false;
  let claimCount = 0;
  const mainClient = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (disconnected) {
        return Promise.reject(new Error("The client is closed"));
      }
      if (claimCount === 1) {
        return Promise.resolve(JSON.stringify(jobData));
      }
      return Promise.resolve(null);
    },
  });
  (mainClient as unknown as { requeueActive: Spy }).requeueActive = spy(() =>
    Promise.resolve("waiting" as const)
  );
  (mainClient as unknown as { complete: Spy }).complete = spy(() => {
    if (disconnected) return Promise.reject(new Error("The client is closed"));
    return Promise.resolve("completed" as const);
  });
  const origDisconnect = mainClient.disconnect;
  (mainClient as unknown as { disconnect: Spy }).disconnect = spy(() => {
    disconnected = true;
    return (origDisconnect as Spy).call(mainClient);
  });

  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);
  const { errors, onError } = createErrorCapture();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await handlerRelease;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onError },
      },
    );

    await worker.start();
    await handlerStarted;
    const result = await worker.shutdown();

    expect(result.mode).toBe("force");
    expect(result.unfinishedJobs).toBe(1);
    expect(result.requeued).toBe(1);

    // Release the handler — the late complete() lands on the disconnected
    // client and rejects. The error is surfaced via onError.
    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ackErrors = errors.filter((e) => e.context.startsWith("complete:"));
    expect(ackErrors.length).toBe(1);
  } finally {
    createStub.restore();
  }
});

// --- Startup edge cases ---

Deno.test("Worker — concurrent start() deduplication", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    // Call start() twice concurrently
    await Promise.all([worker.start(), worker.start()]);
    expect(worker.isRunning).toBe(true);

    // createClient called exactly twice (main + subscriber), not four
    expect(createStub.calls.length).toBe(2);

    await worker.shutdown();
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — shutdown during start() waits for startup then shuts down", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    // Start and immediately shutdown concurrently
    const [, shutdownResult] = await Promise.allSettled([
      worker.start(),
      worker.shutdown(),
    ]);

    // shutdown should have completed successfully (not no-oped)
    expect(shutdownResult.status).toBe("fulfilled");
    expect(worker.isRunning).toBe(false);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — restart after force-shutdown is not corrupted by old run", async () => {
  const jobData = {
    id: "job-old-run",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok-old",
  };

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: handlerRelease, resolve: releaseHandler } = Promise
    .withResolvers<void>();

  let disconnected = false;
  let evalCount = 0;
  const mainClient1 = createFakeClient({
    evalFn: () => {
      evalCount++;
      if (disconnected) {
        return Promise.reject(new Error("The client is closed"));
      }
      if (evalCount === 1) {
        return Promise.resolve(JSON.stringify(jobData));
      }
      return Promise.resolve(null);
    },
  });
  (mainClient1 as unknown as { requeueActive: Spy }).requeueActive = spy(() =>
    Promise.resolve("waiting" as const)
  );
  const origDisconnect = mainClient1.disconnect;
  (mainClient1 as unknown as { disconnect: Spy }).disconnect = spy(() => {
    disconnected = true;
    return (origDisconnect as Spy).call(mainClient1);
  });
  const subClient1 = createFakeClient();

  // Second run clients
  const mainClient2 = createFakeClient();
  const subClient2 = createFakeClient();

  const createStub = stubCreateClients(
    mainClient1,
    subClient1,
    mainClient2,
    subClient2,
  );
  const { onError } = createErrorCapture();

  try {
    let handlerCallCount = 0;
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        handlerCallCount++;
        if (handlerCallCount === 1) {
          onHandlerStarted();
          await handlerRelease; // Block first run's job
        }
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onError },
      },
    );

    // Run 1: start, process job, force shutdown while it is still running
    await worker.start();
    await handlerStarted;
    await worker.shutdown();
    expect(worker.state).toBe("stopped");

    // Run 2: restart the worker
    await worker.start();
    expect(worker.isRunning).toBe(true);
    expect(worker.state).toBe("running");

    // Now release the old handler — its finally should NOT corrupt the new run
    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The new run should still be healthy
    expect(worker.isRunning).toBe(true);

    await worker.shutdown();
    expect(worker.isRunning).toBe(false);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — partial startup rollback on subscriber failure", async () => {
  const mainClient = createFakeClient();

  let callCount = 0;
  const createStub = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => {
      callCount++;
      if (callCount === 1) return mainClient;
      // Second call (subscriber's createClient) — return a client whose connect rejects
      return {
        connect: spy(() =>
          Promise.reject(new Error("subscriber connect failed"))
        ),
        disconnect: spy(() => Promise.resolve()),
        on: spy(),
      };
    }) as any,
  );

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 50,
    });

    await expect(worker.start()).rejects.toThrow("subscriber connect failed");
    expect(worker.isRunning).toBe(false);
    expect(worker.state).toBe("failed");

    // Main client's disconnect was called during rollback
    expect((mainClient.disconnect as Spy).calls.length).toBeGreaterThanOrEqual(
      1,
    );
  } finally {
    createStub.restore();
  }
});

// --- Default console fallback ---

// --- Leases and stalled recovery ---

Deno.test("Worker — claim passes leaseMs and complete passes lockToken", async () => {
  const jobData = {
    id: "job-lease",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "abc123",
    leaseDeadline: Date.now() + 30_000,
  };

  const mainClient = createFakeClient({
    evalResults: [JSON.stringify(jobData), "completed", null],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        leaseMs: 12_345,
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    // claimGlobal(waitingKey, activeKey, jobsKey, timestamp, leaseMs)
    const claimCalls = (mainClient.claimGlobal as Spy).calls;
    expect(claimCalls[0].args[4]).toBe("12345");

    // complete(activeKey, completedKey, jobsKey, jobId, timestamp, lockToken)
    const completeCalls = (mainClient.complete as Spy).calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0].args[3]).toBe("job-lease");
    expect(completeCalls[0].args[5]).toBe("abc123");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — stale completion fires onJobStale and skips onJobComplete", async () => {
  const jobData = {
    id: "job-stale",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "tok",
    leaseDeadline: Date.now() + 30_000,
  };

  const mainClient = createFakeClient({
    evalResults: [JSON.stringify(jobData), "stale", null],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const completed: string[] = [];
  const stale: { id: string; phase: string }[] = [];

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: {
          onJobComplete: (j) => completed.push(j.id),
          onJobStale: (j, phase) => stale.push({ id: j.id, phase }),
        },
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    expect(completed).toEqual([]);
    expect(stale).toEqual([{ id: "job-stale", phase: "complete" }]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — fail passes lockToken; stale fail still fires onJobFail", async () => {
  const jobData = {
    id: "job-fail-stale",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "ftok",
    leaseDeadline: Date.now() + 30_000,
  };

  const mainClient = createFakeClient({
    evalResults: [JSON.stringify(jobData), "stale", null],
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const stale: { id: string; phase: string }[] = [];

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onProcessed();
        throw new Error("boom");
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 50,
        events: { onJobStale: (j, phase) => stale.push({ id: j.id, phase }) },
      },
    );

    await worker.start();
    await processed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();

    // fail(activeKey, failedKey, waitingKey, jobsKey, notifyKey, jobId, ts, error, lockToken)
    const failCalls = (mainClient.fail as Spy).calls;
    expect(failCalls.length).toBe(1);
    expect(failCalls[0].args[5]).toBe("job-fail-stale");
    expect(failCalls[0].args[8]).toBe("ftok");
    expect(stale).toEqual([{ id: "job-fail-stale", phase: "fail" }]);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — periodic recovery sweep calls scheduler.recover and emits onJobRecovered", async () => {
  const mainClient = createFakeClient();
  (mainClient as unknown as { claimGlobal: Spy }).claimGlobal = spy(() =>
    Promise.resolve(null)
  );
  let recoverCount = 0;
  (mainClient as unknown as { recover: Spy }).recover = spy(() => {
    recoverCount++;
    return Promise.resolve(["recovered-1", "recovered-2"]);
  });
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const recoveredBatches: string[][] = [];

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 5000,
      recoverIntervalMs: 30,
      recoverBatchSize: 50,
      events: { onJobRecovered: (ids) => recoveredBatches.push(ids) },
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.shutdown();

    expect(recoverCount).toBeGreaterThanOrEqual(1);
    expect(recoveredBatches.length).toBeGreaterThanOrEqual(1);
    expect(recoveredBatches[0]).toEqual(["recovered-1", "recovered-2"]);

    // recover(activeKey, waitingKey, jobsKey, notifyKey, failedKey, now, batch, reason)
    const recoverCalls = (mainClient.recover as Spy).calls;
    expect(recoverCalls[0].args[0]).toBe("{q:emails}:active");
    expect(recoverCalls[0].args[6]).toBe("50");
    expect(recoverCalls[0].args[7]).toBe("stalled");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — recoverIntervalMs=0 disables recovery sweep", async () => {
  const mainClient = createFakeClient();
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  try {
    const worker = new Worker<TestQueues>("emails", async () => {}, {
      connection: "redis://localhost:6379",
      pollInterval: 5000,
      recoverIntervalMs: 0,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await worker.shutdown();

    expect((mainClient.recover as Spy).calls.length).toBe(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — lock renewal extends lease while handler runs", async () => {
  const jobData = {
    id: "job-renew",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "renew-tok",
    leaseDeadline: Date.now() + 200,
  };

  const mainClient = createFakeClient();
  let claimed = false;
  (mainClient as unknown as { claimGlobal: Spy }).claimGlobal = spy(() => {
    if (claimed) return Promise.resolve(null);
    claimed = true;
    return Promise.resolve(JSON.stringify(jobData));
  });
  (mainClient as unknown as { extendLock: Spy }).extendLock = spy(() =>
    Promise.resolve(1)
  );
  (mainClient as unknown as { complete: Spy }).complete = spy(() =>
    Promise.resolve("completed")
  );
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await release;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 5000,
        leaseMs: 90,
        lockRenewMs: 30,
        recoverIntervalMs: 0,
      },
    );

    await worker.start();
    await handlerStarted;
    // Hold the handler open long enough for at least 2 renewals
    await new Promise((resolve) => setTimeout(resolve, 100));
    doRelease();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.shutdown();

    const extendCalls = (mainClient.extendLock as Spy).calls;
    expect(extendCalls.length).toBeGreaterThanOrEqual(2);
    // extendLock(activeKey, jobsKey, jobId, newDeadline, lockToken)
    expect(extendCalls[0].args[2]).toBe("job-renew");
    expect(extendCalls[0].args[4]).toBe("renew-tok");
  } finally {
    createStub.restore();
  }
});

Deno.test("Worker — lost lease during execution emits lease-lost error and stops renewing", async () => {
  const jobData = {
    id: "job-lost",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    attempts: 1,
    maxRetries: 0,
    createdAt: Date.now(),
    processedAt: Date.now(),
    lockToken: "lost-tok",
    leaseDeadline: Date.now() + 50,
  };

  const mainClient = createFakeClient();
  let claimed = false;
  (mainClient as unknown as { claimGlobal: Spy }).claimGlobal = spy(() => {
    if (claimed) return Promise.resolve(null);
    claimed = true;
    return Promise.resolve(JSON.stringify(jobData));
  });
  // Lease lost on first renewal
  (mainClient as unknown as { extendLock: Spy }).extendLock = spy(() =>
    Promise.resolve(0)
  );
  (mainClient as unknown as { complete: Spy }).complete = spy(() =>
    Promise.resolve("stale")
  );
  const subClient = createFakeClient();
  const createStub = stubCreateClients(mainClient, subClient);

  const { promise: handlerStarted, resolve: onHandlerStarted } = Promise
    .withResolvers<void>();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  try {
    const worker = new Worker<TestQueues>(
      "emails",
      async () => {
        onHandlerStarted();
        await release;
      },
      {
        connection: "redis://localhost:6379",
        pollInterval: 5000,
        leaseMs: 60,
        lockRenewMs: 20,
        recoverIntervalMs: 0,
        events: { onError },
      },
    );

    await worker.start();
    await handlerStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));
    doRelease();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.shutdown();

    const leaseLost = errors.filter((e) => e.context.startsWith("lease-lost:"));
    expect(leaseLost.length).toBe(1);

    // After lease lost, renewer stops — only 1 extend call should have been made
    expect((mainClient.extendLock as Spy).calls.length).toBe(1);
  } finally {
    createStub.restore();
  }
});

Deno.test({
  name: "Worker — errors fall back to console.error when no onError handler",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let claimCount = 0;
    const jobData = {
      id: "job-console",
      queueId: "emails",
      data: { to: "a@b.com", subject: "Hi" },
      status: "active",
      attempts: 1,
      maxRetries: 0,
      createdAt: Date.now(),
      processedAt: Date.now(),
    };

    const mainClient = createFakeClient({
      evalFn: () => {
        claimCount++;
        if (claimCount === 1) {
          return Promise.reject(new Error("claim failed"));
        }
        if (claimCount === 2) {
          return Promise.resolve(JSON.stringify(jobData));
        }
        return Promise.resolve(claimCount === 3 ? 1 : null);
      },
    });
    const subClient = createFakeClient();
    const createStub = stubCreateClients(mainClient, subClient);

    const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
      void
    >();
    const errorSpy = stub(console, "error", () => {});

    try {
      // No events option — should fall back to console
      const worker = new Worker<TestQueues>(
        "emails",
        async () => {
          onProcessed();
        },
        {
          connection: "redis://localhost:6379",
          pollInterval: 50,
        },
      );

      await worker.start();
      await processed;
      await worker.shutdown();

      const claimErrors = errorSpy.calls.filter(
        (c) => typeof c.args[0] === "string" && c.args[0].includes("claim"),
      );
      expect(claimErrors.length).toBeGreaterThanOrEqual(1);
    } finally {
      errorSpy.restore();
      createStub.restore();
    }
  },
});
