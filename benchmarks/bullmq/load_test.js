/**
 * BullMQ Load Test — mirrors demo/load_test.ts for direct comparison with Panqueue.
 *
 * Run: node load_test.js
 */

import { Queue, Worker, FlowProducer } from "bullmq";
import { createClient } from "redis";

const CONNECTION = { host: "localhost", port: 6399 };

// ── Helpers ──────────────────────────────────────────────

async function flushRedis() {
  const client = createClient({ socket: CONNECTION });
  await client.connect();
  await client.sendCommand(["FLUSHDB"]);
  await client.disconnect();
}

async function redisInfo() {
  const client = createClient({ socket: CONNECTION });
  await client.connect();
  const mem = await client.sendCommand(["INFO", "memory"]);
  const usedMatch = String(mem).match(/used_memory_human:(\S+)/);
  const result = { usedMemory: usedMatch?.[1] ?? "unknown" };
  await client.disconnect();
  return result;
}

async function redisQueueStats(queueName) {
  const queue = new Queue(queueName, { connection: CONNECTION });
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
  );
  await queue.close();
  return counts;
}

function fmt(n, unit) {
  return `${n.toLocaleString()} ${unit}`;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Wait for a worker to become idle after processing. */
function waitForProcessed(worker, count) {
  return new Promise((resolve) => {
    let processed = 0;
    worker.on("completed", () => {
      processed++;
      if (processed >= count) resolve();
    });
    worker.on("failed", () => {
      processed++;
      if (processed >= count) resolve();
    });
  });
}

// ── Scenario 1: Throughput — 1000 no-op jobs ────────────

async function scenario1_throughput() {
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log("  Scenario 1: Raw throughput — 1,000 no-op jobs");
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  await flushRedis();

  const COUNT = 1000;
  const CONCURRENCY = 50;
  const QUEUE_NAME = "fast";

  // Enqueue phase
  const queue = new Queue(QUEUE_NAME, { connection: CONNECTION });
  const enqueueStart = performance.now();
  const enqueuePromises = [];
  for (let i = 0; i < COUNT; i++) {
    enqueuePromises.push(queue.add("job", { index: i }));
  }
  await Promise.all(enqueuePromises);
  const enqueueMs = performance.now() - enqueueStart;

  console.log(
    `  Enqueue: ${fmt(COUNT, "jobs")} in ${fmtMs(enqueueMs)} (${fmt(Math.round(COUNT / (enqueueMs / 1000)), "jobs/s")})`,
  );

  // Process phase
  let processed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers();

  const processStart = performance.now();
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // no-op
    },
    {
      connection: CONNECTION,
      concurrency: CONCURRENCY,
    },
  );

  worker.on("completed", () => {
    processed++;
    if (processed === COUNT) onAllDone();
  });

  worker.on("error", (err) => console.error("    ERROR:", err.message));

  await allDone;
  const processMs = performance.now() - processStart;

  await worker.close();

  const stats = await redisQueueStats(QUEUE_NAME);
  const mem = await redisInfo();

  console.log(
    `  Process: ${fmt(COUNT, "jobs")} in ${fmtMs(processMs)} (${fmt(Math.round(COUNT / (processMs / 1000)), "jobs/s")})`,
  );
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(
    `  Redis: waiting=${stats.waiting} active=${stats.active} completed=${stats.completed} failed=${stats.failed}`,
  );
  console.log(`  Memory: ${mem.usedMemory}`);

  const ok =
    stats.completed === COUNT && stats.waiting === 0 && stats.active === 0;
  console.log(
    ok
      ? "  ✅ All jobs completed"
      : `  ❌ Expected ${COUNT} completed, got ${stats.completed}`,
  );

  await queue.close();
  return { enqueueMs, processMs, count: COUNT, concurrency: CONCURRENCY };
}

// ── Scenario 2: Throughput at different concurrency levels ──

async function scenario2_concurrencyScaling() {
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log(
    "  Scenario 2: Concurrency scaling — 500 jobs × [1, 5, 10, 25, 50, 100]",
  );
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  const COUNT = 500;
  const levels = [1, 5, 10, 25, 50, 100];
  const results = [];

  for (const concurrency of levels) {
    await flushRedis();

    const queue = new Queue("fast", { connection: CONNECTION });
    for (let i = 0; i < COUNT; i++) {
      await queue.add("job", { index: i });
    }

    let processed = 0;
    const { promise: allDone, resolve: onAllDone } = Promise.withResolvers();

    const start = performance.now();
    const worker = new Worker(
      "fast",
      async () => {
        // no-op
      },
      {
        connection: CONNECTION,
        concurrency,
      },
    );

    worker.on("completed", () => {
      processed++;
      if (processed === COUNT) onAllDone();
    });

    await allDone;
    const ms = performance.now() - start;
    await worker.close();
    await queue.close();

    const throughput = Math.round(COUNT / (ms / 1000));
    results.push({ concurrency, processMs: ms, throughput });
    console.log(
      `  concurrency=${String(concurrency).padStart(3)}  → ${fmtMs(ms).padStart(8)}  (${fmt(throughput, "jobs/s")})`,
    );
  }

  return results;
}

