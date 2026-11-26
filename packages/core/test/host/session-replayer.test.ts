// The shared session-to-replay helper (ticket #75), driven through an in-memory adapter.
// Every session, line, name and path here is invented.
import { describe, expect, it, vi } from "vitest";
import {
  buildReplay,
  parseSession,
  validateReplay,
  type ReplayModel,
  type SessionRef,
} from "../../src/index.js";
import {
  createSessionReplayer,
  SESSION_REPLAY_MESSAGES,
  SessionReplayError,
  type SessionReplayUpdate,
} from "../../src/sources/node.js";
import {
  CONTENT_MARKER,
  assistant,
  toolResult,
  toolUse,
  userPrompt,
  userResults,
} from "../parser/synthetic.js";
import { FAKE_PATH, ROOT, fakeRef, fakeWorld, type FakeSession } from "./fake-adapter.js";

/** Main dispatches one reviewer, which reads a file and replies. */
function firstPart(): Pick<FakeSession, "main" | "subagents"> {
  return {
    main: [
      userPrompt({ time: "00:00" }),
      assistant({
        time: "00:01",
        id: "msg-1",
        model: "claude-opus-5-5",
        content: [toolUse("toolu-a1", "Agent")],
      }),
      userResults({ time: "00:08", results: [toolResult("toolu-a1")] }),
      assistant({ time: "00:09", id: "msg-2", model: "claude-opus-5-5" }),
    ],
    subagents: [
      {
        agentId: "rt-1",
        meta: { agentType: "code-reviewer", toolUseId: "toolu-a1" },
        lines: [
          assistant({
            time: "00:02",
            id: "msg-s1",
            model: "claude-sonnet-9",
            content: [toolUse("toolu-s1", "Read")],
          }),
          userResults({ time: "00:05", results: [toolResult("toolu-s1")] }),
          assistant({ time: "00:06", id: "msg-s2", model: "claude-sonnet-9" }),
        ],
      },
    ],
  };
}

/** Append a second dispatch (a test runner) to a session made by `firstPart`. */
function grow(session: FakeSession): void {
  session.main.push(
    assistant({
      time: "00:10",
      id: "msg-3",
      model: "claude-opus-5-5",
      content: [toolUse("toolu-a2", "Agent")],
    }),
  );
  session.subagents.push({
    agentId: "rt-2",
    meta: { agentType: "test-runner", toolUseId: "toolu-a2" },
    lines: [assistant({ time: "00:11", id: "msg-t1", model: "claude-haiku-9" })],
  });
}

function makeSession(
  key: string,
  lastActivity = 1_000,
  live: SessionRef["live"] = "busy",
): FakeSession {
  return { ref: fakeRef(key, lastActivity, live), ...firstPart() };
}

/** A listener that records updates, and a way to wait for a number of them. */
function recorder() {
  const updates: SessionReplayUpdate[] = [];
  return {
    updates,
    listener: (update: SessionReplayUpdate) => {
      updates.push(update);
    },
    async waitFor(count: number): Promise<void> {
      await vi.waitFor(() => {
        expect(updates.length).toBeGreaterThanOrEqual(count);
      });
    },
  };
}

function replayOf(update: SessionReplayUpdate | undefined): ReplayModel {
  if (update?.type !== "replay") throw new Error(`expected a replay update, got ${update?.type}`);
  return update.replay;
}

