/**
 * Builds one synthetic Claude Code session: the main transcript, one transcript and one
 * meta file per subagent, and the facts that are true of the session by construction.
 *
 * A scenario scripts a session through AgentWriter calls (prompt, reply, use, spawn, idle).
 * Each writer keeps its own clock, so parallel subagents overlap in time the way they do in
 * a real session. Every value comes from the seed: no Math.random, no wall clock.
 */
import type {
  RawAssistantLine,
  RawAssistantMessage,
  RawContentBlock,
  RawToolResultBlock,
  RawUserLine,
  RawUserMessage,
} from "@orbitrace/core";
import {
  BUILT_IN_AGENT_TYPES,
  addUsage,
  maxUsage,
  zeroUsage,
  type FullUsage,
  type KnownEffortLevel,
  type RawLine,
  type RawSubagentMeta,
} from "./lines.js";
import { createRng, type Rng } from "./rng.js";
import {
  commandText,
  errorText,
  handbackText,
  promptText,
  relativeFilePath,
  replyText,
  resultText,
  searchWord,
  taskDescription,
  thinkingText,
  titleText,
} from "./vocabulary.js";

const HEX = "0123456789abcdef";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The Claude Code version written on fixture lines: inside the range the notes observed. */
export const FIXTURE_CLAUDE_VERSION = "2.1.300";

/** The id of the main agent in SessionFacts. Subagents use their agentId. */
export const MAIN_AGENT_ID = "main";

/**
 * Makes ids that have the length and alphabet of real ones but are plainly invented:
 * UUIDs start with a group of zeros, and message, request and tool-use ids carry "SYNTH".
 */
export class IdFactory {
  private readonly rng: Rng;
  private readonly used = new Set<string>();

  constructor(rng: Rng) {
    this.rng = rng;
  }

  private unique(make: () => string): string {
    for (;;) {
      const id = make();
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }

  private hex(length: number): string {
    return this.rng.chars(length, HEX);
  }

  /** A session id: 36 characters, `00000000-0000-4000-8000-` then 12 hex digits. */
  sessionId(): string {
    return this.unique(() => `00000000-0000-4000-8000-${this.hex(12)}`);
  }

  /** A line uuid: 36 characters, version-4 layout, first group all zeros. */
  uuid(): string {
    return this.unique(
      () =>
        `00000000-${this.hex(4)}-4${this.hex(3)}-${this.rng.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`,
    );
  }

  /** A message id: 28 characters. */
  messageId(): string {
    return this.unique(() => `msg_01SYNTH${this.rng.chars(17, BASE62)}`);
  }

  /** A request id: 28 characters. */
  requestId(): string {
    return this.unique(() => `req_01SYNTH${this.rng.chars(17, BASE62)}`);
  }

  /** A tool-use block id: 30 characters. */
  toolUseId(): string {
    return this.unique(() => `toolu_01SYNTH${this.rng.chars(17, BASE62)}`);
  }

  /** A subagent id: 17 lowercase hex digits, starting `a00000`. */
  agentId(): string {
    return this.unique(() => `a00000${this.hex(11)}`);
  }
}

/** How a tool call ends: with a result, with an error result, or with no result line. */
export type ToolOutcome = "ok" | "error" | "none";

export interface ToolSpec {
  name: string;
  input: Record<string, unknown>;
  /** Milliseconds between the call line and its result line. */
  durationMs: number;
  outcome: ToolOutcome;
}

export interface ToolOverrides {
  durationMs?: number;
  outcome?: ToolOutcome;
}

/** Makes tool calls with invented inputs. File paths sit under the synthetic project folder. */
export class ToolKit {
  private readonly rng: Rng;
  private readonly cwd: string;

  constructor(rng: Rng, cwd: string) {
    this.rng = rng;
    this.cwd = cwd;
  }

  private spec(
    name: string,
    input: Record<string, unknown>,
    minMs: number,
    maxMs: number,
    overrides: ToolOverrides,
  ): ToolSpec {
    // The duration is always drawn, so an override does not shift later random values.
    const drawn = this.rng.int(minMs, maxMs);
    return {
      name,
      input,
      durationMs: overrides.durationMs ?? drawn,
      outcome: overrides.outcome ?? "ok",
    };
  }

  private file(): string {
    return `${this.cwd}/${relativeFilePath(this.rng)}`;
  }

  bash(overrides: ToolOverrides = {}): ToolSpec {
    const input = { command: commandText(this.rng), description: "Synthetic command" };
    return this.spec("Bash", input, 350, 9000, overrides);
  }

