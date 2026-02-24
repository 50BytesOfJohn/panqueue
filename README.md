# Panqueue

A Deno queue library.

## Packages

- `@panqueue/client` - Client library
- `@panqueue/worker` - Worker library

## Workspace

- Deno packages are managed via the Deno workspace in `/deno.json` under `packages/*`
- Node apps/packages are managed via `pnpm` workspace under `apps/*` and `packages-node/*`

### Common Commands

- `pnpm install`
- `pnpm docs:dev`
- `pnpm docs:typecheck`
- `pnpm docs:build`
- `deno task version:bump:dry-run`

## License

MIT
