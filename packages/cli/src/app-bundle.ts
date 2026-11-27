/**
 * Where the built web app lives inside the installed CLI (decision on #76, option (a)).
 *
 * `npm run build` copies the web app's build output (`packages/app/dist`, without its type
 * declarations) into `packages/cli/dist/app`, so the one published package carries the app.
 * The build bundles this module into `dist/index.js` (#120), so the folder is `app/` beside
 * the bundle. The loopback server (#17) serves files from the folder this returns.
 * `orbitrace doctor` (#31) checks that the folder holds every file its page loads.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder name of the web app inside `dist/`. */
export const APP_BUNDLE_FOLDER = "app";

/** The page the app starts from. */
export const APP_INDEX_FILE = "index.html";

/**
 * Where the web app folder is expected, whether or not it exists. `moduleUrl` is for tests; it
 * defaults to this module.
 */
export function appBundleFolder(moduleUrl: string | URL = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), APP_BUNDLE_FOLDER);
}

/**
 * The absolute path of the web app folder, or `null` when it has no `index.html` (for example
 * when the CLI runs from its sources, or the app was not built before the CLI). `moduleUrl` is
 * for tests; it defaults to this module.
 */
export function appBundleDir(moduleUrl: string | URL = import.meta.url): string | null {
  const dir = appBundleFolder(moduleUrl);
  return existsSync(join(dir, APP_INDEX_FILE)) ? dir : null;
}

/**
 * The files of the app folder that an `index.html` loads: every `src` and `href` value that is
 * a relative path (no scheme, no `//`, no leading `/`; a `?` or `#` part is dropped), relative
 * to the app folder with forward slashes, without duplicates, in page order. A value that would
 * leave the app folder keeps its leading `..`, so `checkAppBundle` reports it as missing.
 */
export function appIndexReferences(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw === "" || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;
    if (raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("?")) continue;
    const normalized = posix.normalize(raw.split(/[?#]/)[0] as string);
    if (normalized === "." || normalized === "./") continue;
    if (!found.includes(normalized)) found.push(normalized);
  }
  return found;
}

/** What `checkAppBundle` found. */
export interface AppBundleState {
  /** `index.html` could be read from the folder. */
  readonly present: boolean;
  /** The files `index.html` loads (see `appIndexReferences`). Empty when it is missing. */
  readonly references: readonly string[];
  /** The loaded files that are not in the folder, relative to it. */
  readonly missing: readonly string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the app folder holds `index.html` and every file it loads. Reads only. */
export function checkAppBundle(dir: string): AppBundleState {
  let html: string;
  try {
    html = readFileSync(join(dir, APP_INDEX_FILE), "utf8");
  } catch {
    return { present: false, references: [], missing: [] };
  }
  const references = appIndexReferences(html);
  const missing = references.filter(
    (reference) => reference.startsWith("..") || !isFile(join(dir, ...reference.split("/"))),
  );
  return { present: true, references, missing };
}
