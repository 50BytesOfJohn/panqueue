/**
 * Integration test script — exercises the WorkerPool lifecycle features
 * against real Redis on port 6399.
 *
 * Run: deno run --allow-net demo/integration_test.ts
 */

import { QueueClient } from "@panqueue/client";
import { definePanqueueConfig } from "@panqueue/config";
import {
  defineWorker,
  type ShutdownResult,
  WorkerPool,
  type WorkerState,
} from "@panqueue/worker";
import { withInspector } from "./_inspect.ts";

const CONNECTION = { host: "localhost", port: 6399 };

type TestQueues = {
  emails: { to: string; subject: string };
  slow: { delay: number };
  failing: { shouldFail: boolean };
};

const pq = definePanqueueConfig<TestQueues>({
  redis: CONNECTION,
  queues: {
    emails: {},
    slow: {},
    failing: {},
  },
});

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
  await withInspector(CONNECTION, (r) => r.sendCommand(["FLUSHDB"]));
}

// ──────────────────────────────────────────────────────────
// Test 1: Per-runner state machine transitions — happy path
// ──────────────────────────────────────────────────────────
async function test1_stateTransitions() {
  console.log(
    "\n🔬 Test 1: Per-runner state transitions (idle→running→stopping→stopped)",
  );
  await flushRedis();

  const transitions: [WorkerState, WorkerState][] = [];

  const w = defineWorker(pq, "emails", async () => {}, {
    pollInterval: 100,
    events: {
      onStateChange: (from, to) => transitions.push([from, to]),
    },
  });

  const pool = new WorkerPool(pq, { workers: [w] });

  await pool.start();
  const result = await pool.shutdown();

  assert(!result.timedOut, "Clean shutdown did not time out");
  assert(result.unfinishedJobs === 0, "No unfinished jobs");

  assert(
    transitions.length === 3,
    `3 runner transitions fired (got ${transitions.length})`,
  );
  assert(
    transitions[0][0] === "idle" && transitions[0][1] === "running",
    "idle → running",
  );
  assert(
    transitions[1][0] === "running" && transitions[1][1] === "stopping",
    "running → stopping",
  );
  assert(
    transitions[2][0] === "stopping" && transitions[2][1] === "stopped",
    "stopping → stopped",
  );
}

