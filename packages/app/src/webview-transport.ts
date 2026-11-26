/**
 * `HostTransport` for the editor tab (#12): requests go out with the webview API's
 * `postMessage`, replies and live updates come back as window `message` events.
 *
 * - Every request gets an id, unique for this transport; a `result` or `error` with that id
 *   settles it.
 * - The id of a `subscribe` request is the subscription id. `live` messages are routed by
 *   `subscriptionId`, never by session key, so two subscriptions to one session are separate.
 * - A transport error (the webview API throws on `postMessage`, a message cannot be read, or
 *   `close` is called) rejects every pending request and ends every subscription with an
 *   `error` update, so nothing waits for a reply that will not come.
 */

import type {
  ListSessionsOptions,
  ReplayModel,
  SessionSummary,
  Unsubscribe,
} from "@orbitrace/core";
import { decodeLiveUpdate, decodeReplay, decodeSessions } from "./client-decode";
import { parseTransportMessage, transportError, type TransportRequestBody } from "./protocol";
import type {
  HostTransport,
  LiveUpdateListener,
  TransportError,
  TransportRequest,
} from "./transport";

/** The part of the editor's webview API the app uses (`acquireVsCodeApi()` in VS Code). */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

/** Where host messages arrive: `window` in the editor tab. */
export interface MessageEventSource {
  addEventListener(type: "message" | "messageerror", listener: (event: MessageEvent) => void): void;
  removeEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent) => void,
  ): void;
}

export interface WebviewTransportOptions {
  readonly api: WebviewApi;
  readonly events: MessageEventSource;
}

export interface WebviewTransport extends HostTransport {
  /** Stop listening, reject pending requests and end subscriptions. Safe to call twice. */
  close(): void;
}

export const WEBVIEW_MESSAGES = {
  sendFailed: "The message to the editor could not be sent.",
  unreadable: "A message from the editor could not be read.",
  closed: "The connection to the editor is closed.",
} as const;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: TransportError) => void;
}

export function createWebviewTransport({ api, events }: WebviewTransportOptions): WebviewTransport {
  let nextId = 1;
  let closed: TransportError | null = null;
  const pending = new Map<number, Pending>();
  const subscriptions = new Map<number, LiveUpdateListener>();

  /** Reject every pending request and end every subscription with `error`. */
  const failAll = (error: TransportError): void => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.reject(error);
    const listeners = [...subscriptions.values()];
    subscriptions.clear();
    for (const listener of listeners) listener({ type: "error", error });
  };

  const onMessage = (event: MessageEvent): void => {
    const message = parseTransportMessage(event.data);
    if (message === null) return;
    if (message.kind === "live") {
      const listener = subscriptions.get(message.subscriptionId);
      if (listener === undefined) return;
      const update = decodeLiveUpdate(message.update);
      if (update.type !== "replay") {
        subscriptions.delete(message.subscriptionId);
        // An invalid replay ends the subscription here; tell the host to stop sending.
        if (message.update.type === "replay") stopOnHost(message.subscriptionId);
      }
      listener(update);
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.kind === "result") entry.resolve(message.result);
    else entry.reject(message.error);
  };

  const onMessageError = (): void => {
    failAll(transportError("internal", WEBVIEW_MESSAGES.unreadable));
  };

  const close = (error: TransportError): void => {
    if (closed !== null) return;
    closed = error;
    events.removeEventListener("message", onMessage);
    events.removeEventListener("messageerror", onMessageError);
    failAll(error);
  };

  const allocateId = (): number => {
    const id = nextId;
    nextId += 1;
    return id;
  };

  /** Post request `id`; `entry` handles its reply. */
  const send = (id: number, body: TransportRequestBody, entry: Pending): void => {
    if (closed !== null) {
      entry.reject(closed);
      return;
    }
    pending.set(id, entry);
    try {
      api.postMessage({ ...body, id } as TransportRequest);
    } catch {
      close(transportError("internal", WEBVIEW_MESSAGES.sendFailed));
    }
  };

  const request = (body: TransportRequestBody): Promise<unknown> =>
    new Promise((resolve, reject) => {
      send(allocateId(), body, { resolve, reject });
    });

  const stopOnHost = (subscriptionId: number): void => {
    if (closed !== null) return;
    request({ method: "unsubscribe", params: { subscriptionId } }).catch(() => {});
  };

  events.addEventListener("message", onMessage);
  events.addEventListener("messageerror", onMessageError);

  return {
    kind: "editor",
    // The editor extension answers every `openInBrowser` with `unsupported` until it can start
    // the loopback server (issue 100), so the flag says no. A vscode test checks the two agree.
    canOpenInBrowser: false,
    async listSessions(options?: ListSessionsOptions): Promise<readonly SessionSummary[]> {
      const result = await request({
        method: "listSessions",
        params: options === undefined ? {} : { options },
      });
      return decodeSessions(result);
    },
    async loadReplay(key: string): Promise<ReplayModel> {
      return decodeReplay(await request({ method: "loadReplay", params: { key } }));
    },
    subscribe(key: string, listener: LiveUpdateListener): Unsubscribe {
      if (closed !== null) {
        const error = closed;
        queueMicrotask(() => listener({ type: "error", error }));
        return () => {};
      }
      // The request id is the subscription id. Registered before the request is posted, so a
      // `live` message can never arrive unrouted.
      const subscriptionId = allocateId();
      subscriptions.set(subscriptionId, listener);
      send(
        subscriptionId,
        { method: "subscribe", params: { key } },
        {
          resolve: () => {},
          reject: (error) => {
            if (subscriptions.delete(subscriptionId)) listener({ type: "error", error });
          },
        },
      );
      return () => {
        if (!subscriptions.delete(subscriptionId)) return;
        pending.delete(subscriptionId);
        stopOnHost(subscriptionId);
      };
    },
    async openInBrowser(key?: string): Promise<void> {
      await request({ method: "openInBrowser", params: key === undefined ? {} : { key } });
    },
    close() {
      close(transportError("internal", WEBVIEW_MESSAGES.closed));
    },
  };
}
