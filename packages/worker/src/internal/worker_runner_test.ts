import { expect } from "jsr:@std/expect";
import { type Spy, spy } from "jsr:@std/testing/mock";
import type { WorkerState } from "../define_worker.ts";
import { createErrorCapture, createFakeClient } from "./_test_utils.ts";
import { WorkerRunner } from "./worker_runner.ts";

const baseJob = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  queueId: "emails",
  data: { to: "a@b.com", subject: "Hi" },
  status: "active",
  runs: 1,
  failures: 0,
  stalls: 0,
  maxRetries: 0,
  maxStalls: 5,
  createdAt: Date.now(),
  lastStartedAt: Date.now(),
  lockToken: "tok-1",
  ...overrides,
});

// ── Lifecycle ─────────────────────────────────────────────────────────

Deno.test("WorkerRunner — state transitions: idle → running → stopping → stopped", async () => {
  const client = createFakeClient();
  const transitions: [WorkerState, WorkerState][] = [];

  const runner = new WorkerRunner(
    "emails",
    async () => {},
    {
      pollInterval: 50,
      events: { onStateChange: (from, to) => transitions.push([from, to]) },
    },
    client,
  );

  expect(runner.state).toBe("idle");
  runner.start();
  expect(runner.state).toBe("running");

  await runner.stopClaiming();
  expect(runner.state).toBe("stopping");
  await runner.forceRequeueInflight();
  runner.finalize();
  expect(runner.state).toBe("stopped");

  expect(transitions).toEqual([
    ["idle", "running"],
    ["running", "stopping"],
    ["stopping", "stopped"],
  ]);
});

Deno.test("WorkerRunner — start() is single-shot", async () => {
  const client = createFakeClient();
  const runner = new WorkerRunner(
    "emails",
    async () => {},
    { pollInterval: 50 },
    client,
  );

  runner.start();
  expect(() => runner.start()).toThrow("single-shot");

  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();
});

// ── Job processing ─────────────────────────────────────────────────────

Deno.test("WorkerRunner — processes a job and calls complete", async () => {
  const client = createFakeClient({
    evalResults: [JSON.stringify(baseJob()), "completed", null],
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { promise: completed, resolve: onCompleted } = Promise.withResolvers<
    void
  >();
  const seen: string[] = [];

  const runner = new WorkerRunner(
    "emails",
    async (job) => {
      seen.push(job.id);
      onProcessed();
    },
    { pollInterval: 50, events: { onJobComplete: () => onCompleted() } },
    client,
  );

  runner.start();
  await processed;
  await completed;
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(seen).toEqual(["job-1"]);
  expect((client.complete as Spy).calls.length).toBe(1);
  // complete(activeKey, completedKey, jobsKey, corruptKey, corruptDataKey, jobId, lockToken)
  expect((client.complete as Spy).calls[0].args[5]).toBe("job-1");
});

Deno.test("WorkerRunner — handler throws → fail script invoked with error", async () => {
  const client = createFakeClient({
    evalResults: [JSON.stringify(baseJob({ id: "job-fail" })), "failed", null],
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onProcessed();
      throw new Error("boom");
    },
    { pollInterval: 50 },
    client,
  );

  runner.start();
  await processed;
  await new Promise((r) => setTimeout(r, 20));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  const failCalls = (client.fail as Spy).calls;
  expect(failCalls.length).toBe(1);
  // fail(activeKey, failedKey, waitingKey, jobsKey, notifyKey, corruptKey, corruptDataKey, jobId, error, lockToken)
  expect(failCalls[0].args[7]).toBe("job-fail");
  expect(failCalls[0].args[8]).toBe("boom");
});

// ── Concurrency & wake ─────────────────────────────────────────────────

Deno.test("WorkerRunner — concurrency caps simultaneous handlers", async () => {
  const jobs = Array.from(
    { length: 3 },
    (_, i) => JSON.stringify(baseJob({ id: `job-${i}` })),
  );

  let claimCount = 0;
  const client = createFakeClient();
  (client.claimGlobal as Spy) = spy(() => {
    const result = jobs[claimCount] ?? null;
    claimCount++;
    return Promise.resolve(result);
  });
  (client.complete as Spy) = spy(() => Promise.resolve("completed"));

  let concurrent = 0;
  let maxConcurrent = 0;
  let done = 0;
  let completedCount = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();
  const { promise: allCompleted, resolve: onAllCompleted } = Promise
    .withResolvers<void>();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      done++;
      if (done === 3) onAllDone();
    },
    {
      concurrency: 2,
      pollInterval: 50,
      events: {
        onJobComplete: () => {
          completedCount++;
          if (completedCount === 3) onAllCompleted();
        },
      },
    },
    client,
  );

  runner.start();
  await allDone;
  await allCompleted;
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(maxConcurrent).toBeLessThanOrEqual(2);
});

