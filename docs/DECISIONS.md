# Decision Log

This file records rationale and dated decisions. It is not the source of truth
for behavior; `SPEC.md` is authoritative.

## 2026-05-14: Concurrency Scope Naming

### Decision

- The per-queue concurrency configuration is expressed as
  `concurrency: { scope: "global" | "keyed" }` nested inside the queue config.
- `concurrency` is optional. Omitting it defaults to `scope: "global"`.
- The previous `mode: "global"` flat field on `QueueConfig` is removed.
- Redis metadata stores the scope under the key `scope` (replacing `mode`).
- A future `scope: "auto"` value will allow the client to resolve the scope from
  Redis metadata written by the worker, enabling zero-config cross-language setups
  where the worker is the source of truth.

### Why

- `mode: "global"` as a required flat field was poor DX: the word "mode" gives
  no hint of what varies between options, and requiring it for the only available
  value added boilerplate with no benefit.
- `scope` directly answers the question "what is the scope of this concurrency
  limit?" — `"global"` means the whole queue, `"keyed"` means per key. The
  contrast is self-explanatory.
- Nesting under `concurrency` groups the concept correctly and makes room for
  related fields (`key`, `limit`) without polluting the top-level queue config.
- Making `concurrency` optional with `"global"` as the default eliminates
  required boilerplate for the common case.
- `scope: "auto"` (future) supports cross-language deployments where client and
  worker are in different codebases: the client reads the scope from Redis rather
  than requiring it to be duplicated in config. Explicit scope values remain
  useful for fail-fast mismatch detection at startup.

## 2026-05-03: Panqueue-Owned Redis Instances & Pure Worker Definitions

### Decision

- v0.1 keeps Panqueue-owned Redis client instances. Users pass Redis connection
  config; they do not pass Redis client objects.
- `QueueClient` is the producer connection boundary. Each client instance
  creates and reuses the Redis connection needed for enqueue operations.
- `WorkerPool` is the consumer connection boundary. Each pool creates and reuses
  the worker-side Redis connections needed by every registered worker
  definition.
- Worker definitions are pure. `defineWorker(...)` captures the typed queue
  processor and worker-specific options but opens no connections and owns no
  lifecycle.
- `WorkerPool.register(...)` accepts worker definitions. The pool materializes
  those definitions when started.
- Worker definitions do not carry Redis connection config. Pool-level connection
  config wins for all workers in the pool.

## 2026-05-01: Force Shutdown as Default, Drain as Opt-In (v0.1)

### Decision

- `Worker.shutdown()` defaults to **force**: stop the claim loop, atomically
  requeue every in-flight job via a fenced Lua script (`requeue_active`), then
  disconnect Redis. Local handlers keep running until the process exits; their
  eventual complete/fail no-op as `stale` because the lockToken has been cleared
  by the requeue.
- `Worker.shutdown({ drain: true, timeout? })` opts into the previous drain
  semantics. If `timeout` is provided and elapses, the worker falls through to
  the force-requeue path so it never disconnects silently under live work.
- `ShutdownResult` is now
  `{ mode: "force" | "drain"; timedOut; unfinishedJobs; requeued }`.
- `WorkerOptions.shutdownTimeout` is removed; the timeout lives on
  `shutdown({ timeout })` in drain mode only.
- The new `requeueActive` script mirrors `recover` (fenced on lockToken instead
  of lease deadline): if the killed claim still has retries left it goes back to
  `waiting` with a `PUBLISH` notification; if it has exhausted retries it goes
  straight to `failed` with reason `"shutdown"`. A force shutdown is therefore
  indistinguishable from a stall, except the worker that owns the lease executes
  the handoff itself instead of waiting for the lease clock.

### Why

- This inverts the 2026-04-29 "graceful shutdown is the default" decision. The
  shape that decision picked — graceful with a 5s timeout — was the worst of
  both: callers who set a long timeout hung deployments under long jobs; callers
  who left the 5s default silently disconnected under live work, which the TODO
  explicitly called out as a bug.
- Job leases and stalled-job recovery (2026-04-30) are what makes force safe. A
  force-shutdown job is not lost: it is requeued, fenced by lockToken, and
  either picked up immediately by another worker or swept by recovery.
  At-least-once is preserved.
- Naive force has a latency hole — in-flight jobs would sit in `active` until
  the lease deadline (default 30s) and then up to one recovery-sweep interval
  (default 30s) before being eligible again. That is too long for a default. The
  proactive `requeueActive` Lua script eliminates the wait: shutdown handoff is
  immediate, no extra steady-state Redis cost, paid only at shutdown time.
