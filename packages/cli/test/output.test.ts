import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionSummary } from "@orbitrace/core";
import { CliError } from "../src/errors.js";
import {
  formatLocalTime,
  formatSessionTable,
  sanitizeForTerminal,
  writeOutputFile,
} from "../src/output.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("sanitizeForTerminal", () => {
  it("replaces control characters and keeps the rest", () => {
    expect(sanitizeForTerminal("widget-lab")).toBe("widget-lab");
    expect(sanitizeForTerminal("a\u001b[31mb\nc\u0007")).toBe("a?[31mb?c?");
    expect(sanitizeForTerminal("café ☃")).toBe("café ☃");
  });
});

describe("formatLocalTime", () => {
  it("writes YYYY-MM-DD HH:MM in local time", () => {
    const date = new Date(2026, 2, 4, 7, 5, 59);
    expect(formatLocalTime(date.getTime())).toBe("2026-03-04 07:05");
  });

  it("writes '-' for a time that is not a date", () => {
    expect(formatLocalTime(Number.NaN)).toBe("-");
  });
});

describe("formatSessionTable", () => {
  const sessions: SessionSummary[] = [
    {
      key: "claude-code:00000000000000000000000000000001",
      runtime: "claude-code",
      projectLabel: "example-project",
      sessionId: "00000000-0000-4000-8000-000000000001",
      lastActivity: new Date(2026, 0, 2, 3, 4).getTime(),
      live: "busy",
      subagentCount: 3,
    },
    {
      key: "claude-code:00000000000000000000000000000002",
      runtime: "claude-code",
      projectLabel: "odd\u001bname",
      sessionId: "00000000-0000-4000-8000-000000000002",
      lastActivity: new Date(2026, 0, 1, 0, 0).getTime(),
      live: "unknown",
      subagentCount: null,
    },
  ];

  it("aligns a header and one row per session, without the session id", () => {
    const lines = formatSessionTable(sessions).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^KEY {43}LAST ACTIVITY {5}LIVE {5}SUBAGENTS {2}PROJECT$/);
    expect(lines[1]).toBe(
      "claude-code:00000000000000000000000000000001  2026-01-02 03:04  busy     3          example-project",
    );
    expect(lines[2]).toBe(
      "claude-code:00000000000000000000000000000002  2026-01-01 00:00  unknown  -          odd?name",
    );
    expect(formatSessionTable(sessions)).not.toContain("00000000-0000-4000");
  });
});

describe("writeOutputFile", () => {
  it("creates a new file and reports the path as typed", () => {
    const dir = makeTempDir();
    const written = writeOutputFile({
      target: "out.json",
      cwd: dir,
      fileName: "orbitrace.replay.json",
      data: "{}\n",
      force: false,
    });
    expect(written).toEqual({ shown: "out.json", bytes: 3 });
    expect(readFileSync(join(dir, "out.json"), "utf8")).toBe("{}\n");
  });

  it("puts the suggested file name inside a folder", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "replays"));
    const written = writeOutputFile({
      target: "replays",
      cwd: dir,
      fileName: "orbitrace.replay.json",
      data: "{}",
      force: false,
    });
    expect(written.shown).toBe(join("replays", "orbitrace.replay.json"));
    expect(readFileSync(join(dir, "replays", "orbitrace.replay.json"), "utf8")).toBe("{}");
  });

  it("refuses to replace a file without force and replaces it with force", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "keep.json"), "old");
    const options = { target: "keep.json", cwd: dir, fileName: "x", data: "new" };
    let caught: unknown;
    try {
      writeOutputFile({ ...options, force: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe("output-exists");
    expect((caught as CliError).message).toBe("The file keep.json exists already.");
    expect(readFileSync(join(dir, "keep.json"), "utf8")).toBe("old");

    writeOutputFile({ ...options, force: true });
    expect(readFileSync(join(dir, "keep.json"), "utf8")).toBe("new");
  });

  it("reports an unwritable path without the absolute path or the system error", () => {
    const dir = makeTempDir();
    let caught: unknown;
    try {
      writeOutputFile({
        target: join("no-folder", "out.json"),
        cwd: dir,
        fileName: "x",
        data: "{}",
        force: true,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("output-unwritable");
    expect((caught as CliError).message).toBe(
      `The file ${join("no-folder", "out.json")} could not be written.`,
    );
    expect((caught as CliError).hint).toBe("Check that its folder exists.");
    expect((caught as CliError).message).not.toContain(dir);
    expect((caught as CliError).message).not.toContain("ENOENT");
  });
});
