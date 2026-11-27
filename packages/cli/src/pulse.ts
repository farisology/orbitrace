/**
 * `orbitrace pulse` (#27): an activity summary across sessions, from core's `pulseReport`.
 *
 * Reads only. Sessions are found exactly as for `list` and `export`: the same roots, the same
 * history-aware adapter (so sessions only the history store holds count when a store exists;
 * nothing is created when it does not) and the same session replayer's listing. Each session is
 * built with the same chain the replayer's `load` runs (open, parse, build, replay format check,
 * with the same error codes), done here so the parsed session's first timestamp can be passed to
 * core as the session's real start. The output holds session keys, times, counts, tool labels and
 * token counts, never transcript content, project names or paths.
 *
 * Bound: sessions are read newest first by last activity, and at most `--limit` of them are read,
 * whether they turn out inside the range, outside it, or unreadable. The document says how many
 * were listed, read, counted, left out of the range, not read because of the limit, and could not
 * be read, and which counted sessions came from the history store.
 */

import {
  SessionReplayError,
  buildReplay,
  createZoneClock,
  describeReplayProblems,
  formatDuration,
  formatDurationShort,
  formatTokens,
  parseSession,
  pulseReport,
  pulseSessionStart,
  type EpochMs,
  type ParsedSession,
  type PulseReport,
  type PulseSessionInput,
  type ReplayModel,
  type SessionRef,
  type SessionSummary,
  type SourceAdapter,
  type ZoneClock,
} from "@orbitrace/core";
import { SESSION_REPLAY_MESSAGES, type SessionReplayer } from "@orbitrace/core/node";
import type { ParsedCommand, PulseTimeSpec } from "./args.js";
import { usageError } from "./errors.js";
import { sanitizeForTerminal } from "./output.js";
import type { HistoryRuntime } from "./history/context.js";
import { historySearch, isHistoryRef } from "./history/source.js";
import {
  CLI_ADAPTERS,
  MIN_KEY_PREFIX,
  createReplayer,
  keyBody,
  resolveRoots,
  type HostContext,
} from "./sessions.js";
import type { CliWarning } from "./sessions.js";

export type PulseCommand = Extract<ParsedCommand, { kind: "pulse" }>;

/**
 * What the command read, and what it left out and why. Part of the `--json` document, whose
 * `version` covers these fields too: a change to them bumps it.
 */
export interface PulseReading {
  /** Sessions listed under the roots (after `--project`). */
  readonly listed: number;
  /** Sessions whose replay was built: `counted + outOfRange`. */
  readonly read: number;
  /** Sessions counted in the report. */
  readonly counted: number;
  /** Read, but their start is outside `--since` / `--until`. */
  readonly outOfRange: number;
  /** Listed, but not read because `limit` sessions were read (or tried) already. */
  readonly notReadLimit: number;
  /** Most sessions read, or tried, in this run: `read + unreadable.count <= limit`. */
  readonly limit: number;
  /** Sessions that could not be read or built, by core's error code. */
  readonly unreadable: {
    readonly count: number;
    readonly byCode: Readonly<Record<string, number>>;
  };
  /** Counted sessions that came from the history store rather than from files. */
  readonly fromHistory: number;
  /** The keys of those sessions, in timeline order (a subset of `totals.keys`). */
  readonly historyKeys: readonly string[];
}

/**
 * The `orbitrace pulse --json` document: core's report, what was read, and the warnings.
 * `version` (core's `PULSE_REPORT_VERSION`) covers the whole document, the fields the command
 * adds (`sessions`, `project`, `warnings`) included: a change to any of them bumps it.
 */
export type PulseDocument = PulseReport & {
  readonly sessions: PulseReading;
  readonly project: string | null;
  readonly warnings: readonly CliWarning[];
};

/** The document, and every session key under the roots (for short keys in the text output). */
export interface PulseResult {
  readonly document: PulseDocument;
  /** Every key listed under the roots, before `--project`; never written to the output. */
  readonly knownKeys: readonly string[];
}

/** This computer's time zone as `Intl` reports it, or `UTC` when it reports none. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone for `--tz` (or this computer's), or a usage error that does not repeat the value. */
export function pulseZone(tz: string | undefined): ZoneClock {
  try {
    return createZoneClock(tz ?? systemTimeZone());
  } catch {
    throw usageError(
      "--tz needs a time zone name this Node knows, such as Europe/London, America/New_York or UTC.",
      "pulse",
    );
  }
}

