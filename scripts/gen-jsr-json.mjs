#!/usr/bin/env node
// Generate a `jsr.json` for each public package from its `package.json`.
//
// `package.json` is the single source of truth for name + version (Release
// Please bumps it). JSR reads version from `jsr.json`, so we derive it here at
// publish time to keep the two registries in lock-step. Note the two `exports`
// definitions point at *different* targets on purpose:
//   - package.json#exports -> built `dist/*.js` (npm artifact)
//   - jsr.json#exports      -> source `./mod.ts` (JSR publishes source)
//
// The bare specifiers the source uses (`@panqueue/*`, `redis`) are mapped into
// jsr.json#imports so JSR resolves siblings as `jsr:` and externals as `npm:`.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packagesUrl = new URL("../packages/", import.meta.url);
const entries = await readdir(fileURLToPath(packagesUrl), {
  withFileTypes: true,
});

// First pass: read every package.json (name -> { version, pkg, dir }).
const packages = new Map();
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = new URL(`${entry.name}/`, packagesUrl);
  try {
    const pkg = JSON.parse(await readFile(new URL("package.json", dir), "utf8"));
    if (pkg.private) continue;
    packages.set(pkg.name, { version: pkg.version, pkg, dir });
  } catch {
    // no package.json -> not a publishable package
  }
}

// Second pass: emit jsr.json with a resolved imports map.
const generated = [];
for (const { version, pkg, dir } of packages.values()) {
  const imports = {};
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (packages.has(dep)) {
      imports[dep] = `jsr:${dep}@^${packages.get(dep).version}`;
    } else {
      // workspace specifiers never reach here; pass npm ranges through as-is.
      imports[dep] = `npm:${dep}@${range}`;
    }
  }

  const jsr = {
    name: pkg.name,
    version,
    license: pkg.license ?? "MIT",
    exports: "./mod.ts",
    ...(Object.keys(imports).length > 0 ? { imports } : {}),
    publish: {
      exclude: [
        "tsconfig.json",
        "tsdown.config.ts",
        "moon.yml",
        "dist",
        "node_modules",
      ],
    },
  };

  await writeFile(
    new URL("jsr.json", dir),
    JSON.stringify(jsr, null, 2) + "\n",
  );
  generated.push(`${pkg.name}@${version}`);
}

console.log(`Generated jsr.json for: ${generated.join(", ") || "(none)"}`);
