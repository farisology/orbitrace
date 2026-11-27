/** What the inspector and timeline show about one agent. Pure functions over a replay. */

import {
  KNOWN_MODEL_FAMILIES,
  TOOL_KINDS,
  type ReplayAgent,
  type ReplayAgentId,
  type ReplayModel,
  type ToolKind,
} from "@orbitrace/core";

export interface KindCount {
  readonly kind: ToolKind;
  readonly calls: number;
  readonly failed: number;
}

/** Tool calls of one agent by kind, in `TOOL_KINDS` order, leaving out kinds with no calls. */
export function toolCallsByKind(agent: ReplayAgent): readonly KindCount[] {
  const counts = new Map<ToolKind, { calls: number; failed: number }>();
  for (const tool of agent.tools) {
    const entry = counts.get(tool.kind) ?? { calls: 0, failed: 0 };
    entry.calls += 1;
    if (tool.failed) entry.failed += 1;
    counts.set(tool.kind, entry);
  }
  return TOOL_KINDS.flatMap((kind) => {
    const entry = counts.get(kind);
    return entry === undefined ? [] : [{ kind, calls: entry.calls, failed: entry.failed }];
  });
}

/** Display name of each tool kind. */
export const KIND_LABELS: Readonly<Record<ToolKind, string>> = {
  shell: "Shell",
  read: "Read",
  edit: "Edit",
  agent: "Agent",
  mcp: "MCP",
  other: "Other",
};

/**
 * Whether the agent has not started, is running or has finished at compressed time `t`. Core's
 * one rule (issue 108), shared with the renderer, so the inspector and the orrery agree at an
 * agent's end time: running in `[start, end)`, finished from `end` on.
 */
export { agentPhase, type AgentPhase } from "@orbitrace/core";

/** `Opus`, `Haiku`. A family the renderer does not know keeps its own word. */
export function familyLabel(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

const FAMILY_SHAPES: Readonly<Record<string, string>> = {
  fable: "burst",
  opus: "hexagon",
  sonnet: "diamond",
  haiku: "triangle",
  unknown: "circle",
};

/**
 * Shape the orrery draws for a family, in words (design/identity.md), so the inspector says what
 * the canvas shows. Any family outside `KNOWN_MODEL_FAMILIES` is drawn as a circle.
 */
export function familyShape(family: string): string {
  const known = (KNOWN_MODEL_FAMILIES as readonly string[]).includes(family);
  return (known ? FAMILY_SHAPES[family] : undefined) ?? "circle";
}

/** Waves are numbered from 0 in a replay and from 1 on screen. */
export function waveLabel(wave: number | null): string {
  return wave === null ? "centre" : `Wave ${wave + 1}`;
}

/** The agent with this id, or `undefined`. */
export function findAgent(model: ReplayModel, id: ReplayAgentId | null): ReplayAgent | undefined {
  if (id === null) return undefined;
  return model.agents.find((agent) => agent.id === id);
}

/** Callsign of every agent by id. */
export function callsigns(model: ReplayModel): ReadonlyMap<ReplayAgentId, string> {
  return new Map(model.agents.map((agent) => [agent.id, agent.callsign]));
}

/** True when `value` has the shape of a replay agent id (`main`, `a1`, `a2`, ...). */
export function isAgentId(value: string): value is ReplayAgentId {
  return value === "main" || /^a[1-9]\d*$/.test(value);
}
