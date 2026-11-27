/**
 * Launcher of the integration suite (`npm run test:integration -w orbitrace-vscode`).
 *
 * 1. Checks that the extension is built (`dist/extension.js` and the app in `dist/app`).
 * 2. Creates a sandbox (`sandbox.ts`): synthetic config tree, empty home, workspace, profile.
 * 3. Downloads VS Code once into `node_modules/.cache/vscode-test/` of this package (see
 *    `downloadCacheDir`; `ensureDownloadCacheDir` creates the folder first, #125) with
 *    `@vscode/test-electron` and starts it with the built extension from this package, the
 *    suite bundle (`dist/suite.cjs`), the sandbox's workspace and profile folders, and
 *    `CLAUDE_CONFIG_DIR` / `HOME` pointing into the sandbox.
 * 4. Prints the suite's report, which the suite writes into the sandbox: recent VS Code
 *    versions do not pass the extension host's console output on.
 * 5. Makes sure the editor is gone. VS Code quits by itself when the suite ends. If it has not
 *    quit `QUIT_GRACE_MS` after the suite wrote its result (it did not while its main process
 *    was blocked on the keychain, see `editorArguments` in sandbox.ts), or the whole run takes
 *    longer than the timeout, the launcher kills the editor's process group, and then any
 *    process still holding the sandbox.
 * 6. Deletes the sandbox.
 *
 * The editor is started here instead of with `runTests` from `@vscode/test-electron`, because
 * `runTests` gives no handle on the process to stop it. The arguments are the ones `runTests`
 * passes.
 *
 * Needs Node.js 22 or later (the `engines` range of `@vscode/test-electron` 3).
 *
 * Settings, all optional: `ORBITRACE_VSCODE_VERSION` (`stable` by default, `insiders`, or a
 * number such as `1.96.0`, the lowest the manifest accepts); `ORBITRACE_IT_TIMEOUT_MS` (whole
 * run, default 180000); `ORBITRACE_IT_KEEP_SANDBOX=1` keeps the sandbox, with the editor's
 * logs under `ud/logs`, when a run fails; `ORBITRACE_IT_EDITOR_ARGS` adds editor arguments,
 * separated by spaces, for debugging.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_BUNDLE_SEGMENTS, APP_INDEX_FILE } from "../src/app-bundle.js";
import {
  createSandbox,
  editorArguments,
  editorEnvironment,
  removeSandbox,
  type SandboxDescription,
} from "./sandbox.js";
import { readSuiteResult, SUITE_LOG_FILE, type SuiteResult } from "./sandbox-description.js";

/** Environment variable that picks the VS Code version. */
export const VERSION_ENV = "ORBITRACE_VSCODE_VERSION";

/** Environment variable with the timeout of the whole run, in milliseconds. */
export const TIMEOUT_ENV = "ORBITRACE_IT_TIMEOUT_MS";

/** Environment variable that keeps the sandbox (with the editor's logs) after a failed run. */
export const KEEP_ENV = "ORBITRACE_IT_KEEP_SANDBOX";

/**
 * Environment variable with extra editor arguments, separated by spaces, for debugging a run
 * (for example `--remote-debugging-port=9339` to look into the webview with a debugger).
 */
export const EXTRA_ARGS_ENV = "ORBITRACE_IT_EDITOR_ARGS";

/** Lowest Node.js major version `@vscode/test-electron` 3 supports (its `engines` field). */
export const MIN_NODE_MAJOR = 22;

/** True when a Node.js version string such as `v20.19.0` is older than `MIN_NODE_MAJOR`. */
export function nodeTooOld(version: string): boolean {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return !Number.isFinite(major) || major < MIN_NODE_MAJOR;
}

/** Default timeout of the whole run, download excluded. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** How long the editor may take to quit after the suite has written its result. */
export const QUIT_GRACE_MS = 10_000;

/** File, in the sandbox, that receives the editor's own output. */
export const EDITOR_OUTPUT_FILE = "editor-output.log";

