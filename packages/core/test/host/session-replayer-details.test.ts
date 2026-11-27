// Ticket #203: the session replayer builds with reply details (each reply's cache writes by
// lifetime and its own model id) for the first load and for every live update, and checks the
// result as an in-memory model. Every session, line, name and number here is invented.
import { describe, expect, it, vi } from "vitest";
import {
  buildReplay,
  cacheWriteBasis,
  exportReplay,
  parseSession,
  sessionLedger,
  validateReplay,
  validateReplayModel,
  withoutReplyDetails,
  type ReplayModel,
} from "../../src/index.js";
import {
  createSessionReplayer,
  type SessionReplayBuildOptions,
  type SessionReplayUpdate,
} from "../../src/sources/node.js";
import { assistant, toolResult, toolUse, userPrompt, userResults } from "../parser/synthetic.js";
import { ROOT, fakeRef, fakeWorld, type FakeSession } from "./fake-adapter.js";

/** Main writes to the 1-hour cache, then switches model; its helper records no split. */
function splitSession(key: string): FakeSession {
  return {
    ref: fakeRef(key, 1_000, "busy"),
    main: [
      userPrompt({ time: "00:00" }),
      assistant({
        time: "00:01",
        id: "msg-1",
        model: "claude-opus-5-5",
        usage: {
          input: 10,
          output: 20,
          cacheCreation: 3_000,
          cacheCreationSplit: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000 },
        },
        content: [toolUse("toolu-a1", "Agent")],
      }),
      userResults({ time: "00:08", results: [toolResult("toolu-a1")] }),
      assistant({
        time: "00:09",
        id: "msg-2",
        model: "claude-haiku-5-5",
        usage: {
          input: 5,
          output: 7,
          cacheCreation: 400,
          cacheCreationSplit: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
        },
      }),
    ],
    subagents: [
      {
        agentId: "rt-1",
        meta: { agentType: "example-helper", toolUseId: "toolu-a1" },
        lines: [
          assistant({
            time: "00:02",
            id: "msg-s1",
            model: "claude-sonnet-5-5",
            usage: { input: 3, output: 4, cacheCreation: 50 },
          }),
        ],
      },
    ],
  };
}

/** One more main reply, written to the 5-minute cache. */
function growWithSplit(session: FakeSession): void {
  session.main.push(
    assistant({
      time: "00:20",
      id: "msg-3",
      model: "claude-opus-5-5",
      usage: {
        input: 2,
        output: 9,
        cacheCreation: 800,
        cacheCreationSplit: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 },
      },
    }),
  );
}

async function plainBuild(session: FakeSession): Promise<ReplayModel> {
  return buildReplay(await parseSession({ main: session.main, subagents: session.subagents }));
}

/** Each agent's replies as [model, 5-minute writes, 1-hour writes], `-` for a missing value. */
function detailsOf(model: ReplayModel): string[][] {
  return model.agents.map((agent) =>
    agent.replies.map((reply) =>
      [reply.model, reply.cacheWrite5mTokens, reply.cacheWrite1hTokens]
        .map((value) => (value === undefined ? "-" : String(value)))
        .join(" "),
    ),
  );
}

function replayOf(update: SessionReplayUpdate | undefined): ReplayModel {
  if (update?.type !== "replay") throw new Error(`expected a replay update, got ${update?.type}`);
  return update.replay;
}

describe("createSessionReplayer: reply details (#203)", () => {
  it("loads a model with each reply's split and model, checked as an in-memory model", async () => {
    const session = splitSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const model = await replayer.load("k-1");

    expect(detailsOf(model)).toEqual([
      ["claude-opus-5-5 0 3000", "claude-haiku-5-5 100 300"],
      ["claude-sonnet-5-5 - -"],
    ]);
    expect(validateReplayModel(model)).toBe(true);
    // The exact file check still refuses the details, and taking them out gives the plain build.
    expect(validateReplay(model)).toBe(false);
    expect(withoutReplyDetails(model)).toEqual(await plainBuild(session));
  });

  it("gives the ledger the recorded split and the replies' own models", async () => {
    const world = fakeWorld([splitSession("k-1")]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const ledger = sessionLedger(await replayer.load("k-1"));
    // Main's writes are recorded; the helper's 50 are not, so the session is mixed.
    expect(cacheWriteBasis(ledger.session)).toBe("mixed");
    expect(ledger.session.cacheWrites).toMatchObject({
      recorded5m: 100,
      recorded1h: 3_300,
      unrecorded: 50,
    });
    expect(ledger.session.ownModelReplies).toBe(3);
    expect(ledger.byModel.map((entry) => entry.model).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
  });

  it("exports exactly the bytes of a build without details", async () => {
    const session = splitSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const loaded = await replayer.load("k-1");
    const plain = await plainBuild(session);
    for (const pretty of [false, true]) {
      expect(exportReplay(loaded, { pretty }).data).toBe(exportReplay(plain, { pretty }).data);
    }
    const options = { names: "opaque", roundTimes: 0.1, bucketTokens: true } as const;
    expect(exportReplay(loaded, options).data).toBe(exportReplay(plain, options).data);
  });

  it("carries the details in the first live update and in every rebuild", async () => {
    const session = splitSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const updates: SessionReplayUpdate[] = [];
    const stop = replayer.follow("k-1", (update) => updates.push(update));
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    const first = replayOf(updates[0]);
    expect(first).toEqual(await replayer.load("k-1"));

    growWithSplit(session);
    world.change("k-1");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(2);
    });
    const second = replayOf(updates[1]);
    expect(validateReplayModel(second)).toBe(true);
    expect(detailsOf(second)).toEqual([
      ["claude-opus-5-5 0 3000", "claude-haiku-5-5 100 300", "claude-opus-5-5 800 0"],
      ["claude-sonnet-5-5 - -"],
    ]);
    // The same build the host would make by hand, with the last model as `previous`.
    expect(second).toEqual(
      buildReplay(await parseSession({ main: session.main, subagents: session.subagents }), {
        previous: first,
        replyDetails: true,
      }),
    );
    stop();
  });

  it("builds with details even when the build options try to turn them off", async () => {
    const world = fakeWorld([splitSession("k-1")]);
    // The type leaves `replyDetails` out; a caller that passes it anyway is overruled.
    const build = { replyDetails: false } as unknown as SessionReplayBuildOptions;
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT], build });
    const model = await replayer.load("k-1");
    expect(model.agents[0]?.replies[0]).toMatchObject({
      model: "claude-opus-5-5",
      cacheWrite1hTokens: 3_000,
    });
  });

  it("writes no detail a transcript did not record", async () => {
    const session: FakeSession = {
      ref: fakeRef("k-2", 1_000, "ended"),
      main: [assistant({ time: "00:01", id: "msg-1", usage: { input: 1, cacheCreation: 9 } })],
      subagents: [],
    };
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const model = await replayer.load("k-2");
    expect(model).toEqual(await plainBuild(session));
    expect(validateReplay(model)).toBe(true);
  });
});
