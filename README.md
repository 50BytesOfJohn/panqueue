<p align="center">
  <img src="assets/logo.png" alt="Panqueue" width="180">
</p>

<h1 align="center">Panqueue</h1>

<p align="center">
  <strong>Runtime-agnostic Redis job queues for JavaScript and TypeScript</strong><br>
  First-class on Node, Bun, and Deno, with typed payloads, at-least-once delivery, lease-based recovery, and atomic Lua scripts.
</p>

---

## Status

Panqueue is pre-release. The API is stabilising toward v0.1 but may still change.
See [TODO.md](./TODO.md) for remaining work.

Panqueue currently targets JavaScript and TypeScript across Node, Bun, and Deno.
The same TypeScript source tree is published to npm and JSR.

## Features

- **Type-safe from end to end** — shared config ties queue IDs to payload types, so `enqueue` and `defineWorker` infer the right shapes automatically
- **At-least-once delivery** — lease-based stalled-job recovery reclaims work from crashed or unresponsive workers
- **Atomic Redis scripts** — every state transition (claim, complete, fail, renew, recover, requeue) runs inside a single Lua call — no race conditions
- **Force-shutdown by default** — in-flight jobs are atomically requeued so another worker picks them up immediately; drain mode is opt-in
- **Corrupt-job quarantining** — malformed Redis data is isolated instead of silently dropped
- **Cluster-ready keys** — all keys use hash tags (`{q:<id>}`) for Redis Cluster compatibility

## Packages

| Package                                 | Description                                             |
| --------------------------------------- | ------------------------------------------------------- |
| [`@panqueue/core`](./packages/core)     | Shared types, key helpers, and serialization primitives |
| [`@panqueue/config`](./packages/config) | Shared queue config (`definePanqueueConfig`)            |
| [`@panqueue/client`](./packages/client) | Producer — `createQueueClient` / `QueueClient`          |
| [`@panqueue/worker`](./packages/worker) | Consumer — `defineWorker` / `WorkerPool`                |

All packages are **ESM-only** and ship with first-class types.

## Installation

Install `@panqueue/config` anywhere you define or import the shared queue
contract, then add `@panqueue/client` for producers and `@panqueue/worker` for
consumers. `@panqueue/core` is pulled in automatically.

```sh
# Node / Bun
pnpm add @panqueue/config @panqueue/client @panqueue/worker

# Deno (via npm)
deno add npm:@panqueue/config npm:@panqueue/client npm:@panqueue/worker

# Deno (via JSR)
deno add jsr:@panqueue/config jsr:@panqueue/client jsr:@panqueue/worker
```

You also need a Redis server (7+).

## Quick start

### 1. Define your queues

```ts
import { definePanqueueConfig } from "@panqueue/config";

type Queues = {
  email: { to: string; subject: string };
  thumbnail: { url: string };
};

const config = definePanqueueConfig<Queues>({
  redis: { url: "redis://localhost:6379" },
  queues: {
    email: {},
    thumbnail: {},
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

const emailWorker = defineWorker(
  config,
  "email",
  async (job) => {
    await sendEmail(job.data);
  },
  {
    concurrency: 5,
    events: {
      onJobComplete(job) {
        console.log(`sent ${job.data.subject}`);
      },
      onJobFail(job, error) {
        console.error(`failed: ${error}`);
      },
    },
  },
);

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

| Option              | Default       | Description                              |
| ------------------- | ------------- | ---------------------------------------- |
| `concurrency`       | `1`           | Max parallel jobs per queue              |
| `pollInterval`      | `5000`        | Fallback polling interval (ms)           |
| `leaseMs`           | `30000`       | Job lease duration (ms)                  |
| `lockRenewMs`       | `leaseMs / 3` | Lock renewal interval (ms)               |
| `recoverIntervalMs` | `30000`       | Stalled-job recovery sweep interval (ms) |
| `recoverBatchSize`  | `100`         | Max jobs per recovery sweep              |
| `events`            | —             | Observability callbacks (see below)      |

### Event handlers

```ts
interface WorkerEventHandlers<T> {
  onJobStart?(job: JobData<T>): void;
  onJobComplete?(job: JobData<T>): void;
  onJobFail?(job: JobData<T>, error: string): void;
  onJobRetry?(job: JobData<T>, error: string): void;
  onJobStale?(job: JobData<T>, phase: "complete" | "fail"): void;
  onJobCorrupt?(jobId: string, reason: string): void;
  onJobAckError?(job: JobData<T>, phase: "complete" | "fail", error: unknown): void;
  onJobRecovered?(jobIds: string[]): void;
  onError?(context: string, error: unknown): void;
  onStateChange?(from: WorkerState, to: WorkerState): void;
}
```

## Job lifecycle

```
enqueue ──▶ waiting ──▶ active ──▶ completed
                           │            ▲
                           └──▶ failed ──┘ (retry → waiting)
