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
import { withRecordedSplit, withReplyModels } from "./ledger-models";

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

/** `model` with `extra` added to the main agent's first reply. */
function withMainReplyExtra(extra: Record<string, unknown>): unknown {
  const model = makeModel();
  const [main, ...rest] = model.agents;
  const [first, ...replies] = main.replies;
  return {
    ...model,
    agents: [{ ...main, replies: [{ ...first, ...extra }, ...replies] }, ...rest],
  };
}

describe("decodeReplay and decodeLiveUpdate: reply details (#203)", () => {
  it("accept a model whose replies carry the cache-write split or their own model", () => {
    for (const model of [withRecordedSplit(), withReplyModels("all"), withReplyModels("some")]) {
      expect(decodeReplay(model)).toBe(model);
      const update = { type: "replay", replay: model, live: "busy" } as const;
      expect(decodeLiveUpdate(update)).toBe(update);
    }
  });

  it("refuse a detail of the wrong type, naming the pointer and rule but not the value", () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { cacheWrite5mTokens: -1 },
        "/agents/0/replies/0/cacheWrite5mTokens: must be a whole number of tokens, 0 or more",
      ],
      [
        { cacheWrite1hTokens: 1.5 },
        "/agents/0/replies/0/cacheWrite1hTokens: must be a whole number of tokens, 0 or more",
      ],
      [{ model: "synthetic model name" }, "/agents/0/replies/0/model: must be a model id"],
    ];
    for (const [extra, problem] of cases) {
      const value = withMainReplyExtra(extra);
      const error = thrown(() => decodeReplay(value)) as { code: string; message: string };
      expect(error.code).toBe("invalid");
      expect(error.message).toBe(`${CLIENT_MESSAGES.badReplay} ${problem}`);
      expect(error.message).not.toContain("synthetic model name");
      expect(
        decodeLiveUpdate({ type: "replay", replay: value as never, live: "busy" }),
      ).toMatchObject({ type: "error", error: { code: "invalid", message: error.message } });
    }
  });

  it("still refuse any other unknown property, on a reply or anywhere else", () => {
    const onReply = thrown(() => decodeReplay(withMainReplyExtra({ prompt: "synthetic" })));
    expect(onReply).toMatchObject({ code: "invalid" });
    expect((onReply as { message: string }).message).toContain("/agents/0/replies/0");
    expect((onReply as { message: string }).message).not.toContain('"synthetic"');
    const onRoot = thrown(() => decodeReplay({ ...withRecordedSplit(), extra: true }));
    expect(onRoot).toMatchObject({ code: "invalid" });
    const onAgent = { ...withRecordedSplit() } as unknown as { agents: unknown[] };
    onAgent.agents = [{ ...(onAgent.agents[0] as object), cwd: "x" }, ...onAgent.agents.slice(1)];
    expect(thrown(() => decodeReplay(onAgent))).toMatchObject({ code: "invalid" });
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
