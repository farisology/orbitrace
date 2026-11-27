/**
 * #195: background recording while `orbitrace open` runs. The recorder's scheduling is checked
 * with a stand-in worker on every Node; `open` with recording on is checked end to end with
 * core's real worker on synthetic fixture sessions in temporary folders (skipped, with the
 * reason, without node:sqlite).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listSessions, type SessionRef, type SessionSummary } from "@orbitrace/core";
import {
  claudeCodeAdapter,
  HistoryStoreError,
  openHistoryStore,
  type HistoryIngestRequest,
  type HistoryIngestResult,
  type HistoryWorkerOptions,
} from "@orbitrace/core/node";
import type { CliRuntime } from "../src/cli.js";
import { ENDED_AFTER_MS, isEndedSession } from "../src/history/context.js";
import { createHistoryRecorder, type HistoryRecorder } from "../src/history/recorder.js";
import { HISTORY_LOCATOR_PREFIX } from "../src/history/source.js";
import { recordingReplayer } from "../src/open.js";
import type { LoopbackServer } from "../src/server/server.js";
import { removeTempDirs } from "./helpers.js";
import {
  dataFiles,
  historyRuntime,
  makeHistoryMachine,
  oneJson,
  runCli,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
} from "./history-helpers.js";
import {
  appendToolCall,
  eventually,
  fixtureTranscript,
  makeAppFolder,
  openLive,
} from "./server-helpers.js";

afterAll(() => {
  removeTempDirs();
});

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function ref(key: string, extra: Partial<SessionRef> = {}): SessionRef {
  return {
    key,
    runtime: "claude-code",
    source: {
      runtime: "claude-code",
      root: "/srv/example-config",
      resolvedBy: "user-setting",
      available: true,
    },
    projectLabel: "example-project",
    sessionId: `id-${key}`,
    lastActivity: NOW - 10 * ENDED_AFTER_MS,
    live: "unknown",
    subagentCount: 0,
    locator: `/srv/example-config/projects/example/${key}.jsonl`,
    ...extra,
  };
}

const RESULT: HistoryIngestResult = {
  sessions: 1,
  sessionsSkipped: 0,
  files: 1,
  filesMissing: 0,
  filesReset: 0,
  linesRead: 1,
  linesAdded: 1,
  linesSkipped: 0,
  redactions: 0,
  durationMs: 1,
};

interface Call {
  readonly request: HistoryIngestRequest;
  readonly options: HistoryWorkerOptions;
  finish(error?: Error): void;
}

/** A stand-in worker whose runs finish when the test says so. */
function fakeWorker(): {
  calls: Call[];
  run: (r: HistoryIngestRequest, o: HistoryWorkerOptions) => Promise<HistoryIngestResult>;
} {
  const calls: Call[] = [];
  return {
    calls,
    run: (request, options) =>
      new Promise((resolve, reject) => {
        const call: Call = {
          request,
          options,
          finish: (error) => (error === undefined ? resolve(RESULT) : reject(error)),
        };
        options.signal?.addEventListener("abort", () =>
          reject(new HistoryStoreError("aborted", "The history ingest was stopped.")),
        );
        calls.push(call);
      }),
  };
}

const tick = (ms = 0): Promise<void> => new Promise((done) => setTimeout(done, ms));

function recorder(
  worker: ReturnType<typeof fakeWorker>,
  sessions: readonly SessionRef[],
  problems: string[] = [],
  extra: {
    listSessions?: () => Promise<readonly SessionRef[]>;
    isRecordingOn?: () => boolean;
  } = {},
): HistoryRecorder {
  return createHistoryRecorder({
    workerUrl: "file:///srv/example/history-worker.js",
    dataDir: "/srv/example-data",
    env: { HOME: "/srv/example-home" },
    isRecordingOn: extra.isRecordingOn ?? (() => true),
    listSessions: extra.listSessions ?? (() => Promise.resolve(sessions)),
    findSession: (key) => Promise.resolve(sessions.find((entry) => entry.key === key) ?? null),
    debounceMs: 20,
    now: () => NOW,
    onProblem: (message) => problems.push(message),
    runWorker: worker.run,
  });
}

describe("isEndedSession", () => {
  it("is true only for an ended session that has been quiet for a minute", () => {
    expect(isEndedSession(ref("a", { live: "ended" }), NOW)).toBe(true);
    expect(isEndedSession(ref("a", { live: "ended", lastActivity: NOW - 1000 }), NOW)).toBe(false);
    for (const live of ["busy", "idle", "unknown"] as const) {
      expect(isEndedSession(ref("a", { live }), NOW)).toBe(false);
    }
  });
});

