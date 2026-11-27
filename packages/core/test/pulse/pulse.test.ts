// Ticket #27: Pulse over hand-built replays with fixed instants. Every value is invented.
import { describe, expect, it } from "vitest";
import {
  PULSE_DEFINITIONS,
  PULSE_REPORT_VERSION,
  TOOL_KINDS,
  buildReplay,
  pulseReport,
  pulseSessionStart,
  type ParsedReply,
  type ParsedRun,
  type ParsedSession,
  type ParsedSubagentRun,
  type ParsedToolCall,
  type PulseReport,
} from "../../src/index.js";
import { filledCells, gridSum, reply, sessionOf, tool } from "./helpers.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Monday 30 November 2026, 10:00 UTC. */
const MONDAY_10 = Date.UTC(2026, 10, 30, 10, 0);

describe("pulseReport with no sessions", () => {
  const report = pulseReport([]);

  it("gives zero everywhere, a full 7 by 24 grid and every tool kind", () => {
    expect(report.version).toBe(PULSE_REPORT_VERSION);
    expect(report.timeZone).toBe("UTC");
    expect(report.range).toEqual({ since: null, until: null });
    expect(report.totals).toEqual({
      sessions: 0,
      spanMs: 0,
      activeMs: 0,
      idleMs: 0,
      agents: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      openToolCalls: 0,
      replies: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      keys: [],
    });
    expect(report.hourOfWeek.weekdays).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(report.hourOfWeek.cells).toHaveLength(7);
    for (const row of report.hourOfWeek.cells) expect(row).toHaveLength(24);
    expect(filledCells(report)).toEqual({});
    expect(report.tools.byKind.map((entry) => entry.kind)).toEqual([...TOOL_KINDS]);
    expect(report.tools.byKind.every((entry) => entry.calls === 0)).toBe(true);
    expect(report.tools.byName).toEqual([]);
    expect(report.tools.total).toEqual({ calls: 0, failed: 0, open: 0, keys: [] });
    expect(report.timeline).toEqual([]);
    expect(report.idle).toEqual({
      totalMs: 0,
      gaps: 0,
      longestGapMs: 0,
      keys: [],
      waitingOnUser: { known: false },
    });
    expect(report.skipped).toEqual({ outOfRange: 0, duplicate: 0, invalid: 0 });
    expect(report.definitions).toBe(PULSE_DEFINITIONS);
  });
});

describe("pulseReport for one session with an idle gap", () => {
  // 100 s on the compressed timeline, with one hour cut after 40 s: 3700 s of real time,
  // ending at Monday 10:00 UTC, so starting at 08:58:20.
  const input = sessionOf("claude-code:widget-0001", MONDAY_10, {
    duration: 100,
    warps: [{ at: 40, skipped: 3600 }],
    replies: [reply(1), reply(50, 1, 2, 3, 4)],
    tools: [tool("Bash", "shell", 2, 30)],
  });
  const report = pulseReport([input]);

  it("places the session from its last activity back by its real length", () => {
    expect(report.timeline).toEqual([
      {
        key: "claude-code:widget-0001",
        start: MONDAY_10 - 3700 * SECOND,
        end: MONDAY_10,
        spanMs: 3_700_000,
        activeMs: 100_000,
        idleMs: 3_600_000,
        idleGaps: 1,
        agents: 1,
        toolCalls: 1,
        failedToolCalls: 0,
        openToolCalls: 0,
        replies: 2,
        tokens: { input: 11, output: 22, cacheRead: 33, cacheCreation: 44 },
        live: "ended",
        anchor: "last-activity",
      },
    ]);
  });

  it("splits active and idle time by the hour they really happened in", () => {
    // Active 08:58:20-08:59:00, idle 08:59:00-09:59:00, active 09:59:00-10:00:00.
    expect(filledCells(report)).toEqual({
      "mon-8": { activeMs: 40 * SECOND, idleMs: 60 * SECOND, sessionsStarted: 1 },
      "mon-9": { activeMs: 60 * SECOND, idleMs: 59 * MINUTE, sessionsStarted: 0 },
    });
    expect(gridSum(report, "activeMs")).toBe(report.totals.activeMs);
    expect(gridSum(report, "idleMs")).toBe(report.totals.idleMs);
  });

  it("reports idle time under its own name and does not claim to know waiting time", () => {
    expect(report.idle).toEqual({
      totalMs: 3_600_000,
      gaps: 1,
      longestGapMs: 3_600_000,
      keys: ["claude-code:widget-0001"],
      waitingOnUser: { known: false },
    });
  });

  it("uses the real start instead when the caller gives it", () => {
    const start = MONDAY_10 - 2 * HOUR;
    const given = pulseReport([{ ...input, startedAt: start }]);
    expect(given.timeline[0]).toMatchObject({ start, end: start + 3_700_000, anchor: "start" });
  });
});

