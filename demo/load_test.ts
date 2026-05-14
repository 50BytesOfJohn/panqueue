/**
 * Load test — processes 1000+ jobs through the worker with various scenarios.
 *
 * Run: deno run --allow-net --allow-hrtime demo/load_test.ts
 */

import { QueueClient } from "@panqueue/client";
import { definePanqueueConfig } from "@panqueue/config";
import { defineWorker, WorkerPool } from "@panqueue/worker";
import { withInspector } from "./_inspect.ts";

const CONNECTION = { host: "localhost", port: 6399 };

type LoadQueues = {
  fast: { index: number };
  mixed: { index: number; failRate: number };
  heavy: { index: number; workMs: number };
};

const pq = definePanqueueConfig<LoadQueues>({
  redis: CONNECTION,
  queues: {
    fast: { mode: "global" },
    mixed: { mode: "global" },
    heavy: { mode: "global" },
  },
});

// ── Helpers ──────────────────────────────────────────────

async function flushRedis() {
  await withInspector(CONNECTION, (r) => r.sendCommand(["FLUSHDB"]));
}

async function redisInfo() {
  return await withInspector(CONNECTION, async (r) => {
    const mem = await r.sendCommand(["INFO", "memory"]);
    const usedMatch = String(mem).match(/used_memory_human:(\S+)/);
    return { usedMemory: usedMatch?.[1] ?? "unknown" };
  });
}

async function redisQueueStats(queueId: string) {
  return await withInspector(CONNECTION, async (r) => {
    const waiting = await r.lLen(`{q:${queueId}}:waiting`);
    const active = await r.zCard(`{q:${queueId}}:active`);
    const completed = await r.zCard(`{q:${queueId}}:completed`);
    const failed = await r.zCard(`{q:${queueId}}:failed`);
    return { waiting, active, completed, failed };
  });
}

function fmt(n: number, unit: string) {
  return `${n.toLocaleString()} ${unit}`;
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Scenario 1: Throughput — 1000 no-op jobs ────────────

async function scenario1_throughput() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Scenario 1: Raw throughput — 1,000 no-op jobs");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await flushRedis();

  const COUNT = 1000;
  const CONCURRENCY = 50;

  // Enqueue phase
  const client = new QueueClient<LoadQueues>({ connection: CONNECTION });
  const enqueueStart = performance.now();
  const enqueuePromises: Promise<string>[] = [];
  for (let i = 0; i < COUNT; i++) {
    enqueuePromises.push(client.enqueue("fast", { index: i }));
  }
  await Promise.all(enqueuePromises);
  const enqueueMs = performance.now() - enqueueStart;

  console.log(
    `  Enqueue: ${fmt(COUNT, "jobs")} in ${fmtMs(enqueueMs)} (${
      fmt(Math.round(COUNT / (enqueueMs / 1000)), "jobs/s")
    })`,
  );

  // Process phase
  let processed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const processStart = performance.now();
  const w = defineWorker(pq, "fast", async () => {
    // no-op — measuring pure claim/complete overhead
    processed++;
    if (processed === COUNT) onAllDone();
  }, {
    concurrency: CONCURRENCY,
    pollInterval: 50,
    events: {
      onError: (ctx, err) => console.error(`    ERROR [${ctx}]:`, err),
    },
  });
  const pool = new WorkerPool(pq, { workers: [w] });

  await pool.start();
  await allDone;
  const processMs = performance.now() - processStart;
  const result = await pool.shutdown();

  const stats = await redisQueueStats("fast");
  const mem = await redisInfo();

  console.log(
    `  Process: ${fmt(COUNT, "jobs")} in ${fmtMs(processMs)} (${
      fmt(Math.round(COUNT / (processMs / 1000)), "jobs/s")
    })`,
  );
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(
    `  Shutdown: timedOut=${result.timedOut}, unfinished=${result.unfinishedJobs}`,
  );
  console.log(
    `  Redis: waiting=${stats.waiting} active=${stats.active} completed=${stats.completed} failed=${stats.failed}`,
  );
  console.log(`  Memory: ${mem.usedMemory}`);

  const ok = stats.completed === COUNT && stats.waiting === 0 &&
    stats.active === 0;
  console.log(
    ok
      ? "  ✅ All jobs completed"
      : `  ❌ Expected ${COUNT} completed, got ${stats.completed}`,
  );

  await client.disconnect();
  return { enqueueMs, processMs, count: COUNT, concurrency: CONCURRENCY };
}

// ── Scenario 2: Throughput at different concurrency levels ──

