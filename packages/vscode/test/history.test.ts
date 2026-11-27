/**
 * #211: the extension's side of the history store, with temporary folders only (HOME,
 * CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR point at new folders before any call), a stand-in
 * worker for the scheduling, and core's built worker for the store itself (skipped, with the
 * reason, where `node:sqlite` is missing).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRef } from "@orbitrace/core";
import {
  claudeCodeAdapter,
  HISTORY_LOCATOR_PREFIX,
  historyCapability,
  HistoryStoreError,
  runHistoryIngestWorker,
  withoutSqliteWarning,
  type HistoryCapability,
  type HistoryIngestRequest,
  type HistoryIngestResult,
  type HistoryRecorderProblem,
} from "@orbitrace/core/node";
import { FIXTURE_CONFIG_DIR } from "@orbitrace/fixtures";
import {
  createExtensionHistory,
  ingestLogLine,
  RECORDER_MESSAGES,
  recorderMessage,
  showLocalPath,
  type ExtensionHistoryOptions,
} from "../src/history.js";
import { makeRef, makeSummary, makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

const probe = await withoutSqliteWarning(historyCapability);
const SKIP_NOTE = probe.available ? "" : ` (skipped: ${probe.reason})`;
/** The extension's own built worker (npm run build at the root builds it before the tests). */
const WORKER = pathToFileURL(
  join(fileURLToPath(new URL("..", import.meta.url)), "dist", "history-worker.js"),
);

const RESULT: HistoryIngestResult = {
  sessions: 2,
  sessionsSkipped: 0,
  files: 2,
  filesMissing: 0,
  filesReset: 0,
  linesRead: 3,
  linesAdded: 3,
  linesSkipped: 0,
  redactions: 0,
  durationMs: 7,
};

const UNAVAILABLE: HistoryCapability = {
  available: false,
  engine: "node:sqlite",
  nodeVersion: "v20.18.1",
  reason: "This Node.js (v20.18.1) has no node:sqlite module. History needs Node 22.13 or later.",
};

const AVAILABLE: HistoryCapability = {
  available: true,
  engine: "node:sqlite",
  nodeVersion: "v24.0.0",
  sqliteVersion: "3.50.0",
  fts5: true,
};

/** Temporary home, config and data folders, as the environment a history gets. */
function machine() {
  const base = makeTempDir();
  const home = join(base, "home");
  const config = join(base, "config");
  const data = join(base, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    ORBITRACE_DATA_DIR: data,
  };
  return { base, home, config, data, env, settings: join(data, "settings.json") };
}

const refs: SessionRef[] = [
  makeRef(makeSummary({ key: "claude-code:a" }), "-workspace-kite-workshop"),
  makeRef(makeSummary({ key: "claude-code:b" }), "-workspace-marble-run"),
];

function setup(extra: Partial<ExtensionHistoryOptions> = {}) {
  const m = machine();
  const calls: HistoryIngestRequest[] = [];
  const problems: { message: string; problem: HistoryRecorderProblem | null }[] = [];
  let capabilityCalls = 0;
  const history = createExtensionHistory({
    env: m.env,
    homeDir: m.home,
    capability: async () => {
      capabilityCalls += 1;
      return AVAILABLE;
    },
    workerUrl: "file:///srv/example/history-worker.js",
    listFileSessions: async () => refs,
    findSession: async (key) => refs.find((ref) => ref.key === key) ?? null,
    debounceMs: 5,
    now: () => Date.UTC(2026, 0, 15),
    onProblem: (message, problem) => problems.push({ message, problem }),
    runWorker: async (request) => {
      calls.push(request);
      return RESULT;
    },
    ...extra,
  });
  return { m, history, calls, problems, capabilityCalls: () => capabilityCalls };
}

describe("showLocalPath", () => {
  it("shows the home folder as ~ and leaves other paths alone", () => {
    expect(showLocalPath("/srv/person/.orbitrace", "/srv/person", "linux")).toBe("~/.orbitrace");
    expect(showLocalPath("/srv/person", "/srv/person", "linux")).toBe("~");
    expect(showLocalPath("/srv/data", "/srv/person", "linux")).toBe("/srv/data");
    expect(showLocalPath("/srv/data", "", "linux")).toBe("/srv/data");
    expect(
      showLocalPath("D:\\profiles\\example\\.orbitrace", "D:\\profiles\\example", "win32"),
    ).toBe("~\\.orbitrace");
  });
});

