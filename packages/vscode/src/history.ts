/**
 * History in the editor (#211): the extension's side of core's history store, with no vscode
 * dependency, so it is unit tested with temporary folders and a stand-in worker.
 *
 * - One switch for both hosts: recording is core's settings file in the data folder
 *   (`readHistorySettings`, `setHistoryRecording`), the same file `orbitrace history enable` and
 *   `disable` write. There is no editor setting, so the editor and the command line never
 *   disagree.
 * - Off by default. With recording off the extension creates nothing on disk: it reads the
 *   settings file, and it opens the store as a reader only when the database file already exists.
 * - When on, it copies sessions into the store through core's recorder, in core's worker thread
 *   (shipped as its own file in the .vsix, `dist/history-worker.js`): every session once when the
 *   extension activates or recording is turned on, and a session a tab follows again after it
 *   changes (debounced). One copy at a time; another writer (an `orbitrace open`, another window)
 *   is never waited for. The recording stops when the extension deactivates or recording is
 *   turned off.
 * - Sessions kept only in the store are found through core's history root and history-aware
 *   adapter, so they list and replay like any other.
 * - Where `historyCapability()` says the store cannot run (VS Code 1.96 to 1.100, whose Node has
 *   no `node:sqlite`), nothing here loads, records or lists from the store; the commands say why.
 *
 * Paths stay on this machine: they are shown only to the user, in the editor, and never logged or
 * sent to the webview.
 */

import { homedir } from "node:os";
import type { SessionRef, SourceAdapter, SourceRoot } from "@orbitrace/core";
import {
  CLAUDE_CODE_RUNTIME,
  createHistoryRecorder,
  deleteHistoryStore,
  HISTORY_RECORD_DEBOUNCE_MS,
  historyAwareAdapter,
  historyCapability,
  historyRoot,
  historySettingsFile,
  historyStoreBytes,
  historyStoreExists,
  openHistoryStore,
  pathApiFor,
  readHistorySettings,
  resolveHistoryLocation,
  runHistoryIngestWorker,
  setHistoryRecording,
  toHistoryErrorInfo,
  withoutSqliteWarning,
  type HistoryCapability,
  type HistoryIngestResult,
  type HistoryLocation,
  type HistoryLocationOptions,
  type HistoryRecorder,
  type HistoryRecorderProblem,
  type HistorySessionSummary,
  type HistorySettings,
  type HistoryStore,
  type HistorySwitchResult,
  type HistoryTotals,
} from "@orbitrace/core/node";

/** The worker file the build writes beside `dist/extension.js` (#188, #211). */
export const HISTORY_WORKER_FILE = "history-worker.js";

/** The output channel history writes its notes to. No path, key or content. */
export const OUTPUT_CHANNEL = "Orbitrace";

/** How long a delete waits for a running writer (a recording window or `orbitrace open`). */
export const DELETE_LOCK_WAIT_MS = 3000;

/** Texts of the recorder's problems, in the editor's words. No path. */
export const RECORDER_MESSAGES = {
  off: "History recording was turned off; this window copies nothing more.",
  locked:
    "History: another process is writing the history store, so this window copies nothing until it finishes.",
  fatal: "History is not recorded in this window:",
  list: "History: the sessions to copy could not be listed; trying again later.",
  io: "History: a copy into the history store failed; trying again on the next change.",
  noWorker:
    "History is not recorded in this window: this build of the extension has no history worker.",
} as const;

/** The editor's text for one recorder problem. */
export function recorderMessage(problem: HistoryRecorderProblem): string {
  if (problem.kind === "fatal") {
    return `${RECORDER_MESSAGES.fatal} ${problem.reason ?? "the history store cannot be used."}`.trim();
  }
  return RECORDER_MESSAGES[problem.kind];
}

/** One line for the log after a copy. No path, key or content. */
export function ingestLogLine(result: HistoryIngestResult): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return `History: copied ${plural(result.linesAdded, "new line", "new lines")} from ${plural(result.sessions, "session", "sessions")} in the background worker (${result.durationMs} ms).`;
}

/**
 * A path for the user's own screen, with the home folder shown as `~`. Never written to a file,
 * a log or the webview.
 */
export function showLocalPath(path: string, homeDir: string, platform: string): string {
  const p = pathApiFor(platform);
  if (homeDir === "") return path;
  const relative = p.relative(homeDir, path);
  if (relative === "") return "~";
  if (relative.startsWith("..") || p.isAbsolute(relative)) return path;
  return `~${p.sep}${relative}`;
}

/** What the status command shows. */
export interface HistoryStatus {
  readonly settings: HistorySettings;
  readonly capability: HistoryCapability;
  readonly location: HistoryLocation;
  readonly exists: boolean;
  /** The store's totals, or null when there is no store or it cannot be read here. */
  readonly totals: HistoryTotals | null;
  /** Why the totals could not be read, when the store exists but could not be. No path. */
  readonly error: string | null;
  readonly bytes: number;
}

