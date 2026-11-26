import { describe, expect, it } from "vitest";
import {
  COMMON_LINE_KEYS,
  FIXTURE_CLAUDE_VERSION,
  IdFactory,
  MAIN_AGENT_ID,
  MODELS,
  SessionBuilder,
  ToolKit,
  createRng,
  type AgentWriter,
  type KnownEffortLevel,
  type FullUsage,
  type Rng,
  type SessionOptions,
  type SubagentSpec,
  type RawLine,
} from "../src/index.js";
import { parseJsonl, type JsonObject } from "./helpers.js";

const START = "2026-01-05T12:00:00.000Z";
const START_MS = Date.parse(START);
const CWD = "/workspace/pebble-pantry";

function newSession(overrides: Partial<SessionOptions> = {}): SessionBuilder {
  return new SessionBuilder({
    seed: "unit",
    project: "pebble-pantry",
    startTime: START,
    model: MODELS.sonnet,
    effort: "medium",
    ...overrides,
  });
}

function messageOf(line: RawLine | undefined): JsonObject {
  return (line as JsonObject).message as JsonObject;
}

function blockOf(line: RawLine | undefined): JsonObject {
  return (messageOf(line).content as JsonObject[])[0] as JsonObject;
}

function timeOf(line: RawLine | undefined): number {
  return Date.parse(String((line as JsonObject).timestamp));
}

function child(
  agentType: string,
  script: (agent: AgentWriter) => void,
  extra: Partial<SubagentSpec> = {},
): SubagentSpec {
  return { agentType, model: MODELS.haiku, effort: "low", script, ...extra };
}

describe("IdFactory", () => {
  const ids = new IdFactory(createRng("ids"));

  it("makes ids with the length and alphabet of real ones, marked as invented", () => {
    expect(ids.sessionId()).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    expect(ids.uuid()).toMatch(
      /^00000000-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ids.messageId()).toMatch(/^msg_01SYNTH[0-9A-Za-z]{17}$/);
    expect(ids.requestId()).toMatch(/^req_01SYNTH[0-9A-Za-z]{17}$/);
    expect(ids.toolUseId()).toMatch(/^toolu_01SYNTH[0-9A-Za-z]{17}$/);
    expect(ids.agentId()).toMatch(/^a00000[0-9a-f]{11}$/);
    expect(ids.sessionId()).toHaveLength(36);
    expect(ids.uuid()).toHaveLength(36);
    expect(ids.messageId()).toHaveLength(28);
    expect(ids.toolUseId()).toHaveLength(30);
    expect(ids.agentId()).toHaveLength(17);
  });

  it("gives the same ids for the same seed and never the same id twice", () => {
    const first = new IdFactory(createRng("same"));
    const second = new IdFactory(createRng("same"));
    const a = Array.from({ length: 3000 }, () => first.uuid());
    const b = Array.from({ length: 3000 }, () => second.uuid());
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3000);
    expect(new IdFactory(createRng("other")).uuid()).not.toBe(a[0]);
  });

  it("draws again when the generator repeats itself", () => {
    let draws = 0;
    const stuck: Rng = {
      ...createRng("stuck"),
      chars: (length) => {
        draws += 1;
        return (draws <= 2 ? "0" : "1").repeat(length);
      },
    };
    const factory = new IdFactory(stuck);
    expect(factory.agentId()).toBe("a0000000000000000");
    expect(factory.agentId()).toBe("a0000011111111111");
    expect(draws).toBe(3);
  });
});

