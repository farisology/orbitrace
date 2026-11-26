/**
 * What each scenario promises a reader. These hold for any seed, so each scenario is checked
 * with the seed of the committed fixtures and with two others.
 */
import { REPLAY_BUILD_DEFAULTS } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED,
  DEMO_SCENARIO,
  KNOWN_EFFORT_LEVELS,
  IDLE_GAP_LONG_COMMAND_SECONDS,
  IDLE_GAP_SECONDS,
  IDLE_GAP_SHORT_PAUSE_SECONDS,
  INVENTED_BLOCK_TYPE,
  INVENTED_LINE_TYPES,
  INVENTED_TOOL_NAME,
  MODELS,
  SCENARIOS,
  SCENARIO_NAMES,
  SPLIT_REPLY_LINE_USAGE,
  SPLIT_REPLY_MERGED_USAGE,
  USAGE_KEYS,
  addUsage,
  generateSession,
  maxUsage,
  zeroUsage,
  type GeneratedSession,
  type FullUsage,
  type ScenarioName,
} from "../src/index.js";
import {
  IDLE_GAP_MS,
  allTranscripts,
  contentBlocks,
  gapsMs,
  idleGaps,
  linesOfType,
  readSession,
  subagentStartTimes,
  summarise,
  toolResultBlocks,
  toolUseBlocks,
  waveSizes,
  type JsonObject,
  type SessionTranscripts,
} from "./helpers.js";

const SEEDS = [DEFAULT_SEED, "second-seed", "3"];

interface Loaded {
  session: GeneratedSession;
  transcripts: SessionTranscripts;
}

function load(name: ScenarioName, seed: string): Loaded {
  const session = generateSession(name, { seed });
  return { session, transcripts: readSession(session) };
}

function message(line: JsonObject): JsonObject {
  return line.message as JsonObject;
}

/** The index of every assistant line per message id, in file order. */
function lineIndexesByMessage(lines: readonly JsonObject[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.type !== "assistant") return;
    const id = String(message(line).id);
    found.set(id, [...(found.get(id) ?? []), index]);
  });
  return found;
}

function family(model: string): string {
  return model.split("-")[1] ?? "";
}