/** The instant a `--since` / `--until` value stands for, in `clock`'s zone at `now`. */
export function resolvePulseTime(spec: PulseTimeSpec, clock: ZoneClock, now: number): number {
  switch (spec.kind) {
    case "instant":
      return spec.ms;
    case "local":
      return clock.instantAt(spec.localMs);
    case "ago":
      return now - spec.ms;
  }
}

/**
 * The first timestamp of a session's transcripts (main and subagents), epoch milliseconds, or
 * `undefined` when none has one. It is the instant the replay's time 0 stands for.
 */
export function transcriptStart(
  parsed: Pick<ParsedSession, "main" | "subagents">,
): EpochMs | undefined {
  const starts = [parsed.main.startedAt, ...parsed.subagents.map((sub) => sub.startedAt)].filter(
    (time): time is number => typeof time === "number" && Number.isFinite(time),
  );
  return starts.length === 0 ? undefined : Math.min(...starts);
}

/** One session read: its replay, its real start when known, and where it was found. */
interface ReadSession {
  readonly ref: SessionRef;
  readonly replay: ReplayModel;
  readonly startedAt: EpochMs | undefined;
}

/**
 * Find, open, parse, build and check one session: the chain of the replayer's `load`, with its
 * error codes (`not-found` and `internal` from `find`; `unreadable` when reading or parsing
 * fails; `internal` when building fails; `invalid` when the replay fails the format check), but
 * keeping the parsed session's first timestamp.
 */
async function readSession(
  replayer: SessionReplayer,
  adapters: readonly SourceAdapter[],
  key: string,
): Promise<ReadSession> {
  const ref = await replayer.find(key);
  const adapter = adapters.find((candidate) => candidate.runtime === ref.runtime);
  if (adapter === undefined) {
    throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.buildFailed);
  }
  let parsed: ParsedSession;
  try {
    // Reading happens lazily while parsing, so a read error can surface in either call.
    parsed = await parseSession(await adapter.openSession(ref));
  } catch {
    throw new SessionReplayError("unreadable", SESSION_REPLAY_MESSAGES.unreadable);
  }
  let replay: ReplayModel;
  try {
    replay = buildReplay(parsed);
  } catch {
    throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.buildFailed);
  }
  if (describeReplayProblems(replay).length > 0) {
    throw new SessionReplayError("invalid", SESSION_REPLAY_MESSAGES.invalid);
  }
  return { ref, replay, startedAt: transcriptStart(parsed) };
}

/**
 * Build the Pulse document. `now` is the clock reading for relative `--since` / `--until`
 * values; it is passed in so tests can fix it.
 */
export async function buildPulseDocument(
  command: PulseCommand,
  host: HostContext,
  history: HistoryRuntime,
  now: number,
): Promise<PulseResult> {
  const clock = pulseZone(command.tz);
  const since =
    command.since === undefined ? undefined : resolvePulseTime(command.since, clock, now);
  const until =
    command.until === undefined ? undefined : resolvePulseTime(command.until, clock, now);
  if (since !== undefined && until !== undefined && since >= until) {
    throw usageError("--since must be before --until.", "pulse");
  }

  const resolved = await resolveRoots(host, command.sources);
  const search = await historySearch(host, history, CLI_ADAPTERS);
  const roots = search.root === null ? resolved.roots : [...resolved.roots, search.root];
  const warnings = [...resolved.warnings, ...search.warnings];
  const replayer = createReplayer(roots, search.adapters);

  // Not listed with `since`: the listing filters on last activity (file times), which can be
  // earlier than the transcript's own timestamps (a file whose time was set back), so the range
  // is tested on each session's start once it is read.
  const listedAll = await replayer.list();
  const listed: readonly SessionSummary[] =
    command.project === undefined
      ? listedAll
      : listedAll.filter((summary) => summary.projectLabel === command.project);

  const counted: PulseSessionInput[] = [];
  const historyKeys = new Set<string>();
  const byCode: Record<string, number> = {};
  let unreadable = 0;
  let read = 0;
  let outOfRange = 0;
  let index = 0;
  // The limit caps every session tried, whatever the outcome, so a run stays bounded.
  for (; index < listed.length && read + unreadable < command.limit; index += 1) {
    const summary = listed[index] as SessionSummary;
    let session: ReadSession;
    try {
      session = await readSession(replayer, search.adapters, summary.key);
    } catch (error) {
      const code = error instanceof SessionReplayError ? error.code : "internal";
      byCode[code] = (byCode[code] ?? 0) + 1;
      unreadable += 1;
      continue;
    }
    read += 1;
    const input: PulseSessionInput = {
      summary,
      replay: session.replay,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    };
    const start = pulseSessionStart(input);
    if (
      start === null ||
      (since !== undefined && start < since) ||
      (until !== undefined && start >= until)
    ) {
      outOfRange += 1;
      continue;
    }
    counted.push(input);
    if (isHistoryRef(session.ref)) historyKeys.add(summary.key);
  }

  const report = pulseReport(counted, {
    timeZone: clock.timeZone,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  });
  const document: PulseDocument = {
    ...report,
    sessions: {
      listed: listed.length,
      read,
      counted: report.totals.sessions,
      outOfRange,
      notReadLimit: listed.length - index,
      limit: command.limit,
      unreadable: { count: unreadable, byCode },
      fromHistory: historyKeys.size,
      historyKeys: report.totals.keys.filter((key) => historyKeys.has(key)),
    },
    project: command.project ?? null,
    warnings,
  };
  return { document, knownKeys: listedAll.map((summary) => summary.key) };
}