describe("ToolKit", () => {
  const kit = (): ToolKit => new ToolKit(createRng("kit"), CWD);

  it("makes each built-in tool call with invented input", () => {
    const tools = kit();
    expect(tools.bash()).toMatchObject({
      name: "Bash",
      outcome: "ok",
      input: { command: expect.stringMatching(/^synthetic-/), description: "Synthetic command" },
    });
    expect(tools.read()).toMatchObject({ name: "Read", input: { file_path: expect.any(String) } });
    expect(Object.keys(tools.edit().input)).toEqual(["file_path", "old_string", "new_string"]);
    expect(Object.keys(tools.write().input)).toEqual(["file_path", "content"]);
    expect(tools.grep()).toMatchObject({ name: "Grep", input: { path: `${CWD}/src` } });
    expect(tools.glob()).toMatchObject({ name: "Glob", input: { pattern: "**/*.md" } });
    expect(tools.toolSearch()).toMatchObject({ name: "ToolSearch", input: { max_results: 5 } });
    expect(tools.edit().name).toBe("Edit");
    expect(tools.write().name).toBe("Write");
  });

  it("keeps every file path inside the synthetic project folder", () => {
    const tools = kit();
    for (let index = 0; index < 50; index += 1) {
      const paths = [tools.read(), tools.edit(), tools.write()].map((tool) => tool.input.file_path);
      expect(paths.every((path) => String(path).startsWith(`${CWD}/`))).toBe(true);
    }
  });

  it("names MCP tools mcp__<server>__<tool> and takes any name for custom tools", () => {
    const tools = kit();
    expect(tools.mcp("tide-almanac", "lookup_tide").name).toBe("mcp__tide-almanac__lookup_tide");
    expect(tools.mcp("paper_kites", "fold").name).toBe("mcp__paper_kites__fold");
    expect(tools.custom("SomethingNew")).toMatchObject({
      name: "SomethingNew",
      input: { note: expect.stringMatching(/^synthetic_/) },
    });
  });

  it("draws durations inside the range of each tool", () => {
    const tools = kit();
    const ranges: [() => { durationMs: number }, number, number][] = [
      [() => tools.bash(), 350, 9000],
      [() => tools.read(), 25, 220],
      [() => tools.edit(), 40, 180],
      [() => tools.write(), 40, 200],
      [() => tools.grep(), 60, 480],
      [() => tools.glob(), 30, 260],
      [() => tools.toolSearch(), 90, 420],
      [() => tools.mcp("server", "tool"), 180, 2600],
      [() => tools.custom("Tool"), 50, 600],
    ];
    for (const [make, min, max] of ranges) {
      const durations = Array.from({ length: 60 }, () => make().durationMs);
      expect(Math.min(...durations)).toBeGreaterThanOrEqual(min);
      expect(Math.max(...durations)).toBeLessThanOrEqual(max);
      expect(new Set(durations).size).toBeGreaterThan(1);
    }
  });

  it("applies overrides without shifting the values drawn afterwards", () => {
    const plain = kit();
    const overridden = kit();
    plain.read();
    expect(overridden.read({ durationMs: 5, outcome: "error" })).toMatchObject({
      durationMs: 5,
      outcome: "error",
    });
    expect(overridden.bash()).toEqual(plain.bash());
    expect(kit().bash({ outcome: "none" }).outcome).toBe("none");
  });
});

describe("AgentWriter lines", () => {
  it("conversationLine writes the common keys and chains each line to the one before", () => {
    const session = newSession({ gitBranch: "feature/synthetic", entrypoint: "claude-vscode" });
    const main = session.main;
    expect(main.leafUuid).toBeNull();
    const first = main.conversationLine("user", {
      message: { role: "user", content: "Synthetic" },
    });
    const second = main.conversationLine("system", { subtype: "note" });
    const loose = main.conversationLine("attachment", {}, false);
    const third = main.conversationLine("user", {});

    expect(main.lines).toHaveLength(4);
    for (const line of main.lines) {
      expect(Object.keys(line)).toEqual(expect.arrayContaining([...COMMON_LINE_KEYS]));
    }
    expect(main.lines[0]).toMatchObject({
      type: "user",
      uuid: first,
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: CWD,
      sessionId: session.sessionId,
      version: FIXTURE_CLAUDE_VERSION,
      gitBranch: "feature/synthetic",
      entrypoint: "claude-vscode",
      timestamp: START,
    });
    expect("agentId" in (main.lines[0] as JsonObject)).toBe(false);
    expect(main.lines.map((line) => line.parentUuid)).toEqual([null, first, second, second]);
    expect(main.lines[2]?.uuid).toBe(loose);
    expect(main.leafUuid).toBe(third);
  });

  it("housekeeping writes the type, the fields and by default only the session id", () => {
    const session = newSession();
    const main = session.main;
    main.housekeeping("mode", { mode: "default" });
    main.housekeeping("file-history-snapshot", { messageId: "m" }, { sessionId: false });
    main.housekeeping("queue-operation", { operation: "enqueue" }, { timestamp: true });
    expect(main.lines).toEqual([
      { type: "mode", mode: "default", sessionId: session.sessionId },
      { type: "file-history-snapshot", messageId: "m" },
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: session.sessionId,
        timestamp: START,
      },
    ]);
    expect(main.leafUuid).toBeNull();
  });

  it("prompt, system and attachment write their line types", () => {
    const main = newSession().main;
    const promptUuid = main.prompt();
    main.prompt("Synthetic prompt: a given one.");
    main.system("turn_duration", { durationMs: 1200 });
    main.attachment();
    expect(main.lines.map((line) => line.type)).toEqual(["user", "user", "system", "attachment"]);
    expect(main.lines[0]?.uuid).toBe(promptUuid);
    expect(messageOf(main.lines[0])).toEqual({
      role: "user",
      content: expect.stringMatching(/^Synthetic prompt: /),
    });
    expect(messageOf(main.lines[1]).content).toBe("Synthetic prompt: a given one.");
    expect(main.lines[2]).toMatchObject({
      subtype: "turn_duration",
      durationMs: 1200,
      isMeta: false,
    });
    expect(main.lines[3]).toMatchObject({ attachment: { type: "synthetic_attachment" } });
    // Each line is stamped a little after the one before.
    const times = main.lines.map(timeOf);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThan(START_MS);
  });
});