describe("recorderMessage and ingestLogLine", () => {
  it("word the recorder's problems for the editor and a copy for the log, without paths", () => {
    expect(recorderMessage({ kind: "off" })).toBe(RECORDER_MESSAGES.off);
    expect(recorderMessage({ kind: "locked" })).toBe(RECORDER_MESSAGES.locked);
    expect(recorderMessage({ kind: "list" })).toBe(RECORDER_MESSAGES.list);
    expect(recorderMessage({ kind: "io" })).toBe(RECORDER_MESSAGES.io);
    expect(recorderMessage({ kind: "fatal", reason: "Not here." })).toBe(
      "History is not recorded in this window: Not here.",
    );
    expect(recorderMessage({ kind: "fatal" })).toContain("cannot be used");
    expect(ingestLogLine(RESULT)).toBe(
      "History: copied 3 new lines from 2 sessions in the background worker (7 ms).",
    );
    expect(ingestLogLine({ ...RESULT, linesAdded: 1, sessions: 1 })).toContain(
      "1 new line from 1 session",
    );
  });
});

describe("createExtensionHistory with recording off (the default)", () => {
  it("reads the switch, copies nothing, lists nothing from history and creates nothing", async () => {
    const { m, history, calls, capabilityCalls } = setup();
    expect(history.settings()).toEqual({ state: "missing", recording: false });
    await history.sync();
    history.sessionChanged("claude-code:a");
    await history.idle();
    expect(calls).toEqual([]);
    expect(history.recording).toBe(false);
    expect(await history.root()).toBeNull();
    expect(history.storeExists()).toBe(false);
    expect(await history.listStored()).toEqual([]);
    expect(await history.deleteSession("claude-code:a")).toEqual({
      deleted: false,
      scrubbed: true,
    });
    expect(await history.deleteAll()).toBe(false);
    // Turning off with no settings file writes nothing.
    expect((await history.setRecording(false)).written).toBe(false);
    const status = await history.status();
    expect(status).toMatchObject({ exists: false, totals: null, bytes: 0, error: null });
    expect(status.location.dir).toBe(m.data);
    expect(existsSync(m.data)).toBe(false);
    expect(existsSync(join(m.home, ".orbitrace"))).toBe(false);
    // The capability is checked once at most and only when something needs it.
    expect(capabilityCalls()).toBeLessThanOrEqual(1);
  });

  it("wraps the Claude Code adapter to read the store and leaves other adapters alone", () => {
    const { history } = setup();
    const other = { ...claudeCodeAdapter, runtime: "other" as never };
    const [wrapped, untouched] = history.adapters([claudeCodeAdapter, other]);
    expect(wrapped).not.toBe(claudeCodeAdapter);
    expect(wrapped?.runtime).toBe("claude-code");
    expect(untouched).toBe(other);
  });
});