// ---------------------------------------------------------------------------------------
// Text output. Every line fits in 80 columns (tool names are cut to fit; keys are shortened).
// ---------------------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD HH:MM` of an instant in `clock`'s zone. */
export function formatZoned(clock: ZoneClock, instant: number): string {
  if (!Number.isFinite(instant)) return "-";
  const date = new Date(instant + clock.offsetAt(instant));
  if (Number.isNaN(date.getTime())) return "-";
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
  );
}

/** Shades of the hour grid, from nothing to the busiest hour. Plain ASCII. */
const SHADES = [" ", ".", ":", "-", "=", "+", "*", "#"] as const;

/** One character for `value` out of `max`: a space for 0, `#` for the maximum. */
export function shade(value: number, max: number): string {
  if (value <= 0 || max <= 0) return SHADES[0];
  const level = Math.max(1, Math.ceil((value / max) * (SHADES.length - 1)));
  return SHADES[Math.min(level, SHADES.length - 1)] as string;
}

/** Shortest key start shown in the session table. `open` and `export` accept it. */
export const PULSE_SHORT_KEY = Math.max(8, MIN_KEY_PREFIX);

/**
 * For each of `keys`, the shortest start of the part after `<runtime>:` that is at least
 * `PULSE_SHORT_KEY` characters and that no other key of `known` starts with, so `open` and
 * `export` take it in place of the whole key. A key no start of which is unique is kept whole.
 */
export function shortKeys(
  keys: readonly string[],
  known: readonly string[],
): ReadonlyMap<string, string> {
  const bodies = [...new Set([...known, ...keys])].map((key) => ({ key, body: keyBody(key) }));
  const out = new Map<string, string>();
  for (const key of keys) {
    const body = keyBody(key);
    let short = key;
    for (let size = PULSE_SHORT_KEY; size <= body.length; size += 1) {
      const start = body.slice(0, size);
      const clash = bodies.some((other) => other.key !== key && other.body.startsWith(start));
      if (!clash) {
        short = start;
        break;
      }
    }
    out.set(key, short);
  }
  return out;
}

/** Longest tool name shown in the text output; a longer one is cut and ends in `...`. */
const TOOL_NAME_WIDTH = 40;

