# Runtime-agnostic panqueue: plan & context

## Goal

Reposition panqueue from a Deno-first library to a runtime-agnostic job queue
that ships first-class on **Node, Bun, and Deno**, with future ports to other
languages (Rust first). One TypeScript source tree, published to **npm** and
**JSR**.

The strategy is **Node-first**: author standard Node/ESM TypeScript, build the
npm artifact with mainstream Node tooling, and publish the _same source_ to JSR
via `npx jsr publish`. Node and Bun are the larger audiences and get priority;
Deno is fully supported (it consumes the npm package directly, and JSR is added
on top).

## Why now

- The library code is already runtime-agnostic in behavior — it uses only the
  `redis` package and standard JS APIs (no `Deno.*`, no `node:*`).
- Restricting distribution to JSR caps reach for no technical reason; Node and
  Bun are the larger ecosystems.
- A small-runtime worker (edge / serverless) story is on the roadmap and needs
  Node/Bun-compatible packaging anyway.
- A polyglot future (Rust port, possibly others) needs release and task tooling
  that is not JS-specific.

## Why Node-first

Author standard Node/ESM TypeScript, treat the npm artifact as primary, and
publish the _same source_ to JSR via `npx jsr publish`. This is the inverse of a
Deno-first → npm pipeline (evaluated and rejected — see "Considered and
rejected"). Two facts make it work, both confirmed by hands-on spikes:

- **JSR accepts Node-native imports.** `npx jsr publish` runs on plain
  `package.json` projects (no Deno required) and published cleanly in dry-runs
  with both `.js`-extension (`from "./util.js"`) and extensionless relative
  imports. Slow-types are enforced only on the JSR side and are avoided for free
  by `isolatedDeclarations` (forces explicit public return types); they never
  touch the npm artifact.
- **tsdown builds the npm artifact correctly.** A spike (`core` + `worker` with a
  `workspace:*` sibling, external `redis`, and a `node:` builtin) confirmed it
  keeps dependencies external, emits ESM + oxc-generated `.d.ts`, auto-generates
  the `exports` map, and passes `publint` — in ~77ms. tsdown is also
  Vite+/VoidZero's official library bundler (same team as Vite/Rolldown/Oxc), a
  strong longevity signal. **unbuild** is the tested fallback.

## Current state (May 2026)

- Deno workspace at the repo root; per-package `deno.json` with
  `exports: "./mod.ts"` and a `publish.include` allowlist.
- Sources use Deno conventions: `.ts` relative imports, `jsr:@std/...` tests,
  `npm:redis@^5` specifier aliased in the import map, bare workspace imports.
- Releases: `@deno/bump-workspaces` opens a version PR; merge to `main` triggers
  `deno publish` to JSR via GitHub OIDC. No npm publishing.
- A pnpm workspace already exists (pnpm 10, Node 22) but `pnpm-workspace.yaml`
  only globs `apps/*` and a stale, empty `packages-node/*`; it does **not** yet
  include `packages/*`.
- `internal/` lives at the repo root (not under `packages/`). `demo/` is a
  member of the Deno workspace.
- Public packages today: `@panqueue/config`, `@panqueue/client`,
  `@panqueue/worker`. `@panqueue/internal` is private and re-exported through
  the public ones — it **will become a published package**.

## Decisions

| Topic                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoring model      | **Node-first.** Standard ESM TypeScript, `package.json` per package as the primary manifest, Node-native relative imports (`.js` extension or extensionless).                                                                                                                                                                                                                                                                       |
| Distribution         | Publish to **npm** (primary) and **JSR** (`npx jsr publish`, same source). Deno also works immediately via `npm:@panqueue/...`.                                                                                                                                                                                                                                                                                                     |
| npm build tool       | **tsdown** (Rolldown + Oxc). Emits ESM + oxc `.d.ts` + an explicit `exports` map; built-in `workspace` mode and `exports` auto-generation. **unbuild** is the tested fallback.                                                                                                                                                                                                                                                      |
| TypeScript version   | **TypeScript 6.0** (latest; `6.0.3` at time of spike). Verified clean under Node 25.                                                                                                                                                                                                                                                                                                                                                |
| Module format        | **ESM only.** Revisit CJS/UMD only on real demand.                                                                                                                                                                                                                                                                                                                                                                                  |
| Type declarations    | Real `.d.ts` generated by **oxc** (syntactic, fast, no `@types/node` needed). `isolatedDeclarations: true` forces explicit public return types, keeping the JSR side slow-types-clean; also set `verbatimModuleSyntax` + `isolatedModules`.                                                                                                                                                                                         |
| Package validation   | **publint** via tsdown's built-in `publint: "ci-only"` option (no separate tool invocation).                                                                                                                                                                                                                                                                                                                                        |
| `redis` dependency   | Plain `import … from "redis"` with `"redis": "^5"` declared in each consuming `package.json`. Drop the import-map alias.                                                                                                                                                                                                                                                                                                            |
| Intra-repo deps      | `@panqueue/*` referenced via **`workspace:*`**; the release tool rewrites these to real version ranges at publish time.                                                                                                                                                                                                                                                                                                             |
| `@panqueue/internal` | Rename to `@panqueue/core`, promote to a **public, published** package, consolidate shared types + helpers there.                                                                                                                                                                                                                                                                                                                   |
| Tests                | **Vitest** on **Node** as the authoritative primary suite (not a port). **Bun and Deno** are each covered by a smoke test that exercises the built/packed artifact on that runtime — symmetric treatment, since both consume the same npm package.                                                                                                                                                                                  |
| JSR config           | Each public package gets a `jsr.json` **generated from its `package.json`** (name, version, exports → source `.ts`) — `package.json` is the single source of truth, so the JSR version stays in sync with the npm version that Release Please bumps. `deno.json` is retired. (Note the two exports definitions are intentionally different targets: `package.json#exports` → built `dist/*.js`; `jsr.json#exports` → source `.ts`.) |
| Task runner          | **pnpm workspaces.** Recursive scripts (`pnpm -r`) run across packages in dependency order; publish scripts run sequentially in dependency order (core → config → client/worker).                                                                                                                                                                                                                                                   |
| Release tooling      | **Release Please.** Conventional-commits driven, language-agnostic. The `node-workspace` plugin propagates dependent bumps and rewrites intra-repo version refs; `cargo-workspace` + `linked-versions` extend the _same_ release PR to the planned Rust crate.                                                                                                                                                                      |
| Workspace manifest   | Expand `pnpm-workspace.yaml` to include `packages/*`; remove the dead `packages-node/*` glob. Intra-repo deps resolve via `workspace:*`.                                                                                                                                                                                                                                                                                            |

## Architecture after migration

```
panqueue/
├── packages/
│   ├── core/           # was: internal — now public, shared types + helpers
│   ├── config/
│   ├── client/
│   └── worker/         # each: package.json + jsr.json + tsconfig
├── apps/docs/
├── scripts/            # gen-jsr-json (jsr.json generated from package.json)
├── release-please-config.json
└── pnpm-workspace.yaml
```

For each public package:

- **Source** — standard Node/ESM TypeScript. Runs directly under Node, Bun, and
  Deno; importable across the workspace via `workspace:*`.
- **npm artifact** — built by `tsdown` into `dist/`: ESM `.js` + `.d.ts`, with an
  `exports` map and explicit `dependencies` from `package.json`.
- **JSR artifact** — published from the same source via `npx jsr publish`,
  driven by `jsr.json`.

## Migration plan

Ordered to keep `main` shippable to JSR throughout.

1. **Promote `internal` to `core`.**
   Move `internal/` → `packages/core/`. Audit the export surface; split "public
   core" (types, constants) from helpers that should stay unexported. Make it a
   public, published package. Rename across the workspace.
2. **Convert source to Node-first conventions.**
   Codemod relative imports `./x.ts` → `./x.js` (or extensionless). Replace the
   `npm:redis@^5` import-map alias with a plain `import … from "redis"`. Switch
   intra-repo imports to resolve via `workspace:*`.
3. **Add npm manifests + tsconfig.**
   Per public package: `package.json` (name, `type: module`, `exports`, real
   `dependencies` incl. `redis` and `workspace:*` siblings, `engines`) and a
   `tsconfig.json` extending a shared base with `module`/`moduleResolution`
   `nodenext`, `target`/`lib` `esnext`, and `isolatedDeclarations`,
   `isolatedModules`, `verbatimModuleSyntax` all `true`. Expand
   `pnpm-workspace.yaml` to `packages/*`; drop the dead `packages-node/*` glob.
4. **Migrate tests to Vitest.**
   Replace `jsr:@std/expect` and `jsr:@std/testing/mock`. Keep test files
   colocated and excluded from published artifacts. Vitest on Node is the
   authoritative suite; add lightweight Bun and Deno smoke tests that import the
   built/packed artifact and exercise the public API on each runtime.
5. **Add the tsdown build.**
   Per package, emit ESM + `.d.ts` to `dist/` (dts via oxc/`isolatedDeclarations`).
   Use tsdown's `exports: true` to auto-generate the `exports` map and tsdown's
   built-in `publint: "ci-only"` to validate each package. Verify the emitted
   package under both
   `moduleResolution: "nodenext"` and `"bundler"`.
6. **Adopt Release Please.**
   Manifest-driven config (`release-please-config.json` +
   `.release-please-manifest.json`) covering all public packages; enable the
   `node-workspace` plugin so dependent packages bump and `workspace:*` refs are
   rewritten to real ranges on publish. Retire `@deno/bump-workspaces`.
7. **Orchestrate with pnpm.**
   Root scripts: `test`, `build`, `typecheck`. `pnpm -r` runs recursive scripts
   across packages in dependency order, so `build` compiles siblings (e.g.
   `core` before `worker`) in the right order.
8. **Wire publishing in CI.**
   A single GitHub Actions `publish` job runs when Release Please creates any
   release (`releases_created == true`). **npm:** `pnpm -r publish` publishes in
   dependency order and skips any version already on the registry, so it
   publishes exactly the packages just bumped; going through pnpm (not bare
   `npm publish`) rewrites `workspace:*` to concrete version ranges, and
   provenance comes from GitHub OIDC (`id-token: write` + `NPM_CONFIG_PROVENANCE`).
   **JSR:** has no skip-if-published, so the job generates `jsr.json` from each
   `package.json` then runs `npx jsr publish` per package, each gated on Release
   Please's per-path `--release_created` output and ordered core → config →
   client/worker so `jsr:@panqueue/*` siblings already exist (also GitHub OIDC).
9. **Documentation.**
   Update README and docs to describe install paths for Node/Bun
   (`npm i @panqueue/...`) and Deno (`deno add npm:@panqueue/...` or
   `jsr:@panqueue/...`), and note ESM-only.

## Considered and rejected

Each was evaluated (most via hands-on spike) and ruled out:

| Option                                                           | Why not                                                                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deno-first → npm** (generate the npm package from Deno source) | Deriving npm output from Deno tooling broke dependencies and `.d.ts`; authoring Node-first removes the whole class of problems.                 |
| **`@deno/dnt`**                                                  | Effectively in maintenance (last release 2025-07-17), JSR-only, and needs a per-package build script.                                           |
| **`deno pack`**                                                  | Omits inter-workspace dependencies and `.d.ts` for slow-typed modules; its npm `dependencies` detection was fragile.                            |
| **Bun build** (as the bundler)                                   | Emits no declaration files, so it can't ship a typed library on its own.                                                                        |
| **rslib**                                                        | Generates `.d.ts` via project-mode `tsc`, which fails on a shared monorepo base tsconfig without extra `rootDir` config; heavier rspack engine. |
| **tsup**                                                         | Superseded by tsdown (its rolldown/oxc successor); the author steers users to tsdown.                                                           |
| **`@arethetypeswrong` (attw)**                                   | Unmaintained (no commits since 2025-06-10) and broken under Node 25 / TS 6 even on published packages.                                          |
| **CJS / UMD output**                                             | ESM-only by decision; dual-format adds artifact and `exports` complexity for no current demand.                                                 |
| **`@deno/bump-workspaces`**                                      | Replaced by Release Please — language-agnostic, extends to the planned Rust crate.                                                              |

## Non-goals

- No API redesign. Surface stays as-is apart from the `internal` → `core`
  rename.
- No Rust port in this milestone — only the tooling that _unblocks_ it later.
- No changes to the Redis protocol, Lua scripts, or queue semantics.
- No performance/benchmark suites in this milestone. _Future reference:_ a
  runtime-agnostic, separate perf suite run across all three runtimes
  (Node, Bun, Deno) — kept distinct from the correctness suites above.

## Risks and mitigations

- **JSR slow-types rules** still apply to the JSR artifact. Mitigation:
  `isolatedDeclarations: true` forces explicit public return types (lint-gated);
  CI gate on `npx jsr publish --dry-run`. `--allow-slow-types` is a fallback.
- **Import-style migration** (`.ts` → `.js`/extensionless) touching every file.
  Mitigation: codemod + typecheck + the existing test suite as a guard; verified
  both styles publish cleanly to JSR.
- **`workspace:*` not rewritten** to a real range on publish would ship broken
  deps. Two mechanisms cover this and must not be confused: Release Please's
  `node-workspace` plugin propagates dependent version bumps in the release PR,
  while **`pnpm publish` (per-package) rewrites the `workspace:*` specifier to a
  concrete range in the tarball** (`npm publish` does _not_). Mitigation: publish
  via pnpm; smoke-test the published tarball's `dependencies`.
- **JSR version drift from npm.** JSR reads the version from `jsr.json`, which
  Release Please does not bump. Mitigation: generate `jsr.json` from
  `package.json` at publish time, so the bumped npm version flows through.
- **Type-resolution drift** between npm `.d.ts` and JSR. Mitigation: smoke-test
  the emitted npm package under `moduleResolution: "nodenext"` and `"bundler"`
  (spike confirmed both resolve the tsdown output cleanly); run `publint` in CI;
  gate JSR on `--dry-run`.
- **Conventional-commits discipline.** Release Please derives bumps and
  changelogs from commit messages. Mitigation: the team already uses
  Conventional Commits; add a commit-lint check in CI to keep it consistent.

## Success criteria

- `npm i @panqueue/client` works on Node 22+ and Bun, with full types.
- `deno add npm:@panqueue/client` (and `jsr:@panqueue/client`) work.
- A single release PR ships matching versions to both registries.
- No source files contain registry- or runtime-specific shims.
- CI runs the full Vitest suite on Node, plus Bun and Deno smoke tests of the
  built artifact, on every PR.
- npm artifacts are published with provenance (verifiable on the npm package
  page).
