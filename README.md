# Panqueue

A Redis-backed queue library for Deno.

Panqueue is currently pre-release. The v0.1 API direction is:

- define shared queue config with `definePanqueueConfig`
- enqueue through a `QueueClient`
- define processors with `defineWorker`
- run processors through a `WorkerPool`

Panqueue owns Redis client instances internally. Users pass Redis connection
configuration; `QueueClient` creates the producer connection and `WorkerPool`
creates the worker-side connections for all registered worker definitions.

## Packages

- `@panqueue/client` - Client library
- `@panqueue/worker` - Worker library

## Workspace

- Deno packages are managed via the Deno workspace in `/deno.json` under
  `packages/*`
- Node apps/packages are managed via `pnpm` workspace under `apps/*` and
  `packages-node/*`

### Common Commands

- `pnpm install`
- `pnpm docs:dev`
- `pnpm docs:typecheck`
- `pnpm docs:build`
- `deno task version:bump:dry-run`

## License

MIT