describe("AgentWriter.reply", () => {
  it("writes one line per block, all with the same message id and request id", () => {
    const main = newSession().main;
    const tool = main.tools.read();
    const handle = main.reply([{ kind: "thinking" }, { kind: "text" }, { kind: "tool", tool }]);

    expect(main.lines).toHaveLength(3);
    expect(handle.lineUuids).toEqual(main.lines.map((line) => line.uuid));
    expect(new Set(main.lines.map((line) => messageOf(line).id))).toEqual(
      new Set([handle.messageId]),
    );
    expect(new Set(main.lines.map((line) => line.requestId)).size).toBe(1);
    expect(main.lines.map((line) => blockOf(line).type)).toEqual(["thinking", "text", "tool_use"]);
    expect(main.lines.every((line) => (messageOf(line).content as unknown[]).length === 1)).toBe(
      true,
    );
    expect(messageOf(main.lines[0])).toMatchObject({
      type: "message",
      role: "assistant",
      model: MODELS.sonnet,
      stop_reason: "tool_use",
      stop_sequence: null,
    });
    expect(blockOf(main.lines[0])).toMatchObject({
      thinking: expect.stringMatching(/^Synthetic thinking: /),
      signature: "synthetic-signature",
    });
    expect(blockOf(main.lines[2])).toEqual({
      type: "tool_use",
      id: handle.calls[0]?.id,
      name: "Read",
      input: tool.input,
    });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0]).toMatchObject({
      name: "Read",
      lineUuid: main.lines[2]?.uuid,
      calledAt: timeOf(main.lines[2]),
      resolved: false,
      failed: false,
    });
  });

  it("ends the turn when no block is a tool call, and takes a given text", () => {
    const main = newSession().main;
    main.reply([{ kind: "text", text: "Synthetic reply: given." }]);
    expect(messageOf(main.lines[0]).stop_reason).toBe("end_turn");
    expect(blockOf(main.lines[0])).toEqual({ type: "text", text: "Synthetic reply: given." });
  });

  it("writes the same usage on every line unless told otherwise, and reports the merge", () => {
    const main = newSession().main;
    const plain = main.reply([{ kind: "thinking" }, { kind: "text" }]);
    expect(messageOf(main.lines[0]).usage).toEqual(messageOf(main.lines[1]).usage);
    expect(plain.usage).toEqual(messageOf(main.lines[0]).usage);
    expect(messageOf(main.lines[0]).usage).not.toBe(messageOf(main.lines[1]).usage);

    const perLine: FullUsage[] = [
      {
        input_tokens: 9,
        output_tokens: 1,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
      },
      {
        input_tokens: 2,
        output_tokens: 70,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 6,
      },
    ];
    const split = main.reply([{ kind: "text" }, { kind: "text" }], { usagePerLine: perLine });
    expect(main.lines.slice(2).map((line) => messageOf(line).usage)).toEqual(perLine);
    expect(split.usage).toEqual({
      input_tokens: 9,
      output_tokens: 70,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 6,
    });
    expect(main.facts().usage.output_tokens).toBe(plain.usage.output_tokens + 70);
  });

  it("reads back what the reply before it wrote to the cache", () => {
    const main = newSession().main;
    const first = main.say().usage;
    const second = main.say().usage;
    expect(second.cache_read_input_tokens).toBe(
      first.cache_read_input_tokens + first.cache_creation_input_tokens,
    );
    expect(second.cache_creation_input_tokens).toBe(first.output_tokens);
    expect(first.output_tokens).toBeGreaterThan(0);
  });

  it("spends more output tokens on thinking at a higher effort", () => {
    const tokens = (effort: KnownEffortLevel): number =>
      newSession({ effort }).main.reply([{ kind: "thinking" }]).usage.output_tokens;
    expect(tokens("max")).toBeGreaterThan(tokens("high"));
    expect(tokens("high")).toBeGreaterThan(tokens("low"));
  });

  it("writes the effort keys in the three ways real lines show", () => {
    const main = newSession({ effort: "xhigh" }).main;
    main.reply([{ kind: "text" }]);
    main.reply([{ kind: "text" }], { effortKeys: "nullPerTurn" });
    main.reply([{ kind: "text" }], { effortKeys: "none" });
    expect(main.lines[0]).toMatchObject({ effort: "xhigh", perTurnEffort: "xhigh" });
    expect(main.lines[1]).toMatchObject({ effort: "xhigh", perTurnEffort: null });
    expect("effort" in (main.lines[2] as JsonObject)).toBe(false);
    expect("perTurnEffort" in (main.lines[2] as JsonObject)).toBe(false);
  });

  it("writes a raw block as given, and repeats an earlier block on a new line", () => {
    const main = newSession().main;
    const handle = main.reply([
      { kind: "raw", block: { type: "synthetic_future_block", data: 1 } },
      { kind: "tool", tool: main.tools.grep() },
      { kind: "repeat", of: 1 },
    ]);
    expect(blockOf(main.lines[0])).toEqual({ type: "synthetic_future_block", data: 1 });
    expect(blockOf(main.lines[2])).toEqual(blockOf(main.lines[1]));
    expect(main.lines[2]?.uuid).not.toBe(main.lines[1]?.uuid);
    // The repeated block is the same call, not a second one.
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0]?.lineUuid).toBe(main.lines[1]?.uuid);
    expect(main.facts().toolCalls).toBe(1);
  });

  it("rejects an empty reply, a usage list of the wrong length and a bad repeat", () => {
    const main = newSession().main;
    expect(() => main.reply([])).toThrow("at least one block");
    expect(() => main.reply([{ kind: "text" }], { usagePerLine: [] })).toThrow("one usage object");
    expect(() => main.reply([{ kind: "repeat", of: 3 }])).toThrow("no earlier block at 3");
  });

  it("can write each tool result between the lines of the reply", () => {
    const main = newSession().main;
    const handle = main.reply(
      [
        { kind: "text" },
        { kind: "tool", tool: main.tools.read() },
        { kind: "tool", tool: main.tools.edit() },
      ],
      { interleaveResults: true },
    );
    expect(main.lines.map((line) => line.type)).toEqual([
      "assistant",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(blockOf(main.lines[2]).tool_use_id).toBe(handle.calls[0]?.id);
    expect(blockOf(main.lines[4]).tool_use_id).toBe(handle.calls[1]?.id);
    expect(handle.calls.every((call) => call.resolved)).toBe(true);
    expect(messageOf(main.lines[3]).id).toBe(handle.messageId);
  });
});

