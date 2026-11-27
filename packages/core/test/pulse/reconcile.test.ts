// Ticket #27: every Pulse figure reconciled with what the fixture generator says is true of each
// committed synthetic session (fixtures/manifest.json, written by the generator that wrote the
// transcripts), over every scenario, alone and all together. The sessions are invented
// (fixtures/README.md). Core cannot depend on @orbitrace/fixtures, so the files are read directly.
import { describe, expect, it } from "vitest";
import {
  REPLAY_BUILD_DEFAULTS,
  TOOL_KINDS,
  buildReplay,
  parseSession,
  pulseReport,
  type PulseReport,
  type PulseSessionInput,
  type ReplayModel,
} from "../../src/index.js";
import { loadCorpus, toInput } from "../export/audit-corpus.js";
import { manifestSessions, readReplay, type ManifestUsage } from "../ledger/helpers.js";
import { gridSum } from "./helpers.js";

interface Facts {
  firstTimestamp: string;
  lastTimestamp: string;
  replies: number;
  toolCalls: number;
  failedToolCalls: number;
  unfinishedToolCalls: number;
  mcpToolCalls: number;
  usage: ManifestUsage;
}

interface FixtureSession {
  name: string;
  goldenReplay: string;
  expected: {
    agents: Facts[];
    totals: Omit<Facts, "firstTimestamp" | "lastTimestamp">;
    scriptedIdleGaps: { seconds: number }[];
  };
}

const sessions = manifestSessions() as unknown as FixtureSession[];

const firstOf = (session: FixtureSession): number =>
  Math.min(...session.expected.agents.map((agent) => Date.parse(agent.firstTimestamp)));
const lastOf = (session: FixtureSession): number =>
  Math.max(...session.expected.agents.map((agent) => Date.parse(agent.lastTimestamp)));

/** The input `orbitrace pulse` builds: the summary's last activity is the last line's time. */
function inputOf(session: FixtureSession, replay?: ReplayModel): PulseSessionInput {
  return {
    summary: { key: `claude-code:fixture-${session.name}`, lastActivity: lastOf(session) },
    replay: replay ?? readReplay(session.goldenReplay),
  };
}

/** Checks that hold for any report: the parts add up to the totals, exactly. */
function expectInternallyConsistent(report: PulseReport): void {
  const { totals } = report;
  expect(gridSum(report, "activeMs")).toBe(totals.activeMs);
  expect(gridSum(report, "idleMs")).toBe(totals.idleMs);
  expect(gridSum(report, "sessionsStarted")).toBe(totals.sessions);
  expect(totals.activeMs + totals.idleMs).toBe(totals.spanMs);
  const calls = (list: readonly { calls: number; failed: number; open: number }[]) => ({
    calls: list.reduce((s, e) => s + e.calls, 0),
    failed: list.reduce((s, e) => s + e.failed, 0),
    open: list.reduce((s, e) => s + e.open, 0),
  });
  const expected = {
    calls: totals.toolCalls,
    failed: totals.failedToolCalls,
    open: totals.openToolCalls,
  };
  expect(calls(report.tools.byKind)).toEqual(expected);
  expect(calls(report.tools.byName)).toEqual(expected);
  expect(calls([report.tools.total])).toEqual(expected);
  expect(report.idle.totalMs).toBe(totals.idleMs);
  for (const entry of report.timeline) {
    expect(entry.activeMs + entry.idleMs).toBe(entry.spanMs);
    expect(entry.end - entry.start).toBe(entry.spanMs);
  }
  // Every key in a bucket is a counted session.
  const counted = new Set(totals.keys);
  for (const row of report.hourOfWeek.cells) {
    for (const cell of row) for (const key of cell.keys) expect(counted.has(key)).toBe(true);
  }
}

