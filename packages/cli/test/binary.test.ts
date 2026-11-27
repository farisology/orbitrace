/**
 * End-to-end tests: the built `dist/index.js` runs as a child process against a fake machine in
 * a temporary folder (synthetic fixtures only, fresh environment, empty home folder).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CORE_STATUS,
  listSessions,
  toSessionSummary,
  validateReplay,
  type SessionSummary,
} from "@orbitrace/core";
import { claudeCodeAdapter, desktopSessionBases } from "@orbitrace/core/node";
import {
  SCENARIO_NAMES,
  fixturePaths,
  generateSession,
  goldenReplayPath,
  writeFixtureTree,
  type ScenarioName,
} from "@orbitrace/fixtures";
import { CLI_EXIT_CODES } from "../src/errors.js";
import {
  BIN,
  makeFakeMachine,
  makeTempDir,
  removeTempDirs,
  runBin,
  type CliRun,
  type FakeMachine,
} from "./helpers.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Session order by file time: `demo` is the newest session. */
const ORDER: readonly ScenarioName[] = [
  ...SCENARIO_NAMES.filter((name) => name !== "demo"),
  "demo",
];
const NEWEST_PROJECT = generateSession("demo").project;

let machine: FakeMachine;

beforeAll(() => {
  machine = makeFakeMachine(ORDER);
});

afterAll(() => {
  removeTempDirs();
});

function run(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  return runBin(args, { home: machine.home, ...options });
}

/** The output names no folder of the fake machine (the user did not type one). */
function expectPathFree(result: CliRun): void {
  expect(result.stdout).not.toContain(machine.root);
  expect(result.stderr).not.toContain(machine.root);
}

function parseJson(text: string): unknown {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(text);
}

async function coreSummaries(): Promise<SessionSummary[]> {
  const refs = await listSessions(
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
  return refs.map(toSessionSummary);
}

describe("orbitrace (built binary): version and help", () => {
  it("prints the version and the core status", () => {
    for (const flag of ["--version", "-V"]) {
      const result = run([flag]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`orbitrace ${manifest.version} (core: ${CORE_STATUS})\n`);
      expect(result.stderr).toBe("");
    }
  });

  it("prints the version as one JSON document with --json", () => {
    const result = run(["--version", "--json"]);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({
      name: "orbitrace",
      version: manifest.version,
      core: CORE_STATUS,
    });
  });

  it("prints the main help with --help, -h and help", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
      for (const name of ["open", "list", "export", "doctor", "help"])
        expect(result.stdout).toContain(name);
      expect(result.stdout).toContain("With no command, orbitrace runs 'open'");
      expect(result.stderr).toBe("");
    }
  });

  it("prints help for every command, three ways", () => {
    for (const name of ["open", "list", "export", "doctor", "help"]) {
      const outputs = [
        [name, "--help"],
        [name, "-h"],
        ["help", name],
      ].map((args) => run(args));
      for (const result of outputs) {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`orbitrace ${name}`);
      }
      expect(outputs[1]?.stdout).toBe(outputs[0]?.stdout);
      expect(outputs[2]?.stdout).toBe(outputs[0]?.stdout);
    }
  });

  it("prints help as JSON with the exit codes", () => {
    const all = parseJson(run(["help", "--json"]).stdout) as {
      commands: { name: string }[];
      exitCodes: Record<string, number>;
    };
    expect(all.commands.map((command) => command.name)).toEqual([
      "open",
      "list",
      "export",
      "doctor",
      "help",
    ]);
    expect(all.exitCodes).toEqual({ ok: 0, ...CLI_EXIT_CODES });
    const one = parseJson(run(["export", "--help", "--json"]).stdout) as {
      commands: { name: string }[];
    };
    expect(one.commands.map((command) => command.name)).toEqual(["export"]);
  });
});

