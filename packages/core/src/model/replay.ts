/**
 * ReplayModel v1: the structure-only replay that the renderer draws and that export writes.
 *
 * A replay is meant to be safe to share. It holds structure and timing only. There is no
 * field for message text, thinking, tool inputs or outputs, file paths, command lines, the
 * working directory, the git branch, the session title, the session id or a subagent
 * description, and the JSON Schema (`schema/replay-v1.schema.json`) rejects any property
 * it does not list. String fields are limited by schema patterns to identifiers (no spaces),
 * so a free-text value cannot be stored in them either.
 *
 * Time: every time value is a number of seconds from the session start on the compressed
 * timeline, that is, after idle gaps were cut (see `ReplayWarp`). A replay carries no
 * wall-clock timestamps.
 *
 * Append stability. Live view builds a new snapshot of one session on every change, with an
 * increasing `now`, and passes the previous snapshot as `BuildReplayOptions.previous`.
 * Between two such snapshots the replay builder (ticket #8) guarantees:
 *
 * (a) every agent in the earlier snapshot is in the later one with the same `id`,
 *     `callsign`, `parent` and `wave`, at the same index in `agents`;
 * (b) new subagents get the next free ids and are appended (see `ReplayAgentId`);
 * (c) an existing entry in `tools` or `replies` changes only to fill in `end` or `failed`
 *     (and a reply's token counts, which only grow while its lines arrive); new entries are
 *     only appended;
 * (d) existing warps never move and none is added before them; only the last warp's
 *     `skipped` may grow, and new warps are appended.
 *
 * Values that only grow or fill in may change: an agent's `end` (from `null`), `model`,
 * `family` and `effort` (from `null` or `unknown`), totals, `duration` and `realDuration`.
 * A renderer can therefore keep selection and per-agent state keyed by agent id across
 * snapshots (see `OrreryHandle.updateModel` in @orbitrace/renderer).
 */

/** The only value of `formatVersion` this file describes. Any change to the shape bumps it. */
export const REPLAY_FORMAT_VERSION = 1 as const;

export type ReplayFormatVersion = typeof REPLAY_FORMAT_VERSION;

/**
 * Agent id inside a replay. Assigned by the replay builder, never the runtime's own agent id:
 * `main` for the main agent, `a1`, `a2`, ... for subagents.
 *
 * Fresh build (no `previous` snapshot): subagents linked to a parent call are numbered in the
 * order of that call, by the call's start time, then by its `tool_use` block order within one
 * reply. Subagents with no link to a parent call follow, in `ParsedSession.subagents` order.
 *
 * Live build (`previous` given): agents in `previous` keep their ids. Subagents new in this
 * snapshot get the next free numbers, ordered among themselves by the same rule. So a
 * subagent transcript found one poll late is appended; it never shifts the ids, callsigns or
 * waves of agents already shown.
 */
export type ReplayAgentId = "main" | `a${number}`;

/**
 * Model families the renderer has a shape for. `unknown` is drawn as a circle. This list is
 * not a limit on what a replay may hold; see `ModelFamily`.
 */
export const KNOWN_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku", "unknown"] as const;

export type KnownModelFamily = (typeof KNOWN_MODEL_FAMILIES)[number];

/**
 * Model family: an open, lower-case identifier (schema pattern `^[a-z][a-z0-9-]{0,31}$`).
 *
 * The replay builder writes the family word as derived from the model id, whether or not it
 * is in `KNOWN_MODEL_FAMILIES`. For Claude Code it is the word after `claude-`
 * (`claude-opus-5-5` gives `opus`). A parser for another runtime defines its own derivation.
 * The builder writes `unknown` only when the model is `null` or no word can be derived.
 *
 * A renderer draws any family it does not know as `unknown` (a circle). A new model family,
 * or another runtime's models, therefore needs no new format version, and the real family
 * stays in the file for a later renderer that knows it.
 */
// `string & {}` keeps editor completion for the known values while accepting any string.
export type ModelFamily = KnownModelFamily | (string & {});

/** Effort levels in a replay. Any other raw value becomes `null`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Seconds from session start on the compressed timeline. Non-negative. */
export type ReplaySeconds = number;

/**
 * What a tool call does, independent of the runtime that made it. The parser that knows the
 * runtime sets it (see `ParsedToolCall.kind`); the replay builder copies it; the renderer
 * colours and treats a call by `kind` only and uses `name` only as a label.
 *
 * - `shell`: runs a shell command.
 * - `read`: reads or searches files.
 * - `edit`: changes or creates files.
 * - `agent`: starts an agent or hands back from one.
 * - `mcp`: any tool served by an MCP server. `name` is then `mcp:<server>`.
 * - `other`: any tool that fits none of the above.
 */
