// The shared wire layout and request checks (#92, #96). Synthetic values only.
import { URLSearchParams } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EDITOR_HOST_META_VALUE,
  HOST_META_NAME,
  LIVE_PATH,
  MAX_SESSION_KEY_LENGTH,
  RPC_METHODS,
  RPC_PATH,
  SESSION_FRAGMENT_PARAM,
  SESSION_META_NAME,
  TOKEN_FRAGMENT_PARAM,
  TRANSPORT_METHODS,
  checkTransportRequest,
  encodeFragmentValue,
  encodeLiveLine,
  hostLinkFragment,
  isLiveUpdate,
  isRequestId,
  isSessionKey,
  isTransportError,
  parseListOptions,
  parseLiveRequest,
  parseTransportMessage,
  parseTransportRequest,
  transportError,
  type LiveRequest,
  type SessionReplayUpdate,
  type TransportErrorInfo,
  type TransportMessage,
  type TransportMethod,
  type TransportRequest,
  type TransportRequestBody,
} from "../../src/index.js";

const KEY = "claude-code:0123456789abcdef0123456789abcdef";
const MODEL_STUB = { version: 1 };

describe("transport message types", () => {
  it("cover the five methods and the three message kinds", () => {
    expectTypeOf<TransportMethod>().toEqualTypeOf<
      "listSessions" | "loadReplay" | "subscribe" | "unsubscribe" | "openInBrowser"
    >();
    expectTypeOf<(typeof TRANSPORT_METHODS)[number]>().toEqualTypeOf<TransportMethod>();
    expect(TRANSPORT_METHODS).toEqual([
      "listSessions",
      "loadReplay",
      "subscribe",
      "unsubscribe",
      "openInBrowser",
    ]);
    expectTypeOf<TransportMessage["kind"]>().toEqualTypeOf<"result" | "error" | "live">();
    expectTypeOf<
      Extract<TransportMessage, { kind: "live" }>["update"]
    >().toEqualTypeOf<SessionReplayUpdate>();
    expectTypeOf<
      Extract<TransportMessage, { kind: "error" }>["error"]
    >().toEqualTypeOf<TransportErrorInfo>();
    expectTypeOf<Extract<TransportRequestBody, { method: "loadReplay" }>>().toEqualTypeOf<
      Omit<Extract<TransportRequest, { method: "loadReplay" }>, "id">
    >();
    expectTypeOf<LiveRequest>().toEqualTypeOf<{ readonly id: number; readonly key: string }>();
  });
});

describe("wire layout constants", () => {
  it("match the lead's layout on #17", () => {
    expect(HOST_META_NAME).toBe("orbitrace-host");
    expect(EDITOR_HOST_META_VALUE).toBe("editor");
    expect(SESSION_META_NAME).toBe("orbitrace-session");
    expect(TOKEN_FRAGMENT_PARAM).toBe("t");
    expect(SESSION_FRAGMENT_PARAM).toBe("key");
    expect(RPC_PATH).toBe("/api/rpc");
    expect(LIVE_PATH).toBe("/api/live");
    expect(RPC_METHODS).toEqual(["listSessions", "loadReplay", "unsubscribe", "openInBrowser"]);
    expect(MAX_SESSION_KEY_LENGTH).toBe(512);
  });
});

describe("isRequestId and isSessionKey", () => {
  it("accept safe integers from 0 only", () => {
    expect(isRequestId(0)).toBe(true);
    expect(isRequestId(42)).toBe(true);
    for (const value of [-1, 1.5, Number.NaN, 2 ** 60, "1", null]) {
      expect(isRequestId(value)).toBe(false);
    }
  });

  it("accept keys of 1 to 512 characters only", () => {
    expect(isSessionKey("k")).toBe(true);
    expect(isSessionKey(KEY)).toBe(true);
    expect(isSessionKey("k".repeat(MAX_SESSION_KEY_LENGTH))).toBe(true);
    for (const value of ["", "k".repeat(MAX_SESSION_KEY_LENGTH + 1), 7, null, undefined]) {
      expect(isSessionKey(value)).toBe(false);
    }
  });
});