// ──────────────────────────────────────────────────────────
// Test 2: Process jobs with event handlers
// ──────────────────────────────────────────────────────────
async function test2_processWithEvents() {
  console.log("\n🔬 Test 2: Process jobs with onJobStart/onJobComplete events");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(
      await client.enqueue("emails", {
        to: `user${i}@test.com`,
        subject: `Test ${i}`,
      }),
    );
  }
  console.log(`  Enqueued ${ids.length} jobs: ${ids.join(", ")}`);

  const waitingBefore = await withInspector(
    CONNECTION,
    (r) => r.lRange("{q:emails}:waiting", 0, -1),
  );
  assert(
    waitingBefore.length === 3,
    `3 jobs in waiting list (got ${waitingBefore.length})`,
  );

  const started: string[] = [];
  const completed: string[] = [];
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const w = defineWorker(pq, "emails", async () => {
    await new Promise((r) => setTimeout(r, 50));
  }, {
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
  });

  const pool = new WorkerPool(pq, { workers: [w] });
  await pool.start();
  await allDone;
  await pool.shutdown();

  assert(
    started.length === 3,
    `onJobStart fired 3 times (got ${started.length})`,
  );
  assert(
    completed.length === 3,
    `onJobComplete fired 3 times (got ${completed.length})`,
  );

  await withInspector(CONNECTION, async (r) => {
    const waitingAfter = await r.lRange("{q:emails}:waiting", 0, -1);
    assert(
      waitingAfter.length === 0,
      `Waiting list is empty (got ${waitingAfter.length})`,
    );

    const activeAfter = await r.zCard("{q:emails}:active");
    assert(
      activeAfter === 0,
      `Active set is empty (got ${activeAfter})`,
    );

    const completedSet = await r.zRange("{q:emails}:completed", 0, -1);
    assert(
      completedSet.length === 3,
      `Completed ZSET has 3 entries (got ${completedSet.length})`,
    );

    for (const id of ids) {
      const raw = await r.hGet("{q:emails}:jobs", id);
      if (raw) {
        const job = JSON.parse(raw);
        assert(
          job.status === "completed",
          `Job ${id} status is "completed" (got "${job.status}")`,
        );
        assert(
          typeof job.finishedAt === "number",
          `Job ${id} has finishedAt timestamp`,
        );
      }
    }
  });

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 3: Failed jobs with onJobFail + retry verification
// ──────────────────────────────────────────────────────────
async function test3_failedJobsAndRetries() {
  console.log("\n🔬 Test 3: Failed jobs with onJobRetry + onJobFail");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const jobId = await client.enqueue("failing", { shouldFail: true }, {
    retries: 2,
  });
  console.log(`  Enqueued failing job: ${jobId} (retries: 2)`);

  // With retries: 2, a job that always throws produces 2 onJobRetry events
  // (handler failures 1 and 2 fall back to waiting) followed by a single
  // terminal onJobFail (handler failure 3 exhausts retries).
  const retryEvents: { id: string; error: string }[] = [];
  const failEvents: { id: string; error: string }[] = [];
  let attempts = 0;
  const { promise: done, resolve: onDone } = Promise.withResolvers<void>();

  const w = defineWorker(pq, "failing", (job) => {
    attempts++;
    console.log(`    → Attempt ${attempts} for ${job.id}`);
    throw new Error(`Attempt ${attempts} failed`);
  }, {
    pollInterval: 100,
    events: {
      onJobRetry: (job, error) => {
        console.log(`    → onJobRetry: ${job.id} — "${error}"`);
        retryEvents.push({ id: job.id, error });
      },
      onJobFail: (job, error) => {
        console.log(`    → onJobFail: ${job.id} — "${error}"`);
        failEvents.push({ id: job.id, error });
        setTimeout(() => onDone(), 100);
      },
      onError: (ctx, err) => {
        console.log(`    → onError[${ctx}]: ${err}`);
      },
    },
  });

  const pool = new WorkerPool(pq, { workers: [w] });
  await pool.start();
  await done;
  await pool.shutdown();

  assert(attempts === 3, `Handler was called 3 times (got ${attempts})`);
  assert(
    retryEvents.length === 2,
    `onJobRetry fired 2 times (got ${retryEvents.length})`,
  );
  assert(
    failEvents.length === 1,
    `onJobFail fired exactly once (got ${failEvents.length})`,
  );

  await withInspector(CONNECTION, async (r) => {
    const failedSet = await r.zRange("{q:failing}:failed", 0, -1);
    assert(failedSet.includes(jobId), `Job ${jobId} is in failed ZSET`);

    const raw = await r.hGet("{q:failing}:jobs", jobId);
    if (raw) {
      const job = JSON.parse(raw);
      assert(
        job.status === "failed",
        `Job status is "failed" (got "${job.status}")`,
      );
      assert(
        job.failedReason === "Attempt 3 failed",
        `failedReason recorded (got "${job.failedReason}")`,
      );
      assert(
        job.failures === 3,
        `failures count is 3 (got ${job.failures})`,
      );
      assert(
        job.failureKind === "handler",
        `failureKind is "handler" (got "${job.failureKind}")`,
      );
    }
  });

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 4: Force shutdown requeues in-flight jobs
// ──────────────────────────────────────────────────────────
async function test4_shutdownTimeout() {
  console.log("\n🔬 Test 4: Force shutdown requeues in-flight jobs");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.enqueue("slow", { delay: 5000 });
  console.log("  Enqueued slow job (5s delay)");

  const { promise: jobStarted, resolve: onJobStarted } = Promise
    .withResolvers<void>();

  const w = defineWorker(pq, "slow", async (job) => {
    onJobStarted();
    await new Promise((r) => setTimeout(r, job.data.delay));
  }, {
    pollInterval: 100,
    events: {
      onJobStart: (job) => console.log(`    → onJobStart: ${job.id}`),
      onError: (ctx, err) => console.log(`    → onError[${ctx}]: ${err}`),
    },
  });

  const pool = new WorkerPool(pq, { workers: [w] });
  await pool.start();
  await jobStarted;
  console.log("  Job started processing, initiating force shutdown...");

  const result: ShutdownResult = await pool.shutdown();
  console.log(
    `  Shutdown result: mode=${result.mode}, unfinishedJobs=${result.unfinishedJobs}, requeued=${result.requeued}`,
  );

  assert(result.mode === "force", "Default shutdown is force");
  assert(
    result.unfinishedJobs === 1,
    `1 unfinished job (got ${result.unfinishedJobs})`,
  );
  assert(result.requeued === 1, `1 requeued job (got ${result.requeued})`);

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 5: Sequential pools — pools are single-shot
// ──────────────────────────────────────────────────────────
async function test5_sequentialPools() {
  console.log("\n🔬 Test 5: Pools are single-shot — fresh pool per run");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  const processed: string[] = [];

  const buildWorker = () =>
    defineWorker(pq, "emails", async (job) => {
      processed.push(job.id);
    }, { pollInterval: 100 });

  // Run 1
  await client.enqueue("emails", { to: "run1@test.com", subject: "Run 1" });
  const pool1 = new WorkerPool(pq, { workers: [buildWorker()] });
  await pool1.start();
  await new Promise((r) => setTimeout(r, 300));
  await pool1.shutdown();
  console.log(`  Run 1: processed ${processed.length} job(s)`);
  assert(
    processed.length === 1,
    `Run 1 processed 1 job (got ${processed.length})`,
  );

  // Reusing pool1 must reject
  let restartRejected = false;
  try {
    await pool1.start();
  } catch {
    restartRejected = true;
  }
  assert(restartRejected, "pool1.start() after shutdown rejects");

  // Run 2 — fresh pool
  await client.enqueue("emails", { to: "run2@test.com", subject: "Run 2" });
  const pool2 = new WorkerPool(pq, { workers: [buildWorker()] });
  await pool2.start();
  await new Promise((r) => setTimeout(r, 300));
  await pool2.shutdown();
  console.log(`  Run 2: processed ${processed.length} total job(s)`);
  assert(
    processed.length === 2,
    `Total processed is 2 (got ${processed.length})`,
  );

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 6: onError fallback to console (no events provided)
// ──────────────────────────────────────────────────────────
async function test6_consoleDefaultFallback() {
  console.log(
    "\n🔬 Test 6: Default console.error fallback (no onError handler)",
  );
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.enqueue("emails", { to: "test@test.com", subject: "Hello" });

  const processed: string[] = [];
  const { promise: done, resolve: onDone } = Promise.withResolvers<void>();

  const w = defineWorker(pq, "emails", async (job) => {
    processed.push(job.id);
    onDone();
  }, { pollInterval: 100 });

  const pool = new WorkerPool(pq, { workers: [w] });
  await pool.start();
  await done;
  await new Promise((r) => setTimeout(r, 100));
  await pool.shutdown();

  assert(
    processed.length === 1,
    `Processed 1 job without events configured (got ${processed.length})`,
  );
  console.log(
    "  (If there were errors, they would have appeared in console above)",
  );

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 7: Concurrency with real Redis
// ──────────────────────────────────────────────────────────
async function test7_concurrency() {
  console.log("\n🔬 Test 7: Concurrency control with real Redis");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });

  for (let i = 0; i < 5; i++) {
    await client.enqueue("emails", {
      to: `user${i}@test.com`,
      subject: `Job ${i}`,
    });
  }

  let concurrent = 0;
  let maxConcurrent = 0;
  let totalProcessed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const w = defineWorker(pq, "emails", async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 100));
    concurrent--;
    totalProcessed++;
    if (totalProcessed === 5) onAllDone();
  }, {
    concurrency: 3,
    pollInterval: 100,
    events: {
      onJobStart: (job) =>
        console.log(`    → start ${job.id} (concurrent: ${concurrent})`),
      onJobComplete: (job) =>
        console.log(`    → done  ${job.id} (concurrent: ${concurrent})`),
    },
  });

  const pool = new WorkerPool(pq, { workers: [w] });
  await pool.start();
  await allDone;
  await pool.shutdown();

  console.log(
    `  Max concurrent: ${maxConcurrent}, Total processed: ${totalProcessed}`,
  );
  assert(maxConcurrent <= 3, `Max concurrent ≤ 3 (got ${maxConcurrent})`);
  assert(totalProcessed === 5, `All 5 jobs processed (got ${totalProcessed})`);

  const completedSet = await withInspector(
    CONNECTION,
    (r) => r.zRange("{q:emails}:completed", 0, -1),
  );
  assert(
    completedSet.length === 5,
    `5 jobs in completed ZSET (got ${completedSet.length})`,
  );

  await client.disconnect();
}

