# Decision Log

This file records rationale and dated decisions. It is not the source of truth for behavior; `SPEC.md` is authoritative.

## 2026-03-22: Pay-for-What-You-Use Lua Scripts & EVALSHA Caching

### Decision

- Each feature's Redis cost is additive: the base enqueue path is 3 ops (HSET + LPUSH + PUBLISH). Optional features (delays, priorities, rate limiting) add ops only when enabled on a queue.
- All Lua scripts use `defineScript` from node-redis v5, registered via `createClient({ scripts })`. Scripts are hardcoded per package (client scripts, worker scripts) — not configurable.
- The framework automatically uses EVALSHA (40-byte SHA1 hash) instead of sending full script text on every call. First invocation per script falls back to EVAL; all subsequent calls use the cached hash.

### Why

- BullMQ runs ~15+ Redis ops per enqueue unconditionally to maintain indexes for priorities, delays, rate limiting, and dependencies — even when unused. Our 3-op base path benchmarks at **2.3x faster enqueue** than BullMQ, which matters because enqueue is in the client-facing hot path (API handlers, webhooks).
- Processing speed (background, user-invisible) is secondary. Users don't feel the difference between 103ms and 106ms on a background email send.
- EVALSHA eliminates repeated script transmission. With 2 evals per job at scale, this saves bandwidth to Redis proportional to script size × throughput.
- Scripts as fixed internals (not constructor params) keeps the API surface clean and avoids accidental misconfiguration.

### Benchmark (local Docker Redis, port 6399)

| Metric | Panqueue | BullMQ |
|---|---|---|
| Enqueue throughput | ~47,000 jobs/s | ~20,000 jobs/s |
| Process throughput (no-op, c=50) | ~4,400 jobs/s | ~15,000 jobs/s |
| Overhead per job | ~0.16ms | ~0.04ms |

Processing gap is due to ioredis command pipelining in BullMQ — a known future optimization for Panqueue.

## 2026-03-21: Worker Lifecycle State Machine, Event Handlers & Structured Shutdown

### Decision

- Replace implicit boolean state (`#running`, `#stopping`) with an explicit `WorkerState` type: `"idle" | "starting" | "running" | "stopping" | "stopped" | "failed"`
- Add `WorkerEventHandlers` interface (`onJobStart`, `onJobComplete`, `onJobFail`, `onError`, `onStateChange`) as an optional `events` field on `WorkerOptions`
- Change `shutdown()` return type from `Promise<void>` to `Promise<ShutdownResult>` with `{ timedOut: boolean; unfinishedJobs: number }`

### Why

- The worker's lifecycle was already an implicit state machine with combinations of booleans and promises. Making it explicit simplifies reasoning and enables future features (WorkerPool, pause/resume, health reporting, force shutdown)
- Direct `console.error`/`console.warn` calls are acceptable for prototyping but not for a library. Event handlers allow users to plug in their own logger, suppress noise, or integrate with observability tools. Default behavior falls back to `console.error` to avoid silent failures
- Shutdown returning `void` forces callers to rely on logs. A structured result lets pools, CLIs, and orchestration layers react programmatically (e.g., force-kill on timeout, alert on unfinished jobs)

### Deferred

- **Worker config/session split**: The state machine clarifies where the session boundary belongs. Splitting `Worker` into config + per-run session will be done once the state machine is proven in practice
- **Claimed-job/lease abstraction**: Current direct `complete()`/`fail()` on the scheduler works. A `ClaimedJob` wrapper with `complete()`, `fail()`, `extendLock()` will be introduced alongside lock renewal and stalled detection
- **Integration tests against real Redis**: Important but orthogonal. Will be a separate effort

## 2026-03-10: Class-Based API & Three-Tier Worker Design

### Decision

- All public APIs use classes: `QueueClient`, `Worker`, `WorkerPool`
- `Worker` constructor uses positional args for queue name and processor, trailing options object for config: `new Worker(queueName, processor, options?)`
- When using shared config, it becomes the first argument: `new Worker(config, queueName, processor, options?)`
- Three tiers of worker definition: standalone (no shared config), shared-config (with optional overrides), and pool shorthand (inline processors only)
- `WorkerPool` accepts both inline processor functions and pre-built `Worker` instances in its handler map

### Why

- `QueueClient` was already class-based (`new QueueClient(...)`), so `Worker` and `WorkerPool` follow the same pattern for consistency
- Positional args for queue name and processor keep the two universal, required concerns prominent and readable — they exist on every worker
- Trailing options object holds situational settings (concurrency, connection overrides, shutdown timeouts) that vary per deployment
- Three tiers map to real deployment topologies: standalone workers for microservices, shared-config workers for modular monorepos, pool shorthand for single-app setups
- Pre-built workers in the pool preserve coordinated shutdown/health without forcing all workers into the same config
- The options object is the natural extension point for future settings — no risk of running out of positional args

### Pool + Pre-Built Worker Rules

- Pool validates that a pre-built worker's queue ID matches its handler map key (mismatch = startup error)
- Pre-built worker's own config always wins (pool does not override connection or concurrency)
- Pool owns lifecycle: `pool.shutdown()` shuts down all workers including pre-built ones
- Detection of worker instances vs inline functions uses a branded symbol (`Symbol.for("panqueue.worker")`)

## 2026-02-20: v0.1 API Direction

### Decision

> **Note:** The API surface (factory functions) described here has been superseded by the 2026-03-10 decision (class-based API with three-tier worker design). The package split, shared config pattern, and config scope decisions below remain current.

