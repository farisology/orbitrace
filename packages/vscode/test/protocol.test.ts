import { describe, expect, it } from "vitest";
import * as core from "@orbitrace/core";
import {
  TRANSPORT_METHODS,
  isRequestId,
  parseListOptions,
  parseTransportRequest,
} from "../src/protocol.js";

describe("one request check for every host (#92)", () => {
  it("re-exports core's check and limits", () => {
    expect(parseTransportRequest).toBe(core.checkTransportRequest);
    expect(isRequestId).toBe(core.isRequestId);
    expect(parseListOptions).toBe(core.parseListOptions);
    expect(TRANSPORT_METHODS).toBe(core.TRANSPORT_METHODS);
  });
});

describe("isRequestId", () => {
  it("accepts safe integers from 0 only", () => {
    expect(isRequestId(0)).toBe(true);
    expect(isRequestId(42)).toBe(true);
    expect(isRequestId(-1)).toBe(false);
    expect(isRequestId(1.5)).toBe(false);
    expect(isRequestId(Number.NaN)).toBe(false);
    expect(isRequestId(2 ** 60)).toBe(false);
    expect(isRequestId("1")).toBe(false);
  });
});

describe("parseListOptions", () => {
  it("keeps since and limit when valid", () => {
    expect(parseListOptions({})).toEqual({});
    expect(parseListOptions({ since: 1000, limit: 5 })).toEqual({ since: 1000, limit: 5 });
  });

  it("drops unknown fields", () => {
    expect(parseListOptions({ limit: 1, extra: "x" })).toEqual({ limit: 1 });
  });

  it("refuses wrong types and ranges", () => {
    expect(parseListOptions(null)).toBeNull();
    expect(parseListOptions([])).toBeNull();
    expect(parseListOptions({ since: "1" })).toBeNull();
    expect(parseListOptions({ since: -1 })).toBeNull();
    expect(parseListOptions({ since: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseListOptions({ limit: 1.5 })).toBeNull();
    expect(parseListOptions({ limit: -2 })).toBeNull();
    expect(parseListOptions({ limit: 0 })).toBeNull();
  });
});

describe("parseTransportRequest", () => {
  it("lists every method of the contract", () => {
    expect(TRANSPORT_METHODS).toEqual([
      "listSessions",
      "loadReplay",
      "subscribe",
      "unsubscribe",
      "openInBrowser",
    ]);
  });

  it("accepts each request shape and copies only the known fields", () => {
    expect(parseTransportRequest({ id: 1, method: "listSessions", params: {} })).toEqual({
      ok: true,
      request: { id: 1, method: "listSessions", params: {} },
    });
    expect(
      parseTransportRequest({ id: 2, method: "listSessions", params: { options: { limit: 3 } } }),
    ).toEqual({
      ok: true,
      request: { id: 2, method: "listSessions", params: { options: { limit: 3 } } },
    });
    expect(
      parseTransportRequest({
        id: 3,
        method: "loadReplay",
        params: { key: "k", path: "/x" },
        extra: 1,
      }),
    ).toEqual({ ok: true, request: { id: 3, method: "loadReplay", params: { key: "k" } } });
    expect(parseTransportRequest({ id: 4, method: "subscribe", params: { key: "k" } })).toEqual({
      ok: true,
      request: { id: 4, method: "subscribe", params: { key: "k" } },
    });
    expect(
      parseTransportRequest({ id: 5, method: "unsubscribe", params: { subscriptionId: 4 } }),
    ).toEqual({
      ok: true,
      request: { id: 5, method: "unsubscribe", params: { subscriptionId: 4 } },
    });
    expect(parseTransportRequest({ id: 6, method: "openInBrowser", params: {} })).toEqual({
      ok: true,
      request: { id: 6, method: "openInBrowser", params: {} },
    });
    expect(parseTransportRequest({ id: 7, method: "openInBrowser", params: { key: "k" } })).toEqual(
      { ok: true, request: { id: 7, method: "openInBrowser", params: { key: "k" } } },
    );
  });

  it("drops messages it cannot reply to", () => {
    for (const message of [
      null,
      "text",
      5,
      [],
      {},
      { id: "1" },
      { id: 1.5, method: "listSessions" },
      { id: -1, method: "listSessions", params: {} },
    ]) {
      expect(parseTransportRequest(message)).toEqual({ ok: false, problem: "no-id", id: null });
    }
  });

  it("reports an unknown method with the id", () => {
    expect(parseTransportRequest({ id: 9, method: "readFile", params: {} })).toEqual({
      ok: false,
      problem: "unknown-method",
      id: 9,
    });
    expect(parseTransportRequest({ id: 9, params: {} })).toMatchObject({
      problem: "unknown-method",
    });
    expect(parseTransportRequest({ id: 9, method: "toString", params: {} })).toMatchObject({
      problem: "unknown-method",
    });
  });

  it("reports bad parameters with the id", () => {
    const bad = [
      { id: 1, method: "listSessions" },
      { id: 1, method: "listSessions", params: null },
      { id: 1, method: "listSessions", params: { options: { limit: "all" } } },
      { id: 1, method: "loadReplay", params: {} },
      { id: 1, method: "loadReplay", params: { key: "" } },
      { id: 1, method: "loadReplay", params: { key: 7 } },
      { id: 1, method: "loadReplay", params: { key: "k".repeat(2000) } },
      { id: 1, method: "subscribe", params: { key: null } },
      { id: 1, method: "unsubscribe", params: { subscriptionId: "4" } },
      { id: 1, method: "openInBrowser", params: { key: 3 } },
    ];
    for (const message of bad) {
      expect(parseTransportRequest(message)).toEqual({ ok: false, problem: "bad-params", id: 1 });
    }
  });
});
