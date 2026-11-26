/**
 * Error codes a host reports when a request about a session fails (ticket #75).
 *
 * One definition for every host: the editor host (#12), the CLI and its loopback server
 * (#16, #17) and the shared session-to-replay helper in `@orbitrace/core/node`.
 * `@orbitrace/app/transport` re-exports `TransportErrorCode` from here, so the app and the hosts
 * cannot drift apart. Core cannot import from the app, which is why the union lives in core.
 *
 * Every message sent with a code is for display and holds no file path, locator, session id or
 * transcript content.
 */

/** Why a request failed. */
export type TransportErrorCode =
  /** No session with that key. */
  | "not-found"
  /** The transcript could not be read. */
  | "unreadable"
  /** The result did not validate against the replay schema. */
  | "invalid"
  /** The host does not support this request (for example `openInBrowser` in a browser). */
  | "unsupported"
  /** The browser host rejected the token or the Host header. */
  | "unauthorized"
  /** Anything else. */
  | "internal";

/** Every `TransportErrorCode`, in the order of the union above. */
export const TRANSPORT_ERROR_CODES = [
  "not-found",
  "unreadable",
  "invalid",
  "unsupported",
  "unauthorized",
  "internal",
] as const satisfies readonly TransportErrorCode[];
