/// <reference types="node" />
/**
 * Background recording into the history store while a host runs (#195; shared by the
 * `orbitrace open` command and the editor extension since #211), once the user turned recording
 * on.
 *
 * - `start`: every session under the roots is copied into the history store.
 * - `sessionChanged`: when a session the host shows changes, that session is copied again after a
 *   short quiet period (`debounceMs`), so a burst of appended lines is one ingest.
 * - Each ingest runs in core's worker thread (`runHistoryIngestWorker`), so the host's thread is
 *   never blocked. One worker at a time: changes that come while one runs are copied by the next.
 * - Another writer (an `orbitrace open` or another editor window that is recording) holds the
 *   writer lock: the copy does not wait for it (`lockWaitMs` 0), it is reported once and the next
 *   change tries again, so two hosts never block each other.
 * - `stop` (the host stopping) cancels the timer and terminates a running worker; what it
 *   committed stays, and its lock is removed. No daemon: nothing runs after the host ends.
 *
 * A session the host knows has ended (`isHistorySessionEnded`) is passed as ended, so an
 * unfinished last line in it is taken once. Failures never stop the host: the first one of each
 * kind is reported through `onProblem`, and a store that cannot be used turns recording off for
 * this recorder.
 *
 * The switch is read again (`isRecordingOn`, a small file read) before each copy is scheduled and
 * before each copy starts, so turning recording off from any host stops this recorder before its
 * next copy: what is pending is dropped, nothing more is copied by it, and that is said once
 * through `onProblem`. A copy already running when the switch is turned off finishes.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import type { SessionRef } from "../model/sources.js";
import type { SessionReplayer } from "../host/session-replayer.js";
import { HistoryStoreError } from "./errors.js";
import type { HistoryIngestRequest, HistoryIngestResult } from "./ingest.js";
import { runHistoryIngestWorker } from "./run-worker.js";
import { isHistoryRef } from "./source.js";

/** How long after its last activity an ended session's unfinished last line is taken. */
export const HISTORY_ENDED_AFTER_MS = 60_000;

/** How long a host waits after a session change before it copies the session. */
export const HISTORY_RECORD_DEBOUNCE_MS = 2000;

/**
 * Whether a session has ended, so its unfinished last line may be taken (the ingest's
 * `endedSessionKeys`): its live status says ended and nothing was written to it for a minute.
 */
export function isHistorySessionEnded(
  ref: Pick<SessionRef, "live" | "lastActivity">,
  now: number,
): boolean {
  return ref.live === "ended" && now - ref.lastActivity >= HISTORY_ENDED_AFTER_MS;
}

/**
 * The kinds of problem a recorder reports, once each:
 * - `off`: the switch was turned off; this recorder copies nothing more.
 * - `locked`: another process is writing the store; tried again on the next change.
 * - `fatal`: the store cannot be used here (`reason` says why); this recorder stops copying.
 * - `list`: the sessions to copy could not be listed; tried again later.
 * - `io`: one copy failed; tried again on the next change.
 */
export type HistoryRecorderProblemKind = "off" | "locked" | "fatal" | "list" | "io";

/** One problem, for a host that words it its own way. */
export interface HistoryRecorderProblem {
  readonly kind: HistoryRecorderProblemKind;
  /** For `fatal`: the store error's message, which names no path. */
  readonly reason?: string;
}

export interface HistoryRecorderOptions {
  /** The worker file. */
  readonly workerUrl: URL | string;
  /** The data folder, already resolved for this host. */
  readonly dataDir: string;
  /** The environment for the worker. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Whether recording is still on (the settings file says so). Read before each copy is
   * scheduled and before each copy starts; false, or a throw, stops this recorder.
   */
  readonly isRecordingOn: () => boolean;
  /** Every session under the roots now (listed again for each full copy). */
  readonly listSessions: () => Promise<readonly SessionRef[]>;
  /** The session with this key, or null. */
  readonly findSession: (key: string) => Promise<SessionRef | null>;
  /** Quiet period after a change, in milliseconds. */
  readonly debounceMs: number;
  /** Clock, Unix epoch milliseconds. */
  readonly now: () => number;
  /**
   * Told about a problem once per kind; the host keeps running. `message` is the command line's
   * wording; `problem` lets another host word it its own way. Never throws into here.
   */
  readonly onProblem?: (message: string, problem: HistoryRecorderProblem) => void;
  /** Told after each ingest. */
  readonly onIngested?: (result: HistoryIngestResult) => void;
  /** Runs one ingest. Default: core's worker. For tests. */
  readonly runWorker?: typeof runHistoryIngestWorker;
}

export interface HistoryRecorder {
  /** Copy every session now (in the background). */
  start(): void;
  /** A watched session changed; copy it after the quiet period. */
  sessionChanged(key: string): void;
  /** Stop: cancel what is pending, terminate a running worker and wait for it to exit. */
  stop(): Promise<void>;
  /** Resolves when nothing is running or pending. */
  idle(): Promise<void>;
}

/** Problems that mean the store cannot be used by this recorder at all. */
const FATAL_CODES = new Set(["unavailable", "unsafe-location", "not-a-store", "newer-schema"]);

