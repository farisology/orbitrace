/**
 * `orbitrace history <status|enable|disable|ingest|list|delete|where>` in-process (#195), on the
 * synthetic fixture sessions of a fake machine whose every folder is temporary. The suites that
 * need node:sqlite are skipped, with the reason in their name, on a Node without it; the
 * `history-unavailable` suite runs everywhere, with the capability check replaced.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHistoryStore, type HistoryCapability } from "@orbitrace/core/node";
import { HISTORY_ACTIONS } from "../src/args.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import { formatBytes, formatHistoryTable } from "../src/history/commands.js";
import { removeTempDirs } from "./helpers.js";
import {
  dataFiles,
  historyRuntime,
  makeHistoryMachine,
  oneJson,
  orbitraceFilesExist,
  runCli,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  type HistoryMachine,
} from "./history-helpers.js";

afterAll(() => {
  removeTempDirs();
});

const UNAVAILABLE: HistoryCapability = {
  available: false,
  engine: "node:sqlite",
  nodeVersion: "v20.19.0",
  reason: "This Node.js (v20.19.0) has no node:sqlite module. History needs Node 22.13 or later.",
};

/** The permission bits of a file or folder (POSIX only). */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const posix = process.platform !== "win32";

/** Ingest the fixtures with recording off, as an explicit one-off. */
async function ingested(): Promise<HistoryMachine> {
  const machine = makeHistoryMachine();
  const result = await runCli(["history", "ingest", "--json"], machine.host);
  expect(result.code).toBe(0);
  return machine;
}

