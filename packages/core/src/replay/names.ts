/**
 * Identifier helpers for the replay builder. Each one turns a value from a parsed session into
 * a value the replay v1 schema accepts, or into its documented fallback. None of them ever
 * passes free text through: anything outside the schema's identifier pattern is reduced or
 * replaced.
 */

import type { KnownEffortLevel } from "../model/raw.js";
import {
  EFFORT_LEVELS,
  KNOWN_MODEL_FAMILIES,
  TOOL_KINDS,
  type EffortLevel,
  type ModelFamily,
  type ToolKind,
} from "../model/replay.js";

/** Name given to a subagent whose agent type is unknown or cannot be made an identifier. */
export const FALLBACK_AGENT_NAME = "subagent";

/** Server label used when an MCP call's server name is unknown or cannot be made an identifier. */
export const FALLBACK_MCP_SERVER = "unknown";

/** Label used for a non-MCP call whose tool name cannot be made an identifier. */
export const FALLBACK_TOOL_NAME = "unknown";

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FAMILY_WORD = /^[a-z][a-z0-9]*$/;

/**
 * Agent type to a schema `agentName`: letters, digits and `._:-`, starting with a letter or
 * digit, at most 64 characters. Other characters become `-`. Returns `subagent` when nothing
 * usable is left.
 */
export function agentNameOf(agentType: string | null): string {
  if (agentType === null) return FALLBACK_AGENT_NAME;
  const cleaned = agentType
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return cleaned === "" ? FALLBACK_AGENT_NAME : cleaned;
}

/** A model id the schema accepts, or `null`. Values such as `<synthetic>` become `null`. */
export function modelIdOf(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  return MODEL_PATTERN.test(model) ? model : null;
}

/**
 * Model family for a Claude Code model id: the first alphabetic word after `claude-`
 * (`claude-opus-5-5` gives `opus`, `claude-3-5-sonnet-20241022` gives `sonnet`). A bare
 * alias that is itself a known family word (`sonnet`) gives that family. Otherwise `unknown`.
 */
export function familyOf(model: string | null): ModelFamily {
  if (model === null) return "unknown";
  const lower = model.toLowerCase();
  if (lower.startsWith("claude-")) {
    for (const word of lower.slice("claude-".length).split("-")) {
      if (FAMILY_WORD.test(word) && word.length <= 32) return word;
    }
    return "unknown";
  }
  return (KNOWN_MODEL_FAMILIES as readonly string[]).includes(lower) ? lower : "unknown";
}

/** A replay effort level, or `null` for a missing or unrecognised value. */
export function effortOf(effort: KnownEffortLevel | string | null | undefined): EffortLevel | null {
  return typeof effort === "string" && (EFFORT_LEVELS as readonly string[]).includes(effort)
    ? (effort as EffortLevel)
    : null;
}

/** The parsed call's kind, copied. A value outside `TOOL_KINDS` (bad input) becomes `other`. */
export function toolKindOf(kind: string): ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(kind) ? (kind as ToolKind) : "other";
}

/** MCP server from `mcp__<server>__<tool>`, or `null` when the name has another form. */
function serverFromName(name: string): string | null {
  const match = /^mcp__(.+?)__/.exec(name);
  return match?.[1] ?? null;
}

function serverLabel(server: string | null): string {
  if (server === null) return FALLBACK_MCP_SERVER;
  const cleaned = server
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return cleaned === "" ? FALLBACK_MCP_SERVER : cleaned;
}

/**
 * Display label for a tool call. An `mcp` call becomes `mcp:<server>`, so the MCP tool name
 * never reaches the replay. Any other call keeps the runtime name, reduced to the schema's
 * `[A-Za-z][A-Za-z0-9_]{0,63}`. A non-MCP call whose name still looks like a raw MCP name is
 * labelled `mcp` (the schema rejects the raw form, and `mcp:` is reserved for kind `mcp`).
 */
export function toolLabelOf(name: string, kind: ToolKind, mcpServer: string | null): string {
  if (kind === "mcp") return `mcp:${serverLabel(mcpServer ?? serverFromName(name))}`;
  const cleaned = name
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 64);
  if (cleaned === "") return FALLBACK_TOOL_NAME;
  if (cleaned.startsWith("mcp__")) return "mcp";
  return cleaned;
}

/**
 * The most frequent non-null value, ties broken by first appearance. `null` when there is
 * none. Used for the dominant model and effort of an agent.
 */
export function dominant<T extends string>(values: readonly (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  // Map iteration follows first insertion, so a strict comparison keeps the earliest on a tie.
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Callsigns for agents in id order. A name that appears once keeps its name; a repeated name
 * gets `#n` by position among the agents with that name (`code-reviewer#1`,
 * `code-reviewer#2`). `fixed` holds callsigns that must not change (agents from a previous
 * snapshot, and the main agent); they are kept as given and count as positions.
 */
export function assignCallsigns(
  names: readonly string[],
  fixed: readonly (string | null)[] = [],
): string[] {
  const totals = new Map<string, number>();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const used = new Set<string>(fixed.filter((value): value is string => value !== null));
  const seen = new Map<string, number>();
  return names.map((name, index) => {
    const position = (seen.get(name) ?? 0) + 1;
    seen.set(name, position);
    const kept = fixed[index];
    if (kept !== undefined && kept !== null) return kept;
    let candidate = (totals.get(name) ?? 0) > 1 ? `${name}#${position}` : name;
    let bump = position;
    while (used.has(candidate)) {
      bump += 1;
      candidate = `${name}#${bump}`;
    }
    used.add(candidate);
    return candidate;
  });
}