- `shutdown({ drain: true })` is still ~30 lines of code we already have
  working, and is the right escape hatch for users with non-idempotent
  processors. Shipping both modes today (with force as the default) is cheaper
  than removing drain only to add it back in v0.1.1.
- Single API with explicit options keeps the surface small and the default
  communicative. Two methods (`shutdown` + `terminate`) was considered and
  rejected as more API for no benefit.

### Tradeoffs

- Force shutdown makes "your processor must be idempotent" a hard requirement
  rather than a soft one. Documented prominently.
- Cooperative cancellation (`AbortSignal` passed to processors) is deferred to
  v0.2 — it is breaking on the processor signature and not needed for the v0.1
  force-shutdown story.
- A force-shutdown handoff does not consume `failures` or `stalls` (see
  2026-05-04 lifecycle separation). A restart loop can therefore requeue the
  same job repeatedly; operators should watch high `runs` counts or repeated
  `lastRequeueReason = "shutdown"` markers.

## 2026-05-04: Three-Counter Job Lifecycle (v0.1)

### Decision

- A job carries three independent counters on its hash: `runs` (successful
  durable claims), `failures` (handler throws), and `stalls` (lease-expiry
  recoveries). The previous single `attempts` field is removed.
- `maxRetries` gates `failures`; `maxStalls` gates `stalls`. `maxStalls`
  defaults to `5` and is configurable per job through `EnqueueOptions`.
- `claim_global` is the only script that increments `runs`. `fail` is the only
  script that increments `failures`. `recover` is the only script that
  increments `stalls`. `requeue_active` (force-shutdown handoff) touches none of
  the three.
- Every durable lifecycle timestamp (`createdAt`, `lastStartedAt`,
  `leaseDeadline`, `lastFailedAt`, `lastStalledAt`, `lastRequeuedAt`,
  `finishedAt`) is written from Redis `TIME` inside Lua so the clock is
  authoritative for one primary.
- `failureKind` (`"handler" | "stalled"`) and `failedReason` are set on every
  failure transition so operators can read the most recent failure regardless of
  whether the job is currently `waiting` or terminal.

### Why

- A single `attempts` counter conflated three distinct events with different
  operational meanings: user code throwing, the runtime losing ownership of a
  lease, and a deliberate shutdown handoff. Each has its own retry budget and
  its own remediation story; collapsing them under one counter erased that
  signal.
- Separating `runs` from `failures` also lets observability code answer "how
  many times has this job actually executed" independently of "how many times it
  has failed," which matters for at-least-once auditing.
- Redis-side timestamps avoid clock skew between the producer and consumer hosts
  and remove the need for the client to send a `now` parameter on every enqueue.

## 2026-04-30: Job Leases & Stalled-Job Recovery (v0.1)

### Decision

- The `active` collection is a Redis `ZSET` scored by lease deadline (ms), not a
  `SET`. Each claim writes the deadline as the score and a fresh
  server-generated `lockToken` (sha1 of jobId + now + runs) on the job hash.
- `complete`, `fail`, and `extend_lock` Lua scripts fence on `lockToken`: they
  no-op if the caller's token does not match the hash. A stale ack surfaces to
  the worker via the `onJobStale` event.
- Lock renewal runs in the background per in-flight job (default cadence
  `leaseMs / 3`) using `ZADD XX` plus a token check. If renewal returns 0 (lease
  lost), the renewer stops and emits a `lease-lost:<jobId>` error.
- A periodic `recover` sweep on each worker (default 30s, batch 100) is a single
  atomic Lua script: `ZRANGEBYSCORE 0 now`, then per candidate `ZSCORE`+`ZREM`
  (re-fence under script atomicity), increment `stalls`, then either requeue (if
  `stalls <= maxStalls`) or move to `failed`. Concurrent sweeps are safe — only
  the first `ZREM` wins.

### Why

- Carrying the lease deadline as the ZSET score collapses "is active" and "lease
  expired?" into one structure, which makes the sweep an index-backed
  `ZRANGEBYSCORE` instead of an O(N) scan of per-job lock keys plus the active
  set.
- A dedicated `lockToken` keeps fencing semantics independent of the retry
  counters: any future change to retry accounting cannot silently break the
  fence. The few extra bytes per job hash are worth the clarity.
