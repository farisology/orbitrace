// Tests for buildReplay. Every session here is built by hand from the contract types with
// invented values; no parser and no transcript is involved.
import { describe, expect, it } from "vitest";
import {
  buildReplay,
  DEFAULT_REPLY_PADDING_SECONDS,
  REPLAY_BUILD_DEFAULTS,
  REPLAY_BUILD_DEFAULTS_RESOLVED,
  type ParsedSession,
  type ReplayModel,
  type ReplaySubagent,
} from "../../src/index.js";
import { at, call, expectValidReplay, reply, run, session, sub } from "./helpers.js";

/**
 * A session with two parallel reviewers, a long idle stretch, a later wave with a test runner
 * and an unlinked explorer, an MCP call, and two failed calls. Subagents are listed out of
 * call order on purpose.
 */
function orchestra(): ParsedSession {
  const main = run(
    [
      reply({ id: "msg-m1", t: 0, calls: ["toolu-read1"], tokens: [1200, 180, 0, 9000] }),
      reply({
        id: "msg-m2",
        t: 9.5,
        calls: ["toolu-ag1", "toolu-ag2"],
        tokens: [40, 260, 9000, 300],
      }),
      reply({ id: "msg-m3", t: 69, calls: ["toolu-mcp1"], tokens: [30, 90, 9300, 200] }),
      reply({ id: "msg-m4", t: 400, calls: ["toolu-ag3"], tokens: [25, 140, 9500, 150] }),
      reply({ id: "msg-m5", t: 455, calls: ["toolu-edit1"], tokens: [20, 210, 9650, 120] }),
      reply({ id: "msg-m6", t: 460, tokens: [10, 75, 9770, 0] }),
    ],
    [
      call({ id: "toolu-read1", name: "Read", kind: "read", msg: "msg-m1", t: 1, end: 1.4 }),
      call({ id: "toolu-ag1", name: "Agent", kind: "agent", msg: "msg-m2", t: 10, end: 60 }),
      call({ id: "toolu-ag2", name: "Agent", kind: "agent", msg: "msg-m2", t: 10, end: 64 }),
      call({
        id: "toolu-mcp1",
        name: "mcp__docs__search",
        kind: "mcp",
        mcpServer: "docs",
        msg: "msg-m3",
        t: 70,
        end: 71.2,
      }),
      call({ id: "toolu-ag3", name: "Agent", kind: "agent", msg: "msg-m4", t: 401, end: 450 }),
      call({
        id: "toolu-edit1",
        name: "Edit",
        kind: "edit",
        msg: "msg-m5",
        t: 456,
        end: 456.3,
        error: true,
      }),
    ],
  );
  const beta = sub({
    agentId: "rt-beta-51c2",
    agentType: "code-reviewer",
    parentToolUseId: "toolu-ag2",
    parentAgentId: "main",
    run: run(
      [
        reply({
          id: "msg-b1",
          t: 10.4,
          calls: ["toolu-b1"],
          effort: "medium",
          tokens: [500, 60, 0, 2000],
        }),
        reply({ id: "msg-b2", t: 63, effort: "medium", tokens: [20, 300, 2000, 50] }),
      ],
      [
        call({
          id: "toolu-b1",
          name: "Bash",
          kind: "shell",
          msg: "msg-b1",
          t: 11,
          end: 20,
          error: true,
        }),
      ],
    ),
  });
  const alpha = sub({
    agentId: "rt-alpha-7f3e",
    agentType: "code-reviewer",
    parentToolUseId: "toolu-ag1",
    parentAgentId: "main",
    run: run(
      [
        reply({
          id: "msg-a1",
          t: 10.2,
          calls: ["toolu-a1"],
          effort: "medium",
          tokens: [400, 50, 0, 1800],
        }),
        reply({ id: "msg-a2", t: 59.8, effort: "medium", tokens: [15, 250, 1800, 40] }),
      ],
      [call({ id: "toolu-a1", name: "Grep", kind: "read", msg: "msg-a1", t: 11, end: 12 })],
    ),
  });
  const gamma = sub({
    agentId: "rt-gamma-0d9a",
    agentType: "test-runner",
    parentToolUseId: "toolu-ag3",
    parentAgentId: "main",
    run: run(
      [
        reply({
          id: "msg-g1",
          t: 401.5,
          model: "claude-sonnet-9-0",
          effort: "low",
          calls: ["toolu-g1"],
          tokens: [300, 40, 0, 1500],
        }),
        reply({
          id: "msg-g2",
          t: 449,
          model: "claude-sonnet-9-0",
          effort: "low",
          tokens: [10, 120, 1500, 0],
        }),
      ],
      [
        call({
          id: "toolu-g1",
          name: "mcp__tracker__list_items",
          kind: "mcp",
          mcpServer: null,
          msg: "msg-g1",
          t: 402,
          end: 403,
        }),
      ],
    ),
  });
  const explorer = sub({
    agentId: "rt-orphan-33bb",
    agentType: "explorer",
    parentToolUseId: null,
    parentAgentId: null,
    model: "claude-haiku-9-0",
    run: run(
      [
        reply({
          id: "msg-o1",
          t: 420,
          model: "claude-haiku-9-0",
          effort: null,
          tokens: [100, 10, 0, 0],
        }),
        reply({ id: "msg-o2", t: 425, model: "<synthetic>", effort: null, tokens: [0, 0, 0, 0] }),
        reply({
          id: "msg-o3",
          t: 430,
          model: "claude-haiku-9-0",
          effort: null,
          tokens: [5, 30, 100, 0],
        }),
      ],
      [],
    ),
  });
  return session(main, [beta, explorer, gamma, alpha]);
}

