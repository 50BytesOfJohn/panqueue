# Contributing

Thanks for helping improve Panqueue.

Panqueue is pre-release, so API changes are welcome when they make the library
faster, simpler, or easier to use.

## Setup

```sh
pnpm install
```

## Common Commands

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm smoke:bun
pnpm smoke:deno
pnpm docs:build
```

The Bun and Deno smoke tests expect built package output, so run `pnpm build`
first.

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Update docs when public APIs or workflows change.
- Use clear names and readable TypeScript types.
- Avoid `as any` and `as unknown` type escapes.

## Issues

Use bug reports for broken behavior and feature requests for API or workflow
improvements. Security reports should use private vulnerability reporting.