- `ZSCORE`+`ZREM` inside the same Lua script is the only way to safely fence
  against a renewer pushing the deadline forward at exactly the same instant a
  sweeper fires.
- Per-worker sweep with no leader election keeps the v0.1 model simple; the
  atomic script makes concurrent sweepers harmless.

## 2026-04-29: v0.1 Alpha Scope, Single Producer API & WorkerPool Composition

> **Note:** The producer API remains current. The worker composition details
> were superseded by the 2026-05-03 `defineWorker` and pool-owned connection
> decision.

### Decision

- v0.1 is advertised as alpha while the public API settles, but the Redis
  lifecycle should be production-quality.
- The single producer operation is `client.enqueue(queueId, payload, options?)`.
  No `queue().add()` alias in v0.1.
- Job IDs are generated and owned by panqueue. User-provided `jobId` is not part
  of the v0.1 API.
- Deduplication/idempotency will use a separate user-provided key in v0.2.
- v0.1 includes global FIFO queues only. Keyed concurrency, delayed jobs, retry
  backoff, and richer executors move to v0.2+.
- Graceful shutdown in v0.1 stops claiming, waits for in-flight work to finish,
  then disconnects. Forced shutdown can be added later as an explicit API.
  _(Superseded 2026-05-01: with leases + recovery in place, force shutdown
  became the default; drain is the opt-in.)_
- `WorkerPool` is a thin lifecycle layer over workers.
- `WorkerPool.register(...)` accepts:
  - a queue ID, processor, and optional worker options
  - a prebuilt `Worker`
  - an array of prebuilt `Worker` instances
- `register(queueId, processor, options?)` constructs a worker from the pool's
  base config. `register(worker)` keeps explicit worker construction composable.

### Why

- A single enqueue API keeps the mental model and documentation small.
- Separating job identity from deduplication avoids overloading one field with
  two meanings.
- Library-owned job IDs prevent duplicate-ID corruption and keep every enqueue
  as a concrete job record.
- Stalled recovery is required for the at-least-once guarantee; without it,
  crashes can strand active jobs.
- Deferring keyed concurrency avoids locking v0.1 into Redis layouts that need a
  larger scheduling design.
- A pool should not be the only way to run jobs. `Worker` remains a standalone
  block; `WorkerPool` only coordinates multiple workers when that is useful.
  _(Superseded 2026-05-03: worker definitions are pure and `WorkerPool` is the
  v0.1 public execution boundary.)_

## 2026-03-22: Pay-for-What-You-Use Lua Scripts & EVALSHA Caching

### Decision

- Each feature's Redis cost is additive: the base enqueue path is 3 ops (HSET +
  LPUSH + PUBLISH). Optional features (delays, priorities, rate limiting) add
  ops only when enabled on a queue.
- All Lua scripts use `defineScript` from node-redis v5, registered via
  `createClient({ scripts })`. Scripts are hardcoded per package (client
  scripts, worker scripts) — not configurable.
- The framework automatically uses EVALSHA (40-byte SHA1 hash) instead of
  sending full script text on every call. First invocation per script falls back
  to EVAL; all subsequent calls use the cached hash.

### Why

- BullMQ runs ~15+ Redis ops per enqueue unconditionally to maintain indexes for
  priorities, delays, rate limiting, and dependencies — even when unused. Our
  3-op base path benchmarks at **2.3x faster enqueue** than BullMQ, which
  matters because enqueue is in the client-facing hot path (API handlers,
  webhooks).
- Processing speed (background, user-invisible) is secondary. Users don't feel
  the difference between 103ms and 106ms on a background email send.
- EVALSHA eliminates repeated script transmission. With 2 evals per job at
  scale, this saves bandwidth to Redis proportional to script size × throughput.
- Scripts as fixed internals (not constructor params) keeps the API surface
  clean and avoids accidental misconfiguration.

### Benchmark (local Docker Redis, port 6399)

| Metric                           | Panqueue       | BullMQ         |
| -------------------------------- | -------------- | -------------- |
| Enqueue throughput               | ~47,000 jobs/s | ~20,000 jobs/s |
| Process throughput (no-op, c=50) | ~4,400 jobs/s  | ~15,000 jobs/s |
| Overhead per job                 | ~0.16ms        | ~0.04ms        |

Processing gap is due to ioredis command pipelining in BullMQ — a known future
optimization for Panqueue.

## 2026-03-21: Worker Lifecycle State Machine, Event Handlers & Structured Shutdown

### Decision

