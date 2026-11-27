// Hand-built replays for the ledger tests. Every value is invented.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelFamily,
  ReplayMainAgent,
  ReplayModel,
  ReplayReply,
  ReplayReplyWithDetails,
  ReplaySubagent,
  ReplayTotals,
} from "../../src/index.js";

export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures",
);

/** A reply with the given tokens: input, output, cache read, cache creation. */
export function reply(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  t = 1,
): ReplayReply {
  return {
    t,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

function totalsOf(replies: readonly ReplayReplyWithDetails[]): ReplayTotals {
  const sum = (key: keyof ReplayReply): number => replies.reduce((acc, r) => acc + r[key], 0);
  return {
    toolCalls: 0,
    failedToolCalls: 0,
    replies: replies.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
  };
}

export interface AgentSpec {
  readonly name?: string;
  readonly model: string | null;
  readonly family: ModelFamily;
  /** Replies may carry in-memory details (#191); `totals` counts the replay v1 fields only. */
  readonly replies: readonly ReplayReplyWithDetails[];
}

/** A valid replay: `main` first, then one subagent per further spec, all in wave 0. */
export function replayOf(main: AgentSpec, ...subagents: AgentSpec[]): ReplayModel {
  const mainAgent: ReplayMainAgent = {
    id: "main",
    name: "main",
    callsign: "main",
    model: main.model,
    family: main.family,
    effort: null,
    parent: null,
    wave: null,
    start: 0,
    end: 10,
    tools: [],
    replies: main.replies,
    totals: totalsOf(main.replies),
  };
  const subs = subagents.map((spec, index): ReplaySubagent => ({
    id: `a${index + 1}`,
    name: spec.name ?? `widget-helper-${index + 1}`,
    callsign: spec.name ?? `widget-helper-${index + 1}`,
    model: spec.model,
    family: spec.family,
    effort: null,
    parent: "main",
    wave: 0,
    start: 1,
    end: 9,
    tools: [],
    replies: spec.replies,
    totals: totalsOf(spec.replies),
  }));
  const agents = [mainAgent, ...subs] as const;
  const sum = (key: keyof ReplayTotals): number => agents.reduce((s, a) => s + a.totals[key], 0);
  return {
    formatVersion: 1,
    agents: [mainAgent, ...subs],
    warps: [],
    totals: {
      toolCalls: 0,
      failedToolCalls: 0,
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      agents: agents.length,
      duration: 10,
      realDuration: 10,
    },
  };
}

export interface ManifestUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ManifestSession {
  name: string;
  goldenReplay: string;
  expected: {
    agents: { id: string; model: string | null; replies: number; usage: ManifestUsage }[];
    totals: { replies: number; usage: ManifestUsage };
  };
}

/** The committed synthetic fixture manifest (core cannot depend on @orbitrace/fixtures). */
export function manifestSessions(): ManifestSession[] {
  return (
    JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
      sessions: ManifestSession[];
    }
  ).sessions;
}

/** A committed golden replay, by its path relative to `fixtures/`. */
export function readReplay(relative: string): ReplayModel {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, relative), "utf8")) as ReplayModel;
}
