// Feed events derived from built replays. Sessions are invented.
import { describe, expect, it } from "vitest";
import minimal from "../../../../fixtures/replays/minimal.replay.json" with { type: "json" };
import {
  buildReplay,
  replayFeed,
  REPLAY_FEED_DEFAULTS,
  type ReplayModel,
} from "../../src/index.js";
import { call, reply, run, session, sub } from "./helpers.js";

function fanOut(): ReplayModel {
  return buildReplay(
    session(
      run(
        [
          reply({ id: "msg-1", t: 0, calls: ["toolu-1", "toolu-2"] }),
          reply({ id: "msg-2", t: 30, calls: ["toolu-3", "toolu-4"] }),
          reply({ id: "msg-3", t: 300, calls: ["toolu-5"] }),
        ],
        [
          call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 25 }),
          call({ id: "toolu-2", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 28 }),
          call({
            id: "toolu-3",
            name: "Bash",
            kind: "shell",
            msg: "msg-2",
            t: 31,
            end: 32,
            error: true,
          }),
          call({ id: "toolu-4", name: "Read", kind: "read", msg: "msg-2", t: 31, end: 31.5 }),
          call({
            id: "toolu-5",
            name: "Edit",
            kind: "edit",
            msg: "msg-3",
            t: 301,
            end: 302,
            error: true,
          }),
        ],
      ),
      [
        sub({
          agentId: "rt-1",
          agentType: "worker",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          run: run(
            [
              reply({ id: "m-a", t: 2, calls: ["toolu-a"], tokens: [1, 40, 0, 0] }),
              reply({ id: "m-b", t: 24, tokens: [1, 60, 0, 0] }),
            ],
            [
              call({
                id: "toolu-a",
                name: "mcp__docs__find",
                kind: "mcp",
                mcpServer: "docs",
                msg: "m-a",
                t: 23,
                end: 23.5,
                error: true,
              }),
            ],
          ),
        }),
        sub({
          agentId: "rt-2",
          agentType: "worker",
          parentToolUseId: "toolu-2",
          parentAgentId: "main",
          run: run(
            [
              reply({ id: "m-c", t: 3, tokens: [1, 5, 0, 0] }),
              reply({ id: "m-d", t: 27, tokens: [1, 7, 0, 0] }),
            ],
            [],
          ),
        }),
      ],
    ),
  );
}

describe("replayFeed", () => {
  const model = fanOut();
  const feed = replayFeed(model);

  it("lists dispatch, grouped failures, handbacks and idle skips in time order", () => {
    // Idle 33 s to 297 s is cut to 8 s: the cut sits at 37 s and removes 256 s.
    expect(model.warps).toEqual([{ at: 37, skipped: 256 }]);
    expect(feed).toEqual([
      { kind: "dispatch", t: 1, parent: "main", wave: 0, agents: ["a1", "a2"] },
      {
        kind: "failures",
        t: 23,
        calls: [
          { agent: "a1", name: "mcp:docs", t: 23 },
          { agent: "main", name: "Bash", t: 31 },
        ],
        agents: ["a1", "main"],
      },
      { kind: "handback", t: 24, agent: "a1", parent: "main", outputTokens: 100 },
      { kind: "handback", t: 27, agent: "a2", parent: "main", outputTokens: 12 },
      { kind: "idle", t: 37, skipped: 256 },
      {
        kind: "failures",
        t: 45,
        calls: [{ agent: "main", name: "Edit", t: 45 }],
        agents: ["main"],
      },
    ]);
  });

  it("splits failure groups by the window", () => {
    const narrow = replayFeed(model, { failureGroupSeconds: 5 }).filter(
      (e) => e.kind === "failures",
    );
    expect(narrow.map((e) => e.t)).toEqual([23, 31, 45]);
    expect(REPLAY_FEED_DEFAULTS.failureGroupSeconds).toBe(12);
  });

  it("skips handbacks of agents still running", () => {
    const live = {
      ...model,
      agents: [model.agents[0], { ...model.agents[1], end: null }, ...model.agents.slice(2)],
    } as ReplayModel;
    expect(
      replayFeed(live)
        .filter((e) => e.kind === "handback")
        .map((e) => e.t),
    ).toEqual([27]);
  });

  it("works on the hand-written fixture and is deterministic", () => {
    const fixture = minimal as unknown as ReplayModel;
    const events = replayFeed(fixture);
    expect(events.filter((e) => e.kind === "dispatch")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "failures")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "idle")).toHaveLength(1);
    expect(replayFeed(fixture)).toEqual(events);
  });

  it("rejects an invalid window", () => {
    expect(() => replayFeed(model, { failureGroupSeconds: -1 })).toThrow(RangeError);
  });

  it("returns no events for a session without subagents, failures or warps", () => {
    expect(replayFeed(buildReplay(session(run([reply({ id: "m", t: 0 })], []))))).toEqual([]);
  });
});