/** Arguments `@vscode/test-electron`'s `runTests` passes to every test editor. */
export const TEST_EDITOR_ARGUMENTS = [
  "--no-sandbox",
  "--disable-gpu-sandbox",
  "--disable-updates",
  "--skip-welcome",
  "--skip-release-notes",
  "--no-cached-data",
  "--disable-workspace-trust",
] as const;

/** The folder of this package, from the bundle's location `test-integration/dist/`. */
export function packageDirFrom(bundleDir: string): string {
  return resolve(bundleDir, "..", "..");
}

/**
 * Where the downloaded editor is kept between runs: `node_modules/.cache/vscode-test` of this
 * package. Not `.vscode-test/` (the usual name): the repository's ESLint configuration does not
 * ignore that folder, so `npm run lint` would lint the downloaded editor. `node_modules` is
 * ignored by git, ESLint and Prettier alike. `npm ci` deletes it, and the next run downloads
 * the editor again.
 */
export function downloadCacheDir(packageDir: string): string {
  return join(packageDir, "node_modules", ".cache", "vscode-test");
}

/**
 * Create the download cache folder with its parents and return its path (#125).
 * `@vscode/test-electron` 3 creates `cachePath` with a non-recursive `mkdirSync`, and `npm ci`
 * does not create `node_modules/.cache`, so without this the first run on a fresh clone fails
 * with `ENOENT`. Does nothing when the folder exists.
 */
