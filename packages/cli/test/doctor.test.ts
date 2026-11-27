/**
 * `orbitrace doctor` end to end in-process: the whole report, its pinned JSON shape, the text
 * for the terminal, the exit codes and the agreement with docs/cli.md. Every host points HOME
 * (and CLAUDE_CONFIG_DIR where set) at temporary folders.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctorRuntime, run, type CliIo, type CliRuntime } from "../src/cli.js";
import { DOCTOR_DEFAULT_PARSE_LIMIT, parseCommandLine } from "../src/args.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import {
  ALL_DOCTOR_CODES,
  DOCTOR_CHECK_IDS,
  DOCTOR_CODES,
  DOCTOR_STATUSES,
  formatDoctorText,
  summarize,
  type DoctorCheckResult,
  type DoctorReport,
} from "../src/doctor/report.js";
import { doctorExitCode, runDoctor, runDoctorCommand } from "../src/doctor/run.js";
import type { HostContext } from "../src/sessions.js";
import { cliVersion } from "../src/version.js";
import {
  cannotTestPermissions,
  fakeHost,
  healthyLines,
  healthyRuntime,
  makeAppDir,
  makeHome,
  writeRegistryEntry,
  writeSession,
} from "./doctor-helpers.js";
import { makeFakeMachine, makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

const NO_SOURCES = { configDirs: [], extraRoots: false } as const;

/** A home folder whose default config folder has one session and a running-sessions entry. */
function healthyMachine(): { home: string; host: HostContext } {
  const { home } = makeHome();
  const config = join(home, ".claude");
  writeSession(config, "example-project", "synthetic-session", healthyLines());
  writeRegistryEntry(config, "0", { pid: 0, sessionId: "synthetic-session", status: "idle" });
  return { home, host: fakeHost(home) };
}

async function capture(
  argv: string[],
  host: HostContext,
  runtime: CliRuntime = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await run(argv, io, host, runtime);
  return { code, stdout, stderr };
}

/**
 * A home folder, and a working folder outside it with a distinctive name that holds `cfg/`, a
 * config folder with one invented session. Neither HOME nor the working folder is the real one.
 */
function relativeConfigMachine(): { host: HostContext; cfg: string; session: string } {
  const base = makeTempDir();
  const home = join(base, "home");
  const cwd = join(base, "cwd-marker-zq");
  mkdirSync(home, { recursive: true });
  const cfg = join(cwd, "cfg");
  const session = writeSession(cfg, "example-project", "synthetic-session", healthyLines());
  return { host: { ...fakeHost(home), cwd }, cfg, session };
}

/** The doctor's JSON and text output for a relative --config-dir, with fixed outside checks. */
async function relativeConfigReports(
  host: HostContext,
): Promise<{ json: string; text: string; report: DoctorReport }> {
  const runtime: CliRuntime = { doctor: healthyRuntime(makeAppDir()) };
  const json = await capture(["doctor", "--config-dir", "./cfg", "--json"], host, runtime);
  const text = await capture(["doctor", "--config-dir", "./cfg"], host, runtime);
  expect(json.stderr).toBe("");
  expect(text.stderr).toBe("");
  return { json: json.stdout, text: text.stdout, report: JSON.parse(json.stdout) as DoctorReport };
}

/** The detail keys of each check, as docs/cli.md lists them. */
const DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  "node-version": ["version", "range", "satisfies"],
  "config-folder": ["env", "path", "resolvedBy", "reason", "state", "projects"],
  "session-roots": ["roots", "sessions", "warnings"],
  parser: [
    "limit",
    "checked",
    "parsed",
    "unreadable",
    "lines",
    "malformed",
    "malformedSessions",
    "unknownLines",
    "unknownByType",
    "unknownTypesNotListed",
    "versions",
  ],
  "running-registry": ["folders"],
  "app-bundle": ["present", "files", "missing"],
  "loopback-port": ["host", "bound", "errorCode"],
  "history-store": ["module", "available", "inUse", "errorCode"],
  hooks: [],
  "remote-sources": [],
};

