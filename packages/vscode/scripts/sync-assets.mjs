#!/usr/bin/env node
// Copies the files the extension ships from elsewhere in the repository into this package.
//
//   node scripts/sync-assets.mjs          write the copies (run by `npm run build`)
//   node scripts/sync-assets.mjs --check  write nothing; exit 1 if any copy differs
//
// The copies are committed, because `vsce package` reads them from the package folder:
//   design/icons/activity-bar.svg  -> media/activity-bar.svg  activity-bar and view icon
//   LICENSE                        -> LICENSE                 the licence shipped in the .vsix
//
// Files are compared and copied byte for byte. test/sync-assets.test.ts runs the check.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "..", "..");

/**
 * Every copy, as absolute paths.
 * @type {readonly { source: string, target: string }[]}
 */
export const ASSETS = [
  {
    source: join(repoDir, "design", "icons", "activity-bar.svg"),
    target: join(packageDir, "media", "activity-bar.svg"),
  },
  {
    source: join(repoDir, "LICENSE"),
    target: join(packageDir, "LICENSE"),
  },
];

/**
 * Copy each asset, or with `check` only compare. Returns the targets that were out of date
 * (missing or different) before this call. Throws when a source is missing.
 * @param {readonly { source: string, target: string }[]} assets
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncAssets(assets, options = {}) {
  /** @type {string[]} */
  const stale = [];
  for (const { source, target } of assets) {
    if (!existsSync(source)) throw new Error(`asset source is missing: ${source}`);
    const wanted = readFileSync(source);
    const current = existsSync(target) ? readFileSync(target) : null;
    if (current !== null && current.equals(wanted)) continue;
    stale.push(target);
    if (options.check) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, wanted);
  }
  return stale;
}

function main() {
  const check = process.argv.includes("--check");
  try {
    const stale = syncAssets(ASSETS, { check });
    const names = stale.map((target) => target.slice(packageDir.length + 1));
    if (check && stale.length > 0) {
      console.error(`sync-assets: out of date: ${names.join(", ")}. Run 'npm run sync'.`);
      process.exitCode = 1;
    } else if (!check && stale.length > 0) {
      console.log(`sync-assets: updated ${names.join(", ")}`);
    }
  } catch (error) {
    console.error(`sync-assets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
