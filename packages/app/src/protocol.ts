/**
 * The wire layout between the app and its two hosts (lead's decision on #85). Shared by the
 * app's client transports and by the hosts, so both sides use the same names, routes and checks:
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
 * No runtime imports: this module is also built as plain JavaScript for the hosts
 * (`@orbitrace/app`, see `index.ts`).
 */

import type {
  LiveUpdate,
  TransportError,
  TransportMessage,
  TransportMethod,
  TransportRequest,
} from "./transport.js";

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

/** A `TransportRequest` without its `id`, which the sending transport assigns. */
export type TransportRequestBody = TransportRequest extends infer R
  ? R extends { readonly id: number }
    ? Omit<R, "id">
    : never
  : never;

/** Body of `POST /api/live`. `id` is the subscription id the `live` messages carry. */
export interface LiveRequest {
  readonly id: number;
  readonly key: string;
}

/** What the app reads from the page fragment of a loopback link. */
export interface HostFragment {
  readonly token: string | null;
  readonly sessionKey: string | null;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/** A `TransportError` value. Plain object, as a host sends it. */
export function transportError(code: TransportError["code"], message: string): TransportError {
  return { code, message };
}

/** True when `value` has the `{ code, message }` shape of a `TransportError`. */
export function isTransportError(value: unknown): value is TransportError {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" && typeof value.message === "string";
}

/** Check one live update's shape. The replay model itself is not validated here. */
export function isLiveUpdate(value: unknown): value is LiveUpdate {
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
 * Read a `TransportRequest` (as a host receives it). Returns `null` for anything that is not one
 * of the five request shapes, so a host can answer it with an error instead of trusting it.
 */
export function parseTransportRequest(value: unknown): TransportRequest | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  const params = value.params === undefined ? {} : value.params;
  if (!isRecord(params)) return null;
  const id = value.id;
  switch (value.method) {
    case "listSessions": {
      const options = params.options;
      if (options === undefined) return { id, method: "listSessions", params: {} };
      if (
        !isRecord(options) ||
        !isOptionalNumber(options.since) ||
        !isOptionalNumber(options.limit)
      )
        return null;
      return {
        id,
        method: "listSessions",
        params: {
          options: {
            ...(typeof options.since === "number" ? { since: options.since } : {}),
            ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
          },
        },
      };
    }
    case "loadReplay":
    case "subscribe":
      return typeof params.key === "string"
        ? { id, method: value.method, params: { key: params.key } }
        : null;
    case "unsubscribe":
      return isId(params.subscriptionId)
        ? { id, method: "unsubscribe", params: { subscriptionId: params.subscriptionId } }
        : null;
    case "openInBrowser":
      if (params.key === undefined) return { id, method: "openInBrowser", params: {} };
      return typeof params.key === "string"
        ? { id, method: "openInBrowser", params: { key: params.key } }
        : null;
    default:
      return null;
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
      return isId(value.id) ? { kind: "result", id: value.id, result: value.result } : null;
    case "error":
      return isId(value.id) && isTransportError(value.error)
        ? {
            kind: "error",
            id: value.id,
            error: { code: value.error.code, message: value.error.message },
          }
        : null;
    case "live":
      return isId(value.subscriptionId) &&
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

/** Read the body of `POST /api/live`. Returns `null` when it is not a `LiveRequest`. */
export function parseLiveRequest(value: unknown): LiveRequest | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.key !== "string") return null;
  return { id: value.id, key: value.key };
}

/** One line of a `POST /api/live` response: the message as JSON, then a newline. */
export function encodeLiveLine(message: TransportMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The fragment of a loopback link, `#t=<token>&key=<session key>`, with both values encoded.
 * The token goes in the fragment so it is never sent in a request line or a Referer.
 */
export function hostLinkFragment(token: string, sessionKey?: string): string {
  const params = new URLSearchParams();
  params.set(TOKEN_FRAGMENT_PARAM, token);
  if (sessionKey !== undefined) params.set(SESSION_FRAGMENT_PARAM, sessionKey);
  return `#${params.toString()}`;
}

/** Read the token and session key from a page fragment such as `#t=abc&key=s1`. */
export function readHostFragment(hash: string): HostFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get(TOKEN_FRAGMENT_PARAM);
  const sessionKey = params.get(SESSION_FRAGMENT_PARAM);
  return {
    token: token === null || token === "" ? null : token,
    sessionKey: sessionKey === null || sessionKey === "" ? null : sessionKey,
  };
}
