#!/usr/bin/env node
// Copies the repository LICENSE into each npm package a release ships, because npm puts a
// LICENSE file into a tarball only when it sits in the package folder:
//
//   node scripts/release/sync-licenses.mjs          write the copies
//   node scripts/release/sync-licenses.mjs --check  write nothing; exit 1 if a copy differs
//
// The copies are committed. scripts/release/check-package.test.mjs runs the check, so a changed
// LICENSE that was not copied fails `npm test`. The extension keeps its own copy through
// packages/vscode/scripts/sync-assets.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NPM_PACKAGES, REPO_ROOT } from "./lib.mjs";

/**
 * The LICENSE copies, as absolute paths, for a repository root.
 * @param {string} root
 * @returns {{ source: string, target: string }[]}
 */
export function licenseCopies(root = REPO_ROOT) {
  return NPM_PACKAGES.map((spec) => ({
    source: join(root, "LICENSE"),
    target: join(root, "packages", spec.dir, "LICENSE"),
  }));
}

/**
 * Copy each LICENSE, or with `check` only compare. Returns the targets that were missing or
 * different before the call.
 * @param {{ source: string, target: string }[]} copies
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncLicenses(copies, options = {}) {
  const stale = [];
  for (const { source, target } of copies) {
    const wanted = readFileSync(source);
    const current = existsSync(target) ? readFileSync(target) : null;
    if (current !== null && current.equals(wanted)) continue;
    stale.push(target);
    if (!options.check) writeFileSync(target, wanted);
  }
  return stale;
}

function main() {
  const check = process.argv.includes("--check");
  try {
    const stale = syncLicenses(licenseCopies(), { check });
    const names = stale.map((target) => target.slice(REPO_ROOT.length + 1));
    if (check && stale.length > 0) {
      console.error(
        `sync-licenses: out of date: ${names.join(", ")}. Run 'node scripts/release/sync-licenses.mjs'.`,
      );
      process.exitCode = 1;
    } else if (stale.length > 0) {
      console.log(`sync-licenses: updated ${names.join(", ")}`);
    }
  } catch (error) {
    console.error(`sync-licenses: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
