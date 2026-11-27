import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { SESSION_REPLAY_MESSAGES } from "@orbitrace/core/node";
import type { TransportMessage } from "@orbitrace/app/transport";
import {
  MAX_SAVED_REPLAY_BYTES,
  SAVE_REPLAY_METHOD,
  exportReplay,
  parseSaveReplayResult,
  type SaveReplayOutcome,
  type TransportMessage as CoreTransportMessage,
} from "@orbitrace/core";
// The conversation both ends of the editor-tab wire are checked against (#197). The app's
// transport is checked against the same one in packages/app/test/webview-wire.test.ts.
import {
  EDITOR_WIRE_CONVERSATION,
  WIRE_REPLAY,
  WIRE_SESSION,
  withWireErrorText,
} from "@orbitrace/fixtures/wire";
import { MESSAGE_HOST_ERRORS, createMessageHost } from "../src/message-host.js";
import {
  demoReplay,
  fakeReplayer,
  fixtureReplayer,
  flush,
  makeRef,
  makeSummary,
} from "./helpers.js";

function setup(options: { listError?: unknown } = {}) {
  const ref = makeRef(makeSummary(), "-workspace-kite-workshop");
  const replayer = fakeReplayer([ref], options);
  const posted: TransportMessage[] = [];
  const host = createMessageHost({ replayer, post: (message) => posted.push(message) });
  return { ref, replayer, posted, host };
}

