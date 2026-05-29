#!/usr/bin/env node
// Generate each package's jsr.json (from package.json) and publish source to
// JSR in dependency order, so a package's `jsr:@panqueue/*` siblings already
// exist when it is published. Runs `jsr publish` (npx) which uses GitHub OIDC
// for authentication in CI.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Dependency order: core has no deps; config depends on core; client/worker
// depend on core + config.
const order = ["core", "config", "client", "worker"];

execFileSync("node", ["scripts/gen-jsr-json.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
});

for (const pkg of order) {
  console.log(`\n=== Publishing @panqueue/${pkg} to JSR ===`);
  execFileSync("npx", ["jsr", "publish", "--allow-dirty"], {
    cwd: fileURLToPath(new URL(`packages/${pkg}/`, import.meta.url)),
    stdio: "inherit",
  });
}