describe("orbitrace list (built binary)", () => {
  it("lists the sessions of a --config-dir folder, newest first, as core lists them", async () => {
    const result = run(["list", "--config-dir", machine.configDir, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const doc = parseJson(result.stdout) as { sessions: SessionSummary[]; warnings: unknown[] };
    expect(doc.warnings).toEqual([]);
    expect(doc.sessions).toEqual(await coreSummaries());
    expect(doc.sessions.length).toBeGreaterThan(1);
    const times = doc.sessions.map((session) => session.lastActivity);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(doc.sessions[0]?.projectLabel).toBe(NEWEST_PROJECT);
  });

  it("writes path-free summaries: only the summary fields, no folder of the machine", () => {
    const result = run(["list", "--config-dir", machine.configDir, "--json"]);
    const doc = parseJson(result.stdout) as { sessions: Record<string, unknown>[] };
    for (const session of doc.sessions) {
      expect(Object.keys(session).sort()).toEqual([
        "key",
        "lastActivity",
        "live",
        "projectLabel",
        "runtime",
        "sessionId",
        "subagentCount",
      ]);
    }
    expectPathFree(result);
  });

  it("prints a table for people, with the newest session first", () => {
    const result = run(["list", "--config-dir", machine.configDir]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^KEY\s+LAST ACTIVITY\s+LIVE\s+SUBAGENTS\s+PROJECT$/);
    expect(lines[1]).toMatch(/^claude-code:[0-9a-f]{32}\s+2026-01-15 09:\d\d\s+\w+\s+\d+\s+(\S+)$/);
    expect(lines[1]?.endsWith(`  ${NEWEST_PROJECT}`)).toBe(true);
    expectPathFree(result);
  });

  it("takes --limit", () => {
    const doc = parseJson(
      run(["list", "--config-dir", machine.configDir, "--limit", "2", "--json"]).stdout,
    ) as { sessions: unknown[] };
    expect(doc.sessions).toHaveLength(2);
  });

  it("resolves a relative --config-dir against the working folder", () => {
    const doc = parseJson(
      run(["list", "--config-dir", join("fixtures", "config"), "--json"], { cwd: machine.root })
        .stdout,
    ) as { sessions: unknown[] };
    expect(doc.sessions.length).toBeGreaterThan(1);
  });

  it("finds the sessions through CLAUDE_CONFIG_DIR without a flag", async () => {
    const result = run(["list", "--json"], { env: { CLAUDE_CONFIG_DIR: machine.configDir } });
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout) as { sessions: SessionSummary[] };
    expect(doc.sessions.map((session) => session.key)).toEqual(
      (await coreSummaries()).map((session) => session.key),
    );
  });

  it("reports an empty list, not an error, when no folder has sessions", () => {
    const json = run(["list", "--json"]);
    expect(json.status).toBe(0);
    expect(parseJson(json.stdout)).toEqual({ sessions: [], warnings: [] });
    const text = run(["list"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("No sessions found.");
    expectPathFree(text);
  });

  it("warns about a missing --config-dir folder, naming it only as typed", () => {
    const json = run(["list", "--config-dir", "no-such-folder", "--json"]);
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    const doc = parseJson(json.stdout) as { warnings: { code: string; message: string }[] };
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]?.code).toBe("config-dir-unavailable");
    expect(doc.warnings[0]?.message).toContain("no-such-folder");
    expectPathFree(json);

    const text = run(["list", "--config-dir", "no-such-folder"]);
    expect(text.stderr).toContain("warning:");
    expect(text.stderr).toContain("no-such-folder");
    expectPathFree(text);
  });

  it("searches the desktop app folders only with --extra-roots", () => {
    const [base] = desktopSessionBases(process.platform, machine.home, {
      APPDATA: join(machine.home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(machine.home, ".config"),
    });
    expect(base).toBeDefined();
    const desktopFixtures = join(base as string, "session-one");
    mkdirSync(desktopFixtures, { recursive: true });
    writeFixtureTree(desktopFixtures);

    const without = parseJson(run(["list", "--json"]).stdout) as { sessions: unknown[] };
    expect(without.sessions).toEqual([]);
    const withExtra = run(["list", "--extra-roots", "--json"]);
    expect(withExtra.status).toBe(0);
    const doc = parseJson(withExtra.stdout) as { sessions: unknown[] };
    expect(doc.sessions.length).toBeGreaterThan(1);
    expectPathFree(withExtra);
  });
});

describe("orbitrace export (built binary)", () => {
  it("writes the structure-only replay of the newest session to stdout", () => {
    const result = run(["export", "--latest", "--config-dir", machine.configDir, "--pretty"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The same pipeline as the golden files, so the bytes match.
    expect(result.stdout).toBe(readFileSync(goldenReplayPath("demo"), "utf8"));
    expectPathFree(result);
  });

  it("writes compact JSON without --pretty, and '-o -' is stdout", () => {
    const plain = run(["export", "--latest", "--config-dir", machine.configDir]);
    const dash = run(["export", "--latest", "--config-dir", machine.configDir, "-o", "-"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(validateReplay(JSON.parse(plain.stdout))).toBe(true);
    expect(dash.stdout).toBe(plain.stdout);
  });

  it("exports a session by its key and by a unique start of its key", () => {
    const sessions = (
      parseJson(run(["list", "--config-dir", machine.configDir, "--json"]).stdout) as {
        sessions: SessionSummary[];
      }
    ).sessions;
    const target = sessions[0];
    const other = sessions[1];
    expect(target).toBeDefined();
    const byKey = run([
      "export",
      (target as SessionSummary).key,
      "--config-dir",
      machine.configDir,
    ]);
    const latest = run(["export", "--latest", "--config-dir", machine.configDir]);
    expect(byKey.status).toBe(0);
    expect(byKey.stdout).toBe(latest.stdout);

    const body = (target as SessionSummary).key.split(":")[1] as string;
    const byPrefix = run(["export", body.slice(0, 10), "--config-dir", machine.configDir]);
    expect(byPrefix.status).toBe(0);
    expect(byPrefix.stdout).toBe(latest.stdout);

    const another = run([
      "export",
      (other as SessionSummary).key,
      "--config-dir",
      machine.configDir,
    ]);
    expect(another.status).toBe(0);
    expect(another.stdout).not.toBe(latest.stdout);
  });

  it("wraps the replay in one JSON document with --json", () => {
    const result = run(["export", "--latest", "--config-dir", machine.configDir, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const doc = parseJson(result.stdout) as Record<string, unknown>;
    expect(doc.key).toMatch(/^claude-code:[0-9a-f]{32}$/);
    expect(doc.fileName).toBe("orbitrace.replay.json");
    expect(doc.output).toBeNull();
    expect(doc.bytes).toBeGreaterThan(0);
    expect(validateReplay(doc.replay)).toBe(true);
    expectPathFree(result);
  });

  it("writes a file, refuses to replace it without --force, and replaces it with --force", () => {
    const outDir = makeTempDir();
    const first = run(["export", "--latest", "--config-dir", machine.configDir, "-o", "out.json"], {
      cwd: outDir,
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/^Wrote out\.json \(\d+ bytes\)\.\n$/);
    expect(first.stderr).toContain("check them before you share it");
    const written = readFileSync(join(outDir, "out.json"), "utf8");
    expect(validateReplay(JSON.parse(written))).toBe(true);

    writeFileSync(join(outDir, "out.json"), "keep me");
    const refused = run(
      ["export", "--latest", "--config-dir", machine.configDir, "-o", "out.json", "--json"],
      { cwd: outDir },
    );
    expect(refused.status).toBe(CLI_EXIT_CODES["output-exists"]);
    expect(refused.stdout).toBe("");
    const error = parseJson(refused.stderr) as { error: { code: string; message: string } };
    expect(error.error.code).toBe("output-exists");
    expect(error.error.message).toContain("out.json");
    expect(readFileSync(join(outDir, "out.json"), "utf8")).toBe("keep me");

    const forced = run(
      [
        "export",
        "--latest",
        "--config-dir",
        machine.configDir,
        "-o",
        "out.json",
        "--force",
        "--json",
      ],
      { cwd: outDir },
    );
    expect(forced.status).toBe(0);
    const doc = parseJson(forced.stdout) as Record<string, unknown>;
    expect(doc.output).toBe("out.json");
    expect(doc).not.toHaveProperty("replay");
    expect(readFileSync(join(outDir, "out.json"), "utf8")).toBe(written);
    expectPathFree(forced);
  });

  it("writes orbitrace.replay.json inside a folder given with -o", () => {
    const outDir = makeTempDir();
    const result = run(["export", "--latest", "--config-dir", machine.configDir, "-o", "."], {
      cwd: outDir,
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(outDir, "orbitrace.replay.json"))).toBe(true);
  });

  it("reports a file that cannot be written, naming it as typed", () => {
    const result = run(
      ["export", "--latest", "--config-dir", machine.configDir, "-o", join("missing", "out.json")],
      { cwd: makeTempDir() },
    );
    expect(result.status).toBe(CLI_EXIT_CODES["output-unwritable"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(join("missing", "out.json"));
    expect(result.stderr).toContain("[output-unwritable]");
    expectPathFree(result);
  });

  it("reports an unknown key with the not-found code", () => {
    const result = run(["export", "ffffffffffff", "--config-dir", machine.configDir, "--json"]);
    expect(result.status).toBe(CLI_EXIT_CODES["not-found"]);
    expect(result.stdout).toBe("");
    expect((parseJson(result.stderr) as { error: { code: string } }).error.code).toBe("not-found");
    expectPathFree(result);
  });

  it("reports no sessions for --latest with the no-sessions code", () => {
    const json = run(["export", "--latest", "--json"]);
    expect(json.status).toBe(CLI_EXIT_CODES["no-sessions"]);
    expect(json.stdout).toBe("");
    expect((parseJson(json.stderr) as { error: { code: string } }).error.code).toBe("no-sessions");
    const text = run(["export", "--latest"]);
    expect(text.status).toBe(CLI_EXIT_CODES["no-sessions"]);
    expect(text.stderr).toMatch(/^orbitrace: .+ \[no-sessions\]\n/);
  });

  it("reports an unreadable transcript with the unreadable code", () => {
    // A file mode cannot stop root or Windows from reading the file.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const local = makeFakeMachine(ORDER);
    const transcript = fixturePaths("demo", local.fixturesDir).transcript;
    chmodSync(transcript, 0o000);
    try {
      const result = runBin(["export", "--latest", "--config-dir", local.configDir, "--json"], {
        home: local.home,
      });
      expect(result.status).toBe(CLI_EXIT_CODES.unreadable);
      expect(result.stdout).toBe("");
      const error = parseJson(result.stderr) as { error: { code: string; message: string } };
      expect(error.error.code).toBe("unreadable");
      expect(result.stderr).not.toContain(local.root);
    } finally {
      chmodSync(transcript, 0o644);
    }
  });
});

describe("orbitrace usage errors (built binary)", () => {
  const cases: { args: string[]; text: RegExp }[] = [
    { args: ["bogus"], text: /Unknown command 'bogus'/ },
    { args: ["list", "--bogus"], text: /--bogus/ },
    { args: ["--bogus", "list"], text: /Unknown option '--bogus'/ },
    { args: ["list", "extra"], text: /takes no arguments/ },
    { args: ["list", "--limit", "0"], text: /--limit/ },
    { args: ["list", "--limit", "many"], text: /--limit/ },
    { args: ["export"], text: /session key or --latest/ },
    { args: ["export", "abcd", "--latest"], text: /not both/ },
    { args: ["export", "a", "b"], text: /one session key/ },
    { args: ["export", "--latest", "-o"], text: /-o|--output/ },
    { args: ["help", "bogus"], text: /Unknown command 'bogus'/ },
    { args: ["--version", "list"], text: /--version/ },
  ];

  it.each(cases)("exits 2 with a usage error for $args", ({ args, text }) => {
    const result = run(args);
    expect(result.status).toBe(CLI_EXIT_CODES.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(text);
    expect(result.stderr).toContain("[usage]");

    const json = run([...args, "--json"]);
    expect(json.status).toBe(CLI_EXIT_CODES.usage);
    expect(json.stdout).toBe("");
    const error = parseJson(json.stderr) as { error: { code: string; exitCode: number } };
    expect(error.error).toMatchObject({ code: "usage", exitCode: 2 });
  });
});

describe("orbitrace through a bin symlink", () => {
  it("runs when started through a symlink, as npm installs a bin", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const link = join(dir, "orbitrace");
    symlinkSync(BIN, link);
    const result = runBin(["--version"], { home: machine.home, file: link });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`orbitrace ${manifest.version}`);
  });
});
