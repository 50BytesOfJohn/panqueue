# panqueue — Library Specification

> BullMQ-inspired job queue library for Deno. Redis-backed, self-hosted, no cloud dependencies.

## Scope

- **Runtime:** Deno only (stable APIs, no Deploy/KV/cloud-specific features)
- **Storage:** Redis only (adapter interface extracted for future extensibility)
- **Deployment:** Docker + any Redis instance — Railway, Fly, VPS, local dev
- **Dependencies:** One Redis driver, zero platform APIs

## Core Principles

1. **Redis is the single source of truth.** All job state, scheduling, metadata, and results live in Redis. No secondary stores.
2. **No cloud coupling.** The library assumes nothing about hosting. A Deno Docker container and a Redis URL is the entire infrastructure contract.
3. **Adapter interface extracted, not abstracted prematurely.** Build the Redis implementation first, then derive the storage interface from real requirements. Don't design a generic interface upfront.
4. **Deno-native DX.** TypeScript-first, no build step, published to JSR, leverages Deno-specific features where they provide real value.

## API Shape (Current Direction)

- **Package split:** `@panqueue/client` (producers + types) and `@panqueue/worker` (workers + executors).
- **Typed client:** `QueueClient<QueueMap>` is the primary producer API; queue IDs are strongly typed via the app registry.
- **Queue-scoped defaults:** `mq.queue(queueId, defaults?)` returns a lightweight queue handle for per-queue defaults with per-job overrides on `.add()`.
- **Worker model:** `Worker` remains the low-level primitive; `WorkerPool` coordinates multiple workers and shared shutdown behavior.
- **Queue boundary:** One worker handles one queue. `queueId` should represent a workload class (to avoid head-of-line blocking).
- **v0.1 limits:** No dynamic queue-name escape hatch and no runtime schema validation yet (JSON-serializable payload validation on enqueue only).

## Job State Machine

```
waiting → delayed → active → completed
                  ↘         ↗
                    failed (→ retry → waiting | DLQ)
```

All state transitions are atomic via Redis Lua scripts. No partial states, no race conditions.

## Executor Model

Three tiers of job execution, user-selectable per queue or per job type:

| Executor       | Isolation                       | Use Case                                                                            |
| -------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| **Inline**     | None (same process)             | Trusted, lightweight jobs. Fastest. Default.                                        |
| **Web Worker** | V8 isolate + Deno permissions   | Per-job-type permission scoping (network, fs, env). Key differentiator over BullMQ. |
| **Subprocess** | Full process via `Deno.Command` | Maximum isolation. Untrusted or native-dependent workloads.                         |

### Deno Permission Scoping (Web Worker executor)

Workers can be spawned with granular, per-job-type permissions. This is a Deno-exclusive feature and a primary differentiator.

Example intent: an image processing job gets write access to `/tmp` and network access to a single S3 endpoint, nothing else.

## Redis Requirements

- v0.1 accepts a Redis URL/config and manages the client internally (BYO client can be added later if real demand emerges).
- No assumptions about Redis topology — single instance, Sentinel, and Cluster are the user's configuration concern.
- Lua scripts handle all atomic operations (job claiming, state transitions, retry scheduling, stalled job detection).
- Scheduled/repeatable jobs use Redis sorted sets with timestamp scoring, not runtime-level cron.

## Technical Constraints

### Redis Key Design (Cluster Compatibility)

All keys for a given queue must share a hash slot to avoid `CROSSSLOT` errors in Redis Cluster. This is enforced from day one via Redis Hash Tags — all keys for a queue are prefixed with a bracketed identifier (e.g., `{q:myQueue}:waiting`, `{q:myQueue}:active`, `{q:myQueue}:jobs`). This ensures atomic Lua scripts operate on co-located keys regardless of Redis topology.

### Job Payload Serialization

All job payloads must be strictly JSON-serializable (primitives, plain objects, arrays). No class instances, functions, Dates, or other non-serializable types. This is a hard constraint driven by Web Worker structured clone boundaries and Redis storage. Enforced at the type level and validated at runtime on `queue.add()`.

