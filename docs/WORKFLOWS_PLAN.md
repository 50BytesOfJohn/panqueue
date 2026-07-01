# Workflows — Design Plan

> Status: exploratory design notes, captured from a brainstorm session.
> This is not a final spec. Settled parts should later move into `SPEC.md`,
> and dated rationale into `DECISIONS.md`.

## Motivation

Real applications often outgrow a plain queue. They need to coordinate several
jobs, pass state between them, fan out over dynamic data, wait for children to
finish, branch based on results, and recover from failures.

Panqueue already owns the hard queue mechanics: job delivery, workers,
concurrency, retries, backoff, stalled-job recovery, cleanup, and shared worker
pools. Workflows should not reimplement those things.

The goal is to add a workflow layer that coordinates normal Panqueue queues while
keeping the queue system itself small, reusable, and workflow-unaware.

## Core idea

A workflow is a durable coordination layer over normal queue jobs.

Panqueue queues remain responsible for execution:

- enqueueing jobs
- running workers
- retries and backoff
- concurrency limits
- stalled-job recovery
- dead-letter / failure behavior
- job cleanup

The workflow package is responsible for coordination:

- workflow run identity
- replaying workflow code
- step journal
- step outputs
- fan-out / fan-in barriers
- workflow history and inspection
- per-run serialization
- recovery decisions

The important boundary is:

> Workflow state is the source of truth for workflows. Queue state is the source
> of truth for queue execution.

A queue job may be deleted after completion. The workflow must not depend on
completed job retention.

## Queue-first step model

Workflow steps are normal Panqueue queues.

Users define queues normally in shared Panqueue config. A workflow references
those queues by name:

```ts
const workflow = defineWorkflow("image-flow", async (ctx) => {
  const prepared = await ctx.run("prepare-image", {
    imageId: ctx.data.imageId,
  });

  const resized = await ctx.run("resize-image", {
    imageId: prepared.imageId,
    width: 1024,
  });

  await ctx.run("notify-user", {
    userId: ctx.data.userId,
    imageId: resized.imageId,
  });
});
```

`prepare-image`, `resize-image`, and `notify-user` are not special workflow
steps. They are normal Panqueue queues with normal workers.

This avoids a second definition system. There are no separate “workflow step
handlers” to register. A workflow step is simply a queue job used by a workflow.

## `ctx.run`

`ctx.run(queueName, payload, options?)` means:

> enqueue a normal Panqueue job, wait durably for its result, and resume the
> workflow when the job completes.

It does not mean “execute this function inline”. It does not wrap arbitrary local
code. It is queue-backed by design.

Internally, `ctx.run`:

1. creates or finds a journal entry for the step
2. enqueues a normal Panqueue job if the step has not been dispatched yet
3. attaches workflow correlation metadata to the job
4. forces a reliable completion event for that job
5. suspends the workflow turn
6. returns the journaled result on replay once the job has completed

The basic form is:

```ts
const result = await ctx.run("resize-image", payload);
```

If the same queue is used multiple times in one workflow, the user must provide a
stable key:

```ts
const small = await ctx.run("resize-image", smallPayload, { key: "small" });
const large = await ctx.run("resize-image", largePayload, { key: "large" });
```

The workflow step identity is derived from:

```txt
workflow name + workflow version + run id + queue name + optional key
```

Repeated use of the same queue name without a unique key should throw a clear
error.

## `ctx.map`

`ctx.map` is the workflow primitive for fan-out / fan-in.

It enqueues many normal Panqueue jobs, waits for all required children to finish,
and returns their results.

```ts
const results = await ctx.map(
  "process-image",
  images,
  {
    key: (image) => image.id,
    input: (image) => ({ imageId: image.id }),
    parallelism: 5,
  },
);
```

The queue still owns global execution behavior. `ctx.map` only adds the local
workflow barrier and local parallelism window.

There are three separate concurrency concepts:

- queue concurrency: global ceiling for that queue across all producers and runs
- map parallelism: local window for one map call in one workflow run
- workflow pool concurrency: how many distinct workflow runs can advance at once

These should be documented separately because they solve different problems.

## Completion events

The workflow layer must get the result or error from a job before the queue job
is removed.

Panqueue core should not need workflow-specific concepts. It only needs a generic
capability:

> a job can request a reliable completion event that includes status, result or
> error, and user metadata.

For workflow-enqueued jobs, the workflow package automatically enables this
option and attaches correlation metadata:

```ts
await queue.add("resize-image", payload, {
  metadata: {
    workflowRunId,
    workflowStepId,
    workflowDispatchId,
  },
  completion: {
    event: true,
    includeResult: true,
  },
});
```

This is still generic queue behavior. The queue does not know what a workflow is.
It only emits a durable lifecycle event.

The workflow package consumes that event:

```txt
job completes
→ queue emits completion event with result/error + metadata
→ workflow consumer writes result/error into workflow store
→ workflow run is woken for another replay turn
→ queue job can be removed normally
```

This makes `removeOnComplete` compatible with workflows. Completed queue jobs do
not need to stay around, because the workflow has copied the result into its own
state.

Redis Streams are a natural fit for these lifecycle events because they are
reliable and can be consumed at least once. Pub/Sub is not enough because events
can be missed.

The workflow consumer should acknowledge the completion event only after the
workflow store has recorded the result.

## Workflow store

Workflow state should not be stored only in completed queue jobs.

The workflow package owns a workflow store. The first implementation may use
Redis / Valkey, but the design should allow adapters:

```ts
workflowStore: new RedisWorkflowStore(...)
workflowStore: new PostgresWorkflowStore(...)
workflowStore: new SQLiteWorkflowStore(...)
```

The store contains:

- run state
- current status
- step journal
- step results and errors
- dispatch state
- map/barrier state
- workflow history
- retention metadata

This makes workflows more durable and inspectable than queue jobs. It also keeps
Panqueue queues optimized for fast execution rather than long-lived business
history.

## Replay model

A workflow function is a replayed decision function.

The function is re-run from the top whenever the workflow needs to advance. Each
`ctx.run` or `ctx.map` checks the workflow journal:

- step already completed → return stored result
- step already dispatched → suspend and wait
- step not seen before → record intent, dispatch job, suspend

This avoids serializing suspended JavaScript closures. The current position is
rebuilt from journaled state.

## Determinism rule

Replay means normal code in the workflow body may run multiple times.

Therefore:

> Pure transforms are fine anywhere. Impure work must go through `ctx` or a queue
> job.

Safe:

```ts
const normalized = normalizeInput(ctx.data);
const ids = prepared.items.map((item) => item.id);
```

Unsafe:

```ts
const now = Date.now();
const id = crypto.randomUUID();
const response = await fetch(url);
```

Arguments are evaluated before `ctx.run`, so this is also unsafe:

```ts
await ctx.run("charge", { at: Date.now() });
```

Use durable helpers instead:

```ts
const now = await ctx.now("started-at");
const id = await ctx.uuid("request-id");
```

A possible future helper for expensive pure computation is `ctx.memo`, but it
should not be part of the core mental model. Cheap pure code can simply rerun.

```ts
const normalized = ctx.memo("normalize-input", () => {
  return expensivePureTransform(ctx.data);
});
```

## Determinism detection

The workflow layer should detect obvious replay divergence loudly.

If a replay produces a different step sequence, different step identity, or a
duplicate unkeyed step, the workflow should throw a clear error instead of
silently corrupting the run.

Example:

```txt
DuplicateStepError: queue "resize-image" was used more than once in this run
without a key. Pass { key } or use ctx.map for collections.
```

This is especially important because workflow code will often be edited by both
humans and AI agents.

## Workflow versioning

A run should record the workflow version it started with.

Replay against changed code can break active runs. Versioning is the clean way to
avoid accidental corruption during deployments.

Possible shape:

```ts
defineWorkflow({
  name: "image-flow",
  version: 1,
  run: async (ctx) => {
    // ...
  },
});
```

Active runs continue using the version they started with. New runs use the new
version.

This does not need to be fancy in the first implementation, but the design should
not ignore it.

## Orchestrator

The orchestrator is the workflow brain.

It does not execute step work directly. It advances workflow runs by replaying
workflow code and deciding which queue jobs should be dispatched next.

The orchestrator owns:

- replay
- journal reads/writes
- dispatch decisions
- map window advancement
- run wakeups
- recovery checks

Workers own actual job execution.

