/// <reference types="node" />
/**
 * Path rules for Claude Code sources on Windows, macOS and Linux. Pure string functions:
 * nothing here touches the file system, so each OS's rules can be tested on any host.
 *
 * Node only (uses `node:path` for its posix and win32 flavours). Exported from
 * `@orbitrace/core/node`.
 */

import path from "node:path";

export type PathApi = typeof path.posix;

/** The config root folder name under the home folder on every OS. */
export const CLAUDE_CONFIG_FOLDER = ".claude";

/** The environment variable that moves the whole config folder. */
export const CLAUDE_CONFIG_ENV = "CLAUDE_CONFIG_DIR";

/**
 * Folder under the desktop app's own data folder that holds per-session config roots.
 * Observed on one machine and undocumented: treat it as optional.
 */
export const DESKTOP_SESSIONS_FOLDER = "local-agent-mode-sessions";

/** Path functions for an OS, as in Node's `process.platform`. Every OS but Windows is posix. */
export function pathApiFor(platform: string): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Path functions for an existing path string, for code that gets a path but no platform
 * (a `SourceRoot` or a locator). Drive-letter, UNC and backslash-rooted paths are Windows; the
 * rest is posix.
 */
export function pathApiForPath(value: string): PathApi {
  return pathApiFor(platformForPath(value));
}

/**
 * `win32` for a path that starts with a drive letter (`C:\`, `C:/`) or with a backslash: a UNC
 * path (`\\server\share`) or a path rooted on the current drive (`\srv\x`, what `path.join("/srv",
 * ...)` gives on Windows). `posix` for the rest. A posix absolute path starts with `/`, so a path
 * that starts with a backslash is never one (#210).
 */
export function platformForPath(value: string): "win32" | "posix" {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\") ? "win32" : "posix";
}

/** An environment variable, looked up case-insensitively on Windows as Windows does. */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== "win32") return direct;
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/** A non-empty, trimmed environment value, or undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** The home folder: `homeDir`, else `USERPROFILE` on Windows or `HOME` elsewhere. */
export function homeFolder(
  platform: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return (
    nonEmpty(homeDir) ??
    nonEmpty(envValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform))
  );
}

/** Replace a leading `~` (alone, or followed by a separator) with the home folder. */
export function expandHome(value: string, home: string | undefined, platform: string): string {
  if (home === undefined || !value.startsWith("~")) return value;
  if (value === "~") return home;
  const next = value[1];
  if (next === "/" || (platform === "win32" && next === "\\")) {
    return pathApiFor(platform).join(home, value.slice(2));
  }
  return value;
}

/**
 * Normalise an absolute path for the OS: resolve `.` and `..`, use the OS separator and drop a
 * trailing separator (except on a bare root). Returns null for a relative or empty path,
 * because a source root must be absolute.
 */