### Stalled Job Sweep Atomicity

The stalled job detection sweep runs periodically on each consumer node. To prevent race conditions where multiple nodes attempt to requeue the same stalled job, the sweep must be a single atomic Lua script that verifies lock expiry and moves the job in one operation. Concurrent sweeps by different nodes must be harmless — each check-and-move either succeeds or no-ops.

### Graceful Shutdown Across Executors

Shutdown behavior varies by executor tier and must be explicitly handled:

- **Inline:** Stop polling for new jobs, await in-flight promises, done.
- **Web Worker:** Send `postMessage({ type: "shutdown" })`, await acknowledgment, hard-kill after configurable timeout.
- **Subprocess:** Send shutdown signal via stdin IPC, await exit, `SIGTERM` → `SIGKILL` after configurable timeout.

All executors must implement a two-phase shutdown: cooperative signal followed by forced termination. The hard timeout is non-negotiable — external code cannot be trusted to exit cleanly.

## Feature Scope

### v0.1 — Core Lifecycle

- Job add / claim / complete / fail
- Atomic state transitions (Lua)
- Configurable retry with exponential backoff
- Stalled job detection (periodic sweep of active jobs past lock timeout)
- Graceful shutdown (stop claiming, drain in-flight, release locks)
- Pub/sub worker wake-up (near-zero latency job pickup with polling fallback)
- Inline executor only

### v0.2 — Scheduling & Workers

- Delayed jobs
- Repeatable/cron jobs (Redis-backed scheduler)
- Web Worker executor with Deno permission scoping
- Subprocess executor
- Job progress reporting

### v0.3 — Advanced

- Priorities
- Dead letter queues
- Rate limiting
- Event streaming (Redis Streams)
- Job flows/dependencies

### Future (non-committed)

- Storage adapter interface extraction + alternative backends
- Dashboard (separate package)
- Cross-runtime support

## Non-Goals

- Deno Deploy compatibility
- Deno KV integration
- Built-in HTTP API or dashboard (separate concern)
- Cross-runtime support in v1
- Managing Redis infrastructure

## Positioning

The Deno ecosystem currently has no production-grade job queue. Existing options are either Node-locked (BullMQ), runtime-specific toys (kvmq), or too early-stage (remq). panqueue targets the gap: a focused, reliable, Redis-backed queue with clean Deno-native DX and a unique sandboxing model via Deno's permission system.

## v0.1 Inline Executor Concurrency (Normative)

### Summary

In v0.1, the inline executor runs handlers in the same process as the worker. Concurrency is enforced by a single claim loop plus a semaphore.

- At most `N` handlers run simultaneously (`concurrency = N`)
- Jobs are only claimed when execution capacity is available
- No local prefetch buffer of claimed jobs
- Pub/sub wake-up with polling fallback for low idle latency
- Two-phase shutdown: stop claiming, then drain in-flight work

This model is intentionally conservative and correctness-first for the initial release.

### Goals

- Enforce a strict upper bound on simultaneous job handlers
- Avoid pre-claiming jobs that cannot start immediately
- Minimize Redis polling pressure while idle
- Keep lock TTL semantics aligned with real execution time
- Support reliable two-phase shutdown

### Core Model

#### Semaphore (Capacity Control)

A semaphore of size `concurrency` represents available execution slots.

- Acquire a slot before attempting a claim
- Release the slot when the handler finishes (success or failure)
- If no slot is available, the claim loop waits

This guarantees the number of executing handlers never exceeds the configured limit.

#### Single Claim Loop

The worker runs one continuous claim coordinator (not one loop per slot).

Claim loop behavior:

1. Wait for an available semaphore slot.
2. Attempt an atomic job claim in Redis.
3. If no job exists:
   - Release the slot
   - Wait for queue notification or fallback poll interval
   - Retry
4. If a job is claimed, dispatch the handler asynchronously and continue the loop.