// ── Scenario 3: Mixed success/failure with retries ──────

async function scenario3_mixedFailures() {
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log(
    "  Scenario 3: Mixed success/failure — 500 jobs, 20% fail rate, 2 retries",
  );
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  await flushRedis();

  const COUNT = 500;
  const FAIL_RATE = 0.2;
  const RETRIES = 2;
  const CONCURRENCY = 25;
  const QUEUE_NAME = "mixed";

  const queue = new Queue(QUEUE_NAME, { connection: CONNECTION });
  let expectedFails = 0;
  for (let i = 0; i < COUNT; i++) {
    const willFail = Math.random() < FAIL_RATE;
    if (willFail) expectedFails++;
    await queue.add(
      "job",
      { index: i, failRate: willFail ? 1.0 : 0.0 },
      { attempts: RETRIES + 1, backoff: { type: "fixed", delay: 0 } },
    );
  }
  console.log(
    `  Enqueued ${COUNT} jobs (${expectedFails} will always fail, ${COUNT - expectedFails} will succeed)`,
  );

  let successCount = 0;
  let failCount = 0;
  let totalAttempts = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers();

  const start = performance.now();
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      totalAttempts++;
      if (job.data.failRate >= 1.0) {
        throw new Error(`Job ${job.data.index} failed`);
      }
    },
    {
      connection: CONNECTION,
      concurrency: CONCURRENCY,
    },
  );

  worker.on("completed", () => {
    successCount++;
    if (successCount + failCount === COUNT) onAllDone();
  });

  worker.on("failed", (job, err) => {
    // Only count terminal failures (attemptsMade === opts.attempts)
    if (job && job.attemptsMade >= RETRIES + 1) {
      failCount++;
      if (successCount + failCount === COUNT) onAllDone();
    }
  });

  await allDone;
  const ms = performance.now() - start;
  await worker.close();

  const stats = await redisQueueStats(QUEUE_NAME);

  console.log(`  Time: ${fmtMs(ms)}`);
  console.log(
    `  Completed: ${successCount}, Failed: ${failCount} (expected ~${expectedFails})`,
  );
  console.log(
    `  Total handler invocations: ${totalAttempts} (includes retries)`,
  );
  console.log(
    `  Expected retry invocations: ~${expectedFails * (RETRIES + 1)} for failing + ${COUNT - expectedFails} for passing = ~${expectedFails * (RETRIES + 1) + COUNT - expectedFails}`,
  );
  console.log(
    `  Redis: waiting=${stats.waiting} active=${stats.active}`,
  );

  const ok =
    successCount + failCount === COUNT &&
    stats.waiting === 0 &&
    stats.active === 0;
  console.log(ok ? "  ✅ All jobs accounted for" : "  ❌ Job count mismatch");

  await queue.close();
  return { ms, completed: successCount, failed: failCount, totalAttempts };
}

// ── Scenario 4: Simulated work — 1000 jobs with 1-5ms work ──

async function scenario4_simulatedWork() {
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log(
    "  Scenario 4: Simulated work — 1,000 jobs × 1-5ms work, concurrency 50",
  );
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  await flushRedis();

  const COUNT = 1000;
  const CONCURRENCY = 50;
  const QUEUE_NAME = "heavy";

  const queue = new Queue(QUEUE_NAME, { connection: CONNECTION });
  const enqueueStart = performance.now();
  for (let i = 0; i < COUNT; i++) {
    await queue.add("job", {
      index: i,
      workMs: 1 + Math.floor(Math.random() * 5),
    });
  }
  const enqueueMs = performance.now() - enqueueStart;
  console.log(`  Enqueue: ${fmtMs(enqueueMs)}`);

  let processed = 0;
  let totalWorkMs = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers();

  const processStart = performance.now();
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const workStart = performance.now();
      await new Promise((r) => setTimeout(r, job.data.workMs));
      totalWorkMs += performance.now() - workStart;
      processed++;
      if (processed === COUNT) onAllDone();
    },
    {
      connection: CONNECTION,
      concurrency: CONCURRENCY,
    },
  );

  worker.on("error", (err) => console.error("    ERROR:", err.message));

  await allDone;
  const processMs = performance.now() - processStart;
  await worker.close();

  const stats = await redisQueueStats(QUEUE_NAME);

  const theoreticalSerial = totalWorkMs;
  const speedup = theoreticalSerial / processMs;

  console.log(`  Process: ${fmtMs(processMs)}`);
  console.log(
    `  Throughput: ${fmt(Math.round(COUNT / (processMs / 1000)), "jobs/s")}`,
  );
  console.log(
    `  Total simulated work: ${fmtMs(totalWorkMs)} (serial equivalent)`,
  );
  console.log(
    `  Effective speedup: ${speedup.toFixed(1)}x from concurrency=${CONCURRENCY}`,
  );
  console.log(
    `  Overhead per job: ~${((processMs - totalWorkMs / CONCURRENCY) / COUNT).toFixed(2)}ms`,
  );
  console.log(
    `  Redis: completed=${stats.completed} failed=${stats.failed}`,
  );

  const ok = stats.completed === COUNT;
  console.log(ok ? "  ✅ All jobs completed" : `  ❌ Expected ${COUNT} completed`);

  await queue.close();
  return { processMs, totalWorkMs, speedup, count: COUNT };
}

