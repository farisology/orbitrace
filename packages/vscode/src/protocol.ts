/**
 * Checks the shape of every message the webview sends before the host acts on it.
 *
 * The webview runs the app bundle, but a message from it is still untrusted input: the host
 * reads files for it. `parseTransportRequest` accepts exactly the `TransportRequest` shapes in
 * `@orbitrace/app/transport` and nothing else. No vscode dependency, so it is unit tested.
 */

import type { ListSessionsOptions } from "@orbitrace/core";
import type { TransportMethod, TransportRequest } from "@orbitrace/app/transport";

/** Every method of `TransportRequest`. */
export const TRANSPORT_METHODS = [
  "listSessions",
  "loadReplay",
  "subscribe",
  "unsubscribe",
  "openInBrowser",
] as const satisfies readonly TransportMethod[];

/** Why a message was refused. */
export type RequestProblem =
  /** No usable `id`: the host cannot reply, so it drops the message. */
  | "no-id"
  /** A valid `id` but a `method` this host does not know. */
  | "unknown-method"
  /** A known method with missing or wrongly typed parameters. */
  | "bad-params";

export type ParsedRequest =
  | { readonly ok: true; readonly request: TransportRequest }
  | { readonly ok: false; readonly problem: RequestProblem; readonly id: number | null };

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A request id: a safe integer. */
export function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 1024;
}

/** `ListSessionsOptions`, or null when a field is present with a wrong type or range. */
export function parseListOptions(value: unknown): ListSessionsOptions | null {
  if (!isPlainObject(value)) return null;
  const options: { since?: number; limit?: number } = {};
  if (value.since !== undefined) {
    if (typeof value.since !== "number" || !Number.isFinite(value.since) || value.since < 0) {
      return null;
    }
    options.since = value.since;
  }
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 0) {
      return null;
    }
    options.limit = value.limit;
  }
  return options;
}

/**
 * Check one incoming message. On success the returned request is a fresh object holding only
 * the known fields, so nothing extra the sender attached travels further.
 */
export function parseTransportRequest(message: unknown): ParsedRequest {
  if (!isPlainObject(message) || !isRequestId(message.id)) {
    return { ok: false, problem: "no-id", id: null };
  }
  const id = message.id;
  const method = message.method;
  if (typeof method !== "string" || !(TRANSPORT_METHODS as readonly string[]).includes(method)) {
    return { ok: false, problem: "unknown-method", id };
  }
  const bad: ParsedRequest = { ok: false, problem: "bad-params", id };
  const params = message.params;
  if (!isPlainObject(params)) return bad;

  switch (method as TransportMethod) {
    case "listSessions": {
      if (params.options === undefined)
        return { ok: true, request: { id, method: "listSessions", params: {} } };
      const options = parseListOptions(params.options);
      if (options === null) return bad;
      return { ok: true, request: { id, method: "listSessions", params: { options } } };
    }
    case "loadReplay":
    case "subscribe": {
      if (!isKey(params.key)) return bad;
      return {
        ok: true,
        request: { id, method: method as "loadReplay" | "subscribe", params: { key: params.key } },
      };
    }
    case "unsubscribe": {
      if (!isRequestId(params.subscriptionId)) return bad;
      return {
        ok: true,
        request: { id, method: "unsubscribe", params: { subscriptionId: params.subscriptionId } },
      };
    }
    case "openInBrowser": {
      if (params.key === undefined)
        return { ok: true, request: { id, method: "openInBrowser", params: {} } };
      if (!isKey(params.key)) return bad;
      return { ok: true, request: { id, method: "openInBrowser", params: { key: params.key } } };
    }
  }
}
