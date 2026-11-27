#!/usr/bin/env node
// Bundles the integration suite into test-integration/dist/ (git- and lint-ignored):
//
// - suite.cjs: what the extension host loads with --extensionTestsPath. CommonJS, because the
//   host require()s it; `vscode` is left to the host. It must stay inside this package's
//   folder: the host gives modules loaded from an extension's folder that extension's API
//   object, which is what lets the suite watch the extension (see spies.ts).
// - run.mjs: the launcher, an ES module for Node. Packages stay external and are loaded from
//   node_modules; only this package's own TypeScript is bundled.
//
// No source maps: they would carry build paths.

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const integrationDir = dirname(fileURLToPath(import.meta.url));

/**
 * The esbuild options of both bundles, for the integration folder `dir`.
 * @param {string} dir the test-integration folder
 * @returns {{ suite: import("esbuild").BuildOptions, launcher: import("esbuild").BuildOptions }}
 */
export function integrationBuildOptions(dir) {
  const common = {
    absWorkingDir: resolve(dir, ".."),
    bundle: true,
    platform: /** @type {const} */ ("node"),
    target: "node20",
    sourcemap: false,
    logLevel: /** @type {const} */ ("warning"),
  };
  return {
    suite: {
      ...common,
      entryPoints: [join(dir, "suite.ts")],
      outfile: join(dir, "dist", "suite.cjs"),
      format: "cjs",
      external: ["vscode"],
    },
    launcher: {
      ...common,
      entryPoints: [join(dir, "run.ts")],
      outfile: join(dir, "dist", "run.mjs"),
      format: "esm",
      target: "node22",
      packages: "external",
    },
  };
}

async function main() {
  try {
    rmSync(join(integrationDir, "dist"), { recursive: true, force: true });
    const options = integrationBuildOptions(integrationDir);
    await build(options.suite);
    await build(options.launcher);
    console.log("test-integration: bundled dist/suite.cjs and dist/run.mjs");
  } catch (error) {
    console.error(`test-integration: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
