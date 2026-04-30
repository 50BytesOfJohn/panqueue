# TODO

Focused v0.1 TODO list from the current review and product decisions.

## Correctness

- [x] Add job leases and stalled job recovery.
  - Claiming a job must create a recoverable lease/lock.
  - A crashed worker or failed acknowledgement must not strand jobs in `active`.
  - Recovery must be atomic and safe when multiple workers sweep at the same
    time.

- [ ] Make graceful shutdown truly graceful for v0.1.
  - Stop claiming new jobs.
  - Wait for in-flight jobs to finish before disconnecting Redis.
  - Do not silently disconnect under live work.
  - Leave any future forced shutdown as an explicit API.

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

- [ ] Implement `WorkerPool` as a tiny lifecycle/composition layer.
  - `register(queueId, processor, options?)` creates and registers a worker from
    pool config.
  - `register(worker)` registers a prebuilt worker.
  - `register(workers)` registers an array of prebuilt workers.
  - A prebuilt worker's own config wins; the pool only owns
    start/shutdown/health.

- [ ] Keep `Worker` usable independently from `WorkerPool`.
  - Support shared `PanqueueConfig`.
  - Support standalone custom connection config.
  - Starting and shutting down a single worker should not require a pool.

## Release Quality

- [ ] Add/adjust tests for every v0.1 correctness guarantee above.
- [ ] Keep docs, code, and examples aligned with the v0.1 API.
- [ ] Fix formatting, lint, and JSR dry-run issues before publishing.
