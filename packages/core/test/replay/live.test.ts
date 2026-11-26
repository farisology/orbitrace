// Live builds: snapshots of one growing session, each built with the one before as
// `previous`. All sessions are invented.
import { describe, expect, it } from "vitest";
import { buildReplay, type ParsedSession, type ReplayModel } from "../../src/index.js";
import { at, call, expectValidReplay, reply, run, session, sub } from "./helpers.js";

/** Checks the append-stability rules of docs/replay-format.md between two snapshots. */
function expectAppendStable(before: ReplayModel, after: ReplayModel): void {
  expect(after.agents.length).toBeGreaterThanOrEqual(before.agents.length);
  before.agents.forEach((agent, index) => {
    const later = after.agents[index];
    expect(later).toBeDefined();
    if (later === undefined) return;
    expect([later.id, later.callsign, later.parent, later.wave, later.start]).toEqual([
      agent.id,
      agent.callsign,
      agent.parent,
      agent.wave,
      agent.start,
    ]);
    // A subagent's end only fills in; the main agent's may go back to null (#67).
    if (agent.end !== null && agent.id !== "main") expect(later.end).not.toBeNull();
    if (agent.model !== null) expect(later.model).toBe(agent.model);
    if (agent.family !== "unknown") expect(later.family).toBe(agent.family);
    if (agent.effort !== null) expect(later.effort).toBe(agent.effort);
    agent.tools.forEach((tool, i) => {
      const next = later.tools[i];
      expect(next).toMatchObject({ name: tool.name, kind: tool.kind, start: tool.start });
      if (tool.end !== null) expect(next).toEqual(tool);
    });
    agent.replies.forEach((r, i) => {
      const next = later.replies[i];
      expect(next?.t).toBe(r.t);
      expect(next?.outputTokens).toBeGreaterThanOrEqual(r.outputTokens);
    });
  });
  before.warps.forEach((warp, i) => {
    const next = after.warps[i];
    expect(next?.at).toBe(warp.at);
    if (i < before.warps.length - 1) expect(next).toEqual(warp);
    else expect(next?.skipped).toBeGreaterThanOrEqual(warp.skipped);
  });
}

/** Two reviewers in wave 0, a long idle stretch, then a test runner in wave 1. */
function growing(): ParsedSession {
  return session(
    run(
      [
        reply({ id: "msg-1", t: 0, calls: ["toolu-1", "toolu-2"] }),
        reply({ id: "msg-2", t: 70 }),
        reply({ id: "msg-3", t: 400, calls: ["toolu-3"] }),
        reply({ id: "msg-4", t: 470 }),
      ],
      [
        call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 60 }),
        call({
          id: "toolu-2",
          name: "Agent",
          kind: "agent",
          msg: "msg-1",
          t: 1,
          end: 65,
          error: true,
        }),
        call({ id: "toolu-3", name: "Agent", kind: "agent", msg: "msg-3", t: 401, end: 465 }),
      ],
    ),
    [
      sub({
        agentId: "rt-r1",
        agentType: "code-reviewer",
        parentToolUseId: "toolu-1",
        parentAgentId: "main",
        run: run(
          [
            reply({ id: "msg-r1a", t: 2, model: null, effort: null, calls: ["toolu-r1"] }),
            reply({ id: "msg-r1b", t: 59, model: "claude-opus-5-5", effort: "medium" }),
          ],
          [call({ id: "toolu-r1", name: "Read", kind: "read", msg: "msg-r1a", t: 3, end: 40 })],
        ),
      }),
      sub({
        agentId: "rt-r2",
        agentType: "code-reviewer",
        parentToolUseId: "toolu-2",
        parentAgentId: "main",
        run: run([reply({ id: "msg-r2a", t: 2.5 }), reply({ id: "msg-r2b", t: 64 })], []),
      }),
      sub({
        agentId: "rt-t1",
        agentType: "test-runner",
        parentToolUseId: "toolu-3",
        parentAgentId: "main",
        run: run(
          [reply({ id: "msg-t1", t: 402, calls: ["toolu-t1"] }), reply({ id: "msg-t2", t: 460 })],
          [
            call({
              id: "toolu-t1",
              name: "mcp__ci__run",
              kind: "mcp",
              msg: "msg-t1",
              t: 403,
              end: 450,
            }),
          ],
        ),
      }),
    ],
  );
}

