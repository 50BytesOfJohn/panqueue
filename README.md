<p align="center">
  <img src="assets/logo.png" alt="Panqueue" width="180">
</p>

<h1 align="center">Panqueue</h1>

<p align="center">
  <strong>Redis-backed job queue for Deno</strong><br>
  Type-safe queues with at-least-once delivery, lease-based recovery, and atomic Lua scripts.
</p>

---

## Status

Panqueue is pre-release. The API is stabilising toward v0.1 but may still change.
See [TODO.md](./TODO.md) for remaining work.

## Features

- **Type-safe from end to end** — shared config ties queue IDs to payload types, so `enqueue` and `defineWorker` infer the right shapes automatically
- **At-least-once delivery** — lease-based stalled-job recovery reclaims work from crashed or unresponsive workers
- **Atomic Redis scripts** — every state transition (claim, complete, fail, renew, recover, requeue) runs inside a single Lua call — no race conditions
- **Force-shutdown by default** — in-flight jobs are atomically requeued so another worker picks them up immediately; drain mode is opt-in
- **Corrupt-job quarantining** — malformed Redis data is isolated instead of silently dropped
- **Cluster-ready keys** — all keys use hash tags (`{q:<id>}`) for Redis Cluster compatibility

## Packages

| Package | Description |
|---|---|
| [`@panqueue/config`](./packages/config) | Shared queue config (`definePanqueueConfig`) |
| [`@panqueue/client`](./packages/client) | Producer — `createQueueClient` / `QueueClient` |
| [`@panqueue/worker`](./packages/worker) | Consumer — `defineWorker` / `WorkerPool` |

> `@panqueue/internal` is an implementation detail and not a public package.

## Quick start

### 1. Define your queues

```ts
import { definePanqueueConfig } from "@panqueue/config";

const config = definePanqueueConfig({
  redis: { url: "redis://localhost:6379" },
  queues: {
    email: { mode: "global" },
    thumbnail: { mode: "global" },
  },
});
```

### 2. Enqueue jobs

```ts
import { createQueueClient } from "@panqueue/client";

const client = createQueueClient(config);
await client.connect();

await client.enqueue("email", { to: "user@example.com", subject: "Hello" });
await client.enqueue("thumbnail", { url: "https://example.com/img.png" });

await client.disconnect();
```

### 3. Define workers and run them

```ts
import { defineWorker, WorkerPool } from "@panqueue/worker";

const emailWorker = defineWorker(config, "email", async (job) => {
  await sendEmail(job.data);
}, {
  concurrency: 5,
  events: {
    onJobComplete(job) { console.log(`sent ${job.data.subject}`); },
    onJobFail(job, error) { console.error(`failed: ${error}`); },
  },
});

const pool = new WorkerPool(config, { workers: [emailWorker] });
await pool.start();
```

### 4. Shut down

```ts
// Force (default): requeues in-flight jobs immediately, then disconnects
await pool.shutdown();

// Drain: waits for in-flight jobs, with an optional timeout
await pool.shutdown({ drain: true, timeout: 30_000 });
```

## API shape

```
definePanqueueConfig  →  PanqueueConfig    (shared config, no connections)
createQueueClient     →  QueueClient       (owns Redis producer connection)
defineWorker          →  WorkerDefinition   (pure data, no connections, no lifecycle)
new WorkerPool        →  WorkerPool         (owns Redis worker + subscriber connections)
```

Panqueue owns all Redis connections internally. Pass connection config, not a Redis client.

## Worker options

| Option | Default | Description |
|---|---|---|
| `concurrency` | `1` | Max parallel jobs per queue |
| `pollInterval` | `5000` | Fallback polling interval (ms) |
| `leaseMs` | `30000` | Job lease duration (ms) |
| `lockRenewMs` | `leaseMs / 3` | Lock renewal interval (ms) |
| `recoverIntervalMs` | `30000` | Stalled-job recovery sweep interval (ms) |
| `recoverBatchSize` | `100` | Max jobs per recovery sweep |
| `events` | — | Observability callbacks (see below) |

### Event handlers

```ts
interface WorkerEventHandlers<T> {
  onJobStart?(job: JobData<T>): void;
  onJobComplete?(job: JobData<T>): void;
  onJobFail?(job: JobData<T>, error: string): void;
  onJobRetry?(job: JobData<T>, error: string): void;
  onJobStale?(job: JobData<T>, phase: "complete" | "fail"): void;
  onJobCorrupt?(jobId: string, reason: string): void;
  onJobAckError?(job: JobData<T>, phase: "complete" | "fail", detail: string): void;
  onJobRecovered?(jobId: string, reason: string): void;
  onError?(error: unknown): void;
  onStateChange?(state: WorkerState): void;
}
```

## Job lifecycle

```
enqueue ──▶ waiting ──▶ active ──▶ completed
                           │            ▲
                           └──▶ failed ──┘ (retry → waiting)
```

Each job tracks three independent counters: `runs` (claims), `failures` (handler errors), and `stalls` (lease expirations). `maxRetries` gates failures; `maxStalls` (default 5) gates stalls. All timestamps originate from Redis `TIME` inside Lua scripts.

## Shutdown semantics

| Mode | Behaviour |
|---|---|
| **Force** (default) | Stop claiming → atomically requeue every in-flight job → disconnect. Local handlers continue running but their eventual complete/fail is a no-op because the lock token has been cleared. |
| **Drain** | Wait for in-flight semaphore drain. Falls back to force-requeue on timeout so the pool never silently exits under live work. |

Both modes return a `ShutdownResult`: `{ mode, timedOut, unfinishedJobs, requeued }`.

## Compatibility

- **Runtime:** Deno (JSR)
- **Redis:** 7+ (uses `HEXISTS`, `ZMSCORE`, and `TIME`)

## Workspace

```
packages/        Deno packages (JSR) — config, client, worker
internal/        Shared internal package (not published)
packages-node/   Node.js packages (pnpm)
apps/docs/       Documentation site (Waku + Fumadocs)
demo/            Integration tests and demo scripts
benchmarks/      BullMQ comparison benchmarks
```

### Common commands

```sh
deno task version:bump:dry-run   # Preview version bumps
deno task publish:dry-run        # Preview JSR publish
pnpm install                      # Install Node.js dependencies
pnpm docs:dev                     # Dev server for docs site
pnpm docs:typecheck               # Typecheck docs site
pnpm docs:build                   # Build docs site
```

### Demo

The demo requires Redis on port 6399 (see `demo/docker-compose.yml`):

```sh
deno task -A demo:enqueue    # Enqueue sample jobs
deno task -A demo:worker    # Process them
deno task -A demo:test      # Run integration tests
```

## Documentation

- [SPEC.md](./docs/SPEC.md) — Authoritative library specification
- [DECISIONS.md](./docs/DECISIONS.md) — Design decision log

## License

MIT