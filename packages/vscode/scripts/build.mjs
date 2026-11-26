#!/usr/bin/env node
// Builds the extension into dist/ (npm run build):
//
// 1. syncs the copied assets (scripts/sync-assets.mjs);
// 2. bundles src/extension.ts and everything it imports, @orbitrace/core included, into one
//    CommonJS file, dist/extension.js. Core is ESM only and the extension host loads the entry
//    with require(), so the bundler does the conversion. `vscode` stays external: the host
//    provides it. No source maps: they would carry build paths and are not shipped;
// 3. copies the built web app into dist/app (scripts/copy-app.mjs).

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { copyAppBundle } from "./copy-app.mjs";
import { ASSETS, syncAssets } from "./sync-assets.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The esbuild options for the extension entry, for a package folder.
 * @param {string} dir the package folder
 * @returns {import("esbuild").BuildOptions}
 */
export function esbuildOptions(dir) {
  return {
    absWorkingDir: dir,
    entryPoints: [join(dir, "src", "extension.ts")],
    outfile: join(dir, "dist", "extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    // VS Code 1.96, the lowest version in engines.vscode, runs extensions on Node 20.
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    minify: false,
    legalComments: "eof",
    logLevel: "warning",
  };
}

async function main() {
  try {
    const updated = syncAssets(ASSETS);
    if (updated.length > 0) console.log(`build: synced ${updated.length} asset(s)`);
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });
    await build(esbuildOptions(packageDir));
    const copied = copyAppBundle(
      resolve(packageDir, "..", "app", "dist"),
      join(packageDir, "dist", "app"),
    );
    console.log(`build: bundled dist/extension.js and copied ${copied.length} app file(s)`);
  } catch (error) {
    console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
