/**
 * Where the web app lives inside the installed extension. `npm run build` copies the app's
 * build output (`packages/app/dist`, without its type declarations) into `dist/app`
 * (scripts/copy-app.mjs), so the one .vsix carries the app its editor tab loads. No vscode
 * dependency, so it is unit tested.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The app folder below the extension folder. Also the only folder the webview may load from. */
export const APP_BUNDLE_SEGMENTS = ["dist", "app"] as const;

/** The page the app starts from. */
export const APP_INDEX_FILE = "index.html";

/** Shown when the app is missing from the extension. Holds no path. */
export const APP_MISSING_MESSAGE =
  "The Orbitrace web app is missing from this extension. Reinstall the extension, or run 'npm run build' at the repository root when running from source.";

/** The absolute path of the app folder of an extension installed at `extensionPath`. */
export function appBundleDir(extensionPath: string): string {
  return join(extensionPath, ...APP_BUNDLE_SEGMENTS);
}

/** The text of the app's `index.html`. Throws an error with `APP_MISSING_MESSAGE` when absent. */
export function readAppIndex(appDir: string): string {
  const file = join(appDir, APP_INDEX_FILE);
  if (!existsSync(file)) throw new Error(APP_MISSING_MESSAGE);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(APP_MISSING_MESSAGE);
  }
}
