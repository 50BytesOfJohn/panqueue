# Decision Log

This file records rationale and dated decisions. It is not the source of truth for behavior; `SPEC.md` is authoritative.

## 2026-02-20: v0.1 API Direction

### Decision

- Keep package split: `@panqueue/client` and `@panqueue/worker`
- Use typed `QueueClient<QueueMap>` as primary producer API
- Add queue-scoped accessor (`mq.queue(queueId, defaults?)`) for per-queue defaults
- Keep `Worker` as low-level primitive
- Add `WorkerPool` for multi-worker coordination and shared shutdown
- Keep "one worker = one queue" guidance

### Why

- Preserves strong type safety while improving ergonomics
- Avoids per-queue connection sprawl on the producer side
- Makes coordinated shutdown and shared defaults straightforward
- Reinforces queue-as-workload-class, reducing head-of-line blocking issues

### Deferred

- Dynamic queue names escape hatch
- Runtime schema validation (zod/valibot)
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