function expectShape(report: DoctorReport): void {
  expect(Object.keys(report)).toEqual([
    "doctor",
    "orbitrace",
    "node",
    "platform",
    "status",
    "summary",
    "checks",
  ]);
  expect(report.doctor).toBe(1);
  expect(report.orbitrace).toBe(cliVersion());
  expect(Object.keys(report.summary)).toEqual([...DOCTOR_STATUSES]);
  expect(report.checks.map((entry) => entry.id)).toEqual([...DOCTOR_CHECK_IDS]);
  for (const entry of report.checks) {
    expect(Object.keys(entry)).toEqual(["id", "status", "code", "message", "fix", "details"]);
    expect(DOCTOR_STATUSES).toContain(entry.status);
    expect(entry.message).not.toContain("\n");
    if (entry.code !== "check-error") {
      expect(DOCTOR_CODES[entry.id] as readonly string[]).toContain(entry.code);
      expect(Object.keys(entry.details)).toEqual(DETAIL_KEYS[entry.id]);
    }
    // Every warn and fail says what to do; nothing else carries a fix.
    if (entry.status === "warn" || entry.status === "fail") {
      expect(typeof entry.fix).toBe("string");
      expect((entry.fix as string).length).toBeGreaterThan(10);
    } else {
      expect(entry.fix).toBeNull();
    }
  }
}