describe("buildReplay live chain", () => {
  const parsed = growing();
  const steps = [0.5, 2.2, 3.5, 30, 62, 66, 200, 401.5, 402.5, 420, 455, 470];

  it("keeps every append-stability rule across snapshots and ends at the fresh build", () => {
    let previous: ReplayModel | undefined;
    for (const step of steps) {
      const next = buildReplay(
        parsed,
        previous === undefined ? { now: at(step) } : { now: at(step), previous },
      );
      expectValidReplay(next);
      if (previous !== undefined) expectAppendStable(previous, next);
      previous = next;
    }
    expect(previous).toEqual(buildReplay(parsed));
  });

  it("is deterministic along the chain", () => {
    const chain = (): string[] => {
      let previous: ReplayModel | undefined;
      return steps.map((step) => {
        previous = buildReplay(
          parsed,
          previous === undefined ? { now: at(step) } : { now: at(step), previous },
        );
        return JSON.stringify(previous);
      });
    };
    expect(chain()).toEqual(chain());
  });

  it("fills a model in from null without changing a shown one", () => {
    const early = buildReplay(parsed, { now: at(30) });
    expect(early.agents[1]).toMatchObject({
      model: null,
      family: "unknown",
      effort: null,
      end: null,
    });
    const later = buildReplay(parsed, { now: at(62), previous: early });
    expect(later.agents[1]).toMatchObject({
      model: "claude-opus-5-5",
      family: "opus",
      effort: "medium",
    });
    expect(later.agents[1]?.end).toBe(59);
  });
});

describe("buildReplay live edge cases", () => {
  it("appends a subagent found one poll late without shifting existing ids or callsigns", () => {
    const full = growing();
    const withoutFirst: ParsedSession = { ...full, subagents: full.subagents.slice(1) };
    const first = buildReplay(withoutFirst, { now: at(30) });
    expect(first.agents.map((a) => [a.id, a.callsign])).toEqual([
      ["main", "main"],
      ["a1", "code-reviewer"],
    ]);
    const second = buildReplay(full, { now: at(31), previous: first });
    expectValidReplay(second);
    expectAppendStable(first, second);
    // Both reviewers start at their shared dispatch (1 s); their content tells them apart, so
    // a1 is still the one shown first (its reply at 2.5 s), and the late one is appended.
    expect(second.agents.map((a) => [a.id, a.callsign, a.start])).toEqual([
      ["main", "main", 0],
      ["a1", "code-reviewer", 1],
      ["a2", "code-reviewer#2", 1],
    ]);
    expect(second.agents[1]?.replies.map((r) => r.t)).toEqual([2.5]);
    expect(second.agents[2]?.replies.map((r) => r.t)).toEqual([2]);
    // A fresh build numbers them by call order instead; both are valid.
    expect(buildReplay(full, { now: at(31) }).agents.map((a) => a.callsign)).toEqual([
      "main",
      "code-reviewer#1",
      "code-reviewer#2",
    ]);
  });

  it("grows the last warp while an idle stretch goes on", () => {
    const idleUntil = (end: number, extra: boolean): ParsedSession =>
      session(
        run(
          [reply({ id: "msg-1", t: 0 }), ...(extra ? [reply({ id: "msg-2", t: 300 })] : [])],
          [],
          { start: 0, end },
        ),
      );
    const first = buildReplay(idleUntil(200, false), { now: at(200) });
    expectValidReplay(first);
    // Busy 0 to 3 s, idle to 200 s: cut 4 s in, 189 s removed.
    expect(first.warps).toEqual([{ at: 7, skipped: 189 }]);
    const second = buildReplay(idleUntil(300, true), { now: at(300), previous: first });
    expectValidReplay(second);
    expectAppendStable(first, second);
    expect(second.warps).toEqual([{ at: 7, skipped: 286 }]);
    expect(second.agents[0].replies.map((r) => r.t)).toEqual([0, 14]);
  });

  it("keeps an earlier cut even when late data falls inside it", () => {
    const base = (late: boolean): ParsedSession =>
      session(
        run(
          [
            reply({ id: "msg-1", t: 0 }),
            ...(late ? [reply({ id: "msg-late", t: 100 })] : []),
            reply({ id: "msg-2", t: 300 }),
          ],
          [],
        ),
      );
    const first = buildReplay(base(false), { now: at(300) });
    expect(first.warps).toEqual([{ at: 7, skipped: 286 }]);
    const second = buildReplay(base(true), { now: at(301), previous: first });
    expectValidReplay(second);
    expect(second.warps).toEqual(first.warps);
    // The late reply sits inside the cut, so it is placed at the cut.
    expect(second.agents[0].replies.map((r) => r.t)).toEqual([0, 7, 14]);
  });

  it("makes a fresh build when previous describes another session", () => {
    const other = buildReplay(growing());
    const parsed = session(run([reply({ id: "msg-x", t: 0 }), reply({ id: "msg-y", t: 5 })], []));
    expect(buildReplay(parsed, { previous: other })).toEqual(buildReplay(parsed));
  });

  it("makes a fresh build when previous warps reach past this session", () => {
    const previous: ReplayModel = {
      ...buildReplay(session(run([reply({ id: "m", t: 0 })], []))),
      warps: [{ at: 10, skipped: 500 }],
    };
    const parsed = session(run([reply({ id: "msg-x", t: 0 }), reply({ id: "msg-y", t: 5 })], []));
    expect(buildReplay(parsed, { previous })).toEqual(buildReplay(parsed));
  });
});

