// watchSessionFiles (ticket #74) on a temporary folder laid out like one Claude Code session.
// Every folder name, session id and line is invented. Nothing reads the real config folder.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_WATCH_MODES,
  openNodeDirectoryWatcher,
  watchSessionFiles,
  type DirectoryWatchOpener,
  type SessionFilesChange,
  type SessionWatchOptions,
  type SessionWatchTargets,
} from "../../src/sources/node.js";

const SESSION = "sess-watch-0001";
const LINE = (n: number): string => `${JSON.stringify({ type: "user", synthetic: n })}\n`;

/**
 * Fast timings, no backstop: only events, polling or the settle check report a change. Used with
 * an injected `openWatcher`, where the test decides when events arrive, and by the one test that
 * proves real `fs.watch` events alone are enough.
 */
const FAST: SessionWatchOptions = {
  debounceMs: 20,
  maxWaitMs: 200,
  pollIntervalMs: 40,
  backstopIntervalMs: 0,
};

/**
 * For tests on real folders that check what is reported (one change per append, filters,
 * replaced and deleted files), not how fast `fs.watch` is. `fs.watch` can be slow or drop an
 * event on a loaded machine (macOS FSEvents especially), so a short backstop keeps these tests
 * from depending on it. The backstop only reports differences, so the counts stay exact.
 */
const STEADY: SessionWatchOptions = { ...FAST, backstopIntervalMs: 100 };

/** Generous: a loaded CI machine or a full `npm test` run can delay timers and events. */
const WAIT = { timeout: 5000 } as const;

let base: string;
let caseDir: string;
let caseNumber = 0;
let targets: SessionWatchTargets;
const stops: (() => void)[] = [];

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Repeat `action` until `done()` holds, waiting up to `each` ms after every try. For real
 * `fs.watch` events, which a platform may start reporting only some time after the watcher
 * opened: once one try is seen the watcher is known to be armed. Returns the tries used.
 */
async function retryUntil(
  action: () => Promise<void>,
  done: () => boolean,
  { tries = 20, each = 250 }: { tries?: number; each?: number } = {},
): Promise<number> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await action();
    const until = Date.now() + each;
    while (Date.now() < until) {
      if (done()) return attempt;
      await sleep(10);
    }
    if (done()) return attempt;
  }
  throw new Error(`no result after ${tries} tries`);
}

/** The real folder watcher, recording which folders it opened. */
function spyOpener(): { opener: DirectoryWatchOpener; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    opener: (dir, onEvent, onError) => {
      const watcher = openNodeDirectoryWatcher(dir, onEvent, onError);
      opened.push(dir);
      return watcher;
    },
  };
}

/** The built Node entry, used to run a watch in a child process. `npm test` builds it first. */
const DIST_ENTRY = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  "dist",
  "sources",
  "node.js",
);

/**
 * The handles a watch holds: folder watchers and timers. Read it only right after an `await
 * sleep(...)` resolves, never inside `vi.waitFor`, whose own timers would be counted.
 */
function handleCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((name) => name === "FSEventWrap" || name === "Timeout" || name === "StatWatcher")
    .length;
}