The claim loop coordinates capacity and dispatch. It does not execute handler code directly.

### Rationale for Single Loop + Semaphore

Spawning `N` independent claim loops is possible, but it increases Redis polling and makes future scheduling features harder to reason about.

The single-loop design provides:

- Predictable Redis access patterns
- Lower risk of synchronized empty-queue hammering
- Easier instrumentation
- Cleaner shutdown semantics
- Better extensibility for pause/resume, rate limiting, and future executors

### No Prefetching (v0.1 Constraint)

In v0.1, a job is only claimed when it can start immediately. Claimed jobs are not buffered locally.

Why:

- Claiming moves a job to `active` and starts the lock TTL lifecycle
- Prefetching creates "active but idle" jobs
- Prefetching increases false stalled-job risk
- Prefetching complicates shutdown and lock renewal behavior

Operational meaning: if a job is `active`, it should be actively executing.

### Locks and Execution

When a job is claimed:

- It moves `waiting -> active`
- A lock with TTL is set

During execution:

- Lock renewal may run (if enabled)
- Renewal continues until completion or failure

When execution ends:

- Completion/failure Lua script finalizes state
- Lock renewal stops
- Semaphore slot is released

Because claims happen only when capacity exists, lock TTL tracks real work time closely.

### Idle Behavior

If a claim attempt finds no job:

- Release the semaphore slot
- Wait for a pub/sub notification on `{q:<queueId>}:notify`
- Also rely on a fallback poll interval (for missed notifications)

Pub/sub is fire-and-forget, so the polling fallback preserves liveness during reconnects or transient network issues.

### Shutdown Semantics

The model supports clean two-phase shutdown.

#### Phase 1: Stop Claiming

- Set `stopping = true`
- Exit the claim loop
- Claim no new jobs

#### Phase 2: Drain In-Flight Jobs

- Wait until all semaphore permits are returned
- This implies all active handlers have finished

Because there is no prefetching, the semaphore count accurately reflects in-flight execution.

### v0.1 Guarantees

- Strict concurrency bound
- No active-but-idle jobs
- Reduced false stalled detection risk
- Clean shutdown behavior
- Simple mental model: concurrency equals simultaneous handler executions

### Intentional v0.1 Limitations

- No prefetching
- No adaptive scheduling
- No dynamic concurrency scaling

These are explicit tradeoffs in favor of correctness and simplicity.

## Planned Keyed Concurrency Mode (Future Spec)

This section defines the Redis layout and scheduling logic for keyed concurrency mode (`keyed`). It is a planned mode, not part of the v0.1 core lifecycle.

### Overview

Keyed concurrency limits concurrently processed jobs per concurrency key (for example `userId`, `tenantId`, or `projectId`) in addition to global worker concurrency.

This mode uses a different Redis structure than `global` mode and must be explicitly enabled per queue. Workers and clients must operate using the same mode for a queue.

### Concurrency Modes

#### `global`

Only global worker concurrency is enforced. All jobs share the same execution pool. No per-key concurrency control.

> At most **N jobs total** can run concurrently across the queue.

#### `keyed`

Concurrency is limited per concurrency key. Each job includes a key and each key can run up to a fixed number of concurrent jobs.

> At most **M jobs per key** can run concurrently.

#### `dynamic` (future)

Extends keyed concurrency by allowing limits to vary per key (with a queue-level default).

> Concurrency per key is determined dynamically.

Each queue has a single mode that determines its Redis data layout and scheduling logic.

### Mode Metadata

Queue mode and keyed concurrency configuration are stored in:

    {q:<queueId>}:meta

Fields:

    mode = global | keyed
    keyConcurrency = <integer>
    seq = <integer>

- `mode` defines the authoritative queue concurrency mode.
- `keyConcurrency` is the default maximum number of concurrently active jobs per key.
- `seq` is a monotonically increasing counter used to order the ready-key set; it is incremented on claims (for fairness rotation).

### Mode Validation

#### Worker

