/**
 * `orbitrace pulse` (#27) in-process, on the synthetic fixture sessions of a fake machine whose
 * every folder is temporary (HOME, CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR are set before any
 * call), with a fixed clock. Figures are reconciled with the fixture manifest's facts.
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listSessions, type SessionRef } from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import {
  CONFIG_FOLDER,
  SCENARIO_NAMES,
  fixturePaths,
  writeFixtureTree,
  writeGeneratedSession,
} from "@orbitrace/fixtures";
import { PULSE_DEFAULT_LIMIT } from "../src/args.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import type { PulseDocument } from "../src/pulse.js";
import { BASE_TIME_MS, makeTempDir, removeTempDirs, runBin } from "./helpers.js";
import {
  MARKER,
  SQLITE_AVAILABLE,
  SQLITE_NOTE,
  TEXT_WIDTH,
  firstOf,
  lastOf,
  makePulseMachine,
  markedSession,
  oneJson,
  orbitraceFilesExist,
  pulseRuntime,
  readManifest,
  runCli,
  spanOf,
  type PulseMachine,
} from "./pulse-helpers.js";

afterAll(() => {
  removeTempDirs();
});

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The exact keys of the `sessions` part of the document, in order. */
const SESSIONS_KEYS = [
  "listed",
  "read",
  "counted",
  "outOfRange",
  "notReadLimit",
  "limit",
  "unreadable",
  "fromHistory",
  "historyKeys",
];

/** Every line of a text output fits in TEXT_WIDTH columns and has no trailing space. */
function expectNarrow(text: string): void {
  const tooWide = text.split("\n").filter((line) => line.length > TEXT_WIDTH);
  const trailing = text.split("\n").filter((line) => line !== line.trimEnd());
  expect(tooWide).toEqual([]);
  expect(trailing).toEqual([]);
}

/** UTC `weekday-hour` cell name of an instant, Monday first, as in `hourOfWeek`. */
function utcCell(instant: number): string {
  const date = new Date(instant);
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getUTCDay()];
  return `${weekday}-${date.getUTCHours()}`;
}

/** Cells with sessions started, as `weekday-hour` to the count. */
function startedCells(doc: PulseDocument): Record<string, number> {
  const cells: Record<string, number> = {};
  for (const row of doc.hourOfWeek.cells) {
    for (const cell of row) {
      if (cell.sessionsStarted > 0) cells[`${cell.weekday}-${cell.hour}`] = cell.sessionsStarted;
    }
  }
  return cells;
}

/** File time of each scenario in a machine made with the default order (see helpers.ts). */
const fileTime = (name: string): number =>
  BASE_TIME_MS + SCENARIO_NAMES.indexOf(name as (typeof SCENARIO_NAMES)[number]) * MINUTE;

async function pulseJson(
  machine: PulseMachine,
  extra: readonly string[] = [],
): Promise<PulseDocument> {
  const result = await runCli(["pulse", "--json", "--tz", "UTC", ...extra], machine.host);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return oneJson<PulseDocument>(result.stdout);
}

async function fileSessions(machine: PulseMachine): Promise<readonly SessionRef[]> {
  return listSessions(
    [
      {
        runtime: "claude-code",
        root: machine.configDir,
        resolvedBy: "user-setting",
        available: true,
      },
    ],
    [claudeCodeAdapter],
  );
}