  read(overrides: ToolOverrides = {}): ToolSpec {
    return this.spec("Read", { file_path: this.file() }, 25, 220, overrides);
  }

  edit(overrides: ToolOverrides = {}): ToolSpec {
    const input = {
      file_path: this.file(),
      old_string: "synthetic old line",
      new_string: "synthetic new line",
    };
    return this.spec("Edit", input, 40, 180, overrides);
  }

  write(overrides: ToolOverrides = {}): ToolSpec {
    const input = { file_path: this.file(), content: "Synthetic file body.\n" };
    return this.spec("Write", input, 40, 200, overrides);
  }

  grep(overrides: ToolOverrides = {}): ToolSpec {
    const input = { pattern: searchWord(this.rng), path: `${this.cwd}/src` };
    return this.spec("Grep", input, 60, 480, overrides);
  }

  glob(overrides: ToolOverrides = {}): ToolSpec {
    return this.spec("Glob", { pattern: "**/*.md" }, 30, 260, overrides);
  }

  toolSearch(overrides: ToolOverrides = {}): ToolSpec {
    const input = { query: searchWord(this.rng), max_results: 5 };
    return this.spec("ToolSearch", input, 90, 420, overrides);
  }

  /** A call to an MCP tool, named `mcp__<server>__<tool>`. */
  mcp(server: string, tool: string, overrides: ToolOverrides = {}): ToolSpec {
    const input = { query: searchWord(this.rng) };
    return this.spec(`mcp__${server}__${tool}`, input, 180, 2600, overrides);
  }

