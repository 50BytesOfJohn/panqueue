# Decision Log

This file records rationale and dated decisions. It is not the source of truth for behavior; `SPEC.md` is authoritative.

## 2026-02-20: v0.1 API Direction

### Decision

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