const cut = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 3)}...`;

const length = (ms: number): string => formatDuration(ms / 1000);
const short = (ms: number): string => formatDurationShort(ms / 1000);

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column] as number),
      )
      .join("  ")
      .trimEnd(),
  );
}

/**
 * The Pulse document as text for the terminal. `knownKeys` is every session key under the
 * roots, so the shortened keys in the session table stay unique among them; by default, the
 * timeline's keys.
 */
export function formatPulseText(
  document: PulseDocument,
  knownKeys: readonly string[] = document.timeline.map((entry) => entry.key),
): string {
  const clock = createZoneClock(document.timeZone);
  const { totals } = document;
  const range =
    document.range.since === null && document.range.until === null
      ? "all times"
      : `from ${document.range.since === null ? "the start" : formatZoned(clock, document.range.since)}` +
        ` until ${document.range.until === null ? "now" : formatZoned(clock, document.range.until)}`;
  const lines: string[] = [
    `Pulse: ${totals.sessions} session${totals.sessions === 1 ? "" : "s"}, ${range}.`,
    `Time zone: ${document.timeZone}.`,
  ];
  if (totals.sessions === 0) {
    lines.push("No sessions to count.");
  } else {
    lines.push(
      `Active ${length(totals.activeMs)}, idle ${length(totals.idleMs)}.`,
      "Idle is not the same as waiting on you: see docs/pulse.md.",
      "Sessions that overlap each count their own time, so times can add up past",
      "the clock time they cover.",
      `Tool calls ${totals.toolCalls} (failed ${totals.failedToolCalls}, no result ${totals.openToolCalls}), replies ${totals.replies}, agents ${totals.agents}.`,
      `Tokens: input ${formatTokens(totals.tokens.input)}, output ${formatTokens(totals.tokens.output)}, cache read ${formatTokens(totals.tokens.cacheRead)}, cache write ${formatTokens(totals.tokens.cacheCreation)}.`,
      "",
      "Active time by hour of the week ('#' is the busiest hour):",
    );
    const max = Math.max(
      ...document.hourOfWeek.cells.flatMap((row) => row.map((cell) => cell.activeMs)),
    );
    lines.push(
      `     ${Array.from({ length: 24 }, (_, hour) => (hour % 3 === 0 ? String(hour).padEnd(3) : "")).join("")}`.trimEnd(),
    );
    for (const row of document.hourOfWeek.cells) {
      const name = row[0]?.weekday ?? "";
      const label = `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
      lines.push(`  ${label}${row.map((cell) => shade(cell.activeMs, max)).join("")}`.trimEnd());
    }
    lines.push("", "Tool calls by kind:");
    lines.push(
      ...table([
        ["  KIND", "CALLS", "FAILED", "NO RESULT"],
        ...document.tools.byKind.map((entry) => [
          `  ${entry.kind}`,
          String(entry.calls),
          String(entry.failed),
          String(entry.open),
        ]),
      ]),
    );
    const top = document.tools.byName.slice(0, 10);
    if (top.length > 0) {
      lines.push("", `Top tools (${top.length} of ${document.tools.byName.length}):`);
      lines.push(
        ...table([
          ["  TOOL", "KIND", "CALLS", "FAILED"],
          ...top.map((entry) => [
            `  ${cut(sanitizeForTerminal(entry.name), TOOL_NAME_WIDTH)}`,
            entry.kind,
            String(entry.calls),
            String(entry.failed),
          ]),
        ]),
      );
    }
    const fromHistory = new Set(document.sessions.historyKeys);
    const withSource = fromHistory.size > 0;
    const keys = shortKeys(
      document.timeline.map((entry) => entry.key),
      knownKeys,
    );
    lines.push("", "Sessions, oldest first (AG agents, OUT output tokens):");
    lines.push(
      ...table([
        [
          "  START",
          "LENGTH",
          "ACTIVE",
          "IDLE",
          "AG",
          "TOOLS",
          "OUT",
          ...(withSource ? ["SRC"] : []),
          "KEY",
        ],
        ...document.timeline.map((entry) => [
          `  ${formatZoned(clock, entry.start)}`,
          short(entry.spanMs),
          short(entry.activeMs),
          short(entry.idleMs),
          String(entry.agents),
          String(entry.toolCalls),
          formatTokens(entry.tokens.output),
          ...(withSource ? [fromHistory.has(entry.key) ? "hist" : "file"] : []),
          keys.get(entry.key) ?? entry.key,
        ]),
      ]),
    );
    if (withSource) {
      lines.push("SRC hist: read from the history store; file: read from its transcripts.");
    }
  }
  lines.push("", ...readingLines(document));
  return `${lines.join("\n")}\n`;
}

/** What was read and left out, and why: one short line for each part that is not zero. */
export function readingLines(document: PulseDocument): string[] {
  const s = document.sessions;
  const lines = [`Listed ${s.listed}, read ${s.read}, counted ${s.counted}.`];
  if (s.outOfRange > 0) lines.push(`${s.outOfRange} outside the time range.`);
  if (s.notReadLimit > 0) {
    lines.push(`${s.notReadLimit} not read because of the limit of ${s.limit} (--limit).`);
  }
  if (s.unreadable.count > 0) {
    const reasons = Object.keys(s.unreadable.byCode)
      .sort()
      .map((code) => `${code} ${s.unreadable.byCode[code]}`)
      .join(", ");
    lines.push(`${s.unreadable.count} could not be read (${reasons}).`);
  }
  if (s.fromHistory > 0) lines.push(`${s.fromHistory} from the history store.`);
  return lines;
}
