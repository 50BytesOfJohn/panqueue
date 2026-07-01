# TODO

Focused v0.1 TODO list from the current review and product decisions.

## Correctness

- [x] Add job leases and stalled job recovery.
  - Claiming a job must create a recoverable lease/lock.
  - A crashed worker or failed acknowledgement must not strand jobs in `active`.
  - Recovery must be atomic and safe when multiple workers sweep at the same
    time.

- [x] Make shutdown semantics explicit for v0.1.
  - Default is force shutdown: stop claiming, atomically requeue every in-flight
    job (so another worker can pick it up immediately, no waiting on the lease
    clock), then disconnect.
  - Drain mode is opt-in via `shutdown({ drain: true, timeout? })`. A drain
    timeout escalates to force-requeue rather than disconnecting silently under
    live work.
  - Inversion of the 2026-04-29 plan: with leases + recovery in place, force is
    safe and avoids the deployment-hang footgun on long jobs. Cooperative
    cancellation (AbortSignal in processors) is deferred.

- [x] Fix enqueue identity semantics.
  - v0.1 job IDs are generated and owned by panqueue.
  - Remove or reject user-provided `jobId`.
  - Make enqueue atomically reject ID collisions instead of overwriting existing
    job data.

- [x] Reject unsupported delayed jobs.
  - `delay` is not part of v0.1.
  - Removed from `JobOptions` along with `backoff` so the public type does not
    advertise scheduling features the runtime cannot honour.

- [x] Add finished-job retention so Redis does not grow without bound.
  - Completed jobs are deleted on success by default; failed jobs are kept as a
    bounded dead-letter (`ttl` 7 days / `count` 1000 by default).
  - Eviction runs inline in the complete/fail/recover Lua scripts.
  - Failure analytics are out of scope: the worker event hooks are the
    documented path to Sentry/PostHog/logs.

- [x] Make missing job data handling non-lossy.
  - A corrupt job (pointer survived, hash gone) is surfaced once via
    `onWorkerError` with `kind: "corrupt"`; the pointer is removed and the
    claim loop continues without parking. Durable capture is the developer's
    via the event — no core-owned dead-letter store.

## v0.1 API Alignment

- [x] Align `QueueClient` with the single producer API.
  - `client.enqueue(queueId, payload, options?)` is the only producer operation.
    Supports both shared `PanqueueConfig` and standalone custom connection
    config. Panqueue owns the underlying Redis client; users pass connection
    config, not a Redis client object.

- [x] Implement `defineWorker` for pure worker definitions.
  - `defineWorker(config, queueId, processor, options?)` captures a typed
    processor and worker-only options. Definitions open no Redis connections and
    own no lifecycle.

- [x] Implement `WorkerPool` as the consumer lifecycle boundary.
  - The pool accepts an array of worker definitions at construction time.
  - The pool creates and reuses the worker-side Redis instances (one command
    client and one subscriber) for every registered queue.

## Release Quality

- [ ] Add/adjust tests for every v0.1 correctness guarantee above.
- [ ] Keep docs, code, and examples aligned with the v0.1 API.
- [ ] Fix formatting, lint, and JSR dry-run issues before publishing.
