/**
 * Test helpers that read raw transcript lines the plain way: no knowledge of how the
 * generator works. They let the tests check the generator's own facts against its output.
 * This is not the Orbitrace parser. That lives in @orbitrace/core.
 */
import { REPLAY_BUILD_DEFAULTS } from "@orbitrace/core";
import { USAGE_KEYS, type FullUsage, type GeneratedSession } from "../src/index.js";

/** The contract's default thresholds, in milliseconds. */
export const IDLE_GAP_MS = REPLAY_BUILD_DEFAULTS.idleGapSeconds * 1000;
export const WAVE_GAP_MS = REPLAY_BUILD_DEFAULTS.waveGapSeconds * 1000;

type UsageKey = (typeof USAGE_KEYS)[number];

/** A usage object with every token count read from `read`. */
function usageFrom(read: (key: UsageKey) => number): FullUsage {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, read(key)])) as FullUsage;
}

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a transcript file. Throws when a line is not a JSON object. */
export function parseJsonl(content: string): JsonObject[] {
  if (content === "") return [];
  if (!content.endsWith("\n")) throw new Error("a transcript file must end with a newline");
  return content
    .slice(0, -1)
    .split("\n")
    .map((text, index) => {
      const value: unknown = JSON.parse(text);
      if (!isObject(value)) throw new Error(`line ${index + 1} is not a JSON object`);
      return value;
    });
}

export interface ToolUseSeen {
  id: string;
  name: string;
  lineUuid: string;
  time: number;
  /** How many lines carry a tool_use block with this id. */
  occurrences: number;
}

export interface ToolResultSeen {
  toolUseId: string;
  isError: boolean;
  time: number;
  source: unknown;
}

export interface TranscriptSummary {
  lines: number;
  lineTypes: Record<string, number>;
  /** Usage per message id, merged by field-wise maximum over the lines of the message. */
  usageByMessage: Map<string, FullUsage>;
  /** Number of lines per message id. */
  linesByMessage: Map<string, number>;
  toolUses: Map<string, ToolUseSeen>;
  toolResults: ToolResultSeen[];
  /** Epoch milliseconds of every line that has a timestamp, in file order. */
  times: number[];
  models: Set<string>;
  efforts: Set<string>;
}