describe("runDoctor", () => {
  it("reports ok for a healthy synthetic set-up, with the pinned JSON shape", async () => {
    const { host } = healthyMachine();
    const report = await runDoctor({
      host,
      sources: NO_SOURCES,
      parseLimit: DOCTOR_DEFAULT_PARSE_LIMIT,
      runtime: healthyRuntime(makeAppDir()),
    });
    expectShape(report);
    expect(report).toMatchObject({
      node: "22.13.0",
      platform: process.platform,
      status: "ok",
      summary: { ok: 8, warn: 0, fail: 0, skipped: 2 },
    });
    expect(report.checks.map((entry) => entry.code)).toEqual([
      "node-version-ok",
      "config-folder-ok",
      "session-roots-ok",
      "parser-ok",
      "running-registry-ok",
      "app-bundle-ok",
      "loopback-port-ok",
      "history-store-available",
      "hooks-not-built",
      "remote-sources-not-built",
    ]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("finds every problem of a broken set-up, each with a fix", async () => {
    const { home } = makeHome();
    const host = fakeHost(home, { CLAUDE_CONFIG_DIR: join(home, "absent") });
    const report = await runDoctor({
      host,
      sources: NO_SOURCES,
      parseLimit: 5,
      runtime: {
        nodeVersion: "18.19.0",
        nodeRange: ">=20",
        appDir: null,
        loadSqlite: () => Promise.reject(new Error("synthetic")),
        bindLoopback: () => Promise.reject(Object.assign(new Error("x"), { code: "EPERM" })),
      },
    });
    expectShape(report);
    expect(report.status).toBe("fail");
    expect(Object.fromEntries(report.checks.map((entry) => [entry.id, entry.code]))).toEqual({
      "node-version": "node-version-unsupported",
      "config-folder": "config-folder-missing",
      "session-roots": "session-roots-unavailable",
      parser: "parser-no-sessions",
      "running-registry": "running-registry-no-roots",
      "app-bundle": "app-bundle-missing",
      "loopback-port": "loopback-port-unavailable",
      "history-store": "history-store-not-in-use",
      hooks: "hooks-not-built",
      "remote-sources": "remote-sources-not-built",
    });
    expect(doctorExitCode(report)).toBe(CLI_EXIT_CODES["doctor-failed"]);
  });

  it("shows a relative --config-dir relative to the working folder, never the working folder", async () => {
    const { host, cfg } = relativeConfigMachine();
    writeRegistryEntry(cfg, "0", { pid: 0, sessionId: "synthetic-session", status: "idle" });
    const { json, text, report } = await relativeConfigReports(host);
    for (const output of [json, text]) {
      expect(output).not.toContain("cwd-marker-zq");
      expect(output).not.toContain(host.homeDir);
    }
    const details = (id: string): Record<string, unknown> =>
      report.checks.find((entry) => entry.id === id)!.details as Record<string, unknown>;
    const roots = details("session-roots").roots as { path: string; resolvedBy: string }[];
    expect(roots.find((root) => root.resolvedBy === "user-setting")?.path).toBe("./cfg");
    const folders = details("running-registry").folders as { path: string }[];
    expect(folders.map((folder) => folder.path)).toContain("./cfg/sessions");
  });

  it("keeps a relative --config-dir relative in the running-registry fix", async () => {
    const { host, cfg } = relativeConfigMachine();
    writeFileSync(join(cfg, "sessions"), "x");
    const { json, text, report } = await relativeConfigReports(host);
    for (const output of [json, text]) expect(output).not.toContain("cwd-marker-zq");
    const registry = report.checks.find((entry) => entry.id === "running-registry")!;
    expect(registry.code).toBe("running-registry-not-a-folder");
    expect(registry.fix).toContain("mv ./cfg/sessions ./cfg/sessions.bak");
  });

  it.skipIf(cannotTestPermissions())(
    "keeps a relative --config-dir relative in the parser-unreadable fix",
    async () => {
      const { host, session } = relativeConfigMachine();
      chmodSync(session, 0o000);
      try {
        const { json, text, report } = await relativeConfigReports(host);
        for (const output of [json, text]) expect(output).not.toContain("cwd-marker-zq");
        const parser = report.checks.find((entry) => entry.id === "parser")!;
        expect(parser.code).toBe("parser-unreadable");
        expect(parser.fix).toContain("chmod -R u+rX ./cfg");
      } finally {
        chmodSync(session, 0o644);
      }
    },
  );

  it("shows no part of a working folder under the home folder for a relative --config-dir", async () => {
    const { home } = makeHome();
    const cwd = join(home, "clients", "acme-marker-zq", "repo");
    writeSession(join(cwd, "cfg"), "example-project", "synthetic-session", healthyLines());
    const { json, text } = await relativeConfigReports({ ...fakeHost(home), cwd });
    for (const output of [json, text]) {
      expect(output).not.toContain("acme-marker-zq");
      expect(output).toContain("./cfg");
    }
  });

  it("uses the same folders as list for --config-dir, and shows no home folder path", async () => {
    const machine = makeFakeMachine();
    const host = fakeHost(machine.home);
    const report = await runDoctor({
      host,
      sources: { configDirs: [machine.configDir], extraRoots: false },
      parseLimit: 3,
      runtime: healthyRuntime(makeAppDir()),
    });
    expectShape(report);
    const roots = report.checks.find((entry) => entry.id === "session-roots") as DoctorCheckResult;
    expect(roots.status).toBe("ok");
    const parser = report.checks.find((entry) => entry.id === "parser") as DoctorCheckResult;
    expect(parser.details).toMatchObject({ limit: 3, checked: 3 });
    const text = formatDoctorText(report);
    expect(text).not.toContain(machine.home);
    expect(JSON.stringify(report)).not.toContain(machine.home);
  });

  it("reports a listing that throws as check-error on the checks that need it", async () => {
    const { host } = healthyMachine();
    const report = await runDoctor({
      host,
      sources: NO_SOURCES,
      parseLimit: 1,
      runtime: {
        ...healthyRuntime(makeAppDir()),
        adapters: [
          {
            runtime: "claude-code",
            displayName: "Broken",
            resolveRoots: () => Promise.reject(new Error("synthetic")),
            listSessions: () => Promise.resolve([]),
            openSession: () => Promise.reject(new Error("synthetic")),
          },
        ],
      },
    });
    const codes = Object.fromEntries(report.checks.map((entry) => [entry.id, entry.code]));
    expect(codes["session-roots"]).toBe("check-error");
    expect(codes.parser).toBe("check-error");
    expect(codes["running-registry"]).toBe("check-error");
    expect(codes["config-folder"]).toBe("config-folder-ok");
    expect(report.status).toBe("fail");
  });
});

describe("summarize and formatDoctorText", () => {
  const checks: DoctorCheckResult[] = [
    {
      id: "node-version",
      status: "ok",
      code: "node-version-ok",
      message: "Fine.",
      fix: null,
      details: {},
    },
    {
      id: "config-folder",
      status: "fail",
      code: "config-folder-missing",
      message: "Missing \u001b[2J folder.",
      fix: "Run 'claude'.",
      details: {},
    },
    {
      id: "running-registry",
      status: "warn",
      code: "running-registry-missing",
      message: "No registry.",
      fix: "Update.",
      details: {},
    },
    {
      id: "hooks",
      status: "skipped",
      code: "hooks-not-built",
      message: "Later.",
      fix: null,
      details: {},
    },
  ];

  it("counts each status and takes the worst as the overall status", () => {
    expect(summarize(checks)).toEqual({
      status: "fail",
      summary: { ok: 1, warn: 1, fail: 1, skipped: 1 },
    });
    expect(summarize(checks.filter((entry) => entry.status !== "fail")).status).toBe("warn");
    expect(summarize([checks[0] as DoctorCheckResult]).status).toBe("ok");
    expect(summarize([]).status).toBe("ok");
  });

  it("writes one line per check, the code and a fix line for each problem", () => {
    const report: DoctorReport = {
      doctor: 1,
      orbitrace: "0.0.0",
      node: "22.13.0",
      platform: "linux",
      ...summarize(checks),
      checks,
    };
    expect(formatDoctorText(report)).toBe(
      [
        "orbitrace doctor: orbitrace 0.0.0, Node 22.13.0, linux. Reads only; changes nothing.",
        "",
        "ok    node-version      Fine.",
        "FAIL  config-folder     Missing ?[2J folder. [config-folder-missing]",
        "                        fix: Run 'claude'.",
        "warn  running-registry  No registry. [running-registry-missing]",
        "                        fix: Update.",
        "skip  hooks             Later.",
        "",
        "Result: fail (1 failed, 1 warning, 1 ok, 1 skipped).",
        "Run 'orbitrace doctor --json' for the codes and details.",
        "",
      ].join("\n"),
    );
  });
});

describe("orbitrace doctor through run", () => {
  it("writes one JSON line on stdout, nothing on stderr, and exits 0 when nothing failed", async () => {
    const { host } = healthyMachine();
    const result = await capture(["doctor", "--json"], host, {
      doctor: healthyRuntime(makeAppDir()),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expectShape(report);
    expect(report.status).toBe("ok");
  });

  it("still writes the report, and exits with doctor-failed, when a check failed", async () => {
    const { home } = makeHome();
    const host = fakeHost(home, { CLAUDE_CONFIG_DIR: join(home, "absent") });
    const json = await capture(["--json", "doctor"], host, {
      appDir: null,
      doctor: { ...healthyRuntime(makeAppDir()), appDir: null },
    });
    expect(json.code).toBe(12);
    expect(json.stderr).toBe("");
    expect((JSON.parse(json.stdout) as DoctorReport).status).toBe("fail");
    const text = await capture(["doctor"], host, { appDir: null });
    expect(text.code).toBe(12);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("FAIL  app-bundle");
    expect(text.stdout).toContain("[config-folder-missing]");
    expect(text.stdout).toContain("fix: ");
  });

  it("passes the open runtime's app folder on to the app-bundle check", async () => {
    const { host } = healthyMachine();
    const appDir = makeAppDir();
    expect(doctorRuntime({ appDir })).toEqual({ appDir });
    expect(doctorRuntime({ appDir, doctor: { appDir: null } })).toEqual({ appDir: null });
    expect(doctorRuntime({ doctor: { nodeVersion: "22.13.0" } })).toEqual({
      nodeVersion: "22.13.0",
    });
    const result = await capture(["doctor", "--json"], host, {
      appDir,
      doctor: { nodeVersion: "22.13.0", nodeRange: ">=20" },
    });
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.checks.find((entry) => entry.id === "app-bundle")?.code).toBe("app-bundle-ok");
  });

  it("reports usage errors like every other command", async () => {
    const { host } = healthyMachine();
    const extra = await capture(["doctor", "now", "--json"], host);
    expect(extra.code).toBe(CLI_EXIT_CODES.usage);
    expect(extra.stdout).toBe("");
    expect(JSON.parse(extra.stderr)).toMatchObject({ error: { code: "usage" } });
    const limit = await capture(["doctor", "--parse-limit", "0"], host);
    expect(limit.code).toBe(CLI_EXIT_CODES.usage);
    expect(limit.stderr).toContain("--parse-limit needs a whole number of at least 1.");
  });

  it("runDoctorCommand writes text without --json", async () => {
    const { host } = healthyMachine();
    let stdout = "";
    const code = await runDoctorCommand(
      parseCommandLine(["doctor", "--parse-limit", "2"]) as Extract<
        ReturnType<typeof parseCommandLine>,
        { kind: "doctor" }
      >,
      { stdout: (text) => (stdout += text), stderr: () => undefined },
      host,
      healthyRuntime(makeAppDir()),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Result: ok (0 failed, 0 warnings, 8 ok, 2 skipped).");
    expect(stdout).toContain("limit 2");
  });
});

describe("docs/cli.md", () => {
  const doc = readFileSync(new URL("../../../docs/cli.md", import.meta.url), "utf8");
  const section = doc.slice(
    doc.indexOf("### `orbitrace doctor`"),
    doc.indexOf("## Where sessions"),
  );

  it("has a doctor section", () => {
    expect(section.length).toBeGreaterThan(100);
  });

  it("lists every code with its status, and no other code", () => {
    const rows = [...section.matchAll(/^\| `([a-z-]+)` +\| `([a-z-]+)` +\| ([a-z, ]+?) +\|/gm)];
    expect(rows.map((match) => match[2])).toEqual([...ALL_DOCTOR_CODES]);
    // Each code sits in the row of its own check; check-error belongs to any check.
    const expectedPairs = [
      ...DOCTOR_CHECK_IDS.flatMap((id) => DOCTOR_CODES[id].map((code) => [id, code])),
      ["any", "check-error"],
    ];
    expect(rows.map((match) => [match[1], match[2]])).toEqual(expectedPairs);
    const statuses = rows.flatMap((match) => (match[3] as string).split(/, | or /));
    for (const status of statuses) expect(DOCTOR_STATUSES).toContain(status);
  });

  it("lists the detail keys of every check", () => {
    for (const id of DOCTOR_CHECK_IDS) {
      for (const key of DETAIL_KEYS[id] ?? []) expect(section).toContain(`\`${key}\``);
    }
  });
});

describe("folders", () => {
  it("are all under the temporary home folder in these tests", async () => {
    const { home } = makeHome();
    mkdirSync(join(home, ".claude"));
    const report = await runDoctor({
      host: fakeHost(home),
      sources: NO_SOURCES,
      parseLimit: 1,
      runtime: healthyRuntime(makeAppDir()),
    });
    const roots = report.checks.find((entry) => entry.id === "session-roots")?.details.roots as {
      path: string;
    }[];
    expect(roots.map((entry) => entry.path)).toEqual([
      `~${process.platform === "win32" ? "\\" : "/"}.claude`,
    ]);
  });
});
