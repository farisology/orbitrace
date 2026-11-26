/**
 * The raw transcript vocabulary the generator writes.
 *
 * The line and meta shapes are the contract in `@orbitrace/core` (`RawLine`,
 * `RawSubagentMeta`, `RawUsage`, `KNOWN_RAW_LINE_TYPES`, `KNOWN_EFFORT_LEVELS`). This module
 * re-exports them and adds only what the contract does not define: run-time key lists
 * (checked against the contract types), the lines that carry the common keys, and the
 * invented values a reader is tested on.
 *
 * The transcript format is internal to Claude Code and has no published schema, so a reader
 * must tolerate keys and line types it does not know.
 */
import {
  KNOWN_EFFORT_LEVELS,
  KNOWN_RAW_LINE_TYPES,
  type KnownEffortLevel,
  type KnownRawLineType,
  type RawLine,
  type RawLineBase,
  type RawSubagentMeta,
  type RawUsage,
} from "@orbitrace/core";

export { KNOWN_EFFORT_LEVELS, KNOWN_RAW_LINE_TYPES };
export type { KnownEffortLevel, KnownRawLineType, RawLine, RawSubagentMeta, RawUsage };

/**
 * The keys a contract type declares by name, without its index signature. The raw types
 * accept any extra key, so `keyof` alone is `string | number` and checks nothing.
 */
export type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Keys found on every conversation line (see CONVERSATION_LINE_TYPES): those of `RawLineBase`. */
export const COMMON_LINE_KEYS = [
  "type",
  "uuid",
  "parentUuid",
  "timestamp",
  "sessionId",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
  "isSidechain",
] as const satisfies readonly DeclaredKeys<RawLineBase>[];

/**
 * The known line types that carry the common keys and take part in the parentUuid chain.
 * The contract does not record this split. The shape tests use it to know which lines must
 * carry the common keys.
 */
export const CONVERSATION_LINE_TYPES = [
  "user",
  "assistant",
  "system",
  "attachment",
] as const satisfies readonly KnownRawLineType[];
export type ConversationLineType = (typeof CONVERSATION_LINE_TYPES)[number];

export type HousekeepingLineType = Exclude<KnownRawLineType, ConversationLineType>;

/**
 * The other known line types: bookkeeping. They carry `type` and little else: most have no
 * `uuid` and no `timestamp`, and `file-history-snapshot` has no `sessionId` either.
 */
export const HOUSEKEEPING_LINE_TYPES: readonly HousekeepingLineType[] = KNOWN_RAW_LINE_TYPES.filter(
  (type): type is HousekeepingLineType =>
    !(CONVERSATION_LINE_TYPES as readonly string[]).includes(type),
);

/** True for a line type the contract lists in KNOWN_RAW_LINE_TYPES. */
export function isKnownLineType(type: unknown): type is KnownRawLineType {
  return (KNOWN_RAW_LINE_TYPES as readonly unknown[]).includes(type);
}

/**
 * Line types that do not exist in Claude Code. The generator invents them so that a reader
 * can be tested on skipping and counting what it does not know.
 */
export const INVENTED_LINE_TYPES = [
  "synthetic-future-event",
  "synthetic-trace-span",
  "synthetic-ledger-note",
] as const;

/** A content block type that does not exist in Claude Code, for the same purpose. */
export const INVENTED_BLOCK_TYPE = "synthetic_future_block";

/** A tool name that does not exist in Claude Code, for the same purpose. */
export const INVENTED_TOOL_NAME = "SyntheticFutureTool";

/** The token counts of `message.usage`: the keys `RawUsage` declares. */
export const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const satisfies readonly DeclaredKeys<RawUsage>[];

/**
 * The usage the generator writes: the contract's `RawUsage` with every token count present.
 * A real line may leave any of them out.
 */
export type FullUsage = Required<Pick<RawUsage, (typeof USAGE_KEYS)[number]>>;

/**
 * Keys of `agent-<agentId>.meta.json`: the keys `RawSubagentMeta` declares. On disk `model`,
 * `isBuiltIn` and `finished` are optional: some files leave them out.
 */
export const SUBAGENT_META_KEYS = [
  "agentType",
  "model",
  "toolUseId",
  "spawnDepth",
  "description",
  "isBuiltIn",
  "finished",
] as const satisfies readonly DeclaredKeys<RawSubagentMeta>[];

/** Model ids used in fixtures, by family. The family is the word after `claude-`. */
export const MODELS = {
  fable: "claude-fable-5-2",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  /** A family with a dated suffix, to test that the family is still read correctly. */
  haikuDated: "claude-haiku-5-5-20260115",
  /** A family that does not exist, to test the unknown-family path. */
  unknownFamily: "claude-quartz-1-0",
} as const;

/** Agent types that ship with Claude Code. Everything else in fixtures is a custom agent. */
export const BUILT_IN_AGENT_TYPES = ["general-purpose", "Explore", "Plan"] as const;

export function zeroUsage(): FullUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

/** Field-by-field maximum: how the lines of one reply are merged. */
export function maxUsage(a: FullUsage, b: FullUsage): FullUsage {
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: Math.max(a.cache_read_input_tokens, b.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(
      a.cache_creation_input_tokens,
      b.cache_creation_input_tokens,
    ),
  };
}

/** Field-by-field sum: how merged replies add up to a total. */
export function addUsage(a: FullUsage, b: FullUsage): FullUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}
