// Hand-built replays for the Pulse tests. Every value is invented.
import type {
  PulseReport,
  PulseSessionInput,
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplaySubagent,
  ReplayToolCall,
  ReplayTotals,
  ReplayWarp,
  ToolKind,
} from "../../src/index.js";

/** A tool call: name, kind, start, end (`null` for open), failed. */
export function tool(
  name: string,
  kind: ToolKind,
  start = 1,
  end: number | null = start + 1,
  failed = false,
): ReplayToolCall {
  return { name, kind, start, end, failed };
}

export function reply(t: number, input = 10, output = 20, cacheRead = 30, cacheCreation = 40) {
  return {
    t,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  } satisfies ReplayReply;
}

function totalsOf(tools: readonly ReplayToolCall[], replies: readonly ReplayReply[]): ReplayTotals {
  const sum = (key: keyof ReplayReply): number => replies.reduce((acc, r) => acc + r[key], 0);
  return {
    toolCalls: tools.length,
    failedToolCalls: tools.filter((t) => t.failed).length,
    replies: replies.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
  };
}

export interface ReplaySpec {
  /** Compressed length in seconds. */
  readonly duration: number;
  readonly warps?: readonly ReplayWarp[];
  readonly tools?: readonly ReplayToolCall[];
  readonly replies?: readonly ReplayReply[];
  /** Tools of each subagent; one subagent per entry. */
  readonly subagents?: readonly (readonly ReplayToolCall[])[];
}

/** A replay with a main agent and the given subagents, all in wave 0. */
export function replayOf(spec: ReplaySpec): ReplayModel {
  const tools = spec.tools ?? [];
  const replies = spec.replies ?? [];
  const main: ReplayMainAgent = {
    id: "main",
    name: "main",
    callsign: "main",
    model: "claude-opus-5-5",
    family: "opus",
    effort: null,
    parent: null,
    wave: null,
    start: 0,
    end: spec.duration,
    tools,
    replies,
    totals: totalsOf(tools, replies),
  };
  const subs = (spec.subagents ?? []).map((subTools, index): ReplaySubagent => ({
    id: `a${index + 1}`,
    name: "widget-helper",
    callsign: index === 0 ? "widget-helper" : `widget-helper#${index + 1}`,
    model: "claude-haiku-4-5",
    family: "haiku",
    effort: null,
    parent: "main",
    wave: 0,
    start: 0,
    end: spec.duration,
    tools: subTools,
    replies: [],
    totals: totalsOf(subTools, []),
  }));
  const agents = [main, ...subs];
  const sum = (key: keyof ReplayTotals): number => agents.reduce((s, a) => s + a.totals[key], 0);
  const skipped = (spec.warps ?? []).reduce((s, w) => s + w.skipped, 0);
  return {
    formatVersion: 1,
    agents: [main, ...subs],
    warps: spec.warps ?? [],
    totals: {
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      agents: agents.length,
      duration: spec.duration,
      realDuration: spec.duration + skipped,
    },
  };
}

/** A Pulse input whose session ends at `lastActivity`. */
export function sessionOf(
  key: string,
  lastActivity: number,
  spec: ReplaySpec,
  extra: Partial<PulseSessionInput> = {},
): PulseSessionInput {
  return { summary: { key, lastActivity, live: "ended" }, replay: replayOf(spec), ...extra };
}

/** Every cell of a report's grid with something in it, as `weekday-hour`. */
export function filledCells(
  report: PulseReport,
): Record<string, { activeMs: number; idleMs: number; sessionsStarted: number }> {
  const filled: Record<string, { activeMs: number; idleMs: number; sessionsStarted: number }> = {};
  for (const row of report.hourOfWeek.cells) {
    for (const cell of row) {
      if (cell.activeMs === 0 && cell.idleMs === 0 && cell.sessionsStarted === 0) continue;
      filled[`${cell.weekday}-${cell.hour}`] = {
        activeMs: cell.activeMs,
        idleMs: cell.idleMs,
        sessionsStarted: cell.sessionsStarted,
      };
    }
  }
  return filled;
}

/** Sum of a field over every cell of the grid. */
export function gridSum(
  report: PulseReport,
  field: "activeMs" | "idleMs" | "sessionsStarted",
): number {
  let total = 0;
  for (const row of report.hourOfWeek.cells) for (const cell of row) total += cell[field];
  return total;
}