- Replace implicit boolean state (`#running`, `#stopping`) with an explicit
  `WorkerState` type:
  `"idle" | "starting" | "running" | "stopping" | "stopped" | "failed"`
- Add `WorkerEventHandlers` interface (`onJobStart`, `onJobComplete`,
  `onJobFail`, `onError`, `onStateChange`) as an optional `events` field on
  `WorkerOptions`
- Change `shutdown()` return type from `Promise<void>` to
  `Promise<ShutdownResult>` with `{ timedOut: boolean; unfinishedJobs: number }`

### Why

- The worker's lifecycle was already an implicit state machine with combinations
  of booleans and promises. Making it explicit simplifies reasoning and enables
  future features (WorkerPool, pause/resume, health reporting, force shutdown)
- Direct `console.error`/`console.warn` calls are acceptable for prototyping but
  not for a library. Event handlers allow users to plug in their own logger,
  suppress noise, or integrate with observability tools. Default behavior falls
  back to `console.error` to avoid silent failures
- Shutdown returning `void` forces callers to rely on logs. A structured result
  lets pools, CLIs, and orchestration layers react programmatically (e.g.,
  force-kill on timeout, alert on unfinished jobs)

### Deferred

- **Worker config/session split**: The state machine clarifies where the session
  boundary belongs. Splitting `Worker` into config + per-run session will be
  done once the state machine is proven in practice
- **Claimed-job/lease abstraction**: Current direct `complete()`/`fail()` on the
  scheduler works. A `ClaimedJob` wrapper with `complete()`, `fail()`,
  `extendLock()` will be introduced alongside lock renewal and stalled detection
- **Integration tests against real Redis**: Important but orthogonal. Will be a
  separate effort

## 2026-03-10: Class-Based API & Three-Tier Worker Design

> **Note:** The class-based `QueueClient` and `WorkerPool` APIs remain current.
> The public live-`Worker` construction model was superseded by the 2026-05-03
> `defineWorker` decision.

### Decision

- All public APIs use classes: `QueueClient`, `Worker`, `WorkerPool`
- `Worker` constructor uses positional args for queue name and processor,
  trailing options object for config:
  `new Worker(queueName, processor, options?)`
- When using shared config, it becomes the first argument:
  `new Worker(config, queueName, processor, options?)`
- Three tiers of worker definition: standalone (no shared config), shared-config
  (with optional overrides), and pool shorthand (inline processors only)
- `WorkerPool` accepts both inline processor functions and pre-built `Worker`
  instances

### Why

- `QueueClient` was already class-based (`new QueueClient(...)`), so `Worker`
  and `WorkerPool` follow the same pattern for consistency
- Positional args for queue name and processor keep the two universal, required
  concerns prominent and readable — they exist on every worker
- Trailing options object holds situational settings (concurrency, connection
  overrides, shutdown timeouts) that vary per deployment
- Three tiers map to real deployment topologies: standalone workers for
  microservices, shared-config workers for modular monorepos, pool shorthand for
  single-app setups
- Pre-built workers in the pool preserve coordinated shutdown/health without
  forcing all workers into the same config
- The options object is the natural extension point for future settings — no
  risk of running out of positional args

### Pool + Pre-Built Worker Rules

- Pre-built worker's own config always wins (pool does not override connection
  or concurrency)
- Pool owns lifecycle: `pool.shutdown()` shuts down all workers including
  pre-built ones

_Superseded 2026-05-03: worker definitions no longer own connection config;
pool-level connection config is the v0.1 execution boundary._

## 2026-02-20: v0.1 API Direction

### Decision

> **Note:** The API surface described here has been superseded by the 2026-03-10
> and 2026-04-29 decisions. The package split and shared config pattern remain
> current.

- Three-package split: `@panqueue/config` (shared), `@panqueue/client`
  (producer), `@panqueue/worker` (consumer)
- Shared configuration via `definePanqueueConfig<QueueMap>()` exported from
  `@panqueue/config`
- `createQueueClient(config)` as primary producer API; queue IDs and payloads
  typed via the shared config
- Queue-scoped accessor (`client.queue(queueId, defaults?)`) for per-queue
  defaults
- `createWorkerPool(config, handlers)` for multi-worker coordination and shared
  shutdown
- One worker per queue within the pool

### Why

- Shared config eliminates drift between producer and consumer queue definitions
- `definePanqueueConfig` is a zero-cost identity function (no side effects, no
  connections) — safe to import anywhere
- Generic parameter `QueueMap` provides full payload type safety without runtime
  schema dependency in v0.1
