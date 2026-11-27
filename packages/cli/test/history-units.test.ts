/**
 * #195: the small parts of the history commands on their own: the settings file, where the store
 * is for a host, the worker file, the command line, the help and the error mapping. Temporary
 * folders only; runs on every Node.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HistoryStoreError } from "@orbitrace/core/node";
import { COMMANDS, HISTORY_ACTIONS, isHistoryAction, parseCommandLine } from "../src/args.js";
import { CliError, historyCliError, toCliError } from "../src/errors.js";
import { promptYesNo } from "../src/history/commands.js";
import {
  capabilityOf,
  defaultWorkerUrl,
  historyLocationFor,
  HISTORY_WORKER_FILE,
  showLocalPath,
  storeBytes,
  storeExists,
  tryHistoryLocation,
  workerUrlOf,
} from "../src/history/context.js";
import {
  HISTORY_SETTINGS_FILE,
  historySettingsFile,
  readHistorySettings,
  writeHistorySettings,
} from "../src/history/settings.js";
import {
  HISTORY_LOCATOR_PREFIX,
  historyRoot,
  historyRootNow,
  isHistoryRef,
} from "../src/history/source.js";
import { commandHelpText, helpJson } from "../src/help.js";
import type { HostContext } from "../src/sessions.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

function host(home: string, env: Record<string, string> = {}): HostContext {
  return { platform: process.platform, homeDir: home, env: { HOME: home, ...env }, cwd: home };
}

const posix = process.platform !== "win32";

describe("the settings file", () => {
  it("is off when missing, on or off when written, and off (invalid) when unreadable", () => {
    const root = makeTempDir();
    const data = join(root, "data");
    const h = host(join(root, "home"), { ORBITRACE_DATA_DIR: data });
    const location = historyLocationFor(h);
    const file = historySettingsFile(location, h.platform);
    expect(file).toBe(join(data, HISTORY_SETTINGS_FILE));
    expect(readHistorySettings(file)).toEqual({ state: "missing", recording: false });
    expect(existsSync(data)).toBe(false);

    writeHistorySettings(location, { env: h.env, homeDir: h.homeDir, platform: h.platform }, true);
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: true });
    expect(readFileSync(file, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
    // Windows has no POSIX modes: Node cannot set them there.
    const modes = posix
      ? [statSync(file).mode & 0o777, statSync(data).mode & 0o777]
      : [0o600, 0o700];
    expect(modes).toEqual([0o600, 0o700]);
    writeHistorySettings(location, { env: h.env, homeDir: h.homeDir, platform: h.platform }, false);
    expect(readHistorySettings(file)).toEqual({ state: "ok", recording: false });

    for (const text of [
      "not json",
      "[]",
      '{"settings":2,"historyRecording":true}',
      '{"settings":1,"historyRecording":"yes"}',
    ]) {
      writeFileSync(file, text);
      expect(readHistorySettings(file)).toEqual({ state: "invalid", recording: false });
    }
    // A folder where the file should be cannot be read either.
    const odd = join(root, "odd");
    mkdirSync(join(odd, HISTORY_SETTINGS_FILE), { recursive: true });
    expect(readHistorySettings(join(odd, HISTORY_SETTINGS_FILE))).toEqual({
      state: "invalid",
      recording: false,
    });
  });

  it("refuses a data folder inside a Claude Code config folder, creating nothing", () => {
    const root = makeTempDir();
    const config = join(root, "config");
    mkdirSync(config);
    const h = host(join(root, "home"), {
      CLAUDE_CONFIG_DIR: config,
      ORBITRACE_DATA_DIR: join(config, "orbitrace"),
    });
    const location = historyLocationFor(h);
    expect(() =>
      writeHistorySettings(
        location,
        { env: h.env, homeDir: h.homeDir, platform: h.platform },
        true,
      ),
    ).toThrow(expect.objectContaining({ code: "unsafe-location" }));
    expect(existsSync(join(config, "orbitrace"))).toBe(false);
  });

  it("reports a write failure as io, without a path", () => {
    const root = makeTempDir();
    const data = join(root, "data");
    mkdirSync(join(data, HISTORY_SETTINGS_FILE), { recursive: true });
    mkdirSync(join(join(data, HISTORY_SETTINGS_FILE), "x"));
    const h = host(join(root, "home"), { ORBITRACE_DATA_DIR: data });
    let caught: unknown;
    try {
      writeHistorySettings(
        historyLocationFor(h),
        { env: h.env, homeDir: h.homeDir, platform: h.platform },
        true,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HistoryStoreError);
    expect((caught as HistoryStoreError).code).toBe("io");
    expect((caught as Error).message).not.toContain(root);
    expect(readdirNames(data)).toEqual([HISTORY_SETTINGS_FILE]);
  });
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("where the store is for a host", () => {
  it("follows ORBITRACE_DATA_DIR, else .orbitrace in the host's home folder, never process.env", () => {
    const root = makeTempDir();
    const home = join(root, "home");
    expect(historyLocationFor(host(home)).dir).toBe(join(home, ".orbitrace"));
    expect(historyLocationFor(host(home, { ORBITRACE_DATA_DIR: join(root, "d") })).dbFile).toBe(
      join(root, "d", "history.sqlite"),
    );
    expect(tryHistoryLocation(host(home, { ORBITRACE_DATA_DIR: "relative" }))).toBeNull();
    expect(() => historyLocationFor(host(home, { ORBITRACE_DATA_DIR: "relative" }))).toThrow(
      HistoryStoreError,
    );
  });

  it("knows whether a store exists and how big it is, reading only", () => {
    const root = makeTempDir();
    const location = historyLocationFor(host(root, { ORBITRACE_DATA_DIR: join(root, "d") }));
    expect(storeExists(location)).toBe(false);
    expect(storeBytes(location)).toBe(0);
    mkdirSync(location.dir);
    writeFileSync(location.dbFile, "x".repeat(10));
    writeFileSync(`${location.dbFile}-wal`, "x".repeat(5));
    expect(storeExists(location)).toBe(true);
    expect(storeBytes(location)).toBe(15);
  });

  it("shows a path with the home folder as ~", () => {
    const root = makeTempDir();
    const sep = process.platform === "win32" ? "\\" : "/";
    const marker = process.platform === "win32" ? "%USERPROFILE%" : "~";
    expect(showLocalPath(join(root, ".orbitrace"), host(root))).toBe(`${marker}${sep}.orbitrace`);
    expect(showLocalPath("/srv/elsewhere", host(root))).toBe("/srv/elsewhere");
  });
});

describe("the worker file and the capability", () => {
  it("finds history-worker.js beside the module, or null", () => {
    const root = makeTempDir();
    const moduleUrl = pathToFileURL(join(root, "index.js"));
    expect(defaultWorkerUrl(moduleUrl)).toBeNull();
    writeFileSync(join(root, HISTORY_WORKER_FILE), "export {};\n");
    expect(defaultWorkerUrl(moduleUrl)?.href).toBe(
      pathToFileURL(join(root, HISTORY_WORKER_FILE)).href,
    );
    // Run from the sources there is no worker beside the module.
    expect(defaultWorkerUrl()).toBeNull();
    expect(workerUrlOf({ workerUrl: "file:///srv/w.js" })).toBe("file:///srv/w.js");
    expect(workerUrlOf({ workerUrl: null })).toBeNull();
  });

  it("uses the runtime's capability check when given, core's otherwise", async () => {
    const fixed = {
      available: false as const,
      engine: "node:sqlite" as const,
      nodeVersion: "v20.19.0",
      reason: "Invented reason.",
    };
    await expect(capabilityOf({ capability: () => Promise.resolve(fixed) })).resolves.toBe(fixed);
    const real = await capabilityOf({});
    expect(real.engine).toBe("node:sqlite");
    expect(real.nodeVersion).toBe(process.version);
  });
});

describe("history source refs", () => {
  it("marks refs read from the store by their locator", () => {
    const root = historyRoot("/srv/example-data/history.sqlite");
    expect(root).toEqual({
      runtime: "claude-code",
      root: "/srv/example-data/history.sqlite",
      resolvedBy: "extra-root",
      available: true,
    });
    const base = {
      key: "claude-code:aaaa",
      runtime: "claude-code" as const,
      source: root,
      projectLabel: "example",
      sessionId: "id",
      lastActivity: 0,
      live: "ended" as const,
      subagentCount: 0,
    };
    expect(isHistoryRef({ ...base, locator: `${HISTORY_LOCATOR_PREFIX}claude-code:aaaa` })).toBe(
      true,
    );
    expect(isHistoryRef({ ...base, locator: "/srv/example-config/projects/x/id.jsonl" })).toBe(
      false,
    );
  });
});

describe("history on the command line", () => {
  const none = { configDirs: [], extraRoots: false };

  it("parses each subcommand with the options it takes", () => {
    expect(HISTORY_ACTIONS).toEqual([
      "status",
      "enable",
      "disable",
      "ingest",
      "list",
      "delete",
      "where",
    ]);
    for (const action of HISTORY_ACTIONS) expect(isHistoryAction(action)).toBe(true);
    expect(isHistoryAction("bogus")).toBe(false);
    expect(parseCommandLine(["history", "status"])).toEqual({
      kind: "history",
      json: false,
      action: "status",
      sources: none,
      all: false,
      yes: false,
    });
    expect(parseCommandLine(["--json", "history", "where"])).toMatchObject({
      action: "where",
      json: true,
    });
    expect(
      parseCommandLine(["history", "ingest", "--config-dir", "/srv/c", "--extra-roots", "--json"]),
    ).toMatchObject({
      action: "ingest",
      json: true,
      sources: { configDirs: ["/srv/c"], extraRoots: true },
    });
    expect(parseCommandLine(["history", "list", "--limit", "5"])).toMatchObject({
      action: "list",
      limit: 5,
    });
    expect(parseCommandLine(["history", "delete", "claude-code:abcd", "-y"])).toMatchObject({
      action: "delete",
      key: "claude-code:abcd",
      all: false,
      yes: true,
    });
    expect(parseCommandLine(["history", "delete", "--all"])).toMatchObject({
      action: "delete",
      all: true,
      yes: false,
    });
    expect(parseCommandLine(["history", "--help"])).toEqual({
      kind: "help",
      json: false,
      command: "history",
    });
    expect(parseCommandLine(["history", "delete", "--help"])).toEqual({
      kind: "help",
      json: false,
      command: "history",
    });
  });

  it("refuses an empty key", () => {
    expect(() => parseCommandLine(["history", "delete", " "])).toThrow(CliError);
  });
});

describe("history help", () => {
  it("lists every subcommand with its usage, says it is off by default and names the exit code", () => {
    const text = commandHelpText("history");
    for (const sub of COMMANDS.history.subcommands ?? []) {
      expect(text).toContain(sub.usage);
      expect(text).toContain(sub.summary);
    }
    expect(text).toContain("History is off by default.");
    expect(text).toContain("13 (history-unavailable)");
    expect(text).toContain("'disable' also stops a running 'open'");
    expect(text).toContain("'disable', 'where'\nand 'delete --all' still work");
    expect(text).toContain("ORBITRACE_DATA_DIR");
    expect(commandHelpText("open")).toContain("history recording is on");
    expect(commandHelpText("list")).toContain("marked as history");
  });

  it("describes the subcommands in help --json", () => {
    const doc = helpJson("history") as {
      commands: { name: string; subcommands: { name: string; options: string[] }[] }[];
    };
    const [history] = doc.commands;
    expect(history?.subcommands.map((sub) => sub.name)).toEqual([...HISTORY_ACTIONS]);
    expect(history?.subcommands.find((sub) => sub.name === "delete")?.options).toEqual([
      "--json",
      "--all",
      "--yes",
    ]);
    const list = helpJson("list") as { commands: Record<string, unknown>[] };
    expect(list.commands[0]).not.toHaveProperty("subcommands");
  });
});

describe("history errors", () => {
  it("maps the store's codes to the command's exit codes, keeping core's message", () => {
    const cases: [HistoryStoreError["code"], string, number][] = [
      ["unavailable", "history-unavailable", 13],
      ["locked", "history-locked", 14],
      ["unsafe-location", "history-failed", 15],
      ["not-a-store", "history-failed", 15],
      ["newer-schema", "history-failed", 15],
      ["needs-upgrade", "history-failed", 15],
      ["io", "history-failed", 15],
      ["aborted", "history-failed", 15],
    ];
    for (const [code, cliCode, exit] of cases) {
      const error = new HistoryStoreError(code, `Invented message for ${code}.`);
      const mapped = toCliError(error);
      expect(mapped.code).toBe(cliCode);
      expect(mapped.exitCode).toBe(exit);
      expect(mapped.message).toBe(`Invented message for ${code}.`);
      expect(historyCliError(error).code).toBe(cliCode);
    }
    expect(toCliError(new HistoryStoreError("unavailable", "x")).hint).toContain("Node 22.13");
    expect(toCliError(new HistoryStoreError("locked", "x")).hint).toContain("orbitrace open");
    expect(toCliError(new HistoryStoreError("newer-schema", "x")).hint).toContain("delete --all");
    expect(toCliError(new HistoryStoreError("io", "x")).hint).toBeUndefined();
  });
});

describe("promptYesNo", () => {
  it("asks on the output and is true only for an answer starting with y", async () => {
    for (const [answer, expected] of [
      ["y\n", true],
      [" Yes\n", true],
      ["n\n", false],
      ["\n", false],
      ["maybe\n", false],
    ] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      let asked = "";
      output.on("data", (chunk: Buffer) => (asked += chunk.toString("utf8")));
      const reply = promptYesNo("Delete the invented thing? [y/N] ", input, output);
      input.write(answer);
      await expect(reply).resolves.toBe(expected);
      expect(asked).toContain("Delete the invented thing? [y/N] ");
    }
  });
});

describe("historyRootNow", () => {
  it("is null without a store, and null where the store cannot run", async () => {
    const root = makeTempDir();
    const data = join(root, "data");
    const h = host(join(root, "home"), { ORBITRACE_DATA_DIR: data });
    await expect(historyRootNow(h, {})).resolves.toBeNull();
    mkdirSync(data);
    writeFileSync(join(data, "history.sqlite"), "");
    const unavailable = {
      capability: () =>
        Promise.resolve({
          available: false as const,
          engine: "node:sqlite" as const,
          nodeVersion: "v20.19.0",
          reason: "Invented reason.",
        }),
    };
    await expect(historyRootNow(h, unavailable)).resolves.toBeNull();
    const available = {
      capability: () =>
        Promise.resolve({
          available: true as const,
          engine: "node:sqlite" as const,
          nodeVersion: "v22.13.0",
          sqliteVersion: "3.99.0",
          fts5: true,
        }),
    };
    await expect(historyRootNow(h, available)).resolves.toEqual(
      historyRoot(join(data, "history.sqlite")),
    );
    await expect(
      historyRootNow(host(root, { ORBITRACE_DATA_DIR: "relative" }), available),
    ).resolves.toBeNull();
    expect(existsSync(join(root, "home"))).toBe(false);
  });
});