A better public framing than “centralized brain” is:

> single writer per run, horizontally scalable across runs.

Only one orchestrator turn may mutate a given run at a time. Many different runs
may advance in parallel.

## Per-run serialization

A workflow run must be advanced one turn at a time.

When several child jobs complete at nearly the same time, they may all wake the
same run. The orchestrator must avoid concurrent replays mutating the same run
state.

This requires either:

- a per-run lock with fencing token, or
- partitioning orchestrator work by `runId` so the same run is only active in one
  place at a time

A plain expiring lock is not enough if an old orchestrator can wake up and write
stale state after the lock has moved to another process. Mutations should be
protected by ownership/fencing.

## Recovery model

The workflow store should allow recovery from partial failures.

Examples:

- step recorded as planned but enqueue failed
- job enqueued but dispatch state was not fully written
- job completed but completion event was not processed yet
- orchestrator crashed after processing a completion but before replaying
- map child completed twice due to at-least-once delivery

The workflow state machine should make these transitions idempotent.

A rough step state model:

```txt
planned -> dispatched -> completed
                    \-> failed
```

The exact state names can change, but the workflow store should be able to tell
what was intended, what was dispatched, and what result was recorded.

## Runtime pieces

The runtime has four pieces:

1. normal Panqueue queues and workers
2. workflow client for starting runs
3. workflow store for durable run state
4. workflow orchestrator for replay and advancement

Example shape:

```ts
const workflows = new WorkflowsPool({
  redis,
  queues,
  workflowStore,
  workflows: [imageFlow],
});

await workflows.start();
```

Starting a workflow should feel producer-shaped:

```ts
const run = await workflowClient.start("image-flow", {
  imageId: "img_123",
});
```

The returned handle can later be used for status and inspection.

## Deployment

The orchestrator should have its own lifecycle, but it should be easy to run it
next to normal workers in small deployments.

Default small deployment:

```txt
app process
- worker pool
- workflow orchestrator pool
```

Scaled deployment:

```txt
worker processes
- many normal Panqueue workers

orchestrator processes
- fewer workflow orchestrators
```

This gives the workflow layer room for different scaling, failure isolation, and
per-run serialization without changing how step workers operate.

## Public package

Workflows should live in a separate opt-in package:

```txt
@panqueue/workflow
```

Users who only need queues should not pay for workflow state, workflow events,
or orchestration logic.

The workflow package depends on Panqueue core behavior but keeps workflow state
and semantics outside of core queues.

## Human and AI developer experience

The public mental model should be simple:

> Define queues normally. Use them from workflows. Workflows add durable
> coordination, not a second job system.

Good examples should prefer boring code:

```ts
const prepared = await ctx.run("prepare-image", input);
const processed = await ctx.map("process-image", prepared.images, {
  key: (image) => image.id,
  input: (image) => ({ imageId: image.id }),
  parallelism: 5,
});
await ctx.run("finalize-image", { processed });
```

Docs should be explicit that workflow code replays and that impure work outside
`ctx` is unsafe.

Error messages should be instructional, because humans and AI agents will both
make determinism mistakes.

## Open questions

- Exact completion event API name and shape.
- Whether completion events are public queue API or internal-but-generic support.
- Exact workflow store interface.
- Redis-first vs Postgres-first workflow store implementation.
- Exact `ctx.map` failure policy options.
- Whether map results are always returned in input order.
- How much workflow history is retained by default.
- How workflow versioning is exposed in the first release.
- Whether `ctx.memo` is worth including early or should remain deferred.
- Whether timers/sleeps/events belong in the first workflow version.

## Summary

Panqueue workflows should coordinate normal Panqueue queues, not replace them.

Queues stay workflow-unaware and continue to own execution mechanics. Workflows
own durable run state, step journals, barriers, replay, and recovery.

`ctx.run` enqueues a normal queue job and waits durably for its result.
`ctx.map` does the same for many jobs and adds a barrier.

Workflow-enqueued jobs automatically request reliable completion events with
result/error and correlation metadata. The workflow layer consumes those events,
copies results into its own store, and wakes the orchestrator. Completed queue
jobs can then be removed normally.

The clean boundary is:

> Panqueue is the execution engine. Workflows are the durable coordination layer.
