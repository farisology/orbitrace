/**
 * Ticket #18. The allow-list projection behind `exportReplay`.
 *
 * Builds a new value field by field from the ReplayModel types. Nothing is copied wholesale and
 * nothing is deleted, so a property the types do not list (an extra `text`, `path`, `cwd`, ...,
 * on any object or array) has no way into the result. Fields are read only when they are the
 * object's own properties, so a value on a prototype is never picked up. Each object literal is
 * typed against its contract type: adding a field to the contract without adding it here, or
 * adding a field here that the contract lacks, fails to compile.
 *
 * The projection does not check values. A leaf that is not a string, number, boolean or null is
 * replaced by an empty object, so it carries nothing and the schema check that follows rejects
 * it. Strings and numbers are copied as they are; the schema check decides whether they are
 * allowed.
 */
import type {
  ReplayAgent,
  ReplayModel,
  ReplayReply,
  ReplaySessionTotals,
  ReplayToolCall,
  ReplayTotals,
  ReplayWarp,
} from "../model/replay.js";

/** Every key of T, required, with a value not checked yet. */
export type Unchecked<T> = { -readonly [K in keyof T]-?: unknown };

type Leaf = string | number | boolean | null;

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A primitive JSON value as is; `undefined` stays missing; anything else becomes `{}`. */
function leaf(value: unknown): Leaf | undefined | Record<string, never> {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return {};
}

/**
 * A new array with each element projected. Properties of the array that are not indices are
 * dropped. `undefined` stays missing, so the schema reports it; any other non-array becomes `{}`.
 */
function list<T>(
  value: unknown,
  item: (element: unknown) => T,
): T[] | undefined | Record<string, never> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return {};
  const result: T[] = [];
  for (let i = 0; i < value.length; i += 1) result.push(item(value[i] as unknown));
  return result;
}

function nested<T>(value: unknown, project: (input: unknown) => T): T | Leaf | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? project(value)
    : (leaf(value) as Leaf | undefined);
}

function toolCall(v: unknown): Unchecked<ReplayToolCall> {
  return {
    name: leaf(own(v, "name")),
    kind: leaf(own(v, "kind")),
    start: leaf(own(v, "start")),
    end: leaf(own(v, "end")),
    failed: leaf(own(v, "failed")),
  };
}

function reply(v: unknown): Unchecked<ReplayReply> {
  return {
    t: leaf(own(v, "t")),
    inputTokens: leaf(own(v, "inputTokens")),
    outputTokens: leaf(own(v, "outputTokens")),
    cacheReadTokens: leaf(own(v, "cacheReadTokens")),
    cacheCreationTokens: leaf(own(v, "cacheCreationTokens")),
  };
}

function totals(v: unknown): Unchecked<ReplayTotals> {
  return {
    toolCalls: leaf(own(v, "toolCalls")),
    failedToolCalls: leaf(own(v, "failedToolCalls")),
    replies: leaf(own(v, "replies")),
    inputTokens: leaf(own(v, "inputTokens")),
    outputTokens: leaf(own(v, "outputTokens")),
    cacheReadTokens: leaf(own(v, "cacheReadTokens")),
    cacheCreationTokens: leaf(own(v, "cacheCreationTokens")),
  };
}

function sessionTotals(v: unknown): Unchecked<ReplaySessionTotals> {
  return {
    agents: leaf(own(v, "agents")),
    toolCalls: leaf(own(v, "toolCalls")),
    failedToolCalls: leaf(own(v, "failedToolCalls")),
    replies: leaf(own(v, "replies")),
    inputTokens: leaf(own(v, "inputTokens")),
    outputTokens: leaf(own(v, "outputTokens")),
    cacheReadTokens: leaf(own(v, "cacheReadTokens")),
    cacheCreationTokens: leaf(own(v, "cacheCreationTokens")),
    duration: leaf(own(v, "duration")),
    realDuration: leaf(own(v, "realDuration")),
  };
}

/** Main agent and subagents have the same keys; the schema tells them apart by position. */
function agent(v: unknown): Unchecked<ReplayAgent> {
  return {
    id: leaf(own(v, "id")),
    name: leaf(own(v, "name")),
    callsign: leaf(own(v, "callsign")),
    model: leaf(own(v, "model")),
    family: leaf(own(v, "family")),
    effort: leaf(own(v, "effort")),
    parent: leaf(own(v, "parent")),
    wave: leaf(own(v, "wave")),
    start: leaf(own(v, "start")),
    end: leaf(own(v, "end")),
    tools: list(own(v, "tools"), (t) => nested(t, toolCall)),
    replies: list(own(v, "replies"), (r) => nested(r, reply)),
    totals: nested(own(v, "totals"), totals),
  };
}

function warp(v: unknown): Unchecked<ReplayWarp> {
  return {
    at: leaf(own(v, "at")),
    skipped: leaf(own(v, "skipped")),
  };
}

/**
 * Builds a new replay-shaped value holding only the fields the ReplayModel types list, in a
 * fixed key order. The result is not checked: pass it to the schema validator before use.
 * A value that is not an object gives `{}`.
 */
export function projectReplay(value: unknown): Unchecked<ReplayModel> | Record<string, never> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return {
    formatVersion: leaf(own(value, "formatVersion")),
    agents: list(own(value, "agents"), (a) => nested(a, agent)),
    warps: list(own(value, "warps"), (w) => nested(w, warp)),
    totals: nested(own(value, "totals"), sessionTotals),
  };
}
