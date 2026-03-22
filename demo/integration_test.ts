/**
 * Integration test script — exercises the new Worker lifecycle features
 * against real Redis on port 6399.
 *
 * Run: deno run --allow-net demo/integration_test.ts
 */

import { QueueClient } from "@panqueue/client";
import { Worker } from "@panqueue/worker";
import type { WorkerState, ShutdownResult } from "@panqueue/worker";

const CONNECTION = { host: "localhost", port: 6399 };

type TestQueues = {
  emails: { to: string; subject: string };
  slow: { delay: number };
  failing: { shouldFail: boolean };
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

async function flushRedis() {
  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.connect();
  await client.redis.client.sendCommand(["FLUSHDB"]);
  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 1: State machine transitions — happy path
// ──────────────────────────────────────────────────────────
async function test1_stateTransitions() {
  console.log("\n🔬 Test 1: State machine transitions (happy path)");
  await flushRedis();

  const transitions: [WorkerState, WorkerState][] = [];

  const worker = new Worker<TestQueues>("emails", async () => {}, {
    connection: CONNECTION,
    pollInterval: 100,
    events: {
      onStateChange: (from, to) => transitions.push([from, to]),
    },
  });

  assert(worker.state === "idle", `Initial state is "idle" (got "${worker.state}")`);
  assert(!worker.isRunning, "isRunning is false before start");

  await worker.start();
  assert(worker.state === "running", `State after start is "running" (got "${worker.state}")`);
  assert(worker.isRunning, "isRunning is true after start");

  const result = await worker.shutdown();
  assert(worker.state === "stopped", `State after shutdown is "stopped" (got "${worker.state}")`);
  assert(!worker.isRunning, "isRunning is false after shutdown");
  assert(!result.timedOut, "Clean shutdown did not time out");
  assert(result.unfinishedJobs === 0, "No unfinished jobs");

  assert(transitions.length === 4, `4 transitions fired (got ${transitions.length})`);
  assert(transitions[0][0] === "idle" && transitions[0][1] === "starting", "idle → starting");
  assert(transitions[1][0] === "starting" && transitions[1][1] === "running", "starting → running");
  assert(transitions[2][0] === "running" && transitions[2][1] === "stopping", "running → stopping");
  assert(transitions[3][0] === "stopping" && transitions[3][1] === "stopped", "stopping → stopped");
}

// ──────────────────────────────────────────────────────────
// Test 2: Process jobs with event handlers
// ──────────────────────────────────────────────────────────
async function test2_processWithEvents() {
  console.log("\n🔬 Test 2: Process jobs with onJobStart/onJobComplete events");
  await flushRedis();

  // Enqueue 3 jobs
  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await client.enqueue("emails", { to: `user${i}@test.com`, subject: `Test ${i}` }));
  }
  console.log(`  Enqueued ${ids.length} jobs: ${ids.join(", ")}`);

  // Verify waiting list
  const waitingBefore = await client.redis.client.lRange("{q:emails}:waiting", 0, -1);
  assert(waitingBefore.length === 3, `3 jobs in waiting list (got ${waitingBefore.length})`);

  const started: string[] = [];
  const completed: string[] = [];
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<void>();

  const worker = new Worker<TestQueues>(
    "emails",
    async (job) => {
      // Simulate quick work
      await new Promise((r) => setTimeout(r, 50));
    },
    {
      connection: CONNECTION,
      concurrency: 2,
      pollInterval: 100,
      events: {
        onJobStart: (job) => {
          console.log(`    → onJobStart: ${job.id}`);
          started.push(job.id);
        },
        onJobComplete: (job) => {
          console.log(`    → onJobComplete: ${job.id}`);
          completed.push(job.id);
          if (completed.length === 3) onAllDone();
        },
      },
    },
  );

  await worker.start();
  await allDone;
  await worker.shutdown();

  assert(started.length === 3, `onJobStart fired 3 times (got ${started.length})`);
  assert(completed.length === 3, `onJobComplete fired 3 times (got ${completed.length})`);

  // Verify Redis state
  const waitingAfter = await client.redis.client.lRange("{q:emails}:waiting", 0, -1);
  assert(waitingAfter.length === 0, `Waiting list is empty (got ${waitingAfter.length})`);

  const activeAfter = await client.redis.client.sMembers("{q:emails}:active");
  assert(activeAfter.length === 0, `Active set is empty (got ${activeAfter.length})`);

  const completedSet = await client.redis.client.sMembers("{q:emails}:completed");
  assert(completedSet.length === 3, `Completed set has 3 entries (got ${completedSet.length})`);

  // Verify job data shows completed status
  for (const id of ids) {
    const raw = await client.redis.client.hGet("{q:emails}:jobs", id);
    if (raw) {
      const job = JSON.parse(raw);
      assert(job.status === "completed", `Job ${id} status is "completed" (got "${job.status}")`);
      assert(typeof job.finishedAt === "number", `Job ${id} has finishedAt timestamp`);
    }
  }

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 3: Failed jobs with onJobFail + retry verification
// ──────────────────────────────────────────────────────────
async function test3_failedJobsAndRetries() {
  console.log("\n🔬 Test 3: Failed jobs with onJobFail and retries");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const jobId = await client.enqueue("failing", { shouldFail: true }, { retries: 2 });
  console.log(`  Enqueued failing job: ${jobId} (retries: 2)`);

  const failEvents: { id: string; error: string }[] = [];
  let attempts = 0;
  const { promise: done, resolve: onDone } = Promise.withResolvers<void>();

  const worker = new Worker<TestQueues>(
    "failing",
    async (job) => {
      attempts++;
      console.log(`    → Attempt ${attempts} for ${job.id}`);
      if (attempts <= 3) {
        throw new Error(`Attempt ${attempts} failed`);
      }
    },
    {
      connection: CONNECTION,
      pollInterval: 100,
      events: {
        onJobFail: (job, error) => {
          console.log(`    → onJobFail: ${job.id} — "${error}"`);
          failEvents.push({ id: job.id, error });
          // After 3 fail events (attempts exhausted), we're done
          if (failEvents.length === 3) {
            setTimeout(() => onDone(), 100);
          }
        },
        onError: (ctx, err) => {
          console.log(`    → onError[${ctx}]: ${err}`);
        },
      },
    },
  );

  await worker.start();
  await done;
  await worker.shutdown();

  assert(attempts === 3, `Handler was called 3 times (got ${attempts})`);
  assert(failEvents.length === 3, `onJobFail fired 3 times (got ${failEvents.length})`);

  // Verify final state in Redis — job should be in failed set after exhausting retries
  const failedSet = await client.redis.client.sMembers("{q:failing}:failed");
  assert(failedSet.includes(jobId), `Job ${jobId} is in failed set`);

  const raw = await client.redis.client.hGet("{q:failing}:jobs", jobId);
  if (raw) {
    const job = JSON.parse(raw);
    assert(job.status === "failed", `Job status is "failed" (got "${job.status}")`);
    assert(job.failedReason === "Attempt 3 failed", `failedReason recorded (got "${job.failedReason}")`);
    assert(job.attempts === 3, `attempts count is 3 (got ${job.attempts})`);
  }

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 4: Shutdown timeout with structured result
// ──────────────────────────────────────────────────────────
async function test4_shutdownTimeout() {
  console.log("\n🔬 Test 4: Shutdown timeout returns structured result");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.enqueue("slow", { delay: 5000 });
  console.log("  Enqueued slow job (5s delay)");

  const errors: { context: string; error: unknown }[] = [];
  const { promise: jobStarted, resolve: onJobStarted } = Promise.withResolvers<void>();

  const worker = new Worker<TestQueues>(
    "slow",
    async (job) => {
      onJobStarted();
      await new Promise((r) => setTimeout(r, job.data.delay));
    },
    {
      connection: CONNECTION,
      pollInterval: 100,
      shutdownTimeout: 200, // 200ms timeout — job takes 5s
      events: {
        onJobStart: (job) => console.log(`    → onJobStart: ${job.id}`),
        onError: (ctx, err) => {
          console.log(`    → onError[${ctx}]: ${err}`);
          errors.push({ context: ctx, error: err });
        },
      },
    },
  );

  await worker.start();
  await jobStarted;
  console.log("  Job started processing, initiating shutdown with 200ms timeout...");

  const result: ShutdownResult = await worker.shutdown();
  console.log(`  Shutdown result: timedOut=${result.timedOut}, unfinishedJobs=${result.unfinishedJobs}`);

  assert(result.timedOut === true, "Shutdown timed out");
  assert(result.unfinishedJobs === 1, `1 unfinished job (got ${result.unfinishedJobs})`);
  assert(worker.state === "stopped", `State is "stopped" (got "${worker.state}")`);

  const timeoutErrors = errors.filter((e) => e.context === "shutdown-timeout");
  assert(timeoutErrors.length === 1, "shutdown-timeout error was emitted");

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 5: Restart after shutdown
// ──────────────────────────────────────────────────────────
async function test5_restart() {
  console.log("\n🔬 Test 5: Worker restart after shutdown");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const transitions: [WorkerState, WorkerState][] = [];
  const processed: string[] = [];

  const worker = new Worker<TestQueues>(
    "emails",
    async (job) => {
      processed.push(job.id);
    },
    {
      connection: CONNECTION,
      pollInterval: 100,
      events: {
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    },
  );

  // Run 1
  await client.enqueue("emails", { to: "run1@test.com", subject: "Run 1" });
  await worker.start();
  await new Promise((r) => setTimeout(r, 300));
  await worker.shutdown();
  console.log(`  Run 1: processed ${processed.length} job(s), state=${worker.state}`);
  assert(processed.length === 1, `Run 1 processed 1 job (got ${processed.length})`);
  assert(worker.state === "stopped", `State is "stopped" after first run`);

  // Run 2 — restart the same worker instance
  await client.enqueue("emails", { to: "run2@test.com", subject: "Run 2" });
  await worker.start();
  await new Promise((r) => setTimeout(r, 300));
  await worker.shutdown();
  console.log(`  Run 2: processed ${processed.length} total job(s), state=${worker.state}`);
  assert(processed.length === 2, `Total processed is 2 (got ${processed.length})`);
  assert(worker.state === "stopped", `State is "stopped" after second run`);

  // Verify full transition sequence
  const expected: [WorkerState, WorkerState][] = [
    ["idle", "starting"],
    ["starting", "running"],
    ["running", "stopping"],
    ["stopping", "stopped"],
    ["stopped", "starting"],
    ["starting", "running"],
    ["running", "stopping"],
    ["stopping", "stopped"],
  ];
  assert(
    JSON.stringify(transitions) === JSON.stringify(expected),
    `Full transition sequence matches (got ${transitions.length} transitions)`,
  );

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 6: onError fallback to console (no events provided)
// ──────────────────────────────────────────────────────────
async function test6_consoleDefaultFallback() {
  console.log("\n🔬 Test 6: Default console.error fallback (no onError handler)");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.enqueue("emails", { to: "test@test.com", subject: "Hello" });

  const processed: string[] = [];
  const { promise: done, resolve: onDone } = Promise.withResolvers<void>();

  // No events — errors should go to console.error
  const worker = new Worker<TestQueues>(
    "emails",
    async (job) => {
      processed.push(job.id);
      onDone();
    },
    {
      connection: CONNECTION,
      pollInterval: 100,
    },
  );

  await worker.start();
  await done;
  await new Promise((r) => setTimeout(r, 100));
  await worker.shutdown();

  assert(processed.length === 1, `Processed 1 job without events configured (got ${processed.length})`);
  assert(worker.state === "stopped", "Worker stopped cleanly");
  console.log("  (If there were errors, they would have appeared in console above)");

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 7: Concurrency with real Redis
// ──────────────────────────────────────────────────────────
async function test7_concurrency() {
  console.log("\n🔬 Test 7: Concurrency control with real Redis");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });

  // Enqueue 5 jobs
  for (let i = 0; i < 5; i++) {
    await client.enqueue("emails", { to: `user${i}@test.com`, subject: `Job ${i}` });
  }

  let concurrent = 0;
  let maxConcurrent = 0;
  let totalProcessed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<void>();

  const worker = new Worker<TestQueues>(
    "emails",
    async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 100));
      concurrent--;
      totalProcessed++;
      if (totalProcessed === 5) onAllDone();
    },
    {
      connection: CONNECTION,
      concurrency: 3,
      pollInterval: 100,
      events: {
        onJobStart: (job) => console.log(`    → start ${job.id} (concurrent: ${concurrent})`),
        onJobComplete: (job) => console.log(`    → done  ${job.id} (concurrent: ${concurrent})`),
      },
    },
  );

  await worker.start();
  await allDone;
  await worker.shutdown();

  console.log(`  Max concurrent: ${maxConcurrent}, Total processed: ${totalProcessed}`);
  assert(maxConcurrent <= 3, `Max concurrent ≤ 3 (got ${maxConcurrent})`);
  assert(totalProcessed === 5, `All 5 jobs processed (got ${totalProcessed})`);

  // Verify all completed in Redis
  const completedSet = await client.redis.client.sMembers("{q:emails}:completed");
  assert(completedSet.length === 5, `5 jobs in completed set (got ${completedSet.length})`);

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Run all tests
// ──────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════");
console.log("  Panqueue Integration Tests (real Redis:6399)");
console.log("═══════════════════════════════════════════════");

await test1_stateTransitions();
await test2_processWithEvents();
await test3_failedJobsAndRetries();
await test4_shutdownTimeout();
await test5_restart();
await test6_consoleDefaultFallback();
await test7_concurrency();

console.log("\n═══════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════\n");

if (failed > 0) Deno.exit(1);
