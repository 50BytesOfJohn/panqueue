# Releasing

This repository uses `@deno/bump-workspaces` for versioning and trusted publishing to JSR.

## One-time setup (JSR)

1. Create the packages on JSR (`@panqueue/client` and `@panqueue/worker`) if they do not exist.
2. Link each package to this GitHub repository in JSR package settings.
3. Ensure GitHub Actions are enabled for this repository.

## Versioning flow

1. Run the `Version Bump` workflow from GitHub Actions.
2. Choose `patch`, `minor`, or `major`.
3. The workflow updates workspace versions and opens a PR.
4. Merge that PR into `main`.

## Publishing flow

- `Publish to JSR` runs on push to `main` only when `packages/*/deno.json` changes.
- The workflow checks which workspace package `version` fields changed before publishing.
- This means regular fix/ticket merges do not trigger unnecessary publish attempts.
- Publishing uses GitHub OIDC (`id-token: write`) and does not require storing a long-lived JSR token.
- After a successful publish, the workflow creates/updates GitHub Releases for each bumped package using tags like `client-v1.2.3` and `worker-v1.2.3`.

## GitHub Releases

- GitHub Releases are created automatically only for package version bumps.
- Release notes are generated with `mikepenz/release-changelog-builder-action`.
- Changelog generation is filtered to changed files under each package path (`includeOnlyPaths`), so each package release only contains relevant entries.
- Release entries are grouped by PR labels (breaking changes, features, fixes, docs, maintenance).
- Re-running the workflow is safe: existing release tags are updated.

## PR label recommendations for cleaner notes

- Use one of these labels on release-worthy PRs when possible: `breaking`, `feature`, `fix`, `documentation`, `chore`, `refactor`, `dependencies`, `ci`.
- Use `skip-changelog` for PRs that should not appear in release notes.
