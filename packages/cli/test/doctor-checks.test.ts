/**
 * Each `orbitrace doctor` check in its ok state and in each failing state, against synthetic
 * folders under the system's temporary folder. HOME (and CLAUDE_CONFIG_DIR where a test sets
 * it) point at temporary folders through the fake host; the doctor never reads `process.env`.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  listSessions,
  type SessionInput,
  type SessionRef,
  type SourceAdapter,
  type SourceRoot,
} from "@orbitrace/core";
import { CLAUDE_CODE_RUNTIME, type HistoryCapability } from "@orbitrace/core/node";
import {
  CHECK_ERROR_MESSAGE,
  HISTORY_MODULE,
  UNKNOWN_TYPES_LISTED,
  bindLoopbackPort,
  check,
  checkAppBundleFinding,
  checkConfigFolder,
  checkHistoryStore,
  checkHooks,
  checkLoopbackPort,
  checkNodeVersion,
  checkParser,
  checkRemoteSources,
  checkRunningRegistry,
  checkSessionRoots,
  readRecordingState,
  reportTypeName,
  tallySessions,
} from "../src/doctor/checks.js";
import { parseVersion } from "../src/doctor/engines.js";
import { CLI_ADAPTERS, resolveRoots } from "../src/sessions.js";
import {
  cannotTestPermissions,
  fakeHost,
  healthyLines,
  makeAppDir,
  makeHome,
  syntheticLine,
  writeRegistryEntry,
  writeSession,
} from "./doctor-helpers.js";
import { makeFakeMachine, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

const NO_SOURCES = { configDirs: [], extraRoots: false } as const;

function root(path: string, available: boolean, resolvedBy: SourceRoot["resolvedBy"]): SourceRoot {
  return { runtime: CLAUDE_CODE_RUNTIME, root: path, resolvedBy, available };
}

describe("node-version", () => {
  it("is ok inside the range", () => {
    const result = checkNodeVersion("22.13.0", ">=20");
    expect(result).toMatchObject({ status: "ok", code: "node-version-ok", fix: null });
    expect(result.details).toEqual({ version: "22.13.0", range: ">=20", satisfies: true });
  });

  it("fails outside the range, with a command to install a supported Node", () => {
    const result = checkNodeVersion("18.19.0", ">=20");
    expect(result).toMatchObject({ status: "fail", code: "node-version-unsupported" });
    expect(result.fix).toContain("nvm install --lts");
    expect(result.message).toContain("18.19.0");
  });

  it("is skipped when there is no range or it cannot be read", () => {
    expect(checkNodeVersion("22.13.0", null)).toMatchObject({
      status: "skipped",
      code: "node-version-range-unknown",
      fix: null,
    });
    expect(checkNodeVersion("22.13.0", "20 - 22")).toMatchObject({
      status: "skipped",
      code: "node-version-range-unknown",
    });
  });
});

describe("config-folder", () => {
  it("is ok for the default folder under the home folder, shown as ~", async () => {
    const { home } = makeHome();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const result = await checkConfigFolder(fakeHost(home), []);
    expect(result).toMatchObject({ status: "ok", code: "config-folder-ok", fix: null });
    expect(result.message).toContain(`~${process.platform === "win32" ? "\\" : "/"}.claude`);
    expect(result.message).not.toContain(home);
    expect(result.details).toMatchObject({
      env: "unset",
      resolvedBy: "os-default",
      state: "ok",
      projects: "ok",
    });
  });

  it("is ok for CLAUDE_CONFIG_DIR and says it came from there", async () => {
    const { root: base, home } = makeHome();
    const config = join(base, "config");
    mkdirSync(join(config, "projects"), { recursive: true });
    const result = await checkConfigFolder(fakeHost(home, { CLAUDE_CONFIG_DIR: config }), []);
    expect(result).toMatchObject({ status: "ok", code: "config-folder-ok" });
    expect(result.message).toContain("CLAUDE_CONFIG_DIR");
    expect(result.details).toMatchObject({ env: "set", resolvedBy: "environment", path: config });
  });

  it("fails when CLAUDE_CONFIG_DIR is not an absolute path", async () => {
    const { home } = makeHome();
    const result = await checkConfigFolder(
      fakeHost(home, { CLAUDE_CONFIG_DIR: "relative/config" }),
      [],
    );
    expect(result).toMatchObject({ status: "fail", code: "config-folder-env-invalid" });
    expect(result.fix).toContain("CLAUDE_CONFIG_DIR=<absolute path>");
    expect(result.message).not.toContain("relative/config");
  });

  it("fails when no home folder is known", async () => {
    const host = { platform: "linux", homeDir: "", env: {}, cwd: "/" };
    const result = await checkConfigFolder(host, []);
    expect(result).toMatchObject({ status: "fail", code: "config-folder-no-home" });
    expect(result.fix).toContain("export HOME=");
  });

  it("fails when the folder is missing and no other folder is readable, else warns", async () => {
    const { root: base, home } = makeHome();
    const host = fakeHost(home);
    const alone = await checkConfigFolder(host, []);
    expect(alone).toMatchObject({ status: "fail", code: "config-folder-missing" });
    expect(alone.fix).toContain("'claude'");
    const other = await checkConfigFolder(host, [root(join(base, "other"), true, "user-setting")]);
    expect(other).toMatchObject({ status: "warn", code: "config-folder-missing" });
    // The config folder itself, unreadable, is not "another" folder.
    const self = await checkConfigFolder(host, [root(join(home, ".claude"), false, "os-default")]);
    expect(self.status).toBe("fail");
  });

  it("names CLAUDE_CONFIG_DIR in the fix when the folder it names is missing", async () => {
    const { root: base, home } = makeHome();
    const result = await checkConfigFolder(
      fakeHost(home, { CLAUDE_CONFIG_DIR: join(base, "absent") }),
      [],
    );
    expect(result).toMatchObject({ status: "fail", code: "config-folder-missing" });
    expect(result.fix).toContain("unset CLAUDE_CONFIG_DIR");
  });

  it("fails when the folder is a file", async () => {
    const { root: base, home } = makeHome();
    writeFileSync(join(home, ".claude"), "x");
    const result = await checkConfigFolder(fakeHost(home), []);
    expect(result).toMatchObject({ status: "fail", code: "config-folder-not-a-folder" });
    expect(result.fix).toContain("mv ~/.claude ~/.claude.bak");
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    const fromEnv = await checkConfigFolder(fakeHost(home, { CLAUDE_CONFIG_DIR: file }), []);
    expect(fromEnv).toMatchObject({ status: "fail", code: "config-folder-not-a-folder" });
    expect(fromEnv.fix).toMatch(/^Set CLAUDE_CONFIG_DIR/);
  });

  it("fails with its own code and a move fix when projects/ is a file", async () => {
    const { home } = makeHome();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "projects"), "x");
    const result = await checkConfigFolder(fakeHost(home), []);
    expect(result).toMatchObject({
      status: "fail",
      code: "config-folder-projects-not-a-folder",
    });
    expect(result.details).toMatchObject({ state: "ok", projects: "not-a-folder" });
    expect(result.message).toContain("~/.claude/projects is a file");
    expect(result.fix).toBe(
      "Move the file away ('mv ~/.claude/projects ~/.claude/projects.bak'), then run Claude Code once ('claude') so it creates the folder.",
    );
    expect(result.fix).not.toContain("chmod");
  });

  it("warns when the folder has no projects folder", async () => {
    const { home } = makeHome();
    mkdirSync(join(home, ".claude"));
    const result = await checkConfigFolder(fakeHost(home), []);
    expect(result).toMatchObject({ status: "warn", code: "config-folder-no-projects" });
    expect(result.details).toMatchObject({ state: "ok", projects: "missing" });
  });

  it.skipIf(cannotTestPermissions())(
    "fails when the folder or its projects folder cannot be read",
    async () => {
      const { home } = makeHome();
      const config = join(home, ".claude");
      mkdirSync(join(config, "projects"), { recursive: true });
      chmodSync(join(config, "projects"), 0o000);
      try {
        const projects = await checkConfigFolder(fakeHost(home), []);
        expect(projects).toMatchObject({ status: "fail", code: "config-folder-unreadable" });
        expect(projects.fix).toBe(
          "Give your account read access: 'chmod -R u+rX ~/.claude/projects'.",
        );
      } finally {
        chmodSync(join(config, "projects"), 0o755);
      }
      chmodSync(config, 0o000);
      try {
        const folder = await checkConfigFolder(fakeHost(home), []);
        expect(folder).toMatchObject({ status: "fail", code: "config-folder-unreadable" });
        expect(folder.fix).toContain("chmod -R u+rX ~/.claude");
      } finally {
        chmodSync(config, 0o755);
      }
    },
  );
});

describe("session-roots", () => {
  it("is ok with sessions, counting them per folder through the same resolution as list", async () => {
    const machine = makeFakeMachine();
    const host = fakeHost(machine.home);
    const resolved = await resolveRoots(host, {
      configDirs: [machine.configDir],
      extraRoots: false,
    });
    const sessions = await listSessions(resolved.roots, CLI_ADAPTERS);
    const result = checkSessionRoots(host, resolved.roots, resolved.warnings, sessions);
    expect(result).toMatchObject({ status: "ok", code: "session-roots-ok", fix: null });
    const roots = result.details.roots as {
      resolvedBy: string;
      sessions: number;
      available: boolean;
    }[];
    expect(roots.map((entry) => entry.resolvedBy)).toEqual(["user-setting", "os-default"]);
    expect(roots[0]).toMatchObject({ available: true, sessions: sessions.length });
    expect(roots[1]).toMatchObject({ available: false, sessions: 0 });
    expect(result.details.sessions).toBe(sessions.length);
    expect(result.message).toBe(`Found ${sessions.length} sessions in 1 of 2 folders.`);
  });

  it("fails with no folder at all", () => {
    const result = checkSessionRoots(fakeHost("/srv/example-home"), [], [], []);
    expect(result).toMatchObject({ status: "fail", code: "session-roots-none" });
    expect(result.fix).toContain("--config-dir");
  });

  it("fails when no folder can be read", () => {
    const result = checkSessionRoots(
      fakeHost("/srv/example-home"),
      [root("/srv/example-home/.claude", false, "os-default")],
      [],
      [],
    );
    expect(result).toMatchObject({ status: "fail", code: "session-roots-unavailable" });
    expect(result.details.roots).toEqual([
      {
        path: "~/.claude",
        resolvedBy: "os-default",
        reason:
          "The default config folder for this operating system. The folder was missing or not readable.",
        available: false,
        sessions: 0,
      },
    ]);
  });

  it("warns about a --config-dir folder that cannot be read", () => {
    const warning = {
      code: "config-dir-unavailable" as const,
      message: "The folder given with --config-dir was not found or cannot be read: ./typo",
    };
    const result = checkSessionRoots(
      fakeHost("/srv/example-home"),
      [root("/srv/example-home/.claude", true, "os-default")],
      [warning],
      [],
    );
    expect(result).toMatchObject({ status: "warn", code: "session-roots-config-dir-unavailable" });
    expect(result.details.warnings).toEqual([warning]);
  });

  it("warns when the readable folders hold no sessions", () => {
    const result = checkSessionRoots(
      fakeHost("/srv/example-home"),
      [root("/srv/example-home/.claude", true, "os-default")],
      [],
      [],
    );
    expect(result).toMatchObject({ status: "warn", code: "session-roots-empty" });
    expect(result.fix).toContain("--extra-roots");
  });
});

/** An adapter whose sessions cannot be opened. */
function brokenAdapter(): SourceAdapter {
  return {
    runtime: CLAUDE_CODE_RUNTIME,
    displayName: "Broken",
    resolveRoots: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    openSession: (): Promise<SessionInput> => Promise.reject(new Error("synthetic failure")),
  };
}

