/**
 * Ticket #27: Pulse, an activity summary across sessions. Pure and browser-safe (no Node API), so
 * the command line (`orbitrace pulse`) and the app's charts compute the same numbers.
 *
 * Input: replays with their session summaries. Output: an hour-of-week grid (7 by 24) of active
 * time, idle time and sessions started; the tool mix; a session timeline; and idle time. Every
 * bucket and total lists the session keys it came from, so a chart can link to its sessions.
 *
 * What the replay model records, and so what the numbers can mean (docs/pulse.md):
 *
 * - A replay has no wall-clock time. Its times are seconds from the session start on a timeline
 *   whose long idle stretches were cut (`ReplayWarp`). The real length of a session is
 *   `totals.realDuration`. To place a session on the calendar, Pulse uses the real start the
 *   caller passes (`startedAt`, the first timestamp of the transcripts). Without it, Pulse
 *   anchors the end at the summary's `lastActivity` (the newest write to its transcripts), so it
 *   starts `realDuration` before that.
 * - Idle: the real time the replay builder removed (the sum of `warps[].skipped`). The builder
 *   removes a stretch only when nothing was in progress for longer than its idle gap (45 s by
 *   default): no reply line (with a few seconds of padding), no open tool call and no running
 *   subagent. It keeps a few seconds (8 s by default) of each such stretch on the timeline.
 * - Active: the rest of the session's real length, that is the length of the compressed timeline
 *   (`totals.duration`). Active plus idle is always the real length. The compressed timeline is
 *   one line for the whole session, so parallel subagents and tool calls count once; across
 *   sessions, time is summed per session, so overlapping sessions each add their own.
 * - Waiting on the user is not known. A replay keeps no user prompts, so an idle stretch can be
 *   the user reading or away, but also the model's time before the first line of its next reply;
 *   and a tool call waiting for the user's permission is an open call, so it counts as active.
 *   Pulse reports idle time under that neutral name and says it is not waiting time.
 *
 * Arithmetic: whole milliseconds. Replay times are on a 1 ms grid (seconds with three decimals),
 * so each is turned into an integer once, with `Math.round(seconds * 1000)`, and every sum after
 * that is exact. The grid's cells add up to the totals exactly.
 */

import type { ReplayModel, ToolKind } from "../model/replay.js";
import { TOOL_KINDS } from "../model/replay.js";
import type { EpochMs } from "../model/parsed.js";
import type { LiveStatus, SessionSummary } from "../model/sources.js";
import { cutsFromWarps } from "../replay/timeline.js";
import { PULSE_WEEKDAYS, createZoneClock, type PulseWeekday } from "./zone.js";

/** The version of the `PulseReport` shape. Any change to the shape bumps it. */
export const PULSE_REPORT_VERSION = 1 as const;

/** Plain statements of what each figure means, written into every report. See docs/pulse.md. */
export const PULSE_DEFINITIONS = {
  sessionTime:
    "A replay holds no clock time. A session starts at the real start the caller gives (the first timestamp of its transcripts; orbitrace pulse gives it) and lasts its real length. Without it, the session ends at its last activity (the newest write to its transcripts) and starts its real length before that.",
  active:
    "Real time of a session minus its idle time: the length of the replay's compressed timeline. It includes pauses shorter than the idle gap (45 s by default) and the few seconds (8 s by default) the timeline keeps of each longer pause. Within a session, time when several agents or tool calls run at once counts once. Across sessions, time is per session and adds up: sessions that overlap each count their own time, so a total can exceed the wall-clock time it covers.",
  idle: "Real time the replay builder cut from the timeline: stretches longer than the idle gap in which no reply, tool call or subagent was in progress, less the seconds kept of each.",
  waitingOnUser:
    "Not known. A replay records no user prompts, so idle time cannot be split into waiting on the user and other pauses (such as the model's time before its next reply), and a tool call waiting for permission counts as active.",
  hourOfWeek:
    "Days Monday to Sunday and hours 0 to 23 in the stated time zone; a week starts on Monday at 00:00. Time that crosses an hour or a daylight-saving change is split at it. Within a session, time when several agents or tool calls run at once counts once; sessions that overlap each add their own time, so an hour cell can hold more than an hour.",
  range:
    "A session is counted, whole, when its start is at or after 'since' and before 'until'. Its time is placed in the hours it really covered, even past 'until'.",
} as const;