describe("the history recorder", () => {
  it("copies every session with files at start, passing the ended ones, in one worker", async () => {
    const worker = fakeWorker();
    const sessions = [
      ref("claude-code:aaaa", { live: "ended" }),
      ref("claude-code:bbbb"),
      ref("claude-code:cccc", { locator: `${HISTORY_LOCATOR_PREFIX}claude-code:cccc` }),
    ];
    const rec = recorder(worker, sessions);
    rec.start();
    await tick();
    expect(worker.calls).toHaveLength(1);
    const [call] = worker.calls;
    expect(call!.request.sessions?.map((entry) => entry.key)).toEqual([
      "claude-code:aaaa",
      "claude-code:bbbb",
    ]);
    expect(call!.request.endedSessionKeys).toEqual(["claude-code:aaaa"]);
    expect(call!.options).toMatchObject({
      workerUrl: "file:///srv/example/history-worker.js",
      dataDir: "/srv/example-data",
      env: { HOME: "/srv/example-home" },
    });
    call!.finish();
    await rec.idle();
    await rec.stop();
  });

  it("waits for the quiet period, copies a burst of changes once, and runs one worker at a time", async () => {
    const worker = fakeWorker();
    const sessions = [ref("claude-code:aaaa"), ref("claude-code:bbbb")];
    const rec = recorder(worker, sessions);
    rec.sessionChanged("claude-code:aaaa");
    rec.sessionChanged("claude-code:aaaa");
    rec.sessionChanged("claude-code:bbbb");
    await tick(5);
    expect(worker.calls).toHaveLength(0);
    await eventually(() => worker.calls.length === 1);
    expect(worker.calls[0]!.request.sessions?.map((entry) => entry.key)).toEqual([
      "claude-code:aaaa",
      "claude-code:bbbb",
    ]);
    expect(worker.calls[0]!.request.endedSessionKeys).toBeUndefined();
    // A change while the worker runs waits for it.
    rec.sessionChanged("claude-code:bbbb");
    await tick(60);
    expect(worker.calls).toHaveLength(1);
    worker.calls[0]!.finish();
    await eventually(() => worker.calls.length === 2);
    expect(worker.calls[1]!.request.sessions?.map((entry) => entry.key)).toEqual([
      "claude-code:bbbb",
    ]);
    worker.calls[1]!.finish();
    await rec.idle();
    await rec.stop();
  });

  it("stop terminates a running worker, cancels what is pending and runs nothing after", async () => {
    const worker = fakeWorker();
    const rec = recorder(worker, [ref("claude-code:aaaa")]);
    rec.start();
    await tick();
    rec.sessionChanged("claude-code:aaaa");
    expect(worker.calls[0]!.options.signal?.aborted).toBe(false);
    await rec.stop();
    expect(worker.calls[0]!.options.signal?.aborted).toBe(true);
    rec.start();
    rec.sessionChanged("claude-code:aaaa");
    await tick(60);
    expect(worker.calls).toHaveLength(1);
  });

  it("reports a locked store once and keeps trying; turns itself off for a store it cannot use", async () => {
    const worker = fakeWorker();
    const problems: string[] = [];
    const rec = recorder(worker, [ref("claude-code:aaaa")], problems);
    rec.start();
    await tick();
    worker.calls[0]!.finish(new HistoryStoreError("locked", "Locked."));
    await rec.idle();
    rec.sessionChanged("claude-code:aaaa");
    await eventually(() => worker.calls.length === 2);
    worker.calls[1]!.finish(new HistoryStoreError("locked", "Locked."));
    await rec.idle();
    expect(problems).toEqual([
      "History: another process is writing the history store, so this run copies nothing until it finishes.",
    ]);
    rec.sessionChanged("claude-code:aaaa");
    await eventually(() => worker.calls.length === 3);
    worker.calls[2]!.finish(
      new HistoryStoreError(
        "unsafe-location",
        "The history folder must not be inside a git working tree.",
      ),
    );
    await rec.idle();
    expect(problems[1]).toBe(
      "History is not recorded in this run: The history folder must not be inside a git working tree.",
    );
    rec.sessionChanged("claude-code:aaaa");
    rec.start();
    await tick(60);
    expect(worker.calls).toHaveLength(3);
    await rec.stop();
  });

  it("reports a failed copy or listing, and skips a run with nothing to copy", async () => {
    const worker = fakeWorker();
    const problems: string[] = [];
    const failing = recorder(worker, [], problems, {
      listSessions: () => Promise.reject(new Error("synthetic")),
    });
    failing.start();
    await failing.idle();
    expect(problems).toEqual([
      "History: the sessions to copy could not be listed; trying again later.",
    ]);
    expect(worker.calls).toHaveLength(0);
    await failing.stop();

    const empty = recorder(worker, [], problems);
    empty.start();
    empty.sessionChanged("claude-code:unknown");
    await tick(60);
    await empty.idle();
    expect(worker.calls).toHaveLength(0);
    await empty.stop();

    const io = recorder(worker, [ref("claude-code:aaaa")], problems);
    io.start();
    await tick();
    worker.calls[0]!.finish(new Error("synthetic"));
    await io.idle();
    expect(problems.at(-1)).toBe(
      "History: a copy into the history store failed; trying again on the next change.",
    );
    await io.stop();
  });

  it("copies nothing more once recording is turned off: a change after it schedules no copy", async () => {
    const worker = fakeWorker();
    const problems: string[] = [];
    let on = true;
    const rec = recorder(worker, [ref("claude-code:aaaa")], problems, {
      isRecordingOn: () => on,
    });
    rec.start();
    await tick();
    expect(worker.calls).toHaveLength(1);
    worker.calls[0]!.finish();
    await rec.idle();
    // `orbitrace history disable` in another terminal.
    on = false;
    rec.sessionChanged("claude-code:aaaa");
    rec.sessionChanged("claude-code:aaaa");
    await tick(60);
    await rec.idle();
    expect(worker.calls).toHaveLength(1);
    expect(problems).toEqual(["History recording was turned off; this run copies nothing more."]);
    // Turning it on again takes effect the next time `open` starts, not in this run.
    on = true;
    rec.sessionChanged("claude-code:aaaa");
    rec.start();
    await tick(60);
    expect(worker.calls).toHaveLength(1);
    await rec.stop();
  });

  it("drops a pending copy when recording is turned off during the quiet period or the listing", async () => {
    const worker = fakeWorker();
    const problems: string[] = [];
    let on = true;
    const sessions = [ref("claude-code:aaaa")];
    const quiet = recorder(worker, sessions, problems, { isRecordingOn: () => on });
    quiet.sessionChanged("claude-code:aaaa");
    on = false;
    await tick(60);
    await quiet.idle();
    expect(worker.calls).toHaveLength(0);
    await quiet.stop();

    // Turned off while the sessions to copy are being listed: checked again before the copy.
    on = true;
    const listing = recorder(worker, sessions, problems, {
      isRecordingOn: () => on,
      listSessions: () => {
        on = false;
        return Promise.resolve(sessions);
      },
    });
    listing.start();
    await tick(20);
    await listing.idle();
    expect(worker.calls).toHaveLength(0);
    expect(problems).toEqual([
      "History recording was turned off; this run copies nothing more.",
      "History recording was turned off; this run copies nothing more.",
    ]);
    await listing.stop();
  });

  it("treats a switch it cannot read as off, and copies nothing when recording is off at start", async () => {
    const worker = fakeWorker();
    const problems: string[] = [];
    const throwing = recorder(worker, [ref("claude-code:aaaa")], problems, {
      isRecordingOn: () => {
        throw new Error("synthetic");
      },
    });
    throwing.start();
    await throwing.idle();
    const off = recorder(worker, [ref("claude-code:aaaa")], problems, {
      isRecordingOn: () => false,
    });
    off.start();
    off.sessionChanged("claude-code:aaaa");
    await tick(60);
    await off.idle();
    expect(worker.calls).toHaveLength(0);
    expect(problems).toHaveLength(2);
    await throwing.stop();
    await off.stop();
  });

  it("recordingReplayer tells the recorder about each replay of a followed session", async () => {
    const changed: string[] = [];
    const fake: HistoryRecorder = {
      start: () => undefined,
      sessionChanged: (key) => changed.push(key),
      stop: () => Promise.resolve(),
      idle: () => Promise.resolve(),
    };
    const updates: string[] = [];
    const inner = {
      list: () => Promise.resolve([] as readonly SessionSummary[]),
      find: () => Promise.reject(new Error("unused")),
      load: () => Promise.reject(new Error("unused")),
      follow: (_key: string, listener: (update: never) => void) => {
        listener({ type: "replay", replay: {}, live: "busy" } as never);
        listener({ type: "ended" } as never);
        return () => undefined;
      },
    };
    const wrapped = recordingReplayer(inner as never, fake);
    wrapped.follow("claude-code:aaaa", (update) => updates.push(update.type));
    expect(changed).toEqual(["claude-code:aaaa"]);
    expect(updates).toEqual(["replay", "ended"]);
    await expect(wrapped.list()).resolves.toEqual([]);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`open with recording on${SKIP_NOTE}`, () => {
  it("copies sessions at start and after a change, never blocks the server, and stops with it", async () => {
    const machine = makeHistoryMachine();
    expect((await runCli(["history", "enable"], machine.host)).code).toBe(0);
    const [newest] = await listSessions(
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
    const app = makeAppFolder();
    const controller = new AbortController();
    let rec: HistoryRecorder | undefined;
    const counts: { start?: number; after?: number; sessions?: number } = {};
    const lines = async (): Promise<number> => {
      const reader = await openHistoryStore({ mode: "read", dataDir: machine.data, env: {} });
      try {
        counts.sessions = reader.totals().sessions;
        return reader.totals().lines;
      } finally {
        reader.close();
      }
    };
    let during: Promise<void> = Promise.resolve();
    const runtime: CliRuntime = {
      history: historyRuntime({ debounceMs: 30 }),
      appDir: app.appDir,
      stopSignal: controller.signal,
      onRecorder: (recorder) => {
        rec = recorder;
      },
      onListening: (server: LoopbackServer) => {
        during = (async () => {
          await rec!.idle();
          counts.start = await lines();
          const live = await openLive(server.port, server.token, { id: 7, key: newest!.key });
          await live.lines(1);
          appendToolCall(fixtureTranscript(machine, newest!.sessionId));
          // The watcher reports the change, the recorder waits 30 ms, then the worker copies it.
          let latest = counts.start;
          for (let attempt = 0; attempt < 150 && latest <= counts.start; attempt += 1) {
            await new Promise((done) => setTimeout(done, 100));
            await rec!.idle();
            latest = await lines();
          }
          counts.after = latest;
          live.abort();
        })().finally(() => controller.abort());
      },
    };
    const result = await runCli(["open", "--no-browser", "--json"], machine.host, runtime);
    await during;
    expect(result.code).toBe(0);
    expect(oneJson(result.stdout)).toMatchObject({ warnings: [] });
    expect(result.stderr).toBe("");
    expect(counts.sessions).toBe(9);
    expect(counts.start).toBeGreaterThan(0);
    expect(counts.after).toBeGreaterThan(counts.start ?? 0);
    expect(existsSync(join(machine.data, "history.lock"))).toBe(false);
  }, 60_000);

  it("stops a running open from copying once recording is turned off and the store deleted", async () => {
    const machine = makeHistoryMachine();
    expect((await runCli(["history", "enable"], machine.host)).code).toBe(0);
    const [newest] = await listSessions(
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
    const app = makeAppFolder();
    const controller = new AbortController();
    let rec: HistoryRecorder | undefined;
    const seen: { storedAtStart?: boolean; recreated?: boolean; disable?: number } = {};
    let during: Promise<void> = Promise.resolve();
    const runtime: CliRuntime = {
      history: historyRuntime({ debounceMs: 30 }),
      appDir: app.appDir,
      stopSignal: controller.signal,
      onRecorder: (recorder) => {
        rec = recorder;
      },
      onListening: (server: LoopbackServer) => {
        during = (async () => {
          await rec!.idle();
          seen.storedAtStart = existsSync(join(machine.data, "history.sqlite"));
          // In another terminal: turn recording off, then delete the store.
          seen.disable = (await runCli(["history", "disable"], machine.host)).code;
          const deleted = await runCli(["history", "delete", "--all", "--yes"], machine.host);
          expect(deleted.code).toBe(0);
          // The app follows a session (its first replay is a change), and the session grows.
          const live = await openLive(server.port, server.token, { id: 7, key: newest!.key });
          await live.lines(1);
          appendToolCall(fixtureTranscript(machine, newest!.sessionId));
          await live.lines(2);
          // Well past the 30 ms quiet period.
          await new Promise((done) => setTimeout(done, 300));
          await rec!.idle();
          seen.recreated = existsSync(join(machine.data, "history.sqlite"));
          live.abort();
        })().finally(() => controller.abort());
      },
    };
    const result = await runCli(["open", "--no-browser"], machine.host, runtime);
    await during;
    expect(result.code).toBe(0);
    expect(seen).toEqual({ storedAtStart: true, disable: 0, recreated: false });
    expect(dataFiles(machine)).toEqual(["settings.json"]);
    expect(result.stderr).toContain(
      "orbitrace: warning: History recording was turned off; this run copies nothing more.",
    );
  }, 60_000);

  it("says in the document when recording is on but this run cannot record", async () => {
    const machine = makeHistoryMachine();
    expect((await runCli(["history", "enable"], machine.host)).code).toBe(0);
    const app = makeAppFolder();
    const controller = new AbortController();
    const result = await runCli(["open", "--no-browser", "--json"], machine.host, {
      history: historyRuntime({ workerUrl: null }),
      appDir: app.appDir,
      stopSignal: controller.signal,
      onListening: () => controller.abort(),
    });
    expect(result.code).toBe(0);
    expect(oneJson(result.stdout)).toMatchObject({
      warnings: [
        {
          code: "history-not-recorded",
          message:
            "History recording is on, but this run records nothing: this build of orbitrace has no history worker.",
        },
      ],
    });
    expect(existsSync(join(machine.data, "history.sqlite"))).toBe(false);
  });
});