describe("the scenario list", () => {
  it("has one definition per name, each with a description and a fixed start time", () => {
    expect(Object.keys(SCENARIOS)).toEqual([...SCENARIO_NAMES]);
    expect(new Set(SCENARIO_NAMES).size).toBe(SCENARIO_NAMES.length);
    for (const name of SCENARIO_NAMES) {
      const scenario = SCENARIOS[name];
      expect(scenario.name).toBe(name);
      expect(scenario.description.length).toBeGreaterThan(20);
      expect(scenario.project).toMatch(/^[a-z]+-[a-z]+$/);
      expect(new Date(scenario.startTime).toISOString()).toBe(scenario.startTime);
      expect(KNOWN_EFFORT_LEVELS).toContain(scenario.effort);
      expect(scenario.model).toMatch(/^claude-[a-z]+-\d/);
    }
  });

  it("covers the scenarios the ticket asks for, and names the demo", () => {
    expect(SCENARIO_NAMES).toEqual(
      expect.arrayContaining([
        "single-agent",
        "two-waves",
        "tool-failures",
        "idle-gap",
        "unknown-lines",
        "split-reply",
        "mcp-tools",
        "demo",
      ]),
    );
    expect(DEMO_SCENARIO).toBe("demo");
  });

  it("gives every session its own start time and its own session id", () => {
    const starts = SCENARIO_NAMES.map((name) => SCENARIOS[name].startTime);
    expect(new Set(starts).size).toBe(starts.length);
    const ids = SCENARIO_NAMES.map((name) => generateSession(name).sessionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(SEEDS)("scenarios with seed '%s'", (seed) => {
  it("single-agent: one transcript, two prompts, and no reply split over lines", () => {
    const { session, transcripts } = load("single-agent", seed);
    const main = transcripts.main;
    expect(session.subagents).toEqual([]);
    expect(session.files).toHaveLength(1);
    expect(session.expected.scriptedWaves).toBe(0);

    const prompts = linesOfType(main, "user").filter(
      (line) => typeof message(line).content === "string",
    );
    expect(prompts).toHaveLength(2);
    expect([...summarise(main).linesByMessage.values()].every((count) => count === 1)).toBe(true);
    expect(session.expected.totals).toMatchObject({
      replies: 8,
      toolCalls: 6,
      failedToolCalls: 0,
      unfinishedToolCalls: 0,
    });
    expect(Object.keys(session.expected.agents[0]?.lineTypes ?? {})).toEqual([
      "ai-title",
      "assistant",
      "attachment",
      "file-history-snapshot",
      "last-prompt",
      "mode",
      "system",
      "tools-used",
      "user",
    ]);
    // Bookkeeping lines open and close the file, and carry no uuid.
    expect(main.slice(0, 2).map((line) => line.type)).toEqual(["mode", "file-history-snapshot"]);
    expect(main.slice(-3).map((line) => line.type)).toEqual([
      "ai-title",
      "tools-used",
      "last-prompt",
    ]);
    expect((main.at(-2) as JsonObject).tools).toEqual(["Bash", "Edit", "Grep", "Read", "Write"]);
    expect("sessionId" in (main[1] as JsonObject)).toBe(false);
  });

  it("two-waves: three subagents together, then two more over a minute later", () => {
    const { session, transcripts } = load("two-waves", seed);
    expect(session.subagents.map((subagent) => subagent.agentType)).toEqual([
      "Explore",
      "Explore",
      "Plan",
      "code-reviewer",
      "test-writer",
    ]);
    expect(waveSizes(subagentStartTimes(transcripts))).toEqual([3, 2]);
    expect(session.expected.scriptedWaves).toBe(2);
    expect([...transcripts.metas.values()].map((meta) => meta.isBuiltIn)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect([...transcripts.metas.values()].every((meta) => meta.finished === true)).toBe(true);
    expect(session.expected.agents.map((agent) => agent.model)).toEqual([
      MODELS.sonnet,
      MODELS.haiku,
      MODELS.haiku,
      MODELS.opus,
      MODELS.opus,
      MODELS.sonnet,
    ]);
    // The main agent waits for each wave: its Agent results come after the subagents end.
    const agentCalls = [...toolUseBlocks(transcripts.main).values()].filter(
      (call) => call.name === "Agent",
    );
    expect(agentCalls).toHaveLength(5);
    expect(new Set(transcripts.main.map((line) => line.gitBranch).filter(Boolean))).toEqual(
      new Set(["feature/synthetic-kites"]),
    );
  });

  it("tool-failures: failed calls, calls with no result and a subagent that never ends", () => {
    const { session, transcripts } = load("tool-failures", seed);
    const [main, runner, cutOff] = session.expected.agents;
    expect(main).toMatchObject({ failedToolCalls: 4, unfinishedToolCalls: 2, finished: true });
    expect(runner).toMatchObject({ failedToolCalls: 2, unfinishedToolCalls: 0, finished: true });
    expect(cutOff).toMatchObject({ failedToolCalls: 0, unfinishedToolCalls: 1, finished: false });
    expect(session.expected.totals).toMatchObject({ failedToolCalls: 6, unfinishedToolCalls: 3 });

    const metas = [...transcripts.metas.values()];
    expect(metas.map((meta) => meta.finished)).toEqual([true, false]);

    // A failure is a result with is_error true. A success has false, or no key at all.
    const results = allTranscripts(transcripts).flatMap(([, lines]) => toolResultBlocks(lines));
    const flags = results.map((result) => result.block.is_error);
    expect(flags.filter((flag) => flag === true)).toHaveLength(6);
    expect(new Set(flags.filter((flag) => flag !== true))).toEqual(new Set([false, undefined]));
    const failed = results.filter((result) => result.block.is_error === true);
    expect(failed.every((result) => typeof result.line.toolUseResult === "string")).toBe(true);

    // The Agent call of the cut-off subagent and the last shell call never get a result.
    const answered = new Set(toolResultBlocks(transcripts.main).map((result) => result.toolUseId));
    const open = [...toolUseBlocks(transcripts.main).values()].filter(
      (call) => !answered.has(call.id),
    );
    expect(open.map((call) => call.name)).toEqual(["Agent", "Bash"]);
    expect(open[0]?.id).toBe(metas[1]?.toolUseId);
    // A failed MCP call is among the failures.
    expect(main?.mcpToolCalls).toBe(1);
  });

  it("idle-gap: two idle gaps of a known length, and busy time that is not a gap", () => {
    const { session, transcripts } = load("idle-gap", seed);
    const main = transcripts.main;
    expect(session.expected.scriptedIdleGaps).toEqual(
      IDLE_GAP_SECONDS.map((seconds) => ({ seconds })),
    );
    expect(idleGaps(main)).toEqual([...IDLE_GAP_SECONDS]);

    const gaps = gapsMs(main);
    const long = gaps.filter((gap) => gap > IDLE_GAP_MS);
    // Three gaps are over the idle threshold: the two idle gaps, and the wait for a long command.
    expect(long).toEqual([
      IDLE_GAP_LONG_COMMAND_SECONDS * 1000,
      IDLE_GAP_SECONDS[0] * 1000,
      IDLE_GAP_SECONDS[1] * 1000,
    ]);
    // The short pause is exact, and under the threshold.
    expect(gaps).toContain(IDLE_GAP_SHORT_PAUSE_SECONDS * 1000);
    expect(IDLE_GAP_SHORT_PAUSE_SECONDS).toBeLessThan(REPLAY_BUILD_DEFAULTS.idleGapSeconds);
    expect(gaps.filter((gap) => gap > 30_000)).toHaveLength(4);

    // The long gap inside a tool call: the call and its result are 240 seconds apart.
    const calls = toolUseBlocks(main);
    const waits = toolResultBlocks(main).map(
      (result) => result.time - (calls.get(result.toolUseId)?.time ?? 0),
    );
    expect(waits.filter((wait) => wait > IDLE_GAP_MS)).toEqual([
      IDLE_GAP_LONG_COMMAND_SECONDS * 1000,
    ]);
    // Each idle gap ends with a new prompt.
    const stamped = main.filter((line) => typeof line.timestamp === "string");
    const idleLengths: number[] = IDLE_GAP_SECONDS.map((seconds) => seconds * 1000);
    const afterGap = stamped.filter(
      (_line, index) => index > 0 && idleLengths.includes(gaps[index - 1] as number),
    );
    expect(afterGap.map((line) => line.type)).toEqual(["user", "user"]);
    expect(afterGap.every((line) => typeof message(line).content === "string")).toBe(true);
  });

  it("unknown-lines: types, a block, a tool and a model family that do not exist", () => {
    const { session, transcripts } = load("unknown-lines", seed);
    const [futureEvent, traceSpan, ledgerNote] = INVENTED_LINE_TYPES;
    const main = transcripts.main;
    const sub = [...transcripts.subagents.values()][0] as JsonObject[];

    expect(session.expected.inventedLineTypes).toEqual({
      [futureEvent]: 2,
      [ledgerNote]: 2,
      [traceSpan]: 2,
    });
    expect(linesOfType(main, futureEvent)).toHaveLength(1);
    expect(linesOfType(main, traceSpan)).toHaveLength(2);
    expect(linesOfType(main, ledgerNote)).toHaveLength(1);
    expect(linesOfType(sub, futureEvent)).toHaveLength(1);
    expect(linesOfType(sub, ledgerNote)).toHaveLength(1);

    // One unknown line has nothing but its type. One has a timestamp and no uuid.
    expect(Object.keys(linesOfType(main, ledgerNote)[0] as JsonObject)).toEqual(["type"]);
    const event = linesOfType(main, futureEvent)[0] as JsonObject;
    expect(typeof event.timestamp).toBe("string");
    expect("uuid" in event).toBe(false);

    // One unknown line sits in the parent chain: the line after it names it as parent.
    const chained = linesOfType(main, traceSpan).find((line) => typeof line.uuid === "string");
    expect(chained).toBeDefined();
    expect(main.filter((line) => line.parentUuid === chained?.uuid)).toHaveLength(1);
    // In the subagent the unknown line has a uuid that no later line names.
    const loose = linesOfType(sub, futureEvent)[0] as JsonObject;
    expect(typeof loose.uuid).toBe("string");
    expect(sub.filter((line) => line.parentUuid === loose.uuid)).toHaveLength(0);

    const blockTypes = linesOfType(main, "assistant").flatMap((line) =>
      contentBlocks(line).map((block) => block.type),
    );
    expect(blockTypes.filter((type) => type === INVENTED_BLOCK_TYPE)).toHaveLength(1);

    const unknownTool = [...toolUseBlocks(main).values()].filter(
      (call) => call.name === INVENTED_TOOL_NAME,
    );
    expect(unknownTool).toHaveLength(1);
    expect(
      toolResultBlocks(main).filter((result) => result.toolUseId === unknownTool[0]?.id),
    ).toHaveLength(1);

    // Replies without the effort keys, and with a null perTurnEffort.
    const assistant = linesOfType(main, "assistant");
    expect(assistant.filter((line) => !("effort" in line))).toHaveLength(1);
    expect(assistant.filter((line) => !("perTurnEffort" in line))).toHaveLength(1);
    expect(assistant.filter((line) => line.perTurnEffort === null)).toHaveLength(1);

    // A model family that does not exist, and a meta file with no model.
    expect(session.expected.agents[1]?.model).toBe(MODELS.unknownFamily);
    expect(["fable", "opus", "sonnet", "haiku"]).not.toContain(family(MODELS.unknownFamily));
    expect("model" in ([...transcripts.metas.values()][0] as JsonObject)).toBe(false);

    expect(linesOfType(main, "queue-operation")).toHaveLength(1);
    expect(new Set(linesOfType(main, "user").map((line) => line.entrypoint))).toEqual(
      new Set(["claude-vscode"]),
    );
  });

  it("split-reply: usage that merges by maximum only, and a tool call written twice", () => {
    const { session, transcripts } = load("split-reply", seed);
    const main = transcripts.main;
    const byMessage = [...lineIndexesByMessage(main).values()];
    expect(byMessage.map((indexes) => indexes.length)).toEqual([5, 3, 2, 1]);
    expect(session.expected.totals.replies).toBe(4);

    // The first reply: five lines, five different usage objects.
    const firstLines = (byMessage[0] as number[]).map((index) => main[index] as JsonObject);
    const usages = firstLines.map((line) => message(line).usage as FullUsage);
    expect(usages).toEqual(SPLIT_REPLY_LINE_USAGE);
    const merged = usages.reduce(maxUsage, zeroUsage());
    const summed = usages.reduce(addUsage, zeroUsage());
    expect(merged).toEqual(SPLIT_REPLY_MERGED_USAGE);
    // No shortcut gives the right answer: not the first line, not the last, not any single
    // line, and not the sum.
    expect(usages).not.toContainEqual(SPLIT_REPLY_MERGED_USAGE);
    for (const key of USAGE_KEYS) {
      expect(summed[key]).toBeGreaterThan(SPLIT_REPLY_MERGED_USAGE[key]);
      expect((usages.at(-1) as FullUsage)[key]).toBeLessThan(SPLIT_REPLY_MERGED_USAGE[key]);
    }
    // Each field's maximum comes from a different line than at least one other field's.
    const holders = USAGE_KEYS.map((key) =>
      usages.findIndex((usage) => usage[key] === SPLIT_REPLY_MERGED_USAGE[key]),
    );
    expect(new Set(holders).size).toBeGreaterThan(1);

    // Three tool_use lines, two distinct calls: the first call is written a second time.
    const toolLines = firstLines.flatMap((line) =>
      contentBlocks(line).filter((block) => block.type === "tool_use"),
    );
    expect(toolLines).toHaveLength(3);
    expect(new Set(toolLines.map((block) => block.id)).size).toBe(2);
    expect(toolLines[2]).toEqual(toolLines[0]);
    const occurrences = [...summarise(main).toolUses.values()].map((use) => use.occurrences);
    expect(occurrences).toEqual([2, 1, 1, 1]);
    expect(session.expected.totals.toolCalls).toBe(4);
    expect(toolResultBlocks(main)).toHaveLength(4);

    // The stated total is the sum of the merged replies, so it holds the merged first reply.
    const perReply = [...summarise(main).usageByMessage.values()];
    expect(perReply[0]).toEqual(SPLIT_REPLY_MERGED_USAGE);
    expect(session.expected.totals.usage).toEqual(perReply.reduce(addUsage, zeroUsage()));

    // The second reply: its lines are not next to each other, results sit between them.
    const second = byMessage[1] as number[];
    expect((second.at(-1) as number) - (second[0] as number)).toBeGreaterThan(second.length - 1);
    const between = main.slice(second[0], second.at(-1)).filter((line) => line.type === "user");
    expect(between).toHaveLength(1);
    // The third reply: the usual case, the same usage on both lines.
    const third = (byMessage[2] as number[]).map((index) => message(main[index] as JsonObject));
    expect(third[0]?.usage).toEqual(third[1]?.usage);
    // All lines of one reply share a request id.
    expect(new Set(firstLines.map((line) => line.requestId)).size).toBe(1);
  });

  it("mcp-tools: calls named mcp__<server>__<tool>, on three servers", () => {
    const { session, transcripts } = load("mcp-tools", seed);
    const calls = allTranscripts(transcripts).flatMap(([, lines]) => [
      ...toolUseBlocks(lines).values(),
    ]);
    const mcp = calls.filter((call) => call.name.startsWith("mcp__"));
    expect(mcp.map((call) => call.name)).toEqual([
      "mcp__tide-almanac__lookup_tide",
      "mcp__paper_kites__fold_pattern",
      "mcp__paper_kites__list_colours",
      "mcp__tide-almanac__lookup_tide",
      "mcp__marble-ledger__append_row",
    ]);
    // Splitting on the double underscore gives the server, even with an underscore in it.
    expect(new Set(mcp.map((call) => call.name.split("__")[1]))).toEqual(
      new Set(["tide-almanac", "paper_kites", "marble-ledger"]),
    );
    expect(session.expected.agents.map((agent) => agent.mcpToolCalls)).toEqual([4, 1]);
    expect(session.expected.totals).toMatchObject({ mcpToolCalls: 5, failedToolCalls: 1 });

    // An MCP result holds a list of blocks, not a string.
    const mcpIds = new Set(mcp.map((call) => call.id));
    const results = allTranscripts(transcripts)
      .flatMap(([, lines]) => toolResultBlocks(lines))
      .filter((result) => mcpIds.has(result.toolUseId));
    expect(results).toHaveLength(5);
    expect(results.every((result) => Array.isArray(result.block.content))).toBe(true);
    expect(results.filter((result) => result.block.is_error === true)).toHaveLength(1);
    // The subagent runs a model id with a date suffix.
    expect(session.expected.agents[1]?.model).toBe(MODELS.haikuDated);
    expect(family(MODELS.haikuDated)).toBe("haiku");
    expect([...toolUseBlocks(transcripts.main).values()].map((call) => call.name)).toContain(
      "ToolSearch",
    );
  });

  it("nested-subagents: a subagent starts two of its own, at depth 2", () => {
    const { session, transcripts } = load("nested-subagents", seed);
    const [main, foreman, first, second] = session.expected.agents;
    expect(session.expected.agents.map((agent) => agent.spawnDepth)).toEqual([0, 1, 2, 2]);
    expect(foreman?.parent).toBe(main?.id);
    expect(first?.parent).toBe(foreman?.id);
    expect(second?.parent).toBe(foreman?.id);

    // The depth-2 Agent calls are in the foreman's transcript, not in the main one.
    const foremanLines = transcripts.subagents.get(String(foreman?.id)) as JsonObject[];
    const foremanCalls = toolUseBlocks(foremanLines);
    const metas = [...transcripts.metas.values()];
    expect(metas.map((meta) => meta.spawnDepth)).toEqual([1, 2, 2]);
    expect(foremanCalls.has(String(metas[1]?.toolUseId))).toBe(true);
    expect(foremanCalls.has(String(metas[2]?.toolUseId))).toBe(true);
    expect(toolUseBlocks(transcripts.main).has(String(metas[1]?.toolUseId))).toBe(false);
    // All files sit in the one subagents folder of the session: the layout is flat.
    expect(
      new Set(session.subagents.map((subagent) => subagent.transcriptPath.split("/").length)),
    ).toEqual(new Set([5]));

    // One wave, although the depth-2 agents start a little after the foreman.
    expect(waveSizes(subagentStartTimes(transcripts))).toEqual([3]);
    // The last meta file has no status keys. The agent did finish: its parent has a result.
    expect(Object.keys(metas[2] as JsonObject).sort()).toEqual([
      "agentType",
      "description",
      "model",
      "spawnDepth",
      "toolUseId",
    ]);
    expect(second?.finished).toBe(true);
    expect(
      toolResultBlocks(foremanLines).some((result) => result.toolUseId === metas[2]?.toolUseId),
    ).toBe(true);
  });

  it("demo: four waves, every model family and effort level, MCP calls and failures", () => {
    const { session, transcripts } = load(DEMO_SCENARIO, seed);
    const agents = session.expected.agents;
    expect(session.subagents).toHaveLength(14);
    expect(waveSizes(subagentStartTimes(transcripts))).toEqual([4, 5, 3, 2]);
    expect(session.expected.scriptedWaves).toBe(4);

    expect(new Set(agents.map((agent) => family(agent.model)))).toEqual(
      new Set(["fable", "opus", "sonnet", "haiku"]),
    );
    expect(new Set(agents.map((agent) => agent.effort))).toEqual(new Set(KNOWN_EFFORT_LEVELS));
    expect(agents[0]).toMatchObject({ model: MODELS.fable, effort: "xhigh", agentType: null });

    // Agent types repeat, so a reader has to tell them apart (code-reviewer #1 and #2).
    const types = session.subagents.map((subagent) => subagent.agentType);
    expect(types.filter((type) => type === "Explore")).toHaveLength(4);
    expect(types.filter((type) => type === "lantern-builder")).toHaveLength(2);
    expect(types.filter((type) => type === "code-reviewer")).toHaveLength(2);
    expect(new Set(types).size).toBe(9);

    expect(agents.every((agent) => agent.finished)).toBe(true);
    expect(session.expected.totals.unfinishedToolCalls).toBe(0);
    expect(session.expected.totals.failedToolCalls).toBeGreaterThanOrEqual(1);
    expect(session.expected.totals.mcpToolCalls).toBeGreaterThanOrEqual(2);
    expect(agents[0]?.failedToolCalls).toBe(1);
    expect(agents[0]?.mcpToolCalls).toBe(2);
    expect(session.expected.scriptedIdleGaps).toEqual([{ seconds: 540 }]);
    expect(idleGaps(transcripts.main)).toEqual([540]);

    // Enough going on to fill the view, and short enough to watch.
    expect(session.expected.totals.toolCalls).toBeGreaterThan(120);
    expect(session.expected.totals.lines).toBeGreaterThan(350);
    expect(agents.every((agent) => agent.toolCalls >= 3 && agent.usage.output_tokens > 0)).toBe(
      true,
    );
    const first = Date.parse(String(agents[0]?.firstTimestamp));
    const last = Date.parse(String(agents[0]?.lastTimestamp));
    expect(first).toBeGreaterThanOrEqual(Date.parse(SCENARIOS.demo.startTime));
    expect((last - first) / 60_000).toBeGreaterThan(12);
    expect((last - first) / 60_000).toBeLessThan(40);
    // Subagents of one wave overlap in time: they run side by side.
    const spans = agents.slice(1, 5).map((agent) => ({
      start: Date.parse(agent.firstTimestamp),
      end: Date.parse(agent.lastTimestamp),
    }));
    const latestStart = Math.max(...spans.map((span) => span.start));
    const earliestEnd = Math.min(...spans.map((span) => span.end));
    expect(latestStart).toBeLessThan(earliestEnd);
  });
});