```

Each job tracks three independent counters: `runs` (claims), `failures` (handler errors), and `stalls` (lease expirations). `maxRetries` gates failures; `maxStalls` (default 5) gates stalls. All timestamps originate from Redis `TIME` inside Lua scripts.

## Job retention

Panqueue cleans up after itself by default: completed jobs are deleted on success, and failed jobs are kept as a bounded dead-letter set (7 days / 1000 jobs) so you can inspect or re-enqueue them — but never unbounded. Configure per queue:

```ts
import ms from "ms";

const config = definePanqueueConfig<Queues>({
  redis: { url: "redis://localhost:6379" },
  queues: {
    email: {
      retention: {
        completed: false, // default: delete on success
        failed: { ttl: ms("7d"), count: 1000 }, // default: bounded dead-letter
      },
    },
  },
});
```

A retention rule is `false` (delete on finish), `true` (keep forever), or `{ ttl?, count? }` (keep at most `count` jobs no older than `ttl`). `ttl` is the retention window in milliseconds. Eviction runs atomically inside the same Lua scripts that finish a job.

## Observability

Panqueue is not a metrics or analytics store — finished jobs are retained only for operational inspection. To track failures, completions, and retries over time, forward the worker event hooks (`onJobFail`, `onJobComplete`, `onJobRetry`, …) to your logging or monitoring stack (Sentry, PostHog, structured logs).

## Shutdown semantics

| Mode                | Behaviour                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Force** (default) | Stop claiming → atomically requeue every in-flight job → disconnect. Local handlers continue running but their eventual complete/fail is a no-op because the lock token has been cleared. |
| **Drain**           | Wait for in-flight semaphore drain. Falls back to force-requeue on timeout so the pool never silently exits under live work.                                                              |

Both modes return a `ShutdownResult`: `{ mode, timedOut, unfinishedJobs, requeued }`.

## Runtime and Registry Support

- **Runtimes:** Node 22+, Bun, and Deno
- **Languages:** JavaScript and TypeScript
- **Registries:** npm and JSR
- **Modules:** ESM only
- **Redis:** 7+ (uses `HEXISTS`, `ZMSCORE`, and `TIME`)

## Workspace

One TypeScript source tree, built for npm with [tsdown](https://tsdown.dev) and
published unchanged to JSR. Tasks are orchestrated by [pnpm](https://pnpm.io)
workspaces and releases by [Release Please](https://github.com/googleapis/release-please).

```
packages/        Published packages — core, config, client, worker
apps/docs/       Documentation site (Waku + Fumadocs)
demo/            Demo scripts (Deno)
benchmarks/      BullMQ comparison benchmarks
```

### Common commands

```sh
pnpm install        # Install dependencies
pnpm build          # Build every package with tsdown (ESM + .d.ts)
pnpm typecheck      # Typecheck every package
pnpm test           # Run the Vitest suite on Node
pnpm smoke:bun      # Smoke-test the built artifacts on Bun
pnpm smoke:deno     # Smoke-test the built artifacts on Deno
pnpm docs:dev       # Dev server for the docs site
```

pnpm runs these across the workspace in dependency order (`pnpm -r`).

### Demo

The demo requires Redis (see `demo/docker-compose.yml`) and runs on Deno
against the built packages (run `pnpm build` first):

```sh
deno task --cwd demo enqueue   # Enqueue sample jobs
deno task --cwd demo worker    # Process them
```

## Documentation

- [SPEC.md](./docs/SPEC.md) — Authoritative library specification
- [DECISIONS.md](./docs/DECISIONS.md) — Design decision log

## License

MIT