- Three-package split: `@panqueue/config` (shared), `@panqueue/client` (producer), `@panqueue/worker` (consumer)
- Shared configuration via `definePanqueueConfig<QueueMap>()` exported from `@panqueue/config`
- `createQueueClient(config)` as primary producer API; queue IDs and payloads typed via the shared config
- Queue-scoped accessor (`client.queue(queueId, defaults?)`) for per-queue defaults
- `createWorkerPool(config, handlers)` for multi-worker coordination and shared shutdown
- One worker per queue within the pool

### Why

- Shared config eliminates drift between producer and consumer queue definitions
- `definePanqueueConfig` is a zero-cost identity function (no side effects, no connections) — safe to import anywhere
- Generic parameter `QueueMap` provides full payload type safety without runtime schema dependency in v0.1
- `queues` keys constrained to `keyof QueueMap` ensures every queue has a payload type and vice versa
- Clean migration path: future schema support (ArkType/Zod/Valibot) replaces the generic with inferred types, no API shape change
- Package split keeps dependency graph clean: neither client nor worker depends on the other
- `@panqueue/config` changes rarely and caches well as a stable shared foundation

### Config Scope

The shared config holds what both sides must agree on: Redis connection, queue IDs, modes, keyed concurrency settings.

One-sided settings stay with their respective `create*` calls:

- **Client-only:** per-queue default job options (TTL, retries, delay)
- **Worker-only:** concurrency, executor type, shutdown timeouts, handler functions

Both `createQueueClient` and `createWorkerPool` accept an optional Redis override for deployments where producer and consumer connect to different endpoints.

### Deferred

- Runtime schema validation (per-queue schemas replacing the generic parameter)
- Dynamic queue names escape hatch
- BYO Redis client instance

## 2026-02-20: Inline Executor Concurrency Model (v0.1)

### Decision

Adopt a single claim loop coordinated by a semaphore. Do not prefetch jobs in v0.1.

### Why

- Strict concurrency bound is easy to reason about
- Claimed jobs start immediately, so `active` maps closely to real execution
- Lower Redis polling pressure than `N` independent loops
- Cleaner shutdown semantics and easier future scheduling extensions

### Consequence

v0.1 prioritizes correctness and observability over maximum throughput optimizations such as prefetching or adaptive claim strategies.

## 2026-02-20: Keyed Concurrency Direction (Future)

### Decision

Use a separate queue mode with dedicated Redis structures:

- per-key waiting lists (`LIST`)
- per-key active counters (`HASH`)
- ready-key scheduler (`ZSET`) with sequence scores for round-robin fairness

### Why

- Enforces per-key fairness and prevents single-key monopolization
- Keeps queue-level mode explicit, avoiding ambiguous mixed layouts
- Supports Redis Cluster compatibility via queue hash tags

### Key Invariant

Re-check key readiness on every state-changing path (enqueue, completion, stalled recovery) to avoid missed scheduling wakeups.

## 2026-03-03: Job Deduplication (v0.2)

### Decision

- Deduplication/idempotency uses a separate user-provided key on `.add()`; the exact field name is still TBD
- Provide a `dedupFrom((payload) => string)` helper for explicit payload-based derivation
- Dedup window controlled by TTL on a Redis key per dedup entry
- Behavior on duplicate is configurable per queue: `throw` (default) or `ignore` (returns existing job ID)
- Dedup config lives in the shared `definePanqueueConfig` under each queue's definition

### Why

- User-provided dedup keys are safer and more readable than magic hashing — the user decides what "duplicate" means
- Keeping deduplication separate from `jobId` preserves job identity and avoids collisions between dedupe and record identity
- Helper utility covers the common hash-from-payload case without making it implicit
- Redis TTL-based window is simple, self-cleaning, and requires no background sweep
- Config-driven behavior (`throw` vs `ignore`) avoids per-call boilerplate while keeping the choice explicit
- Atomic check in the enqueue Lua script prevents race conditions between concurrent enqueues

## 2026-03-03: Job Completion Waiting (v0.1 or v0.2)

### Decision

Add a client-side API for awaiting job completion after enqueue. Exact API and scope TBD.

### Why

- Enables request-response patterns where the producer needs the job result before continuing
- Common use case in single-app setups (e.g. API handler enqueues a job and returns the result to the HTTP client)
- Likely backed by Redis pub/sub or polling — details to be decided when scoping

## 2026-03-03: Rate Limiting as Composable Constraint (Future)

### Decision

Rate limiting is a separate, composable config field — not a queue mode. It can be combined with any mode (`global`, `keyed`, future `dynamic`).

### Why

- Modes define scheduling topology (how jobs are organized and claimed). Rate limiting is an orthogonal constraint on throughput.
- Making rate limiting a mode would cause combinatorial explosion: `global`, `keyed`, `global-rate-limited`, `keyed-rate-limited`, etc.
- As a composable field, the claim Lua script adds one additional check after the mode-specific logic, keeping both concerns clean
- In keyed mode, rate limits naturally scope per key (the scheduling unit). In global mode, they scope per queue.

## 2026-02-20: Documentation Policy

### Decision

Use `SPEC.md` as the single source of truth. Keep only one additional doc (`DECISIONS.md`) for rationale/history.

### Why

- Prevents drift between "spec", "design note", and "session transcript" files
- Makes onboarding easier (one place to read for what the system does)
- Preserves context without duplicating normative behavior