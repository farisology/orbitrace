/**
 * Parse one agent transcript (the main one or a subagent's) into a `ParsedRun`.
 *
 * Only structural facts are taken from each line: type, timestamp, message id, model,
 * effort, usage numbers (including the cache-write split by lifetime, #191), tool_use ids and
 * names, tool_result ids and `is_error`. Text,
 * thinking, tool inputs and outputs, paths and every other value are never read into the
 * result.
 *
 * Time of a line: its own `timestamp`, or, when that is missing or unreadable, the last
 * readable timestamp before it in the same transcript. Lines before the first readable
 * timestamp take that first timestamp. When a transcript has no readable timestamp at all,
 * its replies and calls get time 0 and the run's `startedAt` and `endedAt` are `null`.
 */

import type {
  EpochMs,
  ParsedReply,
  ParsedRun,
  ParsedToolCall,
  TokenUsage,
} from "../model/parsed.js";
import { KNOWN_EFFORT_LEVELS, KNOWN_RAW_LINE_TYPES, type KnownEffortLevel } from "../model/raw.js";
import type { LineSource } from "../model/raw.js";
import { readJsonLines } from "./lines.js";
import { classifyClaudeCodeTool } from "./tools.js";
import {
  asArray,
  asNonEmptyString,
  asOptionalTokenCount,
  asRecord,
  asTokenCount,
  maxOptional,
  parseTimestamp,
  type JsonRecord,
} from "./values.js";

/** A tool call whose `spawnedAgentId` is filled in later, when subagents are linked. */
export type LinkableToolCall = { -readonly [K in keyof ParsedToolCall]: ParsedToolCall[K] };

/** A parsed run whose tool calls can still be linked to subagent runs. */
export interface LinkableRun extends ParsedRun {
  readonly toolCalls: readonly LinkableToolCall[];
}

/** Facts about the session that are collected from every line of every transcript. */
export interface LineObserver {
  /** Called for every non-blank line. */
  line(): void;
  /** Called for a line that was not a JSON object. */
  malformed(): void;
  /** Called for a line whose `type` is not known. `""` when the type is missing. */
  unknown(type: string): void;
  /** Called for each line that is a JSON object. */
  object(line: JsonRecord): void;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(KNOWN_RAW_LINE_TYPES);
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(KNOWN_EFFORT_LEVELS);

interface PendingReply {
  readonly messageId: string;
  readonly order: number;
  model: string | null;
  effort: KnownEffortLevel | null;
  /** Line indexes (in `lineTimes`) of the lines merged into this reply. */
  readonly lineSlots: number[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `null` until a line records `usage.cache_creation.ephemeral_5m_input_tokens`. */
  cacheWrite5mTokens: number | null;
  /** `null` until a line records `usage.cache_creation.ephemeral_1h_input_tokens`. */
  cacheWrite1hTokens: number | null;
  readonly toolUseIds: string[];
}

interface PendingCall {
  readonly toolUseId: string;
  readonly order: number;
  name: string;
  readonly messageId: string;
  readonly slot: number;
}

interface PendingResult {
  readonly slot: number;
  readonly isError: boolean;
}

/** Collects one transcript line by line, then resolves times and pairings. */
class RunAccumulator {
  /** Time of each line that produced a reply line or a result, `null` until resolved. */
  private readonly lineTimes: (EpochMs | null)[] = [];
  private lastTime: EpochMs | null = null;
  private firstTime: EpochMs | null = null;
  private minTime: EpochMs | null = null;
  private maxTime: EpochMs | null = null;
  private userLines = 0;
  private syntheticIds = 0;
  private readonly replies = new Map<string, PendingReply>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly results = new Map<string, PendingResult>();

  /** Note a line's own timestamp, when readable, and return it. */
  private noteTime(line: JsonRecord): EpochMs | null {
    const own = parseTimestamp(line["timestamp"]);
    if (own !== null) {
      this.lastTime = own;
      this.firstTime ??= own;
      this.minTime = this.minTime === null ? own : Math.min(this.minTime, own);
      this.maxTime = this.maxTime === null ? own : Math.max(this.maxTime, own);
    }
    return own;
  }

  /** Record the time of a line that produced a reply line or a result, and return its slot. */
  private slotFor(line: JsonRecord): number {
    this.lineTimes.push(this.noteTime(line) ?? this.lastTime);
    return this.lineTimes.length - 1;
  }

  /** Track the run's first and last timestamp for a line that is not otherwise used. */
  observeTime(line: JsonRecord): void {
    this.noteTime(line);
  }

