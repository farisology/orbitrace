#!/usr/bin/env node
// Builds the `orbitrace` command into dist/ (npm run build), as one self-contained package
// (#120): an installed CLI tarball needs no other package.
//
// 1. bundles src/index.ts and everything it imports, @orbitrace/core (its main entry and its
//    `/node` entry) included, into one ES module, dist/index.js, for Node.js 20 or later. Node
//    built-ins stay external. The `#!/usr/bin/env node` line of src/index.ts is kept, and the
//    file is made executable. No source maps and no type declarations: the package is a
//    command, and declarations would name @orbitrace/core, which is not installed with it;
// 2. fails when anything from a third-party package ended up in the bundle, so a new bundled
//    dependency cannot ship without its licence being reviewed and noted (see NOTICE at the
//    repository root);
// 3. copies the built web app into dist/app (scripts/copy-app.mjs), and fails when its script
//    bundles have no THIRD-PARTY-NOTICES.txt beside them (#143);
// 4. bundles the history ingest worker of @orbitrace/core (its package export
//    `@orbitrace/core/history-worker`, #188) as a second, separate file, dist/history-worker.js,
//    beside dist/index.js. A worker thread is started from a file, so it must never be inlined
//    into dist/index.js; the command finds it next to itself (#195). The same third-party check
//    covers it.
//
// The workspace build runs @orbitrace/core and @orbitrace/app before this package, because the
// CLI lists both as devDependencies (scripts/run-workspaces.mjs orders by that). esbuild
// resolves @orbitrace/core through its package exports, that is from packages/core/dist.

import { chmodSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { copyAppBundle, noticesProblem } from "./copy-app.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The command's JavaScript file, relative to the package folder. */
export const BUNDLE_FILE = "dist/index.js";

/** The history worker's file, beside the command (#188, #195), relative to the package folder. */
export const WORKER_FILE = "dist/history-worker.js";

/** The package export of core's history worker entry (core's `HISTORY_WORKER_EXPORT`). */
export const WORKER_EXPORT = "@orbitrace/core/history-worker";

/**
 * The file core's worker export resolves to from a package folder, through core's package
 * exports, as Node resolves it (symbolic links followed, so a workspace package is reported by
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
 * The esbuild options for the command, for a package folder: two entry points, the command and
 * the history worker, written as two separate files with no code shared between them.
 * @param {string} dir the package folder
 * @param {string} workerEntry the worker's entry file (`resolveWorkerEntry`)
 * @returns {import("esbuild").BuildOptions & { metafile: true }}
 */
export function esbuildOptions(dir, workerEntry) {
  return {
    absWorkingDir: dir,
    entryPoints: [
      { in: join(dir, "src", "index.ts"), out: "index" },
      { in: workerEntry, out: "history-worker" },
    ],
    outdir: join(dir, "dist"),
    bundle: true,
    splitting: false,
    platform: "node",
    format: "esm",
    // engines.node of this package is >=20.
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
 * The workspace packages a bundle took code from, by folder name under packages/.
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild's metafile
 * @returns {string[]} folder names, sorted, without duplicates
 */
export function bundledWorkspaces(metafile) {
  const names = new Set();
  for (const path of Object.keys(metafile.inputs)) {
    const parts = path.split(/[\\/]/);
    if (parts.includes("node_modules")) continue;
    // Inputs are relative to the CLI folder: `src/...` is the CLI, `../<name>/...` a workspace.
    if (parts[0] === "src") names.add("cli");
    else if (parts[0] === ".." && parts[1] !== undefined && parts[1] !== "..") names.add(parts[1]);
  }
  return [...names].sort();
}

/**
 * Bundle the command and its history worker, check what went into them, make the command
 * executable and copy the web app.
 * @param {string} dir the package folder
 * @param {{ workerEntry?: string }} [options] the worker's entry file; default `resolveWorkerEntry(dir)`
 * @returns {Promise<{ workspaces: string[], appFiles: number }>}
 */
export async function buildCli(dir, options = {}) {
  const workerEntry = options.workerEntry ?? resolveWorkerEntry(dir);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  const result = await build(esbuildOptions(dir, workerEntry));
  const thirdParty = thirdPartyInputs(result.metafile);
  if (thirdParty.length > 0) {
    throw new Error(
      `${thirdParty.length} file(s) from third-party packages were bundled. Review their licences, add them to NOTICE and to this check, or keep them out of the bundle.`,
    );
  }
  chmodSync(join(dir, BUNDLE_FILE), 0o755);
  const copied = copyAppBundle(resolve(dir, "..", "app", "dist"), join(dir, "dist", "app"));
  const problem = noticesProblem(join(dir, "dist", "app"));
  if (problem) throw new Error(problem);
  return { workspaces: bundledWorkspaces(result.metafile), appFiles: copied.length };
}

async function main() {
  try {
    const { workspaces, appFiles } = await buildCli(packageDir);
    console.log(
      `build: bundled ${BUNDLE_FILE} and ${WORKER_FILE} (${workspaces.join(", ")}) and copied ${appFiles} app file(s)`,
    );
  } catch (error) {
    console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();
