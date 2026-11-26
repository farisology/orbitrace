/**
 * Which sessions belong to the open workspace folder. Host side only: it compares paths, so
 * it runs on `SessionRef`s, and only the yes/no answer reaches the Sessions view. Nothing here
 * crosses to the webview. No vscode dependency, so it is unit tested.
 *
 * Claude Code names each project folder after the working directory, with every character
 * that is not an ASCII letter or digit replaced by `-`; names over 200 characters are cut and
 * a hash is appended. The original path cannot be recovered from the folder name, so the
 * workspace path is encoded the same way and the two names are compared. A session started in
 * a subfolder of the workspace has a different folder name and is not matched.
 */

import { pathApiForPath, platformForPath } from "@orbitrace/core/node";
import type { SessionRef } from "@orbitrace/core";

/** Longest project folder name Claude Code writes before it cuts the name and adds a hash. */
export const PROJECT_FOLDER_MAX_LENGTH = 200;

/** The project folder name Claude Code would use for a working directory. */
export function encodeProjectFolder(workingDirectory: string): string {
  return trimTrailingSeparators(workingDirectory).replace(/[^A-Za-z0-9]/g, "-");
}

/** `path` without trailing `/` or `\`, except a bare root such as `/` or `C:\`. */
export function trimTrailingSeparators(path: string): string {
  let trimmed = path;
  while (trimmed.length > 1 && /[\\/]$/.test(trimmed) && !/^[A-Za-z]:[\\/]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * The project folder name of a Claude Code session: the folder that holds its main transcript
 * (`<config>/projects/<project>/<session>.jsonl`). Null for a locator without that shape.
 */
export function projectFolderOfLocator(locator: string): string | null {
  if (!locator.toLowerCase().endsWith(".jsonl")) return null;
  const path = pathApiForPath(locator);
  const folder = path.basename(path.dirname(locator));
  return folder === "" || folder === "." ? null : folder;
}

/**
 * True when a project folder name was written for `workspacePath`. Windows paths compare
 * without case, because the editor and the terminal may disagree on the drive letter's case.
 * A cut name (over 200 characters) matches when its first 200 characters match.
 */
export function folderMatchesWorkspace(folder: string, workspacePath: string): boolean {
  if (workspacePath.trim() === "") return false;
  const ignoreCase = platformForPath(workspacePath) === "win32";
  const norm = (value: string): string => (ignoreCase ? value.toLowerCase() : value);
  const wanted = norm(encodeProjectFolder(workspacePath));
  const actual = norm(folder);
  if (actual === wanted) return true;
  return (
    wanted.length > PROJECT_FOLDER_MAX_LENGTH &&
    actual.length > PROJECT_FOLDER_MAX_LENGTH &&
    actual.startsWith(wanted.slice(0, PROJECT_FOLDER_MAX_LENGTH))
  );
}

/** True when the session was recorded in one of the workspace folders. */
export function sessionInWorkspace(
  ref: Pick<SessionRef, "runtime" | "locator">,
  workspacePaths: readonly string[],
): boolean {
  if (ref.runtime !== "claude-code") return false;
  const folder = projectFolderOfLocator(ref.locator);
  if (folder === null) return false;
  return workspacePaths.some((workspacePath) => folderMatchesWorkspace(folder, workspacePath));
}