describe("parseListOptions", () => {
  it("keeps since and limit when valid and drops unknown fields", () => {
    expect(parseListOptions({})).toEqual({});
    expect(parseListOptions({ since: 0, limit: 1 })).toEqual({ since: 0, limit: 1 });
    expect(parseListOptions({ since: 1000.5, limit: 50, extra: "x" })).toEqual({
      since: 1000.5,
      limit: 50,
    });
  });

  it("refuses wrong types and ranges", () => {
    for (const value of [
      null,
      [],
      3,
      { since: "1" },
      { since: -1 },
      { since: Number.POSITIVE_INFINITY },
      { limit: 0 },
      { limit: -2 },
      { limit: 1.5 },
      { limit: "3" },
    ]) {
      expect(parseListOptions(value)).toBeNull();
    }
  });
});

describe("checkTransportRequest", () => {
  it("accepts each request shape and copies only the known fields", () => {
    const cases: [unknown, TransportRequest][] = [
      [
        { id: 0, method: "listSessions", params: {} },
        { id: 0, method: "listSessions", params: {} },
      ],
      [
        { id: 2, method: "listSessions", params: { options: { limit: 3, since: 5, x: 1 } } },
        { id: 2, method: "listSessions", params: { options: { limit: 3, since: 5 } } },
      ],
      [
        { id: 3, method: "loadReplay", params: { key: KEY, path: "/x" }, extra: 1 },
        { id: 3, method: "loadReplay", params: { key: KEY } },
      ],
      [
        { id: 4, method: "subscribe", params: { key: KEY } },
        { id: 4, method: "subscribe", params: { key: KEY } },
      ],
      [
        { id: 5, method: "unsubscribe", params: { subscriptionId: 4 } },
        { id: 5, method: "unsubscribe", params: { subscriptionId: 4 } },
      ],
      [
        { id: 6, method: "openInBrowser", params: {} },
        { id: 6, method: "openInBrowser", params: {} },
      ],
      [
        { id: 7, method: "openInBrowser", params: { key: KEY } },
        { id: 7, method: "openInBrowser", params: { key: KEY } },
      ],
    ];
    for (const [input, request] of cases) {
      expect(checkTransportRequest(input)).toEqual({ ok: true, request });
      expect(parseTransportRequest(input)).toEqual(request);
    }
  });

  it("drops messages without a usable id", () => {
    for (const value of [
      null,
      "text",
      5,
      [],
      {},
      { id: "1", method: "listSessions", params: {} },
      { id: 1.5, method: "listSessions", params: {} },
      { id: -1, method: "listSessions", params: {} },
    ]) {
      expect(checkTransportRequest(value)).toEqual({ ok: false, problem: "no-id", id: null });
      expect(parseTransportRequest(value)).toBeNull();
    }
  });

  it("reports an unknown method with the id", () => {
    for (const value of [
      { id: 9, method: "readFile", params: {} },
      { id: 9, params: {} },
      { id: 9, method: "toString", params: {} },
      { id: 9, method: "readFile" },
    ]) {
      expect(checkTransportRequest(value)).toEqual({ ok: false, problem: "unknown-method", id: 9 });
      expect(parseTransportRequest(value)).toBeNull();
    }
  });

  it("reports bad parameters with the id", () => {
    for (const value of [
      { id: 1, method: "listSessions" },
      { id: 1, method: "openInBrowser" },
      { id: 1, method: "listSessions", params: null },
      { id: 1, method: "loadReplay", params: "k" },
      { id: 1, method: "listSessions", params: { options: 3 } },
      { id: 1, method: "listSessions", params: { options: [] } },
      { id: 1, method: "listSessions", params: { options: { limit: 0 } } },
      { id: 1, method: "listSessions", params: { options: { since: -5 } } },
      { id: 1, method: "loadReplay", params: {} },
      { id: 1, method: "loadReplay", params: { key: "" } },
      { id: 1, method: "loadReplay", params: { key: 7 } },
      { id: 1, method: "loadReplay", params: { key: "k".repeat(MAX_SESSION_KEY_LENGTH + 1) } },
      { id: 1, method: "subscribe", params: { key: null } },
      { id: 1, method: "unsubscribe", params: { subscriptionId: "4" } },
      { id: 1, method: "unsubscribe", params: { subscriptionId: -1 } },
      { id: 1, method: "openInBrowser", params: { key: 3 } },
    ]) {
      expect(checkTransportRequest(value)).toEqual({ ok: false, problem: "bad-params", id: 1 });
      expect(parseTransportRequest(value)).toBeNull();
    }
  });
});

