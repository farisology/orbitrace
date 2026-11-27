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
// 4. bundles the history ingest worker of @orbitrace/core (its package export
//    `@orbitrace/core/history-worker`, #188) as a second, separate CommonJS file,
//    dist/history-worker.js, beside dist/extension.js (#211). A worker thread starts from a file,
//    so it is never inlined into dist/extension.js; the extension finds it next to itself. The
//    same first-party check covers it;
// 5. copies the built web app into dist/app (scripts/copy-app.mjs), and fails when its script
//    bundles have no THIRD-PARTY-NOTICES.txt beside them (#143).

import { rmSync } from "node:fs";
import { createRequire } from "node:module";
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

/** The history worker's file, beside the extension (#188, #211), relative to the package folder. */
export const WORKER_FILE = "dist/history-worker.js";

/** The package export of core's history worker entry (core's `HISTORY_WORKER_EXPORT`). */
export const WORKER_EXPORT = "@orbitrace/core/history-worker";

/**
 * The file core's worker export resolves to from a package folder, through core's package
 * exports, as Node resolves it (symbolic links followed, so the workspace package is reported by
 * its real path and not counted as third-party).
 * @param {string} dir the package folder
 * @returns {string}
 */
export function resolveWorkerEntry(dir) {
  try {
    return createRequire(join(dir, "package.json")).resolve(WORKER_EXPORT);
  } catch {
    throw new Error(
      `${WORKER_EXPORT} was not found. Build @orbitrace/core first (npm run build at the repository root).`,
    );
  }
}

/**
 * The esbuild options for the history worker: its own CommonJS file, nothing shared with the
 * extension bundle. The worker runs only where `node:sqlite` loads (VS Code 1.101 and later); the
 * target stays at the extension's lowest Node so the file parses on every supported editor.
 * @param {string} dir the package folder
 * @param {string} workerEntry the worker's entry file (`resolveWorkerEntry`)
 * @returns {import("esbuild").BuildOptions & { metafile: true }}
 */
export function workerEsbuildOptions(dir, workerEntry) {
  return {
    absWorkingDir: dir,
    entryPoints: [workerEntry],
    outfile: join(dir, WORKER_FILE),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
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
 * @param {string} [file] the bundle, for the message
 */
export function assertFirstPartyOnly(metafile, file = "dist/extension.js") {
  const thirdParty = thirdPartyInputs(metafile);
  if (thirdParty.length > 0) {
    throw new Error(
      `${thirdParty.length} file(s) from third-party packages were bundled into ${file}. Review their licences, add them to NOTICE and to this check, or keep them out of the bundle.`,
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
    const worker = await build(workerEsbuildOptions(packageDir, resolveWorkerEntry(packageDir)));
    assertFirstPartyOnly(worker.metafile, WORKER_FILE);
    const appDir = join(packageDir, "dist", "app");
    const copied = copyAppBundle(resolve(packageDir, "..", "app", "dist"), appDir);
    const problem = noticesProblem(appDir);
    if (problem) throw new Error(problem);
    console.log(
      `build: bundled dist/extension.js and ${WORKER_FILE} and copied ${copied.length} app file(s)`,
    );
  } catch (error) {
    console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
