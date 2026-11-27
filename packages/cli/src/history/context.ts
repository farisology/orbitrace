/**
 * What the history commands (#195) share: where the store is for this host, whether this Node
 * can run it, the worker file, and what the command takes from the process (the runtime). The
 * timings and the store facts are core's since #211, shared with the editor extension.
 *
 * Every location comes from the `HostContext` (its environment and home folder), never from
 * `process.env`, so tests and the doctor read the same folders the command would.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HISTORY_ENDED_AFTER_MS,
  HISTORY_RECORD_DEBOUNCE_MS,
  historyCapability,
  historyStoreBytes,
  historyStoreExists,
  isHistorySessionEnded,
  resolveHistoryLocation,
  withoutSqliteWarning,
  type HistoryCapability,
  type HistoryLocation,
  type HistoryLocationOptions,
} from "@orbitrace/core/node";
import type { SessionRef } from "@orbitrace/core";
import { showPath } from "../doctor/paths.js";
import type { HostContext } from "../sessions.js";

/** The worker file the build writes beside `dist/index.js` (#188). */
export const HISTORY_WORKER_FILE = "history-worker.js";

/** How long after its last activity an ended session's unfinished last line is taken (core's). */
export const ENDED_AFTER_MS = HISTORY_ENDED_AFTER_MS;

/** How long `open` waits after a session change before it copies the session (core's). */
export const RECORD_DEBOUNCE_MS = HISTORY_RECORD_DEBOUNCE_MS;

/** What the history commands take from the process. Every field has a default; tests replace them. */
export interface HistoryRuntime {
  /** Whether the history store can run here. Default: core's `historyCapability`, quietly. */
  readonly capability?: () => Promise<HistoryCapability>;
  /**
   * The worker file. Default: `history-worker.js` beside this bundle (`defaultWorkerUrl`).
   * `null` means this build has none.
   */
  readonly workerUrl?: URL | string | null;
  /** Whether stdin and stderr are terminals. Default: the process's streams. */
  readonly terminal?: { readonly stdin: boolean; readonly stderr: boolean };
  /** Asks a yes-or-no question on the terminal. Default: a readline prompt on stderr. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** `open`: how long to wait after a session change before copying it. Default 2000 ms. */
  readonly debounceMs?: number;
  /** Clock, Unix epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** Core's location options for this host. */
export function locationOptions(host: HostContext): HistoryLocationOptions {
  return { env: host.env, homeDir: host.homeDir, platform: host.platform };
}

/** Where the store is for this host. Throws core's `unsafe-location` error. */
export function historyLocationFor(host: HostContext): HistoryLocation {
  return resolveHistoryLocation(locationOptions(host));
}

/** Where the store is, or null when no folder can be worked out. Never throws. */
export function tryHistoryLocation(host: HostContext): HistoryLocation | null {
  try {
    return historyLocationFor(host);
  } catch {
    return null;
  }
}

/** Whether the store's database file exists. Reads only. Core's `historyStoreExists`. */
export function storeExists(location: HistoryLocation): boolean {
  return historyStoreExists(location);
}

/**
 * Whether the history store can run in this process. Core loads `node:sqlite` on the first call;
 * on Node 22 and 23 that load prints an experimental warning, which is held back here.
 */
export function capabilityOf(runtime: HistoryRuntime): Promise<HistoryCapability> {
  return (runtime.capability ?? (() => withoutSqliteWarning(historyCapability)))();
}

/**
 * The worker file beside this module: `dist/history-worker.js` beside `dist/index.js` in a build
 * (#188), or null when it is not there (run from the sources).
 */
export function defaultWorkerUrl(moduleUrl: string | URL = import.meta.url): URL | null {
  const url = new URL(`./${HISTORY_WORKER_FILE}`, moduleUrl);
  try {
    return existsSync(fileURLToPath(url)) ? url : null;
  } catch {
    return null;
  }
}

/** The worker file of this runtime. */
export function workerUrlOf(runtime: HistoryRuntime): URL | string | null {
  return runtime.workerUrl === undefined ? defaultWorkerUrl() : runtime.workerUrl;
}

/** A path for the user's own screen, with the home folder as `~`, as the doctor shows paths. */
export function showLocalPath(path: string, host: HostContext): string {
  return showPath(path, host.homeDir, host.platform);
}

/** The bytes of the database and the files SQLite keeps beside it. Core's `historyStoreBytes`. */
export function storeBytes(location: HistoryLocation): number {
  return historyStoreBytes(location);
}

/**
 * Whether a session has ended, so its unfinished last line may be taken (core's
 * `endedSessionKeys`): its live status says ended and nothing was written to it for a minute.
 */
export function isEndedSession(ref: SessionRef, now: number): boolean {
  return isHistorySessionEnded(ref, now);
}
