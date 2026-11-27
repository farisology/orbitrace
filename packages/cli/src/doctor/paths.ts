/**
 * Paths in the doctor report: how a folder is shown, how it is written into a fix command, and
 * what state it is in on disk.
 *
 * A folder under the home folder is shown with the home folder as `~` (`%USERPROFILE%` on
 * Windows), so a report pasted into an issue does not carry the account name. A folder outside
 * the home folder is shown only when the user put it there: with `--config-dir`,
 * `CLAUDE_CONFIG_DIR`, `APPDATA` or `XDG_CONFIG_HOME`. A relative `--config-dir` value is shown
 * relative to the working folder, never with the working folder's own path.
 */

import { readdir, stat } from "node:fs/promises";
import type { SourceRoot } from "@orbitrace/core";
import { pathApiFor } from "@orbitrace/core/node";
import { toUserRoot, type HostContext } from "../sessions.js";

/** The home folder in a shown path: `~` on macOS and Linux, `%USERPROFILE%` on Windows. */
export function homeMarker(platform: string): string {
  return platform === "win32" ? "%USERPROFILE%" : "~";
}

/** `path` with a leading home folder replaced by `~` (or `%USERPROFILE%` on Windows). */
export function showPath(path: string, homeDir: string, platform: string): string {
  const p = pathApiFor(platform);
  const home = homeDir.trim();
  if (home === "") return path;
  const fold = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  const base = home.length > 1 && home.endsWith(p.sep) ? home.slice(0, -1) : home;
  if (fold(path) === fold(base)) return homeMarker(platform);
  const prefix = base.endsWith(p.sep) ? base : `${base}${p.sep}`;
  if (fold(path).startsWith(fold(prefix))) {
    return `${homeMarker(platform)}${p.sep}${path.slice(prefix.length)}`;
  }
  return path;
}

/** How the report shows an absolute path. */
export type PathShower = (path: string) => string;

/** `path` relative to `cwd`, starting with `.` or `..`, so it reads as a relative path. */
function relativeToCwd(path: string, cwd: string, platform: string): string {
  const p = pathApiFor(platform);
  const rel = p.relative(cwd, path);
  if (rel === "") return ".";
  return rel === ".." || rel.startsWith(`..${p.sep}`) ? rel : `.${p.sep}${rel}`;
}

/**
 * The one way the doctor shows a session folder, or a path inside one. A folder that came from
 * a relative `--config-dir` value is shown relative to the working folder, as the user typed
 * it, never in its absolute form: the working folder was not typed, and its path can name a
 * client or project. Every other path goes through `showPath`.
 *
 * `roots` are the resolved session folders; `configDirs` are the `--config-dir` values as typed.
 * A relative value matches the folder core resolved it to, or that folder's parent when the
 * value names the `projects` folder itself (core then uses the parent).
 */
export function rootPathShower(
  host: HostContext,
  roots: readonly SourceRoot[],
  configDirs: readonly string[],
): PathShower {
  const { platform, homeDir, cwd } = host;
  const p = pathApiFor(platform);
  const fold = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  const typedRelative = new Set<string>();
  for (const typed of configDirs) {
    const absolute = toUserRoot(typed, cwd);
    if (absolute === typed.trim()) continue; // `~` or absolute: shown with showPath.
    typedRelative.add(fold(absolute));
    if (p.basename(absolute) === "projects") typedRelative.add(fold(p.dirname(absolute)));
  }
  const relativeRoots = roots
    .filter((root) => root.resolvedBy === "user-setting" && typedRelative.has(fold(root.root)))
    .map((root) => root.root)
    .sort((a, b) => b.length - a.length);
  return (path) => {
    for (const root of relativeRoots) {
      if (fold(path) === fold(root)) return relativeToCwd(root, cwd, platform);
      const prefix = root.endsWith(p.sep) ? root : `${root}${p.sep}`;
      if (fold(path).startsWith(fold(prefix))) {
        const shown = relativeToCwd(root, cwd, platform);
        return `${shown}${p.sep}${path.slice(prefix.length)}`;
      }
    }
    return showPath(path, homeDir, platform);
  };
}

const SAFE_POSIX = /^[\w@%+=:,./-]+$/;

function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A shown path as one argument of a shell command: unquoted when it needs no quoting, with the
 * leading `~/` left outside the quotes so the shell still expands it, and in double quotes on
 * Windows.
 */
export function shellPath(shown: string, platform: string): string {
  if (platform === "win32") return `"${shown}"`;
  if (shown === "~") return shown;
  if (shown.startsWith("~/")) {
    const rest = shown.slice(2);
    return SAFE_POSIX.test(rest) ? shown : `~/${singleQuoted(rest)}`;
  }
  return SAFE_POSIX.test(shown) ? shown : singleQuoted(shown);
}

/** What a folder is on disk. `unreadable` means it exists but its entries cannot be listed. */
export type FolderState = "ok" | "missing" | "not-a-folder" | "unreadable";

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The state of a folder. Reads only: a `stat` and a listing. */
export async function folderState(path: string): Promise<FolderState> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return "not-a-folder";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "missing";
    if (code === "ENOTDIR") return "not-a-folder";
    return "unreadable";
  }
  try {
    await readdir(path);
    return "ok";
  } catch {
    return "unreadable";
  }
}

/** The command that gives your own account read access to a folder and what is in it. */
export function readAccessFix(shown: string, platform: string): string {
  return platform === "win32"
    ? `icacls ${shellPath(shown, platform)} /grant "%USERNAME%:(OI)(CI)RX" /T`
    : `chmod -R u+rX ${shellPath(shown, platform)}`;
}

/** How to set an environment variable for this shell, on this platform. */
export function setEnvCommand(name: string, value: string, platform: string): string {
  return platform === "win32" ? `set ${name}=${value}` : `export ${name}=${value}`;
}

/** How to remove an environment variable from this shell, on this platform. */
export function unsetEnvCommand(name: string, platform: string): string {
  return platform === "win32" ? `set ${name}=` : `unset ${name}`;
}
