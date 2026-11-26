/**
 * Errors of the host-side session helpers (ticket #75). Browser-safe: no Node module, so the
 * app can check a code it received with `isTransportErrorCode` too.
 */

import { TRANSPORT_ERROR_CODES, type TransportErrorCode } from "../model/errors.js";

/**
 * A failure with a `TransportErrorCode`. The message is written by core, never copied from the
 * underlying error: a Node file error names the path it failed on, and that path must not reach
 * the app or a log line someone pastes into an issue.
 */
export class SessionReplayError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "SessionReplayError";
    this.code = code;
  }
}

/** The plain `{ code, message }` pair a host sends to the app (a `TransportError`). */
export interface TransportErrorInfo {
  readonly code: TransportErrorCode;
  readonly message: string;
}

const CODES: ReadonlySet<string> = new Set(TRANSPORT_ERROR_CODES);

/** True when `value` is one of the `TransportErrorCode` strings. */
export function isTransportErrorCode(value: unknown): value is TransportErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/** Message used for any failure that is not a `SessionReplayError`. */
export const INTERNAL_ERROR_MESSAGE = "Something went wrong while handling the session.";

/**
 * The `{ code, message }` to send for anything thrown. A `SessionReplayError` keeps its code and
 * message; anything else becomes `internal` with a fixed message, so the text of an unknown error
 * (which may hold a path) is never passed on. Returns a plain object, because structured clone
 * (editor messages) drops custom fields of an `Error`.
 */
export function toTransportError(error: unknown): TransportErrorInfo {
  if (error instanceof SessionReplayError && isTransportErrorCode(error.code)) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal", message: INTERNAL_ERROR_MESSAGE };
}