function blocksOf(line: JsonObject): JsonObject[] {
  const message = line.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

export function summarise(lines: readonly JsonObject[]): TranscriptSummary {
  const summary: TranscriptSummary = {
    lines: lines.length,
    lineTypes: {},
    usageByMessage: new Map(),
    linesByMessage: new Map(),
    toolUses: new Map(),
    toolResults: [],
    times: [],
    models: new Set(),
    efforts: new Set(),
  };
  for (const line of lines) {
    const type = String(line.type);
    summary.lineTypes[type] = (summary.lineTypes[type] ?? 0) + 1;
    const time = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : null;
    if (time !== null) summary.times.push(time);

    if (type === "assistant" && isObject(line.message)) {
      const message = line.message;
      const id = String(message.id);
      summary.models.add(String(message.model));
      if (typeof line.effort === "string") summary.efforts.add(line.effort);
      const usage = message.usage as FullUsage;
      const merged = summary.usageByMessage.get(id);
      summary.usageByMessage.set(
        id,
        usageFrom((key) => Math.max(merged?.[key] ?? 0, usage[key])),
      );
      summary.linesByMessage.set(id, (summary.linesByMessage.get(id) ?? 0) + 1);
      for (const block of blocksOf(line)) {
        if (block.type !== "tool_use") continue;
        const blockId = String(block.id);
        const seen = summary.toolUses.get(blockId);
        if (seen !== undefined) {
          seen.occurrences += 1;
        } else {
          summary.toolUses.set(blockId, {
            id: blockId,
            name: String(block.name),
            lineUuid: String(line.uuid),
            time: time ?? Number.NaN,
            occurrences: 1,
          });
        }
      }
    }

    if (type === "user") {
      for (const block of blocksOf(line)) {
        if (block.type !== "tool_result") continue;
        summary.toolResults.push({
          toolUseId: String(block.tool_use_id),
          isError: block.is_error === true,
          time: time ?? Number.NaN,
          source: line.sourceToolAssistantUUID,
        });
      }
    }
  }
  return summary;
}

/** The part of AgentFacts that can be counted from the lines of one transcript. */
export function countedFacts(summary: TranscriptSummary): JsonObject {
  const lineTypes: Record<string, number> = {};
  for (const type of Object.keys(summary.lineTypes).sort()) {
    lineTypes[type] = summary.lineTypes[type] as number;
  }
  const usage = usageFrom((key) =>
    [...summary.usageByMessage.values()].reduce((sum, item) => sum + item[key], 0),
  );
  const resultIds = new Set(summary.toolResults.map((result) => result.toolUseId));
  const failedIds = new Set(
    summary.toolResults.filter((result) => result.isError).map((result) => result.toolUseId),
  );
  const uses = [...summary.toolUses.values()];
  return {
    lines: summary.lines,
    lineTypes,
    replies: summary.usageByMessage.size,
    toolCalls: uses.length,
    failedToolCalls: uses.filter((use) => failedIds.has(use.id)).length,
    unfinishedToolCalls: uses.filter((use) => !resultIds.has(use.id)).length,
    mcpToolCalls: uses.filter((use) => use.name.startsWith("mcp__")).length,
    usage,
    firstTimestamp: new Date(Math.min(...summary.times)).toISOString(),
    lastTimestamp: new Date(Math.max(...summary.times)).toISOString(),
  };
}

export interface SessionTranscripts {
  main: JsonObject[];
  /** Subagent transcripts by agent id, in spawn order. */
  subagents: Map<string, JsonObject[]>;
  /** Subagent meta files by agent id. */
  metas: Map<string, JsonObject>;
}

function fileContent(session: GeneratedSession, path: string): string {
  const file = session.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no generated file at ${path}`);
  return file.content;
}

/** Parse every file of a generated session. */
export function readSession(session: GeneratedSession): SessionTranscripts {
  const subagents = new Map<string, JsonObject[]>();
  const metas = new Map<string, JsonObject>();
  for (const subagent of session.subagents) {
    subagents.set(subagent.agentId, parseJsonl(fileContent(session, subagent.transcriptPath)));
    const meta: unknown = JSON.parse(fileContent(session, subagent.metaPath));
    if (!isObject(meta)) throw new Error("a meta file must hold a JSON object");
    metas.set(subagent.agentId, meta);
  }
  return { main: parseJsonl(fileContent(session, session.transcriptPath)), subagents, metas };
}

/** Every transcript of a session with the id of the agent that wrote it. */
export function allTranscripts(transcripts: SessionTranscripts): [string, JsonObject[]][] {
  return [["main", transcripts.main], ...transcripts.subagents];
}

/**
 * Count waves the way the notes define them: sort subagents by start time, and begin a new
 * wave when one starts more than the contract's `waveGapSeconds` (60) after the one before it.
 */
export function countWaves(startTimes: readonly number[]): number {
  return waveSizes(startTimes).length;
}

/**
 * Gaps of more than the contract's `idleGapSeconds` (45) between two stamped lines of a
 * transcript during which no tool call was waiting for its result, in seconds.
 */
export function idleGaps(lines: readonly JsonObject[]): number[] {
  const gaps: number[] = [];
  const open = new Set<string>();
  let previous: number | null = null;
  for (const line of lines) {
    if (typeof line.timestamp === "string") {
      const time = Date.parse(line.timestamp);
      if (previous !== null && time - previous > IDLE_GAP_MS && open.size === 0) {
        gaps.push((time - previous) / 1000);
      }
      previous = time;
    }
    for (const block of blocksOf(line)) {
      if (block.type === "tool_use") open.add(String(block.id));
      if (block.type === "tool_result") open.delete(String(block.tool_use_id));
    }
  }
  return gaps;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: JsonObject;
  /** Index, in the file, of the first line that holds the block. */
  lineIndex: number;
  time: number;
}

/** The tool_use blocks of a transcript by block id. A block written twice is kept once. */
export function toolUseBlocks(lines: readonly JsonObject[]): Map<string, ToolUseBlock> {
  const found = new Map<string, ToolUseBlock>();
  lines.forEach((line, lineIndex) => {
    if (line.type !== "assistant") return;
    for (const block of blocksOf(line)) {
      if (block.type !== "tool_use" || found.has(String(block.id))) continue;
      found.set(String(block.id), {
        id: String(block.id),
        name: String(block.name),
        input: isObject(block.input) ? block.input : {},
        lineIndex,
        time: Date.parse(String(line.timestamp)),
      });
    }
  });
  return found;
}

export interface ToolResultBlock {
  toolUseId: string;
  block: JsonObject;
  line: JsonObject;
  lineIndex: number;
  time: number;
}

/** The tool_result blocks of a transcript, in file order. */
export function toolResultBlocks(lines: readonly JsonObject[]): ToolResultBlock[] {
  const found: ToolResultBlock[] = [];
  lines.forEach((line, lineIndex) => {
    if (line.type !== "user") return;
    for (const block of blocksOf(line)) {
      if (block.type !== "tool_result") continue;
      found.push({
        toolUseId: String(block.tool_use_id),
        block,
        line,
        lineIndex,
        time: Date.parse(String(line.timestamp)),
      });
    }
  });
  return found;
}

/** The content blocks of a line, or an empty list when its content is not a list. */
export function contentBlocks(line: JsonObject): JsonObject[] {
  return blocksOf(line);
}

/** Every string anywhere inside a JSON value. */
export function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (isObject(value)) return Object.values(value).flatMap(allStrings);
  return [];
}

/** The lines of one type, in file order. */
export function linesOfType(lines: readonly JsonObject[], type: string): JsonObject[] {
  return lines.filter((line) => line.type === type);
}

/** Milliseconds between each stamped line and the stamped line before it. */
export function gapsMs(lines: readonly JsonObject[]): number[] {
  const times = lines
    .map((line) => line.timestamp)
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value));
  return times.slice(1).map((time, index) => time - (times[index] as number));
}

/** Group subagent start times into waves: more than `waveGapSeconds` apart starts a new wave. */
export function waveSizes(startTimes: readonly number[]): number[] {
  const sorted = [...startTimes].sort((a, b) => a - b);
  const sizes: number[] = [];
  let previous: number | null = null;
  for (const start of sorted) {
    if (previous === null || start - previous > WAVE_GAP_MS) sizes.push(1);
    else sizes[sizes.length - 1] = (sizes[sizes.length - 1] as number) + 1;
    previous = start;
  }
  return sizes;
}

/** The time of the first line of each subagent transcript, in spawn order. */
export function subagentStartTimes(transcripts: SessionTranscripts): number[] {
  return [...transcripts.subagents.values()].map((lines) =>
    Date.parse(String((lines[0] as JsonObject).timestamp)),
  );
}