/** One session for Pulse: its path-free summary and its replay. */
export interface PulseSessionInput {
  /** `key` and `lastActivity` are used; `live` is copied to the timeline. */
  readonly summary: Pick<SessionSummary, "key" | "lastActivity"> &
    Partial<Pick<SessionSummary, "live">>;
  readonly replay: ReplayModel;
  /**
   * The session's real start, epoch milliseconds, when the caller knows it (the first timestamp
   * of its transcripts). Without it the start is `lastActivity` minus the real length.
   */
  readonly startedAt?: EpochMs;
}

export interface PulseOptions {
  /** IANA time zone for the hour-of-week grid, for example `Europe/London`. Default `UTC`. */
  readonly timeZone?: string;
  /** Count only sessions that start at or after this time, epoch milliseconds. */
  readonly since?: EpochMs;
  /** Count only sessions that start before this time, epoch milliseconds. */
  readonly until?: EpochMs;
}

/** Token counts in the four classes. */
export interface PulseTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/** How a session's place on the calendar was found. */
export type PulseAnchor = "last-activity" | "start";

/** One session on the timeline. Times are epoch milliseconds; lengths are milliseconds. */
export interface PulseTimelineEntry {
  readonly key: string;
  readonly start: EpochMs;
  readonly end: EpochMs;
  /** `end - start`: the real length of the session. Always `activeMs + idleMs`. */
  readonly spanMs: number;
  readonly activeMs: number;
  readonly idleMs: number;
  /** Number of idle stretches cut (warps). */
  readonly idleGaps: number;
  /** Main agent and subagents. */
  readonly agents: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  /** Tool calls with no result seen (still running, or the result line is missing). */
  readonly openToolCalls: number;
  readonly replies: number;
  readonly tokens: PulseTokens;
  readonly live: LiveStatus | null;
  readonly anchor: PulseAnchor;
}

/** One hour of the week. */
export interface PulseHourCell {
  readonly weekday: PulseWeekday;
  readonly hour: number;
  readonly activeMs: number;
  readonly idleMs: number;
  /** Sessions whose start falls in this hour. */
  readonly sessionsStarted: number;
  /** Sessions with active time, idle time or a start in this hour, in timeline order. */
  readonly keys: readonly string[];
}

/** The hour-of-week grid: `cells[weekday][hour]`, Monday first. */
export interface PulseHourOfWeek {
  readonly weekdays: readonly PulseWeekday[];
  readonly cells: readonly (readonly PulseHourCell[])[];
}

/** Calls of one tool kind or one tool name. */
export interface PulseToolCount {
  readonly calls: number;
  readonly failed: number;
  readonly open: number;
  /** Sessions with at least one such call, in timeline order. */
  readonly keys: readonly string[];
}

export interface PulseToolKindEntry extends PulseToolCount {
  readonly kind: ToolKind;
}

export interface PulseToolNameEntry extends PulseToolCount {
  /** The tool's label as in the replay: `Bash`, `mcp:<server>`, ... */
  readonly name: string;
  readonly kind: ToolKind;
}

export interface PulseToolMix {
  /** Every kind of `TOOL_KINDS`, in that order, zeros included. */
  readonly byKind: readonly PulseToolKindEntry[];
  /** Most calls first, then by name and kind. */
  readonly byName: readonly PulseToolNameEntry[];
  readonly total: PulseToolCount;
}