describe("createMessageHost", () => {
  it("answers listSessions with path-free summaries", async () => {
    const { posted, host } = setup();
    await host.handle({ id: 1, method: "listSessions", params: {} });
    expect(posted).toEqual([{ kind: "result", id: 1, result: [makeSummary()] }]);
    expect(JSON.stringify(posted)).not.toContain("locator");
    expect(JSON.stringify(posted)).not.toContain(".config-root");
  });

  it("answers loadReplay with the model, and not-found with the replayer's fixed message", async () => {
    const { posted, host, ref } = setup();
    await host.handle({ id: 2, method: "loadReplay", params: { key: ref.key } });
    expect(posted[0]).toEqual({ kind: "result", id: 2, result: demoReplay() });
    await host.handle({ id: 3, method: "loadReplay", params: { key: "claude-code:missing" } });
    expect(posted[1]).toEqual({
      kind: "error",
      id: 3,
      error: { code: "not-found", message: SESSION_REPLAY_MESSAGES.notFound },
    });
  });

  it("turns an unknown failure into internal without passing its text on", async () => {
    const { posted, host } = setup({ listError: new Error("failed at /workspace/secret-place") });
    await host.handle({ id: 4, method: "listSessions", params: {} });
    expect(posted).toHaveLength(1);
    const reply = posted[0] as Extract<TransportMessage, { kind: "error" }>;
    expect(reply.error.code).toBe("internal");
    expect(reply.error.message).not.toContain("secret-place");
  });

  it("subscribes: result first, then live updates by subscription id, then forgets on ended", async () => {
    const { posted, host, replayer, ref } = setup();
    await host.handle({ id: 10, method: "subscribe", params: { key: ref.key } });
    expect(posted).toEqual([{ kind: "result", id: 10, result: null }]);
    expect(host.subscriptionCount).toBe(1);
    const follow = replayer.follows[0];
    expect(follow?.key).toBe(ref.key);

    const replay = demoReplay();
    follow?.listener({ type: "replay", replay, live: "busy" });
    follow?.listener({ type: "ended" });
    follow?.listener({ type: "replay", replay, live: "busy" });
    expect(posted.slice(1)).toEqual([
      {
        kind: "live",
        subscriptionId: 10,
        key: ref.key,
        update: { type: "replay", replay, live: "busy" },
      },
      { kind: "live", subscriptionId: 10, key: ref.key, update: { type: "ended" } },
    ]);
    expect(host.subscriptionCount).toBe(0);

    // A later unsubscribe for a forgotten subscription still gets a result.
    await host.handle({ id: 11, method: "unsubscribe", params: { subscriptionId: 10 } });
    expect(posted.at(-1)).toEqual({ kind: "result", id: 11, result: null });
  });

  it("forgets a subscription after an error update", async () => {
    const { posted, host, replayer, ref } = setup();
    await host.handle({ id: 12, method: "subscribe", params: { key: ref.key } });
    replayer.follows[0]?.listener({ type: "error", error: { code: "unreadable", message: "x" } });
    expect(host.subscriptionCount).toBe(0);
    expect(posted.at(-1)).toMatchObject({
      kind: "live",
      subscriptionId: 12,
      update: { type: "error" },
    });
  });

  it("unsubscribe stops that subscription only and no update follows it", async () => {
    const { posted, host, replayer, ref } = setup();
    await host.handle({ id: 20, method: "subscribe", params: { key: ref.key } });
    await host.handle({ id: 21, method: "subscribe", params: { key: ref.key } });
    expect(host.subscriptionCount).toBe(2);
    await host.handle({ id: 22, method: "unsubscribe", params: { subscriptionId: 20 } });
    expect(replayer.follows.map((follow) => follow.stopped)).toEqual([true, false]);
    expect(host.subscriptionCount).toBe(1);
    const before = posted.length;
    replayer.follows[0]?.listener({ type: "ended" });
    expect(posted.length).toBe(before);
    replayer.follows[1]?.listener({ type: "ended" });
    expect(posted.at(-1)).toMatchObject({ kind: "live", subscriptionId: 21 });
  });

  it("refuses a second subscription with an open id", async () => {
    const { posted, host, ref } = setup();
    await host.handle({ id: 30, method: "subscribe", params: { key: ref.key } });
    await host.handle({ id: 30, method: "subscribe", params: { key: ref.key } });
    expect(posted.at(-1)).toEqual({
      kind: "error",
      id: 30,
      error: { code: "internal", message: MESSAGE_HOST_ERRORS.duplicateSubscription },
    });
    expect(host.subscriptionCount).toBe(1);
  });

  it("answers openInBrowser with unsupported for now", async () => {
    const { posted, host } = setup();
    await host.handle({ id: 40, method: "openInBrowser", params: {} });
    expect(posted).toEqual([
      {
        kind: "error",
        id: 40,
        error: { code: "unsupported", message: MESSAGE_HOST_ERRORS.openInBrowser },
      },
    ]);
  });

  it("validates every message: unknown methods, bad parameters, and messages without an id", async () => {
    const { posted, host, replayer } = setup();
    await host.handle({ id: 50, method: "readFile", params: { path: "/etc" } });
    await host.handle({ id: 51, method: "loadReplay", params: {} });
    await host.handle({ method: "listSessions", params: {} });
    await host.handle("listSessions");
    expect(posted).toEqual([
      {
        kind: "error",
        id: 50,
        error: { code: "unsupported", message: MESSAGE_HOST_ERRORS.unknownMethod },
      },
      {
        kind: "error",
        id: 51,
        error: { code: "bad-request", message: MESSAGE_HOST_ERRORS.badParams },
      },
    ]);
    expect(replayer.listCalls).toBe(0);
  });

  it("dispose stops every subscription and ignores later messages and updates", async () => {
    const { posted, host, replayer, ref } = setup();
    await host.handle({ id: 60, method: "subscribe", params: { key: ref.key } });
    await host.handle({ id: 61, method: "subscribe", params: { key: ref.key } });
    host.dispose();
    host.dispose();
    expect(replayer.follows.every((follow) => follow.stopped)).toBe(true);
    expect(host.subscriptionCount).toBe(0);
    const before = posted.length;
    replayer.follows[0]?.listener({ type: "ended" });
    await host.handle({ id: 62, method: "listSessions", params: {} });
    expect(posted.length).toBe(before);
  });

  it("ignores a post that throws or rejects", async () => {
    const replayer = fakeReplayer([makeRef(makeSummary(), "-workspace-kite-workshop")]);
    const throwing = createMessageHost({
      replayer,
      post: () => {
        throw new Error("closed");
      },
    });
    await expect(
      throwing.handle({ id: 1, method: "listSessions", params: {} }),
    ).resolves.toBeUndefined();
    const rejecting = createMessageHost({
      replayer,
      post: () => Promise.reject(new Error("closed")),
    });
    await expect(
      rejecting.handle({ id: 1, method: "listSessions", params: {} }),
    ).resolves.toBeUndefined();
    await flush();
  });

  it("stops a follow whose update arrives during the follow call itself", async () => {
    const ref = makeRef(makeSummary(), "-workspace-kite-workshop");
    const base = fakeReplayer([ref]);
    let stopped = false;
    const posted: TransportMessage[] = [];
    const host = createMessageHost({
      replayer: {
        ...base,
        follow: (_key, listener) => {
          listener({ type: "ended" });
          return () => {
            stopped = true;
          };
        },
      },
      post: (message) => posted.push(message),
    });
    await host.handle({ id: 70, method: "subscribe", params: { key: ref.key } });
    expect(posted.map((message) => message.kind)).toEqual(["result", "live"]);
    expect(stopped).toBe(true);
    expect(host.subscriptionCount).toBe(0);
  });
});

