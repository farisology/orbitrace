#!/usr/bin/env node
// Copies the built web app (packages/app/dist) into packages/cli/dist/app, so the published CLI
// carries the app it serves (decision on #76, option (a)). scripts/build.mjs calls it after
// bundling; it can also run on its own.
// The app's type declarations (dist/types) are left out: they are not served. The app's
// THIRD-PARTY-NOTICES.txt and third-party-modules.json are copied with the bundle (#143);
// noticesProblem() checks the notices are there.
//
// The workspace build runs @orbitrace/app before this package, because the CLI lists it as a
// devDependency (scripts/run-workspaces.mjs orders by that). Building the CLI alone needs the
// app built first; this script fails with a message saying so.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Top-level entries of the app's dist folder that are not copied. */
export const SKIPPED_ENTRIES = ["types"];

/** The licence notices of the third-party code in the web app bundle, next to index.html. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/**
 * Copy every file below `from` into `to`, keeping the folder layout.
 * @param {string} from
 * @param {string} to
 * @param {string} prefix relative path of `from` inside the copied tree, with forward slashes
 * @param {string[]} copied receives the relative path of each copied file
 */
function copyTree(from, to, prefix, copied) {
  mkdirSync(to, { recursive: true });
  const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (prefix === "" && SKIPPED_ENTRIES.includes(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      copyTree(join(from, entry.name), join(to, entry.name), relative, copied);
    } else if (entry.isFile()) {
      copyFileSync(join(from, entry.name), join(to, entry.name));
      copied.push(relative);
    }
  }
}

/**
 * Replace `targetDir` with a copy of the built app in `sourceDir`, without the entries in
 * SKIPPED_ENTRIES. Throws when `sourceDir` has no index.html, so a CLI build never ships without
 * the app.
 * @param {string} sourceDir the app's dist folder
 * @param {string} targetDir the CLI's dist/app folder
 * @returns {string[]} relative paths of the copied files, with forward slashes, in name order
 */
export function copyAppBundle(sourceDir, targetDir) {
  if (!existsSync(join(sourceDir, "index.html"))) {
    throw new Error(
      "The web app is not built (packages/app/dist/index.html is missing). Run 'npm run build' at the repository root, or 'npm run build -w @orbitrace/app' first.",
    );
  }
  rmSync(targetDir, { recursive: true, force: true });
  /** @type {string[]} */
  const copied = [];
  copyTree(sourceDir, targetDir, "", copied);
  return copied;
}

/**
 * The problem with a copied web app, or null: it holds script bundles (which carry third-party
 * code) but no THIRD-PARTY-NOTICES.txt beside them.
 * @param {string} appDir the copied app folder
 * @returns {string | null}
 */
export function noticesProblem(appDir) {
  const assets = join(appDir, "assets");
  const scripts = existsSync(assets)
    ? readdirSync(assets).filter((name) => name.endsWith(".js"))
    : [];
  if (scripts.length === 0 || existsSync(join(appDir, NOTICES_FILE))) return null;
  return `the web app has ${scripts.length} script file(s) but no ${NOTICES_FILE}. Rebuild it with 'npm run build -w @orbitrace/app', which writes the notices.`;
}

function main() {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  const sourceDir = resolve(packageDir, "..", "app", "dist");
  const targetDir = resolve(packageDir, "dist", "app");
  try {
    const copied = copyAppBundle(sourceDir, targetDir);
    const problem = noticesProblem(targetDir);
    if (problem) throw new Error(problem);
    console.log(`copy-app: copied ${copied.length} file(s) of the web app into dist/app`);
  } catch (error) {
    console.error(`copy-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