Deno.test("WorkerRunner — wake() resumes the claim loop", async () => {
  let claimCount = 0;
  const client = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) return Promise.resolve(null);
      if (claimCount === 2) {
        return Promise.resolve(JSON.stringify(baseJob({ id: "wake-job" })));
      }
      return Promise.resolve(claimCount === 3 ? "completed" : null);
    },
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { promise: completed, resolve: onCompleted } = Promise.withResolvers<
    void
  >();
  const seen: string[] = [];

  const runner = new WorkerRunner(
    "emails",
    async (job) => {
      seen.push(job.id);
      onProcessed();
    },
    {
      pollInterval: 5000, // long poll so wake is the only path
      events: { onJobComplete: () => onCompleted() },
    },
    client,
  );

  runner.start();
  await new Promise((r) => setTimeout(r, 20));
  runner.wake();

  await processed;
  await completed;
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(seen).toEqual(["wake-job"]);
});

// ── Force-requeue handoff ──────────────────────────────────────────────

Deno.test("WorkerRunner — forceRequeueInflight returns counts for in-flight jobs", async () => {
  const job = baseJob({ id: "slow", lockToken: "tok-1" });

  let claimCount = 0;
  const client = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) return Promise.resolve(JSON.stringify(job));
      return Promise.resolve(null);
    },
  });
  (client as { requeueActive: Spy }).requeueActive = spy(() =>
    Promise.resolve("waiting" as const)
  );
  (client.complete as Spy) = spy(() => Promise.resolve("stale"));

  const { promise: started, resolve: onStarted } = Promise.withResolvers<
    void
  >();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onStarted();
      await release;
    },
    { pollInterval: 50 },
    client,
  );

  runner.start();
  await started;
  await runner.stopClaiming();

  const result = await runner.forceRequeueInflight();
  expect(result.unfinishedJobs).toBe(1);
  expect(result.requeued).toBe(1);

  const requeueCalls = (client.requeueActive as Spy).calls;
  expect(requeueCalls.length).toBe(1);
  // requeueActive(activeKey, waitingKey, jobsKey, notifyKey, corruptKey, corruptDataKey, jobId, lockToken, reason)
  expect(requeueCalls[0].args[6]).toBe("slow");
  expect(requeueCalls[0].args[7]).toBe("tok-1");
  expect(requeueCalls[0].args[8]).toBe("shutdown");

  doRelease();
  runner.finalize();
  await new Promise((r) => setTimeout(r, 10));
});

Deno.test("WorkerRunner — drainInflight times out and reports timedOut=true", async () => {
  const job = baseJob({ id: "stuck", lockToken: "tok-stuck" });

  let claimCount = 0;
  const client = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) return Promise.resolve(JSON.stringify(job));
      return Promise.resolve(null);
    },
  });
  (client.complete as Spy) = spy(() => Promise.resolve("stale"));

  const { promise: started, resolve: onStarted } = Promise.withResolvers<
    void
  >();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onStarted();
      await release;
    },
    { pollInterval: 50 },
    client,
  );

  runner.start();
  await started;
  await runner.stopClaiming();

  const drainResult = await runner.drainInflight(20);
  expect(drainResult.timedOut).toBe(true);

  doRelease();
  runner.finalize();
  await new Promise((r) => setTimeout(r, 10));
});

// ── Recovery ───────────────────────────────────────────────────────────

Deno.test("WorkerRunner — recovery sweep calls scheduler.recover and emits onJobRecovered", async () => {
  const client = createFakeClient();
  (client.claimGlobal as Spy) = spy(() => Promise.resolve(null));
  let recoverCount = 0;
  (client.recover as Spy) = spy(() => {
    recoverCount++;
    return Promise.resolve(["r-1", "r-2"]);
  });

  const recoveredBatches: string[][] = [];

  const runner = new WorkerRunner(
    "emails",
    async () => {},
    {
      pollInterval: 5000,
      recoverIntervalMs: 30,
      recoverBatchSize: 50,
      events: { onJobRecovered: (ids) => recoveredBatches.push(ids) },
    },
    client,
  );

  runner.start();
  await new Promise((r) => setTimeout(r, 80));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(recoverCount).toBeGreaterThanOrEqual(1);
  expect(recoveredBatches[0]).toEqual(["r-1", "r-2"]);
});