export interface PulseIdle {
  readonly totalMs: number;
  /** Idle stretches cut, across sessions. */
  readonly gaps: number;
  /** Longest single stretch removed, 0 when there is none. */
  readonly longestGapMs: number;
  /** Sessions with idle time, in timeline order. */
  readonly keys: readonly string[];
  /** Waiting on the user cannot be told from other idle time; see `PULSE_DEFINITIONS`. */
  readonly waitingOnUser: { readonly known: false };
}

export interface PulseTotals {
  readonly sessions: number;
  readonly spanMs: number;
  readonly activeMs: number;
  readonly idleMs: number;
  readonly agents: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly openToolCalls: number;
  readonly replies: number;
  readonly tokens: PulseTokens;
  /** Every session counted, in timeline order. */
  readonly keys: readonly string[];
}

/** Inputs left out, by reason. */
export interface PulseSkipped {
  /** Start outside `[since, until)`. */
  readonly outOfRange: number;
  /** A key already seen earlier in the input. */
  readonly duplicate: number;
  /** A `lastActivity`, `startedAt` or replay length that is not a finite number of 0 or more. */
  readonly invalid: number;
}

export interface PulseReport {
  readonly version: typeof PULSE_REPORT_VERSION;
  /** The zone the grid is in, as `Intl` resolved it. */
  readonly timeZone: string;
  readonly range: { readonly since: EpochMs | null; readonly until: EpochMs | null };
  readonly definitions: typeof PULSE_DEFINITIONS;
  readonly totals: PulseTotals;
  readonly hourOfWeek: PulseHourOfWeek;
  readonly tools: PulseToolMix;
  /** Sessions by start, then key. */
  readonly timeline: readonly PulseTimelineEntry[];
  readonly idle: PulseIdle;
  readonly skipped: PulseSkipped;
}

/** Seconds on the replay's 1 ms grid to whole milliseconds. */
const toMs = (seconds: number): number => Math.round(seconds * 1000);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** An ordered set of keys: each key once, in the order first added. */
class KeyList {
  readonly #seen = new Set<string>();
  readonly #keys: string[] = [];
  add(key: string): void {
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#keys.push(key);
  }
  list(): string[] {
    return [...this.#keys];
  }
}

interface MutableCount {
  calls: number;
  failed: number;
  open: number;
  keys: KeyList;
}

const newCount = (): MutableCount => ({ calls: 0, failed: 0, open: 0, keys: new KeyList() });

const countOut = (count: MutableCount): PulseToolCount => ({
  calls: count.calls,
  failed: count.failed,
  open: count.open,
  keys: count.keys.list(),
});

interface MutableCell {
  activeMs: number;
  idleMs: number;
  sessionsStarted: number;
  keys: KeyList;
}

/** A session ready to be counted: its wall-clock place and its real-time active and idle parts. */
interface Placed {
  readonly input: PulseSessionInput;
  readonly key: string;
  readonly start: number;
  readonly realMs: number;
  /** Real removed ranges, milliseconds from the session start, sorted. */
  readonly cuts: readonly { readonly start: number; readonly end: number }[];
  readonly anchor: PulseAnchor;
}

/** Validate and place one input on the calendar, or say why it is left out. */
function place(input: PulseSessionInput): Placed | "invalid" {
  const { replay, summary } = input;
  const duration = replay?.totals?.duration;
  const warps = replay?.warps;
  if (!isTime(duration) || duration < 0 || !Array.isArray(warps)) return "invalid";
  if (warps.some((warp) => !isTime(warp?.at) || !isTime(warp.skipped) || warp.skipped < 0)) {
    return "invalid";
  }
  const cuts = cutsFromWarps(warps);
  const realMs = toMs(duration) + cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  if (input.startedAt !== undefined) {
    if (!isTime(input.startedAt)) return "invalid";
    const start = Math.round(input.startedAt);
    return { input, key: summary.key, start, realMs, cuts, anchor: "start" };
  }
  if (!isTime(summary?.lastActivity)) return "invalid";
  const start = Math.round(summary.lastActivity) - realMs;
  return { input, key: summary.key, start, realMs, cuts, anchor: "last-activity" };
}

/**
 * Where Pulse places a session on the calendar: its real start, epoch milliseconds, as
 * `pulseReport` computes it (`startedAt` when given, otherwise `lastActivity` minus the replay's
 * real length), or `null` for an input it would skip as invalid. A host that applies a limit
 * before calling `pulseReport` uses this to apply the same range rule.
 */
export function pulseSessionStart(input: PulseSessionInput): EpochMs | null {
  const placed = place(input);
  return placed === "invalid" ? null : placed.start;
}

function optionalTime(name: string, value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!isTime(value)) throw new RangeError(`pulse: option ${name} must be a finite epoch time`);
  return Math.round(value);
}