/** Start a watch that records every change, and stop it after the test. */
function record(
  options: SessionWatchOptions = STEADY,
  watchTargets: SessionWatchTargets = targets,
): { changes: SessionFilesChange[]; stop: () => void } {
  const changes: SessionFilesChange[] = [];
  const stop = watchSessionFiles(watchTargets, (change) => changes.push(change), options);
  stops.push(stop);
  return { changes, stop };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "orbitrace-watch-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  caseNumber += 1;
  caseDir = join(base, `case-${caseNumber}`);
  const projectDir = join(caseDir, "projects", "-srv-example-project");
  const sessionDir = join(projectDir, SESSION);
  targets = {
    transcript: join(projectDir, `${SESSION}.jsonl`),
    sessionDir,
    subagentsDir: join(sessionDir, "subagents"),
    registryDir: join(caseDir, "sessions"),
  };
  await mkdir(projectDir, { recursive: true });
  await mkdir(targets.registryDir as string, { recursive: true });
  await writeFile(targets.transcript, LINE(1), "utf8");
  // Let late events for the setup writes arrive before a watch starts.
  await sleep(30);
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("SESSION_WATCH_MODES", () => {
  it("lists the three modes", () => {
    expect(SESSION_WATCH_MODES).toEqual(["auto", "events", "poll"]);
  });
});

describe("watchSessionFiles with fs.watch", { timeout: 30_000 }, () => {
  it("reports changes by fs.watch events alone once the watchers are armed", async () => {
    // Events mode, no backstop, no settle check: nothing but real events can report a change.
    const spy = spyOpener();
    const { changes } = record({ ...FAST, mode: "events", settleMs: 0, openWatcher: spy.opener });
    let line = 2;
    // A platform may drop events until the watcher is armed; repeat until one is seen.
    await retryUntil(
      () => appendFile(targets.transcript, LINE(line++)),
      () => changes.length >= 1,
    );
    // Armed: each later append is one event-driven change.
    const armed = changes.length;
    await appendFile(targets.transcript, LINE(line++));
    await vi.waitFor(() => expect(changes.length).toBe(armed + 1), WAIT);

    // A subagent folder that appears later gets its own watcher, and its events count too.
    const agent = join(targets.subagentsDir, "agent-e1.jsonl");
    await mkdir(targets.subagentsDir, { recursive: true });
    await writeFile(agent, LINE(1));
    await vi.waitFor(() => expect(spy.opened).toContain(targets.subagentsDir), WAIT);
    const before = changes.length;
    await retryUntil(
      () => appendFile(agent, LINE(line++)),
      () => changes.length > before,
    );
    const subArmed = changes.length;
    await appendFile(agent, LINE(line++));
    await vi.waitFor(() => expect(changes.length).toBe(subArmed + 1), WAIT);
    expect(changes.every((c) => c.files && !c.registry)).toBe(true);
  });

  it("reports one change for lines appended to the main transcript", async () => {
    const { changes } = record();
    await sleep(50);
    expect(changes).toEqual([]);
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await sleep(250);
    expect(changes).toEqual([{ files: true, registry: false }]);
  });

  it("keeps the backstop poll from reporting a change twice", async () => {
    const { changes } = record({ ...FAST, mode: "auto", backstopIntervalMs: 30 });
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await sleep(200);
    expect(changes).toHaveLength(1);
  });

  it("notices a subagent folder that appears after the watch started, and files in it", async () => {
    const spy = spyOpener();
    const { changes } = record({ ...STEADY, openWatcher: spy.opener });
    const agent = join(targets.subagentsDir, "agent-a1.jsonl");
    await mkdir(targets.subagentsDir, { recursive: true });
    await writeFile(agent, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), WAIT);
    // Both new folders are watched from now on.
    await vi.waitFor(() => {
      expect(spy.opened).toContain(targets.sessionDir);
      expect(spy.opened).toContain(targets.subagentsDir);
    }, WAIT);
    await sleep(150);
    const afterCreate = changes.length;
    expect(changes.every((c) => c.files && !c.registry)).toBe(true);

    await appendFile(agent, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 1), WAIT);

    await writeFile(join(targets.subagentsDir, "agent-a1.meta.json"), "{}");
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 2), WAIT);

    await writeFile(join(targets.subagentsDir, "agent-a2.jsonl"), LINE(1));
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 3), WAIT);
  });

  it("ignores other entries in the subagents folder and other sessions in the project folder", async () => {
    await mkdir(targets.subagentsDir, { recursive: true });
    const { changes } = record();
    await writeFile(join(targets.subagentsDir, "notes.txt"), "synthetic");
    await writeFile(join(dirname(targets.transcript), "sess-other.jsonl"), LINE(1));
    await mkdir(join(targets.sessionDir, "tool-results"), { recursive: true });
    await sleep(300);
    expect(changes).toEqual([]);
  });

  it("survives the transcript being replaced and keeps watching it", async () => {
    const { changes } = record();
    const temporary = join(dirname(targets.transcript), "replacement.tmp");
    await writeFile(temporary, LINE(1) + LINE(2));
    await rename(temporary, targets.transcript);
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await sleep(150);
    const afterReplace = changes.length;
    await appendFile(targets.transcript, LINE(3));
    await vi.waitFor(() => expect(changes.length).toBe(afterReplace + 1), WAIT);
  });

  it("reports a deleted transcript and its return", async () => {
    const { changes } = record();
    await rm(targets.transcript);
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await writeFile(targets.transcript, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBe(2), WAIT);
  });

  it("rewatches a subagents folder that is removed and created again", async () => {
    await mkdir(targets.subagentsDir, { recursive: true });
    const spy = spyOpener();
    const { changes } = record({ ...STEADY, openWatcher: spy.opener });
    const watchedAtStart = spy.opened.filter((dir) => dir === targets.subagentsDir).length;
    expect(watchedAtStart).toBe(1);
    await rm(targets.subagentsDir, { recursive: true });
    await mkdir(targets.subagentsDir, { recursive: true });
    await writeFile(join(targets.subagentsDir, "agent-b1.jsonl"), LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), WAIT);
    // The new folder got a new watcher.
    await vi.waitFor(
      () => expect(spy.opened.filter((dir) => dir === targets.subagentsDir).length).toBe(2),
      WAIT,
    );
    await sleep(150);
    const before = changes.length;
    await appendFile(join(targets.subagentsDir, "agent-b1.jsonl"), LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(before + 1), WAIT);
  });

  it("reports registry changes separately and leaves the registry out when asked", async () => {
    const { changes } = record();
    await writeFile(join(targets.registryDir as string, "4242.json"), "{}");
    await vi.waitFor(() => expect(changes).toEqual([{ files: false, registry: true }]), WAIT);
    await writeFile(join(targets.registryDir as string, "readme.txt"), "synthetic");
    await sleep(200);
    expect(changes).toHaveLength(1);

    const without = record(STEADY, { ...targets, registryDir: null });
    await writeFile(join(targets.registryDir as string, "4243.json"), "{}");
    await sleep(250);
    expect(without.changes).toEqual([]);
  });

  it("works when the session folder does not exist at all and the project folder appears later", async () => {
    const projectDir = join(caseDir, "projects", "-srv-later-project");
    const later: SessionWatchTargets = {
      transcript: join(projectDir, `${SESSION}.jsonl`),
      sessionDir: join(projectDir, SESSION),
      subagentsDir: join(projectDir, SESSION, "subagents"),
      registryDir: null,
    };
    // No folder to watch: the watch polls until one appears. No backstop, so this is the poll.
    const { changes } = record(FAST, later);
    await mkdir(projectDir, { recursive: true });
    await writeFile(later.transcript, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), WAIT);
  });
});

