// The editor tab's save request for an exported replay (#168). Synthetic values only.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_SAVED_REPLAY_BYTES,
  SAVE_REPLAY_METHOD,
  TRANSPORT_METHODS,
  checkSaveReplayRequest,
  checkTransportRequest,
  parseSaveReplayResult,
  utf8ByteLength,
  type SaveReplayOutcome,
  type SaveReplayRequest,
} from "../../src/index.js";

const DATA = '{"version":1}\n';

describe("the save request", () => {
  it("is additive: not one of the transport methods, so the other hosts refuse it as before", () => {
    expect(SAVE_REPLAY_METHOD).toBe("saveReplay");
    expect(TRANSPORT_METHODS).not.toContain(SAVE_REPLAY_METHOD);
    expect(checkTransportRequest({ id: 1, method: "saveReplay", params: { data: DATA } })).toEqual({
      ok: false,
      problem: "unknown-method",
      id: 1,
    });
    expectTypeOf<SaveReplayRequest["params"]>().toEqualTypeOf<{ readonly data: string }>();
    expectTypeOf<SaveReplayOutcome>().toEqualTypeOf<"saved" | "cancelled">();
  });

  it("passes a well-formed request as a fresh object with only the known fields", () => {
    const sent = {
      id: 7,
      method: "saveReplay",
      params: { data: DATA, path: "/not/used", fileName: "not-used.json" },
      extra: true,
    };
    const checked = checkSaveReplayRequest(sent);
    expect(checked).toEqual({
      ok: true,
      request: { id: 7, method: "saveReplay", params: { data: DATA } },
    });
    if (checked?.ok !== true) throw new Error("expected ok");
    expect(checked.request.params).not.toBe(sent.params);
  });

  it("returns null for anything that is not a save request", () => {
    for (const value of [
      null,
      "saveReplay",
      [],
      { id: 1, method: "loadReplay", params: { key: "k" } },
      { id: 1, params: { data: DATA } },
    ]) {
      expect(checkSaveReplayRequest(value)).toBeNull();
    }
  });

  it("refuses a save request without a usable id, so the host drops it", () => {
    for (const id of [undefined, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(checkSaveReplayRequest({ id, method: "saveReplay", params: { data: DATA } })).toEqual({
        ok: false,
        problem: "no-id",
        id: null,
      });
    }
  });

  it("refuses missing, empty or wrongly typed data as bad params", () => {
    for (const params of [undefined, null, [], {}, { data: "" }, { data: 1 }, { data: {} }]) {
      expect(checkSaveReplayRequest({ id: 3, method: "saveReplay", params })).toEqual({
        ok: false,
        problem: "bad-params",
        id: 3,
      });
    }
  });

  it("refuses text over the size limit, counted in UTF-8 bytes", () => {
    expect(MAX_SAVED_REPLAY_BYTES).toBe(50 * 1024 * 1024);
    const atLimit = "a".repeat(MAX_SAVED_REPLAY_BYTES);
    expect(
      checkSaveReplayRequest({ id: 4, method: "saveReplay", params: { data: atLimit } }),
    ).toMatchObject({ ok: true });
    const over = `${atLimit}a`;
    expect(checkSaveReplayRequest({ id: 4, method: "saveReplay", params: { data: over } })).toEqual(
      { ok: false, problem: "too-large", id: 4 },
    );
    // Fewer characters than the limit, but more bytes: each é is two bytes.
    const wide = "é".repeat(MAX_SAVED_REPLAY_BYTES / 2 + 1);
    expect(checkSaveReplayRequest({ id: 5, method: "saveReplay", params: { data: wide } })).toEqual(
      { ok: false, problem: "too-large", id: 5 },
    );
  });
});

describe("utf8ByteLength", () => {
  it("counts the bytes a UTF-8 encoder writes", () => {
    const encoder = new TextEncoder();
    for (const text of [
      "",
      "abc",
      "é",
      "€",
      "😀",
      "a😀b€é",
      "\ud800",
      "x\udc00y",
      "\ud800\ud800",
    ]) {
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).length);
    }
  });
});

describe("parseSaveReplayResult", () => {
  it("reads the two outcomes and nothing else", () => {
    expect(parseSaveReplayResult({ outcome: "saved", path: "/not/kept" })).toEqual({
      outcome: "saved",
    });
    expect(parseSaveReplayResult({ outcome: "cancelled" })).toEqual({ outcome: "cancelled" });
    for (const value of [null, undefined, "saved", [], {}, { outcome: "failed" }]) {
      expect(parseSaveReplayResult(value)).toBeNull();
    }
  });
});
