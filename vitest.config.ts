import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Authoritative Node test suite. Tests run against package *source* (not the
 * built artifact): `@panqueue/*` specifiers are aliased to each package's
 * `index.ts`, so the suite needs no prior build. The built/packed artifact is
 * exercised separately by the Bun and Deno smoke tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@panqueue/core": fromRoot("./packages/core/index.ts"),
      "@panqueue/config": fromRoot("./packages/config/index.ts"),
      "@panqueue/client": fromRoot("./packages/client/index.ts"),
      "@panqueue/worker": fromRoot("./packages/worker/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
