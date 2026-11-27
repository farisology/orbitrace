/**
 * `orbitrace pulse` (#27): parsing of its flags, resolving --since / --until in a zone, and the
 * pieces of the text output, with fixed instants and synthetic values only.
 */
import { describe, expect, it } from "vitest";
import { createZoneClock, pulseReport } from "@orbitrace/core";
import { PULSE_DEFAULT_LIMIT, parseCommandLine, parsePulseTime } from "../src/args.js";
import { CliError } from "../src/errors.js";
import { helpJson, helpText } from "../src/help.js";
import {
  PULSE_SHORT_KEY,
  formatPulseText,
  formatZoned,
  pulseZone,
  readingLines,
  resolvePulseTime,
  shade,
  shortKeys,
  systemTimeZone,
  transcriptStart,
  type PulseDocument,
} from "../src/pulse.js";
import { MIN_KEY_PREFIX, matchSessionKeys } from "../src/sessions.js";

const HOUR = 3_600_000;

function usage(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("usage");
    return error as CliError;
  }
  throw new Error("expected a usage error");
}

describe("parsePulseTime", () => {
  it("reads a date and a date-time as local wall-clock times", () => {
    expect(parsePulseTime("2026-11-01", "--since")).toEqual({
      kind: "local",
      localMs: Date.UTC(2026, 10, 1),
    });
    expect(parsePulseTime(" 2026-11-01T09:30 ", "--since")).toEqual({
      kind: "local",
      localMs: Date.UTC(2026, 10, 1, 9, 30),
    });
    expect(parsePulseTime("2026-11-01 09:30:15", "--until")).toEqual({
      kind: "local",
      localMs: Date.UTC(2026, 10, 1, 9, 30, 15),
    });
  });

  it("reads a time with Z or an offset as an instant", () => {
    expect(parsePulseTime("2026-11-01T09:30Z", "--since")).toEqual({
      kind: "instant",
      ms: Date.UTC(2026, 10, 1, 9, 30),
    });
    expect(parsePulseTime("2026-11-01T09:30+05:30", "--since")).toEqual({
      kind: "instant",
      ms: Date.UTC(2026, 10, 1, 4, 0),
    });
    expect(parsePulseTime("2026-11-01T09:30-04:00", "--since")).toEqual({
      kind: "instant",
      ms: Date.UTC(2026, 10, 1, 13, 30),
    });
  });

  it("reads a span before now in hours, days or weeks", () => {
    expect(parsePulseTime("12h", "--since")).toEqual({ kind: "ago", ms: 12 * HOUR });
    expect(parsePulseTime("7d", "--since")).toEqual({ kind: "ago", ms: 7 * 24 * HOUR });
    expect(parsePulseTime("2w", "--since")).toEqual({ kind: "ago", ms: 14 * 24 * HOUR });
  });

  it("refuses anything else, naming the flag and not the value", () => {
    expect(usage(() => parsePulseTime("", "--until")).message).toMatch(/^--until needs/);
    for (const value of [
      "yesterday-widget",
      "2026-13-01",
      "2026-02-30",
      "2026-11-01T24:00",
      "2026-11-01T09:60",
      "2026-11-01Z",
      "2026-11-01T09:30+25:00",
      "7m",
      "-3d",
    ]) {
      const error = usage(() => parsePulseTime(value, "--until"));
      expect(error.message).toMatch(/^--until needs/);
      expect(error.message).not.toContain(value);
    }
  });
});

