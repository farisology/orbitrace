/**
 * Background recording for `orbitrace open` (#195), when the user turned recording on.
 *
 * Since #211 the recorder lives in `@orbitrace/core/node` (`history/recorder.ts`), shared with
 * the editor extension; this module passes it on under the names the CLI uses. What it does:
 *
 * - At start, every session under the roots is copied into the history store.
 * - When a session the app shows changes, that session is copied again after a short quiet
 *   period (`debounceMs`), so a burst of appended lines is one ingest.
 * - Each ingest runs in core's worker thread (`runHistoryIngestWorker`), so the server's thread is
 *   never blocked. One worker at a time: changes that come while one runs are copied by the next.
 * - `stop` (the server stopping) cancels the timer and terminates a running worker; what it
 *   committed stays, and its lock is removed. No daemon: nothing runs after `open` ends.
 *
 * The switch is read again before each copy is scheduled and before each copy starts, so
 * `orbitrace history disable` (or the editor's Turn history recording off) stops a running `open`
 * before its next copy. Turning recording on again takes effect the next time `open` starts.
 */

export {
  createHistoryRecorder,
  type HistoryRecorder,
  type HistoryRecorderOptions,
  type HistoryRecorderProblem,
} from "@orbitrace/core/node";