describe("AgentWriter results", () => {
  it("writes results in the order the calls finish, each stamped at its finish time", () => {
    const main = newSession().main;
    const slow = main.tools.bash({ durationMs: 60_000 });
    const quick = main.tools.read({ durationMs: 10_000 });
    const handle = main.reply([
      { kind: "tool", tool: slow },
      { kind: "tool", tool: quick },
    ]);
    main.results(handle.calls);

    const [slowCall, quickCall] = handle.calls;
    expect(main.lines.map((line) => line.type)).toEqual(["assistant", "assistant", "user", "user"]);
    expect(blockOf(main.lines[2]).tool_use_id).toBe(quickCall?.id);
    expect(blockOf(main.lines[3]).tool_use_id).toBe(slowCall?.id);
    expect(timeOf(main.lines[2])).toBe((quickCall?.calledAt ?? 0) + 10_000);
    expect(timeOf(main.lines[3])).toBe((slowCall?.calledAt ?? 0) + 60_000);
    expect(main.lines[2]?.sourceToolAssistantUUID).toBe(quickCall?.lineUuid);
    expect(main.lines[3]?.parentUuid).toBe(main.lines[2]?.uuid);
  });

  it("never stamps a result at or before the line above it", () => {
    const main = newSession().main;
    const handle = main.reply([
      { kind: "tool", tool: main.tools.read({ durationMs: 1 }) },
      { kind: "tool", tool: main.tools.read({ durationMs: 1 }) },
    ]);
    main.results(handle.calls);
    const times = main.lines.map(timeOf);
    expect(times[2]).toBe((times[1] as number) + 1);
    expect(times[3]).toBe((times[2] as number) + 1);
  });

  it("marks a failed call, and writes nothing for a call with no outcome", () => {
    const main = newSession().main;
    const handle = main.reply([
      { kind: "tool", tool: main.tools.bash({ outcome: "error" }) },
      { kind: "tool", tool: main.tools.bash({ outcome: "none" }) },
      { kind: "tool", tool: main.tools.mcp("tide-almanac", "lookup_tide") },
    ]);
    main.results(handle.calls);
    // A second call writes nothing more: every due result is already there.
    main.results(handle.calls);

    const results = main.lines.filter((line) => line.type === "user");
    expect(results).toHaveLength(2);
    const failed = results.find((line) => blockOf(line).tool_use_id === handle.calls[0]?.id);
    const mcp = results.find((line) => blockOf(line).tool_use_id === handle.calls[2]?.id);
    expect(blockOf(failed)).toMatchObject({
      type: "tool_result",
      is_error: true,
      content: expect.stringMatching(/^Synthetic error: /),
    });
    expect(failed?.toolUseResult).toBe("Synthetic error result");
    // An MCP result holds a list of blocks.
    expect(blockOf(mcp).content).toEqual([
      { type: "text", text: expect.stringMatching(/^Synthetic result: /) },
    ]);
    expect(mcp?.toolUseResult).toEqual(blockOf(mcp).content);
    expect(handle.calls.map((call) => [call.resolved, call.failed])).toEqual([
      [true, true],
      [false, false],
      [true, false],
    ]);
    expect(main.facts()).toMatchObject({
      toolCalls: 3,
      failedToolCalls: 1,
      unfinishedToolCalls: 1,
      mcpToolCalls: 1,
    });
  });

  it("alternates the forms a successful result takes, whatever the seed", () => {
    const main = newSession().main;
    for (let index = 0; index < 6; index += 1) main.use(main.tools.read());
    const results = main.lines.filter((line) => line.type === "user");
    expect(results.map((line) => blockOf(line).is_error)).toEqual([
      false,
      undefined,
      false,
      undefined,
      false,
      undefined,
    ]);
    expect(results.map((line) => "toolUseResult" in line)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(results[0]?.toolUseResult).toEqual({ synthetic: true });
  });

  it("use() writes one reply with the calls and then their results", () => {
    const main = newSession().main;
    const single = main.use(main.tools.glob());
    const many = main.use([main.tools.read(), main.tools.grep()], { thinking: true, text: true });
    expect(single.calls).toHaveLength(1);
    expect(many.calls.map((call) => call.name)).toEqual(["Read", "Grep"]);
    expect(main.lines.map((line) => line.type)).toEqual([
      "assistant",
      "user",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "user",
      "user",
    ]);
    expect(main.lines.slice(2, 6).map((line) => blockOf(line).type)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_use",
    ]);
    expect(main.toolNames()).toEqual(["Glob", "Grep", "Read"]);
    expect([...single.calls, ...many.calls].every((call) => call.resolved)).toBe(true);
  });

  it("say() writes a text reply, with thinking first when asked", () => {
    const main = newSession().main;
    main.say();
    main.say({ thinking: true, text: "Synthetic reply: done." });
    expect(main.lines.map((line) => blockOf(line).type)).toEqual(["text", "thinking", "text"]);
    expect(blockOf(main.lines[2]).text).toBe("Synthetic reply: done.");
    expect(main.facts().replies).toBe(2);
  });
});

