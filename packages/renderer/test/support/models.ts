/** Hand-built synthetic replays for unit tests. Every name and number is invented. */

import type {
  EffortLevel,
  ReplayAgentId,
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplaySubagent,
  ReplayToolCall,
  ReplayTotals,
  ReplayWarp,
  ToolKind,
} from "@orbitrace/core";

export function call(
  name: string,
  kind: ToolKind,
  start: number,
  end: number | null,
  failed = false,
): ReplayToolCall {
  return { name, kind, start, end, failed };
}

export function reply(t: number, outputTokens: number): ReplayReply {
  return { t, inputTokens: 10, outputTokens, cacheReadTokens: 100, cacheCreationTokens: 5 };
}

function totals(tools: readonly ReplayToolCall[], replies: readonly ReplayReply[]): ReplayTotals {
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

export interface SubSpec {
  id: `a${number}`;
  name: string;
  family: string;
  effort: EffortLevel | null;
  wave: number;
  start: number;
  end: number | null;
  tools?: ReplayToolCall[];
  replies?: ReplayReply[];
  parent?: ReplayAgentId;
}

export function sub(spec: SubSpec): ReplaySubagent {
  const tools = spec.tools ?? [];
  const replies = spec.replies ?? [];
  return {
    id: spec.id,
    name: spec.name,
    callsign: spec.name,
    model: `example-${spec.family}-1`,
    family: spec.family,
    effort: spec.effort,
    parent: spec.parent ?? "main",
    wave: spec.wave,
    start: spec.start,
    end: spec.end,
    tools,
    replies,
    totals: totals(tools, replies),
  };
}

export function mainAgent(
  end: number | null,
  tools: ReplayToolCall[],
  replies: ReplayReply[],
  effort: EffortLevel | null = "high",
): ReplayMainAgent {
  return {
    id: "main",
    name: "main",
    callsign: "main",
    model: "example-opus-1",
    family: "opus",
    effort,
    parent: null,
    wave: null,
    start: 0,
    end,
    tools,
    replies,
    totals: totals(tools, replies),
  };
}

export function model(
  main: ReplayMainAgent,
  subs: ReplaySubagent[],
  warps: ReplayWarp[],
  duration: number,
): ReplayModel {
  const all = [main, ...subs];
  const sum = (key: keyof ReplayTotals) => all.reduce((s, a) => s + a.totals[key], 0);
  return {
    formatVersion: 1,
    agents: [main, ...subs],
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
      realDuration: duration + warps.reduce((s, w) => s + w.skipped, 0),
    },
  };
}

/**
 * Main agent and four subagents in two waves:
 * - a1 `code-reviewer`, sonnet, medium, wave 0, 10 to 60. One call stays open (no result).
 * - a2 `test-runner`, haiku, max, wave 0, 11 to 64.
 * - a3 `doc-writer`, fable, low, wave 1, 75, still running.
 * - a4 `gadget-maker`, family `gizmo` (unknown to the renderer), effort not recorded, wave 1, 76 to 90.
 * One warp at 66 skips 600 real seconds. Duration 100.
 */
export function smallModel(): ReplayModel {
  const main = mainAgent(
    100,
    [
      call("Read", "read", 2, 2.4),
      call("Agent", "agent", 9.5, 60.5),
      call("Agent", "agent", 10.5, 64.5),
      call("Bash", "shell", 66.5, 70, true),
      call("Agent", "agent", 74.5, null),
      call("Agent", "agent", 75.5, 90.5),
      call("Edit", "edit", 92, 92.2),
    ],
    [reply(1, 100), reply(9, 200), reply(69, 50)],
  );
  const a1 = sub({
    id: "a1",
    name: "code-reviewer",
    family: "sonnet",
    effort: "medium",
    wave: 0,
    start: 10,
    end: 60,
    tools: [
      call("Read", "read", 12, 13),
      call("mcp:docs", "mcp", 14, 15, true),
      call("Bash", "shell", 20, null),
    ],
    replies: [reply(11, 300), reply(30, 400)],
  });
  const a2 = sub({
    id: "a2",
    name: "test-runner",
    family: "haiku",
    effort: "max",
    wave: 0,
    start: 11,
    end: 64,
    tools: [call("Edit", "edit", 40, 40.1)],
    replies: [reply(12, 1000)],
  });
  const a3 = sub({
    id: "a3",
    name: "doc-writer",
    family: "fable",
    effort: "low",
    wave: 1,
    start: 75,
    end: null,
  });
  const a4 = sub({
    id: "a4",
    name: "gadget-maker",
    family: "gizmo",
    effort: null,
    wave: 1,
    start: 76,
    end: 90,
  });
  return model(main, [a1, a2, a3, a4], [{ at: 66, skipped: 600 }], 100);
}

/** Only a main agent, no subagents, no calls. */
export function emptyModel(duration = 10): ReplayModel {
  return model(mainAgent(duration, [], []), [], [], duration);
}