export function createHistoryRecorder(options: HistoryRecorderOptions): HistoryRecorder {
  const runWorker = options.runWorker ?? runHistoryIngestWorker;
  let stopped = false;
  let disabled = false;
  let pendingAll = false;
  const pendingKeys = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  const reported = new Set<string>();
  let idleWaiters: (() => void)[] = [];

  const report = (problem: HistoryRecorderProblem, message: string): void => {
    if (reported.has(problem.kind)) return;
    reported.add(problem.kind);
    try {
      options.onProblem?.(message, problem);
    } catch {
      // A reporter must not break recording.
    }
  };

  /**
   * Whether recording may go on. When the switch was turned off, drops what is pending, stops
   * recording for this recorder and says so once.
   */
  const stillOn = (): boolean => {
    if (stopped || disabled) return false;
    let on: boolean;
    try {
      on = options.isRecordingOn();
    } catch {
      on = false;
    }
    if (on) return true;
    disabled = true;
    pendingAll = false;
    pendingKeys.clear();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    report({ kind: "off" }, "History recording was turned off; this run copies nothing more.");
    return false;
  };

  const settleIdle = (): void => {
    if (running !== null || timer !== undefined || pendingAll || pendingKeys.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const done of waiters) done();
  };

  /** The request for what is pending, or null when nothing is left to copy. */
  const takeRequest = async (): Promise<HistoryIngestRequest | null> => {
    const all = pendingAll;
    const keys = [...pendingKeys];
    pendingAll = false;
    pendingKeys.clear();
    let refs: SessionRef[];
    if (all) {
      refs = [...(await options.listSessions())];
    } else {
      refs = [];
      for (const key of keys) {
        const ref = await options.findSession(key);
        if (ref !== null) refs.push(ref);
      }
    }
    // A session read from the store itself has no files to copy.
    const files = refs.filter((ref) => !isHistoryRef(ref));
    if (files.length === 0) return null;
    const now = options.now();
    const ended = files.filter((ref) => isHistorySessionEnded(ref, now)).map((ref) => ref.key);
    return { sessions: files, ...(ended.length === 0 ? {} : { endedSessionKeys: ended }) };
  };

  const runOnce = async (): Promise<void> => {
    if (!stillOn()) return;
    let request: HistoryIngestRequest | null;
    try {
      request = await takeRequest();
    } catch {
      report(
        { kind: "list" },
        "History: the sessions to copy could not be listed; trying again later.",
      );
      return;
    }
    // Listing takes a moment: read the switch again right before the copy.
    if (request === null || !stillOn()) return;
    controller = new AbortController();
    try {
      const result = await runWorker(request, {
        workerUrl: options.workerUrl,
        dataDir: options.dataDir,
        env: options.env,
        signal: controller.signal,
      });
      options.onIngested?.(result);
    } catch (error) {
      if (stopped) return;
      const code = error instanceof HistoryStoreError ? error.code : "io";
      if (code === "locked") {
        report(
          { kind: "locked" },
          "History: another process is writing the history store, so this run copies nothing until it finishes.",
        );
      } else if (FATAL_CODES.has(code)) {
        disabled = true;
        const message = error instanceof Error ? error.message : "";
        report(
          { kind: "fatal", reason: message },
          `History is not recorded in this run: ${message}`,
        );
      } else {
        report(
          { kind: "io" },
          "History: a copy into the history store failed; trying again on the next change.",
        );
      }
    } finally {
      controller = null;
    }
  };

  const pump = (): void => {
    if (running !== null || stopped || disabled) {
      settleIdle();
      return;
    }
    if (!pendingAll && pendingKeys.size === 0) {
      settleIdle();
      return;
    }
    running = runOnce().finally(() => {
      running = null;
      pump();
    });
  };

  const schedule = (delay: number): void => {
    if (stopped || disabled) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      pump();
    }, delay);
    // A pending copy never keeps the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    start() {
      if (!stillOn()) return;
      pendingAll = true;
      pump();
    },
    sessionChanged(key) {
      if (!stillOn()) return;
      pendingKeys.add(key);
      schedule(options.debounceMs);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pendingAll = false;
      pendingKeys.clear();
      controller?.abort();
      await running;
      settleIdle();
    },
    idle() {
      return new Promise<void>((done) => {
        idleWaiters.push(done);
        settleIdle();
      });
    },
  };
}

/** What `recordingSessionReplayer` tells about a change: a recorder, or anything with its hook. */
export interface SessionChangeSink {
  sessionChanged(key: string): void;
}

/**
 * The replayer a recording host serves: the same, except that each replay sent for a session the
 * host follows (its first state and every change) tells `sink` to copy it.
 */
export function recordingSessionReplayer(
  replayer: SessionReplayer,
  sink: SessionChangeSink,
): SessionReplayer {
  return {
    list: (options) => replayer.list(options),
    find: (key) => replayer.find(key),
    load: (key) => replayer.load(key),
    follow: (key, listener) =>
      replayer.follow(key, (update) => {
        if (update.type === "replay") sink.sessionChanged(key);
        listener(update);
      }),
  };
}
