/**
 * Opening the link in the default browser, without a shell and without the token in any
 * command line.
 *
 * Other accounts on the same machine can read every process's arguments (`ps` on macOS,
 * `/proc/<pid>/cmdline` on Linux). If the link were passed to the opener, the token would be in
 * the opener's arguments, and in the browser's for its whole life when the opener had to start
 * it. So the link is written instead into a launcher page: an HTML file readable by this user
 * only (mode 0600) in a fresh folder of its own (mode 0700, from `mkdtemp`), which redirects to
 * the link with `<meta http-equiv="refresh">` (the fragment is kept). The opener gets the file's
 * path, which holds no secret. The caller removes the file when the server stops.
 *
 * The program and its arguments are passed to `spawn` as an array, so nothing is read by a
 * shell: `open <file>` on macOS, `xdg-open <file>` elsewhere. Windows has no such program, so
 * `cmd.exe` runs its built-in `start`. `cmd.exe` parses its own command line, so the path is
 * checked first (no `"`, `%`, `!`, `^` or control characters) and put inside double quotes,
 * where `&` is plain text.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** A link this module agrees to open: the loopback server's own address and fragment. */
const OPENABLE_LINK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/(?:#[A-Za-z0-9\-._~:=&]*)?$/;

/** Whether `link` is one the CLI made and is safe to write into a launcher page. */
export function isOpenableLink(link: string): boolean {
  return OPENABLE_LINK.test(link);
}

/** The launcher page's file name inside its own folder. */
export const LAUNCHER_FILE_NAME = "open.html";

// Control characters (C0 and DEL), never part of a path the CLI made.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Characters cmd.exe treats specially even inside double quotes, or that end the quotes. */
const CMD_SPECIAL = /["%!^]/;
/** A Windows path on a drive (`C:\...`). A rooted path without a drive, or a UNC path, is refused. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;

/**
 * Whether `path` is a launcher page this module agrees to hand to the opener on `platform`: an
 * absolute path to an `.html` file, with no control characters, and on Windows a path on a drive
 * with nothing cmd.exe would read inside double quotes.
 */
export function isOpenableFile(platform: string, path: string): boolean {
  if (!path.endsWith(".html") || CONTROL_CHARACTERS.test(path)) return false;
  if (platform === "win32") return WINDOWS_DRIVE_PATH.test(path) && !CMD_SPECIAL.test(path);
  return path.startsWith("/");
}

export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Windows only: pass the arguments as written, because they are already quoted for cmd.exe. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * The program and arguments that open the launcher page at `file` on `platform`, or `null` when
 * the path does not pass `isOpenableFile`. A link is never accepted here: it would put the
 * token in a command line.
 */
export function browserCommand(platform: string, file: string): BrowserCommand | null {
  if (!isOpenableFile(platform, file)) return null;
  if (platform === "darwin") {
    return { command: "open", args: [file], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    // /d: no AutoRun commands. /v:off: no delayed expansion of !. /s /c "...": run the quoted
    // command line. The empty "" is the window title start expects before a quoted argument.
    return {
      command: "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `"start "" "${file}""`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: "xdg-open", args: [file], windowsVerbatimArguments: false };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The launcher page for `link`: an immediate redirect that keeps the fragment, plus a plain link
 * for a browser that does not follow it. No script. Throws when `link` does not pass
 * `isOpenableLink`.
 */
export function launcherHtml(link: string): string {
  if (!isOpenableLink(link)) throw new TypeError("Not a link of the local server.");
  const href = escapeHtml(link);
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    `<meta http-equiv="refresh" content="0;url=${href}">\n` +
    "<title>Orbitrace</title>\n" +
    "</head>\n" +
    `<body><p><a href="${href}">Open Orbitrace</a></p></body>\n` +
    "</html>\n"
  );
}

/** A launcher page on disk. */
export interface LauncherFile {
  /** Absolute path of the page. Holds no secret; safe to pass as a command-line argument. */
  readonly path: string;
  /** Delete the page and its folder. Safe to call more than once; never rejects. */
  remove(): Promise<void>;
}

export interface LauncherFileOptions {
  /** The folder to make the launcher's own folder in. Default: the system's temporary folder. */
  readonly tmpDir?: string;
}

/**
 * Write the launcher page for `link` into a new folder only this user can open (0700), as a
 * file only this user can read (0600). Rejects when `link` does not pass `isOpenableLink` or
 * the file cannot be written; nothing is left behind then.
 */
export async function writeLauncherFile(
  link: string,
  options: LauncherFileOptions = {},
): Promise<LauncherFile> {
  const html = launcherHtml(link);
  const base = options.tmpDir ?? tmpdir();
  if (!isAbsolute(base)) throw new TypeError("The temporary folder must be an absolute path.");
  const dir = await mkdtemp(join(base, "orbitrace-open-"));
  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    // mkdtemp already makes the folder 0700 on POSIX; chmod states it (a no-op on Windows).
    await chmod(dir, 0o700);
    const path = join(dir, LAUNCHER_FILE_NAME);
    // "wx": fail if anything is already there. The mode is applied when the file is created.
    await writeFile(path, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return { path, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

export type BrowserOpenResult = "opened" | "failed";

/** What `openInBrowser` started. */
export interface BrowserOpening {
  readonly result: BrowserOpenResult;
  /** Delete the launcher page. Call when the server stops. Safe to call more than once. */
  close(): Promise<void>;
}

/** `child_process.spawn`, or a stand-in for tests. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  /** `spawn` once the program started; `error` when it could not start. */
  once(event: "spawn" | "error", listener: (error?: Error) => void): unknown;
  unref(): void;
};

export interface OpenInBrowserOptions extends LauncherFileOptions {
  readonly platform?: string;
  readonly spawn?: SpawnFunction;
}

/** Start the opener. Resolves `opened` once it started, `failed` otherwise. */
function spawnOpener(command: BrowserCommand, spawn: SpawnFunction): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command.command, command.args, {
        shell: false,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
      child.once("error", () => resolve("failed"));
      child.once("spawn", () => {
        child.unref();
        resolve("opened");
      });
    } catch {
      resolve("failed");
    }
  });
}

const FAILED: BrowserOpening = { result: "failed", close: () => Promise.resolve() };

/**
 * Write the launcher page for `link` and start the browser opener on it. Resolves once the
 * opener started (`opened`) or could not start (`failed`, for example when `xdg-open` is not
 * installed, the link is not one the CLI made, or the page could not be written). Never
 * rejects and never waits for the browser. The opener is detached and its output ignored.
 * The token is never in the opener's arguments. On `failed` the page is already deleted.
 */
export async function openInBrowser(
  link: string,
  options: OpenInBrowserOptions = {},
): Promise<BrowserOpening> {
  if (!isOpenableLink(link)) return FAILED;
  let launcher: LauncherFile;
  try {
    launcher = await writeLauncherFile(
      link,
      options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir },
    );
  } catch {
    return FAILED;
  }
  const command = browserCommand(options.platform ?? process.platform, launcher.path);
  const result =
    command === null ? "failed" : await spawnOpener(command, options.spawn ?? nodeSpawn);
  if (result === "failed") {
    await launcher.remove();
    return FAILED;
  }
  return { result, close: launcher.remove };
}