describe("buildReplay live: a subagent seen before its first line", () => {
  /** One Agent call at 10 s (result at 90 s); its subagent writes lines at 20 s and 80 s. */
  const single = (): ParsedSession =>
    session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1"] }), reply({ id: "msg-2", t: 91 })],
        [call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 10, end: 90 })],
      ),
      [
        sub({
          agentId: "rt-late-1",
          agentType: "worker",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          run: run([reply({ id: "m-1", t: 20 }), reply({ id: "m-2", t: 80 })], []),
        }),
      ],
    );

  it("starts it at the dispatch and keeps that start once its first line arrives", () => {
    const parsed = single();
    const early = buildReplay(parsed, { now: at(15) });
    expectValidReplay(early);
    expect(early.agents[1]).toMatchObject({ id: "a1", start: 10, end: null, replies: [] });
    const later = buildReplay(parsed, { now: at(25), previous: early });
    expectValidReplay(later);
    expectAppendStable(early, later);
    expect(later.agents[1]?.start).toBe(10);
    expect(later.agents[1]?.replies.map((r) => r.t)).toEqual([20]);
    const done = buildReplay(parsed, { now: at(91), previous: later });
    expectAppendStable(later, done);
    expect(done).toEqual(buildReplay(parsed));
  });

  /**
   * Main idles from 0 s to 200 s (a warp), then dispatches an explorer (first block) and a
   * reviewer (second block) at 201 s. The explorer writes from 202 s, the reviewer from 220 s.
   */
  const pair = (withExplorer: boolean, inserted = false): ParsedSession => {
    const explorer = sub({
      agentId: "rt-exp-1",
      agentType: "explorer",
      parentToolUseId: "toolu-1",
      parentAgentId: "main",
      run: run(
        [reply({ id: "m-e1", t: 202, calls: ["toolu-e1"] }), reply({ id: "m-e2", t: 280 })],
        [call({ id: "toolu-e1", name: "Read", kind: "read", msg: "m-e1", t: 203, end: 250 })],
      ),
    });
    const reviewer = sub({
      agentId: "rt-rev-1",
      agentType: "code-reviewer",
      parentToolUseId: "toolu-2",
      parentAgentId: "main",
      run: run(
        [
          reply({ id: "m-r1", t: 220 }),
          // A line written out of time order, read only in a later poll.
          ...(inserted ? [reply({ id: "m-r3", t: 250 })] : []),
          reply({ id: "m-r2", t: 285 }),
        ],
        [],
      ),
    });
    return session(
      run(
        [
          reply({ id: "msg-1", t: 0 }),
          reply({ id: "msg-2", t: 200, calls: ["toolu-1", "toolu-2"] }),
          reply({ id: "msg-3", t: 300 }),
        ],
        [
          call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-2", t: 201, end: 290 }),
          call({ id: "toolu-2", name: "Agent", kind: "agent", msg: "msg-2", t: 201, end: 295 }),
        ],
      ),
      withExplorer ? [explorer, reviewer] : [reviewer],
    );
  };

  it("keeps its id, start and the existing warps when found out of order", () => {
    // The explorer's transcript is found one poll late; the reviewer has no line yet.
    const first = buildReplay(pair(false), { now: at(205) });
    expectValidReplay(first);
    expect(first.warps).toHaveLength(1);
    expect(first.agents.map((a) => [a.id, a.name, a.start])).toEqual([
      ["main", "main", 0],
      ["a1", "code-reviewer", 15],
    ]);
    const steps = [225, 260, 300];
    let previous = first;
    for (const step of steps) {
      const next = buildReplay(pair(true), { now: at(step), previous });
      expectValidReplay(next);
      expectAppendStable(previous, next);
      expect(next.warps[0]).toEqual(first.warps[0]);
      expect(next.agents.map((a) => [a.id, a.name, a.start])).toEqual([
        ["main", "main", 0],
        ["a1", "code-reviewer", 15],
        ["a2", "explorer", 15],
      ]);
      previous = next;
    }
    // A fresh build numbers by block order instead; the live chain above never fell back to it.
    expect(buildReplay(pair(true), { now: at(225) }).agents.map((a) => a.name)).toEqual([
      "main",
      "explorer",
      "code-reviewer",
    ]);
  });

  it("starts at its own first line when that comes before the parent call", () => {
    const parsed = session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1"] }), reply({ id: "msg-2", t: 40 })],
        [call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 10, end: 39 })],
      ),
      [
        sub({
          agentId: "rt-skew-1",
          agentType: "worker",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          run: run([reply({ id: "m-1", t: 8 }), reply({ id: "m-2", t: 30 })], []),
        }),
      ],
    );
    const early = buildReplay(parsed, { now: at(9) });
    expect(early.agents[1]?.start).toBe(8);
    const later = buildReplay(parsed, { now: at(12), previous: early });
    expectAppendStable(early, later);
    expect(buildReplay(parsed).agents[1]?.start).toBe(8);
  });

  it("still matches a subagent on its start when an earlier reply is inserted", () => {
    // The reviewer is a1 (found first). A later poll reads a reply that sorts between two shown
    // ones, so its replies are no longer an append of the shown ones; the match on start keeps
    // the ids instead of falling back to a fresh build (which would make the explorer a1).
    const first = buildReplay(pair(false), { now: at(205) });
    const shown = buildReplay(pair(true), { now: at(290), previous: first });
    const second = buildReplay(pair(true, true), { now: at(300), previous: shown });
    expectValidReplay(second);
    expect(second.warps).toEqual(shown.warps);
    expect(second.agents.map((a) => [a.id, a.name, a.start])).toEqual(
      shown.agents.map((a) => [a.id, a.name, a.start]),
    );
    expect(second.agents[1]?.replies).toHaveLength(3);
  });
});

