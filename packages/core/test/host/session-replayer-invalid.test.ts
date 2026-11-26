// The schema check in the session replayer (ticket #75). The builder always produces a valid
// replay, so this file swaps it for one that adds a property the format does not allow.
import { describe, expect, it, vi } from "vitest";
import { createSessionReplayer, SESSION_REPLAY_MESSAGES } from "../../src/sources/node.js";
import { assistant } from "../parser/synthetic.js";
import { ROOT, fakeRef, fakeWorld } from "./fake-adapter.js";

vi.mock("../../src/replay/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/replay/index.js")>();
  return {
    ...actual,
    buildReplay: (...args: Parameters<typeof actual.buildReplay>) => ({
      ...actual.buildReplay(...args),
      exampleExtra: true,
    }),
  };
});

describe("createSessionReplayer: schema check", () => {
  const world = fakeWorld([
    {
      ref: fakeRef("k-1", 1_000, "busy"),
      main: [assistant({ time: "00:01", id: "msg-1", model: "claude-opus-5-5" })],
      subagents: [],
    },
  ]);
  const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });

  it("rejects a load whose replay does not validate, naming the rule but no value", async () => {
    const error = await replayer.load("k-1").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "invalid" });
    const message = (error as Error).message;
    expect(message.startsWith(SESSION_REPLAY_MESSAGES.invalid)).toBe(true);
    expect(message).toContain('(root): has a property the format does not allow: "exampleExtra"');
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