async function scenario2_concurrencyScaling() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Scenario 2: Concurrency scaling — 500 jobs × [1, 5, 10, 25, 50, 100]",
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const COUNT = 500;
  const levels = [1, 5, 10, 25, 50, 100];
  const results: {
    concurrency: number;
    processMs: number;
    throughput: number;
  }[] = [];

  for (const concurrency of levels) {
    await flushRedis();

    const client = new QueueClient<LoadQueues>({ connection: CONNECTION });
    for (let i = 0; i < COUNT; i++) {
      await client.enqueue("fast", { index: i });
    }

    let processed = 0;
    const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
      void
    >();

    const start = performance.now();
    const w = defineWorker(pq, "fast", async () => {
      processed++;
      if (processed === COUNT) onAllDone();
    }, {
      concurrency,
      pollInterval: 50,
      events: {
        onError: (ctx, err) => console.error(`    ERROR [${ctx}]:`, err),
      },
    });
    const pool = new WorkerPool(pq, { workers: [w] });

    await pool.start();
    await allDone;
    const ms = performance.now() - start;
    await pool.shutdown();
    await client.disconnect();

    const throughput = Math.round(COUNT / (ms / 1000));
    results.push({ concurrency, processMs: ms, throughput });
    console.log(
      `  concurrency=${String(concurrency).padStart(3)}  → ${
        fmtMs(ms).padStart(8)
      }  (${fmt(throughput, "jobs/s")})`,
    );
  }

  return results;
}

// ── Scenario 3: Mixed success/failure with retries ──────

async function scenario3_mixedFailures() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Scenario 3: Mixed success/failure — 500 jobs, 20% fail rate, 2 retries",
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await flushRedis();

  const COUNT = 500;
  const FAIL_RATE = 0.2;
  const RETRIES = 2;
  const CONCURRENCY = 25;

  const client = new QueueClient<LoadQueues>({ connection: CONNECTION });
  let expectedFails = 0;
  for (let i = 0; i < COUNT; i++) {
    const willFail = Math.random() < FAIL_RATE;
    if (willFail) expectedFails++;
    await client.enqueue(
      "mixed",
      { index: i, failRate: willFail ? 1.0 : 0.0 },
      { retries: RETRIES },
    );
  }
  console.log(
    `  Enqueued ${COUNT} jobs (${expectedFails} will always fail, ${
      COUNT - expectedFails
    } will succeed)`,
  );

  let successCount = 0;
  let failCount = 0;
  let totalAttempts = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const start = performance.now();
  const w = defineWorker(pq, "mixed", async (job) => {
    totalAttempts++;
    if (job.data.failRate >= 1.0) {
      throw new Error(`Job ${job.data.index} failed`);
    }
  }, {
    concurrency: CONCURRENCY,
    pollInterval: 50,
    events: {
      onJobComplete: () => {
        successCount++;
        if (successCount + failCount === COUNT) onAllDone();
      },
      onJobFail: (_job, _err) => {
        // Terminal failures are counted via Redis below.
      },
      onError: (ctx, err) => {
        if (!ctx.startsWith("fail:") && !ctx.startsWith("complete:")) {
          console.error(`    ERROR [${ctx}]:`, err);
        }
      },
    },
  });
  const pool = new WorkerPool(pq, { workers: [w] });

  await pool.start();

  // Poll for completion since counting terminal failures is tricky via events
  const pollDone = async () => {
    while (true) {
      const stats = await redisQueueStats("mixed");
      if (stats.waiting === 0 && stats.active === 0) {
        return stats;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const stats = await pollDone();
  const ms = performance.now() - start;
  await pool.shutdown();

  failCount = stats.failed;
  successCount = stats.completed;

  console.log(`  Time: ${fmtMs(ms)}`);
  console.log(
    `  Completed: ${stats.completed}, Failed: ${stats.failed} (expected ~${expectedFails})`,
  );
  console.log(
    `  Total handler invocations: ${totalAttempts} (includes retries)`,
  );
  console.log(
    `  Expected retry invocations: ~${
      expectedFails * (RETRIES + 1)
    } for failing + ${COUNT - expectedFails} for passing = ~${
      expectedFails * (RETRIES + 1) + COUNT - expectedFails
    }`,
  );
  console.log(`  Redis: waiting=${stats.waiting} active=${stats.active}`);

  const ok = stats.completed + stats.failed === COUNT && stats.waiting === 0 &&
    stats.active === 0;
  console.log(ok ? "  ✅ All jobs accounted for" : "  ❌ Job count mismatch");

  await client.disconnect();
  return {
    ms,
    completed: stats.completed,
    failed: stats.failed,
    totalAttempts,
  };
}

// ── Scenario 4: Simulated work — 1000 jobs with 1-5ms work ──

async function scenario4_simulatedWork() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Scenario 4: Simulated work — 1,000 jobs × 1-5ms work, concurrency 50",
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await flushRedis();

  const COUNT = 1000;
  const CONCURRENCY = 50;

  const client = new QueueClient<LoadQueues>({ connection: CONNECTION });
  const enqueueStart = performance.now();
  for (let i = 0; i < COUNT; i++) {
    await client.enqueue("heavy", {
      index: i,
      workMs: 1 + Math.floor(Math.random() * 5),
    });
  }
  const enqueueMs = performance.now() - enqueueStart;
  console.log(`  Enqueue: ${fmtMs(enqueueMs)}`);

  let processed = 0;
  let totalWorkMs = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const processStart = performance.now();
  const w = defineWorker(pq, "heavy", async (job) => {
    const workStart = performance.now();
    // Simulate CPU-ish work with a short sleep
    await new Promise((r) => setTimeout(r, job.data.workMs));
    totalWorkMs += performance.now() - workStart;
    processed++;
    if (processed === COUNT) onAllDone();
  }, {
    concurrency: CONCURRENCY,
    pollInterval: 50,
    events: {
      onError: (ctx, err) => console.error(`    ERROR [${ctx}]:`, err),
    },
  });
  const pool = new WorkerPool(pq, { workers: [w] });

  await pool.start();
  await allDone;
  const processMs = performance.now() - processStart;
  const result = await pool.shutdown();

  const stats = await redisQueueStats("heavy");

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
    `  Effective speedup: ${
      speedup.toFixed(1)
    }x from concurrency=${CONCURRENCY}`,
  );
  console.log(
    `  Overhead per job: ~${
      ((processMs - totalWorkMs / CONCURRENCY) / COUNT).toFixed(2)
    }ms`,
  );
  console.log(`  Shutdown: timedOut=${result.timedOut}`);
  console.log(`  Redis: completed=${stats.completed} failed=${stats.failed}`);

  const ok = stats.completed === COUNT;
  console.log(
    ok ? "  ✅ All jobs completed" : `  ❌ Expected ${COUNT} completed`,
  );

  await client.disconnect();
  return { processMs, totalWorkMs, speedup, count: COUNT };
}