/** Let pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function rejection(promise: Promise<unknown>): Promise<SessionReplayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionReplayError) return error;
    throw new Error("rejected with something other than a SessionReplayError", { cause: error });
  }
  throw new Error("did not reject");
}

describe("createSessionReplayer: list and find", () => {
  it("lists path-free summaries, newest first", async () => {
    const world = fakeWorld([makeSession("k-old", 1_000, "ended"), makeSession("k-new", 2_000)]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const summaries = await replayer.list();
    expect(summaries.map((s) => s.key)).toEqual(["k-new", "k-old"]);
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(
        [
          "key",
          "lastActivity",
          "live",
          "projectLabel",
          "runtime",
          "sessionId",
          "subagentCount",
        ].sort(),
      );
    }
    expect(await replayer.list({ limit: 1 })).toHaveLength(1);
  });

  it("finds a listed key from memory and an unlisted one by listing again", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const roots = vi.fn(async () => [ROOT]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots });
    await replayer.list();
    expect(roots).toHaveBeenCalledTimes(1);
    expect((await replayer.find("k-1")).locator).toContain("k-1");
    expect(world.counts.list).toBe(1);

    world.sessions.push(makeSession("k-2"));
    expect((await replayer.find("k-2")).key).toBe("k-2");
    expect(roots).toHaveBeenCalledTimes(2);
    expect(world.counts.list).toBe(2);
    await replayer.find("k-2");
    expect(world.counts.list).toBe(2);
  });

  it("rejects an unknown or empty key with not-found", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    for (const key of ["k-missing", ""]) {
      const error = await rejection(replayer.find(key));
      expect([error.code, error.message]).toEqual(["not-found", SESSION_REPLAY_MESSAGES.notFound]);
    }
  });

  it("reports roots that cannot be resolved as internal, without the cause's text", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({
      adapters: [world.adapter],
      roots: async () => {
        throw new Error(`EACCES: ${FAKE_PATH}`);
      },
    });
    for (const promise of [replayer.list(), replayer.find("k-1"), replayer.load("k-1")]) {
      const error = await rejection(promise);
      expect([error.code, error.message]).toEqual([
        "internal",
        SESSION_REPLAY_MESSAGES.rootsFailed,
      ]);
    }
  });
});

describe("createSessionReplayer: load", () => {
  it("builds the same validated replay as the core chain, with no content in it", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const model = await replayer.load("k-1");
    expect(validateReplay(model)).toBe(true);
    const direct = buildReplay(
      await parseSession({ main: session.main, subagents: session.subagents }),
    );
    expect(model).toEqual(direct);
    expect(model.agents.map((a) => a.callsign)).toEqual(["main", "code-reviewer"]);
    expect(JSON.stringify(model)).not.toContain(CONTENT_MARKER);
  });

  it("passes build options to the builder", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({
      adapters: [world.adapter],
      roots: [ROOT],
      build: { now: Date.parse("2030-01-02T10:00:03.000Z") },
    });
    const model = await replayer.load("k-1");
    expect(model.agents[0].end).toBeNull();
    expect(model.agents[1]?.replies).toHaveLength(1);
  });

  it("makes a fresh build on every load", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    await replayer.load("k-1");
    grow(session);
    const model = await replayer.load("k-1");
    expect(model).toEqual(
      buildReplay(await parseSession({ main: session.main, subagents: session.subagents })),
    );
  });

  it("maps failures to error codes with path-free messages", async () => {
    const cases: [Partial<FakeSession>, string, string][] = [
      [{ failOpen: true }, "unreadable", SESSION_REPLAY_MESSAGES.unreadable],
      [{ failRead: true }, "unreadable", SESSION_REPLAY_MESSAGES.unreadable],
    ];
    for (const [patch, code, message] of cases) {
      const world = fakeWorld([{ ...makeSession("k-1"), ...patch }]);
      const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
      const error = await rejection(replayer.load("k-1"));
      expect([error.code, error.message]).toEqual([code, message]);
      expect(error.message).not.toContain("/srv");
    }
    const world = fakeWorld([makeSession("k-1")]);
    const badOptions = createSessionReplayer({
      adapters: [world.adapter],
      roots: [ROOT],
      build: { idleGapSeconds: -1 },
    });
    const error = await rejection(badOptions.load("k-1"));
    expect([error.code, error.message]).toEqual(["internal", SESSION_REPLAY_MESSAGES.buildFailed]);
    const missing = await rejection(badOptions.load("k-none"));
    expect(missing.code).toBe("not-found");
  });
});

describe("createSessionReplayer: follow", () => {
  it("sends the current state, then a rebuild with the last model as previous on each change", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    const stop = replayer.follow("k-1", rec.listener);
    await rec.waitFor(1);
    const first = replayOf(rec.updates[0]);
    expect(rec.updates[0]).toMatchObject({ type: "replay", live: "busy" });
    expect(first).toEqual(await replayer.load("k-1"));
    expect(world.watchers("k-1")).toBe(1);

    grow(session);
    world.change("k-1", { live: "idle" });
    await rec.waitFor(2);
    const second = replayOf(rec.updates[1]);
    expect(rec.updates[1]).toMatchObject({ type: "replay", live: "idle" });
    expect(validateReplay(second)).toBe(true);
    expect(second).toEqual(
      buildReplay(await parseSession({ main: session.main, subagents: session.subagents }), {
        previous: first,
      }),
    );
    expect(second.agents.map((a) => [a.id, a.callsign])).toEqual([
      ["main", "main"],
      ["a1", "code-reviewer"],
      ["a2", "test-runner"],
    ]);

    stop();
    stop();
    expect(world.watchers("k-1")).toBe(0);
    world.change("k-1");
    await settle();
    expect(rec.updates).toHaveLength(2);
  });

  it("merges changes that arrive during a build into one more build, in order", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    const stop = replayer.follow("k-1", rec.listener);
    await rec.waitFor(1);
    const opened = world.counts.open;
    world.change("k-1");
    grow(session);
    world.change("k-1");
    world.change("k-1");
    await rec.waitFor(3);
    await settle();
    expect(world.counts.open - opened).toBe(2);
    expect(rec.updates).toHaveLength(3);
    expect(replayOf(rec.updates[2]).agents).toHaveLength(3);
    stop();
  });

  it("keeps a separate subscription per call", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const a = recorder();
    const b = recorder();
    const stopA = replayer.follow("k-1", a.listener);
    const stopB = replayer.follow("k-1", b.listener);
    await a.waitFor(1);
    await b.waitFor(1);
    expect(world.watchers("k-1")).toBe(2);
    stopA();
    grow(session);
    world.change("k-1");
    await b.waitFor(2);
    await settle();
    expect(a.updates).toHaveLength(1);
    expect(replayOf(b.updates[1]).agents).toHaveLength(3);
    stopB();
  });

  it("sends the current state and then ended when the adapter cannot watch", async () => {
    const world = fakeWorld([makeSession("k-1")], { watch: false });
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    const stop = replayer.follow("k-1", rec.listener);
    await rec.waitFor(2);
    await settle();
    expect(rec.updates.map((u) => u.type)).toEqual(["replay", "ended"]);
    stop();
  });

  it("sends one error for an unknown key", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    replayer.follow("k-none", rec.listener);
    await rec.waitFor(1);
    await settle();
    expect(rec.updates).toEqual([
      { type: "error", error: { code: "not-found", message: SESSION_REPLAY_MESSAGES.notFound } },
    ]);
    expect(world.counts.watch).toBe(0);
  });

  it("sends one error and stops watching when a build fails", async () => {
    const session = makeSession("k-1");
    const world = fakeWorld([session]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    replayer.follow("k-1", rec.listener);
    await rec.waitFor(1);
    session.failOpen = true;
    world.change("k-1");
    await rec.waitFor(2);
    expect(rec.updates[1]).toEqual({
      type: "error",
      error: { code: "unreadable", message: SESSION_REPLAY_MESSAGES.unreadable },
    });
    expect(world.watchers("k-1")).toBe(0);
    session.failOpen = false;
    world.change("k-1");
    await settle();
    expect(rec.updates).toHaveLength(2);
  });

  it("sends an error when the first build fails", async () => {
    const world = fakeWorld([{ ...makeSession("k-1"), failOpen: true }]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    replayer.follow("k-1", rec.listener);
    await rec.waitFor(1);
    await settle();
    expect(rec.updates.map((u) => (u.type === "error" ? u.error.code : u.type))).toEqual([
      "unreadable",
    ]);
    expect(world.watchers("k-1")).toBe(0);
  });

  it("sends an internal error when the watch cannot start", async () => {
    const world = fakeWorld([makeSession("k-1")], { watchThrows: true });
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    replayer.follow("k-1", rec.listener);
    await rec.waitFor(1);
    await settle();
    expect(rec.updates).toEqual([
      { type: "error", error: { code: "internal", message: SESSION_REPLAY_MESSAGES.watchFailed } },
    ]);
    expect(JSON.stringify(rec.updates)).not.toContain("/srv");
  });

  it("sends nothing and leaves no watch when stopped before the session is found", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const rec = recorder();
    const stop = replayer.follow("k-1", rec.listener);
    stop();
    await settle();
    expect(rec.updates).toEqual([]);
    expect(world.counts.watch).toBe(0);
  });

  it("sends nothing when stopped while the first build runs", async () => {
    const world = fakeWorld([makeSession("k-1")]);
    const replayer = createSessionReplayer({ adapters: [world.adapter], roots: [ROOT] });
    const release = world.hold();
    const rec = recorder();
    const stop = replayer.follow("k-1", rec.listener);
    await vi.waitFor(() => {
      expect(world.counts.open).toBe(1);
    });
    stop();
    release();
    await settle();
    expect(rec.updates).toEqual([]);
    expect(world.watchers("k-1")).toBe(0);
  });
});