describe("orbitrace pulse on the fixture sessions", { timeout: 30_000 }, () => {
  const machine = makePulseMachine();
  const manifest = readManifest(machine.fixturesDir);

  it("counts every session and reconciles each total with the fixture facts", async () => {
    const doc = await pulseJson(machine);
    const sum = (pick: (facts: (typeof manifest)[number]) => number): number =>
      manifest.reduce((total, facts) => total + pick(facts), 0);
    expect(doc.totals).toMatchObject({
      sessions: manifest.length,
      toolCalls: sum((f) => f.expected.totals.toolCalls),
      failedToolCalls: sum((f) => f.expected.totals.failedToolCalls),
      openToolCalls: sum((f) => f.expected.totals.unfinishedToolCalls),
      replies: sum((f) => f.expected.totals.replies),
      agents: sum((f) => f.expected.agents.length),
      spanMs: sum(spanOf),
      tokens: {
        input: sum((f) => f.expected.totals.usage.input_tokens),
        output: sum((f) => f.expected.totals.usage.output_tokens),
        cacheRead: sum((f) => f.expected.totals.usage.cache_read_input_tokens),
        cacheCreation: sum((f) => f.expected.totals.usage.cache_creation_input_tokens),
      },
    });
    expect(doc.tools.byKind.find((entry) => entry.kind === "mcp")?.calls).toBe(
      sum((f) => f.expected.totals.mcpToolCalls),
    );
    expect(doc.sessions).toEqual({
      listed: manifest.length,
      read: manifest.length,
      counted: manifest.length,
      outOfRange: 0,
      notReadLimit: 0,
      limit: PULSE_DEFAULT_LIMIT,
      unreadable: { count: 0, byCode: {} },
      fromHistory: 0,
      historyKeys: [],
    });
    expect(doc.warnings).toEqual([]);
    expect(doc.project).toBeNull();
    expect(doc.timeZone).toBe("UTC");
  });

  it("places each session at the first timestamp of its transcripts, not at its file times", async () => {
    // The machine's file times are 15 January 2026 (see helpers.ts); the transcripts are dated
    // 2 February to 14 March 2026. Every figure must follow the transcripts.
    const doc = await pulseJson(machine);
    const refs = await fileSessions(machine);
    expect([...doc.totals.keys].sort()).toEqual(refs.map((ref) => ref.key).sort());
    const expectedCells: Record<string, number> = {};
    for (const facts of manifest) {
      const ref = refs.find((candidate) => candidate.lastActivity === fileTime(facts.name));
      expect(Math.abs(firstOf(facts) - fileTime(facts.name))).toBeGreaterThan(7 * DAY);
      const entry = doc.timeline.find((candidate) => candidate.key === ref?.key);
      expect(entry).toMatchObject({
        start: firstOf(facts),
        end: lastOf(facts),
        spanMs: spanOf(facts),
        toolCalls: facts.expected.totals.toolCalls,
        anchor: "start",
      });
      const cell = utcCell(firstOf(facts));
      expectedCells[cell] = (expectedCells[cell] ?? 0) + 1;
      const [weekday, hour] = cell.split("-");
      const day = doc.hourOfWeek.weekdays.indexOf(weekday as never);
      expect(doc.hourOfWeek.cells[day]?.[Number(hour)]?.keys).toContain(ref?.key);
    }
    expect(startedCells(doc)).toEqual(expectedCells);
    // Nothing is placed on the file times' day (Thursday 15 January 2026, 07:00 to 09:59).
    expect(expectedCells["thu-7"]).toBeUndefined();
  });

  it("writes a document with exactly these top-level keys, and creates nothing", async () => {
    const doc = await pulseJson(machine);
    expect(Object.keys(doc)).toEqual([
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
      "sessions",
      "project",
      "warnings",
    ]);
    expect(Object.keys(doc.sessions)).toEqual(SESSIONS_KEYS);
    expect(Object.keys(doc.sessions.unreadable)).toEqual(["count", "byCode"]);
    expect(doc.idle.waitingOnUser).toEqual({ known: false });
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("reads at most --limit sessions, the newest first, and says how many it did not read", async () => {
    const doc = await pulseJson(machine, ["--limit", "3"]);
    const newest = manifest.filter((facts) =>
      SCENARIO_NAMES.slice(-3).includes(facts.name as never),
    );
    expect(doc.timeline.map((entry) => entry.end).sort()).toEqual(newest.map(lastOf).sort());
    expect(doc.sessions).toMatchObject({
      listed: manifest.length,
      read: 3,
      counted: 3,
      notReadLimit: manifest.length - 3,
      limit: 3,
    });
    const text = await runCli(["pulse", "--limit", "3", "--tz", "UTC"], machine.host);
    expect(text.stdout).toContain(
      `Listed ${manifest.length}, read 3, counted 3.\n${manifest.length - 3} not read because of the limit of 3 (--limit).`,
    );
  });

  it("counts sessions outside the range against --limit, so the reading stays bounded", async () => {
    const doc = await pulseJson(machine, ["--until", "2026-01-01", "--limit", "2"]);
    expect(doc.sessions.read + doc.sessions.unreadable.count).toBeLessThanOrEqual(2);
    expect(doc.sessions).toMatchObject({
      listed: manifest.length,
      read: 2,
      counted: 0,
      outOfRange: 2,
      notReadLimit: manifest.length - 2,
    });
  });

  it("counts by start within --since and --until, in the --tz zone and relative to now", async () => {
    // The transcripts start on 2 February to 14 March 2026; idle-gap starts on Thursday
    // 5 February at 08:05 UTC, and four sessions start before 08:30 that day.
    const until = Date.UTC(2026, 1, 5, 8, 30);
    const expected = manifest.filter((facts) => firstOf(facts) < until);
    expect(expected.map((facts) => facts.name).sort()).toEqual(
      ["idle-gap", "single-agent", "tool-failures", "two-waves"].sort(),
    );
    const before = await pulseJson(machine, ["--until", "2026-02-05T08:30Z"]);
    expect(before.timeline.map((entry) => entry.start)).toEqual(expected.map(firstOf).sort());
    expect(before.sessions.outOfRange).toBe(manifest.length - expected.length);
    expect(before.range.until).toBe(until);
    // The same instant written in Tokyo time (UTC+9), and as a date-time read in --tz.
    const tokyo = await pulseJson(machine, ["--until", "2026-02-05T17:30+09:00"]);
    expect(tokyo.totals.keys).toEqual(before.totals.keys);
    const local = await runCli(
      ["pulse", "--json", "--tz", "Asia/Tokyo", "--until", "2026-02-05T17:30"],
      machine.host,
    );
    expect(oneJson<PulseDocument>(local.stdout).totals.keys).toEqual(before.totals.keys);
    // --since on the transcripts' dates, though every file time is before it.
    const march = await pulseJson(machine, ["--since", "2026-03-01"]);
    expect(march.timeline.map((entry) => entry.start)).toEqual(
      manifest.filter((facts) => facts.name === "demo").map(firstOf),
    );
    expect(march.sessions).toMatchObject({
      listed: manifest.length,
      outOfRange: manifest.length - 1,
    });
    // Relative to a fixed clock on 15 March 2026: two weeks back is 1 March.
    const now = Date.UTC(2026, 2, 15, 12, 0);
    const recent = await runCli(
      ["pulse", "--json", "--tz", "UTC", "--since", "2w"],
      machine.host,
      pulseRuntime(now),
    );
    const recentDoc = oneJson<PulseDocument>(recent.stdout);
    expect(recentDoc.range.since).toBe(now - 14 * DAY);
    expect(recentDoc.totals.keys).toEqual(march.totals.keys);
    const none = await pulseJson(machine, ["--since", "2026-03-15"]);
    expect(none.totals.sessions).toBe(0);
    expect(none.sessions.outOfRange).toBe(manifest.length);
  });

  it("counts only the sessions of --project", async () => {
    const doc = await pulseJson(machine, ["--project", "lantern-ledger"]);
    const expected = manifest.filter((facts) => facts.project === "lantern-ledger");
    expect(expected.length).toBeGreaterThan(1);
    expect(doc.totals.sessions).toBe(expected.length);
    expect(doc.totals.toolCalls).toBe(
      expected.reduce((sum, facts) => sum + facts.expected.totals.toolCalls, 0),
    );
    expect(doc.project).toBe("lantern-ledger");
    // The project name is filtered on, not written anywhere else in the document.
    expect(JSON.stringify({ ...doc, project: null })).not.toContain("lantern-ledger");
  });

  it("shows the summary as text, with the grid, the tool mix and the sessions, in 80 columns", async () => {
    const result = await runCli(["pulse", "--tz", "UTC"], machine.host);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain(`Pulse: ${manifest.length} sessions, all times.\nTime zone: UTC.`);
    expect(out).toContain("Idle is not the same as waiting on you: see docs/pulse.md.");
    expect(out).toContain("Sessions that overlap each count their own time");
    expect(out).toContain("Active time by hour of the week");
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(out).toMatch(new RegExp(`^  ${day}`, "m"));
    }
    expect(out).toContain("Tool calls by kind:");
    expect(out).toContain("Sessions, oldest first");
    expect(out).toContain(
      `Listed ${manifest.length}, read ${manifest.length}, counted ${manifest.length}.`,
    );
    // demo (Saturday 09:26 UTC, 8 min 55 s active) is the busiest hour, drawn as '#'; idle-gap
    // (Thursday 08:05, mostly idle) shades Thursday 08:00 lighter. Placed by the transcripts.
    expect(out).toMatch(/^ {2}Sat {9}#$/m);
    expect(out).toMatch(/^ {2}Thu {8}[^ #]$/m);
    // Sessions from files only: no SRC column.
    expect(out).not.toMatch(/\bSRC\b/);
    expectNarrow(out);
    // Each session row starts with its transcript start and ends with a short key that names it.
    const doc = await pulseJson(machine);
    for (const entry of doc.timeline) {
      const start = new Date(entry.start).toISOString().slice(0, 16).replace("T", " ");
      const row = out.split("\n").find((line) => line.startsWith(`  ${start}`));
      expect(row).toBeDefined();
      const short = (row as string).split(" ").pop() as string;
      expect(short.length).toBeGreaterThanOrEqual(8);
      expect(short.length).toBeLessThan(entry.key.length);
      expect(entry.key.split(":")[1]?.startsWith(short)).toBe(true);
      expect(doc.totals.keys.filter((key) => key.split(":")[1]?.startsWith(short))).toEqual([
        entry.key,
      ]);
    }
  });
});

describe(
  "orbitrace pulse on transcripts whose file times were not kept",
  { timeout: 30_000 },
  () => {
    it("follows the transcript timestamps, as after a copy, a clone or a restore", async () => {
      // Written now, with no file times set: every file time is months after its lines.
      const root = makeTempDir();
      const home = join(root, "home");
      mkdirSync(home);
      const fixturesDir = join(root, "fixtures");
      writeFixtureTree(fixturesDir);
      const host = {
        platform: process.platform,
        homeDir: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: join(fixturesDir, CONFIG_FOLDER),
          ORBITRACE_DATA_DIR: join(root, "data"),
        },
        cwd: root,
      };
      const manifest = readManifest(fixturesDir);
      const run = async (extra: string[]): Promise<PulseDocument> => {
        const result = await runCli(["pulse", "--json", "--tz", "UTC", ...extra], host);
        expect(result.code).toBe(0);
        return oneJson<PulseDocument>(result.stdout);
      };
      const all = await run([]);
      expect(all.timeline.every((entry) => entry.anchor === "start")).toBe(true);
      expect(all.timeline.map((entry) => [entry.start, entry.end])).toEqual(
        [...manifest]
          .sort((a, b) => firstOf(a) - firstOf(b))
          .map((facts) => [firstOf(facts), lastOf(facts)]),
      );
      const expectedCells: Record<string, number> = {};
      for (const facts of manifest) {
        const cell = utcCell(firstOf(facts));
        expectedCells[cell] = (expectedCells[cell] ?? 0) + 1;
      }
      expect(startedCells(all)).toEqual(expectedCells);
      const march = await run(["--since", "2026-03-01"]);
      expect(march.timeline.map((entry) => entry.start)).toEqual(
        manifest.filter((facts) => facts.name === "demo").map(firstOf),
      );
      const early = await run(["--until", "2026-02-03"]);
      expect(early.timeline.map((entry) => entry.start)).toEqual(
        manifest.filter((facts) => facts.name === "single-agent").map(firstOf),
      );
      expect(orbitraceFilesExist({ data: join(root, "data"), home } as PulseMachine)).toBe(false);
    });
  },
);

describe("orbitrace pulse on bad input", { timeout: 30_000 }, () => {
  it("refuses an unknown --tz, a bad --since and a reversed range with usage errors", async () => {
    const machine = makePulseMachine();
    const cases: [string[], RegExp][] = [
      [["--tz", "Nowhere/Widget_Town"], /--tz needs a time zone name/],
      [["--since", "last tuesday"], /--since needs a date/],
      [["--until", "2026-02-30"], /--until needs a date/],
      [["--since", "2026-01-02", "--until", "2026-01-01"], /--since must be before --until/],
      [["--limit", "0"], /--limit needs a whole number/],
      [["extra"], /pulse takes no arguments/],
    ];
    for (const [args, message] of cases) {
      const result = await runCli(["pulse", "--json", ...args], machine.host);
      expect(result.code).toBe(CLI_EXIT_CODES.usage);
      expect(result.stdout).toBe("");
      const error = oneJson<{ error: { code: string; message: string } }>(result.stderr).error;
      expect(error.code).toBe("usage");
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain("Widget_Town");
      expect(error.message).not.toContain("tuesday");
    }
  });

  it("finds nothing to count in an empty config folder, and says so", async () => {
    const root = makeTempDir();
    const home = join(root, "home");
    const config = join(root, "config");
    mkdirSync(home);
    mkdirSync(join(config, "projects"), { recursive: true });
    const host = {
      platform: process.platform,
      homeDir: home,
      env: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: config,
        ORBITRACE_DATA_DIR: join(root, "data"),
      },
      cwd: root,
    };
    const json = await runCli(["pulse", "--json", "--tz", "UTC"], host);
    const doc = oneJson<PulseDocument>(json.stdout);
    expect(doc.totals.sessions).toBe(0);
    expect(Object.keys(doc.sessions)).toEqual(SESSIONS_KEYS);
    expect(doc.sessions).toEqual({
      listed: 0,
      read: 0,
      counted: 0,
      outOfRange: 0,
      notReadLimit: 0,
      limit: PULSE_DEFAULT_LIMIT,
      unreadable: { count: 0, byCode: {} },
      fromHistory: 0,
      historyKeys: [],
    });
    const text = await runCli(["pulse", "--tz", "UTC"], host);
    expect(text.stdout).toContain("No sessions to count.");
    expect(readdirSync(root).sort()).toEqual(["config", "home"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "counts a session it cannot read and goes on with the others",
    async () => {
      const machine = makePulseMachine();
      const paths = fixturePaths("demo", machine.fixturesDir);
      chmodSync(paths.transcript, 0o000);
      try {
        const doc = await pulseJson(machine);
        expect(doc.sessions.unreadable).toEqual({ count: 1, byCode: { unreadable: 1 } });
        expect(doc.sessions.counted).toBe(SCENARIO_NAMES.length - 1);
        const text = await runCli(["pulse", "--tz", "UTC"], machine.host);
        expect(text.stdout).toContain("1 could not be read (unreadable 1).");
      } finally {
        chmodSync(paths.transcript, 0o644);
      }
    },
  );
});

describe("orbitrace pulse writes no content", { timeout: 30_000 }, () => {
  it("leaves out every prompt, reply, input, output, folder and description", async () => {
    const root = makeTempDir();
    const home = join(root, "home");
    const config = join(root, "config");
    mkdirSync(home);
    const session = markedSession();
    const files = writeGeneratedSession(config, session);
    // The marker really is in the transcripts, in many places.
    const planted = files
      .map((file) => readFileSync(file, "utf8").split(MARKER).length - 1)
      .reduce((sum, n) => sum + n, 0);
    expect(planted).toBeGreaterThan(20);
    const host = {
      platform: process.platform,
      homeDir: home,
      env: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: config,
        ORBITRACE_DATA_DIR: join(root, "data"),
      },
      cwd: root,
    };
    const json = await runCli(["pulse", "--json", "--tz", "UTC"], host);
    const text = await runCli(["pulse", "--tz", "UTC"], host);
    const doc = oneJson<PulseDocument>(json.stdout);
    expect(doc.totals.sessions).toBe(1);
    expect(doc.totals.toolCalls).toBe(session.expected.totals.toolCalls);
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
      expect(output).not.toContain(MARKER);
      expect(output).not.toContain(root);
      expect(output).not.toContain(session.sessionId);
    }
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(
  `orbitrace pulse with the history store${SQLITE_NOTE}`,
  { timeout: 30_000 },
  () => {
    it("counts stored sessions once their transcripts are gone, with the same figures", async () => {
      const machine = makePulseMachine();
      const before = await pulseJson(machine);
      expect(orbitraceFilesExist(machine)).toBe(false);
      const ingest = await runCli(["history", "ingest", "--json"], machine.host);
      expect(ingest.code).toBe(0);
      rmSync(machine.configDir, { recursive: true, force: true });
      const after = await pulseJson(machine);
      expect(after.sessions.fromHistory).toBe(SCENARIO_NAMES.length);
      expect(after.sessions.historyKeys).toEqual(after.totals.keys);
      expect(before.sessions.historyKeys).toEqual([]);
      // A stored session's live status is `ended` (its transcript is not being written); the
      // fixture files have no live registry, so read from files it is `unknown`.
      expect(after.timeline.every((entry) => entry.live === "ended")).toBe(true);
      const withoutLive = (doc: PulseDocument) => ({
        ...doc,
        timeline: doc.timeline.map((entry) => ({ ...entry, live: null })),
      });
      const { sessions: s1, ...r1 } = withoutLive(before);
      const { sessions: s2, ...r2 } = withoutLive(after);
      expect(r2).toEqual(r1);
      expect({ ...s2, fromHistory: 0, historyKeys: [] }).toEqual(s1);
      // The text marks them in a SRC column, and still fits in 80 columns.
      const text = await runCli(["pulse", "--tz", "UTC"], machine.host);
      expect(text.stdout).toMatch(/\bSRC\b/);
      expect(text.stdout.split("\n").filter((line) => /\bhist\b/.test(line))).toHaveLength(
        SCENARIO_NAMES.length + 1,
      );
      expect(text.stdout).toContain(`${SCENARIO_NAMES.length} from the history store.`);
      expectNarrow(text.stdout);
    });
  },
);

describe("orbitrace pulse (built binary)", { timeout: 30_000 }, () => {
  it("runs from the bundle and writes one JSON document", () => {
    const machine = makePulseMachine();
    const result = runBin(["pulse", "--config-dir", machine.configDir, "--tz", "UTC", "--json"], {
      home: machine.home,
      env: { ORBITRACE_DATA_DIR: machine.data },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const doc = oneJson<PulseDocument>(result.stdout);
    expect(doc.totals.sessions).toBe(SCENARIO_NAMES.length);
    expect(doc.hourOfWeek.cells).toHaveLength(7);
    expect(orbitraceFilesExist(machine)).toBe(false);
  });
});
