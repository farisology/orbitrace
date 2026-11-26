/**
 * A synthetic replay for the demo page, the benchmark and the allocation test. Every value is
 * invented by a seeded generator: agent types, tool names, timings and token counts. No real
 * session went into it.
 */

import type {
  EffortLevel,
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplaySubagent,
  ReplayToolCall,
  ReplayTotals,
  ReplayWarp,
  ToolKind,
} from "@orbitrace/core";

export interface DemoModelOptions {
  /** Seed for the generator. The same options always give the same model. */
  readonly seed?: number;
  readonly waves?: number;
  readonly agentsPerWave?: number;
  /** Leave the last subagent running (`end: null`), as in a live snapshot. */
  readonly live?: boolean;
}

const AGENT_TYPES = [
  "code-reviewer",
  "test-runner",
  "doc-writer",
  "lint-fixer",
  "api-scout",
  "schema-checker",
  "ui-tinkerer",
  "perf-prober",
];
const FAMILIES: readonly { family: string; model: string }[] = [
  { family: "opus", model: "claude-opus-5-5" },
  { family: "sonnet", model: "claude-sonnet-5-5" },
  { family: "haiku", model: "claude-haiku-5-5" },
  { family: "fable", model: "claude-fable-5-5" },
  { family: "gizmo", model: "example-gizmo-1" },
];
const EFFORTS: readonly (EffortLevel | null)[] = ["low", "medium", "high", "xhigh", "max", null];
const TOOLS: readonly { name: string; kind: ToolKind; weight: number }[] = [
  { name: "Read", kind: "read", weight: 30 },
  { name: "Grep", kind: "read", weight: 14 },
  { name: "Glob", kind: "read", weight: 6 },
  { name: "Edit", kind: "edit", weight: 14 },
  { name: "Write", kind: "edit", weight: 4 },
  { name: "Bash", kind: "shell", weight: 20 },
  { name: "mcp:docs", kind: "mcp", weight: 6 },
  { name: "mcp:tracker", kind: "mcp", weight: 3 },
  { name: "TodoWrite", kind: "other", weight: 3 },
];
const TOOL_WEIGHT = TOOLS.reduce((sum, tool) => sum + tool.weight, 0);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;

function totalsOf(tools: readonly ReplayToolCall[], replies: readonly ReplayReply[]): ReplayTotals {
  return {
    toolCalls: tools.length,
    failedToolCalls: tools.filter((t) => t.failed).length,
    replies: replies.length,
    inputTokens: replies.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: replies.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: replies.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheCreationTokens: replies.reduce((s, r) => s + r.cacheCreationTokens, 0),
  };
}

