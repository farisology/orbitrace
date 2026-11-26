import { describe, expect, it } from "vitest";
import {
  EDITOR_HOST_META_VALUE,
  HOST_META_NAME,
  LIVE_PATH,
  RPC_METHODS,
  RPC_PATH,
  SESSION_FRAGMENT_PARAM,
  SESSION_META_NAME,
  TOKEN_FRAGMENT_PARAM,
  encodeLiveLine,
  hostLinkFragment,
  isLiveUpdate,
  isTransportError,
  parseLiveRequest,
  parseTransportMessage,
  parseTransportRequest,
  readHostFragment,
  transportError,
} from "../src/protocol";
import { makeModel } from "./helpers";

describe("wire layout constants", () => {
  it("match the lead's layout on #85", () => {
    expect(HOST_META_NAME).toBe("orbitrace-host");
    expect(EDITOR_HOST_META_VALUE).toBe("editor");
    expect(SESSION_META_NAME).toBe("orbitrace-session");
    expect(TOKEN_FRAGMENT_PARAM).toBe("t");
    expect(SESSION_FRAGMENT_PARAM).toBe("key");
    expect(RPC_PATH).toBe("/api/rpc");
    expect(LIVE_PATH).toBe("/api/live");
    expect(RPC_METHODS).toEqual(["listSessions", "loadReplay", "unsubscribe", "openInBrowser"]);
  });
});

describe("transport errors", () => {
  it("builds and recognises the { code, message } shape", () => {
    expect(transportError("not-found", "Gone.")).toEqual({ code: "not-found", message: "Gone." });
    expect(isTransportError({ code: "internal", message: "x" })).toBe(true);
    expect(isTransportError({ code: "internal" })).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("internal")).toBe(false);
  });
});

describe("parseTransportRequest", () => {
  it("accepts the five request shapes", () => {
    expect(parseTransportRequest({ id: 1, method: "listSessions", params: {} })).toEqual({
      id: 1,
      method: "listSessions",
      params: {},
    });
    expect(
      parseTransportRequest({ id: 2, method: "listSessions", params: { options: { limit: 3 } } }),
    ).toEqual({ id: 2, method: "listSessions", params: { options: { limit: 3 } } });
    expect(parseTransportRequest({ id: 3, method: "loadReplay", params: { key: "k" } })).toEqual({
      id: 3,
      method: "loadReplay",
      params: { key: "k" },
    });
    expect(parseTransportRequest({ id: 4, method: "subscribe", params: { key: "k" } })).toEqual({
      id: 4,
      method: "subscribe",
      params: { key: "k" },
    });
    expect(
      parseTransportRequest({ id: 5, method: "unsubscribe", params: { subscriptionId: 4 } }),
    ).toEqual({ id: 5, method: "unsubscribe", params: { subscriptionId: 4 } });
    expect(parseTransportRequest({ id: 6, method: "openInBrowser" })).toEqual({
      id: 6,
      method: "openInBrowser",
      params: {},
    });
    expect(parseTransportRequest({ id: 7, method: "openInBrowser", params: { key: "k" } })).toEqual(
      { id: 7, method: "openInBrowser", params: { key: "k" } },
    );
  });

  it("drops fields it does not know", () => {
    expect(
      parseTransportRequest({
        id: 1,
        method: "listSessions",
        params: { options: { limit: 2, extra: "x" } },
        extra: true,
      }),
    ).toEqual({ id: 1, method: "listSessions", params: { options: { limit: 2 } } });
  });

  it("rejects anything else", () => {
    for (const value of [
      null,
      [],
      { method: "loadReplay", params: { key: "k" } },
      { id: -1, method: "loadReplay", params: { key: "k" } },
      { id: 1.5, method: "loadReplay", params: { key: "k" } },
      { id: 1, method: "deleteEverything", params: {} },
      { id: 1, method: "loadReplay", params: {} },
      { id: 1, method: "loadReplay", params: "k" },
      { id: 1, method: "unsubscribe", params: { subscriptionId: "1" } },
      { id: 1, method: "openInBrowser", params: { key: 3 } },
      { id: 1, method: "listSessions", params: { options: { limit: "3" } } },
      { id: 1, method: "listSessions", params: { options: 3 } },
    ]) {
      expect(parseTransportRequest(value)).toBeNull();
    }
  });
});

describe("parseTransportMessage", () => {
  it("accepts results, errors and live updates", () => {
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
      key: "k",
      update: { type: "replay", replay: makeModel(), live: "busy" },
    };
    expect(parseTransportMessage(live)).toEqual(live);
  });

  it("rejects anything else", () => {
    for (const value of [
      undefined,
      "result",
      { kind: "result" },
      { kind: "error", id: 1, error: "bad" },
      { kind: "live", subscriptionId: 1, key: "k", update: { type: "unknown" } },
      { kind: "live", subscriptionId: 1, update: { type: "ended" } },
      { kind: "push", id: 1 },
    ]) {
      expect(parseTransportMessage(value)).toBeNull();
    }
  });
});

describe("isLiveUpdate", () => {
  it("checks the three update shapes", () => {
    expect(isLiveUpdate({ type: "replay", replay: makeModel(), live: "idle" })).toBe(true);
    expect(isLiveUpdate({ type: "ended" })).toBe(true);
    expect(isLiveUpdate({ type: "error", error: { code: "internal", message: "x" } })).toBe(true);
    expect(isLiveUpdate({ type: "replay", replay: null, live: "idle" })).toBe(false);
    expect(isLiveUpdate({ type: "error" })).toBe(false);
    expect(isLiveUpdate(null)).toBe(false);
  });
});

describe("live requests and lines", () => {
  it("parses the /api/live body", () => {
    expect(parseLiveRequest({ id: 4, key: "k" })).toEqual({ id: 4, key: "k" });
    expect(parseLiveRequest({ id: "4", key: "k" })).toBeNull();
    expect(parseLiveRequest({ id: 4 })).toBeNull();
  });

  it("encodes one message per line", () => {
    const line = encodeLiveLine({
      kind: "live",
      subscriptionId: 1,
      key: "k",
      update: { type: "ended" },
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(parseTransportMessage(JSON.parse(line))).toEqual({
      kind: "live",
      subscriptionId: 1,
      key: "k",
      update: { type: "ended" },
    });
  });
});

describe("host link fragment", () => {
  it("round-trips the token and the session key, encoded", () => {
    const fragment = hostLinkFragment("tok/en+=", "session 1&x");
    expect(fragment.startsWith("#t=")).toBe(true);
    expect(readHostFragment(fragment)).toEqual({ token: "tok/en+=", sessionKey: "session 1&x" });
    expect(readHostFragment(hostLinkFragment("abc"))).toEqual({ token: "abc", sessionKey: null });
  });

  it("reads nothing from an empty or unrelated fragment", () => {
    expect(readHostFragment("")).toEqual({ token: null, sessionKey: null });
    expect(readHostFragment("#section")).toEqual({ token: null, sessionKey: null });
    expect(readHostFragment("#t=&key=")).toEqual({ token: null, sessionKey: null });
    expect(readHostFragment("t=abc")).toEqual({ token: "abc", sessionKey: null });
  });
});