describe("AgentWriter clock", () => {
  it("advance() moves the clock forward and refuses to move it back", () => {
    const main = newSession().main;
    expect(main.now).toBe(START_MS);
    expect(main.advance(5000)).toBe(main);
    expect(main.now).toBe(START_MS + 5000);
    expect(() => main.advance(-1)).toThrow(RangeError);
  });

  it("pauseFor() stamps the next line exactly that long after the last one", () => {
    const main = newSession().main;
    main.prompt();
    main.pauseFor(40);
    main.prompt();
    main.pauseFor(0.25);
    main.say({ thinking: true });
    const times = main.lines.map(timeOf);
    expect((times[1] as number) - (times[0] as number)).toBe(40_000);
    expect((times[2] as number) - (times[1] as number)).toBe(250);
    // Only the first line after the pause is exact. Later lines pause as usual.
    expect((times[3] as number) - (times[2] as number)).toBeGreaterThanOrEqual(600);
    for (const bad of [0, -3, Number.NaN]) {
      expect(() => main.pauseFor(bad)).toThrow(RangeError);
    }
  });

  it("idle() is an exact pause that is recorded, and only the main agent may idle", () => {
    const session = newSession();
    const main = session.main;
    main.prompt();
    main.say();
    main.idle(600);
    main.prompt();
    const times = main.lines.map(timeOf);
    expect((times[2] as number) - (times[1] as number)).toBe(600_000);
    expect(session.build().expected.scriptedIdleGaps).toEqual([{ seconds: 600 }]);
    expect(() => main.idle(0)).toThrow(RangeError);

    let caught: unknown;
    main.spawn([
      child("Explore", (agent) => {
        try {
          agent.idle(60);
        } catch (error) {
          caught = error;
        }
        agent.say();
      }),
    ]);
    expect(caught).toEqual(new Error("only the main agent can idle"));
  });

  it("gives the same lines whether or not a pause was skipped before them", () => {
    // Skipping a pause must not shift the random values that follow it.
    const plain = newSession().main;
    const paused = newSession().main;
    plain.prompt();
    plain.prompt();
    paused.prompt();
    paused.pauseFor(90);
    paused.prompt();
    expect(messageOf(paused.lines[1]).content).toBe(messageOf(plain.lines[1]).content);
  });
});