// ── Scenario 5: Burst enqueue during processing ─────────

async function scenario5_burstDuringProcessing() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Scenario 5: Burst enqueue during processing — 500 pre + 500 live",
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await flushRedis();

  const PRE = 500;
  const LIVE = 500;
  const TOTAL = PRE + LIVE;
  const CONCURRENCY = 30;

  const client = new QueueClient<LoadQueues>({ connection: CONNECTION });

  // Pre-enqueue
  for (let i = 0; i < PRE; i++) {
    await client.enqueue("fast", { index: i });
  }
  console.log(`  Pre-enqueued: ${PRE} jobs`);

  let processed = 0;
  const { promise: allDone, resolve: onAllDone } = Promise.withResolvers<
    void
  >();

  const start = performance.now();
  const w = defineWorker(pq, "fast", async () => {
    processed++;
    if (processed === TOTAL) onAllDone();
  }, {
    concurrency: CONCURRENCY,
    pollInterval: 50,
    events: {
      onError: (ctx, err) => console.error(`    ERROR [${ctx}]:`, err),
    },
  });
  const pool = new WorkerPool(pq, { workers: [w] });

  await pool.start();

  // Burst-enqueue while worker is processing
  const burstStart = performance.now();
  for (let i = PRE; i < TOTAL; i++) {
    await client.enqueue("fast", { index: i });
  }
  const burstMs = performance.now() - burstStart;
  console.log(
    `  Live burst: ${LIVE} jobs enqueued in ${
      fmtMs(burstMs)
    } while worker running`,
  );

  await allDone;
  const totalMs = performance.now() - start;
  await pool.shutdown();

  const stats = await redisQueueStats("fast");
  console.log(
    `  Total: ${fmt(TOTAL, "jobs")} in ${fmtMs(totalMs)} (${
      fmt(Math.round(TOTAL / (totalMs / 1000)), "jobs/s")
    })`,
  );
  console.log(
    `  Redis: completed=${stats.completed} waiting=${stats.waiting} active=${stats.active}`,
  );

  const ok = stats.completed === TOTAL;
  console.log(
    ok ? "  ✅ All jobs completed" : `  ❌ Expected ${TOTAL} completed`,
  );

  await client.disconnect();
}

// ── Run all scenarios ───────────────────────────────────

console.log("══════════════════════════════════════════════════════════");
console.log("  Panqueue Load Test — real Redis on port 6399");
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
  `  S1 throughput (no-op, c=${s1.concurrency}): ${
    fmt(Math.round(s1.count / (s1.processMs / 1000)), "jobs/s")
  }`,
);
console.log(
  `  S2 scaling: ${
    s2.map((r) => `c=${r.concurrency}→${r.throughput}`).join(", ")
  } jobs/s`,
);
console.log(
  `  S3 mixed: ${s3.completed} ok + ${s3.failed} failed in ${
    fmtMs(s3.ms)
  }, ${s3.totalAttempts} total attempts`,
);
console.log(
  `  S4 work sim: ${s4.speedup.toFixed(1)}x speedup, ~${
    ((s4.processMs - s4.totalWorkMs / 50) / s4.count).toFixed(2)
  }ms overhead/job`,
);
console.log("══════════════════════════════════════════════════════════\n");
