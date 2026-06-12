# Releasing

Releases are fully automated. There is no manual versioning or tagging.

## How it works

1. Merge PRs to `main` using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor(scope)!:`, …).
2. [Release Please](https://github.com/googleapis/release-please) keeps a **release PR** open that accumulates changes, bumps versions, and updates changelogs. Versioning uses the `always-bump-patch` strategy: every release bumps only the patch component (`0.0.x`), regardless of commit types, until we decide to leave `0.0.*`.
3. Merging the release PR creates per-package tags (`core-vX.Y.Z`, …) and GitHub Releases, then the `publish` job in [`release.yml`](.github/workflows/release.yml) publishes the bumped packages:
   - **npm** — `pnpm -r publish` via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no token) with provenance attestations. pnpm publishes in dependency order and skips versions already on npm.
   - **JSR** — `jsr publish` per package via GitHub OIDC, using `jsr.json` files generated from each `package.json` (`pnpm gen:jsr`).

The `node-workspace` plugin cascades bumps: releasing `core` also patch-bumps `config`/`client`/`worker` so their `workspace:*` ranges resolve to published versions.

## One-time registry setup

### npm

The CI workflow has no npm token — it relies entirely on trusted publishing. Trusted publishers can only be configured on packages that already exist, so the **first version of each package is published manually from a local machine**:

1. Create the `panqueue` org/scope on [npmjs.com](https://www.npmjs.com) (or ensure you own `@panqueue`).
2. From a clean checkout: `pnpm install && pnpm build`, then `npm login` and

   ```sh
   NPM_CONFIG_PROVENANCE=false pnpm --filter "./packages/*" -r publish --access public
   ```

   pnpm handles dependency order and rewrites `workspace:*` ranges. The env var overrides `publishConfig.provenance` — provenance can only be generated in CI, so a local publish fails without it.

3. Configure a **trusted publisher** for each package at `https://www.npmjs.com/package/@panqueue/<name>/access`:
   - Provider: GitHub Actions
   - Repository: `50BytesOfJohn/panqueue`
   - Workflow filename: `release.yml`
   - Allowed actions: `npm publish`

From then on, CI publishes token-free via OIDC.

### JSR

1. Create the `@panqueue` scope on [jsr.io](https://jsr.io).
2. Create the four packages (`core`, `config`, `client`, `worker`).
3. In each package's settings, **link the GitHub repository** `50BytesOfJohn/panqueue`. This enables tokenless OIDC publishing from GitHub Actions (the workflow already grants `id-token: write`).

### GitHub (optional but recommended)

The release PR is created with the default `GITHUB_TOKEN`, which cannot trigger other workflows — so CI checks won't run on it. To get CI on release PRs, create a fine-grained PAT scoped to this repo with **Contents: read/write** and **Pull requests: read/write**, and add it as the `RELEASE_PLEASE_TOKEN` secret.

## Manual escape hatch

If a publish fails mid-run (e.g. npm succeeded but JSR failed), re-run the failed `publish` job from the Actions tab — npm skips already-published versions, and the JSR steps are gated per package.
