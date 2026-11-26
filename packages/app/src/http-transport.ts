/**
 * `HostTransport` for the browser tab the CLI opens (#17), over the loopback server's routes in
 * `protocol.ts`:
 *
 * - `POST /api/rpc` carries one `TransportRequest` and answers one `TransportMessage`.
 * - `POST /api/live` carries `{ id, key }` and answers newline-delimited JSON `live` messages.
 *   Each `subscribe` is its own request; aborting it is the unsubscribe.
 *
 * Every request sends `Authorization: Bearer <token>`, no cookies, and uses an origin-relative
 * URL, so the app works from whatever origin served it. The token lives in this closure only:
 * it is never put in a URL, in storage, in an error message or in a log.
 */

import type {
  ListSessionsOptions,
  ReplayModel,
  SessionSummary,
  Unsubscribe,
} from "@orbitrace/core";
import { decodeLiveUpdate, decodeReplay, decodeSessions } from "./client-decode";
import {
  LIVE_PATH,
  RPC_PATH,
  parseTransportMessage,
  transportError,
  type TransportRequestBody,
} from "./protocol";
import type { HostTransport, LiveUpdate, LiveUpdateListener, TransportError } from "./transport";

/** The `fetch` the transport uses. Default: the page's `fetch`. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  /** The loopback server's token, read from the link's fragment. */
  readonly token: string;
  readonly fetch?: FetchFunction;
}

export const HTTP_MESSAGES = {
  unreachable: "The Orbitrace server could not be reached.",
  refused: "The Orbitrace server refused this link's token.",
  badReply: "The Orbitrace server sent a reply the app could not read.",
  liveClosed: "The live connection to the Orbitrace server closed.",
} as const;

/** The error for a reply with a non-2xx status. */
export function statusError(status: number): TransportError {
  if (status === 401 || status === 403)
    return transportError("unauthorized", HTTP_MESSAGES.refused);
  return transportError("internal", `The Orbitrace server answered with status ${status}.`);
}

/**
 * The lines of a newline-delimited body, without their line breaks; blank lines are skipped.
 * Reads the body as a stream when the platform offers one.
 */
export async function* readLines(response: Response): AsyncGenerator<string, void, undefined> {
  if (response.body === null) {
    for (const line of (await response.text()).split("\n")) {
      if (line.trim() !== "") yield line;
    }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") yield line;
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim() !== "") yield buffer;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createHttpTransport({
  token,
  fetch: fetchOption,
}: HttpTransportOptions): HostTransport {
  const fetchFn: FetchFunction = fetchOption ?? ((input, init) => globalThis.fetch(input, init));
  let nextId = 1;

  const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    fetchFn(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(signal !== undefined ? { signal } : {}),
    });

  const rpc = async (body: TransportRequestBody): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    let response: Response;
    try {
      response = await post(RPC_PATH, { ...body, id });
    } catch {
      throw transportError("internal", HTTP_MESSAGES.unreachable);
    }
    if (response.status === 401 || response.status === 403) throw statusError(response.status);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw transportError("internal", HTTP_MESSAGES.unreachable);
    }
    const message = parseTransportMessage(parseJson(text));
    if (message !== null && message.kind === "error" && message.id === id) throw message.error;
    if (!response.ok) throw statusError(response.status);
    if (message !== null && message.kind === "result" && message.id === id) return message.result;
    throw transportError("internal", HTTP_MESSAGES.badReply);
  };

  return {
    kind: "browser",
    canOpenInBrowser: false,
    async listSessions(options?: ListSessionsOptions): Promise<readonly SessionSummary[]> {
      return decodeSessions(
        await rpc({ method: "listSessions", params: options === undefined ? {} : { options } }),
      );
    },
    async loadReplay(key: string): Promise<ReplayModel> {
      return decodeReplay(await rpc({ method: "loadReplay", params: { key } }));
    },
    subscribe(key: string, listener: LiveUpdateListener): Unsubscribe {
      const id = nextId;
      nextId += 1;
      const controller = new AbortController();
      let active = true;

      /** Deliver the last update and stop reading. */
      const finish = (update: LiveUpdate): void => {
        if (!active) return;
        active = false;
        controller.abort();
        listener(update);
      };
      const fail = (message: string): void =>
        finish({ type: "error", error: transportError("internal", message) });

      const run = async (): Promise<void> => {
        let response: Response;
        try {
          response = await post(LIVE_PATH, { id, key }, controller.signal);
        } catch {
          fail(HTTP_MESSAGES.unreachable);
          return;
        }
        if (!active) return;
        if (!response.ok) {
          finish({ type: "error", error: statusError(response.status) });
          return;
        }
        try {
          for await (const line of readLines(response)) {
            if (!active) return;
            const message = parseTransportMessage(parseJson(line));
            if (message === null) {
              fail(HTTP_MESSAGES.badReply);
              return;
            }
            if (message.kind === "error") {
              finish({ type: "error", error: message.error });
              return;
            }
            if (message.kind !== "live" || message.subscriptionId !== id) continue;
            const update = decodeLiveUpdate(message.update);
            if (update.type === "replay") listener(update);
            else finish(update);
          }
        } catch {
          fail(HTTP_MESSAGES.liveClosed);
          return;
        }
        // The stream ended without `ended` or `error`: the server went away.
        fail(HTTP_MESSAGES.liveClosed);
      };
      void run();

      return () => {
        if (!active) return;
        active = false;
        controller.abort();
      };
    },
    async openInBrowser(key?: string): Promise<void> {
      await rpc({ method: "openInBrowser", params: key === undefined ? {} : { key } });
    },
  };
}
