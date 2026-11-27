/**
 * `orbitrace open` (and a bare `orbitrace`): start the loopback server, print the link, open the
 * default browser, and run until Ctrl+C.
 *
 * Output:
 * - Without `--json`, the link is the only line on stdout, so a script can read it; the notes
 *   for people go to stderr.
 * - With `--json`, one JSON document on stdout once the server listens:
 *   `{ "url", "origin", "port", "key", "browser", "warnings" }`.
 *
 * History (#195): sessions only the history store holds are listed and served too. When the user
 * turned recording on, a background recorder copies sessions into the store in a worker thread
 * (at start, and after a change to a session the app follows) and stops with the server.
 */

import { listSessions, type SourceAdapter } from "@orbitrace/core";
import type { SessionReplayer } from "@orbitrace/core/node";
import type { ParsedCommand } from "./args.js";
import { appBundleDir } from "./app-bundle.js";
import { CliError, EXIT_OK } from "./errors.js";
import {
  capabilityOf,
  locationOptions,
  RECORD_DEBOUNCE_MS,
  tryHistoryLocation,
  workerUrlOf,
  type HistoryRuntime,
} from "./history/context.js";
import { createHistoryRecorder, type HistoryRecorder } from "./history/recorder.js";
import { historySettingsFile, readHistorySettings } from "./history/settings.js";
import { historyAwareAdapter, historyRootNow, historySearch } from "./history/source.js";
import { openInBrowser, type BrowserOpening, type BrowserOpenResult } from "./server/browser.js";
import { ServerStartError, startServer, type LoopbackServer } from "./server/server.js";
import {
  CLI_ADAPTERS,
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
  /** The history store's capability check, worker file and timings (#195). */
  readonly history?: HistoryRuntime;
  /** Called with the background recorder when history recording is on. For tests. */
  readonly onRecorder?: (recorder: HistoryRecorder) => void;
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

/** Whether `open` records history in this run: the worker file to use, or null, and why not. */
async function historyRecording(
  host: HostContext,
  history: HistoryRuntime,
): Promise<{ workerUrl: URL | string | null; warnings: CliWarning[] }> {
  const off = { workerUrl: null, warnings: [] };
  const location = tryHistoryLocation(host);
  if (location === null) return off;
  // Reads the settings file only; with recording off nothing else is loaded or created.
  if (!readHistorySettings(historySettingsFile(location, host.platform)).recording) return off;
  const capability = await capabilityOf(history);
  if (!capability.available) {
    return {
      workerUrl: null,
      warnings: [
        {
          code: "history-not-recorded",
          message: `History recording is on, but this run records nothing: ${capability.reason}`,
        },
      ],
    };
  }
  const workerUrl = workerUrlOf(history);
  if (workerUrl === null) {
    return {
      workerUrl: null,
      warnings: [
        {
          code: "history-not-recorded",
          message:
            "History recording is on, but this run records nothing: this build of orbitrace has no history worker.",
        },
      ],
    };
  }
  return { workerUrl, warnings: [] };
}

/**
 * The replayer the server uses while recording: the same, except that each replay sent for a
 * session the app follows (its first state and every change) tells the recorder to copy it.
 */
export function recordingReplayer(
  replayer: SessionReplayer,
  recorder: HistoryRecorder,
): SessionReplayer {
  return {
    list: (options) => replayer.list(options),
    find: (key) => replayer.find(key),
    load: (key) => replayer.load(key),
    follow: (key, listener) =>
      replayer.follow(key, (update) => {
        if (update.type === "replay") recorder.sessionChanged(key);
        listener(update);
      }),
  };
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

  const history = runtime.history ?? {};
  const resolved = await resolveRoots(host, command.sources);
  const search = await historySearch(host, history, CLI_ADAPTERS);
  const recording = await historyRecording(host, history);
  const warnings = [...resolved.warnings, ...search.warnings, ...recording.warnings];
  if (!command.json) writeWarnings(io, warnings);

  // Sessions only the history store holds are listed and replayed too (#195). The store is
  // looked for on every listing: recording may create it after the start.
  const location = tryHistoryLocation(host);
  const adapters: readonly SourceAdapter[] =
    location === null
      ? CLI_ADAPTERS
      : CLI_ADAPTERS.map((adapter) =>
          historyAwareAdapter(adapter, location.dbFile, locationOptions(host)),
        );
  const fileRoots = rootsOnEveryListing(host, command.sources);
  const replayer = createReplayer(async () => {
    const roots = await fileRoots();
    const root = await historyRootNow(host, history);
    return root === null ? roots : [...roots, root];
  }, adapters);
  const key = await pickKey(command, replayer);

  const recorder =
    recording.workerUrl === null || location === null
      ? null
      : createHistoryRecorder({
          workerUrl: recording.workerUrl,
          dataDir: location.dir,
          env: host.env,
          // Read again before each copy, so `history disable` stops this run too.
          isRecordingOn: () =>
            readHistorySettings(historySettingsFile(location, host.platform)).recording,
          listSessions: async () => listSessions(await fileRoots(), CLI_ADAPTERS),
          findSession: (wanted) => replayer.find(wanted).catch(() => null),
          debounceMs: history.debounceMs ?? RECORD_DEBOUNCE_MS,
          now: history.now ?? Date.now,
          ...(command.json
            ? {}
            : { onProblem: (message: string) => io.stderr(`orbitrace: warning: ${message}\n`) }),
        });
  const served = recorder === null ? replayer : recordingReplayer(replayer, recorder);

  let server: LoopbackServer;
  try {
    server = await startServer({
      replayer: served,
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
    if (recorder !== null) {
      runtime.onRecorder?.(recorder);
      // In the background: the server is already serving.
      recorder.start();
    }
    runtime.onListening?.(server);
    await waitForStop(runtime.stopSignal);
  } finally {
    try {
      // Stops with the server: a running copy is terminated, what it committed stays.
      await recorder?.stop();
      await server.close();
    } finally {
      await opening?.close();
    }
  }
  if (!command.json) io.stderr("Stopped the local server.\n");
  return EXIT_OK;
}