describe("parseCommandLine pulse", () => {
  it("has defaults: no range, the default limit, this computer's zone, every project", () => {
    expect(parseCommandLine(["pulse"])).toEqual({
      kind: "pulse",
      json: false,
      sources: { configDirs: [], extraRoots: false },
      limit: PULSE_DEFAULT_LIMIT,
    });
  });

  it("takes every flag", () => {
    expect(
      parseCommandLine([
        "pulse",
        "--since",
        "7d",
        "--until",
        "2026-11-30",
        "--limit",
        "5",
        "--tz",
        "Europe/London",
        "--project",
        "widget-works",
        "--config-dir",
        "/tmp/example-config",
        "--extra-roots",
        "--json",
      ]),
    ).toEqual({
      kind: "pulse",
      json: true,
      sources: { configDirs: ["/tmp/example-config"], extraRoots: true },
      since: { kind: "ago", ms: 7 * 24 * HOUR },
      until: { kind: "local", localMs: Date.UTC(2026, 10, 30) },
      limit: 5,
      tz: "Europe/London",
      project: "widget-works",
    });
  });

  it("refuses arguments, empty values and unknown options", () => {
    expect(usage(() => parseCommandLine(["pulse", "extra"])).code).toBe("usage");
    expect(usage(() => parseCommandLine(["pulse", "--tz", " "])).code).toBe("usage");
    expect(usage(() => parseCommandLine(["pulse", "--project", ""])).code).toBe("usage");
    expect(usage(() => parseCommandLine(["pulse", "--limit", "0"])).code).toBe("usage");
    expect(usage(() => parseCommandLine(["pulse", "--latest"])).code).toBe("usage");
  });

  it("is in the help, with its options", () => {
    expect(helpText()).toContain("pulse");
    const text = helpText("pulse");
    expect(text).toContain("orbitrace pulse [--since <time>]");
    expect(text).toContain("Nothing leaves this computer.");
    expect(text).toContain("docs/pulse.md");
    const json = helpJson("pulse") as { commands: { options: { name: string }[] }[] };
    expect(json.commands[0]?.options.map((option) => option.name)).toEqual([
      "--since",
      "--until",
      "--limit",
      "--tz",
      "--project",
      "--config-dir",
      "--extra-roots",
      "--json",
      "--help",
    ]);
  });
});

describe("zones and times", () => {
  it("uses this computer's zone without --tz and refuses an unknown one", () => {
    expect(pulseZone(undefined).timeZone).toBe(createZoneClock(systemTimeZone()).timeZone);
    expect(pulseZone("Asia/Tokyo").timeZone).toBe("Asia/Tokyo");
    const error = usage(() => pulseZone("Nowhere/Widget_Town"));
    expect(error.message).not.toContain("Widget_Town");
  });

  it("resolves a --since value in the zone and against the clock", () => {
    const london = createZoneClock("Europe/London");
    const now = Date.UTC(2026, 10, 30, 12, 0);
    expect(resolvePulseTime({ kind: "instant", ms: 5 }, london, now)).toBe(5);
    expect(resolvePulseTime({ kind: "ago", ms: HOUR }, london, now)).toBe(now - HOUR);
    // Midnight on 1 July 2026 in London is 23:00 UTC the day before (BST).
    expect(resolvePulseTime({ kind: "local", localMs: Date.UTC(2026, 6, 1) }, london, now)).toBe(
      Date.UTC(2026, 5, 30, 23, 0),
    );
  });

  it("formats an instant as a local date and time in the zone", () => {
    const instant = Date.UTC(2026, 5, 30, 23, 5);
    expect(formatZoned(createZoneClock("UTC"), instant)).toBe("2026-06-30 23:05");
    expect(formatZoned(createZoneClock("Europe/London"), instant)).toBe("2026-07-01 00:05");
    expect(formatZoned(createZoneClock("UTC"), Number.NaN)).toBe("-");
  });
});

