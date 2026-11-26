#!/usr/bin/env node
// Copies the files the app bundles from elsewhere in the repository into the app package.
//
//   node scripts/sync-assets.mjs          write the copies
//   node scripts/sync-assets.mjs --check  write nothing; exit 1 if any copy is out of date
//
// The app never imports across a package boundary at run time. The copies are committed, and
// test/sync-assets.test.ts fails when one differs from its source.
//
// Sources (read here only):
//   fixtures/replays/demo.replay.json  the demo golden replay (DEMO_GOLDEN_REPLAY_PATH from
//                                      @orbitrace/fixtures), shown when the app has no host
//   design/tokens.css                  colours, fonts, spacing and radius as CSS properties
//   design/icons/favicon.svg           browser tab icon
//   design/icons/orbitrace-mark.svg    the mark in the header
//
// Text copies are formatted with the repository's Prettier config, and the check compares
// Prettier-formatted text, so `npm run format` never makes the check fail.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { DEMO_GOLDEN_REPLAY_PATH } from "@orbitrace/fixtures";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = resolve(packageDir, "..", "..", "design");

const HEADER_CSS =
  "/* Copied from design/tokens.css by packages/app/scripts/sync-assets.mjs. Do not edit by hand: run `npm run sync` in packages/app. */\n";

/**
 * Every copy: where it comes from, where it goes, and how its text is made.
 * @type {{ source: string, target: string, make: (text: string) => string }[]}
 */
export const ASSETS = [
  {
    source: DEMO_GOLDEN_REPLAY_PATH,
    target: join(packageDir, "src", "generated", "demo.replay.json"),
    make: (text) => text,
  },
  {
    source: join(designDir, "tokens.css"),
    target: join(packageDir, "src", "generated", "tokens.css"),
    make: (text) => HEADER_CSS + text,
  },
  {
    source: join(designDir, "icons", "favicon.svg"),
    target: join(packageDir, "public", "favicon.svg"),
    make: (text) => text,
  },
  {
    source: join(designDir, "icons", "orbitrace-mark.svg"),
    target: join(packageDir, "public", "orbitrace-mark.svg"),
    make: (text) => text,
  },
];

/** Prettier-format text as the file at `target` would be, or return it unchanged for SVG. */
async function prettify(text, target) {
  if (target.endsWith(".svg")) return text;
  const config = (await resolveConfig(target)) ?? {};
  return format(text, { ...config, filepath: target });
}

/** The expected text of one copy. */
export async function expected(asset) {
  return prettify(asset.make(readFileSync(asset.source, "utf8")), asset.target);
}

/** True when the copy on disk says the same as a fresh copy. */
export async function isUpToDate(asset) {
  let current;
  try {
    current = readFileSync(asset.target, "utf8");
  } catch {
    return false;
  }
  return (await prettify(current, asset.target)) === (await expected(asset));
}

async function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const asset of ASSETS) {
    const name = relative(packageDir, asset.target);
    if (check) {
      const ok = await isUpToDate(asset);
      if (!ok) stale += 1;
      console.log(`${ok ? "up to date " : "OUT OF DATE"} ${name}`);
    } else {
      mkdirSync(dirname(asset.target), { recursive: true });
      writeFileSync(asset.target, await expected(asset));
      console.log(`wrote       ${name}`);
    }
  }
  if (stale > 0) process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