describe("buildReplay live: the main agent's end (#67)", () => {
  /**
   * Main replies at 0 s and 5 s, then (in a later poll) calls a tool at 20 s that returns at
   * 30 s. Each snapshot holds only the lines written so far, as a watched transcript does.
   */
  const upTo = (seconds: number): ParsedSession => {
    const replies = [reply({ id: "msg-1", t: 0 }), reply({ id: "msg-2", t: 5 })];
    const calls: ReturnType<typeof call>[] = [];
    if (seconds >= 20) {
      replies.push(reply({ id: "msg-3", t: 20, calls: ["toolu-1"] }));
      calls.push(
        call({
          id: "toolu-1",
          name: "Bash",
          kind: "shell",
          msg: "msg-3",
          t: 20,
          end: seconds >= 30 ? 30 : null,
        }),
      );
    }
    return session(run(replies, calls));
  };

  it("switches from a number back to null when a new call opens, and back again", () => {
    const idle = buildReplay(upTo(5), { now: at(5) });
    expect(idle.agents[0].end).toBe(5);
    const busy = buildReplay(upTo(20), { now: at(20), previous: idle });
    expectValidReplay(busy);
    expectAppendStable(idle, busy);
    expect(busy.agents[0].end).toBeNull();
    const done = buildReplay(upTo(30), { now: at(30), previous: busy });
    expectValidReplay(done);
    expectAppendStable(busy, done);
    expect(done.agents[0].end).toBe(30);
    expect(done).toEqual(buildReplay(upTo(30)));
  });
});
