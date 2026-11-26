/**
 * Claude Code tool names to `ToolKind`. The parser is the only place that reads a tool name
 * to decide behaviour; the replay builder and the renderer use `kind`.
 */

import type { ToolKind } from "../model/replay.js";

/** Kind and MCP server of one tool name. */
export interface ToolClassification {
  readonly kind: ToolKind;
  /** Server name when the tool is `mcp__<server>__<tool>`, otherwise `null`. */
  readonly mcpServer: string | null;
}

// A Map, not an object literal, so names such as `constructor` cannot hit the prototype.
const BUILT_IN_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["Bash", "shell"],
  ["Read", "read"],
  ["Grep", "read"],
  ["Glob", "read"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["Agent", "agent"],
  ["Task", "agent"],
  ["SubagentHandback", "agent"],
]);

// `mcp__<server>__<tool>`: the server ends at the first `__` after the prefix. Both parts
// must be non-empty.
const MCP_NAME = /^mcp__(.+?)__(.+)$/s;

/**
 * Classify a Claude Code tool name.
 *
 * `Bash` is `shell`; `Read`, `Grep` and `Glob` are `read`; `Edit` and `Write` are `edit`;
 * `Agent`, `Task` and `SubagentHandback` are `agent`; `mcp__<server>__<tool>` is `mcp`;
 * every other name is `other`. Names are matched exactly (case-sensitive).
 */
export function classifyClaudeCodeTool(name: string): ToolClassification {
  const match = MCP_NAME.exec(name);
  if (match !== null && match[1] !== undefined) {
    return { kind: "mcp", mcpServer: match[1] };
  }
  return { kind: BUILT_IN_KINDS.get(name) ?? "other", mcpServer: null };
}