  /** A call to a tool with any name, for names a reader does not know. */
  custom(name: string, overrides: ToolOverrides = {}): ToolSpec {
    return this.spec(name, { note: searchWord(this.rng) }, 50, 600, overrides);
  }
}

/** One content block of a reply. Each block is written as its own transcript line. */
export type BlockSpec =
  | { kind: "thinking" }
  | { kind: "text"; text?: string }
  | { kind: "tool"; tool: ToolSpec }
  /** A block written exactly as given, for block types a reader does not know. */
  | { kind: "raw"; block: { type: string } & Record<string, unknown> }
  /** Writes the block at index `of` of the same reply a second time, on a new line. */
  | { kind: "repeat"; of: number };

export interface ReplyOptions {
  /**
   * One usage object per line. The default writes the same usage on every line of the
   * reply, which is what current Claude Code versions do.
   */
  usagePerLine?: readonly FullUsage[];
  /** Write each tool result right after its call line, between lines of the same reply. */
  interleaveResults?: boolean;
  /**
   * How the effort keys are written. Default "both": `effort` and `perTurnEffort` hold the
   * agent's effort. "nullPerTurn" writes `perTurnEffort: null`. "none" leaves both keys
   * out. Real lines show all three.
   */
  effortKeys?: "both" | "nullPerTurn" | "none";
}

export interface ToolCall {
  id: string;
  name: string;
  /** The uuid of the assistant line that holds the tool_use block. */
  lineUuid: string;
  /** Epoch milliseconds of that line. */
  calledAt: number;
  spec: ToolSpec;
  /** True once a result line was written. */
  resolved: boolean;
  failed: boolean;
}

export interface ReplyHandle {
  messageId: string;
  lineUuids: string[];
  /** The distinct tool calls of the reply, in block order. */
  calls: ToolCall[];
  /** The usage of the reply after merging its lines by maximum. */
  usage: FullUsage;
}

export interface UseOptions {
  thinking?: boolean;
  text?: boolean;
}

export interface SubagentSpec {
  agentType: string;
  model: string;
  effort: KnownEffortLevel;
  /** Default: true for the agent types that ship with Claude Code. */
  isBuiltIn?: boolean;
  /** Default true. False: the meta file says unfinished and the parent gets no result. */
  finished?: boolean;
  /** Default true. False leaves `model` out of the meta file, as some real files do. */
  modelInMeta?: boolean;
  /**
   * Default true. False leaves `isBuiltIn` and `finished` out of the meta file, as some real
   * files do. A reader then has to tell from the transcripts whether the subagent finished.
   */
  statusInMeta?: boolean;
  script: (agent: AgentWriter) => void;
}

export interface SpawnOptions {
  thinking?: boolean;
  text?: boolean;
  /** Default true. False when the subagents belong to the wave that is already running. */
  newWave?: boolean;
}

export interface HousekeepingOptions {
  /** Default true. */
  sessionId?: boolean;
  /** Default false. */
  timestamp?: boolean;
}

/** What is true of one agent's transcript, known from how it was written. */
export interface AgentFacts {
  /** "main" for the main agent, the agentId for a subagent. */
  id: string;
  /** The id of the agent that spawned this one. Null for the main agent. */
  parent: string | null;
  agentType: string | null;
  /** 0 for the main agent, 1 for its subagents, 2 for theirs. */
  spawnDepth: number;
  model: string;
  effort: KnownEffortLevel;
  /** False when the subagent never handed back. Always true for the main agent. */
  finished: boolean;
  lines: number;
  /** Number of lines per `type` value. */
  lineTypes: Record<string, number>;
  /** Distinct message ids. */
  replies: number;
  /** Distinct tool_use block ids. */
  toolCalls: number;
  /** Tool calls whose result has `is_error: true`. */
  failedToolCalls: number;
  /** Tool calls with no result line. */
  unfinishedToolCalls: number;
  /** Tool calls whose name starts with `mcp__`. */
  mcpToolCalls: number;
  /** Sum over replies of the per-field maximum across the lines of each reply. */
  usage: FullUsage;
  firstTimestamp: string;
  lastTimestamp: string;
}

export interface SessionTotals {
  lines: number;
  replies: number;
  toolCalls: number;
  failedToolCalls: number;
  unfinishedToolCalls: number;
  mcpToolCalls: number;
  usage: FullUsage;
}

/** What is true of a whole session, known from how it was written. */
export interface SessionFacts {
  /** The main agent first, then subagents in the order they were spawned. */
  agents: AgentFacts[];
  totals: SessionTotals;
  /**
   * Waves the scenario scripted: groups of subagents that start close together, with more
   * than 60 seconds between the last start of one group and the first start of the next.
   */
  scriptedWaves: number;
  /** Idle gaps the scenario scripted in the main transcript, in order. */
  scriptedIdleGaps: { seconds: number }[];
  /** Lines whose type the generator invented, per type, over all files of the session. */
  inventedLineTypes: Record<string, number>;
}

export interface GeneratedFile {
  /** Path relative to the synthetic config folder, with forward slashes. */
  path: string;
  content: string;
}

export interface GeneratedSubagent {
  agentId: string;
  agentType: string;
  /** Path of `agent-<agentId>.jsonl`, relative to the synthetic config folder. */
  transcriptPath: string;
  /** Path of `agent-<agentId>.meta.json`, relative to the synthetic config folder. */
  metaPath: string;
  /** What the meta file holds, as the contract's type. Its `description` is invented. */
  meta: RawSubagentMeta;
}

export interface BuiltSession {
  sessionId: string;
  /** The invented working directory written on every conversation line. */
  cwd: string;
  /** The project folder name: the working directory with non-alphanumerics as dashes. */
  projectDir: string;
  /** Path of the main transcript, relative to the synthetic config folder. */
  transcriptPath: string;
  subagents: GeneratedSubagent[];
  /** The main transcript, then a transcript and a meta file per subagent. */
  files: GeneratedFile[];
  expected: SessionFacts;
}

export interface SessionOptions {
  seed: string;
  /** Invented project name. The working directory becomes `/workspace/<project>`. */
  project: string;
  /** ISO 8601 UTC time of the first line. */
  startTime: string;
  model: string;
  effort: KnownEffortLevel;
  gitBranch?: string;
  entrypoint?: "cli" | "claude-vscode";
  version?: string;
  /** Lines the caller declares as invented types, so the facts can count them. */
  inventedLineTypes?: readonly string[];
}

interface AgentIdentity {
  agentId: string | null;
  parent: string | null;
  agentType: string | null;
  spawnDepth: number;
  model: string;
  effort: KnownEffortLevel;
}

interface SubagentRecord {
  writer: AgentWriter;
  agentType: string;
  meta: RawSubagentMeta;
}

/** Milliseconds a block takes to arrive, as [min, max], by block kind. */
const BLOCK_PAUSE_MS: Record<BlockSpec["kind"], readonly [number, number]> = {
  thinking: [1200, 9000],
  text: [600, 4200],
  tool: [300, 2600],
  raw: [300, 2000],
  repeat: [5, 40],
};

const EFFORT_THINKING_SCALE: Record<KnownEffortLevel, number> = {
  low: 0.4,
  medium: 0.7,
  high: 1,
  xhigh: 1.5,
  max: 2.2,
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function serialiseLines(lines: readonly RawLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** Writes the transcript of one agent. Get one from SessionBuilder.main or from spawn(). */
export class AgentWriter {
  readonly lines: RawLine[] = [];
  readonly tools: ToolKit;
  readonly rng: Rng;
  /** "main" or the agentId. */
  readonly id: string;
  readonly agentId: string | null;
  readonly model: string;
  readonly effort: KnownEffortLevel;
  readonly spawnDepth: number;
  /** The clock of this agent, in epoch milliseconds. A line is stamped with it. */
  now: number;

  private readonly session: SessionBuilder;
  private readonly identity: AgentIdentity;
  private readonly calls = new Map<string, ToolCall>();
  private readonly replies = new Map<string, FullUsage>();
  private lastUuid: string | null = null;
  private lastLineAt: number;
  private cachedTokens: number;
  private pendingTokens: number;
  private skipNextPause = false;
  private successResults = 0;
  private plainResults = 0;
  private handedBack = true;

  constructor(session: SessionBuilder, identity: AgentIdentity, rng: Rng, startMs: number) {
    this.session = session;
    this.identity = identity;
    this.rng = rng;
    this.id = identity.agentId ?? MAIN_AGENT_ID;
    this.agentId = identity.agentId;
    this.model = identity.model;
    this.effort = identity.effort;
    this.spawnDepth = identity.spawnDepth;
    this.now = startMs;
    this.lastLineAt = startMs;
    this.tools = new ToolKit(rng.fork("tools"), session.cwd);
    this.cachedTokens = identity.agentId === null ? rng.int(14000, 22000) : rng.int(6000, 12000);
    this.pendingTokens = rng.int(300, 2400);
  }

  /** Move this agent's clock forward. */
  advance(ms: number): this {
    if (ms < 0) throw new RangeError("advance() cannot move the clock back");
    this.now += ms;
    return this;
  }

  /**
   * The next line is stamped exactly `seconds` after the last one. Unlike advance(), no
   * random pause is added on top, so the length of the gap is known to the millisecond.
   */
  pauseFor(seconds: number): this {
    if (!(seconds > 0)) throw new RangeError("a pause needs a positive number of seconds");
    this.now = this.lastLineAt + Math.round(seconds * 1000);
    this.skipNextPause = true;
    return this;
  }

  /**
   * A scripted idle gap: a pauseFor() that is also recorded in the session facts. Only the
   * main agent may idle, since a running subagent counts as busy time.
   */
  idle(seconds: number): this {
    if (this.agentId !== null) throw new Error("only the main agent can idle");
    this.pauseFor(seconds);
    this.session.scriptedIdleGaps.push({ seconds });
    return this;
  }

  private pause(minMs: number, maxMs: number): void {
    // The value is always drawn, so skipping a pause does not shift later random values.
    const ms = this.rng.int(minMs, maxMs);
    if (this.skipNextPause) {
      this.skipNextPause = false;
      return;
    }
    this.now += ms;
  }

  private stamp(): string {
    if (this.now < this.lastLineAt) this.now = this.lastLineAt;
    this.lastLineAt = this.now;
    return toIso(this.now);
  }

  /**
   * Write a line that carries the common keys. With `chain` (the default) the next line
   * names this one as its parent.
   */
  conversationLine(type: string, fields: Record<string, unknown> = {}, chain = true): string {
    const uuid = this.session.ids.uuid();
    const timestamp = this.stamp();
    const line: RawLine = {
      parentUuid: this.lastUuid,
      isSidechain: this.agentId !== null,
      ...(this.agentId !== null ? { agentId: this.agentId } : {}),
      userType: "external",
      cwd: this.session.cwd,
      sessionId: this.session.sessionId,
      version: this.session.version,
      gitBranch: this.session.gitBranch,
      entrypoint: this.session.entrypoint,
      type,
      ...fields,
      uuid,
      timestamp,
    };
    this.lines.push(line);
    if (chain) this.lastUuid = uuid;
    return uuid;
  }

  /** Write a bookkeeping line: `type`, the given fields, and by default the session id. */
  housekeeping(
    type: string,
    fields: Record<string, unknown> = {},
    options: HousekeepingOptions = {},
  ): void {
    const line: RawLine = {
      type,
      ...fields,
      ...(options.sessionId !== false ? { sessionId: this.session.sessionId } : {}),
      ...(options.timestamp === true ? { timestamp: this.stamp() } : {}),
    };
    this.lines.push(line);
  }

  /** Write a user prompt: a `user` line whose content is a string. Returns the line uuid. */
  prompt(text?: string): string {
    this.pause(900, 6500);
    const content = text ?? promptText(this.rng);
    const message: RawUserMessage = { role: "user", content };
    return this.conversationLine("user", { message });
  }

  /** Write a `system` line. */
  system(subtype: string, fields: Record<string, unknown> = {}): string {
    this.pause(5, 60);
    return this.conversationLine("system", { subtype, ...fields, isMeta: false });
  }

  /** Write an `attachment` line. */
  attachment(): string {
    this.pause(5, 60);
    const attachment = { type: "synthetic_attachment", note: "Synthetic attachment." };
    return this.conversationLine("attachment", { attachment });
  }

  private nextUsage(blocks: readonly BlockSpec[]): FullUsage {
    let output = 0;
    for (const block of blocks) {
      if (block.kind === "thinking") {
        output += Math.round(this.rng.int(60, 520) * EFFORT_THINKING_SCALE[this.effort]);
      } else if (block.kind === "text") {
        output += this.rng.int(24, 320);
      } else if (block.kind === "tool" || block.kind === "raw") {
        output += this.rng.int(28, 190);
      }
    }
    const usage: FullUsage = {
      input_tokens: this.rng.int(3, 64),
      output_tokens: output,
      cache_read_input_tokens: this.cachedTokens,
      cache_creation_input_tokens: this.pendingTokens,
    };
    this.cachedTokens += this.pendingTokens;
    this.pendingTokens = output;
    return usage;
  }

  /**
   * Write one model reply. Each block becomes its own `assistant` line, and all lines of
   * the reply share one message id and one request id.
   */
  reply(blocks: readonly BlockSpec[], options: ReplyOptions = {}): ReplyHandle {
    if (blocks.length === 0) throw new Error("a reply needs at least one block");
    const perLine = options.usagePerLine;
    if (perLine !== undefined && perLine.length !== blocks.length) {
      throw new Error("usagePerLine needs one usage object per block");
    }
    const messageId = this.session.ids.messageId();
    const requestId = this.session.ids.requestId();
    const baseUsage = this.nextUsage(blocks);
    const stopReason = blocks.some((block) => block.kind === "tool") ? "tool_use" : "end_turn";

    const rendered: RawContentBlock[] = [];
    const lineUuids: string[] = [];
    const calls: ToolCall[] = [];
    let merged = zeroUsage();

    const effortKeys = options.effortKeys ?? "both";
    const effortFields: Pick<RawAssistantLine, "effort" | "perTurnEffort"> =
      effortKeys === "none"
        ? {}
        : {
            effort: this.effort,
            perTurnEffort: effortKeys === "nullPerTurn" ? null : this.effort,
          };

    blocks.forEach((block, index) => {
      const [minPause, maxPause] = BLOCK_PAUSE_MS[block.kind];
      this.pause(minPause, maxPause);
      let content: RawContentBlock;
      let pendingCall: { id: string; spec: ToolSpec } | null = null;
      switch (block.kind) {
        case "thinking":
          content = {
            type: "thinking",
            thinking: thinkingText(this.rng),
            signature: "synthetic-signature",
          };
          break;
        case "text":
          content = { type: "text", text: block.text ?? replyText(this.rng) };
          break;
        case "tool": {
          const id = this.session.ids.toolUseId();
          content = { type: "tool_use", id, name: block.tool.name, input: block.tool.input };
          pendingCall = { id, spec: block.tool };
          break;
        }
        case "raw":
          content = block.block;
          break;
        case "repeat": {
          const earlier = rendered[block.of];
          if (earlier === undefined) throw new Error(`repeat: no earlier block at ${block.of}`);
          content = earlier;
          break;
        }
      }
      rendered.push(content);
      const usage = perLine?.[index] ?? baseUsage;
      merged = maxUsage(merged, usage);
      const message: RawAssistantMessage = {
        id: messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [content],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { ...usage },
      };
      const fields: Partial<RawAssistantLine> = { message, requestId, ...effortFields };
      const uuid = this.conversationLine("assistant", fields);
      lineUuids.push(uuid);
      if (pendingCall !== null) {
        const call: ToolCall = {
          id: pendingCall.id,
          name: pendingCall.spec.name,
          lineUuid: uuid,
          calledAt: this.now,
          spec: pendingCall.spec,
          resolved: false,
          failed: false,
        };
        this.calls.set(call.id, call);
        calls.push(call);
        if (options.interleaveResults === true) this.results([call]);
      }
    });

    this.replies.set(messageId, merged);
    return { messageId, lineUuids, calls, usage: merged };
  }

  private writeResult(call: ToolCall, failed: boolean, text: string): void {
    const structured = call.name === "Agent" || call.name.startsWith("mcp__");
    // A real result line has is_error true on failure, and false or no key on success.
    // Successes alternate between the two forms, so any transcript with two successful
    // results holds both, whatever the seed.
    let errorKey: Pick<RawToolResultBlock, "is_error"> = {};
    if (failed) errorKey = { is_error: true };
    else {
      this.successResults += 1;
      if (this.successResults % 2 === 1) errorKey = { is_error: false };
    }
    const block: RawToolResultBlock = {
      tool_use_id: call.id,
      type: "tool_result",
      content: structured ? [{ type: "text", text }] : text,
      ...errorKey,
    };

    // The inner shape of toolUseResult is invented. It is a string, a list, an object or
    // absent on real lines, so fixtures cover all four: every third plain success has none.
    let toolUseResult: { toolUseResult?: unknown } = {};
    if (failed) toolUseResult = { toolUseResult: "Synthetic error result" };
    else if (structured) toolUseResult = { toolUseResult: [{ type: "text", text }] };
    else {
      this.plainResults += 1;
      if (this.plainResults % 3 !== 0) toolUseResult = { toolUseResult: { synthetic: true } };
    }
    const message: RawUserMessage = { role: "user", content: [block] };
    const fields: Partial<RawUserLine> = {
      message,
      ...toolUseResult,
      sourceToolAssistantUUID: call.lineUuid,
    };

    this.conversationLine("user", fields);
    call.resolved = true;
    call.failed = failed;
    this.pendingTokens += this.rng.int(60, 1800);
  }

  /**
   * Write the result lines of the given calls, in the order the calls finish. A call whose
   * outcome is "none", or that already has a result, is skipped.
   */
  results(calls: readonly ToolCall[]): void {
    const due = calls
      .map((call, order) => ({ call, order, at: call.calledAt + call.spec.durationMs }))
      .filter(({ call }) => !call.resolved && call.spec.outcome !== "none")
      .sort((a, b) => a.at - b.at || a.order - b.order);
    for (const { call, at } of due) {
      this.now = Math.max(this.now + 1, at);
      const failed = call.spec.outcome === "error";
      this.writeResult(call, failed, failed ? errorText(this.rng) : resultText(this.rng));
    }
  }

  /** One reply that calls the given tools, then their results. */
  use(tools: ToolSpec | readonly ToolSpec[], options: UseOptions = {}): ReplyHandle {
    const list: readonly ToolSpec[] = Array.isArray(tools) ? tools : [tools as ToolSpec];
    const blocks: BlockSpec[] = [];
    if (options.thinking === true) blocks.push({ kind: "thinking" });
    if (options.text === true) blocks.push({ kind: "text" });
    for (const tool of list) blocks.push({ kind: "tool", tool });
    const handle = this.reply(blocks);
    this.results(handle.calls);
    return handle;
  }

  /** One reply with text only, which ends the turn. */
  say(options: { thinking?: boolean; text?: string } = {}): ReplyHandle {
    const blocks: BlockSpec[] = [];
    if (options.thinking === true) blocks.push({ kind: "thinking" });
    blocks.push(
      options.text === undefined ? { kind: "text" } : { kind: "text", text: options.text },
    );
    return this.reply(blocks);
  }

  /**
   * One reply that calls the Agent tool once per child, then each child's whole transcript,
   * then the results in the order the children finish. An unfinished child gets no result.
   */
  spawn(children: readonly SubagentSpec[], options: SpawnOptions = {}): AgentWriter[] {
    if (children.length === 0) throw new Error("spawn() needs at least one child");
    const blocks: BlockSpec[] = [];
    if (options.thinking === true) blocks.push({ kind: "thinking" });
    if (options.text === true) blocks.push({ kind: "text" });
    const tasks = children.map((child) => ({
      description: taskDescription(this.rng),
      prompt: promptText(this.rng),
      child,
    }));
    for (const task of tasks) {
      const input = {
        description: task.description,
        prompt: task.prompt,
        subagent_type: task.child.agentType,
      };
      blocks.push({ kind: "tool", tool: { name: "Agent", input, durationMs: 1, outcome: "none" } });
    }
    const handle = this.reply(blocks);
    if (options.newWave !== false) this.session.scriptedWaves += 1;

    const started = tasks.map((task, index) => {
      const call = handle.calls[index] as ToolCall;
      const writer = this.session.addSubagent(this, task.child, call, task.description);
      writer.now = call.calledAt + this.rng.int(150, 900);
      writer.conversationLine("user", { message: { role: "user", content: task.prompt } });
      task.child.script(writer);
      return { writer, call, finished: task.child.finished !== false };
    });

    const finished = started
      .map((entry, order) => ({ ...entry, order }))
      .filter((entry) => entry.finished)
      .sort((a, b) => a.writer.now - b.writer.now || a.order - b.order);
    for (const entry of finished) {
      this.now = Math.max(this.now + 1, entry.writer.now + this.rng.int(100, 600));
      this.writeResult(entry.call, false, handbackText(this.rng));
    }
    for (const entry of started) {
      if (!entry.finished) entry.writer.handedBack = false;
    }
    return started.map((entry) => entry.writer);
  }

  /** The distinct tool names this agent called, sorted. */
  toolNames(): string[] {
    return [...new Set([...this.calls.values()].map((call) => call.name))].sort();
  }

  /** The uuid of the last line in the parent chain, or null before the first line. */
  get leafUuid(): string | null {
    return this.lastUuid;
  }

  /** What is true of this agent's transcript. Call after the script has run. */
  facts(): AgentFacts {
    const lineTypes: Record<string, number> = {};
    for (const line of this.lines) {
      // Every line this writer makes has a type; the contract allows a line without one.
      const type = String(line.type);
      lineTypes[type] = (lineTypes[type] ?? 0) + 1;
    }
    const sortedTypes: Record<string, number> = {};
    for (const type of Object.keys(lineTypes).sort()) sortedTypes[type] = lineTypes[type] as number;

    const calls = [...this.calls.values()];
    let usage = zeroUsage();
    for (const merged of this.replies.values()) usage = addUsage(usage, merged);
    const stamps = this.lines
      .map((line) => line.timestamp)
      .filter((value): value is string => typeof value === "string");

    return {
      id: this.id,
      parent: this.identity.parent,
      agentType: this.identity.agentType,
      spawnDepth: this.spawnDepth,
      model: this.model,
      effort: this.effort,
      finished: this.handedBack,
      lines: this.lines.length,
      lineTypes: sortedTypes,
      replies: this.replies.size,
      toolCalls: calls.length,
      failedToolCalls: calls.filter((call) => call.failed).length,
      unfinishedToolCalls: calls.filter((call) => !call.resolved).length,
      mcpToolCalls: calls.filter((call) => call.name.startsWith("mcp__")).length,
      usage,
      firstTimestamp: stamps[0] ?? "",
      lastTimestamp: stamps[stamps.length - 1] ?? "",
    };
  }
}

/** The project folder name Claude Code derives from a working directory. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Builds one session. Script it through `main`, then call `build()`. */
export class SessionBuilder {
  readonly rng: Rng;
  readonly ids: IdFactory;
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectDir: string;
  readonly gitBranch: string;
  readonly entrypoint: string;
  readonly version: string;
  readonly main: AgentWriter;
  scriptedWaves = 0;
  readonly scriptedIdleGaps: { seconds: number }[] = [];

  private readonly subagents: SubagentRecord[] = [];
  private readonly inventedLineTypes: ReadonlySet<string>;

  constructor(options: SessionOptions) {
    if (!/^[a-z][a-z0-9-]*$/.test(options.project)) {
      throw new Error("project must be a lowercase name made of letters, digits and dashes");
    }
    const startMs = Date.parse(options.startTime);
    if (Number.isNaN(startMs)) throw new Error("startTime must be an ISO 8601 date");
    this.rng = createRng(options.seed);
    this.ids = new IdFactory(this.rng.fork("ids"));
    this.sessionId = this.ids.sessionId();
    // Never a real home folder: the privacy check rejects those, and so does the test suite.
    this.cwd = `/workspace/${options.project}`;
    this.projectDir = projectDirName(this.cwd);
    this.gitBranch = options.gitBranch ?? "main";
    this.entrypoint = options.entrypoint ?? "cli";
    this.version = options.version ?? FIXTURE_CLAUDE_VERSION;
    this.inventedLineTypes = new Set(options.inventedLineTypes ?? []);
    const identity: AgentIdentity = {
      agentId: null,
      parent: null,
      agentType: null,
      spawnDepth: 0,
      model: options.model,
      effort: options.effort,
    };
    this.main = new AgentWriter(this, identity, this.rng.fork("main"), startMs);
  }

  /** Used by AgentWriter.spawn. Registers a subagent and returns its writer. */
  addSubagent(
    parent: AgentWriter,
    spec: SubagentSpec,
    call: ToolCall,
    description: string,
  ): AgentWriter {
    const agentId = this.ids.agentId();
    const identity: AgentIdentity = {
      agentId,
      parent: parent.id,
      agentType: spec.agentType,
      spawnDepth: parent.spawnDepth + 1,
      model: spec.model,
      effort: spec.effort,
    };
    const rng = this.rng.fork(`agent-${this.subagents.length + 1}`);
    const writer = new AgentWriter(this, identity, rng, call.calledAt);
    const builtIn = (BUILT_IN_AGENT_TYPES as readonly string[]).includes(spec.agentType);
    const meta: RawSubagentMeta = {
      agentType: spec.agentType,
      ...(spec.modelInMeta === false ? {} : { model: spec.model }),
      toolUseId: call.id,
      spawnDepth: identity.spawnDepth,
      description,
      ...(spec.statusInMeta === false
        ? {}
        : { isBuiltIn: spec.isBuiltIn ?? builtIn, finished: spec.finished !== false }),
    };
    this.subagents.push({ writer, agentType: spec.agentType, meta });
    return writer;
  }

  /** The bookkeeping lines a main transcript starts with. */
  open(): void {
    const messageId = this.ids.uuid();
    this.main.housekeeping("mode", { mode: "default" });
    this.main.housekeeping(
      "file-history-snapshot",
      {
        messageId,
        snapshot: { messageId, trackedFileBackups: {}, timestamp: toIso(this.main.now) },
        isSnapshotUpdate: false,
      },
      { sessionId: false },
    );
  }

  /** The bookkeeping lines a main transcript ends with. */
  close(): void {
    this.main.housekeeping("ai-title", { aiTitle: titleText(this.rng) });
    this.main.housekeeping("tools-used", { tools: this.main.toolNames() });
    this.main.housekeeping("last-prompt", {
      lastPrompt: promptText(this.rng),
      leafUuid: this.main.leafUuid,
    });
  }

  /** Render the files and the facts. Call once, after the script has run. */
  build(): BuiltSession {
    const sessionFolder = `projects/${this.projectDir}/${this.sessionId}`;
    const transcriptPath = `${sessionFolder}.jsonl`;
    const files: GeneratedFile[] = [
      { path: transcriptPath, content: serialiseLines(this.main.lines) },
    ];
    const subagents: GeneratedSubagent[] = [];
    for (const { writer, agentType, meta } of this.subagents) {
      const base = `${sessionFolder}/subagents/agent-${writer.id}`;
      files.push({ path: `${base}.jsonl`, content: serialiseLines(writer.lines) });
      files.push({ path: `${base}.meta.json`, content: `${JSON.stringify(meta, null, 2)}\n` });
      subagents.push({
        agentId: writer.id,
        agentType,
        transcriptPath: `${base}.jsonl`,
        metaPath: `${base}.meta.json`,
        meta,
      });
    }

    const agents = [this.main.facts(), ...this.subagents.map(({ writer }) => writer.facts())];
    const totals: SessionTotals = {
      lines: 0,
      replies: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      unfinishedToolCalls: 0,
      mcpToolCalls: 0,
      usage: zeroUsage(),
    };
    const invented: Record<string, number> = {};
    for (const agent of agents) {
      totals.lines += agent.lines;
      totals.replies += agent.replies;
      totals.toolCalls += agent.toolCalls;
      totals.failedToolCalls += agent.failedToolCalls;
      totals.unfinishedToolCalls += agent.unfinishedToolCalls;
      totals.mcpToolCalls += agent.mcpToolCalls;
      totals.usage = addUsage(totals.usage, agent.usage);
      for (const [type, count] of Object.entries(agent.lineTypes)) {
        if (this.inventedLineTypes.has(type)) invented[type] = (invented[type] ?? 0) + count;
      }
    }
    const inventedLineTypes: Record<string, number> = {};
    for (const type of Object.keys(invented).sort()) {
      inventedLineTypes[type] = invented[type] as number;
    }

    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      projectDir: this.projectDir,
      transcriptPath,
      subagents,
      files,
      expected: {
        agents,
        totals,
        scriptedWaves: this.scriptedWaves,
        scriptedIdleGaps: this.scriptedIdleGaps.map((gap) => ({ ...gap })),
        inventedLineTypes,
      },
    };
  }
}