export interface ExtensionHistoryOptions {
  /** Environment for the data folder and the worker. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `os.homedir()`. */
  readonly homeDir?: string;
  /** Default `process.platform`. */
  readonly platform?: string;
  /** Whether the store can run here. Default: core's `historyCapability`, quietly, once. */
  readonly capability?: () => Promise<HistoryCapability>;
  /** The worker file, or null when this build has none. */
  readonly workerUrl: URL | string | null;
  /** Every session in the Claude Code folders now (not the store), for the full copy. */
  readonly listFileSessions: () => Promise<readonly SessionRef[]>;
  /** The session with this key, or null. */
  readonly findSession: (key: string) => Promise<SessionRef | null>;
  /** Default `HISTORY_RECORD_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
  /** Default `Date.now`. */
  readonly now?: () => number;
  /** Told about a recording problem once per kind, in the editor's words. */
  readonly onProblem?: (message: string, problem: HistoryRecorderProblem | null) => void;
  /** Told after each copy. */
  readonly onIngested?: (result: HistoryIngestResult) => void;
  /** Runs one copy. Default: core's worker. For tests. */
  readonly runWorker?: typeof runHistoryIngestWorker;
}

/** What the extension does with history. */
export interface ExtensionHistory {
  /** Core's location options for this extension host. */
  readonly locationOptions: HistoryLocationOptions;
  /** The home folder paths are shown relative to. */
  readonly homeDir: string;
  readonly platform: string;
  /** The data folder, or null when none can be worked out (with the reason). */
  location(): { location: HistoryLocation } | { location: null; reason: string };
  /** Whether the store can run in this extension host. Checked once. */
  capability(): Promise<HistoryCapability>;
  /** The switch, as the settings file says now. Never throws, never writes. */
  settings(): HistorySettings;
  /**
   * Turn recording on or off in the shared settings file, then start or stop recording in this
   * window. Throws core's `HistoryStoreError` (`unsafe-location`, `io`).
   */
  setRecording(on: boolean): Promise<HistorySwitchResult>;
  status(): Promise<HistoryStatus>;
  /** Whether the store's database file exists. Reads only; false when there is no place. */
  storeExists(): boolean;
  /** The stored sessions, newest first; empty when there is no store. */
  listStored(): Promise<readonly HistorySessionSummary[]>;
  /** Delete one stored session. Resolves whether the WAL was scrubbed too. */
  deleteSession(key: string): Promise<{ deleted: boolean; scrubbed: boolean }>;
  /** Delete the whole store. Resolves false when there was none. */
  deleteAll(): Promise<boolean>;
  /** The history root to search, when the store exists and can run here; else null. */
  root(): Promise<SourceRoot | null>;
  /** `adapters` with the Claude Code one wrapped to read the store too (when there is a place). */
  adapters(adapters: readonly SourceAdapter[]): readonly SourceAdapter[];
  /** Start or stop recording in this window to match the switch. Never rejects. */
  sync(): Promise<void>;
  /** A session a tab follows changed: copy it again soon, when recording is on. */
  sessionChanged(key: string): void;
  /** Whether this window is recording now. */
  readonly recording: boolean;
  /** Stop recording for good (deactivate). */
  stop(): Promise<void>;
  /** Resolves when no copy is running or pending. For tests. */
  idle(): Promise<void>;
}

interface Recording {
  readonly recorder: HistoryRecorder;
  retired: boolean;
  failed: boolean;
}