  assistant(line: JsonRecord): void {
    const message = asRecord(line["message"]);
    if (message === null) {
      this.observeTime(line);
      return;
    }
    const slot = this.slotFor(line);
    const messageId =
      asNonEmptyString(message["id"]) ??
      asNonEmptyString(line["uuid"]) ??
      `line-${(this.syntheticIds += 1)}`;

    let reply = this.replies.get(messageId);
    if (reply === undefined) {
      reply = {
        messageId,
        order: this.replies.size,
        model: null,
        effort: null,
        lineSlots: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        toolUseIds: [],
      };
      this.replies.set(messageId, reply);
    }
    reply.lineSlots.push(slot);
    reply.model ??= asNonEmptyString(message["model"]);
    if (reply.effort === null) {
      const effort = line["effort"];
      if (typeof effort === "string" && KNOWN_EFFORTS.has(effort)) {
        reply.effort = effort as KnownEffortLevel;
      }
    }

    const usage = asRecord(message["usage"]);
    if (usage !== null) {
      reply.inputTokens = Math.max(reply.inputTokens, asTokenCount(usage["input_tokens"]));
      reply.outputTokens = Math.max(reply.outputTokens, asTokenCount(usage["output_tokens"]));
      reply.cacheReadTokens = Math.max(
        reply.cacheReadTokens,
        asTokenCount(usage["cache_read_input_tokens"]),
      );
      reply.cacheCreationTokens = Math.max(
        reply.cacheCreationTokens,
        asTokenCount(usage["cache_creation_input_tokens"]),
      );
      // #191: the split by cache lifetime, when this Claude Code version writes it. Kept as
      // "not recorded" (null) until a line has a readable count, so it is never zero-filled.
      const split = asRecord(usage["cache_creation"]);
      if (split !== null) {
        reply.cacheWrite5mTokens = maxOptional(
          reply.cacheWrite5mTokens,
          asOptionalTokenCount(split["ephemeral_5m_input_tokens"]),
        );
        reply.cacheWrite1hTokens = maxOptional(
          reply.cacheWrite1hTokens,
          asOptionalTokenCount(split["ephemeral_1h_input_tokens"]),
        );
      }
    }

    for (const raw of asArray(message["content"])) {
      const block = asRecord(raw);
      if (block === null || block["type"] !== "tool_use") continue;
      const toolUseId = asNonEmptyString(block["id"]);
      if (toolUseId === null) continue;
      const name = asNonEmptyString(block["name"]);
      const existing = this.calls.get(toolUseId);
      if (existing !== undefined) {
        // Same block written again on a later line: keep the first, fill a missing name.
        if (existing.name === "" && name !== null) existing.name = name;
        continue;
      }
      this.calls.set(toolUseId, {
        toolUseId,
        order: this.calls.size,
        name: name ?? "",
        messageId,
        slot,
      });
      reply.toolUseIds.push(toolUseId);
    }
  }

  user(line: JsonRecord): void {
    this.userLines += 1;
    const message = asRecord(line["message"]);
    const blocks = message === null ? [] : asArray(message["content"]);
    let slot: number | null = null;
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (block === null || block["type"] !== "tool_result") continue;
      const toolUseId = asNonEmptyString(block["tool_use_id"]);
      if (toolUseId === null || this.results.has(toolUseId)) continue;
      slot ??= this.slotFor(line);
      this.results.set(toolUseId, { slot, isError: block["is_error"] === true });
    }
    if (slot === null) this.observeTime(line);
  }

  finish(): LinkableRun {
    const times = this.resolveTimes();
    const timeOf = (slot: number): EpochMs => times[slot] ?? 0;

    const replies: ParsedReply[] = [...this.replies.values()]
      .map((reply) => {
        const lineTimes = reply.lineSlots.map(timeOf);
        const usage: TokenUsage = {
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          cacheCreationTokens: reply.cacheCreationTokens,
          ...(reply.cacheWrite5mTokens === null
            ? {}
            : { cacheWrite5mTokens: reply.cacheWrite5mTokens }),
          ...(reply.cacheWrite1hTokens === null
            ? {}
            : { cacheWrite1hTokens: reply.cacheWrite1hTokens }),
        };
        return {
          order: reply.order,
          parsed: {
            messageId: reply.messageId,
            model: reply.model,
            effort: reply.effort,
            firstAt: Math.min(...lineTimes),
            lastAt: Math.max(...lineTimes),
            usage,
            toolUseIds: [...reply.toolUseIds],
            lineCount: reply.lineSlots.length,
          },
        };
      })
      .sort((a, b) => a.parsed.firstAt - b.parsed.firstAt || a.order - b.order)
      .map((entry) => entry.parsed);

    const toolCalls: LinkableToolCall[] = [...this.calls.values()]
      .map((call) => {
        const startedAt = timeOf(call.slot);
        const result = this.results.get(call.toolUseId);
        const { kind, mcpServer } = classifyClaudeCodeTool(call.name);
        const parsed: LinkableToolCall = {
          toolUseId: call.toolUseId,
          name: call.name,
          mcpServer,
          kind,
          messageId: call.messageId,
          startedAt,
          // A result stamped before its call is treated as ending at the call's start.
          endedAt: result === undefined ? null : Math.max(startedAt, timeOf(result.slot)),
          isError: result === undefined ? null : result.isError,
          spawnedAgentId: null,
        };
        return { order: call.order, parsed };
      })
      .sort((a, b) => a.parsed.startedAt - b.parsed.startedAt || a.order - b.order)
      .map((entry) => entry.parsed);

    return {
      replies,
      toolCalls,
      userLines: this.userLines,
      startedAt: this.minTime,
      endedAt: this.maxTime,
    };
  }

  /** Fill lines that had no timestamp before the first readable one. */
  private resolveTimes(): readonly (EpochMs | null)[] {
    const fallback = this.firstTime;
    return this.lineTimes.map((time) => time ?? fallback);
  }
}

/**
 * Read one transcript and return its run. Every line is reported to `observer`. Never
 * throws on a bad line; an error from the line source itself is passed on.
 */
export async function parseRun(lines: LineSource, observer: LineObserver): Promise<LinkableRun> {
  const run = new RunAccumulator();
  for await (const record of readJsonLines(lines)) {
    observer.line();
    if (record.kind === "malformed") {
      observer.malformed();
      continue;
    }
    const line = record.value;
    observer.object(line);
    const type = line["type"];
    if (type === "assistant") {
      run.assistant(line);
    } else if (type === "user") {
      run.user(line);
    } else {
      run.observeTime(line);
      if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
        observer.unknown(typeof type === "string" ? type : "");
      }
    }
  }
  return run.finish();
}
