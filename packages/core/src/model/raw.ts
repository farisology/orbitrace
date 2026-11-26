/**
 * Raw input types: one JSON object per transcript line, the subagent meta file, and the
 * optional live session registry entry.
 *
 * The Claude Code transcript format is internal and has no published schema. It can change
 * in any release. These types are therefore tolerant:
 *
 * - every field is optional, because any field can be missing in some version;
 * - every object keeps an index signature, so keys added by a later version still fit;
 * - a line whose `type` this package does not know is still a valid `RawLine`
 *   (`RawUnknownLine`). The parser skips such lines and counts them by type.
 *
 * Raw values can hold user content (prompts, replies, tool inputs and outputs, paths,
 * command lines). Nothing in this file may be copied into a replay model. See
 * `replay.ts` for the export shape.
 *
 * Shape observed in Claude Code versions 2.1.234 to 2.1.332.
 */

/** Line `type` values the parser knows about. Any other value is an unknown line. */
export const KNOWN_RAW_LINE_TYPES = [
  "user",
  "assistant",
  "system",
  "attachment",
  "mode",
  "ai-title",
  "last-prompt",
  "file-history-snapshot",
  "queue-operation",
  "tools-used",
] as const;

export type KnownRawLineType = (typeof KNOWN_RAW_LINE_TYPES)[number];

/** Effort values seen on assistant lines. Other strings may appear in later versions. */
export const KNOWN_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type KnownEffortLevel = (typeof KNOWN_EFFORT_LEVELS)[number];

/** Keys common to every line. All optional. Unknown keys are kept as `unknown`. */
export interface RawLineBase {
  readonly type?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  /** ISO 8601, UTC. */
  readonly timestamp?: string;
  readonly sessionId?: string;
  /** User content. Never exported. */
  readonly cwd?: string;
  /** User content. Never exported. */
  readonly gitBranch?: string;
  /** Claude Code version that wrote the line. */
  readonly version?: string;
  readonly entrypoint?: string;
  readonly isSidechain?: boolean;
  readonly [key: string]: unknown;
}

/** Token usage on an assistant message. When merging lines of one message, take the maximum of each field. */
export interface RawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly [key: string]: unknown;
}

export interface RawTextBlock {
  readonly type: "text";
  /** User content. Never exported. */
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface RawThinkingBlock {
  readonly type: "thinking";
  /** User content. Never exported. */
  readonly thinking?: string;
  readonly [key: string]: unknown;
}

export interface RawToolUseBlock {
  readonly type: "tool_use";
  /** Tool use id. A tool_result block refers to it with `tool_use_id`. */
  readonly id?: string;
  /** Built-in name such as `Bash`, or `mcp__<server>__<tool>` for MCP tools. */
  readonly name?: string;
  /** User content. Never exported. */
  readonly input?: unknown;
  readonly [key: string]: unknown;
}

export interface RawToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id?: string;
  readonly is_error?: boolean;
  /** User content. Never exported. */
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

/** A content block with a `type` this package does not know. */
export interface RawUnknownBlock {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export type RawContentBlock =
  RawTextBlock | RawThinkingBlock | RawToolUseBlock | RawToolResultBlock | RawUnknownBlock;

export interface RawAssistantMessage {
  /** One model reply is written as several lines that share this id. Merge them. */
  readonly id?: string;
  /** For example `claude-opus-5-5`. */
  readonly model?: string;
  readonly role?: string;
  readonly usage?: RawUsage;
  readonly content?: readonly RawContentBlock[];
  readonly [key: string]: unknown;
}

export interface RawUserMessage {
  readonly role?: string;
  /** A plain string (user content) or a list of blocks, which may include tool results. */
  readonly content?: string | readonly RawContentBlock[];
  readonly [key: string]: unknown;
}

export interface RawAssistantLine extends RawLineBase {
  readonly type: "assistant";
  readonly message?: RawAssistantMessage;
  /** `low`, `medium`, `high`, `xhigh` or `max` in observed versions. Kept as a string. */
  readonly effort?: string;
  readonly perTurnEffort?: unknown;
}

export interface RawUserLine extends RawLineBase {
  readonly type: "user";
  readonly message?: RawUserMessage;
}

export interface RawSystemLine extends RawLineBase {
  readonly type: "system";
}

/**
 * Any other line, including known types the parser does not use (`attachment`, `mode`,
 * `ai-title` and so on), internal tracing types, and types added by later versions.
 * `type` may even be missing.
 */
export interface RawUnknownLine extends RawLineBase {
  readonly type?: string;
}

/**
 * One parsed transcript line. Because `RawUnknownLine.type` is any string, TypeScript
 * cannot narrow this union on `type` alone; compare `line.type` and then treat the value
 * as the matching interface.
 */
export type RawLine = RawAssistantLine | RawUserLine | RawSystemLine | RawUnknownLine;

/**
 * The `agent-<agentId>.meta.json` file beside a subagent transcript.
 */
export interface RawSubagentMeta {
  /** Agent type, such as `code-reviewer`. */
  readonly agentType?: string;
  readonly model?: string;
  /** Id of the parent's `Agent` tool call that started this subagent. */
  readonly toolUseId?: string;
  readonly spawnDepth?: number;
  /** User content. Never read into a parsed session, never exported. */
  readonly description?: string;
  readonly isBuiltIn?: boolean;
  readonly finished?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Optional live registry entry, `<config>/sessions/<pid>.json`. Observed on one machine,
 * undocumented. A reader must check that `pid` is alive before trusting `status`.
 */
export interface RawLiveRegistryEntry {
  readonly pid?: number;
  readonly sessionId?: string;
  /** User content. Never exported. */
  readonly cwd?: string;
  /** `cli` or `claude-vscode` in observed versions. */
  readonly entrypoint?: string;
  readonly kind?: string;
  /** User content. Never exported. */
  readonly name?: string;
  /** `busy` or `idle` in observed versions. */
  readonly status?: string;
  readonly statusUpdatedAt?: string | number;
  readonly startedAt?: string | number;
  readonly updatedAt?: string | number;
  readonly version?: string;
  readonly [key: string]: unknown;
}

/** Text lines in file order. Works for a file read in Node and for a file dropped in a browser. */
export type LineSource = Iterable<string> | AsyncIterable<string>;

/** One subagent transcript and its meta file, as handed to the parser. */
export interface RawSubagentInput {
  /** The `<agentId>` part of `agent-<agentId>.jsonl`. Local only, never exported. */
  readonly agentId: string;
  /** Parsed meta file, or `null` when the file is missing or unreadable. */
  readonly meta: RawSubagentMeta | null;
  readonly lines: LineSource;
}

/**
 * Everything the parser needs for one session. Built in one of two places:
 * - on the host, by a source adapter from files on disk (ticket #7);
 * - in the app, from a transcript file the user dropped, with an empty `subagents` list
 *   (ticket #11). The app then calls `parseSession` and `buildReplay` itself, and the raw
 *   lines never cross the host transport.
 */
export interface SessionInput {
  readonly main: LineSource;
  readonly subagents: readonly RawSubagentInput[];
}
