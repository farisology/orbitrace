/**
 * ParsedSession: the parser's output (ticket #6) and the replay builder's input (ticket #8).
 *
 * A parsed session lives in memory on the user's machine only. It keeps local identifiers
 * (session id, runtime agent ids, tool use ids) so runs can be linked, but it holds no
 * message text, thinking, tool inputs, tool outputs, paths, command lines, working
 * directory, branch, title or subagent description. Nothing downstream needs them, and
 * leaving them out here means the replay builder cannot copy them by mistake.
 *
 * Times are Unix epoch milliseconds (UTC), taken from line timestamps.
 *
 * Missing timestamps (decided in #66). `ParsedReply.firstAt`, `ParsedReply.lastAt` and
 * `ParsedToolCall.startedAt` are always numbers. When the line they come from has no readable
 * `timestamp`, the parser uses, in order: the last readable timestamp on an earlier line of the
 * same transcript (any line type); else the first readable timestamp of that transcript, which
 * is on a later line; else `0`. So `0` means "this transcript has no readable timestamp at all", and that case is
 * exactly `ParsedRun.startedAt === null` for the run that holds the reply or call: check that,
 * not the value `0`, to tell a fallback from a real time. The same chain gives a result line's
 * time for `ParsedToolCall.endedAt`. Why not `EpochMs | null`: the fields were merged as numbers
 * and the parser and builder rely on that; a nullable type would change both for a case the run
 * already reports.
 */

import type { KnownEffortLevel } from "./raw.js";
import type { ToolKind } from "./replay.js";
import type { RuntimeId } from "./sources.js";

/** Unix epoch milliseconds. */
export type EpochMs = number;

/** Token usage of one merged reply: the maximum of each field across its lines, not the sum. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /**
   * #191. Cache creation tokens written to the 5-minute cache (`usage.cache_creation.
   * ephemeral_5m_input_tokens`), the maximum across the reply's lines. Absent, never 0, when no
   * line of the reply recorded it.
   */
  readonly cacheWrite5mTokens?: number;
  /** #191. The same for the 1-hour cache (`ephemeral_1h_input_tokens`). Absent when not recorded. */
  readonly cacheWrite1hTokens?: number;
}

/**
 * One assistant reply, merged from every line that shares `message.id`.
 */
export interface ParsedReply {
  /**
   * `message.id`. Local only. When an assistant line has no `message.id`, the parser uses the
   * line's `uuid`, and failing that `line-<n>`, where `<n>` counts such lines in the transcript
   * from 1. A reply keyed by a fallback is not merged with other lines unless they share it.
   */
  readonly messageId: string;
  /** Model id as written, for example `claude-opus-5-5`. `null` when missing. */
  readonly model: string | null;
  /** `null` when the line had no effort or an unrecognised value. */
  readonly effort: KnownEffortLevel | null;
  /** Timestamp of the first line of the reply. Missing timestamps: see the file header. */
  readonly firstAt: EpochMs;
  /** Timestamp of the last line of the reply. Missing timestamps: see the file header. */
  readonly lastAt: EpochMs;
  readonly usage: TokenUsage;
  /** Ids of the tool_use blocks in this reply: the union by block id across its lines. */
  readonly toolUseIds: readonly string[];
  /** Number of transcript lines merged into this reply. */
  readonly lineCount: number;
}

/**
 * One tool call paired with its result. Duration is the result line's timestamp minus the
 * call line's timestamp.
 */
export interface ParsedToolCall {
  /** tool_use block id. Local only. */
  readonly toolUseId: string;
  /** Raw tool name, for example `Bash` or `mcp__<server>__<tool>`. */
  readonly name: string;
  /** MCP server name when `name` is `mcp__<server>__<tool>`, otherwise `null`. */
  readonly mcpServer: string | null;
  /**
   * What the call does, set by the parser for this runtime. The replay builder copies it,
   * and nothing downstream reads `name` to decide behaviour. For Claude Code (ticket #6):
   * `Bash` is `shell`; `Read`, `Grep` and `Glob` are `read`; `Edit` and `Write` are `edit`;
   * `Agent`, its older name `Task`, and `SubagentHandback` are `agent`; any
   * `mcp__<server>__<tool>` is `mcp`; every other name is `other`. A parser for another
   * runtime maps its own tool names.
   */
  readonly kind: ToolKind;
  /** The reply that made the call. */
  readonly messageId: string;
  /** Timestamp of the line with the tool_use block. Missing timestamps: see the file header. */
  readonly startedAt: EpochMs;
  /**
   * Result line timestamp, or `null` when no result was seen. Never before `startedAt`: a result
   * stamped earlier than its call is treated as ending at the call's start.
   */
  readonly endedAt: EpochMs | null;
  /** `is_error` of the result, or `null` when no result was seen. */
  readonly isError: boolean | null;
  /**
   * For an `Agent` call: the runtime agent id of the subagent run it started, when the
   * run was found and linked. `null` otherwise.
   */
  readonly spawnedAgentId: string | null;
}

/** Messages and calls of one agent transcript (the main one or a subagent's). */
export interface ParsedRun {
  /** Merged assistant replies, in time order. */
  readonly replies: readonly ParsedReply[];
  /** Tool calls in start order, each paired with its result when one was found. */
  readonly toolCalls: readonly ParsedToolCall[];
  /** Number of user lines (prompts and tool results). Their content is not kept. */
  readonly userLines: number;
  /** First timestamp in the transcript, or `null` when it had none. */
  readonly startedAt: EpochMs | null;
  /** Last timestamp in the transcript, or `null` when it had none. */
  readonly endedAt: EpochMs | null;
}

/** A subagent run, linked to the parent call that started it. */
export interface ParsedSubagentRun extends ParsedRun {
  /** Runtime agent id (`agent-<agentId>.jsonl`). Local only. */
  readonly agentId: string;
  /** From the meta file, for example `code-reviewer`. `null` when the meta file was missing. */
  readonly agentType: string | null;
  /** Model from the meta file, else from the first reply. `null` when unknown. */
  readonly model: string | null;
  readonly spawnDepth: number | null;
  readonly isBuiltIn: boolean | null;
  readonly finished: boolean | null;
  /** The parent's `Agent` tool use id (meta `toolUseId`). `null` when unknown. */
  readonly parentToolUseId: string | null;
  /**
   * Runtime agent id of the parent run, `"main"` for the main transcript, or `null` when
   * the parent call was not found in any run. An unlinked run is kept, not dropped.
   */
  readonly parentAgentId: string | null;
}

/** Lines the parser did not use. Each count is a number of lines. */
export interface LineCounts {
  /**
   * Every line read, across all transcripts of the session. Blank and whitespace-only lines are
   * not counted, so a trailing newline is not a line.
   */
  readonly total: number;
  /** Lines whose `type` the parser does not know, keyed by that type. A missing type is keyed `""`. */
  readonly unknownByType: Readonly<Record<string, number>>;
  /** Lines that were not valid JSON objects. */
  readonly malformed: number;
}

export interface ParsedSession {
  /** Runtime that wrote the transcript. */
  readonly runtime: RuntimeId;
  /** `sessionId` from the lines, or `null` when none was seen. Local only, never exported. */
  readonly sessionId: string | null;
  readonly main: ParsedRun;
  /** In start order. */
  readonly subagents: readonly ParsedSubagentRun[];
  /** Distinct runtime versions seen (Claude Code's `version` line key), in first-seen order. */
  readonly versionsSeen: readonly string[];
  readonly lines: LineCounts;
}