describe("Pulse reconciled with the fixture facts", () => {
  it("covers every fixture scenario", () => {
    expect(sessions.length).toBeGreaterThanOrEqual(9);
  });

  describe.each(sessions)("$name", (session) => {
    const replay = readReplay(session.goldenReplay);
    const report = pulseReport([inputOf(session, replay)]);
    const entry = report.timeline[0];
    const facts = session.expected.totals;

    it("starts at the first line and ends at the last line of the transcripts", () => {
      expect(entry?.start).toBe(firstOf(session));
      expect(entry?.end).toBe(lastOf(session));
      expect(entry?.spanMs).toBe(lastOf(session) - firstOf(session));
    });

    it("counts the agents, replies, tool calls, failures, open calls and tokens the facts list", () => {
      expect(entry).toMatchObject({
        agents: session.expected.agents.length,
        replies: facts.replies,
        toolCalls: facts.toolCalls,
        failedToolCalls: facts.failedToolCalls,
        openToolCalls: facts.unfinishedToolCalls,
        tokens: {
          input: facts.usage.input_tokens,
          output: facts.usage.output_tokens,
          cacheRead: facts.usage.cache_read_input_tokens,
          cacheCreation: facts.usage.cache_creation_input_tokens,
        },
      });
      const mcp = report.tools.byKind.find((kind) => kind.kind === "mcp");
      expect(mcp?.calls).toBe(facts.mcpToolCalls);
      expect(report.tools.byKind.map((kind) => kind.kind)).toEqual([...TOOL_KINDS]);
    });

    it("finds one idle gap per scripted idle stretch, each its length less what is kept", () => {
      const scripted = session.expected.scriptedIdleGaps;
      expect(entry?.idleGaps).toBe(scripted.length);
      const skipped = replay.warps.map((warp) => Math.round(warp.skipped * 1000));
      expect(entry?.idleMs).toBe(skipped.reduce((s, ms) => s + ms, 0));
      const keep = REPLAY_BUILD_DEFAULTS.idleKeepSeconds * 1000;
      scripted.forEach((gap, index) => {
        // The scripted pause sits between busy spans whose reply padding (3 s each side) and
        // line spacing move the cut by a few seconds either way; never by more than 15 s.
        expect(Math.abs((skipped[index] as number) - (gap.seconds * 1000 - keep))).toBeLessThan(
          15_000,
        );
      });
      expect(report.idle.keys).toEqual(scripted.length === 0 ? [] : [entry?.key]);
    });

    it("adds up inside the report", () => {
      expectInternallyConsistent(report);
      expect(report.totals.sessions).toBe(1);
    });
  });

  it("sums every scenario in one report to the sum of the facts", () => {
    const report = pulseReport(sessions.map((session) => inputOf(session)));
    expectInternallyConsistent(report);
    const sum = (pick: (s: FixtureSession) => number): number =>
      sessions.reduce((total, s) => total + pick(s), 0);
    expect(report.totals).toMatchObject({
      sessions: sessions.length,
      agents: sum((s) => s.expected.agents.length),
      replies: sum((s) => s.expected.totals.replies),
      toolCalls: sum((s) => s.expected.totals.toolCalls),
      failedToolCalls: sum((s) => s.expected.totals.failedToolCalls),
      openToolCalls: sum((s) => s.expected.totals.unfinishedToolCalls),
      spanMs: sum((s) => lastOf(s) - firstOf(s)),
      tokens: {
        input: sum((s) => s.expected.totals.usage.input_tokens),
        output: sum((s) => s.expected.totals.usage.output_tokens),
        cacheRead: sum((s) => s.expected.totals.usage.cache_read_input_tokens),
        cacheCreation: sum((s) => s.expected.totals.usage.cache_creation_input_tokens),
      },
    });
    expect(report.idle.gaps).toBe(sum((s) => s.expected.scriptedIdleGaps.length));
    // Timeline in start order.
    const starts = report.timeline.map((entry) => entry.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Each session started in the hour of its first line (the fixtures are in UTC).
    for (const session of sessions) {
      const first = new Date(firstOf(session));
      const weekday = (first.getUTCDay() + 6) % 7;
      const cell = report.hourOfWeek.cells[weekday]?.[first.getUTCHours()];
      expect(cell?.keys).toContain(`claude-code:fixture-${session.name}`);
    }
  });

  it("gives the same report from the transcripts, with the parsed start, as from the goldens", async () => {
    const byName = new Map(sessions.map((session) => [session.name, session]));
    const fromTranscripts: PulseSessionInput[] = [];
    for (const corpus of loadCorpus()) {
      const parsed = await parseSession(toInput(corpus));
      const session = byName.get(corpus.name) as FixtureSession;
      const starts = [parsed.main.startedAt, ...parsed.subagents.map((sub) => sub.startedAt)];
      const startedAt = Math.min(...starts.filter((time): time is number => time !== null));
      fromTranscripts.push({ ...inputOf(session, buildReplay(parsed)), startedAt });
    }
    const viaStart = pulseReport(fromTranscripts);
    const viaLastActivity = pulseReport(sessions.map((session) => inputOf(session)));
    expect(viaStart.timeline.every((entry) => entry.anchor === "start")).toBe(true);
    const strip = (report: PulseReport) => ({
      ...report,
      timeline: report.timeline.map((entry) => ({ ...entry, anchor: null })),
    });
    expect(strip(viaStart)).toEqual(strip(viaLastActivity));
  });
});
