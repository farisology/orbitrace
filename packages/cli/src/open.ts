/**
 * `orbitrace open` (and a bare `orbitrace`): start the loopback server, print the link, open the
 * default browser, and run until Ctrl+C.
 *
 * Output:
 * - Without `--json`, the link is the only line on stdout, so a script can read it; the notes
 *   for people go to stderr.
 * - With `--json`, one JSON document on stdout once the server listens:
 *   `{ "url", "origin", "port", "key", "browser", "warnings" }`.
 */

import type { ParsedCommand } from "./args.js";
import { appBundleDir } from "./app-bundle.js";
import { CliError, EXIT_OK } from "./errors.js";
import { openInBrowser, type BrowserOpening, type BrowserOpenResult } from "./server/browser.js";
import { ServerStartError, startServer, type LoopbackServer } from "./server/server.js";
import {
  chooseSession,
  createReplayer,
  resolveRoots,
  rootsOnEveryListing,
  type CliWarning,
  type HostContext,
} from "./sessions.js";

/** Where the command writes. The same shape as `CliIo` in cli.ts. */
export interface OpenIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** What `open` needs from the process. Every field has a default; tests replace them. */
export interface OpenRuntime {
  /** Aborted when the user asks to stop. Default: the process's SIGINT and SIGTERM. */
  readonly stopSignal?: AbortSignal;
  /**
   * Opens a link in the default browser. Default: `openInBrowser`. Its `close` is called when
   * the server stops (it deletes the launcher page that held the link).
   */
  readonly openBrowser?: (link: string) => Promise<BrowserOpening>;
  /** The web app folder. Default: `appBundleDir()`. `null` means this build has none. */
  readonly appDir?: string | null;
  /** Called once the server listens and the link is printed. */
  readonly onListening?: (server: LoopbackServer) => void;
}

/** What `browser` says in the JSON document. */
export type BrowserStatus = BrowserOpenResult | "skipped";

/** The `app-missing` message and hint. `orbitrace doctor` gives the same fix. */
export const APP_MISSING_MESSAGE = "This build of orbitrace has no web app to serve.";
export const APP_MISSING_HINT =
  "Build the repository with 'npm run build', then run the built command.";

/** Resolve when `signal` aborts, or, without one, on the process's SIGINT or SIGTERM. */
export function waitForStop(signal?: AbortSignal): Promise<void> {
  if (signal !== undefined) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function writeWarnings(io: OpenIo, warnings: readonly CliWarning[]): void {
  for (const warning of warnings) io.stderr(`orbitrace: warning: ${warning.message}\n`);
}

/** The session key to put in the link, or `undefined` for the session list. */
async function pickKey(
  command: Extract<ParsedCommand, { kind: "open" }>,
  replayer: ReturnType<typeof createReplayer>,
): Promise<string | undefined> {
  if (command.key !== undefined) return chooseSession(replayer, { key: command.key });
  if (command.latest) return chooseSession(replayer, { latest: true });
  const [newest] = await replayer.list({ limit: 1 });
  return newest?.key;
}

const BROWSER_TEXT: Readonly<Record<BrowserStatus, string>> = {
  opened: "Opened the link in your default browser.\n",
  failed: "Could not open a browser. Open the link yourself.\n",
  skipped: "",
};

/** Run `open`. Resolves with the exit code once the user stopped it and the server is closed. */
export async function runOpen(
  command: Extract<ParsedCommand, { kind: "open" }>,
  io: OpenIo,
  host: HostContext,
  runtime: OpenRuntime = {},
): Promise<number> {
  const appDir = runtime.appDir === undefined ? appBundleDir() : runtime.appDir;
  if (appDir === null) throw new CliError("app-missing", APP_MISSING_MESSAGE, APP_MISSING_HINT);

  const { warnings } = await resolveRoots(host, command.sources);
  if (!command.json) writeWarnings(io, warnings);
  const replayer = createReplayer(rootsOnEveryListing(host, command.sources));
  const key = await pickKey(command, replayer);

  let server: LoopbackServer;
  try {
    server = await startServer({
      replayer,
      appDir,
      ...(command.port === undefined ? {} : { port: command.port }),
    });
  } catch (error) {
    if (
      error instanceof ServerStartError &&
      (error.reason === "port-in-use" || error.reason === "port-denied")
    ) {
      throw new CliError(
        "port-unavailable",
        `Port ${command.port ?? 0} of 127.0.0.1 is in use or may not be used.`,
        "Leave out --port to use a free port.",
      );
    }
    throw error;
  }

  let opening: BrowserOpening | undefined;
  try {
    const link = server.link(key);
    if (command.browser) opening = await (runtime.openBrowser ?? openInBrowser)(link);
    const browser: BrowserStatus = opening?.result ?? "skipped";
    if (command.json) {
      io.stdout(
        `${JSON.stringify({
          url: link,
          origin: server.origin,
          port: server.port,
          key: key ?? null,
          browser,
          warnings,
        })}\n`,
      );
    } else {
      io.stderr(
        `Orbitrace is serving on ${server.origin} (this computer only).\n` +
          "The link below holds a token for this run. Anyone with it can read your sessions: do not share it.\n",
      );
      io.stdout(`${link}\n`);
      io.stderr(`${BROWSER_TEXT[browser]}Press Ctrl+C to stop.\n`);
    }
    runtime.onListening?.(server);
    await waitForStop(runtime.stopSignal);
  } finally {
    try {
      await server.close();
    } finally {
      await opening?.close();
    }
  }
  if (!command.json) io.stderr("Stopped the local server.\n");
  return EXIT_OK;
}
