/// <reference types="node" />
/**
 * The `worker_threads` entry of the history ingest (ticket #25). Built to
 * `dist/history/worker.js`, exported as `@orbitrace/core/history-worker` (#188) so a host can
 * bundle it as its own file; `runHistoryIngestWorker` starts it.
 *
 * Runs only inside a worker started with a `HistoryWorkerData` as its `workerData`; imported
 * anywhere else it does nothing. It opens the store for writing with the lock token the parent
 * made (`HistoryWorkerData.lockToken`), runs `ingestHistory`, closes the store and posts
 * `progress` after each session, then exactly one `result` or `error`. Errors carry a code and a
 * fixed message, never a path.
 *
 * Node only.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { toHistoryErrorInfo } from "./errors.js";
import { ingestHistory } from "./ingest.js";
import { withoutSqliteWarning } from "./quiet.js";
import { isHistoryWorkerData, type HistoryWorkerMessage } from "./worker-protocol.js";
import { openHistoryWriterWithLockToken, type HistoryStore } from "./store.js";

async function run(): Promise<void> {
  const port = parentPort;
  const data: unknown = workerData;
  if (isMainThread || port === null || !isHistoryWorkerData(data)) return;
  const post = (message: HistoryWorkerMessage): void => port.postMessage(message);
  let store: HistoryStore | null = null;
  try {
    // The first load of node:sqlite in this thread happens here; on Node 22 and 23 it would print
    // the SQLite experimental warning to the host's stderr.
    store = await withoutSqliteWarning(() =>
      openHistoryWriterWithLockToken(
        {
          ...(data.dataDir === undefined ? {} : { dataDir: data.dataDir }),
          ...(data.lockWaitMs === undefined ? {} : { lockWaitMs: data.lockWaitMs }),
        },
        data.lockToken,
      ),
    );
    if (data.testBlockAfterLock === true) {
      // Terminating the worker interrupts the wait.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    const result = await ingestHistory(store, data.request, {
      ...(data.batchLines === undefined ? {} : { batchLines: data.batchLines }),
      onProgress: (progress) => post({ type: "progress", progress }),
    });
    store.close();
    store = null;
    post({ type: "result", result });
  } catch (error) {
    try {
      store?.close();
    } catch {
      // Reported below.
    }
    post({ type: "error", error: toHistoryErrorInfo(error) });
  }
}

void run();