// ── Scenario 5: Burst enqueue during processing ─────────

async function scenario5_burstDuringProcessing() {
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log(
    "  Scenario 5: Burst enqueue during processing — 500 pre + 500 live",
  );
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  await flushRedis();

  const PRE = 500;
  const LIVE = 500;
  const TOTAL = PRE + LIVE;
  const CONCURRENCY = 30;
  const QUEUE_NAME = "fast";

  const queue = new Queue(QUEUE_NAME, { connection: CONNECTION });

  // Pre-enqueue
  for (let i = 0; i < PRE; i++) {
    await queue.add("job", { index: i });
  }
  console.log(`  Pre-enqueued: ${PRE} jobs`);

  let processed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers();

  const start = performance.now();
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // no-op
    },
    {
      connection: CONNECTION,
      concurrency: CONCURRENCY,
    },
  );

  worker.on("completed", () => {
    processed++;
    if (processed === TOTAL) onAllDone();
  });

  worker.on("error", (err) => console.error("    ERROR:", err.message));

  // Burst-enqueue while worker is processing
  const burstStart = performance.now();
  for (let i = PRE; i < TOTAL; i++) {
    await queue.add("job", { index: i });
  }
  const burstMs = performance.now() - burstStart;
  console.log(
    `  Live burst: ${LIVE} jobs enqueued in ${fmtMs(burstMs)} while worker running`,
  );

  await allDone;
  const totalMs = performance.now() - start;
  await worker.close();

  const stats = await redisQueueStats(QUEUE_NAME);
  console.log(
    `  Total: ${fmt(TOTAL, "jobs")} in ${fmtMs(totalMs)} (${fmt(Math.round(TOTAL / (totalMs / 1000)), "jobs/s")})`,
  );
  console.log(
    `  Redis: completed=${stats.completed} waiting=${stats.waiting} active=${stats.active}`,
  );

  const ok = stats.completed === TOTAL;
  console.log(
    ok
      ? "  ✅ All jobs completed"
      : `  ❌ Expected ${TOTAL} completed`,
  );

  await queue.close();
}

// ── Run all scenarios ───────────────────────────────────

console.log("══════════════════════════════════════════════════════════");
console.log("  BullMQ Load Test — real Redis on port 6399");
console.log("══════════════════════════════════════════════════════════");

const s1 = await scenario1_throughput();
const s2 = await scenario2_concurrencyScaling();
const s3 = await scenario3_mixedFailures();
const s4 = await scenario4_simulatedWork();
await scenario5_burstDuringProcessing();

console.log("\n══════════════════════════════════════════════════════════");
console.log("  Summary");
console.log("══════════════════════════════════════════════════════════");
console.log(
  `  S1 throughput (no-op, c=${s1.concurrency}): ${fmt(Math.round(s1.count / (s1.processMs / 1000)), "jobs/s")}`,
);
console.log(
  `  S2 scaling: ${s2.map((r) => `c=${r.concurrency}→${r.throughput}`).join(", ")} jobs/s`,
);
console.log(
  `  S3 mixed: ${s3.completed} ok + ${s3.failed} failed in ${fmtMs(s3.ms)}, ${s3.totalAttempts} total attempts`,
);
console.log(
  `  S4 work sim: ${s4.speedup.toFixed(1)}x speedup, ~${((s4.processMs - s4.totalWorkMs / 50) / s4.count).toFixed(2)}ms overhead/job`,
);
console.log(
  "══════════════════════════════════════════════════════════\n",
);

process.exit(0);
