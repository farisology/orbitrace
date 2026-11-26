/**
 * The fixture scenarios. Each one scripts a session that exercises one thing a transcript
 * reader has to get right. Project names, agent types, MCP servers and all text are invented.
 */
import {
  INVENTED_BLOCK_TYPE,
  INVENTED_LINE_TYPES,
  INVENTED_TOOL_NAME,
  MODELS,
  type FullUsage,
  type KnownEffortLevel,
} from "./lines.js";
import type { AgentWriter, SessionBuilder, SubagentSpec, ToolSpec } from "./session-builder.js";

export const SCENARIO_NAMES = [
  "single-agent",
  "two-waves",
  "tool-failures",
  "idle-gap",
  "unknown-lines",
  "split-reply",
  "mcp-tools",
  "nested-subagents",
  "demo",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** The session bundled for a first run of the app. */
export const DEMO_SCENARIO: ScenarioName = "demo";

export interface ScenarioDefinition {
  name: ScenarioName;
  /** One sentence on what the scenario is for. */
  description: string;
  /** Invented project name. Two scenarios may share a project. */
  project: string;
  /** ISO 8601 UTC time of the first line. A fixed, invented date. */
  startTime: string;
  model: string;
  effort: KnownEffortLevel;
  gitBranch?: string;
  entrypoint?: "cli" | "claude-vscode";
  script: (session: SessionBuilder) => void;
}

/**
 * The per-line usage of the first reply in the split-reply scenario. No single line holds
 * the maximum of every field, the last line holds none of them, and the sum is far larger,
 * so only a field-by-field maximum gives SPLIT_REPLY_MERGED_USAGE.
 */
export const SPLIT_REPLY_LINE_USAGE: readonly FullUsage[] = [
  {
    input_tokens: 42,
    output_tokens: 9,
    cache_read_input_tokens: 18200,
    cache_creation_input_tokens: 640,
  },
  {
    input_tokens: 42,
    output_tokens: 310,
    cache_read_input_tokens: 18200,
    cache_creation_input_tokens: 640,
  },
  {
    input_tokens: 57,
    output_tokens: 120,
    cache_read_input_tokens: 17900,
    cache_creation_input_tokens: 0,
  },
  {
    input_tokens: 42,
    output_tokens: 455,
    cache_read_input_tokens: 18100,
    cache_creation_input_tokens: 910,
  },
  {
    input_tokens: 3,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
];

/** What the lines of SPLIT_REPLY_LINE_USAGE merge to. */
export const SPLIT_REPLY_MERGED_USAGE: FullUsage = {
  input_tokens: 57,
  output_tokens: 455,
  cache_read_input_tokens: 18200,
  cache_creation_input_tokens: 910,
};

/** The idle gaps scripted in the idle-gap scenario, in seconds, in order. */
export const IDLE_GAP_SECONDS = [2820, 95] as const;

/** A pause in the idle-gap scenario that is under the 45 second threshold: not an idle gap. */
export const IDLE_GAP_SHORT_PAUSE_SECONDS = 40;

/** A shell command in the idle-gap scenario that runs this long: busy time, not idle time. */
export const IDLE_GAP_LONG_COMMAND_SECONDS = 240;

type WorkProfile = "explore" | "plan" | "build" | "review" | "docs";

const PROFILE_TOOLS: Record<WorkProfile, readonly string[]> = {
  explore: ["read", "read", "grep", "grep", "glob"],
  plan: ["read", "read", "grep", "glob", "toolSearch"],
  build: ["edit", "edit", "write", "bash", "read", "bash"],
  review: ["read", "read", "grep", "bash"],
  docs: ["read", "write", "edit", "glob"],
};

interface WorkOptions {
  /** Chance that a tool call fails. Default 0. */
  failChance?: number;
  /** MCP tools the agent may also call, as [server, tool] pairs. */
  mcp?: readonly (readonly [string, string])[];
}

function pickTool(agent: AgentWriter, profile: WorkProfile, options: WorkOptions): ToolSpec {
  const rng = agent.rng;
  const failed = rng.chance(options.failChance ?? 0);
  const overrides = failed ? ({ outcome: "error" } as const) : {};
  const mcp = options.mcp ?? [];
  const useMcp = rng.chance(0.22);
  if (mcp.length > 0 && useMcp) {
    const [server, tool] = rng.pick(mcp);
    return agent.tools.mcp(server, tool, overrides);
  }
  switch (rng.pick(PROFILE_TOOLS[profile])) {
    case "read":
      return agent.tools.read(overrides);
    case "grep":
      return agent.tools.grep(overrides);
    case "glob":
      return agent.tools.glob(overrides);
    case "edit":
      return agent.tools.edit(overrides);
    case "write":
      return agent.tools.write(overrides);
    case "toolSearch":
      return agent.tools.toolSearch(overrides);
    default:
      return agent.tools.bash(overrides);
  }
}

/** A run of tool rounds in the style of a profile, then a closing reply. */
function work(
  agent: AgentWriter,
  profile: WorkProfile,
  rounds: number,
  options: WorkOptions = {},
): void {
  for (let round = 0; round < rounds; round += 1) {
    const batch = agent.rng.pick([1, 1, 1, 2, 2, 3]);
    const tools: ToolSpec[] = [];
    for (let index = 0; index < batch; index += 1) tools.push(pickTool(agent, profile, options));
    const thinking = agent.rng.chance(0.4);
    const text = agent.rng.chance(0.3);
    agent.use(tools, { thinking, text });
  }
  agent.say({ thinking: agent.rng.chance(0.5) });
}

function worker(
  agentType: string,
  model: string,
  effort: KnownEffortLevel,
  profile: WorkProfile,
  rounds: number,
  options: WorkOptions = {},
): SubagentSpec {
  return { agentType, model, effort, script: (agent) => work(agent, profile, rounds, options) };
}

/** A shell command long enough to put more than 60 seconds between two waves. */
function longCommand(agent: AgentWriter, seconds: number): void {
  agent.use(agent.tools.bash({ durationMs: seconds * 1000 }), { text: true });
}

function singleAgent(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  main.attachment();
  main.use(main.tools.read());
  main.use(main.tools.grep());
  main.use(main.tools.bash());
  main.say();
  main.system("turn_duration", { durationMs: 21400 });
  main.advance(18000);
  main.prompt();
  main.use(main.tools.edit());
  main.use(main.tools.write());
  main.use(main.tools.bash());
  main.say();
  main.system("turn_duration", { durationMs: 16900 });
  session.close();
}

function twoWaves(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  main.use([main.tools.glob(), main.tools.read()], { thinking: true });
  main.spawn(
    [
      worker("Explore", MODELS.haiku, "low", "explore", 4),
      worker("Explore", MODELS.haiku, "low", "explore", 5),
      worker("Plan", MODELS.opus, "high", "plan", 3),
    ],
    { thinking: true, text: true },
  );
  main.use(main.tools.edit(), { text: true });
  longCommand(main, 95);
  main.spawn(
    [
      worker("code-reviewer", MODELS.opus, "high", "review", 4),
      worker("test-writer", MODELS.sonnet, "medium", "build", 5),
    ],
    { text: true },
  );
  main.say({ thinking: true });
  session.close();
}

function toolFailures(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  main.use(main.tools.read({ outcome: "error" }));
  main.use([main.tools.bash({ outcome: "error" }), main.tools.grep()], { thinking: true });
  main.use(main.tools.edit({ outcome: "error" }));
  main.use(main.tools.edit());
  main.use(main.tools.mcp("tide-almanac", "lookup_tide", { outcome: "error" }));
  main.spawn(
    [
      {
        agentType: "test-runner",
        model: MODELS.sonnet,
        effort: "medium",
        script: (agent) => {
          agent.use(agent.tools.bash({ outcome: "error" }));
          agent.use(agent.tools.read());
          agent.use(agent.tools.bash({ outcome: "error" }), { thinking: true });
          agent.say();
        },
      },
      {
        // This subagent is cut off: its last call has no result, its meta file says
        // unfinished, and the parent's Agent call never gets a result either.
        agentType: "general-purpose",
        model: MODELS.haiku,
        effort: "low",
        finished: false,
        script: (agent) => {
          agent.use(agent.tools.read());
          agent.use(agent.tools.bash({ outcome: "none" }));
        },
      },
    ],
    { text: true },
  );
  // The main agent is cut off too: one more call, and no result for it.
  main.use(main.tools.bash({ outcome: "none" }));
  session.close();
}

function idleGap(session: SessionBuilder): void {
  const main = session.main;
  const [longGap, shortGap] = IDLE_GAP_SECONDS;
  session.open();
  main.prompt();
  main.use(main.tools.read());
  // A long command is busy time: nothing may be cut out of it.
  main.use(main.tools.bash({ durationMs: IDLE_GAP_LONG_COMMAND_SECONDS * 1000 }));
  main.say();
  main.idle(longGap);
  main.prompt();
  main.use(main.tools.grep());
  main.say();
  // Under the threshold: this pause is not an idle gap.
  main.pauseFor(IDLE_GAP_SHORT_PAUSE_SECONDS);
  main.prompt();
  main.use(main.tools.edit());
  main.say();
  main.idle(shortGap);
  main.prompt();
  main.say();
  session.close();
}

function unknownLines(session: SessionBuilder): void {
  const main = session.main;
  const [futureEvent, traceSpan, ledgerNote] = INVENTED_LINE_TYPES;
  session.open();
  // An unknown type with a timestamp but none of the other common keys.
  main.housekeeping(futureEvent, { payload: { note: "Synthetic payload." } }, { timestamp: true });
  main.prompt();
  // An unknown type that carries the common keys and sits in the parent chain: a reader
  // that drops it still has to connect the lines around it.
  main.conversationLine(traceSpan, { span: { label: "Synthetic span." } });
  main.use(main.tools.read());
  // A known line type with a content block type that does not exist.
  main.reply([
    { kind: "thinking" },
    { kind: "raw", block: { type: INVENTED_BLOCK_TYPE, data: "Synthetic block." } },
    { kind: "text" },
  ]);
  // Known lines that lack the effort keys, or hold a null: both occur in real transcripts.
  main.reply([{ kind: "text" }], { effortKeys: "none" });
  main.reply([{ kind: "text" }], { effortKeys: "nullPerTurn" });
  // An unknown type with nothing but `type`.
  main.housekeeping(ledgerNote, {}, { sessionId: false });
  // A tool name that does not exist.
  main.use(main.tools.custom(INVENTED_TOOL_NAME));
  main.spawn([
    {
      agentType: "schema-cartographer",
      model: MODELS.unknownFamily,
      effort: "medium",
      modelInMeta: false,
      script: (agent) => {
        agent.conversationLine(futureEvent, { payload: { note: "Synthetic payload." } }, false);
        agent.use(agent.tools.grep());
        agent.housekeeping(ledgerNote, { note: "Synthetic note." });
        agent.say();
      },
    },
  ]);
  main.housekeeping(
    "queue-operation",
    { operation: "enqueue", content: "Synthetic queued prompt." },
    { timestamp: true },
  );
  main.say();
  main.housekeeping(traceSpan, { span: { label: "Synthetic span." } });
  session.close();
}

function splitReply(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  // Five lines, one message id. The fifth line writes the first tool call a second time,
  // so tool calls must be united by block id, not counted per line.
  const first = main.reply(
    [
      { kind: "thinking" },
      { kind: "text" },
      { kind: "tool", tool: main.tools.read() },
      { kind: "tool", tool: main.tools.grep() },
      { kind: "repeat", of: 2 },
    ],
    { usagePerLine: SPLIT_REPLY_LINE_USAGE },
  );
  main.results(first.calls);
  // Two tool calls whose results sit between the lines of the reply: the lines of one
  // message are not always next to each other.
  main.reply(
    [
      { kind: "text" },
      { kind: "tool", tool: main.tools.read() },
      { kind: "tool", tool: main.tools.edit() },
    ],
    { interleaveResults: true },
  );
  // An ordinary split reply: the same usage on every line.
  main.say({ thinking: true });
  main.prompt();
  // A reply on a single line.
  main.say();
  session.close();
}

function mcpTools(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  main.use(main.tools.toolSearch());
  main.use(main.tools.mcp("tide-almanac", "lookup_tide"), { thinking: true });
  // A server name with an underscore: the name must be split on the double underscore.
  main.use([
    main.tools.mcp("paper_kites", "fold_pattern"),
    main.tools.mcp("paper_kites", "list_colours"),
    main.tools.read(),
  ]);
  main.use(main.tools.mcp("tide-almanac", "lookup_tide", { outcome: "error" }));
  main.spawn([
    {
      agentType: "general-purpose",
      model: MODELS.haikuDated,
      effort: "medium",
      script: (agent) => {
        agent.use(agent.tools.mcp("marble-ledger", "append_row"));
        agent.say();
      },
    },
  ]);
  main.say();
  session.close();
}

function nestedSubagents(session: SessionBuilder): void {
  const main = session.main;
  session.open();
  main.prompt();
  main.use(main.tools.glob());
  main.spawn([
    {
      agentType: "lantern-foreman",
      model: MODELS.sonnet,
      effort: "high",
      script: (foreman) => {
        foreman.use(foreman.tools.read());
        // Depth 2, started a few seconds after the foreman: still the first wave. The second
        // meta file has neither `isBuiltIn` nor `finished`.
        foreman.spawn(
          [
            worker("Explore", MODELS.haiku, "low", "explore", 3),
            { ...worker("Explore", MODELS.haiku, "low", "explore", 2), statusInMeta: false },
          ],
          { newWave: false },
        );
        foreman.use(foreman.tools.write());
        foreman.say();
      },
    },
  ]);
  main.say();
  session.close();
}

function demo(session: SessionBuilder): void {
  const main = session.main;
  const almanac = [
    ["tide-almanac", "lookup_tide"],
    ["tide-almanac", "list_moons"],
  ] as const;
  const ledger = [["marble-ledger", "append_row"]] as const;

  session.open();
  main.prompt();
  main.attachment();
  main.use([main.tools.glob(), main.tools.read(), main.tools.read()], { thinking: true });
  main.use(main.tools.toolSearch());
  main.use(main.tools.mcp("tide-almanac", "lookup_tide"), { text: true });

  // Wave 1: look around and plan.
  main.spawn(
    [
      worker("Explore", MODELS.haiku, "low", "explore", 7),
      worker("Explore", MODELS.haiku, "low", "explore", 9, { failChance: 0.08 }),
      worker("Explore", MODELS.haiku, "medium", "explore", 6, { mcp: almanac }),
      worker("Plan", MODELS.opus, "high", "plan", 6),
    ],
    { thinking: true, text: true },
  );
  main.use([main.tools.read(), main.tools.grep()], { thinking: true });
  main.use(main.tools.write(), { text: true });
  longCommand(main, 72);

  // Wave 2: build.
  main.spawn(
    [
      worker("lantern-builder", MODELS.sonnet, "medium", "build", 11, { failChance: 0.12 }),
      worker("lantern-builder", MODELS.sonnet, "medium", "build", 9, { failChance: 0.1 }),
      worker("schema-cartographer", MODELS.sonnet, "high", "plan", 7, { mcp: ledger }),
      worker("kite-rigger", MODELS.opus, "xhigh", "build", 8, { failChance: 0.06 }),
      worker("docs-scribe", MODELS.haiku, "medium", "docs", 6),
    ],
    { text: true },
  );
  main.use(main.tools.bash({ outcome: "error" }), { thinking: true });
  main.use(main.tools.edit());
  main.use(main.tools.bash(), { text: true });
  main.say({ thinking: true });
  main.system("turn_duration", { durationMs: 412000 });

  // The user steps away: one idle gap for the timeline to skip.
  main.idle(540);
  main.prompt();
  main.use([main.tools.read(), main.tools.grep(), main.tools.grep()], { thinking: true });

  // Wave 3: review and test.
  main.spawn(
    [
      worker("code-reviewer", MODELS.opus, "max", "review", 8),
      worker("test-writer", MODELS.sonnet, "medium", "build", 10, { failChance: 0.15 }),
      worker("general-purpose", MODELS.fable, "high", "review", 7, { mcp: almanac }),
    ],
    { thinking: true },
  );
  main.use(main.tools.edit(), { text: true });
  longCommand(main, 81);

  // Wave 4: a last check.
  main.spawn(
    [
      worker("code-reviewer", MODELS.opus, "max", "review", 5),
      worker("Explore", MODELS.haiku, "low", "explore", 4),
    ],
    { text: true },
  );
  main.use(main.tools.mcp("marble-ledger", "append_row"));
  main.say({ thinking: true });
  main.system("turn_duration", { durationMs: 268000 });
  session.close();
}

export const SCENARIOS: Record<ScenarioName, ScenarioDefinition> = {
  "single-agent": {
    name: "single-agent",
    description:
      "One agent, two turns, no subagents. Every reply is a single line, so nothing needs merging.",
    project: "lantern-ledger",
    startTime: "2026-02-02T09:00:00.000Z",
    model: MODELS.opus,
    effort: "high",
    script: singleAgent,
  },
  "two-waves": {
    name: "two-waves",
    description:
      "Three subagents started together, then two more over a minute later. Two share an agent type.",
    project: "kite-workshop",
    startTime: "2026-02-03T10:30:00.000Z",
    model: MODELS.sonnet,
    effort: "medium",
    gitBranch: "feature/synthetic-kites",
    script: twoWaves,
  },
  "tool-failures": {
    name: "tool-failures",
    description:
      "Failed tool calls in the main agent and a subagent, calls with no result, and a subagent that never finishes.",
    project: "marble-run",
    startTime: "2026-02-04T14:15:00.000Z",
    model: MODELS.sonnet,
    effort: "low",
    script: toolFailures,
  },
  "idle-gap": {
    name: "idle-gap",
    description:
      "A 47 minute gap and a 95 second gap between turns, a 40 second pause that is not a gap, and a 4 minute command that is busy time.",
    project: "quill-archive",
    startTime: "2026-02-05T08:05:00.000Z",
    model: MODELS.opus,
    effort: "medium",
    script: idleGap,
  },
  "unknown-lines": {
    name: "unknown-lines",
    description:
      "Line types, a content block type, a tool name and a model family that do not exist, and replies without effort keys, in the main and a subagent transcript.",
    project: "juniper-almanac",
    startTime: "2026-02-06T16:40:00.000Z",
    model: MODELS.haiku,
    effort: "high",
    entrypoint: "claude-vscode",
    script: unknownLines,
  },
  "split-reply": {
    name: "split-reply",
    description:
      "Replies written over several lines that share a message id: usage that only merges by maximum, a tool call written twice, and results between the lines.",
    project: "lantern-ledger",
    startTime: "2026-02-09T11:20:00.000Z",
    model: MODELS.opus,
    effort: "xhigh",
    script: splitReply,
  },
  "mcp-tools": {
    name: "mcp-tools",
    description:
      "MCP tool calls on three invented servers, one with an underscore in its name, one call failing, one made by a subagent.",
    project: "tidepool-atlas",
    startTime: "2026-02-10T13:00:00.000Z",
    model: MODELS.sonnet,
    effort: "high",
    script: mcpTools,
  },
  "nested-subagents": {
    name: "nested-subagents",
    description:
      "A subagent that spawns two subagents of its own: spawn depth 2, with the middle agent as their parent. One meta file has no status keys.",
    project: "compass-foundry",
    startTime: "2026-02-11T15:45:00.000Z",
    model: MODELS.opus,
    effort: "high",
    script: nestedSubagents,
  },
  demo: {
    name: "demo",
    description:
      "The bundled demo: four waves, fourteen subagents, all four model families, all five effort levels, MCP calls, failures and one idle gap.",
    project: "paper-orrery",
    startTime: "2026-03-14T09:26:00.000Z",
    model: MODELS.fable,
    effort: "xhigh",
    entrypoint: "claude-vscode",
    gitBranch: "feature/synthetic-orrery",
    script: demo,
  },
};
