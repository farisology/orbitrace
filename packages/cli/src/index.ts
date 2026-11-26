#!/usr/bin/env node
/**
 * Entry of the `orbitrace` command. Importing this module runs nothing; the command runs only
 * when Node was started with this file (directly or through the npm bin link).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { run, type CliIo } from "./cli.js";
import { CLI_EXIT_CODES } from "./errors.js";
import type { HostContext } from "./sessions.js";

export { CLI_NAME, cliVersion, statusLine, versionJson, versionLine } from "./version.js";
export { run, type CliIo } from "./cli.js";
export { appBundleDir, APP_BUNDLE_FOLDER, APP_INDEX_FILE } from "./app-bundle.js";
export { CLI_ERROR_CODES, CLI_EXIT_CODES, CliError, type CliErrorCode } from "./errors.js";
export type { HostContext } from "./sessions.js";
export type { OpenRuntime } from "./open.js";
export {
  startServer,
  ServerStartError,
  type LoopbackServer,
  type LoopbackServerOptions,
} from "./server/server.js";
export { buildLink } from "./server/link.js";
export {
  browserCommand,
  openInBrowser,
  writeLauncherFile,
  type BrowserOpening,
  type BrowserOpenResult,
  type LauncherFile,
} from "./server/browser.js";

/** The host context of this process. */
export function processHost(): HostContext {
  return { platform: process.platform, homeDir: homedir(), env: process.env, cwd: process.cwd() };
}

/**
 * Writes to the process's streams. A closed stdout (for example `| head`) ends the run quietly;
 * any other stdout failure ends it with the `internal` exit code and no stack trace, because a
 * stack trace names files on this machine.
 */
export function processIo(): CliIo {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.exit(error.code === "EPIPE" ? Number(process.exitCode ?? 0) : CLI_EXIT_CODES.internal);
  });
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

/** True when this module is the file Node was started with, following npm bin symlinks. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * The stop signal of this process: aborted on the first SIGINT (Ctrl+C) or SIGTERM, so `open`
 * closes its live streams and watches and exits. A second signal exits at once.
 */
export function processStopSignal(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) process.exit(signal === "SIGINT" ? 130 : 143);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return controller.signal;
}

if (isEntryPoint()) {
  void run(process.argv.slice(2), processIo(), processHost(), {
    stopSignal: processStopSignal(),
  }).then((code) => {
    process.exitCode = code;
    // The signal handlers above keep nothing alive; every server handle is closed by now.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });
}
