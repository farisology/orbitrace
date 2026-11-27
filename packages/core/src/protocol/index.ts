/**
 * The wire layout between the app and its two hosts, and the one set of checks every side runs
 * on what it receives (#92, #96). Browser-safe and free of runtime imports from outside core, so
 * the app, the CLI's loopback server and the editor extension all use this copy.
 *
 * - Editor tab (#12): the app posts `TransportRequest` objects with the webview API's
 *   `postMessage` and receives `TransportMessage` objects as window `message` events. The host
 *   marks the page with `<meta name="orbitrace-host" content="editor">` and, when a session is
 *   preselected, `<meta name="orbitrace-session" content="<session key>">`. No inline script.
 * - Browser tab (#17): the link is `http://127.0.0.1:<port>/#t=<token>&key=<session key>`. The
 *   app reads the fragment and removes it from the address bar. Every API request carries
 *   `Authorization: Bearer <token>`. `POST /api/rpc` takes one `TransportRequest` and answers
 *   one `TransportMessage`; `POST /api/live` takes a `LiveRequest` and answers newline-delimited
 *   JSON `live` messages until `ended`, `error` or the client aborts (abort is the unsubscribe).
 *
 * Request limits, the same for every host (strictest of the three copies this replaced):
 * - `id` and `subscriptionId`: a safe integer, 0 or more.
 * - `params`: required, a plain object.
 * - a session key: a string of 1 to `MAX_SESSION_KEY_LENGTH` characters.
 * - `listSessions` options, when present: an object; `since` a finite number, 0 or more;
 *   `limit` a safe integer, 1 or more.
 * Fields beyond these are dropped, so nothing extra a sender attached travels further.
 *
 * Saving an exported replay from the editor tab (#168) is one more request, `saveReplay`, kept
 * outside `TransportRequest` with its own check: see `./save-replay.ts`.
 */

import type { TransportErrorCode } from "../model/errors.js";
import type { ListSessionsOptions } from "../model/sources.js";
import {
  TRANSPORT_METHODS,
  type LiveRequest,
  type TransportMessage,
  type TransportMethod,
  type TransportRequest,
} from "../model/transport.js";
import type { TransportErrorInfo } from "../host/errors.js";
import type { SessionReplayUpdate } from "../host/session-replayer.js";

/** Name of the meta tag that tells the app which host serves it. */
export const HOST_META_NAME = "orbitrace-host";
/** Value of the `orbitrace-host` meta tag in the editor tab. */
export const EDITOR_HOST_META_VALUE = "editor";
/** Name of the meta tag that carries a preselected session key. */
export const SESSION_META_NAME = "orbitrace-session";

/** Fragment parameter holding the loopback server's token. */
export const TOKEN_FRAGMENT_PARAM = "t";
/** Fragment parameter holding a preselected session key. */
export const SESSION_FRAGMENT_PARAM = "key";

/** Loopback route for one request and one reply. Origin-relative. */
export const RPC_PATH = "/api/rpc";
/** Loopback route for one live subscription, answered as newline-delimited JSON. */
export const LIVE_PATH = "/api/live";

/** Methods `POST /api/rpc` takes. A subscription goes to `POST /api/live` instead. */
export const RPC_METHODS = [
  "listSessions",
  "loadReplay",
  "unsubscribe",
  "openInBrowser",
] as const satisfies readonly TransportMethod[];

/** Longest session key a host accepts. Real keys are far shorter (the runtime id and a hash). */
export const MAX_SESSION_KEY_LENGTH = 512;

/** Why a request was refused. */
export type RequestProblem =
  /** No usable `id`: the host cannot reply, so it drops the message. */
  | "no-id"
  /** A valid `id` but a `method` that is not a `TransportMethod`. */
  | "unknown-method"
  /** A known method with missing, wrongly typed or out-of-range parameters. */
  | "bad-params";

/** What `checkTransportRequest` found. */
export type TransportRequestCheck =
  | { readonly ok: true; readonly request: TransportRequest }
  | { readonly ok: false; readonly problem: RequestProblem; readonly id: number | null };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const METHODS: ReadonlySet<string> = new Set(TRANSPORT_METHODS);

function isMethod(value: unknown): value is TransportMethod {
  return typeof value === "string" && METHODS.has(value);
}

/** A request or subscription id: a safe integer, 0 or more. */
export function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A session key a host accepts: a string of 1 to `MAX_SESSION_KEY_LENGTH` characters. */
export function isSessionKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_KEY_LENGTH;
}

/**
 * `ListSessionsOptions` copied field by field, or `null` when it is not an object or a field is
 * present with a wrong type or range (`since` a finite number, 0 or more; `limit` a safe integer,
 * 1 or more).
 */
export function parseListOptions(value: unknown): ListSessionsOptions | null {
  if (!isRecord(value)) return null;
  const options: { since?: number; limit?: number } = {};
  if (value.since !== undefined) {
    if (typeof value.since !== "number" || !Number.isFinite(value.since) || value.since < 0) {
      return null;
    }
    options.since = value.since;
  }
  if (value.limit !== undefined) {
    if (!isRequestId(value.limit) || value.limit < 1) return null;
    options.limit = value.limit;
  }
  return options;
}