describe("AgentWriter.spawn", () => {
  it("writes one Agent call per child and gives each child its own transcript", () => {
    const session = newSession();
    const main = session.main;
    main.prompt();
    const writers = main.spawn(
      [
        child("Explore", (agent) => {
          agent.use(agent.tools.read());
          agent.say();
        }),
        child("code-reviewer", (agent) => agent.say(), { model: MODELS.opus, effort: "max" }),
      ],
      { thinking: true, text: true },
    );

    expect(writers).toHaveLength(2);
    const calls = main.lines.filter(
      (line) => line.type === "assistant" && blockOf(line).type === "tool_use",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((line) => blockOf(line).name)).toEqual(["Agent", "Agent"]);
    expect(blockOf(calls[0]).input).toEqual({
      description: expect.stringMatching(/^Synthetic task: /),
      prompt: expect.stringMatching(/^Synthetic prompt: /),
      subagent_type: "Explore",
    });
    expect(main.lines.slice(1, 3).map((line) => blockOf(line).type)).toEqual(["thinking", "text"]);

    const [explorer, reviewer] = writers as [AgentWriter, AgentWriter];
    expect(explorer.id).toMatch(/^a00000[0-9a-f]{11}$/);
    expect(explorer.agentId).toBe(explorer.id);
    expect(main.agentId).toBeNull();
    expect(main.id).toBe(MAIN_AGENT_ID);
    expect(explorer.spawnDepth).toBe(1);
    expect(reviewer).toMatchObject({ model: MODELS.opus, effort: "max" });

    // The child's first line is the prompt of its Agent call, stamped after the call.
    const firstInput = blockOf(calls[0]).input as JsonObject;
    expect(messageOf(explorer.lines[0]).content).toBe(firstInput.prompt);
    expect(explorer.lines[0]).toMatchObject({
      type: "user",
      parentUuid: null,
      isSidechain: true,
      agentId: explorer.id,
      sessionId: session.sessionId,
    });
    expect(timeOf(explorer.lines[0])).toBeGreaterThan(timeOf(calls[0]));
    expect(explorer.lines.every((line) => line.isSidechain === true)).toBe(true);
    expect(messageOf(reviewer.lines[1]).model).toBe(MODELS.opus);
    expect(reviewer.lines[1]?.effort).toBe("max");
  });

  it("hands back in the order the children finish, after each child's last line", () => {
    const main = newSession().main;
    const [slow, quick] = main.spawn([
      child("Explore", (agent) => {
        agent.use(agent.tools.bash({ durationMs: 120_000 }));
        agent.say();
      }),
      child("Plan", (agent) => agent.say()),
    ]) as [AgentWriter, AgentWriter];

    const results = main.lines.filter((line) => line.type === "user");
    const callIds = main.lines
      .filter((line) => line.type === "assistant")
      .map((line) => blockOf(line).id);
    expect(results.map((line) => blockOf(line).tool_use_id)).toEqual([callIds[1], callIds[0]]);
    expect(timeOf(results[0])).toBeGreaterThan(timeOf(quick.lines.at(-1)));
    expect(timeOf(results[1])).toBeGreaterThan(timeOf(slow.lines.at(-1)));
    expect(blockOf(results[0]).content).toEqual([
      { type: "text", text: expect.stringMatching(/^Synthetic handback: /) },
    ]);
    // The parent's clock has moved past the slowest child.
    expect(main.now).toBeGreaterThan(slow.now);
    expect(main.toolNames()).toEqual(["Agent"]);
  });

  it("leaves an unfinished child without a result", () => {
    const session = newSession();
    const main = session.main;
    main.spawn([
      child("Explore", (agent) => agent.say()),
      child("Explore", (agent) => agent.use(agent.tools.bash({ outcome: "none" })), {
        finished: false,
      }),
    ]);
    const built = session.build();
    expect(main.lines.filter((line) => line.type === "user")).toHaveLength(1);
    expect(built.expected.agents.map((agent) => agent.finished)).toEqual([true, true, false]);
    expect(built.expected.agents[0]?.unfinishedToolCalls).toBe(1);
    const metas = built.files
      .filter((file) => file.path.endsWith(".meta.json"))
      .map((file) => JSON.parse(file.content) as JsonObject);
    expect(metas.map((meta) => meta.finished)).toEqual([true, false]);
  });

  it("writes the meta file keys, with the optional ones left out on request", () => {
    const session = newSession();
    const done = (agent: AgentWriter): void => {
      agent.say();
    };
    session.main.spawn([
      child("general-purpose", done),
      child("kite-rigger", done),
      child("kite-rigger", done, { isBuiltIn: true, modelInMeta: false }),
      child("Plan", done, { statusInMeta: false }),
    ]);
    const built = session.build();
    const metas = built.files
      .filter((file) => file.path.endsWith(".meta.json"))
      .map((file) => JSON.parse(file.content) as JsonObject);
    const callIds = session.main.lines
      .filter((line) => line.type === "assistant")
      .map((line) => blockOf(line).id);
    const descriptions = session.main.lines
      .filter((line) => line.type === "assistant")
      .map((line) => (blockOf(line).input as JsonObject).description);

    expect(metas[0]).toEqual({
      agentType: "general-purpose",
      model: MODELS.haiku,
      toolUseId: callIds[0],
      spawnDepth: 1,
      description: descriptions[0],
      isBuiltIn: true,
      finished: true,
    });
    expect(metas[1]).toMatchObject({ agentType: "kite-rigger", isBuiltIn: false });
    expect(metas[2]).toMatchObject({ isBuiltIn: true });
    expect("model" in (metas[2] as JsonObject)).toBe(false);
    expect(Object.keys(metas[3] as JsonObject)).toEqual([
      "agentType",
      "model",
      "toolUseId",
      "spawnDepth",
      "description",
    ]);
    // The same objects are on the built session, in spawn order.
    expect(built.subagents.map((subagent) => subagent.meta)).toEqual(metas);
    // A meta file is indented JSON with a newline at the end.
    const metaFile = built.files.find((file) => file.path.endsWith(".meta.json"));
    expect(metaFile?.content).toBe(`${JSON.stringify(metas[0], null, 2)}\n`);
  });

  it("counts a wave per spawn unless the spawn joins the running wave", () => {
    const session = newSession();
    const done = (agent: AgentWriter): void => {
      agent.say();
    };
    session.main.spawn([child("Explore", done)]);
    session.main.spawn([child("Explore", done)], { newWave: false });
    session.main.spawn([child("Explore", done)]);
    expect(session.build().expected.scriptedWaves).toBe(2);
    expect(() => session.main.spawn([])).toThrow("at least one child");
  });

  it("lets a child spawn its own children, one level deeper", () => {
    const session = newSession();
    let grandchild: AgentWriter | undefined;
    const [middle] = session.main.spawn([
      child("lantern-foreman", (agent) => {
        [grandchild] = agent.spawn([child("Explore", (inner) => inner.say())], { newWave: false });
        agent.say();
      }),
    ]) as [AgentWriter];
    const facts = session.build().expected.agents;
    expect(facts.map((agent) => agent.spawnDepth)).toEqual([0, 1, 2]);
    expect(facts.map((agent) => agent.parent)).toEqual([null, MAIN_AGENT_ID, middle.id]);
    expect(grandchild?.spawnDepth).toBe(2);
    expect(middle.toolNames()).toEqual(["Agent"]);
  });

  it("draws each child's values from its own stream", () => {
    // More work in the first child must not change what the second child reads.
    const secondChildInput = (extraWork: boolean): unknown => {
      const main = newSession().main;
      const [, second] = main.spawn([
        child("Explore", (agent) => {
          if (extraWork) agent.use([agent.tools.read(), agent.tools.grep()]);
          agent.say();
        }),
        child("Explore", (agent) => {
          agent.use(agent.tools.read());
          agent.say();
        }),
      ]) as [AgentWriter, AgentWriter];
      return blockOf(second.lines[1]).input;
    };
    expect(secondChildInput(true)).toEqual(secondChildInput(false));
  });
});