// ──────────────────────────────────────────────────────────
// Test 8: Pool shares a single command + subscriber connection
// across multiple registered queues
// ──────────────────────────────────────────────────────────
async function test8_sharedConnections() {
  console.log("\n🔬 Test 8: Pool shares connections across queues");
  await flushRedis();

  const client = new QueueClient<TestQueues>({ connection: CONNECTION });
  await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });
  await client.enqueue("slow", { delay: 10 });

  const seen: string[] = [];
  const { promise: bothDone, resolve: onBothDone } = Promise.withResolvers<
    void
  >();

  const wEmails = defineWorker(pq, "emails", async (job) => {
    seen.push(`emails:${job.data.subject}`);
    if (seen.length === 2) onBothDone();
  }, { pollInterval: 100 });

  const wSlow = defineWorker(pq, "slow", async (job) => {
    await new Promise((r) => setTimeout(r, job.data.delay));
    seen.push(`slow:${job.data.delay}`);
    if (seen.length === 2) onBothDone();
  }, { pollInterval: 100 });

  const pool = new WorkerPool(pq, { workers: [wEmails, wSlow] });
  await pool.start();
  await bothDone;
  await pool.shutdown();

  assert(seen.length === 2, `Both queues processed (got ${seen.length})`);
  console.log(`  Processed: ${seen.join(", ")}`);

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
await test5_sequentialPools();
await test6_consoleDefaultFallback();
await test7_concurrency();
await test8_sharedConnections();

console.log("\n═══════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════\n");

if (failed > 0) Deno.exit(1);
