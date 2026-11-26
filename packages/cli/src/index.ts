#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CORE_STATUS } from "@orbitrace/core";

const requireFromHere = createRequire(import.meta.url);
const manifest = requireFromHere("../package.json") as { version: string };

export const CLI_NAME = "orbitrace";

export function versionLine(): string {
  return `${CLI_NAME} ${manifest.version}`;
}

/** The line the entry prints. It shows the core status, which comes from @orbitrace/core. */
export function statusLine(): string {
  return `${versionLine()} (core: ${CORE_STATUS})`;
}

/** True when this module is the file Node was started with, following npm bin symlinks. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  console.log(statusLine());
}