describe("text output pieces", () => {
  it("shades from blank to '#' for the busiest hour", () => {
    expect(shade(0, 100)).toBe(" ");
    expect(shade(5, 0)).toBe(" ");
    expect(shade(1, 100)).toBe(".");
    expect(shade(100, 100)).toBe("#");
    expect(shade(50, 100)).not.toBe("#");
  });

  const empty: PulseDocument = {
    ...pulseReport([]),
    sessions: {
      listed: 12,
      read: 7,
      counted: 4,
      outOfRange: 2,
      notReadLimit: 5,
      limit: 4,
      unreadable: { count: 3, byCode: { unreadable: 1, invalid: 2 } },
      fromHistory: 0,
      historyKeys: [],
    },
    project: null,
    warnings: [],
  };

  it("says what was read and what was left out, and why, one short line each", () => {
    expect(readingLines(empty)).toEqual([
      "Listed 12, read 7, counted 4.",
      "2 outside the time range.",
      "5 not read because of the limit of 4 (--limit).",
      "3 could not be read (invalid 2, unreadable 1).",
    ]);
    const withHistory = {
      ...empty,
      sessions: {
        ...empty.sessions,
        fromHistory: 2,
        historyKeys: ["claude-code:a", "claude-code:b"],
      },
    };
    expect(readingLines(withHistory)).toContain("2 from the history store.");
    const clean = {
      ...empty,
      sessions: {
        ...empty.sessions,
        outOfRange: 0,
        notReadLimit: 0,
        unreadable: { count: 0, byCode: {} },
      },
    };
    expect(readingLines(clean)).toEqual(["Listed 12, read 7, counted 4."]);
  });

  it("writes a short text when there is nothing to count", () => {
    const text = formatPulseText(empty);
    expect(text).toContain("Pulse: 0 sessions, all times.\nTime zone: UTC.");
    expect(text).toContain("No sessions to count.");
    expect(text).not.toContain("Tool calls by kind");
  });

  it("names the range in the zone", () => {
    const ranged = {
      ...empty,
      ...pulseReport([], { timeZone: "Europe/London", since: Date.UTC(2026, 6, 1) }),
    };
    expect(formatPulseText(ranged)).toContain(
      "from 2026-07-01 01:00 until now.\nTime zone: Europe/London.",
    );
  });
});

describe("short keys", () => {
  const known = [
    "claude-code:0123456789abcdef0123456789abcdef",
    "claude-code:0123456789abffff0123456789abcdef",
    "claude-code:fedcba9876543210fedcba9876543210",
    "claude-code:fedcba98",
    "other-runtime:7777777777777777",
  ];

  it("gives the shortest unique start of the hash, at least PULSE_SHORT_KEY long", () => {
    expect(PULSE_SHORT_KEY).toBeGreaterThanOrEqual(MIN_KEY_PREFIX);
    const map = shortKeys(known, known);
    expect(map.get(known[0] as string)).toBe("0123456789abc");
    expect(map.get(known[1] as string)).toBe("0123456789abf");
    expect(map.get(known[4] as string)).toBe("77777777");
    // "fedcba98" is a whole key and the start of another: the longer one gets one more character;
    // the shorter one has no unique start, so it stays whole.
    expect(map.get(known[2] as string)).toBe("fedcba987");
    expect(map.get(known[3] as string)).toBe("claude-code:fedcba98");
  });

  it("names exactly one session when given to open or export", () => {
    for (const [key, short] of shortKeys(known, known)) {
      expect(matchSessionKeys(known, short)).toEqual([key]);
    }
  });

  it("checks uniqueness against every known key, not just the ones shown", () => {
    const shown = [known[0] as string];
    expect(shortKeys(shown, shown).get(known[0] as string)).toBe("01234567");
    expect(shortKeys(shown, known).get(known[0] as string)).toBe("0123456789abc");
  });
});

describe("transcriptStart", () => {
  const run = (startedAt: number | null) => ({ startedAt });

  it("is the earliest first timestamp of the main transcript and its subagents", () => {
    expect(
      transcriptStart({
        main: run(5_000),
        subagents: [run(7_000), run(4_000)],
      } as never),
    ).toBe(4_000);
    expect(transcriptStart({ main: run(null), subagents: [run(9_000)] } as never)).toBe(9_000);
  });

  it("is undefined when no transcript has a timestamp", () => {
    expect(transcriptStart({ main: run(null), subagents: [run(null)] } as never)).toBeUndefined();
    expect(transcriptStart({ main: run(null), subagents: [] } as never)).toBeUndefined();
  });
});