/**
 * The Pulse report of a set of sessions. Throws a `RangeError` for a time zone `Intl` does not
 * know or for a `since` or `until` that is not a finite number; a bad input session is left out
 * and counted in `skipped`, never thrown on.
 */
export function pulseReport(
  sessions: readonly PulseSessionInput[],
  options: PulseOptions = {},
): PulseReport {
  const clock = createZoneClock(options.timeZone ?? "UTC");
  const since = optionalTime("since", options.since);
  const until = optionalTime("until", options.until);

  const seen = new Set<string>();
  const skipped = { outOfRange: 0, duplicate: 0, invalid: 0 };
  const placed: Placed[] = [];
  for (const input of sessions) {
    const key = input?.summary?.key;
    if (typeof key !== "string") {
      skipped.invalid += 1;
      continue;
    }
    if (seen.has(key)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(key);
    const result = place(input);
    if (result === "invalid") {
      skipped.invalid += 1;
      continue;
    }
    if ((since !== null && result.start < since) || (until !== null && result.start >= until)) {
      skipped.outOfRange += 1;
      continue;
    }
    placed.push(result);
  }
  placed.sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const cells: MutableCell[][] = PULSE_WEEKDAYS.map(() =>
    Array.from({ length: 24 }, () => ({
      activeMs: 0,
      idleMs: 0,
      sessionsStarted: 0,
      keys: new KeyList(),
    })),
  );
  const cell = (weekday: number, hour: number): MutableCell =>
    (cells[weekday] as MutableCell[])[hour] as MutableCell;

  const byKind = new Map<ToolKind, MutableCount>(TOOL_KINDS.map((kind) => [kind, newCount()]));
  const byName = new Map<string, MutableCount & { name: string; kind: ToolKind }>();
  const toolTotal = newCount();
  const idleKeys = new KeyList();
  let idleGaps = 0;
  let longestGapMs = 0;
  const timeline: PulseTimelineEntry[] = [];

  for (const session of placed) {
    const { key, start, realMs, cuts, input } = session;
    const { replay } = input;

    // Sessions started, by the hour of the start.
    const startLocal = clock.localTime(start);
    const startCell = cell(startLocal.weekday, startLocal.hour);
    startCell.sessionsStarted += 1;
    startCell.keys.add(key);

    // Active and idle time, split by local hour.
    let cursor = 0;
    let idleMs = 0;
    let sessionGaps = 0;
    const addActive = (from: number, to: number): void => {
      clock.splitByLocalHour(start + from, start + to, (weekday, hour, ms) => {
        const target = cell(weekday, hour);
        target.activeMs += ms;
        target.keys.add(key);
      });
    };
    for (const cut of cuts) {
      const from = Math.max(cursor, Math.min(cut.start, realMs));
      const to = Math.max(from, Math.min(cut.end, realMs));
      addActive(cursor, from);
      clock.splitByLocalHour(start + from, start + to, (weekday, hour, ms) => {
        const target = cell(weekday, hour);
        target.idleMs += ms;
        target.keys.add(key);
      });
      idleMs += to - from;
      if (to > from) sessionGaps += 1;
      longestGapMs = Math.max(longestGapMs, to - from);
      cursor = to;
    }
    addActive(cursor, realMs);
    idleGaps += sessionGaps;
    if (idleMs > 0) idleKeys.add(key);

    // Tool mix.
    let toolCalls = 0;
    let failedToolCalls = 0;
    let openToolCalls = 0;
    for (const agent of replay.agents) {
      for (const tool of agent.tools) {
        const kindCount = byKind.get(tool.kind) ?? newCount();
        if (!byKind.has(tool.kind)) byKind.set(tool.kind, kindCount);
        const nameKey = `${tool.kind}\u0000${tool.name}`;
        let nameCount = byName.get(nameKey);
        if (nameCount === undefined) {
          nameCount = { ...newCount(), name: tool.name, kind: tool.kind };
          byName.set(nameKey, nameCount);
        }
        const open = tool.end === null;
        for (const count of [kindCount, nameCount, toolTotal]) {
          count.calls += 1;
          if (tool.failed) count.failed += 1;
          if (open) count.open += 1;
          count.keys.add(key);
        }
        toolCalls += 1;
        if (tool.failed) failedToolCalls += 1;
        if (open) openToolCalls += 1;
      }
    }

    const totals = replay.totals;
    timeline.push({
      key,
      start,
      end: start + realMs,
      spanMs: realMs,
      activeMs: realMs - idleMs,
      idleMs,
      idleGaps: sessionGaps,
      agents: replay.agents.length,
      toolCalls,
      failedToolCalls,
      openToolCalls,
      replies: totals.replies,
      tokens: {
        input: totals.inputTokens,
        output: totals.outputTokens,
        cacheRead: totals.cacheReadTokens,
        cacheCreation: totals.cacheCreationTokens,
      },
      live: input.summary.live ?? null,
      anchor: session.anchor,
    });
  }

  const sum = (pick: (entry: PulseTimelineEntry) => number): number =>
    timeline.reduce((total, entry) => total + pick(entry), 0);
  const totals: PulseTotals = {
    sessions: timeline.length,
    spanMs: sum((entry) => entry.spanMs),
    activeMs: sum((entry) => entry.activeMs),
    idleMs: sum((entry) => entry.idleMs),
    agents: sum((entry) => entry.agents),
    toolCalls: sum((entry) => entry.toolCalls),
    failedToolCalls: sum((entry) => entry.failedToolCalls),
    openToolCalls: sum((entry) => entry.openToolCalls),
    replies: sum((entry) => entry.replies),
    tokens: {
      input: sum((entry) => entry.tokens.input),
      output: sum((entry) => entry.tokens.output),
      cacheRead: sum((entry) => entry.tokens.cacheRead),
      cacheCreation: sum((entry) => entry.tokens.cacheCreation),
    },
    keys: timeline.map((entry) => entry.key),
  };

  const names = [...byName.values()].sort(
    (a, b) =>
      b.calls - a.calls ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  return {
    version: PULSE_REPORT_VERSION,
    timeZone: clock.timeZone,
    range: { since, until },
    definitions: PULSE_DEFINITIONS,
    totals,
    hourOfWeek: {
      weekdays: [...PULSE_WEEKDAYS],
      cells: cells.map((row, weekday) =>
        row.map((entry, hour) => ({
          weekday: PULSE_WEEKDAYS[weekday] as PulseWeekday,
          hour,
          activeMs: entry.activeMs,
          idleMs: entry.idleMs,
          sessionsStarted: entry.sessionsStarted,
          keys: entry.keys.list(),
        })),
      ),
    },
    tools: {
      byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, ...countOut(count) })),
      byName: names.map((entry) => ({ name: entry.name, kind: entry.kind, ...countOut(entry) })),
      total: countOut(toolTotal),
    },
    timeline,
    idle: {
      totalMs: totals.idleMs,
      gaps: idleGaps,
      longestGapMs,
      keys: idleKeys.list(),
      waitingOnUser: { known: false },
    },
    skipped,
  };
}
