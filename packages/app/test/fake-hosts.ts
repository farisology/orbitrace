// Fakes for the two client transports: a webview API with a message source, and a fetch that
// answers `/api/rpc` and streams newline-delimited JSON on `/api/live`. Every value is invented.

import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { parseLiveRequest, parseTransportRequest } from "../src/protocol";
import type { TransportMessage, TransportRequest } from "../src/transport";
import type { MessageEventSource, WebviewApi } from "../src/webview-transport";
import type { FetchFunction } from "../src/http-transport";

type Listener = (event: MessageEvent) => void;

export interface FakeWebview {
  readonly api: WebviewApi;
  readonly events: MessageEventSource;
  /** Requests the app posted, as parsed by the host-side check. */
  readonly posted: TransportRequest[];
  /** Deliver a message from the host, as a window `message` event. */
  reply(message: unknown): void;
  /** Fire a `messageerror` event. */
  messageError(): void;
  /** Make `postMessage` throw from now on. */
  breakChannel(): void;
  listenerCount(): number;
}

export function fakeWebview(): FakeWebview {
  const listeners = new Map<string, Set<Listener>>();
  const posted: TransportRequest[] = [];
  let broken = false;
  const fire = (type: string, event: Partial<MessageEvent>) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event as MessageEvent);
  };
  return {
    api: {
      postMessage(message) {
        if (broken) throw new Error("synthetic channel failure");
        // Structured clone, as the editor does.
        const request = parseTransportRequest(structuredClone(message));
        if (request === null) throw new Error("not a TransportRequest");
        posted.push(request);
      },
    },
    events: {
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    },
    posted,
    reply(message) {
      fire("message", { data: structuredClone(message) });
    },
    messageError() {
      fire("messageerror", {});
    },
    breakChannel() {
      broken = true;
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: unknown;
}

/** One open `/api/live` response the test writes to. */
export interface LiveStream {
  readonly call: FetchCall;
  /** Write raw text (may hold partial lines). */
  write(text: string): void;
  /** Write one message as a line. */
  send(message: TransportMessage): void;
  /** End the response body. */
  end(): void;
  readonly aborted: boolean;
}

export interface FakeFetch {
  readonly fetch: FetchFunction;
  readonly calls: FetchCall[];
  readonly streams: LiveStream[];
  /** How `/api/rpc` answers: a message (status 200) or a status with a body. */
  rpc: (request: TransportRequest) => { status: number; body: unknown } | TransportMessage;
  /** Status for `/api/live` (default 200). */
  liveStatus: number;
  /** Make every call reject, as a network failure does. */
  offline: boolean;
}

function fakeResponse(status: number, body: ReadableStream<Uint8Array> | null, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    text: async () => text,
  } as unknown as Response;
}

export function fakeFetch(): FakeFetch {
  const encoder = new TextEncoder();
  const state: FakeFetch = {
    calls: [],
    streams: [],
    rpc: (request) => ({ kind: "result", id: request.id, result: null }),
    liveStatus: 200,
    offline: false,
    fetch: async (url, init) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const call: FetchCall = { url, init, body };
      state.calls.push(call);
      if (state.offline) throw new TypeError("synthetic network failure");
      if (url === "/api/rpc") {
        const request = parseTransportRequest(body);
        if (request === null) return fakeResponse(400, null, "");
        const answer = state.rpc(request);
        if ("kind" in answer) return fakeResponse(200, null, JSON.stringify(answer));
        return fakeResponse(answer.status, null, JSON.stringify(answer.body));
      }
      if (url === "/api/live") {
        if (parseLiveRequest(body) === null) return fakeResponse(400, null, "");
        if (state.liveStatus !== 200) return fakeResponse(state.liveStatus, null, "");
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let aborted = false;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          if (closed) return;
          closed = true;
          controller.error(new Error("aborted"));
        });
        state.streams.push({
          call,
          write(text) {
            if (!closed) controller.enqueue(encoder.encode(text));
          },
          send(message) {
            if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
          },
          end() {
            if (closed) return;
            closed = true;
            controller.close();
          },
          get aborted() {
            return aborted;
          },
        });
        return fakeResponse(200, stream, "");
      }
      return fakeResponse(404, null, "");
    },
  };
  return state;
}

/** Let pending promises and stream reads settle. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