export function ensureDownloadCacheDir(packageDir: string): string {
  const dir = downloadCacheDir(packageDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The suite bundle the extension host loads. */
export function suiteBundlePath(packageDir: string): string {
  return join(packageDir, "test-integration", "dist", "suite.cjs");
}

/** Built files the editor needs, relative to the package folder, that are missing. */
export function missingBuildOutputs(packageDir: string): string[] {
  const needed = [
    join("dist", "extension.js"),
    join(...APP_BUNDLE_SEGMENTS, APP_INDEX_FILE),
    join("test-integration", "dist", "suite.cjs"),
  ];
  return needed.filter((relative) => !existsSync(join(packageDir, relative)));
}

/** Settings read from the environment. */
export interface RunSettings {
  readonly version: string;
  readonly timeoutMs: number;
  readonly keepSandbox: boolean;
  /** Extra editor arguments, from `EXTRA_ARGS_ENV`. */
  readonly extraArguments: readonly string[];
}

/** Read the settings. A timeout that is not a positive number falls back to the default. */
export function readSettings(env: Readonly<Record<string, string | undefined>>): RunSettings {
  const version = env[VERSION_ENV]?.trim();
  const timeout = Number(env[TIMEOUT_ENV]);
  return {
    version: version === undefined || version === "" ? "stable" : version,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    keepSandbox: env[KEEP_ENV] === "1",
    extraArguments: (env[EXTRA_ARGS_ENV] ?? "").split(/\s+/).filter((arg) => arg !== ""),
  };
}

/** The full argument list of the test editor. */
export function testEditorArguments(
  packageDir: string,
  sandbox: SandboxDescription,
  extraArguments: readonly string[] = [],
): string[] {
  return [
    ...editorArguments(sandbox),
    ...extraArguments,
    ...TEST_EDITOR_ARGUMENTS,
    `--extensionTestsPath=${suiteBundlePath(packageDir)}`,
    `--extensionDevelopmentPath=${packageDir}`,
  ];
}

/** Kill a process group started with `detached: true` (the whole tree on Windows). */
function killEditor(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/**
 * Process ids whose command line mentions `marker` (the sandbox folder, which every editor
 * process carries in `--user-data-dir`). Empty on Windows, where `pgrep` does not exist.
 */
export function processesMentioning(marker: string): number[] {
  if (process.platform === "win32") return [];
  const found = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  return (found.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

/** How a run of the editor ended. */
export interface EditorRun {
  /** The suite's result, or null when it wrote none. */
  readonly result: SuiteResult | null;
  /** Exit code or signal of the editor, or `killed` when the launcher stopped it. */
  readonly exit: string;
  readonly timedOut: boolean;
}

/** Start the editor and wait until it is gone. */
async function runEditor(
  executable: string,
  packageDir: string,
  sandbox: SandboxDescription,
  settings: RunSettings,
): Promise<EditorRun> {
  const output = createWriteStream(join(sandbox.root, EDITOR_OUTPUT_FILE));
  const child = spawn(
    executable,
    testEditorArguments(packageDir, sandbox, settings.extraArguments),
    {
      env: editorEnvironment(sandbox, process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });

  let killed = false;
  let timedOut = false;
  const exited = new Promise<string>((done) => {
    child.on("exit", (code, signal) => done(code !== null ? String(code) : String(signal)));
    child.on("error", (error) => done(`error: ${error.message}`));
  });
  const started = Date.now();
  let resultSeenAt: number | null = null;
  const watchdog = setInterval(() => {
    if (resultSeenAt === null && readSuiteResult(sandbox.root) !== null) resultSeenAt = Date.now();
    const quitOverdue = resultSeenAt !== null && Date.now() - resultSeenAt > QUIT_GRACE_MS;
    const runOverdue = Date.now() - started > settings.timeoutMs;
    if (quitOverdue || runOverdue) {
      timedOut = runOverdue && resultSeenAt === null;
      killed = true;
      killEditor(child);
    }
  }, 250);
  const exit = await exited;
  clearInterval(watchdog);
  // Helpers can outlive the main process for a moment; anything left that holds the sandbox
  // is ours.
  for (const pid of processesMentioning(sandbox.root)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  output.end();
  return { result: readSuiteResult(sandbox.root), exit: killed ? "killed" : exit, timedOut };
}

/** The suite's log from the sandbox, or a note that there is none. */
function suiteLog(sandbox: SandboxDescription): string {
  const file = join(sandbox.root, SUITE_LOG_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : "(the suite wrote no log)\n";
}

/** The last `lines` lines of the editor's output. */
function editorOutputTail(sandbox: SandboxDescription, lines: number): string {
  const file = join(sandbox.root, EDITOR_OUTPUT_FILE);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

/** Run the suite once. Resolves with the process exit code. */
export async function main(packageDir: string): Promise<number> {
  if (nodeTooOld(process.version)) {
    console.error(
      `test:integration: needs Node.js ${MIN_NODE_MAJOR} or later (this is ${process.version}).`,
    );
    return 1;
  }
  const missing = missingBuildOutputs(packageDir);
  if (missing.length > 0) {
    console.error(
      `test:integration: missing ${missing.join(", ")}. Run 'npm run build' at the repository root first.`,
    );
    return 1;
  }
  const settings = readSettings(process.env);
  // Loaded here, not at the top, so the unit tests of this file (which run on every Node.js
  // version the repository supports) never load it.
  const { downloadAndUnzipVSCode } = await import("@vscode/test-electron");
  const executable = await downloadAndUnzipVSCode({
    version: settings.version,
    cachePath: ensureDownloadCacheDir(packageDir),
  });
  const sandbox = createSandbox();
  let passed = false;
  try {
    const run = await runEditor(executable, packageDir, sandbox, settings);
    process.stdout.write(suiteLog(sandbox));
    passed = run.result !== null && run.result.failed === 0 && run.result.passed > 0;
    const left = processesMentioning(sandbox.root);
    console.log(
      `test:integration: editor exit ${run.exit}${run.timedOut ? ` (timed out after ${settings.timeoutMs} ms)` : ""}; editor processes left: ${left.length}`,
    );
    if (!passed) {
      console.error("test:integration: last lines of the editor's output:");
      console.error(editorOutputTail(sandbox, 40));
    }
    return passed && left.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`test:integration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (!passed && settings.keepSandbox) {
      console.error(`test:integration: sandbox kept for inspection: ${sandbox.root}`);
    } else {
      removeSandbox(sandbox);
    }
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  process.exitCode = await main(packageDirFrom(dirname(fileURLToPath(import.meta.url))));
}
