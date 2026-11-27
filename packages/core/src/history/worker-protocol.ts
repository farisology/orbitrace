/**
 * The messages between `runHistoryIngestWorker` and the worker entry (ticket #25). Plain data
 * only, so they survive structured clone.
 */

import type { HistoryStoreErrorCode } from "./errors.js";
import type { HistoryIngestProgress, HistoryIngestRequest, HistoryIngestResult } from "./ingest.js";

/** Marks `workerData` meant for the history worker. */
export const HISTORY_WORKER_KIND = "orbitrace-history-ingest" as const;

/**
 * The package export of the worker entry (#188): `@orbitrace/core/history-worker`, which is
 * `dist/history/worker.js`. A host bundler takes it as a separate entry point and ships the
 * output as its own file beside the host bundle (never inlined: a worker is started from a file),
 * then passes that file's URL to `runHistoryIngestWorker` as `workerUrl`.
 */
export const HISTORY_WORKER_EXPORT = "@orbitrace/core/history-worker" as const;

/** The `workerData` the worker entry expects. */
export interface HistoryWorkerData {
  readonly kind: typeof HISTORY_WORKER_KIND;
  readonly request: HistoryIngestRequest;
  /** Data folder; default: `ORBITRACE_DATA_DIR`, else `<home>/.orbitrace`, in the worker. */
  readonly dataDir?: string;
  readonly lockWaitMs?: number;
  readonly batchLines?: number;
  /**
   * The token the worker writes into its lock file, made by the parent before it starts the
   * worker, so the parent can remove the lock however the worker ends (a worker shares the
   * parent's pid, so a lock it leaves behind looks held by a live process).
   */
  readonly lockToken: string;
  /** For tests only: block the worker for good once it holds the lock, until it is terminated. */
  readonly testBlockAfterLock?: boolean;
}

/** A message from the worker. */
export type HistoryWorkerMessage =
  | { readonly type: "progress"; readonly progress: HistoryIngestProgress }
  | { readonly type: "result"; readonly result: HistoryIngestResult }
  | {
      readonly type: "error";
      readonly error: { readonly code: HistoryStoreErrorCode; readonly message: string };
    };

export function isHistoryWorkerData(value: unknown): value is HistoryWorkerData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as { kind?: unknown; request?: unknown; lockToken?: unknown };
  return (
    data.kind === HISTORY_WORKER_KIND &&
    typeof data.request === "object" &&
    data.request !== null &&
    typeof data.lockToken === "string"
  );
}

export function isHistoryWorkerMessage(value: unknown): value is HistoryWorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "progress" || type === "result" || type === "error";
}