export const TOOL_KINDS = ["shell", "read", "edit", "agent", "mcp", "other"] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * One tool call. MCP tools are reduced to the server name: `mcp__<server>__<tool>` becomes
 * `mcp:<server>`. Other tools keep the runtime's name, such as `Bash` or `Agent`.
 */
export interface ReplayToolCall {
  /** Label only. Never used to decide colour or behaviour; `kind` is for that. */
  readonly name: string;
  /** `mcp` exactly when `name` starts with `mcp:`. */
  readonly kind: ToolKind;
  readonly start: ReplaySeconds;
  /** `null` when no result was seen (still running, or the result line is missing). */
  readonly end: ReplaySeconds | null;
  /** `true` when the result had `is_error`. `false` when it did not, or when there is no result yet. */
  readonly failed: boolean;
}

/** One model reply (merged from all lines that share a message id) and its token usage. */
export interface ReplayReply {
  /** Time of the first line of the reply. */
  readonly t: ReplaySeconds;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** Sums over one agent, or over the whole session. Token fields are sums of reply values. */
export interface ReplayTotals {
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly replies: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

interface ReplayAgentBase {
  /** Agent type, such as `code-reviewer` or `general-purpose`. `main` for the main agent. */
  readonly name: string;
  /** `name`, plus `#n` when the same name appears more than once (`code-reviewer#2`). */
  readonly callsign: string;
  /** Model id, such as `claude-opus-5-5`. `null` when unknown. */
  readonly model: string | null;
  /** Open identifier; see `ModelFamily`. */
  readonly family: ModelFamily;
  readonly effort: EffortLevel | null;
  readonly start: ReplaySeconds;
  /** `null` while the agent is still running (live view). */
  readonly end: ReplaySeconds | null;
  /** In start order. */
  readonly tools: readonly ReplayToolCall[];
  /** In time order. */
  readonly replies: readonly ReplayReply[];
  readonly totals: ReplayTotals;
}

/** The main agent. It is always `agents[0]`. */
export interface ReplayMainAgent extends ReplayAgentBase {
  readonly id: "main";
  readonly name: "main";
  readonly callsign: "main";
  readonly parent: null;
  readonly wave: null;
}

/** A subagent. `parent` is the agent whose `Agent` call started it. */
export interface ReplaySubagent extends ReplayAgentBase {
  readonly id: `a${number}`;
  readonly parent: ReplayAgentId;
  /**
   * Wave index from 0. Walk subagents in id order: `a1` is in wave 0; each next subagent
   * opens a new wave (the current wave plus 1) when it starts more than the wave gap (60 s by
   * default) after the latest start among subagents with smaller ids, and otherwise joins the
   * current wave. A wave depends only on agents with smaller ids, so appending an agent never
   * changes an existing wave. When id order matches start order (the usual case) this is the
   * prototype's rule: sort by start, new wave after a gap.
   */
  readonly wave: number;
}

export type ReplayAgent = ReplayMainAgent | ReplaySubagent;

/**
 * An idle gap removed from the timeline. In a live build, warps from `previous` are kept as
 * they are; a time that falls inside a gap an earlier snapshot already cut is placed at that
 * warp's `at`. To map a compressed time `t` to real seconds from
 * the session start, add `skipped` of every warp whose `at` is less than `t`.
 */
export interface ReplayWarp {
  /** Compressed time at which the cut sits. */
  readonly at: ReplaySeconds;
  /** Real seconds removed at this point. */
  readonly skipped: number;
}

export interface ReplaySessionTotals extends ReplayTotals {
  readonly agents: number;
  /** Length of the compressed timeline. */
  readonly duration: ReplaySeconds;
  /** Real length: `duration` plus the sum of all warp `skipped` values. */
  readonly realDuration: number;
}

export interface ReplayModel {
  readonly formatVersion: ReplayFormatVersion;
  /** Main agent first, then subagents in id order (`a1`, `a2`, ...). */
  readonly agents: readonly [ReplayMainAgent, ...ReplaySubagent[]];
  /** In `at` order. */
  readonly warps: readonly ReplayWarp[];
  readonly totals: ReplaySessionTotals;
}

/**
 * Property names that must never appear anywhere in a replay. The type test proves no
 * replay type declares them; the schema test proves the schema rejects them.
 */
export const FORBIDDEN_REPLAY_KEYS = [
  "text",
  "thinking",
  "content",
  "message",
  "prompt",
  "input",
  "output",
  "result",
  "path",
  "file",
  "filePath",
  "command",
  "cwd",
  "gitBranch",
  "branch",
  "title",
  "description",
  "sessionId",
  "agentId",
  "toolUseId",
  "uuid",
  "timestamp",
] as const;

export type ForbiddenReplayKey = (typeof FORBIDDEN_REPLAY_KEYS)[number];
