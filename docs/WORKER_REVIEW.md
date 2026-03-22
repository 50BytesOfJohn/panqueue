# Worker Implementation Review — Full Context

> This document captures the complete findings, code evidence, discussion, and proposed
> resolutions from the code review of panqueue's initial `@panqueue/worker` implementation.
> It is self-contained — no code access is required to evaluate the issues.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [P1-A: Hard Shutdown Breaks Drain Guarantee](#p1-a-hard-shutdown-breaks-drain-guarantee)
- [P1-B: Unhandled Rejections from Job Finalization](#p1-b-unhandled-rejections-from-job-finalization)
- [P1-C: Claim Lua Script Leaves Partial Redis State](#p1-c-claim-lua-script-leaves-partial-redis-state)
- [P2-A: Retry Backoff Accepted but Ignored](#p2-a-retry-backoff-accepted-but-ignored)
- [P2-B: start() Not Lifecycle-Safe](#p2-b-start-not-lifecycle-safe)
- [P3-A: Tests Are Happy-Path and Timer-Driven](#p3-a-tests-are-happy-path-and-timer-driven)
- [P3-B: Spec Drift on Queue Mode Naming](#p3-b-spec-drift-on-queue-mode-naming)
- [Proposed Fix Order](#proposed-fix-order)

---

## Architecture Overview

panqueue is a Deno-native, Redis-backed job queue library. The worker package consumes
jobs from Redis queues using the following components:

### Component Map

```
Worker (worker.ts)
├── RedisConnection (redis_connection.ts)     — primary connection for Lua script execution
├── RedisConnection (subscriber)              — dedicated pub/sub connection (duplicated from primary)
├── SimpleJobScheduler (scheduler/simple.ts)  — claims/completes/fails jobs via Lua scripts
│   └── BaseJobScheduler (scheduler/base.ts)  — shared complete() and fail() logic
├── Semaphore (semaphore.ts)                  — concurrency limiter (counting semaphore)
└── Lua Scripts
    ├── claim_simple.ts   — atomic RPOP from waiting → SADD to active → read job data
    ├── complete.ts       — SREM from active → SADD to completed → update job hash
    └── fail.ts           — SREM from active → retry (LPUSH to waiting) or move to failed
```

### Core Processing Loop

The worker runs a single claim loop that:

1. Acquires a semaphore permit (blocks if at concurrency limit)
2. Executes the claim Lua script to atomically pop a job from `waiting` and move it to `active`
3. If no job: releases the permit, waits for pub/sub notification or poll timeout, retries
4. If job claimed: dispatches `#processJob()` asynchronously (fire-and-forget), loops back

`#processJob()` runs the user's handler, then calls `complete()` or `fail()` via Lua scripts,
and releases the semaphore permit in a `.finally()` block.

### Shutdown Sequence

1. Sets `#stopping = true`, wakes the claim loop
2. Waits for the claim loop promise to resolve
3. Races `semaphore.drain()` against a `shutdownTimeout` timer
4. Unsubscribes from pub/sub, disconnects both Redis connections
5. Sets `#running = false`

### Spec Contract

The spec (SPEC.md) defines these relevant guarantees:

- **Atomicity**: "All state transitions are atomic via Redis Lua scripts. No partial states, no race conditions." (line 205)
- **Two-phase shutdown**: "Stop polling for new jobs, await in-flight promises, done." (line 256)
- **Drain semantics**: "Wait until all semaphore permits are returned. This implies all active handlers have finished." (lines 462-463)
- **v0.1 features**: "Configurable retry with exponential backoff" (line 268)
- **Concurrency modes**: Uses `global` / `keyed` vocabulary (lines 45, 495-509)

---

## P1-A: Hard Shutdown Breaks Drain Guarantee

### Severity: P1 (correctness — can strand active jobs in Redis)

### The Problem

After the shutdown timeout fires, the worker disconnects Redis while handlers may still be
running. Those handlers can no longer call `complete()` or `fail()`, leaving jobs stranded
in the `active` set with no mechanism to recover them (stalled job sweep is not yet implemented).

### Code Evidence

**`worker.ts` — shutdown method (lines 157-189):**

```ts
async shutdown(): Promise<void> {
  if (!this.#running) return;

  this.#stopping = true;
  this.#wakeClaimLoop();

  // Wait for claim loop to exit
  await this.#claimLoopPromise;

  // Drain in-flight jobs with timeout
  const drainPromise = this.#semaphore.drain();
  let shutdownTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((resolve) => {
    shutdownTimer = setTimeout(resolve, this.#shutdownTimeout);
  });
  await Promise.race([drainPromise, timeoutPromise]);
  clearTimeout(shutdownTimer!);

  // Unsubscribe and disconnect          <-- EXECUTES REGARDLESS OF WHICH PROMISE WON
  try {
    const channel = notifyKey(this.#queueId);
    await this.#subscriber.client.unsubscribe(channel);
  } catch {
    // Ignore errors during unsubscribe
  }

  await this.#subscriber.disconnect();   // <-- kills pub/sub connection
  await this.#redis.disconnect();        // <-- kills primary connection used by handlers

  this.#running = false;
  this.#claimLoopPromise = null;
}
```

**`semaphore.ts` — drain method (lines 55-63):**

```ts
drain(): Promise<void> {
  if (this.#current === 0 && this.#waiters.length === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    this.#drainWaiters.push(resolve);
  });
}
```

`drain()` resolves when `#current === 0` (all permits returned). Permits are returned in the
`.finally()` of `#processJob()`:

```ts
// worker.ts lines 220-223
this.#processJob(jobData).finally(() => {
  this.#semaphore.release();
});
```

### Why This Matters

Consider this sequence with `shutdownTimeout = 5000` and a handler that takes 8 seconds:

1. `shutdown()` called at T=0
2. Claim loop exits immediately (no new claims)
3. `Promise.race([drain, timeout])` starts — handler is still running
4. Timeout fires at T=5s — `Promise.race` resolves
5. `this.#redis.disconnect()` executes — primary Redis connection closed
6. Handler completes at T=8s, calls `this.#scheduler.complete(jobId)`
7. `complete()` tries to execute a Lua script on the now-disconnected client
8. Throws an error — but nobody is awaiting this (see P1-B)
9. Job remains in `active` set in Redis forever

The spec explicitly states: "Wait until all semaphore permits are returned. This implies all
active handlers have finished." The timeout path violates this by not waiting.

### Discussion

The semaphore is not the *wrong* abstraction here — after the claim loop exits, `drain()` is
a reasonable proxy for in-flight work because permits are only released in the processing
`.finally()`. However, the semaphore only tracks capacity (a count), not the actual promises.
An explicit `Set<Promise<void>>` for in-flight work gives:

- Direct access to promises for `Promise.allSettled()`
- Accurate count for warnings/metrics on timeout
- Error visibility (which jobs didn't finish, what errors occurred)

**On the timeout behavior**: silently disconnecting under live work should not be the default.
Two proposed approaches:

1. **Timeout = failed shutdown** (preferred): When timeout fires, `shutdown()` rejects or
   returns an error/warning with the count of still-running jobs. The caller decides whether
   to force-disconnect. This makes the failure visible.

2. **Two-mode shutdown**: `shutdown()` defaults to waiting indefinitely (or until drain
   completes). A separate `shutdown({ force: true })` or `forceShutdown()` method provides
   the "disconnect under live work" escape hatch as an explicit opt-in.

Both approaches avoid the current behavior where shutdown silently reports success while
knowingly stranding jobs.

### Proposed Fix

```ts
// New field on Worker
#inFlight = new Set<Promise<void>>();

// In the claim loop, track processing promises:
const processingPromise = this.#processJob(jobData).finally(() => {
  this.#inFlight.delete(processingPromise);
  this.#semaphore.release();
});
this.#inFlight.add(processingPromise);

// In shutdown:
async shutdown(): Promise<void> {
  if (!this.#running) return;

  this.#stopping = true;
  this.#wakeClaimLoop();
  await this.#claimLoopPromise;

  // Wait for in-flight jobs with timeout
  if (this.#inFlight.size > 0) {
    const drainPromise = Promise.allSettled([...this.#inFlight]);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(
          `Shutdown timeout: ${this.#inFlight.size} job(s) still running`
        )),
        this.#shutdownTimeout,
      );
    });

    try {
      await Promise.race([drainPromise, timeoutPromise]);
    } catch (err) {
      // Timeout fired — surface as a failed shutdown
      console.error("[panqueue]", err);
      // Still disconnect, but caller knows shutdown was not clean
      // Alternatively: throw err to let caller decide
    }
  }

  // Disconnect (only after drain or explicit timeout)
  try {
    await this.#subscriber.client.unsubscribe(notifyKey(this.#queueId));
  } catch { /* ignore */ }
  await this.#subscriber.disconnect();
  await this.#redis.disconnect();

  this.#running = false;
}
```

---

## P1-B: Unhandled Rejections from Job Finalization

### Severity: P1 (crash vector — unhandled promise rejection kills Deno process)

### The Problem

`#processJob()` is dispatched as fire-and-forget. If the Redis `complete()` or `fail()` call
throws (e.g., during Redis instability or shutdown), the resulting promise rejection has no
observer. In Deno (and Node.js with default settings), unhandled promise rejections terminate
the process.

### Code Evidence

**`worker.ts` — fire-and-forget dispatch (lines 220-223):**

```ts
// Fire-and-forget: process job, release semaphore when done
this.#processJob(jobData).finally(() => {
  this.#semaphore.release();
});
```

The `.finally()` callback observes the promise for semaphore release purposes, but does NOT
catch rejections. If `#processJob` rejects, `.finally()` runs (releasing the permit), but the
rejection propagates to an unobserved promise.

**`worker.ts` — #processJob (lines 227-235):**

```ts
async #processJob(jobData: JobData): Promise<void> {
  try {
    await this.#processor(jobData);          // user handler
    await this.#scheduler.complete(jobData.id);  // Redis Lua script
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await this.#scheduler.fail(jobData.id, message);  // Redis Lua script
  }
}
```

### Failure Chains

**Chain 1 — Handler succeeds, complete() fails:**

1. `this.#processor(jobData)` succeeds
2. `this.#scheduler.complete(jobData.id)` throws (Redis error)
3. Falls to `catch` block
4. `this.#scheduler.fail(jobData.id, message)` is called
5. Problem: the job **succeeded** but is now being marked as **failed**. This misclassifies
   the job's actual outcome.

**Chain 2 — Handler fails, fail() also fails:**

1. `this.#processor(jobData)` throws
2. Falls to `catch` block
3. `this.#scheduler.fail(jobData.id, message)` throws (Redis error)
4. Promise rejects with nobody awaiting it
5. Deno's default behavior: **process exits with unhandled rejection**

**Chain 3 — During shutdown (interacts with P1-A):**

1. Shutdown timeout fires, Redis disconnected
2. Running handler finishes, calls `complete()`
3. `complete()` throws (Redis disconnected)
4. Falls to `catch`, calls `fail()`
5. `fail()` also throws (Redis disconnected)
6. Unhandled rejection — process crash during what should be graceful shutdown

### Discussion

The fix needs to separate three distinct failure modes:

1. **Handler failure** → call `fail()` to record the error and potentially retry
2. **Handler success + complete() failure** → log the ack failure; do NOT call `fail()`.
   The work was done; only the acknowledgment was lost. The job will either be retried
   by a stalled sweep (once implemented) or needs manual intervention.
3. **fail() itself fails** → log and move on. The job stays in `active` and will need
   recovery via stalled sweep.

Important caveat: the stalled job sweep is **not yet implemented**, so comments saying
"stalled sweep will recover it" are aspirational. The log messages should be honest about
this — e.g., "Job {id} may require manual recovery."

### Proposed Fix

```ts
async #processJob(jobData: JobData): Promise<void> {
  // 1. Run the user's handler
  let handlerError: unknown = undefined;
  try {
    await this.#processor(jobData);
  } catch (err) {
    handlerError = err;
  }

  // 2. Finalize based on handler outcome
  if (handlerError === undefined) {
    // Handler succeeded — acknowledge completion
    try {
      await this.#scheduler.complete(jobData.id);
    } catch (ackErr) {
      // Work was done, but ack failed. Do NOT call fail().
      // Job stays in active — will need stalled sweep or manual recovery.
      console.error(
        `[panqueue] Job ${jobData.id} completed successfully but completion ack failed. ` +
        `Job remains in active set and may require manual recovery.`,
        ackErr,
      );
    }
  } else {
    // Handler failed — record failure
    const message = handlerError instanceof Error
      ? handlerError.message
      : String(handlerError);
    try {
      await this.#scheduler.fail(jobData.id, message);
    } catch (failErr) {
      // Could not record failure either. Job stays in active.
      console.error(
        `[panqueue] Job ${jobData.id} handler failed and failure recording also failed. ` +
        `Job remains in active set and may require manual recovery.`,
        failErr,
      );
    }
  }
}
```

This combined with the `#inFlight` Set from the P1-A fix ensures all processing promises are
observed:

```ts
// In claim loop: the promise is tracked and awaited during shutdown
const processingPromise = this.#processJob(jobData).finally(() => {
  this.#inFlight.delete(processingPromise);
  this.#semaphore.release();
});
this.#inFlight.add(processingPromise);
```

Because `#processJob` now handles all its own errors internally, it will never reject.
The `#inFlight` set provides a second layer of safety via `Promise.allSettled` during shutdown.

---

## P1-C: Claim Lua Script Leaves Partial Redis State

### Severity: P1 (data loss — job ID silently orphaned in Redis)

### The Problem

The claim Lua script removes a job ID from the `waiting` list and adds it to the `active` set
**before** verifying that the job's data exists in the jobs hash. If the job hash is missing,
the script returns `nil` without repairing the mutations. The job ID is now:

- Removed from `waiting` (will never be claimed again)
- Present in `active` (will never be completed or failed)
- Effectively lost

This directly violates the spec's guarantee: "All state transitions are atomic via Redis Lua
scripts. No partial states, no race conditions."

### Code Evidence

**`claim_simple.ts` — the Lua script (lines 17-39):**

```lua
local jobId = redis.call('RPOP', KEYS[1])         -- 1. Remove from waiting list
if not jobId then
  return nil
end

redis.call('SADD', KEYS[2], jobId)                 -- 2. Add to active set (BEFORE checking data)

local raw = redis.call('HGET', KEYS[3], jobId)     -- 3. Read job data from hash
if not raw then
  return nil                                        -- 4. BUG: job is now orphaned
end                                                 --    - gone from waiting (RPOP'd)
                                                    --    - stranded in active (SADD'd)
                                                    --    - no data to process

local job = cjson.decode(raw)
job['status'] = 'active'
job['processedAt'] = tonumber(ARGV[1])
job['attempts'] = (job['attempts'] or 0) + 1

local updated = cjson.encode(job)
redis.call('HSET', KEYS[3], jobId, updated)

return updated
```

**Redis key layout for context:**

```
{q:emails}:waiting   — LIST  — job IDs awaiting processing (FIFO via RPOP)
{q:emails}:active    — SET   — job IDs currently being processed
{q:emails}:jobs      — HASH  — jobId → JSON job data
```

### When Does This Happen?

The missing-job-data scenario could occur if:

- A bug elsewhere deletes the job hash but not the waiting list entry
- Manual Redis operations (e.g., HDEL on the jobs hash during debugging)
- A race condition in a future code path that cleans up job data

While unlikely in normal operation today, the script should be defensive — especially since
the spec promises atomicity. A "this shouldn't happen" condition in a Lua script should be
loud, not silent.

### Discussion

**Option A — Reorder operations (minimum fix):**

Move `SADD` after `HGET` so that if job data is missing, at least the ID isn't added to `active`:

```lua
local jobId = redis.call('RPOP', KEYS[1])
if not jobId then return nil end

local raw = redis.call('HGET', KEYS[3], jobId)
if not raw then
  -- Job data missing. ID is lost from waiting but not stranded in active.
  -- This is still data loss, but less severe than orphaning in active.
  return nil
end

redis.call('SADD', KEYS[2], jobId)
-- ... rest of script
```

Note: `RPOP` is destructive and cannot be undone within the script (there's no atomic
"peek and remove"). So the job ID is still lost from `waiting` if data is missing. But
it won't be stranded in `active`.

**Option B — Error reply (preferred, makes corruption visible):**

```lua
local jobId = redis.call('RPOP', KEYS[1])
if not jobId then return nil end

local raw = redis.call('HGET', KEYS[3], jobId)
if not raw then
  -- Do not SADD to active. Return an error so the worker knows something is wrong.
  return redis.error_reply('ERR job data missing for id: ' .. jobId)
end

redis.call('SADD', KEYS[2], jobId)
-- ... rest of script
```

This surfaces in the worker's claim `catch` block (worker.ts line 207), which already
logs the error and continues the loop:

```ts
try {
  jobData = await this.#scheduler.claim();
} catch (err) {
  this.#semaphore.release();
  console.error("[panqueue] Claim error:", err);
  await this.#waitForNotification();
  continue;
}
```

The error is visible, the job ID is lost from waiting (unavoidable with RPOP), but not
stranded in active.

**Option C — LINDEX + LREM instead of RPOP (most defensive):**

```lua
local jobId = redis.call('LINDEX', KEYS[1], -1)   -- peek without removing
if not jobId then return nil end

local raw = redis.call('HGET', KEYS[3], jobId)
if not raw then
  -- Data missing — remove the orphaned ID from waiting and try again or error
  redis.call('LREM', KEYS[1], -1, jobId)
  return redis.error_reply('ERR job data missing for id: ' .. jobId)
end

redis.call('LREM', KEYS[1], -1, jobId)            -- now safe to remove
redis.call('SADD', KEYS[2], jobId)
-- ... rest of script
```

This approach peeks first, validates, then removes. However, `LREM` is O(N) on the list
length, which adds cost compared to `RPOP` (O(1)). For typical queue sizes this is fine,
but it changes the performance profile.

### Recommended Approach

Option B (error reply + reordered SADD) strikes the best balance: minimal code change,
visible errors, no performance impact, and prevents the worst outcome (active set orphaning).

---

## P2-A: Retry Backoff Accepted but Ignored

### Severity: P2 (silent misconfiguration — users think backoff is active when it isn't)

### The Problem

The client API accepts `backoff` configuration when enqueuing jobs and persists it into the
job's Redis hash. The spec lists "Configurable retry with exponential backoff" as a v0.1
feature. But the worker's fail script always immediately re-queues retried jobs via `LPUSH`
— there is no delay, no scheduled retry, no sorted-set infrastructure for delayed execution.

### Code Evidence

**`queue_client.ts` — backoff accepted and stored (lines 100-108):**

```ts
const jobData: JobData<TQueues[K]> = {
  id: jobId,
  queueId,
  data,
  status: "waiting",
  attempts: 0,
  maxRetries: options?.retries ?? 0,
  backoff: options?.backoff,           // <-- stored in job data
  createdAt: Date.now(),
};
```

**`fail.ts` — retry via immediate LPUSH (lines 33-37):**

```lua
if attempts < maxRetries + 1 then
  job['status'] = 'waiting'
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('LPUSH', KEYS[3], ARGV[1])     -- <-- immediate re-queue, no delay
  redis.call('PUBLISH', KEYS[5], ARGV[1])
  return 'waiting'
```

**SPEC.md line 268:**

```
- Configurable retry with exponential backoff
```

### Impact

A user configures `backoff: { type: "exponential", delay: 1000 }` on their jobs, expecting
retry delays of 1s, 2s, 4s, etc. In reality, retries happen as fast as the worker can claim
them. For transient failures (e.g., rate-limited API), this creates a hot retry loop that:

- Wastes resources on retries that won't succeed
- Can trigger rate limiting escalation
- Burns through all retry attempts in seconds instead of minutes

### Discussion

Implementing proper delayed retry requires sorted-set scheduling infrastructure (a `delayed`
sorted set with timestamp scores, and a sweep/scheduler that promotes delayed jobs to
`waiting` when their time arrives). This is non-trivial and arguably v0.2 scope.

The safest short-term fix: **reject backoff configuration at enqueue time** until the worker
supports it. This is better than accepting config that silently does nothing.

### Proposed Fix

In the client, validate that backoff is not set (or throw if it is):

```ts
async enqueue<K extends keyof TQueues & string>(
  queueId: K,
  data: TQueues[K],
  options?: EnqueueOptions,
): Promise<string> {
  if (options?.backoff) {
    throw new Error(
      "[panqueue] Backoff configuration is not yet supported. " +
      "Retries will execute immediately. Remove the backoff option or wait for delayed retry support."
    );
  }
  // ... rest of enqueue
}
```

And update the spec to move "exponential backoff" from v0.1 to v0.2, or mark it as
not-yet-implemented.

---

## P2-B: start() Not Lifecycle-Safe

### Severity: P2 (resource leak on partial failure, race condition on concurrent calls)

### The Problem

`Worker.start()` has no protection against concurrent invocation and no rollback if
setup partially fails. This can leak Redis connections and cause undefined behavior.

### Code Evidence

**`worker.ts` — start method (lines 131-155):**

```ts
async start(): Promise<void> {
  if (this.#running) return;              // only guards against already-started

  this.#stopping = false;
  this.#semaphore = new Semaphore(this.#concurrency);

  this.#redis = new RedisConnection(this.#connectionOptions);
  await this.#redis.connect();            // <-- opens connection

  this.#subscriber = await this.#redis.duplicate();  // <-- opens second connection

  this.#scheduler = new SimpleJobScheduler(
    this.#queueId,
    this.#redis.client,
  );

  // Subscribe to job notifications
  const channel = notifyKey(this.#queueId);
  await this.#subscriber.client.subscribe(channel, () => {   // <-- can throw
    this.#wakeClaimLoop();
  });

  this.#running = true;
  this.#claimLoopPromise = this.#claimLoop();
}
```

**Compare with `RedisConnection.connect()` (lines 21-31) which already has the guard pattern:**

```ts
async connect(): Promise<void> {
  if (this.#client) return;
  if (this.#connectPromise) return this.#connectPromise;  // <-- dedup guard

  this.#connectPromise = this.#doConnect();
  try {
    await this.#connectPromise;
  } finally {
    this.#connectPromise = null;
  }
}
```

### Failure Scenarios

**Concurrent start():**

1. Caller A: `worker.start()` — begins connecting
2. Caller B: `worker.start()` — `#running` is still false, starts a second setup
3. Both proceed: two sets of Redis connections opened, fields overwritten, undefined state

**Partial failure:**

1. `this.#redis.connect()` succeeds — primary connection open
2. `this.#redis.duplicate()` throws (e.g., Redis at connection limit)
3. `start()` rejects — but `this.#redis` is connected and never cleaned up
4. Calling `start()` again creates a *new* RedisConnection, orphaning the first

### Proposed Fix

```ts
#startPromise: Promise<void> | null = null;

async start(): Promise<void> {
  if (this.#running) return;
  if (this.#startPromise) return this.#startPromise;

  this.#startPromise = this.#doStart();
  try {
    await this.#startPromise;
  } finally {
    this.#startPromise = null;
  }
}

async #doStart(): Promise<void> {
  this.#stopping = false;
  this.#semaphore = new Semaphore(this.#concurrency);

  this.#redis = new RedisConnection(this.#connectionOptions);

  try {
    await this.#redis.connect();
    this.#subscriber = await this.#redis.duplicate();

    this.#scheduler = new SimpleJobScheduler(
      this.#queueId,
      this.#redis.client,
    );

    const channel = notifyKey(this.#queueId);
    await this.#subscriber.client.subscribe(channel, () => {
      this.#wakeClaimLoop();
    });
  } catch (err) {
    // Rollback: disconnect any partially created connections
    try { await this.#subscriber?.disconnect(); } catch { /* ignore */ }
    try { await this.#redis.disconnect(); } catch { /* ignore */ }
    throw err;
  }

  this.#running = true;
  this.#claimLoopPromise = this.#claimLoop();
}
```

---

## P3-A: Tests Are Happy-Path and Timer-Driven

### Severity: P3 (test quality — highest-risk code paths are untested)

### The Problem

All worker tests use wall-clock `setTimeout` delays to wait for async operations, and
none of them test failure paths.

### Code Evidence

**Timer-driven waits throughout the test file:**

```ts
// worker_test.ts line 130 — wait for claim loop to process
await new Promise((resolve) => setTimeout(resolve, 100));

// worker_test.ts line 182 — same pattern
await new Promise((resolve) => setTimeout(resolve, 100));

// worker_test.ts line 234 — same
await new Promise((resolve) => setTimeout(resolve, 100));

// worker_test.ts line 293 — longer wait for concurrency test
await new Promise((resolve) => setTimeout(resolve, 300));

// worker_test.ts line 359 — pub/sub test
await new Promise((resolve) => setTimeout(resolve, 50));
// ...
await new Promise((resolve) => setTimeout(resolve, 100));
```

### Missing Test Coverage

The tests cover:

- Constructor variants (Tier 1 and Tier 2)
- Basic start/shutdown lifecycle
- Successful job processing
- Failed job processing
- Retry (fail returns "waiting")
- Concurrency limits
- Pub/sub wake-up
- `Symbol.asyncDispose`

The tests do **not** cover:

- **Shutdown timeout behavior**: What happens when handlers outlive the timeout?
- **Redis errors during complete()**: Does the worker crash? (P1-B)
- **Redis errors during fail()**: Double-failure path
- **Concurrent start() calls**: Race condition (P2-B)
- **Partial startup failure**: Connection leak (P2-B)
- **Shutdown during active processing**: Integration of drain + disconnect
- **Claim script returning error**: Error handling in the claim loop

### Recommendations

1. **Replace timers with event-driven coordination**: Use resolvers/spies that fire when
   specific events occur (job enters processing, job completes, etc.) instead of hoping
   100ms is enough.

2. **Add failure-path tests** for each P1/P2 fix:
   - Fake Redis client that throws on `eval()` to simulate Redis errors
   - Slow handler + short shutdown timeout to test timeout path
   - Concurrent `start()` calls to verify serialization
   - `start()` with a fake client that throws on `duplicate()` to test rollback

---

## P3-B: Spec Drift on Queue Mode Naming

### Severity: P3 (documentation/naming — cosmetic now, costly later)

### The Problem

The spec uses `global` / `keyed` as the public vocabulary for concurrency modes. The code
uses `simple` everywhere. These refer to the same concept but use different names.

### Code Evidence

**SPEC.md — uses `global` / `keyed` (lines 48-49):**

```ts
queues: {
  email: { mode: "global" },
  image: { mode: "keyed", keyConcurrency: 2 },
},
```

**SPEC.md — mode definitions (lines 495-509):**

> `global`: Only global worker concurrency is enforced. All jobs share the same execution pool.
>
> `keyed`: Concurrency is limited per concurrency key.

**`config/src/types.ts` — uses `simple` (line 6):**

```ts
export interface QueueConfig {
  mode: "simple";
}
```

**`client/src/queue_client.ts` — uses `simple` (line 25):**

```ts
export interface ClientQueueConfig {
  mode?: "simple" | "auto";
}
```

**Test files — all use `simple`:**

```ts
// config/src/define_config_test.ts
queues: { email: { mode: "simple" }, image: { mode: "simple" } }

// worker/src/worker_test.ts
queues: { emails: { mode: "simple" as const } }
```

### Impact

- `simple` is becoming the de facto public vocabulary through code and tests
- When `keyed` mode is implemented, there will be `simple` (code) vs `global` (spec)
- Downstream users/docs will need a breaking rename or a confusing alias

### Recommendation

Rename `simple` → `global` across the codebase now. The total surface area is small:

- `config/src/types.ts` — type definition
- `client/src/queue_client.ts` — type definition
- `config/src/define_config_test.ts` — 4 occurrences
- `worker/src/worker_test.ts` — 1 occurrence
- `scheduler/simple.ts` filename and class name (optional — internal, less urgent)

---

## Proposed Fix Order

Based on risk, dependencies, and diff size:

| Order | Issue | Rationale |
|-------|-------|-----------|
| 1 | P1-C: Claim script | Smallest diff, highest data-loss risk. No dependencies on other fixes. |
| 2 | P1-B: #processJob error handling | Crash vector. Standalone fix that also improves P1-A fix quality. |
| 3 | P1-A: Shutdown lifecycle | Depends on #processJob fix (in-flight Set replaces fire-and-forget). Largest behavioral change. |
| 4 | P2-B: start() guard | Standalone. Mirrors existing pattern in RedisConnection. |
| 5 | P2-A: Backoff rejection | Client-side change, independent of worker. |
| 6 | P3-B: Mode rename | Cosmetic. Low risk, do before more surface area lands. |
| 7 | P3-A: Test improvements | Best done after lifecycle fixes land (tests should cover the new code paths). |
