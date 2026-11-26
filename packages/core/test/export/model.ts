// Hand-built ReplayModel values for the export tests. All data is invented.
import type {
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplaySubagent,
  ReplayToolCall,
  ReplayTotals,
} from "../../src/index.js";

/** A value planted in leak tests. If it shows up in an export, the test fails. */
export const PLANTED = "PLANTED-invented-secret-do-not-export";

function totalsOf(tools: readonly ReplayToolCall[], replies: readonly ReplayReply[]): ReplayTotals {
  const sum = (key: keyof ReplayReply): number => replies.reduce((acc, r) => acc + r[key], 0);
  return {
    toolCalls: tools.length,
    failedToolCalls: tools.filter((tool) => tool.failed).length,
    replies: replies.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
  };
}

/** A small, internally consistent replay: a main agent, two subagents in two waves, one warp. */
export function makeModel(): ReplayModel {
  const mainTools: ReplayToolCall[] = [
    { name: "Read", kind: "read", start: 1, end: 1.5, failed: false },
    { name: "Agent", kind: "agent", start: 4, end: 30, failed: false },
    { name: "mcp:example-docs", kind: "mcp", start: 32, end: 33, failed: true },
    { name: "Agent", kind: "agent", start: 95, end: null, failed: false },
  ];
  const mainReplies: ReplayReply[] = [
    { t: 0.5, inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheCreationTokens: 4000 },
    { t: 3.5, inputTokens: 20, outputTokens: 80, cacheReadTokens: 4000, cacheCreationTokens: 50 },
  ];
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
    end: 120,
    tools: mainTools,
    replies: mainReplies,
    totals: totalsOf(mainTools, mainReplies),
  };

  const firstTools: ReplayToolCall[] = [
    { name: "Grep", kind: "read", start: 6, end: 6.2, failed: false },
    { name: "Edit", kind: "edit", start: 20, end: 20.4, failed: false },
  ];
  const firstReplies: ReplayReply[] = [
    { t: 5, inputTokens: 300, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 1000 },
  ];
  const first: ReplaySubagent = {
    id: "a1",
    name: "widget-reviewer",
    callsign: "widget-reviewer",
    model: "claude-sonnet-9-1",
    family: "sonnet",
    effort: null,
    parent: "main",
    wave: 0,
    start: 4.5,
    end: 29,
    tools: firstTools,
    replies: firstReplies,
    totals: totalsOf(firstTools, firstReplies),
  };

  const secondTools: ReplayToolCall[] = [
    { name: "Bash", kind: "shell", start: 97, end: 99, failed: false },
  ];
  const secondReplies: ReplayReply[] = [
    { t: 96, inputTokens: 150, outputTokens: 40, cacheReadTokens: 500, cacheCreationTokens: 0 },
  ];
  const second: ReplaySubagent = {
    id: "a2",
    name: "widget-reviewer",
    callsign: "widget-reviewer#2",
    model: null,
    family: "unknown",
    effort: "low",
    parent: "main",
    wave: 1,
    start: 95.5,
    end: null,
    tools: secondTools,
    replies: secondReplies,
    totals: totalsOf(secondTools, secondReplies),
  };

  const agents = [main, first, second] as const;
  const sum = (key: keyof ReplayTotals): number =>
    agents.reduce((acc, agent) => acc + agent.totals[key], 0);
  return {
    formatVersion: 1,
    agents: [main, first, second],
    warps: [{ at: 60, skipped: 300 }],
    totals: {
      agents: agents.length,
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      duration: 120,
      realDuration: 420,
    },
  };
}

/** A deep, mutable JSON copy of a model, for tests that change or plant fields. */
export function mutableCopy(model: ReplayModel): Record<string, unknown> {
  return JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
}

/** Narrow helpers for poking into a mutable copy. */
export function obj(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

export function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

/** Every property name and every string value in a JSON value, at any depth. */
export function walk(value: unknown): { keys: string[]; strings: string[] } {
  const keys: string[] = [];
  const strings: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") strings.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        visit(child);
      }
    }
  };
  visit(value);
  return { keys, strings };
}