describe("tool mix", () => {
  const report = pulseReport([
    sessionOf("claude-code:widget-a", MONDAY_10, {
      duration: 60,
      tools: [
        tool("Bash", "shell", 1, 2, true),
        tool("Bash", "shell", 3, null),
        tool("Read", "read"),
        tool("mcp:docs", "mcp", 4, 5, true),
      ],
      subagents: [[tool("Grep", "read"), tool("Bash", "shell")]],
    }),
    sessionOf("claude-code:widget-b", MONDAY_10 + HOUR, {
      duration: 60,
      tools: [tool("Read", "read"), tool("Agent", "agent"), tool("Edit", "edit")],
    }),
  ]);

  it("counts calls, failures and open calls by kind, in TOOL_KINDS order", () => {
    expect(report.tools.byKind).toEqual([
      { kind: "shell", calls: 3, failed: 1, open: 1, keys: ["claude-code:widget-a"] },
      {
        kind: "read",
        calls: 3,
        failed: 0,
        open: 0,
        keys: ["claude-code:widget-a", "claude-code:widget-b"],
      },
      { kind: "edit", calls: 1, failed: 0, open: 0, keys: ["claude-code:widget-b"] },
      { kind: "agent", calls: 1, failed: 0, open: 0, keys: ["claude-code:widget-b"] },
      { kind: "mcp", calls: 1, failed: 1, open: 0, keys: ["claude-code:widget-a"] },
      { kind: "other", calls: 0, failed: 0, open: 0, keys: [] },
    ]);
  });

  it("counts by name, most calls first, then by name", () => {
    expect(report.tools.byName.map((entry) => [entry.name, entry.kind, entry.calls])).toEqual([
      ["Bash", "shell", 3],
      ["Read", "read", 2],
      ["Agent", "agent", 1],
      ["Edit", "edit", 1],
      ["Grep", "read", 1],
      ["mcp:docs", "mcp", 1],
    ]);
    expect(report.tools.byName[1]?.keys).toEqual(["claude-code:widget-a", "claude-code:widget-b"]);
  });

  it("adds up: kinds, names, timeline and totals agree", () => {
    const sum = (list: readonly { calls: number }[]) => list.reduce((s, e) => s + e.calls, 0);
    expect(sum(report.tools.byKind)).toBe(report.tools.total.calls);
    expect(sum(report.tools.byName)).toBe(report.tools.total.calls);
    expect(report.tools.total).toMatchObject({ calls: 9, failed: 2, open: 1 });
    expect(report.totals).toMatchObject({
      toolCalls: 9,
      failedToolCalls: 2,
      openToolCalls: 1,
      agents: 3,
    });
  });
});

describe("keys", () => {
  it("lists in every bucket and total the sessions it came from, in timeline order", () => {
    const report = pulseReport([
      // Given newest first, as a listing returns them; the timeline sorts by start.
      sessionOf("claude-code:late", MONDAY_10 + 3 * HOUR, { duration: 600 }),
      sessionOf("claude-code:early", MONDAY_10, { duration: 600 }),
      sessionOf("claude-code:also-early", MONDAY_10, { duration: 600 }),
    ]);
    expect(report.totals.keys).toEqual([
      "claude-code:also-early",
      "claude-code:early",
      "claude-code:late",
    ]);
    const cells = report.hourOfWeek.cells[0] ?? [];
    expect(cells[9]?.keys).toEqual(["claude-code:also-early", "claude-code:early"]);
    expect(cells[12]?.keys).toEqual(["claude-code:late"]);
    expect(cells[10]?.keys).toEqual([]);
    expect(report.idle.keys).toEqual([]);
  });
});