describe("watchSessionFiles settle check", { timeout: 20_000 }, () => {
  /** A watcher that never reports an event, like an `fs.watch` that is not armed yet. */
  function silentOpener(): { opener: DirectoryWatchOpener; opened: string[] } {
    const opened: string[] = [];
    return {
      opened,
      opener: (dir) => {
        opened.push(dir);
        return { close: () => undefined };
      },
    };
  }

  it("checks once settleMs after the watchers open, catching a change made before events start", async () => {
    const silent = silentOpener();
    const { changes } = record({
      ...FAST,
      mode: "events",
      settleMs: 60,
      openWatcher: silent.opener,
    });
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes).toEqual([{ files: true, registry: false }]), WAIT);
    // Only one settle check: a later change waits for an event.
    await appendFile(targets.transcript, LINE(3));
    await sleep(250);
    expect(changes).toHaveLength(1);
  });

  it("checks again settleMs after a folder that appeared later gets its watcher", async () => {
    const events = new Map<string, (name: string | null) => void>();
    const opened: string[] = [];
    const opener: DirectoryWatchOpener = (dir, onEvent) => {
      opened.push(dir);
      events.set(dir, onEvent);
      return { close: () => undefined };
    };
    const { changes } = record({ ...FAST, mode: "events", settleMs: 400, openWatcher: opener });
    await sleep(500); // the start's settle check has run and found nothing
    expect(changes).toEqual([]);

    await mkdir(targets.subagentsDir, { recursive: true });
    events.get(dirname(targets.transcript))?.(SESSION);
    await vi.waitFor(() => expect(opened).toContain(targets.subagentsDir), {
      ...WAIT,
      interval: 5,
    });
    await sleep(40); // let the check that opened it finish its second look
    // Written after the new watcher opened; the fake never reports it, the settle check does.
    await writeFile(join(targets.subagentsDir, "agent-s1.jsonl"), LINE(1));
    await vi.waitFor(() => expect(changes).toEqual([{ files: true, registry: false }]), WAIT);
  });

  it("is off with settleMs 0 and never runs in poll mode", async () => {
    const silent = silentOpener();
    const off = record({ ...FAST, mode: "events", settleMs: 0, openWatcher: silent.opener });
    await appendFile(targets.transcript, LINE(2));
    await sleep(250);
    expect(off.changes).toEqual([]);
    off.stop();

    // Poll mode opens no watcher, so its only checks are the polls.
    const opener = vi.fn<DirectoryWatchOpener>();
    const polled = record({
      mode: "poll",
      pollIntervalMs: 5000,
      settleMs: 20,
      openWatcher: opener,
    });
    await appendFile(targets.transcript, LINE(3));
    await sleep(200);
    expect(polled.changes).toEqual([]);
    expect(opener).not.toHaveBeenCalled();
  });
});

