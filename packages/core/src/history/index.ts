/// <reference types="node" />
/**
 * The history store and its incremental indexer (ticket #25), exported from
 * `@orbitrace/core/node`. Opt-in: importing this does nothing, and nothing is written until a
 * caller opens a store with `mode: "write"` and calls `ingestHistory`. No host calls it yet.
 *
 * - `historyCapability`: whether `node:sqlite` loads here (Node 22.13+), and why not.
 * - `openHistoryStore`, `HistoryStore`: open (reader or single writer), read back, delete one
 *   session, close. `deleteHistoryStore` removes the whole store.
 * - `ingestHistory`: the incremental, idempotent, redacting copy of sessions into a store;
 *   `runHistoryIngestWorker` runs it in a worker thread.
 * - `redactText`, `redactJsonValue`, `HISTORY_REDACTION_RULES`: the redaction applied first.
 *
 * See docs/architecture.md (History store) and docs/privacy.md (History store).
 */

export { historyCapability, type HistoryCapability } from "./engine.js";
export { HistoryStoreError, toHistoryErrorInfo, type HistoryStoreErrorCode } from "./errors.js";
export {
  HISTORY_DATA_DIR_ENV,
  HISTORY_DB_FILE,
  HISTORY_DEFAULT_FOLDER,
  HISTORY_DIR_MODE,
  HISTORY_FILE_MODE,
  HISTORY_LOCK_FILE,
  resolveHistoryLocation,
  type HistoryLocation,
  type HistoryLocationOptions,
} from "./location.js";
export {
  deleteHistoryStore,
  HISTORY_APPLICATION_ID,
  HISTORY_SCHEMA_VERSION,
  openHistoryStore,
  type HistoryDeleteOptions,
  type HistoryOpenOptions,
  type HistorySessionInput,
  type HistorySessionSummary,
  type HistorySubagentInput,
  type HistoryStore,
  type HistoryTotals,
} from "./store.js";
export {
  ingestHistory,
  prepareHistoryLine,
  type HistoryIngestOptions,
  type HistoryIngestProgress,
  type HistoryIngestRequest,
  type HistoryIngestResult,
  type PreparedHistoryLine,
} from "./ingest.js";
export {
  REDACTION_RULES as HISTORY_REDACTION_RULES,
  redactJsonValue,
  redactText,
  redactionMarker,
  type RedactedText,
  type RedactedValue,
  type RedactionRule,
} from "./redact.js";
export { runHistoryIngestWorker, type HistoryWorkerOptions } from "./run-worker.js";
export {
  HISTORY_WORKER_KIND,
  type HistoryWorkerData,
  type HistoryWorkerMessage,
} from "./worker-protocol.js";