Deno.test("WorkerRunner — recoverIntervalMs=0 disables recovery sweep", async () => {
  const client = createFakeClient();

  const runner = new WorkerRunner(
    "emails",
    async () => {},
    { pollInterval: 5000, recoverIntervalMs: 0 },
    client,
  );

  runner.start();
  await new Promise((r) => setTimeout(r, 60));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect((client.recover as Spy).calls.length).toBe(0);
});

// ── Lock renewal ───────────────────────────────────────────────────────
// Renewal/recovery semantics live in lease_renewer_test.ts and
// stalled_recovery_sweep_test.ts. These cases only assert that WorkerRunner
// composes and wires those modules through its lifecycle.

Deno.test("WorkerRunner — extends lease while handler runs", async () => {
  const job = baseJob({ id: "renew", lockToken: "renew-tok" });
  let claimed = false;
  const client = createFakeClient();
  (client.claimGlobal as Spy) = spy(() => {
    if (claimed) return Promise.resolve(null);
    claimed = true;
    return Promise.resolve(JSON.stringify(job));
  });
  (client.extendLock as Spy) = spy(() => Promise.resolve("extended"));
  (client.complete as Spy) = spy(() => Promise.resolve("completed"));

  const { promise: started, resolve: onStarted } = Promise.withResolvers<
    void
  >();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onStarted();
      await release;
    },
    {
      pollInterval: 5000,
      leaseMs: 90,
      lockRenewMs: 30,
      recoverIntervalMs: 0,
    },
    client,
  );

  runner.start();
  await started;
  await new Promise((r) => setTimeout(r, 100));
  doRelease();
  await new Promise((r) => setTimeout(r, 30));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect((client.extendLock as Spy).calls.length).toBeGreaterThanOrEqual(2);
});

// ── Stale acks ─────────────────────────────────────────────────────────

Deno.test("WorkerRunner — stale completion fires onJobStale and skips onJobComplete", async () => {
  const client = createFakeClient({
    evalResults: [
      JSON.stringify(baseJob({ id: "stale", lockToken: "tok" })),
      "stale",
      null,
    ],
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const completed: string[] = [];
  const stale: { id: string; phase: string }[] = [];

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onProcessed();
    },
    {
      pollInterval: 50,
      events: {
        onJobComplete: (j) => completed.push(j.id),
        onJobStale: (j, phase) => stale.push({ id: j.id, phase }),
      },
    },
    client,
  );

  runner.start();
  await processed;
  await new Promise((r) => setTimeout(r, 20));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(completed).toEqual([]);
  expect(stale).toEqual([{ id: "stale", phase: "complete" }]);
});

// ── Error resilience ───────────────────────────────────────────────────

Deno.test("WorkerRunner — claim error surfaces via onError and does not crash", async () => {
  let claimCount = 0;
  const client = createFakeClient({
    evalFn: () => {
      claimCount++;
      if (claimCount === 1) return Promise.reject(new Error("claim broke"));
      if (claimCount === 2) {
        return Promise.resolve(JSON.stringify(baseJob({ id: "after-error" })));
      }
      return Promise.resolve(claimCount === 3 ? "completed" : null);
    },
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onProcessed();
    },
    { pollInterval: 50, events: { onError } },
    client,
  );

  runner.start();
  await processed;
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect(errors.filter((e) => e.context === "claim").length)
    .toBeGreaterThanOrEqual(1);
});

Deno.test("WorkerRunner — complete() rejection surfaces as onError without calling fail", async () => {
  let evalCount = 0;
  const client = createFakeClient({
    evalFn: () => {
      evalCount++;
      if (evalCount === 1) return Promise.resolve(JSON.stringify(baseJob()));
      if (evalCount === 2) {
        return Promise.reject(new Error("Redis write error"));
      }
      return Promise.resolve(null);
    },
  });

  const { promise: processed, resolve: onProcessed } = Promise.withResolvers<
    void
  >();
  const { errors, onError } = createErrorCapture();

  const runner = new WorkerRunner(
    "emails",
    async () => {
      onProcessed();
    },
    { pollInterval: 50, events: { onError } },
    client,
  );

  runner.start();
  await processed;
  await new Promise((r) => setTimeout(r, 50));
  await runner.stopClaiming();
  await runner.forceRequeueInflight();
  runner.finalize();

  expect((client.fail as Spy).calls.length).toBe(0);
  expect(errors.filter((e) => e.context.startsWith("complete:")).length)
    .toBe(1);
});
