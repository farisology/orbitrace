#!/usr/bin/env node
// Builds the extension into dist/ (npm run build):
//
// 1. syncs the copied assets (scripts/sync-assets.mjs);
// 2. bundles src/extension.ts and everything it imports, @orbitrace/core included, into one
//    CommonJS file, dist/extension.js. Core is ESM only and the extension host loads the entry
//    with require(), so the bundler does the conversion. `vscode` stays external: the host
//    provides it. No source maps: they would carry build paths and are not shipped;
// 3. fails when anything from a third-party package ended up in that bundle, as the CLI build
//    does, so a new bundled dependency cannot ship without its licence being reviewed and noted
//    (#143). Today it holds only the extension and @orbitrace/core, whose Ajv validator is
//    generated code with no Ajv module in it;
// 4. copies the built web app into dist/app (scripts/copy-app.mjs), and fails when its script
//    bundles have no THIRD-PARTY-NOTICES.txt beside them (#143).

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { copyAppBundle, noticesProblem } from "./copy-app.mjs";
import { ASSETS, syncAssets } from "./sync-assets.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The esbuild options for the extension entry, for a package folder.
 * @param {string} dir the package folder
 * @returns {import("esbuild").BuildOptions & { metafile: true }}
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
    metafile: true,
    logLevel: "warning",
  };
}

/**
 * The inputs of a bundle that come from a third-party package: every input path with a
 * `node_modules` folder in it. Workspace packages are linked into node_modules, but esbuild
 * reports them by their real path (packages/<name>/...), so they are not counted.
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild's metafile
 * @returns {string[]} input paths, sorted
 */
export function thirdPartyInputs(metafile) {
  return Object.keys(metafile.inputs)
    .filter((path) => path.split(/[\\/]/).includes("node_modules"))
    .sort();
}

/**
 * Throw when a bundle took code from a third-party package.
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild's metafile
 */
export function assertFirstPartyOnly(metafile) {
  const thirdParty = thirdPartyInputs(metafile);
  if (thirdParty.length > 0) {
    throw new Error(
      `${thirdParty.length} file(s) from third-party packages were bundled into dist/extension.js. Review their licences, add them to NOTICE and to this check, or keep them out of the bundle.`,
    );
  }
}

async function main() {
  try {
    const updated = syncAssets(ASSETS);
    if (updated.length > 0) console.log(`build: synced ${updated.length} asset(s)`);
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });
    const result = await build(esbuildOptions(packageDir));
    assertFirstPartyOnly(result.metafile);
    const appDir = join(packageDir, "dist", "app");
    const copied = copyAppBundle(resolve(packageDir, "..", "app", "dist"), appDir);
    const problem = noticesProblem(appDir);
    if (problem) throw new Error(problem);
    console.log(`build: bundled dist/extension.js and copied ${copied.length} app file(s)`);
  } catch (error) {
    console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