describe("parseLiveRequest", () => {
  it("takes an id and a key and nothing else", () => {
    expect(parseLiveRequest({ id: 3, key: KEY, extra: true })).toEqual({ id: 3, key: KEY });
    for (const value of [
      null,
      { id: 3 },
      { key: KEY },
      { id: "3", key: KEY },
      { id: -3, key: KEY },
      { id: 3, key: "" },
      { id: 3, key: "k".repeat(MAX_SESSION_KEY_LENGTH + 1) },
    ]) {
      expect(parseLiveRequest(value)).toBeNull();
    }
  });
});

describe("transport errors and live updates", () => {
  it("builds and recognises the { code, message } shape", () => {
    expect(transportError("bad-request", "Bad.")).toEqual({ code: "bad-request", message: "Bad." });
    expect(isTransportError({ code: "internal", message: "x" })).toBe(true);
    expect(isTransportError({ code: "internal" })).toBe(false);
    expect(isTransportError(new Error("x"))).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("internal")).toBe(false);
  });

  it("checks the three update shapes", () => {
    expect(isLiveUpdate({ type: "replay", replay: MODEL_STUB, live: "idle" })).toBe(true);
    expect(isLiveUpdate({ type: "ended" })).toBe(true);
    expect(isLiveUpdate({ type: "error", error: { code: "internal", message: "x" } })).toBe(true);
    expect(isLiveUpdate({ type: "replay", replay: null, live: "idle" })).toBe(false);
    expect(isLiveUpdate({ type: "error" })).toBe(false);
    expect(isLiveUpdate({ type: "other" })).toBe(false);
    expect(isLiveUpdate(null)).toBe(false);
  });
});

describe("parseTransportMessage", () => {
  it("accepts results, errors and live updates, copying only the known fields", () => {
    expect(parseTransportMessage({ kind: "result", id: 1, result: [1] })).toEqual({
      kind: "result",
      id: 1,
      result: [1],
    });
    expect(
      parseTransportMessage({
        kind: "error",
        id: 2,
        error: { code: "invalid", message: "Bad.", stack: "dropped" },
      }),
    ).toEqual({ kind: "error", id: 2, error: { code: "invalid", message: "Bad." } });
    const live = {
      kind: "live",
      subscriptionId: 3,
      key: KEY,
      update: { type: "replay", replay: MODEL_STUB, live: "busy" },
    };
    expect(parseTransportMessage(live)).toEqual(live);
  });

  it("rejects anything else", () => {
    for (const value of [
      undefined,
      "result",
      { kind: "result" },
      { kind: "result", id: -1 },
      { kind: "error", id: 1, error: "bad" },
      { kind: "live", subscriptionId: 1, key: KEY, update: { type: "unknown" } },
      { kind: "live", subscriptionId: 1, update: { type: "ended" } },
      { kind: "push", id: 1 },
    ]) {
      expect(parseTransportMessage(value)).toBeNull();
    }
  });
});

describe("encodeLiveLine", () => {
  it("writes one message per line that reads back the same", () => {
    const message: TransportMessage = {
      kind: "live",
      subscriptionId: 1,
      key: KEY,
      update: { type: "ended" },
    };
    const line = encodeLiveLine(message);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(parseTransportMessage(JSON.parse(line))).toEqual(message);
  });
});

describe("link fragment", () => {
  it("encodeFragmentValue keeps the plain characters and encodes the rest as UTF-8", () => {
    expect(encodeFragmentValue("claude-code:abc_1.2~")).toBe("claude-code:abc_1.2~");
    expect(encodeFragmentValue("a b+c&d=e#f%")).toBe("a%20b%2Bc%26d%3De%23f%25");
    expect(encodeFragmentValue("!'()*/?")).toBe("%21%27%28%29%2A%2F%3F");
    expect(encodeFragmentValue("é")).toBe("%C3%A9");
    expect(encodeFragmentValue("\u{1F600}")).toBe("%F0%9F%98%80");
    expect(encodeFragmentValue("a\uD800b")).toBe("a%EF%BF%BDb");
    expect(new URLSearchParams(`k=${encodeFragmentValue("a+b &c")}`).get("k")).toBe("a+b &c");
  });

  it("hostLinkFragment puts the token and the optional key in the fragment", () => {
    expect(hostLinkFragment("tok")).toBe("#t=tok");
    expect(hostLinkFragment("tok", KEY)).toBe(`#t=tok&key=${KEY}`);
    const params = new URLSearchParams(hostLinkFragment("tok/en+=", "session 1&x").slice(1));
    expect(params.get("t")).toBe("tok/en+=");
    expect(params.get("key")).toBe("session 1&x");
  });
});