describe("AgentWriter.facts", () => {
  it("counts lines, replies, calls and usage, and reports the first and last timestamp", () => {
    const main = newSession().main;
    main.housekeeping("mode", { mode: "default" });
    main.prompt();
    const first = main.use([main.tools.read(), main.tools.bash({ outcome: "error" })]);
    const second = main.say({ thinking: true });
    const facts = main.facts();
    expect(facts).toMatchObject({
      id: MAIN_AGENT_ID,
      parent: null,
      agentType: null,
      spawnDepth: 0,
      model: MODELS.sonnet,
      effort: "medium",
      finished: true,
      lines: 8,
      lineTypes: { assistant: 4, mode: 1, user: 3 },
      replies: 2,
      toolCalls: 2,
      failedToolCalls: 1,
      unfinishedToolCalls: 0,
      mcpToolCalls: 0,
    });
    expect(Object.keys(facts.lineTypes)).toEqual(["assistant", "mode", "user"]);
    expect(facts.usage.output_tokens).toBe(first.usage.output_tokens + second.usage.output_tokens);
    expect(facts.firstTimestamp).toBe(main.lines[1]?.timestamp);
    expect(facts.lastTimestamp).toBe(main.lines.at(-1)?.timestamp);
  });

  it("reports empty timestamps for a transcript with no stamped line", () => {
    const facts = newSession().main.facts();
    expect(facts).toMatchObject({ lines: 0, replies: 0, firstTimestamp: "", lastTimestamp: "" });
  });
});