- `queues` keys constrained to `keyof QueueMap` ensures every queue has a
  payload type and vice versa
- Clean migration path: future schema support (ArkType/Zod/Valibot) replaces the
  generic with inferred types, no API shape change
- Package split keeps dependency graph clean: neither client nor worker depends
  on the other
- `@panqueue/config` changes rarely and caches well as a stable shared
  foundation

### Config Scope

The shared config holds what both sides must agree on: Redis connection, queue
IDs, and concurrency configuration.

One-sided settings stay with their respective `create*` calls:

- **Client-only:** per-queue default job options (TTL, retries, delay)
- **Worker-only:** concurrency, executor type, shutdown timeouts, handler
  functions

Both `createQueueClient` and `createWorkerPool` accept an optional Redis
override for deployments where producer and consumer connect to different
endpoints.

_Updated 2026-05-03: this remains true conceptually, but the current public
worker API is `new WorkerPool(config, options?)` plus `defineWorker` rather than
`createWorkerPool(config, handlers)`._

### Deferred

- Runtime schema validation (per-queue schemas replacing the generic parameter)
- Dynamic queue names escape hatch
- User-provided Redis client instance

## 2026-02-20: Inline Executor Concurrency Model (v0.1)

### Decision

Adopt a single claim loop coordinated by a semaphore. Do not prefetch jobs in
v0.1.

### Why

- Strict concurrency bound is easy to reason about
- Claimed jobs start immediately, so `active` maps closely to real execution
- Lower Redis polling pressure than `N` independent loops
- Cleaner shutdown semantics and easier future scheduling extensions

### Consequence

v0.1 prioritizes correctness and observability over maximum throughput
optimizations such as prefetching or adaptive claim strategies.

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

Re-check key readiness on every state-changing path (enqueue, completion,
stalled recovery) to avoid missed scheduling wakeups.

## 2026-03-03: Job Deduplication (v0.2)

### Decision

- Deduplication/idempotency uses a separate user-provided key on `enqueue()`;
  the exact field name is still TBD
- Provide a `dedupFrom((payload) => string)` helper for explicit payload-based
  derivation
- Dedup window controlled by TTL on a Redis key per dedup entry
- Behavior on duplicate is configurable per queue: `throw` (default) or `ignore`
  (returns existing job ID)
- Dedup config lives in the shared `definePanqueueConfig` under each queue's
  definition

### Why

- User-provided dedup keys are safer and more readable than magic hashing — the
  user decides what "duplicate" means
- Keeping deduplication separate from `jobId` preserves job identity and avoids
  collisions between dedupe and record identity
- Helper utility covers the common hash-from-payload case without making it
  implicit
- Redis TTL-based window is simple, self-cleaning, and requires no background
  sweep
- Config-driven behavior (`throw` vs `ignore`) avoids per-call boilerplate while
  keeping the choice explicit
- Atomic check in the enqueue Lua script prevents race conditions between
  concurrent enqueues

## 2026-03-03: Job Completion Waiting (v0.1 or v0.2)

### Decision

Add a client-side API for awaiting job completion after enqueue. Exact API and
scope TBD.

### Why

- Enables request-response patterns where the producer needs the job result
  before continuing
- Common use case in single-app setups (e.g. API handler enqueues a job and
  returns the result to the HTTP client)
- Likely backed by Redis pub/sub or polling — details to be decided when scoping

## 2026-03-03: Rate Limiting as Composable Constraint (Future)

### Decision

Rate limiting is a separate, composable config field — not a concurrency scope.
It can be combined with any scope (`global`, `keyed`, future `dynamic`).

### Why

- Concurrency scopes define scheduling topology (how jobs are organized and
  claimed). Rate limiting is an orthogonal constraint on throughput.
- Making rate limiting a scope would cause combinatorial explosion: `global`,
  `keyed`, `global-rate-limited`, `keyed-rate-limited`, etc.
- As a composable field, the claim Lua script adds one additional check after
  the scope-specific logic, keeping both concerns clean.
- In keyed scope, rate limits naturally scope per key (the scheduling unit). In
  global scope, they scope per queue.

## 2026-02-20: Documentation Policy

### Decision

Use `SPEC.md` as the single source of truth. Keep only one additional doc
(`DECISIONS.md`) for rationale/history.

### Why

- Prevents drift between "spec", "design note", and "session transcript" files
- Makes onboarding easier (one place to read for what the system does)
- Preserves context without duplicating normative behavior