describe("createExtensionHistory with recording on", () => {
  it("writes the shared settings file and copies every file session in the worker", async () => {
    const { m, history, calls } = setup();
    const result = await history.setRecording(true);
    expect(result).toMatchObject({ recording: true, changed: true, written: true });
    expect(readFileSync(m.settings, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
    await history.idle();
    expect(history.recording).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessions?.map((ref) => ref.key)).toEqual(["claude-code:a", "claude-code:b"]);
    // A second sync does not start a second recorder.
    await history.sync();
    await history.idle();
    expect(calls).toHaveLength(1);
  });

  it("copies a changed session again after the quiet period, and stops when turned off", async () => {
    const { history, calls } = setup();
    await history.setRecording(true);
    await history.idle();
    history.sessionChanged("claude-code:b");
    history.sessionChanged("claude-code:b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await history.idle();
    expect(calls.map((call) => call.sessions?.map((ref) => ref.key))).toEqual([
      ["claude-code:a", "claude-code:b"],
      ["claude-code:b"],
    ]);
    await history.setRecording(false);
    expect(history.recording).toBe(false);
    history.sessionChanged("claude-code:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(2);
  });

  it("starts recording at sync when another host turned it on, and afresh after an off and on", async () => {
    const { m, history, calls, problems } = setup();
    mkdirSync(m.data, { recursive: true });
    writeFileSync(m.settings, '{"settings":1,"historyRecording":true}\n');
    await history.sync();
    await history.idle();
    expect(calls).toHaveLength(1);
    // Turned off from the command line: the recorder notices before its next copy.
    writeFileSync(m.settings, '{"settings":1,"historyRecording":false}\n');
    history.sessionChanged("claude-code:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    // And on again: the next change starts a new recorder, which copies everything once.
    writeFileSync(m.settings, '{"settings":1,"historyRecording":true}\n');
    history.sessionChanged("claude-code:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await history.idle();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]?.sessions?.map((ref) => ref.key)).toEqual(["claude-code:a", "claude-code:b"]);
    expect(problems.map((entry) => entry.message)).not.toContain(RECORDER_MESSAGES.off);
  });

  it("reports a store that cannot be used once and does not start again", async () => {
    let runs = 0;
    const { history, problems } = setup({
      runWorker: async () => {
        runs += 1;
        throw new HistoryStoreError("not-a-store", "The file is not a history store.");
      },
    });
    await history.setRecording(true);
    await history.idle();
    expect(history.recording).toBe(false);
    history.sessionChanged("claude-code:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
    expect(problems).toEqual([
      {
        message: "History is not recorded in this window: The file is not a history store.",
        problem: { kind: "fatal", reason: "The file is not a history store." },
      },
    ]);
  });

  it("says once when this build has no worker", async () => {
    const { history, calls, problems } = setup({ workerUrl: null });
    await history.setRecording(true);
    await history.sync();
    expect(calls).toEqual([]);
    expect(problems).toEqual([{ message: RECORDER_MESSAGES.noWorker, problem: null }]);
  });

  it("does nothing where the store cannot run, even with the switch on", async () => {
    const { m, history, calls, problems } = setup({ capability: async () => UNAVAILABLE });
    mkdirSync(m.data, { recursive: true });
    writeFileSync(m.settings, '{"settings":1,"historyRecording":true}\n');
    writeFileSync(join(m.data, "history.sqlite"), "");
    await history.sync();
    history.sessionChanged("claude-code:a");
    await history.idle();
    expect(calls).toEqual([]);
    expect(problems).toEqual([]);
    expect(await history.root()).toBeNull();
    expect((await history.status()).totals).toBeNull();
  });

  it("stop ends recording for good", async () => {
    const { history, calls } = setup();
    await history.setRecording(true);
    await history.idle();
    await history.stop();
    expect(history.recording).toBe(false);
    history.sessionChanged("claude-code:a");
    await history.sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });
});

describe("createExtensionHistory without a usable data folder", () => {
  it("reports why, reads the switch as off and leaves the adapters as they are", async () => {
    const m = machine();
    const history = createExtensionHistory({
      env: { ...m.env, ORBITRACE_DATA_DIR: "relative/data" },
      homeDir: m.home,
      workerUrl: null,
      listFileSessions: async () => [],
      findSession: async () => null,
    });
    expect(history.location()).toEqual({
      location: null,
      reason: expect.stringMatching(/absolute path/),
    });
    expect(history.settings()).toEqual({ state: "missing", recording: false });
    expect(history.storeExists()).toBe(false);
    expect(history.adapters([claudeCodeAdapter])).toEqual([claudeCodeAdapter]);
    expect(await history.root()).toBeNull();
    await expect(history.setRecording(true)).rejects.toThrow(/absolute path/);
    await history.sync();
  });
});

describe(`the store through the extension's own worker${SKIP_NOTE}`, () => {
  it.skipIf(!probe.available)(
    "copies the synthetic sessions, lists them, finds the history root, deletes one and all",
    async () => {
      const m = machine();
      const fixtureRoot = {
        runtime: "claude-code" as const,
        root: FIXTURE_CONFIG_DIR,
        resolvedBy: "user-setting" as const,
        available: true,
      };
      const fileRefs = await claudeCodeAdapter.listSessions(fixtureRoot);
      const ingested: HistoryIngestResult[] = [];
      const history = createExtensionHistory({
        env: m.env,
        homeDir: m.home,
        workerUrl: WORKER,
        listFileSessions: async () => fileRefs,
        findSession: async (key) => fileRefs.find((ref) => ref.key === key) ?? null,
        onIngested: (result) => ingested.push(result),
        runWorker: runHistoryIngestWorker,
      });
      await history.setRecording(true);
      await history.idle();
      expect(ingested).toHaveLength(1);
      expect(ingested[0]?.sessions).toBe(fileRefs.length);
      expect(history.storeExists()).toBe(true);
      expect(existsSync(join(m.data, "history.lock"))).toBe(false);

      const status = await history.status();
      expect(status.totals?.sessions).toBe(fileRefs.length);
      expect(status.bytes).toBeGreaterThan(0);
      const stored = await history.listStored();
      expect(stored.map((s) => s.key).sort()).toEqual(fileRefs.map((r) => r.key).sort());

      const root = await history.root();
      expect(root).toMatchObject({
        root: join(m.data, "history.sqlite"),
        resolvedBy: "extra-root",
      });
      const [adapter] = history.adapters([claudeCodeAdapter]);
      const fromStore = await adapter?.listSessions(root ?? fixtureRoot);
      expect(fromStore?.every((ref) => ref.locator.startsWith(HISTORY_LOCATOR_PREFIX))).toBe(true);

      await history.stop();
      const victim = stored[0]?.key ?? "";
      expect(await history.deleteSession(victim)).toMatchObject({ deleted: true });
      expect((await history.listStored()).map((s) => s.key)).not.toContain(victim);
      expect(await history.deleteAll()).toBe(true);
      expect(history.storeExists()).toBe(false);
      // The switch stays: deleting the store keeps the settings file.
      expect(history.settings().recording).toBe(true);
    },
  );
});