describe("SessionBuilder", () => {
  it("derives the working directory and the project folder from the project name", () => {
    const session = newSession();
    expect(session.cwd).toBe(CWD);
    expect(session.projectDir).toBe("-workspace-pebble-pantry");
    expect(session.sessionId).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    expect(session).toMatchObject({
      gitBranch: "main",
      entrypoint: "cli",
      version: FIXTURE_CLAUDE_VERSION,
    });
    expect(newSession({ version: "2.1.250" }).version).toBe("2.1.250");
  });

  it("writes a version inside the range the format notes cover", () => {
    const [major, minor, patch] = FIXTURE_CLAUDE_VERSION.split(".").map(Number);
    expect([major, minor]).toEqual([2, 1]);
    expect(patch).toBeGreaterThanOrEqual(234);
    expect(patch).toBeLessThanOrEqual(332);
  });

  it("rejects a project name that could leave the synthetic folder, and a bad start time", () => {
    for (const project of ["", "Pebble", "pebble pantry", "../pebble", "pebble/pantry", "9lives"]) {
      expect(() => newSession({ project })).toThrow("project must be a lowercase name");
    }
    expect(() => newSession({ startTime: "yesterday" })).toThrow("startTime must be an ISO 8601");
  });

  it("open() and close() write the bookkeeping lines around the conversation", () => {
    const session = newSession();
    session.open();
    session.main.prompt();
    session.main.use(session.main.tools.bash());
    session.main.say();
    session.close();
    const lines = session.main.lines;
    expect(lines.slice(0, 2)).toEqual([
      { type: "mode", mode: "default", sessionId: session.sessionId },
      {
        type: "file-history-snapshot",
        messageId: expect.stringMatching(/^00000000-/),
        snapshot: {
          messageId: lines[1]?.messageId,
          trackedFileBackups: {},
          timestamp: START,
        },
        isSnapshotUpdate: false,
      },
    ]);
    expect(lines.slice(-3)).toEqual([
      {
        type: "ai-title",
        aiTitle: expect.stringMatching(/^Synthetic session: /),
        sessionId: session.sessionId,
      },
      { type: "tools-used", tools: ["Bash"], sessionId: session.sessionId },
      {
        type: "last-prompt",
        lastPrompt: expect.stringMatching(/^Synthetic prompt: /),
        leafUuid: session.main.leafUuid,
        sessionId: session.sessionId,
      },
    ]);
    expect(session.main.leafUuid).toBe(lines.at(-4)?.uuid);
  });

  it("build() renders the transcript, then a transcript and a meta file per subagent", () => {
    const session = newSession();
    session.main.prompt();
    const [sub] = session.main.spawn([child("Explore", (agent) => agent.say())]) as [AgentWriter];
    session.main.say();
    const built = session.build();
    const folder = `projects/-workspace-pebble-pantry/${session.sessionId}`;

    expect(built).toMatchObject({
      sessionId: session.sessionId,
      cwd: CWD,
      projectDir: "-workspace-pebble-pantry",
      transcriptPath: `${folder}.jsonl`,
      subagents: [
        {
          agentId: sub.id,
          agentType: "Explore",
          transcriptPath: `${folder}/subagents/agent-${sub.id}.jsonl`,
          metaPath: `${folder}/subagents/agent-${sub.id}.meta.json`,
        },
      ],
    });
    expect(built.files.map((file) => file.path)).toEqual([
      `${folder}.jsonl`,
      `${folder}/subagents/agent-${sub.id}.jsonl`,
      `${folder}/subagents/agent-${sub.id}.meta.json`,
    ]);
    expect(parseJsonl(built.files[0]?.content ?? "")).toEqual(session.main.lines);
    expect(parseJsonl(built.files[1]?.content ?? "")).toEqual(sub.lines);
    expect(built.expected.agents.map((agent) => agent.id)).toEqual([MAIN_AGENT_ID, sub.id]);
    expect(built.expected.totals).toMatchObject({
      lines: session.main.lines.length + sub.lines.length,
      replies: 3,
      toolCalls: 1,
      failedToolCalls: 0,
      unfinishedToolCalls: 0,
      mcpToolCalls: 0,
    });
    expect(built.expected.totals.usage.output_tokens).toBe(
      (built.expected.agents[0]?.usage.output_tokens ?? 0) +
        (built.expected.agents[1]?.usage.output_tokens ?? 0),
    );
  });

  it("counts invented line types only when they were declared", () => {
    const script = (session: SessionBuilder): SessionBuilder => {
      session.main.housekeeping("synthetic-b");
      session.main.housekeeping("synthetic-a");
      session.main.housekeeping("synthetic-b");
      session.main.housekeeping("mode");
      session.main.spawn([
        child("Explore", (agent) => {
          agent.housekeeping("synthetic-a");
          agent.say();
        }),
      ]);
      return session;
    };
    const declared = script(newSession({ inventedLineTypes: ["synthetic-a", "synthetic-b"] }));
    const facts = declared.build().expected;
    expect(facts.inventedLineTypes).toEqual({ "synthetic-a": 2, "synthetic-b": 2 });
    expect(Object.keys(facts.inventedLineTypes)).toEqual(["synthetic-a", "synthetic-b"]);
    expect(script(newSession()).build().expected.inventedLineTypes).toEqual({});
  });

  it("gives the same bytes for the same seed and other ids for another seed", () => {
    const run = (seed: string): string => {
      const session = newSession({ seed });
      session.open();
      session.main.prompt();
      session.main.spawn([child("Explore", (agent) => agent.use(agent.tools.grep()))]);
      session.main.say();
      session.close();
      return JSON.stringify(session.build());
    };
    expect(run("one")).toBe(run("one"));
    expect(run("one")).not.toBe(run("two"));
  });
});
