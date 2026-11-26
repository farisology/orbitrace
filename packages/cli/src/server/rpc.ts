/**
 * The request and reply shapes of `POST /api/rpc` and `POST /api/live`, on top of core's session
 * replayer. The shapes are the editor messages of `@orbitrace/app/transport`, unchanged (lead's
 * wire-layout decision on #17).
 *
 * A request body is untrusted input from the network: it is checked field by field before
 * anything is done with it, and every failure reply carries a fixed, path-free message.
 */

import type { ListSessionsOptions } from "@orbitrace/core";
import {
  toTransportError,
  type SessionReplayer,
  type TransportErrorInfo,
} from "@orbitrace/core/node";
import type { TransportMessage, TransportRequest } from "@orbitrace/app/transport";

/** Longest session key accepted. Real keys are far shorter. */
export const MAX_KEY_LENGTH = 512;

/** Fixed messages of the replies the server writes itself. */
export const SERVER_MESSAGES = {
  badRequest: "The request is not a valid Orbitrace request.",
  subscribeOverRpc: "Follow a session with POST /api/live, not /api/rpc.",
  openInBrowser: "Opening a session in the browser is not available from the browser view.",
  unauthorized: "The request did not carry the token from the link.",
  wrongHost: "The request was not addressed to this server.",
  crossOrigin: "The request did not come from the Orbitrace page.",
  method: "This address does not take that request method.",
  contentType: "The request body must be JSON (Content-Type: application/json).",
  tooLarge: "The request body is too large.",
  notFound: "Nothing is served at this address.",
  idInUse: "A live stream with that subscription id is already open.",
  tooManyStreams: "Too many live streams are open.",
  shuttingDown: "The server is shutting down.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH;
}

function listOptions(value: unknown): ListSessionsOptions | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const options: { since?: number; limit?: number } = {};
  if (value.since !== undefined) {
    if (typeof value.since !== "number" || !Number.isFinite(value.since)) return null;
    options.since = value.since;
  }
  if (value.limit !== undefined) {
    if (!isId(value.limit) || value.limit < 1) return null;
    options.limit = value.limit;
  }
  return options;
}

/** A `TransportRequest` checked from a parsed JSON body, or `null` when it is not one. */
export function parseRpcRequest(body: unknown): TransportRequest | null {
  if (!isRecord(body) || !isId(body.id) || !isRecord(body.params)) return null;
  const { id, params } = body;
  switch (body.method) {
    case "listSessions": {
      const options = listOptions(params.options);
      if (options === null) return null;
      return {
        id,
        method: "listSessions",
        params: params.options === undefined ? {} : { options },
      };
    }
    case "loadReplay":
      return isKey(params.key) ? { id, method: "loadReplay", params: { key: params.key } } : null;
    case "subscribe":
      return isKey(params.key) ? { id, method: "subscribe", params: { key: params.key } } : null;
    case "unsubscribe":
      return isId(params.subscriptionId)
        ? { id, method: "unsubscribe", params: { subscriptionId: params.subscriptionId } }
        : null;
    case "openInBrowser":
      if (params.key !== undefined && !isKey(params.key)) return null;
      return {
        id,
        method: "openInBrowser",
        params: params.key === undefined ? {} : { key: params.key },
      };
    default:
      return null;
  }
}

/** The body of `POST /api/live`. */
export interface LiveRequest {
  /** The subscription id: every `live` message of the stream carries it. */
  readonly id: number;
  readonly key: string;
}

/** A `LiveRequest` checked from a parsed JSON body, or `null` when it is not one. */
export function parseLiveRequest(body: unknown): LiveRequest | null {
  if (!isRecord(body) || !isId(body.id) || !isKey(body.key)) return null;
  return { id: body.id, key: body.key };
}

/** What `handleRpc` needs from the server. */
export interface RpcContext {
  readonly replayer: SessionReplayer;
  /** End the live stream with this subscription id, if one is open. */
  readonly unsubscribe: (subscriptionId: number) => void;
}

function errorMessage(id: number, error: TransportErrorInfo): TransportMessage {
  return { kind: "error", id, error };
}

/**
 * Answer one checked request with one `TransportMessage`: a `result`, or an `error` whose code
 * is a `TransportErrorCode` and whose message is core's or the server's fixed text.
 */
export async function handleRpc(
  request: TransportRequest,
  context: RpcContext,
): Promise<TransportMessage> {
  try {
    switch (request.method) {
      case "listSessions":
        return {
          kind: "result",
          id: request.id,
          result: await context.replayer.list(request.params.options),
        };
      case "loadReplay":
        return {
          kind: "result",
          id: request.id,
          result: await context.replayer.load(request.params.key),
        };
      case "unsubscribe":
        context.unsubscribe(request.params.subscriptionId);
        return { kind: "result", id: request.id, result: null };
      case "subscribe":
        return errorMessage(request.id, {
          code: "unsupported",
          message: SERVER_MESSAGES.subscribeOverRpc,
        });
      case "openInBrowser":
        return errorMessage(request.id, {
          code: "unsupported",
          message: SERVER_MESSAGES.openInBrowser,
        });
    }
  } catch (error) {
    return errorMessage(request.id, toTransportError(error));
  }
}