export function createDemoModel(options: DemoModelOptions = {}): ReplayModel {
  const rand = random(options.seed ?? 42);
  const waves = Math.max(1, options.waves ?? 3);
  const perWave = Math.max(1, options.agentsPerWave ?? 5);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

  const pickTool = () => {
    let x = rand() * TOOL_WEIGHT;
    for (const tool of TOOLS) {
      x -= tool.weight;
      if (x <= 0) return tool;
    }
    return TOOLS[0]!;
  };

  /** Calls one after another between `from` and `to`; mostly short, a few long. */
  const callsBetween = (from: number, to: number, out: ReplayToolCall[]): void => {
    let t = from;
    while (t < to - 1) {
      const tool = pickTool();
      const long = rand() < 0.12;
      const length = long ? 3 + rand() * 14 : 0.1 + rand() * 0.9;
      const end = Math.min(to, t + length);
      out.push({
        name: tool.name,
        kind: tool.kind,
        start: round(t),
        end: round(end),
        failed: rand() < 0.06,
      });
      t = end + 0.4 + rand() * 3.5;
    }
  };
  const repliesBetween = (from: number, to: number): ReplayReply[] => {
    const replies: ReplayReply[] = [];
    let cache = 2000;
    for (let t = from + 0.5; t < to; t += 3 + rand() * 5) {
      const created = Math.round(rand() * 400);
      replies.push({
        t: round(t),
        inputTokens: Math.round(20 + rand() * 200),
        outputTokens: Math.round(50 + rand() * 1400),
        cacheReadTokens: cache,
        cacheCreationTokens: created,
      });
      cache += created;
    }
    return replies;
  };

  const subagents: ReplaySubagent[] = [];
  const mainTools: ReplayToolCall[] = [];
  const warps: ReplayWarp[] = [];
  const seen = new Map<string, number>();
  const nameCount = new Map<string, number>();
  const plan: { name: string; start: number; end: number; wave: number }[] = [];
  for (let w = 0; w < waves; w++) {
    const waveStart = 20 + w * 150;
    for (let i = 0; i < perWave; i++) {
      const name = pick(AGENT_TYPES);
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
      const start = waveStart + i * 1.5;
      plan.push({ name, start, end: start + 40 + rand() * 70, wave: w });
    }
    if (w > 0) warps.push({ at: waveStart - 12, skipped: round(300 + rand() * 1500) });
  }

  plan.forEach((p, index) => {
    const id = `a${index + 1}` as `a${number}`;
    const count = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, count);
    const callsign = (nameCount.get(p.name) ?? 0) > 1 ? `${p.name}#${count}` : p.name;
    const identity = pick(FAMILIES);
    const isLast = index === plan.length - 1;
    const end = options.live && isLast ? null : round(p.end);
    const tools: ReplayToolCall[] = [];
    callsBetween(p.start + 1, p.end - 1, tools);
    if (end === null && tools.length > 0) {
      const last = tools[tools.length - 1]!;
      tools[tools.length - 1] = { ...last, end: null, failed: false };
    }
    const replies = repliesBetween(p.start, p.end);
    subagents.push({
      id,
      name: p.name,
      callsign,
      model: identity.model,
      family: identity.family,
      effort: pick(EFFORTS),
      parent: "main",
      wave: p.wave,
      start: round(p.start),
      end,
      tools,
      replies,
      totals: totalsOf(tools, replies),
    });
    mainTools.push({
      name: "Agent",
      kind: "agent",
      start: round(p.start - 0.5),
      end: end === null ? null : round(p.end + 0.5),
      failed: false,
    });
  });

  const lastEnd = plan.reduce((m, p) => Math.max(m, p.end), 0);
  const duration = round(lastEnd + 12);
  callsBetween(1, 18, mainTools);
  for (let w = 0; w < waves; w++)
    callsBetween(20 + w * 150 + perWave * 1.5 + 2, 20 + w * 150 + 30, mainTools);
  callsBetween(lastEnd + 1, duration - 1, mainTools);
  mainTools.sort((a, b) => a.start - b.start);
  const mainReplies = repliesBetween(0, duration);
  const main: ReplayMainAgent = {
    id: "main",
    name: "main",
    callsign: "main",
    model: "claude-opus-5-5",
    family: "opus",
    effort: "high",
    parent: null,
    wave: null,
    start: 0,
    end: options.live ? null : duration,
    tools: mainTools,
    replies: mainReplies,
    totals: totalsOf(mainTools, mainReplies),
  };

  const all = [main, ...subagents];
  const sum = (key: keyof ReplayTotals) => all.reduce((s, a) => s + a.totals[key], 0);
  const skipped = warps.reduce((s, w) => s + w.skipped, 0);
  return {
    formatVersion: 1,
    agents: [main, ...subagents],
    warps,
    totals: {
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      agents: all.length,
      duration,
      realDuration: round(duration + skipped),
    },
  };
}

/**
 * The model as a live snapshot taken at compressed time `now`: only what had started by then,
 * with open calls and running agents ending in `null`. Used by the demo to drive `updateModel`.
 * Assumes subagent ids are in start order, as `createDemoModel` makes them.
 */
export function snapshotAt(model: ReplayModel, now: number): ReplayModel {
  const cut = <A extends ReplayMainAgent | ReplaySubagent>(agent: A): A => {
    const tools = agent.tools
      .filter((tool) => tool.start <= now)
      .map((tool) =>
        tool.end !== null && tool.end <= now ? tool : { ...tool, end: null, failed: false },
      );
    const replies = agent.replies.filter((r) => r.t <= now);
    const end = agent.end !== null && agent.end <= now ? agent.end : null;
    return { ...agent, end, tools, replies, totals: totalsOf(tools, replies) };
  };
  const [main, ...subs] = model.agents;
  const agents: [ReplayMainAgent, ...ReplaySubagent[]] = [
    cut(main),
    ...subs.filter((agent) => agent.start <= now).map(cut),
  ];
  const warps = model.warps.filter((warp) => warp.at <= now);
  const sum = (key: keyof ReplayTotals) => agents.reduce((s, a) => s + a.totals[key], 0);
  const duration = Math.max(0, now);
  return {
    formatVersion: 1,
    agents,
    warps,
    totals: {
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      agents: agents.length,
      duration,
      realDuration: round(duration + warps.reduce((s, w) => s + w.skipped, 0)),
    },
  };
}
