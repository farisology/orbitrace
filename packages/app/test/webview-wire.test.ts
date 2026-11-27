// The app's webview transport against the conversation both ends of the editor-tab wire are
// checked against (#197). The editor's message host is checked against the same conversation in
// packages/vscode/test/message-host.test.ts, so the two agree without either test importing the
// other package's source. Every value is invented.

import { describe, expect, it } from "vitest";
import { SAVE_REPLAY_METHOD, type Unsubscribe } from "@orbitrace/core";
import { EDITOR_WIRE_CONVERSATION, type WireExchange } from "@orbitrace/fixtures/wire";
import type { LiveUpdate } from "../src/transport";
import { createWebviewTransport, type WebviewTransport } from "../src/webview-transport";

type Listener = (event: MessageEvent) => void;

/** The transport on a webview that keeps every message it posts, cloned as the editor does. */
function connect() {
  const listeners = new Set<Listener>();
  const posted: unknown[] = [];
  const transport = createWebviewTransport({
    api: { postMessage: (message) => posted.push(structuredClone(message)) },
    events: {
      addEventListener: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    },
  });
  /** Deliver one host message as a window `message` event. */
  const deliver = (message: unknown): void => {
    const event = { data: structuredClone(message) } as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  };
  return { transport, posted, deliver };
}

/** What one call on the transport came to. */
type Outcome =
  | { readonly kind: "resolved"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly error: unknown };

const settled = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (value): Outcome => ({ kind: "resolved", value }),
    (error: unknown): Outcome => ({ kind: "rejected", error }),
  );

/** Subscriptions the app holds, by subscription id: the updates seen and how to stop. */
type Subscriptions = Map<number, { readonly updates: LiveUpdate[]; readonly stop: Unsubscribe }>;

/**
 * Make the call the app makes for `request`, the way the app makes it. Returns the call's
 * promise, or `null` for a call that returns none (`subscribe` and stopping a subscription).
 */
function call(
  transport: WebviewTransport,
  request: WireExchange["request"],
  subscriptions: Subscriptions,
): Promise<unknown> | null {
  switch (request.method) {
    case "listSessions":
      return request.params.options === undefined
        ? transport.listSessions()
        : transport.listSessions(request.params.options);
    case "loadReplay":
      return transport.loadReplay(request.params.key);
    case "subscribe": {
      const updates: LiveUpdate[] = [];
      const stop = transport.subscribe(request.params.key, (update) => updates.push(update));
      subscriptions.set(request.id, { updates, stop });
      return null;
    }
    case "unsubscribe": {
      const subscription = subscriptions.get(request.params.subscriptionId);
      if (subscription === undefined) throw new Error("no such subscription in this test");
      subscription.stop();
      return null;
    }
    case "openInBrowser":
      return request.params.key === undefined
        ? transport.openInBrowser()
        : transport.openInBrowser(request.params.key);
    case SAVE_REPLAY_METHOD:
      return transport.saveReplay(request.params.data);
  }
}

/**
 * How the app's call ends when the host posts `replies`, read off the first reply: `null` for a
 * call that returns no promise.
 */
function expectedOutcome({ request, replies }: WireExchange): Outcome | null {
  if (request.method === "subscribe" || request.method === "unsubscribe") return null;
  const first = replies[0];
  if (first === undefined || first.kind === "live") throw new Error("no reply to the request");
  if (first.kind === "error") return { kind: "rejected", error: first.error };
  if (request.method === SAVE_REPLAY_METHOD) {
    return { kind: "resolved", value: (first.result as { outcome: string }).outcome };
  }
  // `openInBrowser` resolves with nothing; a list or a replay resolves with the result itself.
  return {
    kind: "resolved",
    value: request.method === "openInBrowser" ? undefined : first.result,
  };
}

// What this file and its counterpart prove together:
// - every request the app posts is one the host answers, with the ids, names and nesting the host
//   reads (the first test here; "answers every request" there);
// - a host error reaches the app's caller with its code and text unchanged, the refusal of a bad
//   replay included (#168): the app rejects with the recorded error, the host posts it;
// - the text the app hands to `saveReplay` is the text the host's saver receives (#168): the app
//   posts the recorded text unchanged, the host passes the recorded text on byte for byte;
// - `canOpenInBrowser` is true exactly when the host does not answer `unsupported` (#100).
describe("the app's webview transport and the editor host (#100, #197)", () => {
  it("posts every request of the recorded conversation and reads every recorded answer", async () => {
    const { transport, posted, deliver } = connect();
    const subscriptions: Subscriptions = new Map();
    const seen: { name: string; posted: unknown[]; outcome: Outcome | null }[] = [];
    for (const { name, request, replies } of EDITOR_WIRE_CONVERSATION) {
      const before = posted.length;
      const pending = call(transport, request, subscriptions);
      const sent = posted.slice(before);
      for (const reply of replies) deliver(reply);
      seen.push({ name, posted: sent, outcome: pending === null ? null : await settled(pending) });
    }
    // One message per call, and exactly the recorded one: ids, names and nesting. Each call ends
    // the way the recorded answer says.
    expect(seen).toEqual(
      EDITOR_WIRE_CONVERSATION.map((exchange) => ({
        name: exchange.name,
        posted: [exchange.request],
        outcome: expectedOutcome(exchange),
      })),
    );
    // Each subscription's listener got its own live updates, in order, and nothing else.
    expect([...subscriptions].map(([id, { updates }]) => ({ id, updates }))).toEqual(
      EDITOR_WIRE_CONVERSATION.filter(({ request }) => request.method === "subscribe").map(
        ({ request, replies }) => ({
          id: request.id,
          updates: replies.flatMap((reply) => (reply.kind === "live" ? [reply.update] : [])),
        }),
      ),
    );
    // Nothing was posted beyond the conversation: no unsubscribe for the session that ended.
    expect(posted).toEqual(EDITOR_WIRE_CONVERSATION.map(({ request }) => request));
    transport.close();
  });

  it("says canOpenInBrowser exactly when the editor host does not answer unsupported", () => {
    const { transport } = connect();
    const exchange = EDITOR_WIRE_CONVERSATION.find(
      ({ request }) => request.method === "openInBrowser",
    );
    const reply = exchange?.replies[0];
    expect(reply).toBeDefined();
    const unsupported = reply?.kind === "error" && reply.error.code === "unsupported";
    expect(transport.canOpenInBrowser).toBe(!unsupported);
    transport.close();
  });
});
