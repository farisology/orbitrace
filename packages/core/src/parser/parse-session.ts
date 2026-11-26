/**
 * `parseSession` for Claude Code transcripts (ticket #6).
 *
 * Reads the main transcript and each subagent transcript line by line, merges assistant
 * lines by message id, pairs tool calls with their results, and links each subagent run to
 * the call that started it through the meta file's `toolUseId`. Unknown and malformed lines
 * are skipped and counted. No text, input, output, path or meta `description` is kept.
 *
 * Uses ES2022 only (no Node or DOM API), so the same code parses a file on the host and a
 * file dropped into the app.
 *
 * The same input always gives a deep-equal result: every order in the output is fixed by
 * the input (timestamps first, then the order in which things appeared).
 */

import type { ParseSession } from "../api.js";
import type { LineCounts, ParsedSession, ParsedSubagentRun } from "../model/parsed.js";
import type { RawSubagentInput } from "../model/raw.js";
import { parseRun, type LineObserver, type LinkableRun, type LinkableToolCall } from "./run.js";
import {
  asBoolean,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  type JsonRecord,
} from "./values.js";

/** Collects line counts, the session id and runtime versions across every transcript. */
class SessionObserver {
  total = 0;
  malformed = 0;
  private readonly unknown = new Map<string, number>();
  private readonly versions = new Set<string>();
  private mainSessionId: string | null = null;
  private otherSessionId: string | null = null;

  /** An observer for one transcript. Only the main transcript sets the session id first. */
  forTranscript(isMain: boolean): LineObserver {
    return {
      line: () => {
        this.total += 1;
      },
      malformed: () => {
        this.malformed += 1;
      },
      unknown: (type) => {
        this.unknown.set(type, (this.unknown.get(type) ?? 0) + 1);
      },
      object: (line: JsonRecord) => {
        const version = asNonEmptyString(line["version"]);
        if (version !== null) this.versions.add(version);
        const sessionId = asNonEmptyString(line["sessionId"]);
        if (sessionId === null) return;
        if (isMain) this.mainSessionId ??= sessionId;
        else this.otherSessionId ??= sessionId;
      },
    };
  }

  sessionId(): string | null {
    return this.mainSessionId ?? this.otherSessionId;
  }

  versionsSeen(): readonly string[] {
    return [...this.versions];
  }

  counts(): LineCounts {
    // Object.fromEntries defines own properties, so a type such as `__proto__` is safe.
    const unknownByType = Object.fromEntries(
      [...this.unknown.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return { total: this.total, unknownByType, malformed: this.malformed };
  }
}

interface SubagentEntry {
  readonly index: number;
  readonly input: RawSubagentInput;
  readonly meta: JsonRecord | null;
  readonly run: LinkableRun;
}

interface CallOwner {
  /** -1 for the main run, otherwise the subagent's index in the input. */
  readonly ownerIndex: number;
  readonly call: LinkableToolCall;
}

/** Index every call by tool use id. The main run first, then subagents in input order; the first claim wins. */
function indexCalls(
  main: LinkableRun,
  subagents: readonly SubagentEntry[],
): Map<string, CallOwner> {
  const index = new Map<string, CallOwner>();
  const add = (ownerIndex: number, run: LinkableRun): void => {
    for (const call of run.toolCalls) {
      if (!index.has(call.toolUseId)) index.set(call.toolUseId, { ownerIndex, call });
    }
  };
  add(-1, main);
  for (const entry of subagents) add(entry.index, entry.run);
  return index;
}

function firstReplyModel(run: LinkableRun): string | null {
  for (const reply of run.replies) {
    if (reply.model !== null) return reply.model;
  }
  return null;
}

/**
 * Link one subagent to its parent call and build its parsed run. The parent call is looked
 * up by id in every other run, whatever its tool name, so a renamed spawn tool still links.
 */
function linkSubagent(
  entry: SubagentEntry,
  calls: ReadonlyMap<string, CallOwner>,
  subagents: readonly SubagentEntry[],
): ParsedSubagentRun {
  const { meta, run, input } = entry;
  const parentToolUseId = meta === null ? null : asNonEmptyString(meta["toolUseId"]);
  let parentAgentId: string | null = null;
  if (parentToolUseId !== null) {
    const owner = calls.get(parentToolUseId);
    if (owner !== undefined && owner.ownerIndex !== entry.index) {
      parentAgentId =
        owner.ownerIndex === -1 ? "main" : (subagents[owner.ownerIndex]?.input.agentId ?? null);
      if (parentAgentId !== null) owner.call.spawnedAgentId ??= input.agentId;
    }
  }
  return {
    ...run,
    agentId: input.agentId,
    agentType: meta === null ? null : asNonEmptyString(meta["agentType"]),
    model: (meta === null ? null : asNonEmptyString(meta["model"])) ?? firstReplyModel(run),
    spawnDepth: meta === null ? null : asFiniteNumber(meta["spawnDepth"]),
    isBuiltIn: meta === null ? null : asBoolean(meta["isBuiltIn"]),
    finished: meta === null ? null : asBoolean(meta["finished"]),
    parentToolUseId,
    parentAgentId,
  };
}

/** Parse a Claude Code session. See `ParseSession` in `api.ts` for the contract. */
export const parseSession: ParseSession = async (input) => {
  const observer = new SessionObserver();
  const main = await parseRun(input.main, observer.forTranscript(true));

  const entries: SubagentEntry[] = [];
  for (const [index, sub] of input.subagents.entries()) {
    const run = await parseRun(sub.lines, observer.forTranscript(false));
    // The meta `description` is user content: only the fields read in linkSubagent are used.
    entries.push({ index, input: sub, meta: asRecord(sub.meta), run });
  }

  const calls = indexCalls(main, entries);
  const subagents = entries
    .map((entry) => ({ entry, parsed: linkSubagent(entry, calls, entries) }))
    .sort(
      (a, b) =>
        compareStart(a.parsed.startedAt, b.parsed.startedAt) || a.entry.index - b.entry.index,
    )
    .map(({ parsed }) => parsed);

  const session: ParsedSession = {
    runtime: "claude-code",
    sessionId: observer.sessionId(),
    main,
    subagents,
    versionsSeen: observer.versionsSeen(),
    lines: observer.counts(),
  };
  return session;
};

/** Ascending, with a missing start after every known one. */
function compareStart(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}