describe("createMessageHost with core's session replayer and the synthetic fixtures", () => {
  it("lists, loads and follows a session with live updates, and stops watching on dispose", async () => {
    const { replayer, notify, watching } = fixtureReplayer();
    const posted: TransportMessage[] = [];
    const host = createMessageHost({ replayer, post: (message) => posted.push(message) });

    await host.handle({ id: 1, method: "listSessions", params: {} });
    const list = posted[0] as Extract<TransportMessage, { kind: "result" }>;
    const summaries = list.result as { key: string; projectLabel: string }[];
    expect(summaries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain("locator");
    expect(serialized).not.toContain("fixtures");
    const key = summaries[0]?.key as string;

    await host.handle({ id: 2, method: "loadReplay", params: { key } });
    expect(posted[1]).toMatchObject({ kind: "result", id: 2, result: { formatVersion: 1 } });

    await host.handle({ id: 3, method: "subscribe", params: { key } });
    await vi.waitFor(() => expect(posted).toHaveLength(4));
    expect(posted[2]).toEqual({ kind: "result", id: 3, result: null });
    expect(posted[3]).toMatchObject({
      kind: "live",
      subscriptionId: 3,
      key,
      update: { type: "replay" },
    });
    expect(watching()).toBe(1);

    notify();
    await vi.waitFor(() => expect(posted).toHaveLength(5));
    expect(posted[4]).toMatchObject({
      kind: "live",
      subscriptionId: 3,
      update: { type: "replay" },
    });

    host.dispose();
    expect(watching()).toBe(0);
  });
});

describe("the editor host and the app's webview transport (#100, #197)", () => {
  /**
   * A message host over the conversation's one session. Messages are cloned on the way in and
   * out, as the webview does. `saved` collects the texts handed to the saver; the saver answers
   * with the outcomes the conversation records, in order.
   */
  function recordedHost() {
    const replayer = fakeReplayer([makeRef(WIRE_SESSION, "-workspace-kite-workshop")], {
      replay: WIRE_REPLAY,
    });
    const outcomes = EDITOR_WIRE_CONVERSATION.flatMap(({ replies }) => {
      const first = replies[0];
      const result = parseSaveReplayResult(first?.kind === "result" ? first.result : null);
      return result === null ? [] : [result.outcome];
    });
    const posted: TransportMessage[] = [];
    const saved: string[] = [];
    const host = createMessageHost({
      replayer,
      post: (message) => posted.push(structuredClone(message)),
      saveReplay: async (data) => {
        saved.push(data);
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error("the conversation records no more saves");
        return outcome;
      },
    });
    return { host, replayer, posted, saved };
  }

  it("speaks one message type on both sides", () => {
    expectTypeOf<TransportMessage>().toEqualTypeOf<CoreTransportMessage>();
  });

  it("answers every request of the recorded conversation with the recorded messages", async () => {
    const { host, replayer, posted } = recordedHost();
    const seen: { name: string; posted: TransportMessage[] }[] = [];
    for (const { name, request, replies } of EDITOR_WIRE_CONVERSATION) {
      const before = posted.length;
      await host.handle(structuredClone(request));
      // The session changes: the replayer pushes what the conversation records for a subscribe.
      const follow = request.method === "subscribe" ? replayer.follows.at(-1) : undefined;
      for (const reply of replies) {
        if (reply.kind === "live") follow?.listener(structuredClone(reply.update));
      }
      // An error's text is each host's own wording and not part of the layout.
      seen.push({ name, posted: posted.slice(before).map(withWireErrorText) });
    }
    expect(seen).toEqual(
      EDITOR_WIRE_CONVERSATION.map(({ name, replies }) => ({ name, posted: [...replies] })),
    );
    // The host followed the session each subscribe names; one ended, the app stopped the other.
    expect(replayer.follows.map((follow) => [follow.key, follow.stopped])).toEqual([
      [WIRE_SESSION.key, false],
      [WIRE_SESSION.key, true],
    ]);
    expect(host.subscriptionCount).toBe(0);
    host.dispose();
  });

  it("hands the saver what the app exported, byte for byte, and never a refused text (#168)", async () => {
    const { host, posted, saved } = recordedHost();
    const saves = EDITOR_WIRE_CONVERSATION.filter(
      ({ request }) => request.method === SAVE_REPLAY_METHOD,
    );
    for (const { request } of saves) await host.handle(structuredClone(request));
    const accepted = saves.flatMap(({ request, replies }) =>
      replies[0]?.kind === "result" && "data" in request.params ? [request.params.data] : [],
    );
    expect(accepted).toHaveLength(2);
    expect(saved).toEqual(accepted);
    // The refusal the app shows is this host's fixed message, passed on as it is.
    expect(posted.at(-1)).toEqual({
      kind: "error",
      id: saves.at(-1)?.request.id,
      error: { code: "invalid", message: MESSAGE_HOST_ERRORS.saveInvalid },
    });
    host.dispose();
  });

  it("answers openInBrowser the way the conversation records, which sets the app's canOpenInBrowser", async () => {
    // packages/app/test/webview-wire.test.ts holds the other half: the app's transport says
    // `canOpenInBrowser` exactly when the recorded answer is not `unsupported`.
    const { host, posted } = recordedHost();
    const exchange = EDITOR_WIRE_CONVERSATION.find(
      ({ request }) => request.method === "openInBrowser",
    );
    await host.handle(structuredClone(exchange?.request));
    expect(posted).toHaveLength(1);
    expect(posted.map(withWireErrorText)).toEqual(exchange?.replies);
    expect(posted[0]).toMatchObject({
      error: { code: "unsupported", message: MESSAGE_HOST_ERRORS.openInBrowser },
    });
    host.dispose();
  });
});

describe("saving an exported replay (#168)", () => {
  const DATA = exportReplay(demoReplay()).data;

  function saving(saveReplay?: (data: string) => Promise<SaveReplayOutcome>) {
    const posted: TransportMessage[] = [];
    const host = createMessageHost({
      replayer: fakeReplayer([]),
      post: (message) => posted.push(message),
      ...(saveReplay !== undefined ? { saveReplay } : {}),
    });
    return { host, posted };
  }

  it("hands the checked text to the saver and answers with the outcome", async () => {
    const save = vi.fn(async () => "saved" as const);
    const { host, posted } = saving(save);
    await host.handle({ id: 1, method: "saveReplay", params: { data: DATA } });
    expect(save).toHaveBeenCalledWith(DATA);
    expect(posted).toEqual([{ kind: "result", id: 1, result: { outcome: "saved" } }]);
  });

  it("answers cancelled when the user closed the save dialog", async () => {
    const { host, posted } = saving(async () => "cancelled");
    await host.handle({ id: 2, method: "saveReplay", params: { data: DATA } });
    expect(posted).toEqual([{ kind: "result", id: 2, result: { outcome: "cancelled" } }]);
  });

  it("writes only allow-listed fields: anything else in the text is dropped", async () => {
    const save = vi.fn(async () => "saved" as const);
    const { host, posted } = saving(save);
    // A text that is not what the app makes: indented. It is written again in the plain form.
    const pretty = JSON.stringify(JSON.parse(DATA), null, 2);
    await host.handle({ id: 3, method: "saveReplay", params: { data: pretty } });
    expect(save).toHaveBeenCalledWith(DATA);
    expect(posted[0]).toMatchObject({ kind: "result", id: 3 });
  });

  it("refuses text that is not JSON or not a valid replay, without calling the saver", async () => {
    const save = vi.fn(async () => "saved" as const);
    const { host, posted } = saving(save);
    const withExtra = JSON.stringify({ ...JSON.parse(DATA), note: "example-extra" });
    await host.handle({ id: 4, method: "saveReplay", params: { data: "{not json" } });
    await host.handle({ id: 5, method: "saveReplay", params: { data: '{"formatVersion":99}' } });
    await host.handle({ id: 6, method: "saveReplay", params: { data: withExtra } });
    const invalid = { code: "invalid", message: MESSAGE_HOST_ERRORS.saveInvalid };
    expect(posted).toEqual([
      { kind: "error", id: 4, error: invalid },
      { kind: "error", id: 5, error: invalid },
      { kind: "error", id: 6, error: invalid },
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses text over the size limit and malformed requests as bad requests", async () => {
    const save = vi.fn(async () => "saved" as const);
    const { host, posted } = saving(save);
    const huge = "a".repeat(MAX_SAVED_REPLAY_BYTES + 1);
    await host.handle({ id: 7, method: "saveReplay", params: { data: huge } });
    await host.handle({ id: 8, method: "saveReplay", params: { path: "/not/used" } });
    // No usable id: dropped, no reply.
    await host.handle({ method: "saveReplay", params: { data: DATA } });
    expect(posted).toEqual([
      {
        kind: "error",
        id: 7,
        error: { code: "bad-request", message: MESSAGE_HOST_ERRORS.saveTooLarge },
      },
      {
        kind: "error",
        id: 8,
        error: { code: "bad-request", message: MESSAGE_HOST_ERRORS.badParams },
      },
    ]);
    expect(MESSAGE_HOST_ERRORS.saveTooLarge).toContain("50 MB");
    expect(save).not.toHaveBeenCalled();
  });

  it("answers a failed write with a fixed message that names no path", async () => {
    const { host, posted } = saving(async () => {
      throw new Error("EACCES: permission denied, open '/workspace/secret-place/x.json'");
    });
    await host.handle({ id: 9, method: "saveReplay", params: { data: DATA } });
    expect(posted).toEqual([
      {
        kind: "error",
        id: 9,
        error: { code: "internal", message: MESSAGE_HOST_ERRORS.saveFailed },
      },
    ]);
    expect(JSON.stringify(posted)).not.toContain("secret-place");
  });

  it("answers unsupported when the host was given no saver, and nothing after dispose", async () => {
    const { host, posted } = saving();
    await host.handle({ id: 10, method: "saveReplay", params: { data: DATA } });
    expect(posted).toEqual([
      {
        kind: "error",
        id: 10,
        error: { code: "unsupported", message: MESSAGE_HOST_ERRORS.saveUnsupported },
      },
    ]);
    host.dispose();
    await host.handle({ id: 11, method: "saveReplay", params: { data: DATA } });
    expect(posted).toHaveLength(1);
  });
});
