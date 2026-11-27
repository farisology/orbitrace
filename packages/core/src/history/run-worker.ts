/// <reference types="node" />
/**
 * Run the history ingest off the main thread (ticket #25): starts the worker entry
 * (`dist/history/worker.js`) with `worker_threads`, forwards its progress and resolves with its
 * result.
 *
 * The worker opens the store for writing itself, so the calling thread must not hold the writer
 * lock at the same time. The lock token is made here, before the worker starts, and handed to the
 * worker, so however the worker ends (finished, terminated by `signal` at any moment, or crashed)
 * the lock it may have taken is removed here on `exit`, together with the temporary files the
 * lock code names after the token. A worker shares the process id of its parent, so a lock it left
 * behind would otherwise look held by a live process and refuse every later writer.
 *
 * The caller passes the worker file's location as `workerUrl`. There is no default: a bundler moves
 * this module away from the worker file, and the CommonJS bundle of the editor extension has no
 * `import.meta.url` to find it by. See docs/architecture.md.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { linkSync, unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { HistoryStoreError } from "./errors.js";
import type { HistoryIngestProgress, HistoryIngestRequest, HistoryIngestResult } from "./ingest.js";
import { resolveHistoryLocation, type HistoryLocationOptions } from "./location.js";
import { historyLockSideFiles, newHistoryLockToken, readHistoryLockOwner } from "./lock.js";
import {
  HISTORY_WORKER_KIND,
  isHistoryWorkerMessage,
  type HistoryWorkerData,
} from "./worker-protocol.js";

export interface HistoryWorkerOptions {
  /**
   * The worker entry: the built `dist/history/worker.js` of `@orbitrace/core`, or wherever a host
   * ships it. Required (see the module comment).
   */
  readonly workerUrl: URL | string;
  /** Data folder. Default: `ORBITRACE_DATA_DIR`, else `<home>/.orbitrace`. */
  readonly dataDir?: string;
  /** Environment for the worker and for finding the data folder. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long the worker waits for another writer, in milliseconds. Default 0. */
  readonly lockWaitMs?: number;
  /** Lines per transaction. Default 1000. */
  readonly batchLines?: number;
  readonly onProgress?: (progress: HistoryIngestProgress) => void;
  /** Terminates the worker. Committed lines stay; the promise rejects with `aborted`. */
  readonly signal?: AbortSignal;
  /** For tests only: the worker blocks once it holds the lock, until it is terminated. */
  readonly testHooks?: { readonly blockAfterLock?: boolean };
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * After the worker has exited: remove the lock it took with `token`, if it is still there, and
 * the side files the lock code names after `token`. A lock another owner holds is never touched.
 */
function releaseWorkerLock(
  token: string,
  options: HistoryLocationOptions & { readonly env?: HistoryWorkerOptions["env"] },
): void {
  let lockFile: string;
  try {
    lockFile = resolveHistoryLocation(options).lockFile;
  } catch {
    return;
  }
  const { temp, aside } = historyLockSideFiles(lockFile, token);
  unlinkQuietly(temp);
  // A worker stopped while taking over a stale lock may have left it renamed aside: put it back
  // when the name is free (the next writer judges it again), then drop the aside name.
  try {
    linkSync(aside, lockFile);
  } catch {
    // No aside file, or the name is taken.
  }
  unlinkQuietly(aside);
  const owner = readHistoryLockOwner(lockFile);
  if (owner === null || owner.token !== token || owner.pid !== process.pid) return;
  unlinkQuietly(lockFile);
}

/**
 * Run `ingestHistory` for `request` in a worker thread. Resolves with the worker's result; rejects
 * with a `HistoryStoreError` (`unavailable`, `locked`, `unsafe-location`, `aborted`, `io`, ...).
 */
export function runHistoryIngestWorker(
  request: HistoryIngestRequest,
  options: HistoryWorkerOptions,
): Promise<HistoryIngestResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new HistoryStoreError("aborted", "The history ingest was stopped."));
      return;
    }
    const token = newHistoryLockToken();
    const data: HistoryWorkerData = {
      kind: HISTORY_WORKER_KIND,
      request,
      lockToken: token,
      ...(options.testHooks?.blockAfterLock === true ? { testBlockAfterLock: true } : {}),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
      ...(options.batchLines === undefined ? {} : { batchLines: options.batchLines }),
    };
    const locationOptions = {
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl, {
        workerData: data,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
      });
    } catch {
      reject(new HistoryStoreError("io", "The history worker could not be started."));
      return;
    }
    let outcome: { ok: true; result: HistoryIngestResult } | { ok: false; error: Error } | null =
      null;
    const onAbort = (): void => {
      outcome ??= {
        ok: false,
        error: new HistoryStoreError("aborted", "The history ingest was stopped."),
      };
      void worker.terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: unknown) => {
      if (!isHistoryWorkerMessage(message)) return;
      if (message.type === "progress") {
        try {
          options.onProgress?.(message.progress);
        } catch (error) {
          void Promise.reject(error);
        }
      } else if (message.type === "result") outcome ??= { ok: true, result: message.result };
      else
        outcome ??= {
          ok: false,
          error: new HistoryStoreError(message.error.code, message.error.message),
        };
    });
    worker.on("error", () => {
      outcome ??= {
        ok: false,
        error: new HistoryStoreError("io", "The history worker stopped with an error."),
      };
    });
    worker.on("exit", () => {
      options.signal?.removeEventListener("abort", onAbort);
      releaseWorkerLock(token, locationOptions);
      const final = outcome ?? {
        ok: false as const,
        error: new HistoryStoreError("io", "The history worker exited without a result."),
      };
      if (final.ok) resolve(final.result);
      else reject(final.error);
    });
  });
}
