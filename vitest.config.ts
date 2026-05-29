import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

/**
 * Authoritative Node test suite. Tests run against package *source* (not the
 * built artifact): `@panqueue/*` specifiers are aliased to each package's
 * `mod.ts`, so the suite needs no prior build. The built/packed artifact is
 * exercised separately by the Bun and Deno smoke tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@panqueue/core": fromRoot("./packages/core/mod.ts"),
      "@panqueue/config": fromRoot("./packages/config/mod.ts"),
      "@panqueue/client": fromRoot("./packages/client/mod.ts"),
      "@panqueue/worker": fromRoot("./packages/worker/mod.ts"),
      "@test/std": fromRoot("./test/std-compat.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*_test.ts"],
    environment: "node",
  },
});
