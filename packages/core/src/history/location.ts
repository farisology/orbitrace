/// <reference types="node" />
/**
 * Where the history store lives, and the checks on that place (ticket #25).
 *
 * - `ORBITRACE_DATA_DIR` when it is set (it must be an absolute path), otherwise a folder named
 *   `.orbitrace` in the user's home folder.
 * - Never inside a git working tree (any folder above it holding `.git`) or inside a Claude Code
 *   config folder (`CLAUDE_CONFIG_DIR`, or `.claude` in the home folder): the first could end up
 *   in a commit, the second is the folder whose cleanup the store outlives.
 * - The folder is made readable by the user only (0700) and the files in it 0600. On Windows,
 *   where Node's `chmod` only sets the read-only flag, the folder's inherited permissions apply.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  defaultConfigRoot,
  environmentConfigRoot,
  envValue,
  homeFolder,
  pathApiFor,
} from "../sources/claude-code/paths.js";
import { HistoryStoreError } from "./errors.js";

/** Environment variable that moves the history store. */
export const HISTORY_DATA_DIR_ENV = "ORBITRACE_DATA_DIR";

/** Folder in the home folder used when `ORBITRACE_DATA_DIR` is not set. */
export const HISTORY_DEFAULT_FOLDER = ".orbitrace";

/** The database file in the data folder. */
export const HISTORY_DB_FILE = "history.sqlite";

/** The writer lock file in the data folder. */
export const HISTORY_LOCK_FILE = "history.lock";

/** Permissions of the data folder and of the files in it. */
export const HISTORY_DIR_MODE = 0o700;
export const HISTORY_FILE_MODE = 0o600;

/** Inputs for finding the data folder. Each defaults to this process's value. */
export interface HistoryLocationOptions {
  /** Use this folder. Must be absolute. Wins over the environment. */
  readonly dataDir?: string;
  /** Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `os.homedir()`. */
  readonly homeDir?: string;
  /** Default `process.platform`. */
  readonly platform?: string;
}

/** The data folder and the files in it. Local paths: never sent to the app or written to a log. */
export interface HistoryLocation {
  readonly dir: string;
  readonly dbFile: string;
  readonly lockFile: string;
}

/**
 * The data folder for these options, before any check: `dataDir`, else `ORBITRACE_DATA_DIR`,
 * else `<home>/.orbitrace`. Throws `unsafe-location` when the folder is not absolute or there is
 * no home folder.
 */
export function resolveHistoryLocation(options: HistoryLocationOptions = {}): HistoryLocation {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const p = pathApiFor(platform);
  const configured = options.dataDir ?? envValue(env, HISTORY_DATA_DIR_ENV, platform)?.trim();
  let dir: string;
  if (configured !== undefined && configured !== "") {
    if (!p.isAbsolute(configured)) {
      throw new HistoryStoreError(
        "unsafe-location",
        `${HISTORY_DATA_DIR_ENV} must be an absolute path.`,
      );
    }
    dir = p.normalize(configured);
  } else {
    const home = homeFolder(platform, options.homeDir ?? homedir(), env);
    if (home === undefined) {
      throw new HistoryStoreError(
        "unsafe-location",
        `No home folder was found; set ${HISTORY_DATA_DIR_ENV} to an absolute path.`,
      );
    }
    dir = p.join(home, HISTORY_DEFAULT_FOLDER);
  }
  return { dir, dbFile: p.join(dir, HISTORY_DB_FILE), lockFile: p.join(dir, HISTORY_LOCK_FILE) };
}

/** Whether `child` is `parent` or inside it, by path text. */
function isInside(p: typeof path, parent: string, child: string, platform: string): boolean {
  const norm = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = p.relative(norm(parent), norm(child));
  return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
}

/** The real path of `target`, resolving its nearest existing ancestor and adding the rest. */
function realPathOfNearest(p: typeof path, target: string): string {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return p.join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return target;
      rest.push(p.basename(current));
      current = parent;
    }
  }
}

/**
 * Throw `unsafe-location` when the folder is inside a Claude Code config folder or a git working
 * tree. Checks the path as given and with symbolic links resolved. Reads only.
 */
export function checkHistoryLocation(
  location: HistoryLocation,
  options: HistoryLocationOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const p = pathApiFor(platform) as typeof path;
  const candidates = [location.dir];
  if (platform === process.platform) candidates.push(realPathOfNearest(p, location.dir));
  const configRoots = [
    environmentConfigRoot(platform, homeDir, env),
    defaultConfigRoot(platform, homeDir, env),
  ].filter((root): root is string => root !== null);
  for (const root of [...configRoots]) {
    if (platform === process.platform) configRoots.push(realPathOfNearest(p, root));
  }
  for (const dir of candidates) {
    if (configRoots.some((root) => isInside(p, root, dir, platform))) {
      throw new HistoryStoreError(
        "unsafe-location",
        "The history folder must not be inside a Claude Code config folder.",
      );
    }
  }
  if (platform !== process.platform) return;
  for (const dir of candidates) {
    let current = dir;
    for (;;) {
      if (existsSync(p.join(current, ".git"))) {
        throw new HistoryStoreError(
          "unsafe-location",
          "The history folder must not be inside a git working tree.",
        );
      }
      const parent = p.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

/** Create the data folder if needed and set it to 0700. Throws `io` without the path. */
export function prepareHistoryDir(location: HistoryLocation): void {
  try {
    mkdirSync(location.dir, { recursive: true, mode: HISTORY_DIR_MODE });
    chmodSync(location.dir, HISTORY_DIR_MODE);
  } catch {
    throw new HistoryStoreError("io", "The history folder could not be created.");
  }
}

/** Set a file in the data folder to 0600 when it exists. */
export function restrictHistoryFile(file: string): void {
  try {
    chmodSync(file, HISTORY_FILE_MODE);
  } catch {
    // Missing (for example a WAL file not created yet) or not ours: nothing to tighten.
  }
}