- Read queue metadata on startup
- Validate configured mode matches stored mode
- Refuse to start on mismatch

#### Queue Client

- Resolve queue mode from metadata unless explicitly configured
- Cache the resolved mode per client instance per queue
- Route enqueues into the correct Redis layout
- Fail enqueue if configured mode and stored mode differ

### Keyed Scheduling Rules

Keyed mode enforces a maximum number of concurrently active jobs per concurrency key.

- Every job must include a concurrency key
- Global worker concurrency limits still apply
- The scheduler must ensure no key exceeds its configured active-job limit

### Redis Data Structures (Keyed Mode)

All keys share the queue hash tag for Redis Cluster compatibility.

Base tag:

    {q:<queueId>}

#### Per-Key Waiting Lists

    {q:<queueId>}:k:wait:<concurrencyKey>

Type: `LIST`

- FIFO waiting jobs for a single concurrency key
- Per-key list is required to preserve FIFO within each key

#### Active Key Counters

    {q:<queueId>}:k:active

Type: `HASH`

- Mapping: `concurrencyKey -> activeCount`

#### Ready Keys

    {q:<queueId>}:k:ready

Type: `ZSET`

- Members are concurrency keys
- Score is the scheduling sequence (`seq`)
- Workers pop the lowest-scored eligible key

A key is eligible for the ready set when:

- it has at least one waiting job
- its active count is below the key concurrency limit

When a key is reinserted, it receives a new sequence score and moves to the back of the order, producing round-robin fairness across keys.

### Readiness Invariant

A key must be checked for ready-set insertion on every path that changes key state:

1. Job enqueue
2. Job completion (success or failure)
3. Stalled job recovery

Each path must independently verify:

- waiting jobs exist
- concurrency capacity is available

If both are true, the key must be inserted into the ready set. This prevents missed-wakeup scheduling gaps caused by non-atomic state changes across different code paths.

### Job Claiming (Keyed Mode)

Workers claim jobs with the following logical sequence (implemented atomically in Lua):

1. Select the lowest-scored eligible key from the ready-key set.
2. Pop the next job from that key's waiting list.
3. Increment the key's active counter.
4. Move the job to the global active job state.
5. Re-evaluate key readiness.
6. Reinsert the key into the ready set with a new score if it still has waiting jobs and available key capacity.

If the key is empty or at capacity after the claim, do not reinsert it.

### Job Completion

When a job finishes (success or failure):

1. Decrement the key's active counter.
2. Re-evaluate the readiness invariant.
3. Reinsert the key into the ready set if it has waiting jobs and available capacity.

This makes newly available key capacity immediately schedulable.

### Stalled Job Recovery

When recovering a stalled keyed job:

1. Decrement the key's active counter.
2. Return the job to the **front** of its key waiting list using `LPUSH`.
3. Re-evaluate the readiness invariant and reinsert the key if eligible.

`LPUSH` prioritizes previously running jobs, but if multiple stalled jobs for the same key are recovered in one cycle, their relative order may not match original execution order. Strict ordering among simultaneously recovered jobs is not guaranteed in this design.

### Key Lifecycle

Key-related Redis structures are created on demand.

If a key has:

- no waiting jobs
- no active jobs

its associated per-key structures may be removed to reduce Redis memory usage.

### Operational Requirements

- All keyed-mode enqueue operations must include a concurrency key
- Workers and clients must use the same queue mode
- Queue mode metadata must remain consistent across deployments

Mode mismatches can result in jobs being written to Redis structures that active workers do not process.

### Performance Characteristics

Compared with `global` mode:

- Enqueue remains constant time
- Claiming requires sorted-set work proportional to the number of active keys
- Memory usage scales with the number of active keys (plus queued jobs)

Queues that do not require per-key fairness/isolation should use `global` mode to minimize Redis overhead.

## Decision Log

Non-authoritative rationale and decision history lives in `DECISIONS.md`. `SPEC.md` is the single source of truth for current behavior and planned designs.
