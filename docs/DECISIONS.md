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

## 2026-02-20: Documentation Policy

### Decision

Use `SPEC.md` as the single source of truth. Keep only one additional doc (`DECISIONS.md`) for rationale/history.

### Why

- Prevents drift between "spec", "design note", and "session transcript" files
- Makes onboarding easier (one place to read for what the system does)
- Preserves context without duplicating normative behavior