describe("watchSessionFiles fallbacks", { timeout: 20_000 }, () => {
  it("polls without opening a watcher in poll mode", async () => {
    const opener = vi.fn<DirectoryWatchOpener>();
    const { changes } = record({ ...FAST, mode: "poll", openWatcher: opener });
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await sleep(150);
    expect(changes).toHaveLength(1);
    expect(opener).not.toHaveBeenCalled();
  });

  it("falls back to polling when fs.watch throws", async () => {
    const opener = vi.fn<DirectoryWatchOpener>(() => {
      throw Object.assign(new Error("synthetic watch limit"), { code: "ENOSPC" });
    });
    const { changes } = record({ ...FAST, openWatcher: opener });
    expect(opener).toHaveBeenCalled();
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
  });

  it("falls back to polling when a watcher reports an error, then opens a new one", async () => {
    const errors: (() => void)[] = [];
    const closed: string[] = [];
    const opener = vi.fn<DirectoryWatchOpener>((dir, _onEvent, onError) => {
      errors.push(onError);
      return { close: () => closed.push(dir) };
    });
    // No settle check: these watchers never report anything, so only the error path can.
    const { changes } = record({ ...FAST, mode: "events", settleMs: 0, openWatcher: opener });
    const opened = opener.mock.calls.length;
    expect(opened).toBe(2); // project folder and registry folder; the session folder is missing
    // These watchers never report an event, so in events mode nothing is noticed.
    await appendFile(targets.transcript, LINE(2));
    await sleep(200);
    expect(changes).toEqual([]);
    // One watcher breaks: the watch closes it, polls, and opens a new one on the next check.
    errors[0]?.();
    await vi.waitFor(() => expect(changes).toEqual([{ files: true, registry: false }]), WAIT);
    expect(closed).toHaveLength(1);
    expect(opener.mock.calls.length).toBeGreaterThan(opened);
  });

  it("reopens a child folder's watcher when the folder above names it (same inode reused)", async () => {
    await mkdir(targets.subagentsDir, { recursive: true });
    const opened: string[] = [];
    const closed: string[] = [];
    const events = new Map<string, (name: string | null) => void>();
    const opener: DirectoryWatchOpener = (dir, onEvent) => {
      opened.push(dir);
      events.set(dir, onEvent);
      return { close: () => closed.push(dir) };
    };
    record({ ...FAST, mode: "events", openWatcher: opener });
    expect(opened).toHaveLength(4);
    const projectDir = dirname(targets.transcript);

    // The session folder reports "subagents": only the subagents watcher is reopened.
    events.get(targets.sessionDir)?.("subagents");
    await vi.waitFor(() => expect(closed).toEqual([targets.subagentsDir]), WAIT);
    await vi.waitFor(() => expect(opened.at(-1)).toBe(targets.subagentsDir));

    // The project folder reports the session folder: both of its watchers are reopened.
    events.get(projectDir)?.(SESSION);
    await vi.waitFor(() => expect(closed).toHaveLength(3), WAIT);
    expect(closed.slice(1).sort()).toEqual([targets.sessionDir, targets.subagentsDir].sort());

    // Another session's file in the project folder reopens nothing and is not checked.
    events.get(projectDir)?.("sess-other.jsonl");
    await sleep(100);
    expect(closed).toHaveLength(3);
  });

  it("checks at least every maxWaitMs while events keep coming", async () => {
    const events: ((name: string | null) => void)[] = [];
    const opener: DirectoryWatchOpener = (_dir, onEvent) => {
      events.push(onEvent);
      return { close: () => undefined };
    };
    const { changes } = record({
      ...FAST,
      mode: "events",
      debounceMs: 60,
      maxWaitMs: 150,
      settleMs: 0,
      openWatcher: opener,
    });
    await appendFile(targets.transcript, LINE(2));
    const fire = setInterval(() => events[0]?.(null), 10);
    try {
      await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 1000, interval: 10 });
    } finally {
      clearInterval(fire);
    }
  });

  it("merges a burst of events into one check and one change", async () => {
    const events: ((name: string | null) => void)[] = [];
    const opener: DirectoryWatchOpener = (_dir, onEvent) => {
      events.push(onEvent);
      return { close: () => undefined };
    };
    const { changes } = record({
      ...FAST,
      mode: "events",
      debounceMs: 80,
      maxWaitMs: 5000,
      settleMs: 0,
      openWatcher: opener,
    });
    const transcriptName = `${SESSION}.jsonl`;
    for (let n = 2; n < 12; n += 1) {
      await appendFile(targets.transcript, LINE(n));
      events[0]?.(transcriptName);
    }
    await vi.waitFor(() => expect(changes.length).toBe(1), WAIT);
    await sleep(250);
    expect(changes).toEqual([{ files: true, registry: false }]);
  });

  it("does not stop the watch when the listener throws", async () => {
    const seen: SessionFilesChange[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    // Vitest's own handler would report the rethrown error as a failure; replace it briefly.
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", onRejection);
    try {
      const stop = watchSessionFiles(
        targets,
        (change) => {
          seen.push(change);
          throw new Error("synthetic listener failure");
        },
        STEADY,
      );
      stops.push(stop);
      await appendFile(targets.transcript, LINE(2));
      await vi.waitFor(() => expect(seen.length).toBe(1), WAIT);
      await sleep(150);
      await appendFile(targets.transcript, LINE(3));
      await vi.waitFor(() => expect(seen.length).toBe(2), WAIT);
      await vi.waitFor(() => expect(rejections).toHaveLength(2));
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      for (const listener of saved) process.on("unhandledRejection", listener);
    }
  });
});