/**
 * Check one incoming request, as a host receives it. On success the request is a fresh object
 * holding only the known fields. On failure it says why, with the `id` when there is a usable one,
 * so a host can answer with an error (`unsupported` for an unknown method, `bad-request` for bad
 * parameters) or drop a message it cannot reply to.
 */
export function checkTransportRequest(value: unknown): TransportRequestCheck {
  if (!isRecord(value) || !isRequestId(value.id)) return { ok: false, problem: "no-id", id: null };
  const id = value.id;
  const method = value.method;
  if (!isMethod(method)) return { ok: false, problem: "unknown-method", id };
  const bad: TransportRequestCheck = { ok: false, problem: "bad-params", id };
  const params = value.params;
  if (!isRecord(params)) return bad;

  switch (method) {
    case "listSessions": {
      if (params.options === undefined) {
        return { ok: true, request: { id, method, params: {} } };
      }
      const options = parseListOptions(params.options);
      return options === null ? bad : { ok: true, request: { id, method, params: { options } } };
    }
    case "loadReplay":
    case "subscribe":
      return isSessionKey(params.key)
        ? { ok: true, request: { id, method, params: { key: params.key } } }
        : bad;
    case "unsubscribe":
      return isRequestId(params.subscriptionId)
        ? { ok: true, request: { id, method, params: { subscriptionId: params.subscriptionId } } }
        : bad;
    case "openInBrowser":
      if (params.key === undefined) return { ok: true, request: { id, method, params: {} } };
      return isSessionKey(params.key)
        ? { ok: true, request: { id, method, params: { key: params.key } } }
        : bad;
  }
}

/** `checkTransportRequest` without the reason: the request, or `null` when it is not one. */
export function parseTransportRequest(value: unknown): TransportRequest | null {
  const checked = checkTransportRequest(value);
  return checked.ok ? checked.request : null;
}

/** Read the body of `POST /api/live`. Returns `null` when it is not a `LiveRequest`. */
export function parseLiveRequest(value: unknown): LiveRequest | null {
  if (!isRecord(value) || !isRequestId(value.id) || !isSessionKey(value.key)) return null;
  return { id: value.id, key: value.key };
}

/** A `{ code, message }` error value. Plain object, as a host sends it. */
export function transportError(code: TransportErrorCode, message: string): TransportErrorInfo {
  return { code, message };
}

/** True when `value` has the `{ code, message }` shape of a transport error. */
export function isTransportError(value: unknown): value is TransportErrorInfo {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" && typeof value.message === "string";
}

/** Check one live update's shape. The replay model itself is not validated here. */
export function isLiveUpdate(value: unknown): value is SessionReplayUpdate {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "replay":
      return isRecord(value.replay) && typeof value.live === "string";
    case "ended":
      return true;
    case "error":
      return isTransportError(value.error);
    default:
      return false;
  }
}

/**
 * Read a `TransportMessage` (as the app receives it). Returns `null` for anything else, so a
 * stray message is ignored rather than routed. A `live` update's replay model is not validated
 * here; the app does that before showing it.
 */
export function parseTransportMessage(value: unknown): TransportMessage | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "result":
      return isRequestId(value.id) ? { kind: "result", id: value.id, result: value.result } : null;
    case "error":
      return isRequestId(value.id) && isTransportError(value.error)
        ? {
            kind: "error",
            id: value.id,
            error: { code: value.error.code, message: value.error.message },
          }
        : null;
    case "live":
      return isRequestId(value.subscriptionId) &&
        typeof value.key === "string" &&
        isLiveUpdate(value.update)
        ? {
            kind: "live",
            subscriptionId: value.subscriptionId,
            key: value.key,
            update: value.update,
          }
        : null;
    default:
      return null;
  }
}

/** One line of a `POST /api/live` response: the message as JSON, then a newline. */
export function encodeLiveLine(message: TransportMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Characters written as they are in a fragment value. */
const PLAIN = /^[A-Za-z0-9\-._~:]$/;

function percentByte(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * A fragment value, percent-encoded as UTF-8 outside `A-Z a-z 0-9 - . _ ~ :`. A plus sign is
 * encoded too, because `URLSearchParams` reads a bare `+` as a space. A lone surrogate, which has
 * no UTF-8 form, is written as U+FFFD, as a UTF-8 encoder does.
 */
export function encodeFragmentValue(value: string): string {
  let out = "";
  for (const char of value) {
    if (PLAIN.test(char)) {
      out += char;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    const whole = code >= 0xd800 && code <= 0xdfff ? "�" : char;
    // encodeURIComponent leaves ! ' ( ) * as they are; encode those as well.
    out += encodeURIComponent(whole).replace(/[!'()*]/g, percentByte);
  }
  return out;
}

/**
 * The fragment of a loopback link, `#t=<token>&key=<session key>`, with both values encoded by
 * `encodeFragmentValue`. The token goes in the fragment so it is never sent in a request line or
 * a Referer.
 */
export function hostLinkFragment(token: string, sessionKey?: string): string {
  const parts = [`${TOKEN_FRAGMENT_PARAM}=${encodeFragmentValue(token)}`];
  if (sessionKey !== undefined) {
    parts.push(`${SESSION_FRAGMENT_PARAM}=${encodeFragmentValue(sessionKey)}`);
  }
  return `#${parts.join("&")}`;
}

/** Saving an exported replay from the editor tab (#168). */
export * from "./save-replay.js";