async function sessionsUnder(configDir: string): Promise<readonly SessionRef[]> {
  return listSessions([root(configDir, true, "user-setting")], CLI_ADAPTERS);
}

describe("parser", () => {
  it("is ok on the synthetic fixtures, counting skipped types by name and count only", async () => {
    const machine = makeFakeMachine();
    const sessions = await sessionsUnder(machine.configDir);
    const result = await checkParser(fakeHost(machine.home), sessions, 20, CLI_ADAPTERS);
    expect(result).toMatchObject({ status: "ok", code: "parser-ok", fix: null });
    expect(result.details).toMatchObject({
      limit: 20,
      checked: sessions.length,
      parsed: sessions.length,
      unreadable: 0,
      malformed: 0,
      malformedSessions: 0,
      unknownTypesNotListed: 0,
    });
    const unknown = result.details.unknownByType as Record<string, number>;
    expect(Object.keys(unknown).every((type) => type.startsWith("synthetic-"))).toBe(true);
    expect(result.details.unknownLines).toBe(
      Object.values(unknown).reduce((sum, count) => sum + count, 0),
    );
    expect(result.message).toContain("limit 20");
  });

  it("reads at most the limit, newest first", async () => {
    const machine = makeFakeMachine();
    const sessions = await sessionsUnder(machine.configDir);
    const result = await checkParser(fakeHost(machine.home), sessions, 1, CLI_ADAPTERS);
    expect(result.details).toMatchObject({ limit: 1, checked: 1, parsed: 1 });
  });

  it("warns about malformed lines and never shows their content", async () => {
    const { root: base, home } = makeHome();
    const config = join(base, "config");
    writeSession(config, "example-project", "synthetic-a", [
      ...healthyLines(),
      '{"type":"user","message":"half-written example',
      syntheticLine("synthetic-future-event"),
    ]);
    writeSession(config, "example-project", "synthetic-b", healthyLines());
    const sessions = await sessionsUnder(config);
    const result = await checkParser(fakeHost(home), sessions, 20, CLI_ADAPTERS);
    expect(result).toMatchObject({ status: "warn", code: "parser-malformed-lines" });
    expect(result.details).toMatchObject({
      checked: 2,
      malformed: 1,
      malformedSessions: 1,
      unknownLines: 1,
      unknownByType: { "synthetic-future-event": 1 },
      versions: ["2.1.300"],
    });
    expect(result.fix).toContain("claude update");
    const text = JSON.stringify(result);
    for (const content of ["half-written example", "example prompt", "example reply"]) {
      expect(text).not.toContain(content);
    }
  });

  it("warns about sessions that cannot be read", async () => {
    const machine = makeFakeMachine();
    const sessions = await sessionsUnder(machine.configDir);
    const result = await checkParser(fakeHost(machine.home), sessions, 2, [brokenAdapter()]);
    expect(result).toMatchObject({ status: "warn", code: "parser-unreadable" });
    expect(result.details).toMatchObject({ checked: 2, parsed: 0, unreadable: 2 });
    expect(result.fix).toContain("chmod -R u+rX");
    expect(result.fix).not.toContain("synthetic failure");
  });

  it("is skipped with no sessions", async () => {
    expect(await checkParser(fakeHost("/srv/example-home"), [], 20, CLI_ADAPTERS)).toMatchObject({
      status: "skipped",
      code: "parser-no-sessions",
      details: { limit: 20, checked: 0, parsed: 0, lines: 0, versions: [] },
    });
  });

  it("lists at most the 20 most common skipped types and counts the rest", async () => {
    const { root: base, home } = makeHome();
    const config = join(base, "config");
    const lines = healthyLines();
    for (let index = 0; index < UNKNOWN_TYPES_LISTED + 5; index += 1) {
      lines.push(syntheticLine(`synthetic-type-${String(index).padStart(2, "0")}`));
    }
    lines.push(syntheticLine("synthetic-type-00"));
    writeSession(config, "example-project", "synthetic-many", lines);
    const result = await checkParser(fakeHost(home), await sessionsUnder(config), 20, CLI_ADAPTERS);
    const unknown = result.details.unknownByType as Record<string, number>;
    expect(Object.keys(unknown)).toHaveLength(UNKNOWN_TYPES_LISTED);
    expect(Object.keys(unknown)[0]).toBe("synthetic-type-00");
    expect(unknown["synthetic-type-00"]).toBe(2);
    expect(result.details.unknownTypesNotListed).toBe(5);
    expect(result.details.unknownLines).toBe(UNKNOWN_TYPES_LISTED + 6);
  });

  it("tallySessions adds up the line counts and keeps well-formed versions only", async () => {
    const { root: base } = makeHome();
    const config = join(base, "config");
    writeSession(config, "example-project", "synthetic-v", [
      syntheticLine("user", { version: "2.1.301" }),
      syntheticLine("user", { version: "not a version" }),
      syntheticLine("user", { version: "2.1.299" }),
    ]);
    const tally = await tallySessions(await sessionsUnder(config), CLI_ADAPTERS);
    expect(tally).toMatchObject({ sessions: 1, unreadable: 0, lines: 3, malformed: 0 });
    expect(tally.versions).toEqual(["2.1.299", "2.1.301"]);
  });

  it("reportTypeName replaces control characters and cuts long names", () => {
    expect(reportTypeName("synthetic\u001b[31m")).toBe("synthetic?[31m");
    expect(reportTypeName("")).toBe("(none)");
    const long = reportTypeName("x".repeat(100));
    expect(long).toHaveLength(64);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("running-registry", () => {
  it("is ok when the folder can be read, counting listed and running sessions", async () => {
    const { root: base, home } = makeHome();
    const config = join(base, "config");
    writeRegistryEntry(config, String(process.pid), {
      pid: process.pid,
      sessionId: "synthetic-live",
      status: "busy",
    });
    writeRegistryEntry(config, "0", { pid: 0, sessionId: "synthetic-ended", status: "idle" });
    writeFileSync(join(config, "sessions", "broken.json"), "{not json");
    const result = await checkRunningRegistry(fakeHost(home), [root(config, true, "environment")]);
    expect(result).toMatchObject({ status: "ok", code: "running-registry-ok", fix: null });
    expect(result.details.folders).toEqual([
      { path: join(config, "sessions"), state: "ok", entries: 2, running: 1 },
    ]);
  });

  it("is ok, as information with no fix, when no config folder has one (lead decision on #184)", async () => {
    const { home } = makeHome();
    mkdirSync(join(home, ".claude"));
    const result = await checkRunningRegistry(fakeHost(home), [
      root(join(home, ".claude"), true, "os-default"),
    ]);
    expect(result).toMatchObject({ status: "ok", code: "running-registry-missing", fix: null });
    expect(result.message).toContain("'unknown'");
    expect(result.message).toContain("desktop-only");
    expect(result.message).not.toContain(home);
  });

  it("fails when it is a file", async () => {
    const { root: base, home } = makeHome();
    const config = join(base, "config");
    mkdirSync(config);
    writeFileSync(join(config, "sessions"), "x");
    const result = await checkRunningRegistry(fakeHost(home), [root(config, true, "environment")]);
    expect(result).toMatchObject({ status: "fail", code: "running-registry-not-a-folder" });
    expect(result.fix).toContain("mv ");
  });

  it.skipIf(cannotTestPermissions())("fails when it cannot be read", async () => {
    const { home } = makeHome();
    const config = join(home, ".claude");
    mkdirSync(join(config, "sessions"), { recursive: true });
    chmodSync(join(config, "sessions"), 0o000);
    try {
      const result = await checkRunningRegistry(fakeHost(home), [root(config, true, "os-default")]);
      expect(result).toMatchObject({ status: "fail", code: "running-registry-unreadable" });
      expect(result.fix).toBe("Give your account read access: 'chmod -R u+rX ~/.claude/sessions'.");
    } finally {
      chmodSync(join(config, "sessions"), 0o755);
    }
  });

  it("is skipped with no readable config folder", async () => {
    expect(
      await checkRunningRegistry(fakeHost("/srv/example-home"), [
        root("/srv/example-home/.claude", false, "os-default"),
      ]),
    ).toMatchObject({ status: "skipped", code: "running-registry-no-roots" });
  });
});

describe("app-bundle", () => {
  it("is ok when the page and every file it loads are there", () => {
    const result = checkAppBundleFinding(makeAppDir());
    expect(result).toMatchObject({ status: "ok", code: "app-bundle-ok", fix: null });
    expect(result.details).toEqual({ present: true, files: 2, missing: [] });
  });

  it("fails when there is no app", () => {
    for (const dir of [null, join(makeHome().root, "nothing")]) {
      const result = checkAppBundleFinding(dir);
      expect(result).toMatchObject({ status: "fail", code: "app-bundle-missing" });
      expect(result.fix).toContain("npm run build");
    }
  });

  it("fails when a file the page loads is missing, naming it relative to the app", () => {
    const dir = makeAppDir();
    writeFileSync(
      join(dir, "index.html"),
      '<script src="./assets/index-example.js"></script><link href="assets/gone.css">',
    );
    const result = checkAppBundleFinding(dir);
    expect(result).toMatchObject({ status: "fail", code: "app-bundle-incomplete" });
    expect(result.details).toEqual({ present: true, files: 2, missing: ["assets/gone.css"] });
    expect(result.message).toContain("assets/gone.css");
    expect(result.message).not.toContain(dir);
  });

  it("is ok for the web app this build carries", () => {
    // The tests run from the sources, so point at the built dist/app (`npm test` builds first).
    const result = checkAppBundleFinding(fileURLToPath(new URL("../dist/app", import.meta.url)));
    expect(result).toMatchObject({ status: "ok", details: { present: true, missing: [] } });
    expect(result.details.files).toBeGreaterThan(0);
  });
});

describe("loopback-port", () => {
  it("is ok when a port of 127.0.0.1 can be listened on", async () => {
    await expect(bindLoopbackPort()).resolves.toBeUndefined();
    const result = await checkLoopbackPort();
    expect(result).toMatchObject({ status: "ok", code: "loopback-port-ok", fix: null });
    expect(result.details).toEqual({ host: "127.0.0.1", bound: true, errorCode: null });
  });

  it("fails when listening fails, naming the error code but not the error's text", async () => {
    const error = Object.assign(new Error("listen EACCES /private/example/path"), {
      code: "EACCES",
    });
    const result = await checkLoopbackPort(() => Promise.reject(error));
    expect(result).toMatchObject({ status: "fail", code: "loopback-port-unavailable" });
    expect(result.details).toEqual({ host: "127.0.0.1", bound: false, errorCode: "EACCES" });
    expect(JSON.stringify(result)).not.toContain("/private/example/path");
    expect(result.fix).toContain("127.0.0.1");
    const odd = await checkLoopbackPort(() => Promise.reject(new Error("no code")));
    expect(odd.details).toMatchObject({ errorCode: null });
  });
});

/** A capability as core reports it where node:sqlite loads, with invented versions. */
const LOADS: HistoryCapability = {
  available: true,
  engine: "node:sqlite",
  nodeVersion: "v22.13.0",
  sqliteVersion: "3.99.0",
  fts5: false,
};
/** A capability as core reports it where node:sqlite is missing. */
const MISSING: HistoryCapability = {
  available: false,
  engine: "node:sqlite",
  nodeVersion: "v20.19.0",
  reason: "This Node.js (v20.19.0) has no node:sqlite module. History needs Node 22.13 or later.",
};
const OFF = { settings: "missing", recording: false } as const;
const ON = { settings: "ok", recording: true } as const;

describe("history-store", () => {
  it("is ok when core says the store can run, and says whether recording is on", async () => {
    const off = await checkHistoryStore("22.13.0", () => Promise.resolve(LOADS), OFF);
    expect(off).toMatchObject({ status: "ok", code: "history-store-available", fix: null });
    expect(off.details).toEqual({
      module: HISTORY_MODULE,
      available: true,
      inUse: false,
      errorCode: null,
      recording: false,
      settings: "missing",
      reason: null,
      sqliteVersion: "3.99.0",
      fts5: false,
    });
    expect(off.message).toContain("recording is off");
    expect(off.message).toContain("orbitrace history enable");
    const on = await checkHistoryStore("22.13.0", () => Promise.resolve(LOADS), ON);
    expect(on).toMatchObject({ status: "ok", code: "history-store-available", fix: null });
    expect(on.details).toMatchObject({ inUse: true, recording: true, settings: "ok" });
    expect(on.message).toContain("recording is on");
  });

  it("is skipped, with no fix, when the store cannot run and recording is off", async () => {
    const result = await checkHistoryStore("20.19.0", () => Promise.resolve(MISSING), OFF);
    expect(result).toMatchObject({
      status: "skipped",
      code: "history-store-not-in-use",
      fix: null,
    });
    expect(result.details).toMatchObject({
      available: false,
      inUse: false,
      errorCode: null,
      reason: MISSING.reason,
      sqliteVersion: null,
      fts5: null,
    });
    expect(result.message).toContain("Node 22.13 or later");
  });

  it("warns, with a fix, when the store cannot run and recording is on", async () => {
    const result = await checkHistoryStore("20.19.0", () => Promise.resolve(MISSING), ON);
    expect(result).toMatchObject({ status: "warn", code: "history-store-unavailable" });
    expect(result.details).toMatchObject({ available: false, inUse: true, recording: true });
    expect(result.fix).toContain("nvm install 22");
    expect(result.fix).toContain("orbitrace history disable");
  });

  it("warns when the settings file cannot be read (recording is then off)", async () => {
    const result = await checkHistoryStore("22.13.0", () => Promise.resolve(LOADS), {
      settings: "invalid",
      recording: false,
    });
    expect(result).toMatchObject({ status: "warn", code: "history-store-settings-invalid" });
    expect(result.fix).toContain("orbitrace history enable");
  });

  it("suggests only disable, which runs on every Node, for an unreadable settings file where the store cannot run", async () => {
    const result = await checkHistoryStore("20.19.0", () => Promise.resolve(MISSING), {
      settings: "invalid",
      recording: false,
    });
    expect(result).toMatchObject({ status: "warn", code: "history-store-settings-invalid" });
    expect(result.fix).toBe(
      "Write it again with 'orbitrace history disable' (off). Turning recording on needs Node 22.13 or later.",
    );
    expect(result.fix).not.toContain("history enable");
  });

  it("uses core's real capability check by default", async () => {
    const version = parseVersion(process.versions.node) ?? [0, 0, 0];
    const unflagged = version[0] > 22 || (version[0] === 22 && version[1] >= 13);
    const result = await checkHistoryStore(process.versions.node);
    expect(result.status).toBe(unflagged ? "ok" : "skipped");
    expect(result.details.available).toBe(unflagged);
  });

  it("reads the recording switch from the settings file of the host's data folder, creating nothing", () => {
    const { home } = makeHome();
    const data = join(home, "data-folder");
    const host = fakeHost(home, { ORBITRACE_DATA_DIR: data });
    expect(readRecordingState(host)).toEqual({ settings: "missing", recording: false });
    expect(existsSync(data)).toBe(false);
    mkdirSync(data);
    writeFileSync(
      join(data, "settings.json"),
      JSON.stringify({ settings: 1, historyRecording: true }),
    );
    expect(readRecordingState(host)).toEqual({ settings: "ok", recording: true });
    writeFileSync(join(data, "settings.json"), "not json");
    expect(readRecordingState(host)).toEqual({ settings: "invalid", recording: false });
    const nowhere = fakeHost(home, { ORBITRACE_DATA_DIR: "relative/folder" });
    expect(readRecordingState(nowhere)).toEqual({ settings: "unknown", recording: false });
  });
});

describe("hooks and remote-sources", () => {
  it("are skipped until #30 builds them", () => {
    expect(checkHooks()).toMatchObject({ status: "skipped", code: "hooks-not-built", fix: null });
    expect(checkRemoteSources()).toMatchObject({
      status: "skipped",
      code: "remote-sources-not-built",
      fix: null,
    });
    expect(checkHooks().message).toContain("#30");
    expect(checkRemoteSources().message).toContain("#30");
  });
});

describe("check", () => {
  it("adds the id to a finding", async () => {
    expect(await check("hooks", checkHooks)).toMatchObject({
      id: "hooks",
      code: "hooks-not-built",
    });
  });

  it("turns a check that throws into a fail with a fixed message", async () => {
    const result = await check("parser", () => {
      throw new Error("EACCES: /private/example/secret.jsonl");
    });
    expect(result).toEqual({
      id: "parser",
      status: "fail",
      code: "check-error",
      message: CHECK_ERROR_MESSAGE,
      fix: expect.stringContaining("orbitrace doctor") as unknown,
      details: {},
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("session folders resolved for a host", () => {
  it("never include the real home folder", async () => {
    const { home } = makeHome();
    const { roots } = await resolveRoots(fakeHost(home), NO_SOURCES);
    expect(roots.every((entry) => entry.root.startsWith(home))).toBe(true);
  });
});