describe("stopping a watch", { timeout: 20_000 }, () => {
  it("sends nothing after stop, is safe to call twice and releases every handle", async () => {
    await sleep(100);
    const baseline = handleCount();
    const { changes, stop } = record({ ...FAST, mode: "auto", backstopIntervalMs: 50 });
    expect(handleCount()).toBeGreaterThan(baseline); // watchers open synchronously
    await mkdir(targets.subagentsDir, { recursive: true });
    await sleep(150); // the backstop timer runs and the subagents folder gets a watcher
    expect(handleCount()).toBeGreaterThan(baseline);
    stop();
    stop();
    await appendFile(targets.transcript, LINE(2));
    await writeFile(join(targets.subagentsDir, "agent-c1.jsonl"), LINE(1));
    await sleep(300);
    expect(changes).toEqual([]);
    // Closing a folder watcher completes on a later turn of the event loop.
    let left = handleCount();
    for (let tries = 0; tries < 20 && left !== baseline; tries += 1) {
      await sleep(50);
      left = handleCount();
    }
    expect(left).toBe(baseline);
  });

  it("stops in the middle of a debounce and of a check without a late change", async () => {
    const { changes, stop } = record({ ...FAST, debounceMs: 100 });
    await appendFile(targets.transcript, LINE(2));
    await sleep(40);
    stop();
    await sleep(300);
    expect(changes).toEqual([]);
  });

  it.skipIf(!existsSync(DIST_ENTRY))(
    "lets a process exit on its own after stop (built package)",
    { timeout: 15_000 },
    async () => {
      const script = `
      import { appendFileSync } from "node:fs";
      const { watchSessionFiles } = await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});
      const targets = JSON.parse(process.argv[1]);
      const stop = watchSessionFiles(targets, () => {
        stop();
        process.stdout.write("changed");
      }, { debounceMs: 10, pollIntervalMs: 20 });
      setTimeout(() => appendFileSync(targets.transcript, "{}\\n"), 50);
    `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, JSON.stringify(targets)],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      const code = await new Promise<number | null>((done, fail) => {
        const timer = setTimeout(() => {
          child.kill();
          fail(new Error("the child process did not exit on its own"));
        }, 8000);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          done(exitCode);
        });
      });
      expect(code).toBe(0);
      expect(out).toBe("changed");
    },
  );
});

describe("openNodeDirectoryWatcher", { timeout: 20_000 }, () => {
  it("reports entries that change in a folder and closes", async () => {
    const dir = join(caseDir, "plain");
    await mkdir(dir);
    const names: (string | null)[] = [];
    const watcher = openNodeDirectoryWatcher(
      dir,
      (name) => names.push(name),
      () => undefined,
    );
    try {
      // The platform may start reporting only after the watcher is armed; write until one is seen.
      let n = 0;
      await retryUntil(
        () => writeFile(join(dir, "example.jsonl"), LINE((n += 1))),
        () => names.includes("example.jsonl"),
      );
      expect(names).toContain("example.jsonl");
    } finally {
      watcher.close();
    }
  });

  it("throws for a folder that does not exist", () => {
    expect(() =>
      openNodeDirectoryWatcher(
        join(caseDir, "missing"),
        () => undefined,
        () => undefined,
      ),
    ).toThrow();
  });
});
