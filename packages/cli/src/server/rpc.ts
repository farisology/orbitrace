/**
 * The request and reply shapes of `POST /api/rpc` and `POST /api/live`, on top of core's session
 * replayer. The shapes are core's `TransportRequest` and `TransportMessage` (lead's wire-layout
 * decision on #17, moved into core by #96).
 *
 * A request body is untrusted input from the network: it is checked field by field with core's
 * shared request check (#92), the same one the editor extension and the app use, before anything
 * is done with it, and every failure reply carries a fixed, path-free message.
 */

import {
  MAX_SESSION_KEY_LENGTH,
  parseTransportRequest,
  type TransportMessage,
  type TransportRequest,
} from "@orbitrace/core";
import {
  toTransportError,
  type SessionReplayer,
  type TransportErrorInfo,
} from "@orbitrace/core/node";

export { parseLiveRequest, type LiveRequest } from "@orbitrace/core";

/** Longest session key accepted. Core's `MAX_SESSION_KEY_LENGTH`, the limit of every host. */
export const MAX_KEY_LENGTH = MAX_SESSION_KEY_LENGTH;

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

/** A `TransportRequest` checked from a parsed JSON body, or `null` when it is not one. Core's. */
export const parseRpcRequest: (body: unknown) => TransportRequest | null = parseTransportRequest;

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
