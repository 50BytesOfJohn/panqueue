# Panqueue

Panqueue is a modern, runtime-agnostic queue library that ships first-class on
Node, Bun, and Deno from one TypeScript source tree (published to npm and JSR).

# Development

Please note that library is not released yet. This means that we do not need
backward compatibility. Trying to do not break current logic can lead to over
complicated solutions, so remember that this is not needed. Make breaking
changes, change core stuff if needed.

- We use clean and readable code
- We focus on performance, queue library needs to be fast and light
- We want to follow modern best practices and language APIs to get most of the
  runtime
- DX is crucial part of Panqueue
- We add comments to make logic and decisions clear for contributors, as well as
  good JS docs for developers integrating Panqueue
- We do not over engineer. Simplicity and balance. Sometimes perfect code is not
  necessery.
- Never use `as any` or `as unknown` hacks. All types should be proper and nice
  and work together.
- Avoid adding comments in code with decision making, all comments should be
  minimal, simple clean and clear, no historical data, or bloating comments
- In docs, always keep the current shape of what we decided. No bloat of, why we
  won't use other thing etc. Just the clean and clear current state of art.

# Notes

- Redis connection is intentionally duplicated in worker and client, and not shared via core or shared package.

# Codex

- Always run pnpm and other commands that requires network outside of sandbox, otherwise it won't work and can break things.
