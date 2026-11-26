import { describe, expect, it } from "vitest";
import { RUNTIME_IDS } from "@orbitrace/core";
import {
  CLIENT_MESSAGES,
  asTransportError,
  decodeLiveUpdate,
  decodeReplay,
  decodeSessionSummary,
  decodeSessions,
} from "../src/client-decode";
import { SUMMARY, makeModel } from "./helpers";

/** What `run` throws, or `undefined`. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("decodeSessionSummary", () => {
  it("copies only the summary fields", () => {
    const decoded = decodeSessionSummary({ ...SUMMARY, locator: "/somewhere/else", root: "x" });
    expect(decoded).toEqual(SUMMARY);
    expect(Object.keys(decoded ?? {})).not.toContain("locator");
  });

  it("accepts a null subagent count", () => {
    expect(decodeSessionSummary({ ...SUMMARY, subagentCount: null })?.subagentCount).toBeNull();
  });

  it("rejects a summary with a missing or wrong field", () => {
    expect(decodeSessionSummary(null)).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, key: "" })).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, runtime: "other" })).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, projectLabel: 3 })).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, lastActivity: "today" })).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, live: "running" })).toBeNull();
    expect(decodeSessionSummary({ ...SUMMARY, subagentCount: -1 })).toBeNull();
  });

  it("accepts every runtime in core's RUNTIME_IDS (#94)", () => {
    for (const runtime of RUNTIME_IDS) {
      expect(decodeSessionSummary({ ...SUMMARY, runtime })?.runtime).toBe(runtime);
    }
  });
});

describe("decodeSessions", () => {
  it("keeps valid summaries and drops the rest", () => {
    expect(decodeSessions([SUMMARY, { key: 1 }])).toEqual([SUMMARY]);
  });

  it("throws an invalid error for a value that is not a list", () => {
    expect(thrown(() => decodeSessions({}))).toEqual({
      code: "invalid",
      message: CLIENT_MESSAGES.badSessions,
    });
    expect(thrown(() => decodeSessions("x"))).toMatchObject({ code: "invalid" });
  });
});

describe("decodeReplay", () => {
  it("returns a valid replay and throws an invalid error with problems otherwise", () => {
    expect(decodeReplay(makeModel())).toEqual(makeModel());
    const error = thrown(() => decodeReplay({ formatVersion: 1 }));
    expect(error).toMatchObject({ code: "invalid" });
    expect((error as { message: string }).message.startsWith(CLIENT_MESSAGES.badReplay)).toBe(true);
  });
});

describe("decodeLiveUpdate", () => {
  it("passes valid updates and turns an invalid replay into an error", () => {
    const update = { type: "replay", replay: makeModel(), live: "busy" } as const;
    expect(decodeLiveUpdate(update)).toBe(update);
    expect(decodeLiveUpdate({ type: "ended" })).toEqual({ type: "ended" });
    const bad = decodeLiveUpdate({
      type: "replay",
      replay: { formatVersion: 3 } as never,
      live: "busy",
    });
    expect(bad).toMatchObject({ type: "error", error: { code: "invalid" } });
  });
});

describe("asTransportError", () => {
  it("keeps a transport error and hides anything else", () => {
    expect(asTransportError({ code: "not-found", message: "Gone.", extra: 1 })).toEqual({
      code: "not-found",
      message: "Gone.",
    });
    expect(asTransportError(new Error("synthetic detail"))).toEqual({
      code: "internal",
      message: CLIENT_MESSAGES.failed,
    });
    expect(asTransportError(undefined, "Fallback.")).toEqual({
      code: "internal",
      message: "Fallback.",
    });
  });
});
