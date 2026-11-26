/**
 * Where the built web app lives inside the installed CLI (decision on #76, option (a)).
 *
 * `npm run build` copies the web app's build output (`packages/app/dist`, without its type
 * declarations) into `packages/cli/dist/app`, so the one published package carries the app.
 * This module is compiled to `dist/app-bundle.js`, so the folder is `app/` beside it. The
 * loopback server (#17) serves files from the folder this returns.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder name of the web app inside `dist/`. */
export const APP_BUNDLE_FOLDER = "app";

/** The page the app starts from. */
export const APP_INDEX_FILE = "index.html";

/**
 * The absolute path of the web app folder, or `null` when it has no `index.html` (for example
 * when the CLI runs from its sources, or the app was not built before the CLI). `moduleUrl` is
 * for tests; it defaults to this module.
 */
export function appBundleDir(moduleUrl: string | URL = import.meta.url): string | null {
  const dir = join(dirname(fileURLToPath(moduleUrl)), APP_BUNDLE_FOLDER);
  return existsSync(join(dir, APP_INDEX_FILE)) ? dir : null;
}
