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

- [ ] Fix enqueue identity semantics.
  - v0.1 job IDs are generated and owned by panqueue.
  - Remove or reject user-provided `jobId`.
  - Make enqueue atomically reject ID collisions instead of overwriting existing
    job data.

- [ ] Reject unsupported delayed jobs.
  - `delay` is not part of v0.1.
  - Remove it from the v0.1 public type or throw clearly when it is provided.
  - Keep retry backoff rejected until delayed retry scheduling exists.

- [ ] Make missing job data handling non-lossy.
  - The claim script must not permanently drop a waiting-list entry when its job
    hash is missing.
  - Decide whether corrupted entries are left in place, moved to a dead/corrupt
    set, or repaired by a cleanup path.

## v0.1 API Alignment

- [ ] Align `QueueClient` with the single producer API.
  - Keep `client.enqueue(queueId, payload, options?)` as the only producer
    operation.
  - Support both shared `PanqueueConfig` and standalone custom connection
    config.
  - Panqueue owns the underlying Redis client instance. Users pass connection
    config, not a Redis client object.

- [ ] Implement `defineWorker` for pure worker definitions.
  - `defineWorker(config, queueId, processor, options?)` captures a typed
    processor and worker-only options.
  - Worker definitions open no Redis connections and own no lifecycle.
  - Worker definitions do not accept Redis connection overrides.

- [ ] Implement `WorkerPool` as the consumer lifecycle boundary.
  - `register(workerDefinition)` registers a worker definition.
  - `register(workerDefinitions)` registers an array of worker definitions.
  - `register(queueId, processor, options?)` remains available as compact
    single-file shorthand.
  - `WorkerPool` creates and reuses the worker-side Redis instances for all
    registered worker definitions based on its connection config.

## Release Quality

- [ ] Add/adjust tests for every v0.1 correctness guarantee above.
- [ ] Keep docs, code, and examples aligned with the v0.1 API.
- [ ] Fix formatting, lint, and JSR dry-run issues before publishing.