export function createExtensionHistory(options: ExtensionHistoryOptions): ExtensionHistory {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const locationOptions: HistoryLocationOptions = { env, homeDir, platform };
  let capabilityPromise: Promise<HistoryCapability> | null = null;
  /**
   * The recorder of this window. `retired`: it saw the switch turned off (by any host) and copies
   * nothing more, so turning recording on again starts a new one. `failed`: the store cannot be
   * used here; it is not started again until the next activation.
   */
  let current: Recording | null = null;
  let stopped = false;
  let noWorkerReported = false;
  let syncing: Promise<void> = Promise.resolve();

  const location = (): { location: HistoryLocation } | { location: null; reason: string } => {
    try {
      return { location: resolveHistoryLocation(locationOptions) };
    } catch (error) {
      return { location: null, reason: toHistoryErrorInfo(error).message };
    }
  };
  const place = (): HistoryLocation => {
    const found = location();
    if (found.location === null) throw new Error(found.reason);
    return found.location;
  };

  const capability = (): Promise<HistoryCapability> => {
    capabilityPromise ??= (options.capability ?? (() => withoutSqliteWarning(historyCapability)))();
    return capabilityPromise;
  };

  const settings = (): HistorySettings => {
    const found = location();
    if (found.location === null) return { state: "missing", recording: false };
    return readHistorySettings(historySettingsFile(found.location, platform));
  };

  const withReader = async <T>(body: (store: HistoryStore) => T): Promise<T> => {
    const store = await withoutSqliteWarning(() =>
      openHistoryStore({ ...locationOptions, mode: "read" }),
    );
    try {
      return body(store);
    } finally {
      store.close();
    }
  };

  const report = (message: string, problem: HistoryRecorderProblem | null): void => {
    try {
      options.onProblem?.(message, problem);
    } catch {
      // A reporter must not break recording.
    }
  };

  const syncOnce = async (): Promise<void> => {
    if (stopped) return;
    const on = settings().recording;
    if (!on) {
      const running = current;
      current = null;
      await running?.recorder.stop();
      return;
    }
    if (current !== null && !current.retired) return;
    if (current !== null) {
      // Turned off from another host and on again: start afresh.
      const old = current;
      current = null;
      await old.recorder.stop();
    }
    const found = location();
    if (found.location === null) return;
    const ability = await capability();
    // Where the store cannot run nothing else changes: the commands say why.
    if (!ability.available || stopped) return;
    if (options.workerUrl === null) {
      if (!noWorkerReported) report(RECORDER_MESSAGES.noWorker, null);
      noWorkerReported = true;
      return;
    }
    const dir = found.location.dir;
    const entry: Recording = {
      recorder: createHistoryRecorder({
        workerUrl: options.workerUrl,
        dataDir: dir,
        env,
        isRecordingOn: () => settings().recording,
        listSessions: options.listFileSessions,
        findSession: options.findSession,
        debounceMs: options.debounceMs ?? HISTORY_RECORD_DEBOUNCE_MS,
        now: options.now ?? Date.now,
        onProblem: (_message, problem) => {
          if (problem.kind === "off") entry.retired = true;
          if (problem.kind === "fatal") entry.failed = true;
          report(recorderMessage(problem), problem);
        },
        ...(options.onIngested === undefined ? {} : { onIngested: options.onIngested }),
        ...(options.runWorker === undefined ? {} : { runWorker: options.runWorker }),
      }),
      retired: false,
      failed: false,
    };
    current = entry;
    entry.recorder.start();
  };

  const sync = (): Promise<void> => {
    // One at a time, so two quick calls never start two recorders.
    syncing = syncing.then(syncOnce).catch(() => undefined);
    return syncing;
  };

  return {
    locationOptions,
    homeDir,
    platform,
    location,
    capability,
    settings,
    async setRecording(on) {
      const result = setHistoryRecording(place(), on, locationOptions);
      await sync();
      return result;
    },
    async status() {
      const where = place();
      const ability = await capability();
      const exists = historyStoreExists(where);
      let totals: HistoryTotals | null = null;
      let error: string | null = null;
      if (exists && ability.available) {
        try {
          totals = await withReader((store) => store.totals());
        } catch (caught) {
          error = toHistoryErrorInfo(caught).message;
        }
      }
      return {
        settings: settings(),
        capability: ability,
        location: where,
        exists,
        totals,
        error,
        bytes: historyStoreBytes(where),
      };
    },
    storeExists() {
      const found = location();
      return found.location !== null && historyStoreExists(found.location);
    },
    async listStored() {
      if (!historyStoreExists(place())) return [];
      return withReader((store) => store.listSessions());
    },
    async deleteSession(key) {
      if (!historyStoreExists(place())) return { deleted: false, scrubbed: true };
      const store = await withoutSqliteWarning(() =>
        openHistoryStore({ ...locationOptions, mode: "write", lockWaitMs: DELETE_LOCK_WAIT_MS }),
      );
      try {
        return store.deleteSession(key);
      } finally {
        store.close();
      }
    },
    deleteAll() {
      return deleteHistoryStore({ ...locationOptions, lockWaitMs: DELETE_LOCK_WAIT_MS });
    },
    async root() {
      try {
        const found = location();
        if (found.location === null || !historyStoreExists(found.location)) return null;
        const ability = await capability();
        return ability.available ? historyRoot(found.location.dbFile) : null;
      } catch {
        return null;
      }
    },
    adapters(adapters) {
      const found = location();
      if (found.location === null) return adapters;
      const dbFile = found.location.dbFile;
      return adapters.map((adapter) =>
        adapter.runtime === CLAUDE_CODE_RUNTIME
          ? historyAwareAdapter(adapter, dbFile, locationOptions)
          : adapter,
      );
    },
    sync,
    sessionChanged(key) {
      if (stopped) return;
      void sync().then(() => current?.recorder.sessionChanged(key));
    },
    get recording() {
      return current !== null && !current.retired && !current.failed;
    },
    async stop() {
      stopped = true;
      await syncing;
      const running = current;
      current = null;
      await running?.recorder.stop();
    },
    async idle() {
      await syncing;
      await current?.recorder.idle();
    },
  };
}
