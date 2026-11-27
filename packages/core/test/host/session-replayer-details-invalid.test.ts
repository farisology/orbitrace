// Ticket #203: the session replayer checks a model with reply details using
// `describeReplayModelProblems`, so a detail of the wrong type is still refused, by its JSON
// pointer and rule and never by its value. The builder always writes valid details, so this file
// swaps it for one that writes a bad one. Every value here is invented.
import { describe, expect, it, vi } from "vitest";
import { createSessionReplayer, SESSION_REPLAY_MESSAGES } from "../../src/sources/node.js";
import { assistant } from "../parser/synthetic.js";
import { ROOT, fakeRef, fakeWorld } from "./fake-adapter.js";

const BAD_MODEL = "not a model id";

vi.mock("../../src/replay/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/replay/index.js")>();
  return {
    ...actual,
    buildReplay: (...args: Parameters<typeof actual.buildReplay>) => {
      const model = actual.buildReplay(...args);
      const [main, ...rest] = model.agents;
      if (main === undefined) return model;
      const replies = main.replies.map((reply, index) =>
        index === 0 ? { ...reply, cacheWrite5mTokens: -1, model: BAD_MODEL } : reply,
      );
      return { ...model, agents: [{ ...main, replies }, ...rest] };
    },
  };
});

describe("createSessionReplayer: reply detail check (#203)", () => {
  const world = fakeWorld([
    {
      ref: fakeRef("k-1", 1_000, "busy"),
      main: [assistant({ time: "00:01", id: "msg-1", model: "claude-opus-5-5" })],
      subagents: [],
    },
  ]);
  const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });

  it("rejects a load whose details are wrong, naming the pointer and rule but no value", async () => {
    const error = await replayer.load("k-1").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "invalid" });
    const message = (error as Error).message;
    expect(message.split("\n")).toEqual([
      SESSION_REPLAY_MESSAGES.invalid,
      "- /agents/0/replies/0/cacheWrite5mTokens: must be a whole number of tokens, 0 or more",
      "- /agents/0/replies/0/model: must be a model id",
    ]);
    expect(message).not.toContain(BAD_MODEL);
  });

  it("sends an invalid error to a follower", async () => {
    const updates: unknown[] = [];
    replayer.follow("k-1", (update) => updates.push(update));
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]).toMatchObject({ type: "error", error: { code: "invalid" } });
  });
});