/** Direct count over a parsed session, independent of the builder. */
function directCount(parsed: ParsedSession) {
  const runs = [parsed.main, ...parsed.subagents];
  const replies = runs.flatMap((r) => r.replies);
  const calls = runs.flatMap((r) => r.toolCalls);
  return {
    agents: runs.length,
    toolCalls: calls.length,
    failedToolCalls: calls.filter((c) => c.isError === true).length,
    replies: replies.length,
    inputTokens: replies.reduce((a, r) => a + r.usage.inputTokens, 0),
    outputTokens: replies.reduce((a, r) => a + r.usage.outputTokens, 0),
    cacheReadTokens: replies.reduce((a, r) => a + r.usage.cacheReadTokens, 0),
    cacheCreationTokens: replies.reduce((a, r) => a + r.usage.cacheCreationTokens, 0),
  };
}

const subagentsOf = (model: ReplayModel): ReplaySubagent[] =>
  model.agents.slice(1) as ReplaySubagent[];

describe("buildReplay on a session with subagents", () => {
  const parsed = orchestra();
  const model = buildReplay(parsed);

  it("validates against the v1 schema and keeps every format rule", () => {
    expectValidReplay(model);
    expect(model.agents).toHaveLength(5);
  });

  it("numbers subagents by parent call order, unlinked ones last", () => {
    const subs = subagentsOf(model);
    expect(subs.map((a) => [a.id, a.name, a.parent])).toEqual([
      ["a1", "code-reviewer", "main"],
      ["a2", "code-reviewer", "main"],
      ["a3", "test-runner", "main"],
      ["a4", "explorer", "main"],
    ]);
    // a1 is the agent started by the first tool_use block of the reply. Both start at the
    // dispatch, the start of their parent call, not at their own first line (10.2 s, 10.4 s).
    expect(subs[0]?.start).toBe(10);
    expect(subs[1]?.start).toBe(10);
  });

  it("never lets a runtime id, tool use id, message id or session id reach the model", () => {
    const json = JSON.stringify(model);
    for (const local of [
      "rt-alpha-7f3e",
      "rt-beta-51c2",
      "rt-gamma-0d9a",
      "rt-orphan-33bb",
      "toolu-",
      "msg-",
      "synthetic-session",
      "list_items",
      "search",
    ]) {
      expect({ local, found: json.includes(local) }).toEqual({ local, found: false });
    }
  });

  it("gives callsigns with #n only to repeated agent types", () => {
    expect(model.agents.map((a) => a.callsign)).toEqual([
      "main",
      "code-reviewer#1",
      "code-reviewer#2",
      "test-runner",
      "explorer",
    ]);
  });

  it("opens a new wave only after the wave gap", () => {
    expect(subagentsOf(model).map((a) => a.wave)).toEqual([0, 0, 1, 1]);
  });

  it("cuts the long idle stretch down and records it as a warp", () => {
    // Busy until 72 s (reply at 69 s plus 3 s padding), busy again from 397 s (reply at 400 s
    // minus padding): 325 s idle, cut to 8 s, so 317 s skipped, with the cut 4 s in.
    expect(model.warps).toEqual([{ at: 76, skipped: 317 }]);
    expect(model.totals.duration).toBe(143);
    expect(model.totals.realDuration).toBe(460);
    const gamma = subagentsOf(model)[2];
    // Dispatched by the Agent call at 84 s; its own first line is at 84.5 s.
    expect(gamma?.start).toBe(84);
    expect(model.agents[0].tools.map((t) => t.start)).toEqual([1, 10, 10, 70, 84, 139]);
  });

  it("reduces MCP tool names to the server name", () => {
    const names = model.agents.flatMap((a) => a.tools.map((t) => [t.name, t.kind]));
    expect(names).toContainEqual(["mcp:docs", "mcp"]);
    expect(names).toContainEqual(["mcp:tracker", "mcp"]);
    expect(names.filter(([name]) => String(name).startsWith("mcp__"))).toEqual([]);
  });

  it("copies the kind and failure of each call", () => {
    expect(model.agents[0].tools.map((t) => [t.name, t.kind, t.failed])).toEqual([
      ["Read", "read", false],
      ["Agent", "agent", false],
      ["Agent", "agent", false],
      ["mcp:docs", "mcp", false],
      ["Agent", "agent", false],
      ["Edit", "edit", true],
    ]);
    expect(subagentsOf(model)[1]?.tools).toEqual([
      { name: "Bash", kind: "shell", start: 11, end: 20, failed: true },
    ]);
  });

  it("keeps the dominant model and effort per agent and derives the family", () => {
    expect(model.agents.map((a) => [a.callsign, a.model, a.family, a.effort])).toEqual([
      ["main", "claude-opus-5-5", "opus", "high"],
      ["code-reviewer#1", "claude-opus-5-5", "opus", "medium"],
      ["code-reviewer#2", "claude-opus-5-5", "opus", "medium"],
      ["test-runner", "claude-sonnet-9-0", "sonnet", "low"],
      ["explorer", "claude-haiku-9-0", "haiku", null],
    ]);
  });

  it("has session totals equal to a direct count of the input", () => {
    const { agents, ...counts } = directCount(parsed);
    expect(model.totals).toMatchObject({ agents, ...counts });
    expect(model.totals).toMatchObject({ toolCalls: 9, failedToolCalls: 2, replies: 15 });
  });

  it("has per-agent totals equal to a direct count of each run", () => {
    const runFor = (agentId: string) => parsed.subagents.find((s) => s.agentId === agentId);
    const runs = [
      parsed.main,
      runFor("rt-alpha-7f3e"),
      runFor("rt-beta-51c2"),
      runFor("rt-gamma-0d9a"),
      runFor("rt-orphan-33bb"),
    ];
    const expected = runs.map((r) => {
      if (r === undefined) throw new Error("missing synthetic run");
      const counted: Partial<ReturnType<typeof directCount>> = directCount(session(r));
      delete counted.agents;
      return counted;
    });
    expect(model.agents.map((a) => a.totals)).toEqual(expected);
  });

  it("closes every agent and call in a finished session", () => {
    expect(model.agents.map((a) => a.end)).toEqual([143, 59.8, 63, 132, 113]);
    expect(model.agents.flatMap((a) => a.tools).filter((t) => t.end === null)).toEqual([]);
  });

  it("is deterministic: the same input gives identical output", () => {
    const again = buildReplay(orchestra());
    expect(again).toEqual(model);
    expect(JSON.stringify(again)).toBe(JSON.stringify(model));
    const copy = JSON.parse(JSON.stringify(parsed)) as ParsedSession;
    expect(JSON.stringify(buildReplay(copy))).toBe(JSON.stringify(model));
  });

  it("does not change its input", () => {
    const input = orchestra();
    const before = JSON.stringify(input);
    buildReplay(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("buildReplay on a session with no subagents", () => {
  const parsed = session(
    run(
      [
        reply({ id: "msg-1", t: 0, calls: ["toolu-1"], tokens: [100, 50, 0, 900] }),
        reply({ id: "msg-2", t: 6, calls: ["toolu-2"], tokens: [10, 70, 900, 20] }),
        reply({ id: "msg-3", t: 12, tokens: [5, 30, 920, 0] }),
      ],
      [
        call({ id: "toolu-1", name: "Glob", kind: "read", msg: "msg-1", t: 1, end: 1.5 }),
        call({ id: "toolu-2", name: "Write", kind: "edit", msg: "msg-2", t: 7, end: 7.25 }),
      ],
    ),
  );
  const model = buildReplay(parsed);

  it("builds a valid replay with the main agent only", () => {
    expectValidReplay(model);
    expect(model.agents).toHaveLength(1);
    expect(model.warps).toEqual([]);
    expect(model.agents[0]).toMatchObject({
      id: "main",
      callsign: "main",
      parent: null,
      wave: null,
      start: 0,
      end: 12,
    });
    expect(model.totals).toEqual({
      agents: 1,
      toolCalls: 2,
      failedToolCalls: 0,
      replies: 3,
      inputTokens: 115,
      outputTokens: 150,
      cacheReadTokens: 1820,
      cacheCreationTokens: 920,
      duration: 12,
      realDuration: 12,
    });
  });
});

describe("buildReplay edge cases", () => {
  it("builds a valid empty replay from an empty session", () => {
    const model = buildReplay(session(run([], [])));
    expectValidReplay(model);
    expect(model.agents[0]).toMatchObject({
      start: 0,
      end: 0,
      model: null,
      family: "unknown",
      effort: null,
    });
    expect(model.totals.duration).toBe(0);
  });

  it("keeps a result-less call and its agents open", () => {
    const parsed = session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1"] })],
        [call({ id: "toolu-1", name: "Bash", kind: "shell", msg: "msg-1", t: 1, end: null })],
      ),
    );
    const model = buildReplay(parsed);
    expectValidReplay(model);
    expect(model.agents[0].tools[0]).toEqual({
      name: "Bash",
      kind: "shell",
      start: 1,
      end: null,
      failed: false,
    });
    expect(model.agents[0].end).toBeNull();
  });

  it("drops what starts after now and leaves what ends after now open", () => {
    const parsed = orchestra();
    const model = buildReplay(parsed, { now: at(30) });
    expectValidReplay(model);
    const subs = subagentsOf(model);
    expect(subs.map((a) => [a.id, a.end])).toEqual([
      ["a1", null],
      ["a2", null],
    ]);
    expect(model.agents[0].end).toBeNull();
    expect(model.agents[0].tools.map((t) => [t.name, t.end])).toEqual([
      ["Read", 1.4],
      ["Agent", null],
      ["Agent", null],
    ]);
    // The failing Bash call ended at 20 s, before now: its failure shows.
    expect(subs[1]?.tools[0]).toMatchObject({ end: 20, failed: true });
    expect(model.totals.replies).toBe(4);
  });

  it("does not show a failure whose result arrives after now", () => {
    const model = buildReplay(orchestra(), { now: at(15) });
    expect(subagentsOf(model)[1]?.tools[0]).toEqual({
      name: "Bash",
      kind: "shell",
      start: 11,
      end: null,
      failed: false,
    });
  });

  it("links a nested subagent to the subagent that started it", () => {
    const parsed = session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1"] }), reply({ id: "msg-2", t: 30 })],
        [call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 29 })],
      ),
      [
        sub({
          agentId: "rt-outer",
          agentType: "planner",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          run: run(
            [reply({ id: "msg-o1", t: 2, calls: ["toolu-o1"] }), reply({ id: "msg-o2", t: 28 })],
            [call({ id: "toolu-o1", name: "Task", kind: "agent", msg: "msg-o1", t: 3, end: 27 })],
          ),
        }),
        sub({
          agentId: "rt-inner",
          agentType: "planner",
          parentToolUseId: "toolu-o1",
          parentAgentId: "rt-outer",
          run: run([reply({ id: "msg-i1", t: 4 }), reply({ id: "msg-i2", t: 26 })], []),
        }),
      ],
    );
    const model = buildReplay(parsed);
    expectValidReplay(model);
    expect(subagentsOf(model).map((a) => [a.id, a.parent, a.callsign])).toEqual([
      ["a1", "main", "planner#1"],
      ["a2", "a1", "planner#2"],
    ]);
  });

  it("links a subagent through the call's spawned agent id when the meta link is missing", () => {
    const parsed = session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1", "toolu-2"] })],
        [
          call({
            id: "toolu-1",
            name: "Agent",
            kind: "agent",
            msg: "msg-1",
            t: 1,
            end: 9,
            spawned: "rt-two",
          }),
          call({
            id: "toolu-2",
            name: "Agent",
            kind: "agent",
            msg: "msg-1",
            t: 1,
            end: 9,
            spawned: "rt-one",
          }),
        ],
      ),
      [
        sub({
          agentId: "rt-one",
          agentType: null,
          parentToolUseId: null,
          parentAgentId: null,
          run: run([reply({ id: "m-1", t: 2 })], []),
        }),
        sub({
          agentId: "rt-two",
          agentType: null,
          parentToolUseId: null,
          parentAgentId: null,
          run: run([reply({ id: "m-2", t: 3 })], []),
        }),
      ],
    );
    const model = buildReplay(parsed);
    expectValidReplay(model);
    // rt-two is started by the first block, so it is a1; missing agent types become `subagent`.
    // Both start at the dispatch (1 s), not at their first lines (3 s and 2 s).
    expect(subagentsOf(model).map((a) => [a.id, a.start, a.callsign])).toEqual([
      ["a1", 1, "subagent#1"],
      ["a2", 1, "subagent#2"],
    ]);
  });

  it("reduces names and models that are not identifiers", () => {
    const parsed = session(
      run(
        [
          reply({
            id: "msg-1",
            t: 0,
            model: "<synthetic>",
            calls: ["toolu-1", "toolu-2", "toolu-3"],
          }),
        ],
        [
          call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 5 }),
          call({
            id: "toolu-2",
            name: "mcp__odd server!__do",
            kind: "mcp",
            msg: "msg-1",
            t: 1,
            end: 2,
          }),
          call({ id: "toolu-3", name: "9 weird-tool", kind: "other", msg: "msg-1", t: 1, end: 2 }),
        ],
      ),
      [
        sub({
          agentId: "rt-x",
          agentType: "my agent (v2)",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          run: run([reply({ id: "msg-x", t: 2, model: null, effort: null })], []),
        }),
      ],
    );
    const model = buildReplay(parsed);
    expectValidReplay(model);
    expect(model.agents[0]).toMatchObject({ model: null, family: "unknown" });
    expect(model.agents[0].tools.map((t) => t.name)).toEqual([
      "Agent",
      "mcp:odd-server-",
      "weird_tool",
    ]);
    expect(model.agents[1]).toMatchObject({ name: "my-agent-v2-", model: null, family: "unknown" });
  });

  it("uses the meta model when no reply names one", () => {
    const parsed = session(
      run(
        [reply({ id: "msg-1", t: 0, calls: ["toolu-1"] })],
        [call({ id: "toolu-1", name: "Agent", kind: "agent", msg: "msg-1", t: 1, end: 5 })],
      ),
      [
        sub({
          agentId: "rt-y",
          agentType: "helper",
          parentToolUseId: "toolu-1",
          parentAgentId: "main",
          model: "claude-fable-9-0",
          run: run([reply({ id: "msg-y", t: 2, model: null })], []),
        }),
      ],
    );
    expect(buildReplay(parsed).agents[1]).toMatchObject({
      model: "claude-fable-9-0",
      family: "fable",
    });
  });

  it("applies custom options", () => {
    const parsed = orchestra();
    const noCut = buildReplay(parsed, { idleGapSeconds: 1000 });
    expectValidReplay(noCut);
    expect(noCut.warps).toEqual([]);
    expect(noCut.totals.duration).toBe(460);
    expect(subagentsOf(noCut).map((a) => a.wave)).toEqual([0, 0, 1, 1]);

    const oneWave = buildReplay(parsed, { waveGapSeconds: 600 });
    expect(subagentsOf(oneWave).map((a) => a.wave)).toEqual([0, 0, 0, 0]);

    const keepMore = buildReplay(parsed, { idleKeepSeconds: 20, replyPaddingSeconds: 0 });
    expectValidReplay(keepMore);
    // Busy until 71.2 s (the MCP call) and from 400 s: 328.8 s idle, 308.8 s skipped.
    expect(keepMore.warps).toEqual([{ at: 81.2, skipped: 308.8 }]);
  });

  it("rejects invalid options", () => {
    const parsed = orchestra();
    expect(() => buildReplay(parsed, { idleGapSeconds: -1 })).toThrow(RangeError);
    expect(() => buildReplay(parsed, { waveGapSeconds: Number.NaN })).toThrow(RangeError);
    expect(() => buildReplay(parsed, { now: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("exposes its resolved defaults", () => {
    expect(REPLAY_BUILD_DEFAULTS_RESOLVED).toEqual({
      ...REPLAY_BUILD_DEFAULTS,
      replyPaddingSeconds: DEFAULT_REPLY_PADDING_SECONDS,
    });
    expect(DEFAULT_REPLY_PADDING_SECONDS).toBe(3);
  });
});
