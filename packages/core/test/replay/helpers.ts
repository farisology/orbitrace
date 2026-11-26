// Test helpers for the replay builder. Every value here is invented: agent types, model ids,
// tool names, ids and times are synthetic and describe no real session.
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import schema from "../../schema/replay-v1.schema.json" with { type: "json" };
import {
  FORBIDDEN_REPLAY_KEYS,
  type KnownEffortLevel,
  type ParsedReply,
  type ParsedRun,
  type ParsedSession,
  type ParsedSubagentRun,
  type ParsedToolCall,
  type ReplayModel,
  type ReplayTotals,
  type ToolKind,
} from "../../src/index.js";

const ajv = new Ajv2020({
  strict: true,
  strictTuples: false,
  allowUnionTypes: true,
  allErrors: true,
});
const validate = ajv.compile(schema);

/** Synthetic session start: 2030-01-01T00:00:00Z. */
export const BASE = Date.UTC(2030, 0, 1);

/** Epoch milliseconds `seconds` after `BASE`. */
export const at = (seconds: number): number => BASE + Math.round(seconds * 1000);

export interface ReplySpec {
  readonly id: string;
  readonly t: number;
  readonly last?: number;
  readonly model?: string | null;
  readonly effort?: KnownEffortLevel | null;
  readonly tokens?: readonly [number, number, number, number];
  readonly calls?: readonly string[];
}

export function reply(spec: ReplySpec): ParsedReply {
  const [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens] = spec.tokens ?? [
    10, 20, 30, 40,
  ];
  return {
    messageId: spec.id,
    model: spec.model === undefined ? "claude-opus-5-5" : spec.model,
    effort: spec.effort === undefined ? "high" : spec.effort,
    firstAt: at(spec.t),
    lastAt: at(spec.last ?? spec.t),
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
    toolUseIds: spec.calls ?? [],
    lineCount: 1,
  };
}

export interface CallSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: ToolKind;
  readonly msg: string;
  readonly t: number;
  /** Result time; `null` for no result. */
  readonly end: number | null;
  readonly error?: boolean;
  readonly mcpServer?: string | null;
  readonly spawned?: string | null;
}

export function call(spec: CallSpec): ParsedToolCall {
  return {
    toolUseId: spec.id,
    name: spec.name,
    mcpServer: spec.mcpServer ?? null,
    kind: spec.kind,
    messageId: spec.msg,
    startedAt: at(spec.t),
    endedAt: spec.end === null ? null : at(spec.end),
    isError: spec.end === null ? null : (spec.error ?? false),
    spawnedAgentId: spec.spawned ?? null,
  };
}

/** A run whose start and end are the first and last times of its replies and calls. */
export function run(
  replies: readonly ParsedReply[],
  toolCalls: readonly ParsedToolCall[],
  bounds: { readonly start?: number; readonly end?: number } = {},
): ParsedRun {
  const times = [
    ...replies.flatMap((r) => [r.firstAt, r.lastAt]),
    ...toolCalls.flatMap((c) => (c.endedAt === null ? [c.startedAt] : [c.startedAt, c.endedAt])),
  ];
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  return {
    replies,
    toolCalls,
    userLines: toolCalls.length,
    startedAt: bounds.start === undefined ? first : at(bounds.start),
    endedAt: bounds.end === undefined ? last : at(bounds.end),
  };
}

export interface SubSpec {
  readonly agentId: string;
  readonly agentType: string | null;
  readonly parentToolUseId: string | null;
  readonly parentAgentId: string | null;
  readonly model?: string | null;
  readonly run: ParsedRun;
}

export function sub(spec: SubSpec): ParsedSubagentRun {
  return {
    ...spec.run,
    agentId: spec.agentId,
    agentType: spec.agentType,
    model: spec.model ?? null,
    spawnDepth: 1,
    isBuiltIn: false,
    finished: true,
    parentToolUseId: spec.parentToolUseId,
    parentAgentId: spec.parentAgentId,
  };
}

export function session(
  main: ParsedRun,
  subagents: readonly ParsedSubagentRun[] = [],
): ParsedSession {
  return {
    runtime: "claude-code",
    sessionId: "synthetic-session",
    main,
    subagents,
    versionsSeen: ["9.9.9"],
    lines: { total: 0, unknownByType: {}, malformed: 0 },
  };
}

/** Every property name anywhere in a JSON value. */
export function allKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, found);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      allKeys(child, found);
    }
  }
  return found;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Asserts that a built model validates against the v1 schema, holds no forbidden key, and
 * keeps every rule from docs/replay-format.md that the schema cannot express.
 */
export function expectValidReplay(model: ReplayModel): void {
  const json: unknown = JSON.parse(JSON.stringify(model));
  const ok = validate(json);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
  expect(json).toEqual(model);

  const keys = allKeys(json);
  for (const key of FORBIDDEN_REPLAY_KEYS)
    expect({ key, present: keys.has(key) }).toEqual({ key, present: false });

  for (const agent of model.agents) {
    const totals: ReplayTotals = {
      toolCalls: agent.tools.length,
      failedToolCalls: agent.tools.filter((tool) => tool.failed).length,
      replies: agent.replies.length,
      inputTokens: sum(agent.replies.map((r) => r.inputTokens)),
      outputTokens: sum(agent.replies.map((r) => r.outputTokens)),
      cacheReadTokens: sum(agent.replies.map((r) => r.cacheReadTokens)),
      cacheCreationTokens: sum(agent.replies.map((r) => r.cacheCreationTokens)),
    };
    expect(agent.totals).toEqual(totals);
    const starts = agent.tools.map((tool) => tool.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const ts = agent.replies.map((r) => r.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(agent.tools.filter((tool) => tool.end !== null && tool.end < tool.start)).toEqual([]);
    if (agent.end !== null) expect(agent.end).toBeGreaterThanOrEqual(agent.start);
  }
  const keysOfTotals = Object.keys(model.agents[0].totals) as (keyof ReplayTotals)[];
  for (const key of keysOfTotals) {
    expect({ key, value: model.totals[key] }).toEqual({
      key,
      value: sum(model.agents.map((agent) => agent.totals[key])),
    });
  }
  expect(model.totals.agents).toBe(model.agents.length);
  expect(model.totals.realDuration).toBe(
    model.totals.duration + model.warps.reduce((acc, warp) => acc + warp.skipped, 0),
  );
  const subs = model.agents.slice(1);
  expect(subs.map((agent) => agent.id)).toEqual(subs.map((_, i) => `a${i + 1}`));
  const ids = new Set<string>(model.agents.map((agent) => agent.id));
  for (const agent of subs) expect(ids.has(String(agent.parent))).toBe(true);
  const callsigns = model.agents.map((agent) => agent.callsign);
  expect(new Set(callsigns).size).toBe(callsigns.length);
  const warpAts = model.warps.map((warp) => warp.at);
  expect(warpAts).toEqual([...warpAts].sort((a, b) => a - b));
}