describe("range and bad input", () => {
  const sessions = [
    sessionOf("claude-code:one", MONDAY_10, { duration: 600 }), // starts 09:50
    sessionOf("claude-code:two", MONDAY_10 + HOUR, { duration: 600 }), // starts 10:50
    sessionOf("claude-code:three", MONDAY_10 + 2 * HOUR, { duration: 600 }), // starts 11:50
  ];

  it("counts a session when its start is at or after since and before until", () => {
    const since = MONDAY_10 + 50 * MINUTE; // exactly the start of "two"
    const until = MONDAY_10 + 110 * MINUTE; // exactly the start of "three"
    const report = pulseReport(sessions, { since, until });
    expect(report.totals.keys).toEqual(["claude-code:two"]);
    expect(report.skipped).toEqual({ outOfRange: 2, duplicate: 0, invalid: 0 });
    expect(report.range).toEqual({ since, until });
  });

  it("counts a session whole, even when it runs past until", () => {
    const report = pulseReport(sessions, { until: MONDAY_10 - 5 * MINUTE });
    expect(report.totals).toMatchObject({ sessions: 1, activeMs: 600_000 });
    expect(report.timeline[0]?.end).toBe(MONDAY_10);
  });

  it("skips a repeated key and an input it cannot place, and says so", () => {
    const report = pulseReport([
      ...sessions,
      sessionOf("claude-code:one", MONDAY_10, { duration: 5 }),
      sessionOf("claude-code:bad-time", Number.NaN, { duration: 5 }),
      sessionOf("claude-code:bad-length", MONDAY_10, { duration: -1 }),
      sessionOf("claude-code:bad-start", MONDAY_10, { duration: 5 }, { startedAt: Infinity }),
    ]);
    expect(report.totals.sessions).toBe(3);
    expect(report.skipped).toEqual({ outOfRange: 0, duplicate: 1, invalid: 3 });
  });

  it("throws on an unknown zone or a bad since, without repeating the value", () => {
    expect(() => pulseReport([], { timeZone: "Mars/Widget_Base" })).toThrow(RangeError);
    expect(() => pulseReport([], { since: Number.NaN })).toThrow(RangeError);
    expect(() => pulseReport([], { until: Infinity })).toThrow(/until/);
  });
});

describe("time zones, daylight saving and the week boundary", () => {
  it("moves the same sessions between cells by zone and keeps every total", () => {
    const sessions = [
      sessionOf("claude-code:night", Date.UTC(2026, 10, 30, 0, 30), { duration: 3600 }),
    ];
    const utc = pulseReport(sessions, { timeZone: "UTC" });
    const tokyo = pulseReport(sessions, { timeZone: "Asia/Tokyo" });
    const ny = pulseReport(sessions, { timeZone: "America/New_York" });
    // Sunday 23:30 to Monday 00:30 UTC: across the week boundary.
    expect(filledCells(utc)).toEqual({
      "sun-23": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 1 },
      "mon-0": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 0 },
    });
    expect(filledCells(tokyo)).toEqual({
      "mon-8": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 1 },
      "mon-9": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 0 },
    });
    expect(filledCells(ny)).toEqual({
      "sun-18": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 1 },
      "sun-19": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 0 },
    });
    for (const report of [tokyo, ny]) {
      expect(report.totals).toEqual(utc.totals);
      expect(report.timeline).toEqual(utc.timeline);
    }
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
  });

  it("splits a session across London's spring-forward change", () => {
    // 29 March 2026: 00:30 GMT to 03:30 BST is two real hours; a 20-minute idle gap is cut
    // from 00:50 GMT to 02:10 BST (00:50 to 01:10 UTC).
    const report = pulseReport(
      [
        sessionOf("claude-code:spring", Date.UTC(2026, 2, 29, 2, 30), {
          duration: 100 * 60,
          warps: [{ at: 20 * 60, skipped: 20 * 60 }],
        }),
      ],
      { timeZone: "Europe/London" },
    );
    expect(filledCells(report)).toEqual({
      "sun-0": { activeMs: 20 * MINUTE, idleMs: 10 * MINUTE, sessionsStarted: 1 },
      "sun-2": { activeMs: 50 * MINUTE, idleMs: 10 * MINUTE, sessionsStarted: 0 },
      "sun-3": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 0 },
    });
    expect(report.totals).toMatchObject({ spanMs: 2 * HOUR, activeMs: 100 * MINUTE });
  });

  it("gives the repeated hour both real hours on London's fall-back day", () => {
    // 25 October 2026: 00:30 to 02:30 UTC is 01:30 BST to 02:30 GMT.
    const report = pulseReport(
      [sessionOf("claude-code:autumn", Date.UTC(2026, 9, 25, 2, 30), { duration: 2 * 3600 })],
      { timeZone: "Europe/London" },
    );
    expect(filledCells(report)).toEqual({
      "sun-1": { activeMs: 90 * MINUTE, idleMs: 0, sessionsStarted: 1 },
      "sun-2": { activeMs: 30 * MINUTE, idleMs: 0, sessionsStarted: 0 },
    });
  });
});

