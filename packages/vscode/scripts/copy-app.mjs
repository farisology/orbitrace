#!/usr/bin/env node
// Copies the built web app (packages/app/dist) into packages/vscode/dist/app, so the .vsix
// carries the app its editor tab loads. The same approach as the CLI (decision on #76); this
// package keeps its own copy step because packages do not import each other's build scripts.
// The app's type declarations (dist/types) are left out: they are not loaded.
//
// The workspace build runs @orbitrace/app before this package, because it is listed as a
// devDependency (scripts/run-workspaces.mjs orders by that).

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Top-level entries of the app's dist folder that are not copied. */
export const SKIPPED_ENTRIES = ["types"];

/**
 * @param {string} from
 * @param {string} to
 * @param {string} prefix relative path of `from` in the copied tree, with forward slashes
 * @param {string[]} copied receives the relative path of each copied file
 */
function copyTree(from, to, prefix, copied) {
  mkdirSync(to, { recursive: true });
  const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (prefix === "" && SKIPPED_ENTRIES.includes(entry.name)) continue;
    // Source maps are never shipped: they would carry build paths.
    if (entry.name.endsWith(".map")) continue;
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
 * SKIPPED_ENTRIES and without source maps. Throws when `sourceDir` has no index.html, so the
 * extension is never built without the app.
 * @param {string} sourceDir the app's dist folder
 * @param {string} targetDir this package's dist/app folder
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