describe("history, where the store cannot run", () => {
  const unavailable = {
    history: historyRuntime({ capability: () => Promise.resolve(UNAVAILABLE) }),
  };

  it("explains why and exits with 13 for each command that needs the store, creating nothing", async () => {
    const machine = makeHistoryMachine();
    const argvs = [
      ["status"],
      ["enable"],
      ["ingest"],
      ["list"],
      ["delete", "claude-code:abcd", "--yes"],
    ];
    // With disable, where and delete --all (below), every history command is covered.
    expect(new Set([...argvs.map((argv) => argv[0]), "disable", "where"])).toEqual(
      new Set(HISTORY_ACTIONS),
    );
    for (const argv of argvs) {
      const text = await runCli(["history", ...argv], machine.host, unavailable);
      expect(text.code).toBe(CLI_EXIT_CODES["history-unavailable"]);
      expect(text.code).toBe(13);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("has no node:sqlite module");
      expect(text.stderr).toContain("[history-unavailable]");
      expect(text.stderr).toContain("Node 22.13 or later");
      const json = await runCli(["history", ...argv, "--json"], machine.host, unavailable);
      expect(json.code).toBe(13);
      expect(json.stdout).toBe("");
      expect(oneJson(json.stderr)).toMatchObject({
        error: { code: "history-unavailable", exitCode: 13, message: UNAVAILABLE.reason },
      });
    }
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("still runs disable, where and delete --all, which need no node:sqlite, creating nothing", async () => {
    const machine = makeHistoryMachine();
    const where = await runCli(["history", "where", "--json"], machine.host, unavailable);
    expect(where.code).toBe(0);
    expect(oneJson(where.stdout)).toMatchObject({ exists: false });
    const off = await runCli(["history", "disable", "--json"], machine.host, unavailable);
    expect(off.code).toBe(0);
    expect(oneJson(off.stdout)).toEqual({ recording: false, changed: false, settings: null });
    const none = await runCli(["history", "delete", "--all", "--yes"], machine.host, unavailable);
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("There is no history store to delete.\n");
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("turns recording off and deletes a store made on another Node", async () => {
    const machine = makeHistoryMachine();
    // A store and a switch left by a Node that has node:sqlite (synthetic bytes: the store is
    // deleted without being opened).
    mkdirSync(machine.data);
    writeFileSync(
      join(machine.data, "settings.json"),
      `${JSON.stringify({ settings: 1, historyRecording: true })}\n`,
    );
    for (const name of ["history.sqlite", "history.sqlite-wal", "history.sqlite-shm"]) {
      writeFileSync(join(machine.data, name), "synthetic");
    }
    const disabled = await runCli(["history", "disable"], machine.host, unavailable);
    expect(disabled.code).toBe(0);
    expect(disabled.stdout).toContain("History recording is off.");
    expect(disabled.stdout).toContain("A running 'orbitrace open' stops copying");
    expect(disabled.stdout).toContain("'orbitrace history delete --all'.");
    expect(disabled.stdout).not.toContain("<session-key>");
    expect(JSON.parse(readFileSync(join(machine.data, "settings.json"), "utf8"))).toEqual({
      settings: 1,
      historyRecording: false,
    });
    const where = await runCli(["history", "where"], machine.host, unavailable);
    expect(where.code).toBe(0);
    expect(where.stderr).toBe("");
    // Not on a terminal: nothing is deleted without --yes.
    const refused = await runCli(["history", "delete", "--all"], machine.host, unavailable);
    expect(refused.code).toBe(CLI_EXIT_CODES["not-confirmed"]);
    expect(dataFiles(machine)).toContain("history.sqlite");
    const questions: string[] = [];
    const asking = {
      history: historyRuntime({
        capability: () => Promise.resolve(UNAVAILABLE),
        terminal: { stdin: true, stderr: true },
        confirm: (question: string) => {
          questions.push(question);
          return Promise.resolve(true);
        },
      }),
    };
    const deleted = await runCli(["history", "delete", "--all"], machine.host, asking);
    expect(deleted.code).toBe(0);
    // The session count needs node:sqlite, so it is left out rather than guessed.
    expect(questions[0]).toMatch(/^Delete the whole history store in .+\? .+ \[y\/N\] $/);
    expect(deleted.stdout).toBe("Deleted the history store.\n");
    expect(dataFiles(machine)).toEqual(["settings.json"]);
  });

  it("reports an unknown session count as null in the delete --all document", async () => {
    const machine = makeHistoryMachine();
    mkdirSync(machine.data);
    writeFileSync(join(machine.data, "history.sqlite"), "synthetic");
    const result = await runCli(
      ["history", "delete", "--all", "--yes", "--json"],
      machine.host,
      unavailable,
    );
    expect(result.code).toBe(0);
    expect(oneJson(result.stdout)).toEqual({
      all: true,
      deleted: true,
      sessions: null,
      recording: false,
    });
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("checks the command line first", async () => {
    const machine = makeHistoryMachine();
    const result = await runCli(["history", "bogus"], machine.host, unavailable);
    expect(result.code).toBe(CLI_EXIT_CODES.usage);
  });
});

describe("history usage errors", () => {
  it("names the subcommands and refuses options a subcommand does not take", async () => {
    const machine = makeHistoryMachine();
    const cases: [string[], string][] = [
      [
        ["history"],
        "Give a history command: status, enable, disable, ingest, list, delete, where.",
      ],
      [["history", "bogus"], "Unknown history command 'bogus'."],
      [["history", "status", "--yes"], "history status does not take --yes."],
      [["history", "enable", "--config-dir", "x"], "history enable does not take --config-dir."],
      [["history", "list", "--all"], "history list does not take --all."],
      [["history", "ingest", "--limit", "3"], "history ingest does not take --limit."],
      [["history", "delete"], "Give a session key or --all."],
      [
        ["history", "delete", "claude-code:abcd", "--all"],
        "Give a session key or --all, not both.",
      ],
      [["history", "delete", "a", "b"], "history delete takes one session key."],
      [["history", "where", "extra"], "history where takes no arguments, got 'extra'."],
      [["history", "list", "--limit", "0"], "--limit needs a whole number of at least 1."],
    ];
    for (const [argv, message] of cases) {
      const result = await runCli(argv, machine.host);
      expect(result.code).toBe(CLI_EXIT_CODES.usage);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("orbitrace history --help");
    }
    expect(orbitraceFilesExist(machine)).toBe(false);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history status and where${SKIP_NOTE}`, () => {
  it("reports recording off, the engine and where the store would be, creating nothing", async () => {
    const machine = makeHistoryMachine();
    const text = await runCli(["history", "status"], machine.host);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Recording: off (the default).");
    expect(text.stdout).toContain("Engine: node:sqlite, SQLite ");
    expect(text.stdout).toContain(join(machine.data, "history.sqlite"));
    expect(text.stdout).toContain("Stored: nothing (there is no store yet).");
    const json = oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout);
    expect(json).toMatchObject({
      recording: false,
      settings: "missing",
      capability: { available: true, engine: "node:sqlite" },
      dataDir: machine.data,
      database: join(machine.data, "history.sqlite"),
      store: { exists: false, sessions: null, files: null, lines: null, bytes: 0, error: null },
    });
    expect(Object.keys(json as object)).toEqual([
      "recording",
      "settings",
      "capability",
      "dataDir",
      "database",
      "store",
    ]);
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("counts what is stored once there is a store", async () => {
    const machine = await ingested();
    const json = oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout) as {
      store: { exists: boolean; sessions: number; lines: number; bytes: number };
    };
    expect(json.store.exists).toBe(true);
    expect(json.store.sessions).toBe(9);
    expect(json.store.lines).toBeGreaterThan(0);
    expect(json.store.bytes).toBeGreaterThan(0);
    const text = await runCli(["history", "status"], machine.host);
    expect(text.stdout).toMatch(/Stored: 9 sessions, \d+ lines, [\d.]+ (KB|MB)\./);
  });

  it("shows the home folder as ~", async () => {
    const machine = makeHistoryMachine();
    const host = { ...machine.host, env: { ...machine.host.env, ORBITRACE_DATA_DIR: undefined } };
    const where = await runCli(["history", "where"], host);
    expect(where.code).toBe(0);
    const sep = process.platform === "win32" ? "\\" : "/";
    const marker = process.platform === "win32" ? "%USERPROFILE%" : "~";
    expect(where.stdout).toBe(`${marker}${sep}.orbitrace\n`);
    expect(where.stdout).not.toContain(machine.home);
    expect(where.stderr).toContain("no history store");
    const json = oneJson((await runCli(["history", "where", "--json"], host)).stdout);
    expect(json).toEqual({
      dataDir: `${marker}${sep}.orbitrace`,
      database: `${marker}${sep}.orbitrace${sep}history.sqlite`,
      settings: `${marker}${sep}.orbitrace${sep}settings.json`,
      exists: false,
    });
    expect(existsSync(join(machine.home, ".orbitrace"))).toBe(false);
  });

  it("fails with history-failed for a data folder that is not allowed", async () => {
    const machine = makeHistoryMachine();
    const host = { ...machine.host, env: { ...machine.host.env, ORBITRACE_DATA_DIR: "relative" } };
    const result = await runCli(["history", "status", "--json"], host);
    expect(result.code).toBe(CLI_EXIT_CODES["history-failed"]);
    expect(result.code).toBe(15);
    expect(oneJson(result.stderr)).toMatchObject({
      error: { code: "history-failed", message: "ORBITRACE_DATA_DIR must be an absolute path." },
    });
    const inside = {
      ...machine.host,
      env: { ...machine.host.env, ORBITRACE_DATA_DIR: join(machine.configDir, "history") },
    };
    const enable = await runCli(["history", "enable"], inside);
    expect(enable.code).toBe(15);
    expect(enable.stderr).toContain("must not be inside a Claude Code config folder");
    expect(existsSync(join(machine.configDir, "history"))).toBe(false);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history enable and disable${SKIP_NOTE}`, () => {
  it("enable writes the settings file (0600) in a new data folder (0700), and nothing else", async () => {
    const machine = makeHistoryMachine();
    const result = await runCli(["history", "enable"], machine.host);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("History recording is on.");
    expect(result.stdout).toContain("orbitrace history ingest");
    expect(result.stderr).toContain("redacted");
    expect(dataFiles(machine)).toEqual(["settings.json"]);
    const file = join(machine.data, "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ settings: 1, historyRecording: true });
    // Windows has no POSIX modes: Node cannot set them there.
    const modes = posix ? [mode(file), mode(machine.data)] : [0o600, 0o700];
    expect(modes).toEqual([0o600, 0o700]);
    const again = oneJson((await runCli(["history", "enable", "--json"], machine.host)).stdout);
    expect(again).toEqual({ recording: true, changed: false, settings: file });
    const status = oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout);
    expect(status).toMatchObject({ recording: true, settings: "ok" });
  });

  it("disable turns it off; without a settings file it writes nothing", async () => {
    const machine = makeHistoryMachine();
    const off = await runCli(["history", "disable", "--json"], machine.host);
    expect(oneJson(off.stdout)).toEqual({ recording: false, changed: false, settings: null });
    expect(orbitraceFilesExist(machine)).toBe(false);
    await runCli(["history", "enable"], machine.host);
    const disabled = await runCli(["history", "disable"], machine.host);
    expect(disabled.code).toBe(0);
    expect(disabled.stdout).toContain("History recording is off.");
    const file = join(machine.data, "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      settings: 1,
      historyRecording: false,
    });
  });

  it("treats a settings file it cannot read as off, and enable or disable writes it again", async () => {
    const machine = makeHistoryMachine();
    mkdirSync(machine.data);
    writeFileSync(join(machine.data, "settings.json"), "{ not json");
    const status = await runCli(["history", "status"], machine.host);
    expect(status.stdout).toContain("The settings file could not be read");
    const json = oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout);
    expect(json).toMatchObject({ recording: false, settings: "invalid" });
    await runCli(["history", "disable"], machine.host);
    expect(
      oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout),
    ).toMatchObject({ recording: false, settings: "ok" });
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history ingest${SKIP_NOTE}`, () => {
  it("copies every session once while recording is off, and a second run adds nothing", async () => {
    const machine = makeHistoryMachine();
    const first = await runCli(["history", "ingest", "--json"], machine.host);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const doc = oneJson(first.stdout) as Record<string, unknown>;
    expect(doc).toMatchObject({
      sessions: 9,
      sessionsSkipped: 0,
      linesSkipped: 0,
      database: join(machine.data, "history.sqlite"),
      warnings: [],
    });
    expect(doc.linesAdded).toBe(doc.linesRead);
    expect(Object.keys(doc)).toEqual([
      "sessions",
      "sessionsSkipped",
      "files",
      "filesMissing",
      "filesReset",
      "linesRead",
      "linesAdded",
      "linesSkipped",
      "redactions",
      "durationMs",
      "database",
      "warnings",
    ]);
    expect(dataFiles(machine)).toContain("history.sqlite");
    expect(dataFiles(machine)).not.toContain("settings.json");
    expect(dataFiles(machine)).not.toContain("history.lock");
    const second = oneJson((await runCli(["history", "ingest", "--json"], machine.host)).stdout);
    expect(second).toMatchObject({ sessions: 9, linesAdded: 0 });
    const reader = await openHistoryStore({ mode: "read", dataDir: machine.data, env: {} });
    try {
      expect(reader.totals().lines).toBe(doc.linesAdded);
    } finally {
      reader.close();
    }
  }, 30_000);

  it("shows progress on a terminal, on stderr, and a summary on stdout", async () => {
    const machine = makeHistoryMachine();
    const runtime = { history: historyRuntime({ terminal: { stdin: false, stderr: true } }) };
    const result = await runCli(["history", "ingest"], machine.host, runtime);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("\rCopied 1 of 9 sessions");
    expect(result.stderr).toContain("\rCopied 9 of 9 sessions");
    expect(result.stderr.endsWith("\n")).toBe(true);
    expect(result.stdout).toMatch(/^Copied \d+ new lines from 9 sessions into .+history\.sqlite/);
    const quiet = await runCli(["history", "ingest"], machine.host);
    expect(quiet.stderr).toBe("");
  }, 30_000);

  it("writes nothing when there is no session to copy", async () => {
    const machine = makeHistoryMachine();
    const host = {
      ...machine.host,
      env: { ...machine.host.env, CLAUDE_CONFIG_DIR: join(machine.root, "empty") },
    };
    const result = await runCli(["history", "ingest"], host);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("No sessions found to copy; nothing was written.\n");
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("fails with history-failed when this build has no worker", async () => {
    const machine = makeHistoryMachine();
    const result = await runCli(["history", "ingest"], machine.host, {
      history: historyRuntime({ workerUrl: null }),
    });
    expect(result.code).toBe(15);
    expect(result.stderr).toContain("no history worker");
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("fails with history-locked (14) while another process writes", async () => {
    const machine = await ingested();
    const holder = await openHistoryStore({ mode: "write", dataDir: machine.data, env: {} });
    try {
      const result = await runCli(["history", "ingest", "--json"], machine.host);
      expect(result.code).toBe(CLI_EXIT_CODES["history-locked"]);
      expect(result.code).toBe(14);
      expect(oneJson(result.stderr)).toMatchObject({ error: { code: "history-locked" } });
    } finally {
      holder.close();
    }
  }, 30_000);
});

describe.skipIf(!SQLITE_AVAILABLE)(`history list${SKIP_NOTE}`, () => {
  it("says the store is empty, and how to fill it, creating nothing", async () => {
    const machine = makeHistoryMachine();
    const result = await runCli(["history", "list"], machine.host);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No sessions in the history store.");
    expect(result.stdout).toContain("orbitrace history enable");
    expect(oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout)).toEqual({
      sessions: [],
      warnings: [],
    });
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("lists stored sessions and marks those whose transcripts are gone", async () => {
    const machine = await ingested();
    const before = oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
      sessions: { key: string; transcript: string; lineCount: number }[];
    };
    expect(before.sessions).toHaveLength(9);
    expect(before.sessions.every((session) => session.transcript === "found")).toBe(true);
    expect(Object.keys(before.sessions[0] as object)).toEqual([
      "key",
      "runtime",
      "sessionId",
      "projectLabel",
      "lastActivity",
      "firstIngestedAt",
      "lastIngestedAt",
      "subagentCount",
      "lineCount",
      "transcript",
    ]);
    // Move the whole config folder away: every transcript is gone.
    rmSync(machine.configDir, { recursive: true, force: true });
    const after = oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
      sessions: { transcript: string }[];
    };
    expect(after.sessions.every((session) => session.transcript === "missing")).toBe(true);
    const text = await runCli(["history", "list", "--limit", "2"], machine.host);
    const lines = text.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+SUBAGENTS\s+LINES\s+TRANSCRIPT\s+PROJECT$/);
    expect(lines[1]).toContain("missing");
  }, 30_000);
});

describe.skipIf(!SQLITE_AVAILABLE)(`history delete${SKIP_NOTE}`, () => {
  it("refuses without --yes when not on a terminal, and with --json, deleting nothing", async () => {
    const machine = await ingested();
    const [first] = (
      oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
        sessions: { key: string }[];
      }
    ).sessions;
    for (const argv of [
      ["history", "delete", first!.key],
      ["history", "delete", "--all"],
    ]) {
      const result = await runCli(argv, machine.host);
      expect(result.code).toBe(CLI_EXIT_CODES["not-confirmed"]);
      expect(result.code).toBe(16);
      expect(result.stderr).toContain("Add --yes");
    }
    const terminal = {
      history: historyRuntime({
        terminal: { stdin: true, stderr: true },
        confirm: () => Promise.reject(new Error("must not ask with --json")),
      }),
    };
    const json = await runCli(["history", "delete", "--all", "--json"], machine.host, terminal);
    expect(json.code).toBe(16);
    expect(dataFiles(machine)).toContain("history.sqlite");
  }, 30_000);

  it("asks on a terminal, and deletes nothing when the answer is no", async () => {
    const machine = await ingested();
    const questions: string[] = [];
    const runtime = (answer: boolean) => ({
      history: historyRuntime({
        terminal: { stdin: true, stderr: true },
        confirm: (question: string) => {
          questions.push(question);
          return Promise.resolve(answer);
        },
      }),
    });
    const no = await runCli(["history", "delete", "--all"], machine.host, runtime(false));
    expect(no.code).toBe(16);
    expect(no.stderr).toContain("Nothing was deleted.");
    expect(questions[0]).toMatch(
      /^Delete the whole history store \(9 sessions\) in .+\? .+ \[y\/N\] $/,
    );
    expect(dataFiles(machine)).toContain("history.sqlite");
    const yes = await runCli(["history", "delete", "--all"], machine.host, runtime(true));
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain("Deleted the history store (9 sessions).");
    expect(dataFiles(machine)).not.toContain("history.sqlite");
  }, 30_000);

  it("deletes one session by a unique key start, and says not-found or ambiguous otherwise", async () => {
    const machine = await ingested();
    const sessions = (
      oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
        sessions: { key: string; lineCount: number }[];
      }
    ).sessions;
    const target = sessions[0]!;
    const prefix = target.key.slice("claude-code:".length, "claude-code:".length + 12);
    const result = await runCli(["history", "delete", prefix, "--yes", "--json"], machine.host);
    expect(result.code).toBe(0);
    expect(oneJson(result.stdout)).toEqual({
      key: target.key,
      deleted: true,
      lines: target.lineCount,
      scrubbed: true,
    });
    const left = oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
      sessions: { key: string }[];
    };
    expect(left.sessions.map((session) => session.key)).not.toContain(target.key);
    expect(left.sessions).toHaveLength(8);
    const gone = await runCli(["history", "delete", target.key, "--yes"], machine.host);
    expect(gone.code).toBe(CLI_EXIT_CODES["not-found"]);
    expect(gone.stderr).toContain("orbitrace history list");
    const tooShort = await runCli(["history", "delete", "claude-code:", "--yes"], machine.host);
    expect(tooShort.code).toBe(CLI_EXIT_CODES["not-found"]);
  }, 30_000);

  it("reports ambiguous key starts", async () => {
    const machine = await ingested();
    const keys = (
      oneJson((await runCli(["history", "list", "--json"], machine.host)).stdout) as {
        sessions: { key: string }[];
      }
    ).sessions.map((session) => session.key.slice("claude-code:".length));
    // The shortest start of at least 4 characters that more than one key shares, if any.
    let shared: string | undefined;
    for (let length = 4; length <= 32 && shared === undefined; length += 1) {
      const counts = new Map<string, number>();
      for (const key of keys)
        counts.set(key.slice(0, length), (counts.get(key.slice(0, length)) ?? 0) + 1);
      shared = [...counts].find(([, count]) => count > 1)?.[0];
    }
    if (shared === undefined) return; // The fixture keys share no 4-character start.
    const result = await runCli(["history", "delete", shared, "--yes"], machine.host);
    expect(result.code).toBe(CLI_EXIT_CODES.ambiguous);
  }, 30_000);

  it("delete --all with no store says so and creates nothing", async () => {
    const machine = makeHistoryMachine();
    const result = await runCli(["history", "delete", "--all", "--yes"], machine.host);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("There is no history store to delete.\n");
    expect(
      oneJson((await runCli(["history", "delete", "--all", "--json"], machine.host)).stdout),
    ).toEqual({ all: true, deleted: false, sessions: 0, recording: false });
    const one = await runCli(["history", "delete", "claude-code:abcd", "--yes"], machine.host);
    expect(one.code).toBe(CLI_EXIT_CODES["not-found"]);
    expect(orbitraceFilesExist(machine)).toBe(false);
  });

  it("keeps the settings file and says recording is still on after delete --all", async () => {
    const machine = await ingested();
    await runCli(["history", "enable"], machine.host);
    const result = await runCli(["history", "delete", "--all", "--yes"], machine.host);
    expect(result.stdout).toContain("Recording is still on");
    expect(dataFiles(machine)).toEqual(["settings.json"]);
    const json = oneJson((await runCli(["history", "status", "--json"], machine.host)).stdout);
    expect(json).toMatchObject({ recording: true, store: { exists: false } });
  }, 30_000);
});

describe("formatting", () => {
  it("formats byte counts for people", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(905_216)).toBe("905.2 KB");
    expect(formatBytes(113_000_000)).toBe("113.0 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB");
  });

  it("formats the history list as an aligned table and replaces control characters", () => {
    const text = formatHistoryTable([
      {
        key: "claude-code:00000000000000000000000000000001",
        runtime: "claude-code",
        sessionId: "00000000-0000-4000-8000-000000000001",
        projectLabel: "example\u001b[2Jproject",
        lastActivity: Number.NaN,
        firstIngestedAt: 0,
        lastIngestedAt: 0,
        subagentCount: 2,
        lineCount: 40,
        transcript: "missing",
      },
    ]);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+SUBAGENTS\s+LINES\s+TRANSCRIPT\s+PROJECT$/);
    expect(lines[1]).toMatch(
      /^claude-code:0+1 {2}- {14}2 {10}40 {5}missing {5}example\?\[2Jproject$/,
    );
  });
});
