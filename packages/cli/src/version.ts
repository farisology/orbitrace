/** Name and version of the command, read from this package's package.json. */

import { createRequire } from "node:module";
import { CORE_STATUS } from "@orbitrace/core";

// `src/version.ts` and the bundle `dist/index.js` are both one level below the package folder.
const requireFromHere = createRequire(import.meta.url);
const manifest = requireFromHere("../package.json") as { version: string };

export const CLI_NAME = "orbitrace";

export function cliVersion(): string {
  return manifest.version;
}

export function versionLine(): string {
  return `${CLI_NAME} ${manifest.version}`;
}

/** The line `orbitrace --version` prints. It shows the core status, which comes from @orbitrace/core. */
export function statusLine(): string {
  return `${versionLine()} (core: ${CORE_STATUS})`;
}

/** The document `orbitrace --version --json` writes. */
export function versionJson(): { name: string; version: string; core: string } {
  return { name: CLI_NAME, version: manifest.version, core: CORE_STATUS };
}
