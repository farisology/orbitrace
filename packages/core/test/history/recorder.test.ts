// Background recording shared by both hosts (#211, from the CLI's #195): scheduling, one worker at
// a time, the switch read before each copy, problems reported once per kind, and the replayer hook.
// A stand-in worker with invented refs; runs on every Node. The real worker is covered by
// worker.test.ts and by each host's own tests.
import { describe, expect, it } from "vitest";
import type { SessionRef } from "../../src/index.js";
import {
  createHistoryRecorder,
  HISTORY_ENDED_AFTER_MS,
  HISTORY_LOCATOR_PREFIX,
  HISTORY_RECORD_DEBOUNCE_MS,
  HistoryStoreError,
  isHistorySessionEnded,
  recordingSessionReplayer,
  type HistoryIngestRequest,
  type HistoryIngestResult,
  type HistoryRecorderOptions,
  type HistoryRecorderProblem,
  type HistoryWorkerOptions,
  type SessionReplayer,
  type SessionReplayListener,
} from "../../src/sources/node.js";

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
    lastActivity: NOW - 10 * HISTORY_ENDED_AFTER_MS,
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
}

function setup(
  extra: Partial<HistoryRecorderOptions> & {
    refs?: SessionRef[];
    fail?: () => unknown;
    on?: () => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const problems: { message: string; problem: HistoryRecorderProblem }[] = [];
  const refs = extra.refs ?? [ref("a"), ref("b")];
  const recorder = createHistoryRecorder({
    workerUrl: "file:///srv/example/history-worker.js",
    dataDir: "/srv/example-data",
    env: { ORBITRACE_DATA_DIR: "/srv/example-data" },
    isRecordingOn: extra.on ?? (() => true),
    listSessions: async () => refs,
    findSession: async (key) => refs.find((candidate) => candidate.key === key) ?? null,
    debounceMs: 5,
    now: () => NOW,
    onProblem: (message, problem) => problems.push({ message, problem }),
    runWorker: async (request, options) => {
      calls.push({ request, options });
      if (extra.fail !== undefined) throw extra.fail();
      return RESULT;
    },
    ...extra,
  });
  return { recorder, calls, problems };
}

describe("isHistorySessionEnded", () => {
  it("is true only for an ended session with nothing written for a minute", () => {
    expect(HISTORY_RECORD_DEBOUNCE_MS).toBe(2000);
    expect(isHistorySessionEnded({ live: "ended", lastActivity: NOW - 60_000 }, NOW)).toBe(true);
    expect(isHistorySessionEnded({ live: "ended", lastActivity: NOW - 59_999 }, NOW)).toBe(false);
    expect(isHistorySessionEnded({ live: "idle", lastActivity: 0 }, NOW)).toBe(false);
  });
});

describe("createHistoryRecorder", () => {
  it("copies every session at start, without stored ones, passing ended sessions as ended", async () => {
    const stored = ref("s", { locator: `${HISTORY_LOCATOR_PREFIX}s` });
    const ended = ref("e", { live: "ended" });
    const { recorder, calls } = setup({ refs: [ref("a"), ended, stored] });
    recorder.start();
    await recorder.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.sessions?.map((r) => r.key)).toEqual(["a", "e"]);
    expect(calls[0]?.request.endedSessionKeys).toEqual(["e"]);
    expect(calls[0]?.options).toMatchObject({
      workerUrl: "file:///srv/example/history-worker.js",
      dataDir: "/srv/example-data",
    });
  });

  it("merges a burst of changes into one copy after the quiet period, one worker at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: HistoryIngestRequest[] = [];
    const ingested: HistoryIngestResult[] = [];
    const { recorder } = setup({
      runWorker: async (request) => {
        calls.push(request);
        if (calls.length === 1) await gate;
        return RESULT;
      },
      onIngested: (result) => ingested.push(result),
    });
    recorder.sessionChanged("a");
    recorder.sessionChanged("a");
    recorder.sessionChanged("b");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.map((request) => request.sessions?.map((r) => r.key))).toEqual([["a", "b"]]);
    // A change while the first copy runs is copied by the next one, not alongside it.
    recorder.sessionChanged("b");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
    release();
    await recorder.idle();
    expect(calls.map((request) => request.sessions?.map((r) => r.key))).toEqual([
      ["a", "b"],
      ["b"],
    ]);
    expect(ingested).toHaveLength(2);
  });

  it("reports a writer held by another process once and tries again on the next change", async () => {
    const { recorder, calls, problems } = setup({
      fail: () => new HistoryStoreError("locked", "locked"),
    });
    recorder.start();
    await recorder.idle();
    recorder.sessionChanged("a");
    await recorder.idle();
    expect(calls).toHaveLength(2);
    expect(problems.map((entry) => entry.problem)).toEqual([{ kind: "locked" }]);
    expect(problems[0]?.message).toContain("another process is writing");
  });

  it("stops copying after a store that cannot be used, with the reason", async () => {
    const { recorder, calls, problems } = setup({
      fail: () => new HistoryStoreError("unsafe-location", "Not here."),
    });
    recorder.start();
    await recorder.idle();
    recorder.sessionChanged("a");
    await recorder.idle();
    expect(calls).toHaveLength(1);
    expect(problems.map((entry) => entry.problem)).toEqual([
      { kind: "fatal", reason: "Not here." },
    ]);
  });

  it("reports a failed copy and a failed listing as their own kinds", async () => {
    const { recorder, problems } = setup({ fail: () => new Error("disk") });
    recorder.start();
    await recorder.idle();
    const listing = setup({
      listSessions: async () => {
        throw new Error("no");
      },
    });
    listing.recorder.start();
    await listing.recorder.idle();
    expect(problems.map((entry) => entry.problem.kind)).toEqual(["io"]);
    expect(listing.problems.map((entry) => entry.problem.kind)).toEqual(["list"]);
  });

  it("drops what is pending once the switch is off, and says so once", async () => {
    let on = true;
    const { recorder, calls, problems } = setup({ on: () => on });
    recorder.sessionChanged("a");
    on = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    recorder.start();
    recorder.sessionChanged("b");
    await recorder.idle();
    expect(calls).toEqual([]);
    expect(problems.map((entry) => entry.problem)).toEqual([{ kind: "off" }]);
  });

  it("treats a switch that cannot be read as off", async () => {
    const { recorder, calls } = setup({
      on: () => {
        throw new Error("unreadable");
      },
    });
    recorder.start();
    await recorder.idle();
    expect(calls).toEqual([]);
  });

  it("stop aborts the running worker and cancels what is pending", async () => {
    let signal: AbortSignal | undefined;
    const { recorder, problems } = setup({
      runWorker: (_request, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener("abort", () =>
            reject(new HistoryStoreError("aborted", "stopped")),
          );
        }),
    });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    recorder.sessionChanged("b");
    await recorder.stop();
    expect(signal?.aborted).toBe(true);
    expect(problems).toEqual([]);
    recorder.start();
    await recorder.idle();
  });
});

describe("recordingSessionReplayer", () => {
  it("passes every call through and tells the sink about each replay update only", async () => {
    const listeners: SessionReplayListener[] = [];
    const base: SessionReplayer = {
      list: async () => [],
      find: async (key) => ref(key),
      load: async () => ({}) as never,
      follow: (_key, listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const changed: string[] = [];
    const wrapped = recordingSessionReplayer(base, { sessionChanged: (key) => changed.push(key) });
    expect(await wrapped.list()).toEqual([]);
    expect((await wrapped.find("a")).key).toBe("a");
    expect(await wrapped.load("a")).toEqual({});
    const seen: string[] = [];
    wrapped.follow("a", (update) => seen.push(update.type));
    listeners[0]?.({ type: "replay", replay: {} as never, live: "idle" });
    listeners[0]?.({ type: "ended" });
    expect(changed).toEqual(["a"]);
    expect(seen).toEqual(["replay", "ended"]);
  });
});