export function normalizeRoot(value: string, platform: string): string | null {
  const p = pathApiFor(platform);
  const trimmed = value.trim();
  if (trimmed === "" || !p.isAbsolute(trimmed)) return null;
  // `C:` alone and `C:foo` are drive-relative on Windows, not absolute.
  if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(trimmed)) return null;
  let normalized = p.normalize(trimmed);
  const { root } = p.parse(normalized);
  while (normalized.length > root.length && normalized.endsWith(p.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Key for comparing two roots on one OS. Windows paths compare case-insensitively. macOS and
 * Linux compare exactly; the adapter also compares real paths, which catches symlinks and
 * case differences on a case-insensitive disk.
 */
export function rootIdentity(normalizedRoot: string, platform: string): string {
  return platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
}

/** `<home>/.claude` (macOS, Linux) or `<USERPROFILE>\.claude` (Windows), or null without a home. */
export function defaultConfigRoot(
  platform: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const home = homeFolder(platform, homeDir, env);
  if (home === undefined) return null;
  return normalizeRoot(pathApiFor(platform).join(home, CLAUDE_CONFIG_FOLDER), platform);
}

/** The `CLAUDE_CONFIG_DIR` root, with `~` expanded, or null when unset, blank or relative. */
export function environmentConfigRoot(
  platform: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = nonEmpty(envValue(env, CLAUDE_CONFIG_ENV, platform));
  if (value === undefined) return null;
  return normalizeRoot(expandHome(value, homeFolder(platform, homeDir, env), platform), platform);
}

/** A root the user set, with `~` expanded, or null when blank or relative. */
export function userConfigRoot(
  value: string,
  platform: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  return normalizeRoot(
    expandHome(value.trim(), homeFolder(platform, homeDir, env), platform),
    platform,
  );
}

/**
 * Folders that hold the desktop app's per-session config roots. The app's data folder is
 * `~/Library/Application Support/Claude` on macOS and `%APPDATA%\Claude` on Windows; on other
 * systems the usual `$XDG_CONFIG_HOME/Claude` (default `~/.config/Claude`) is checked.
 */
export function desktopSessionBases(
  platform: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const p = pathApiFor(platform);
  const home = homeFolder(platform, homeDir, env);
  let appData: string | undefined;
  if (platform === "darwin") {
    appData = home === undefined ? undefined : p.join(home, "Library", "Application Support");
  } else if (platform === "win32") {
    appData =
      nonEmpty(envValue(env, "APPDATA", platform)) ??
      (home === undefined ? undefined : p.join(home, "AppData", "Roaming"));
  } else {
    appData =
      nonEmpty(envValue(env, "XDG_CONFIG_HOME", platform)) ??
      (home === undefined ? undefined : p.join(home, ".config"));
  }
  if (appData === undefined) return [];
  const base = normalizeRoot(p.join(appData, "Claude", DESKTOP_SESSIONS_FOLDER), platform);
  return base === null ? [] : [base];
}

/**
 * The config root a transcript path belongs to, or null when the path does not have the
 * Claude Code shape. Accepts a main transcript, `<root>/projects/<project>/<session>.jsonl`,
 * and a subagent transcript,
 * `<root>/projects/<project>/<session>/subagents/agent-<agentId>.jsonl`.
 */
export function configRootFromTranscriptPath(
  transcriptPath: string,
  platform: string,
): string | null {
  const normalized = normalizeRoot(transcriptPath, platform);
  if (normalized === null) return null;
  const p = pathApiFor(platform);
  if (!normalized.toLowerCase().endsWith(".jsonl")) return null;
  const up = (value: string, times: number): string => {
    let current = value;
    for (let i = 0; i < times; i += 1) current = p.dirname(current);
    return current;
  };
  // Windows folder names are case-insensitive.
  const name = (value: string): string => {
    const base = p.basename(value);
    return platform === "win32" ? base.toLowerCase() : base;
  };
  const projectDir = p.dirname(normalized);
  if (name(p.dirname(projectDir)) === "projects") {
    return normalizeRoot(up(normalized, 3), platform);
  }
  if (
    name(projectDir) === "subagents" &&
    name(normalized).startsWith("agent-") &&
    name(up(normalized, 4)) === "projects"
  ) {
    return normalizeRoot(up(normalized, 5), platform);
  }
  return null;
}

/**
 * Readable project name from a working directory: its last segment. Works for Windows and
 * posix paths whatever the host is, because a transcript may come from another machine.
 */
export function projectLabelFromCwd(cwd: string): string | null {
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  return last === undefined ? null : last;
}

/**
 * Fallback project name from the encoded project folder name when no working directory is
 * known. Claude Code replaces every non-alphanumeric character with `-`, so the original
 * cannot be recovered; the last dash-separated word is used. Lossy by design.
 */
export function projectLabelFromFolderName(folderName: string): string {
  const words = folderName.split("-").filter((word) => word !== "");
  return words[words.length - 1] ?? folderName;
}