describe("arithmetic", () => {
  it("keeps whole milliseconds when replay seconds are not exact in binary", () => {
    const report = pulseReport([
      sessionOf("claude-code:float", MONDAY_10, {
        duration: 0.3,
        warps: [
          { at: 0.1, skipped: 0.2 },
          { at: 0.2, skipped: 45.123 },
        ],
      }),
    ]);
    const entry = report.timeline[0];
    expect(entry).toMatchObject({ spanMs: 45_623, activeMs: 300, idleMs: 45_323, idleGaps: 2 });
    for (const value of [entry?.spanMs, entry?.activeMs, entry?.idleMs, entry?.start]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(gridSum(report, "activeMs") + gridSum(report, "idleMs")).toBe(45_623);
    expect(report.idle.longestGapMs).toBe(45_123);
  });
});

describe("time that runs at the same time", () => {
  it("adds up overlapping sessions: each counts its own time, so an hour cell can exceed an hour", () => {
    // Two sessions of 40 min with no idle time, 10:00-10:40 and 10:10-10:50 on Monday: their
    // wall-clock union is 50 min, but the 10:00 cell and the totals hold 80 min.
    const report = pulseReport([
      sessionOf("claude-code:overlap-a", MONDAY_10 + 40 * MINUTE, { duration: 2400 }),
      sessionOf("claude-code:overlap-b", MONDAY_10 + 50 * MINUTE, { duration: 2400 }),
    ]);
    const union = 50 * MINUTE;
    expect(filledCells(report)).toEqual({
      "mon-10": { activeMs: 80 * MINUTE, idleMs: 0, sessionsStarted: 2 },
    });
    expect(report.totals.activeMs).toBe(80 * MINUTE);
    expect(report.totals.activeMs).toBeGreaterThan(union);
    expect(report.hourOfWeek.cells[0]?.[10]?.activeMs).toBeGreaterThan(HOUR);
    expect(report.hourOfWeek.cells[0]?.[10]?.keys).toEqual([
      "claude-code:overlap-a",
      "claude-code:overlap-b",
    ]);
    expect(PULSE_DEFINITIONS.active).toMatch(/sessions that overlap each count their own time/);
    expect(PULSE_DEFINITIONS.hourOfWeek).toMatch(/an hour cell can hold more than an hour/);
  });

  it("counts parallel subagents and tool calls in one session once: active is the union", () => {
    // A parsed session built by hand: the main agent runs two tool calls at once for 10 min,
    // and two subagents each run a call over nearly the same 10 min. Nothing is idle.
    const t0 = MONDAY_10;
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const replyAt = (messageId: string, at: number, toolUseIds: string[]): ParsedReply => ({
      messageId,
      model: "claude-opus-5-5",
      effort: null,
      firstAt: at,
      lastAt: at,
      usage,
      toolUseIds,
      lineCount: 1,
    });
    const call = (id: string, messageId: string, from: number, to: number): ParsedToolCall => ({
      toolUseId: id,
      name: "Bash",
      mcpServer: null,
      kind: "shell",
      messageId,
      startedAt: from,
      endedAt: to,
      isError: false,
      spawnedAgentId: null,
    });
    const main: ParsedRun = {
      replies: [replyAt("m1", t0, ["c1", "c2"]), replyAt("m2", t0 + 10 * MINUTE, [])],
      toolCalls: [call("c1", "m1", t0, t0 + 10 * MINUTE), call("c2", "m1", t0, t0 + 10 * MINUTE)],
      userLines: 3,
      startedAt: t0,
      endedAt: t0 + 10 * MINUTE,
    };
    const sub = (agentId: string): ParsedSubagentRun => ({
      replies: [replyAt(`${agentId}-r`, t0 + SECOND, [`${agentId}-c`])],
      toolCalls: [call(`${agentId}-c`, `${agentId}-r`, t0 + SECOND, t0 + 10 * MINUTE - SECOND)],
      userLines: 1,
      startedAt: t0 + SECOND,
      endedAt: t0 + 10 * MINUTE - SECOND,
      agentId,
      agentType: "widget-helper",
      model: "claude-haiku-4-5",
      spawnDepth: 1,
      isBuiltIn: false,
      finished: true,
      parentToolUseId: null,
      parentAgentId: null,
    });
    const parsed: ParsedSession = {
      runtime: "claude-code",
      sessionId: null,
      main,
      subagents: [sub("s1"), sub("s2")],
      versionsSeen: [],
      lines: { total: 9, unknownByType: {}, malformed: 0 },
    };
    const replay = buildReplay(parsed);
    const report = pulseReport([
      { summary: { key: "claude-code:parallel", lastActivity: t0 }, replay, startedAt: t0 },
    ]);
    const busyPerAgent = replay.agents.reduce(
      (sum, agent) => sum + agent.tools.reduce((s, t) => s + ((t.end ?? t.start) - t.start), 0),
      0,
    );
    expect(report.totals.agents).toBe(3);
    expect(report.totals.toolCalls).toBe(4);
    expect(report.totals.idleMs).toBe(0);
    expect(report.totals.activeMs).toBe(10 * MINUTE);
    expect(report.totals.spanMs).toBe(10 * MINUTE);
    // The sum over agents and calls is far more than the session's active time.
    expect(busyPerAgent * SECOND).toBeGreaterThan(3 * report.totals.activeMs);
    expect(filledCells(report)).toEqual({
      "mon-10": { activeMs: 10 * MINUTE, idleMs: 0, sessionsStarted: 1 },
    });
    expect(PULSE_DEFINITIONS.active).toMatch(/run at once counts once/);
  });
});

describe("the report shape", () => {
  const report: PulseReport = pulseReport(
    [
      sessionOf("claude-code:shape", MONDAY_10, {
        duration: 60,
        warps: [{ at: 30, skipped: 100 }],
        tools: [tool("Bash", "shell")],
        replies: [reply(1)],
      }),
    ],
    { timeZone: "Europe/London", since: 0, until: MONDAY_10 * 2 },
  );

  it("survives JSON unchanged (no bigint, no undefined, no class instances)", () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("has exactly these keys", () => {
    expect(Object.keys(report)).toEqual([
      "version",
      "timeZone",
      "range",
      "definitions",
      "totals",
      "hourOfWeek",
      "tools",
      "timeline",
      "idle",
      "skipped",
    ]);
    expect(Object.keys(report.definitions)).toEqual([
      "sessionTime",
      "active",
      "idle",
      "waitingOnUser",
      "hourOfWeek",
      "range",
    ]);
    expect(Object.keys(report.totals)).toEqual([
      "sessions",
      "spanMs",
      "activeMs",
      "idleMs",
      "agents",
      "toolCalls",
      "failedToolCalls",
      "openToolCalls",
      "replies",
      "tokens",
      "keys",
    ]);
    expect(Object.keys(report.hourOfWeek)).toEqual(["weekdays", "cells"]);
    expect(Object.keys(report.hourOfWeek.cells[0]?.[0] ?? {})).toEqual([
      "weekday",
      "hour",
      "activeMs",
      "idleMs",
      "sessionsStarted",
      "keys",
    ]);
    expect(Object.keys(report.tools)).toEqual(["byKind", "byName", "total"]);
    expect(Object.keys(report.tools.byKind[0] ?? {})).toEqual([
      "kind",
      "calls",
      "failed",
      "open",
      "keys",
    ]);
    expect(Object.keys(report.tools.byName[0] ?? {})).toEqual([
      "name",
      "kind",
      "calls",
      "failed",
      "open",
      "keys",
    ]);
    expect(Object.keys(report.timeline[0] ?? {})).toEqual([
      "key",
      "start",
      "end",
      "spanMs",
      "activeMs",
      "idleMs",
      "idleGaps",
      "agents",
      "toolCalls",
      "failedToolCalls",
      "openToolCalls",
      "replies",
      "tokens",
      "live",
      "anchor",
    ]);
    expect(Object.keys(report.idle)).toEqual([
      "totalMs",
      "gaps",
      "longestGapMs",
      "keys",
      "waitingOnUser",
    ]);
    expect(Object.keys(report.skipped)).toEqual(["outOfRange", "duplicate", "invalid"]);
  });
});

describe("pulseSessionStart", () => {
  it("gives the start pulseReport uses, or null for an input it would skip", () => {
    const input = sessionOf("claude-code:start", MONDAY_10, {
      duration: 60,
      warps: [{ at: 10, skipped: 40 }],
    });
    expect(pulseSessionStart(input)).toBe(MONDAY_10 - 100 * SECOND);
    expect(pulseSessionStart(input)).toBe(pulseReport([input]).timeline[0]?.start);
    expect(pulseSessionStart({ ...input, startedAt: 5 })).toBe(5);
    expect(pulseSessionStart(sessionOf("claude-code:nan", Number.NaN, { duration: 1 }))).toBe(null);
  });
});
