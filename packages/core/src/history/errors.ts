/**
 * Errors of the history store (ticket #25).
 *
 * The message is written by core, never copied from an underlying error: a file or SQLite error
 * can name a path, and that path must not reach a host's log or the app.
 */

/** Why a history store call failed. */
export type HistoryStoreErrorCode =
  /** `node:sqlite` cannot be loaded in this process. See `historyCapability`. */
  | "unavailable"
  /** Another live process holds the writer lock. */
  | "locked"
  /** The data folder is relative, or inside a git working tree or a Claude Code config folder. */
  | "unsafe-location"
  /** A reader was opened where no store exists yet. */
  | "not-found"
  /** The file is not an Orbitrace history store. */
  | "not-a-store"
  /** The store was written by a newer Orbitrace, with a schema this version does not know. */
  | "newer-schema"
  /** The store is older than this version and a reader cannot upgrade it; open a writer once. */
  | "needs-upgrade"
  /** A write was asked of a store opened for reading, or of a closed store. */
  | "not-writable"
  /** The caller's abort signal fired. Everything committed before it stays. */
  | "aborted"
  /** A file or database operation failed. */
  | "io";

export class HistoryStoreError extends Error {
  readonly code: HistoryStoreErrorCode;

  constructor(code: HistoryStoreErrorCode, message: string) {
    super(message);
    this.name = "HistoryStoreError";
    this.code = code;
  }
}

/** The plain `{ code, message }` of anything thrown, with a fixed message for unknown errors. */
export function toHistoryErrorInfo(error: unknown): {
  readonly code: HistoryStoreErrorCode;
  readonly message: string;
} {
  if (error instanceof HistoryStoreError) return { code: error.code, message: error.message };
  return { code: "io", message: "The history store could not complete the operation." };
}
