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

/** Fast timings so the tests finish quickly. No backstop, so only events or polling count. */
const FAST: SessionWatchOptions = {
  debounceMs: 20,
  maxWaitMs: 200,
  pollIntervalMs: 40,
  backstopIntervalMs: 0,
};

let base: string;
let caseDir: string;
let caseNumber = 0;
let targets: SessionWatchTargets;
const stops: (() => void)[] = [];

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
  options: SessionWatchOptions = FAST,
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

describe("watchSessionFiles with fs.watch", () => {
  it("reports one change for lines appended to the main transcript", async () => {
    const { changes } = record();
    await sleep(50);
    expect(changes).toEqual([]);
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
    await sleep(250);
    expect(changes).toEqual([{ files: true, registry: false }]);
  });

  it("merges a burst of appends into one change", async () => {
    const { changes } = record({ ...FAST, debounceMs: 80, maxWaitMs: 2000 });
    for (let n = 2; n < 12; n += 1) await appendFile(targets.transcript, LINE(n));
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
    await sleep(250);
    expect(changes).toHaveLength(1);
  });

  it("keeps the backstop poll from reporting a change twice", async () => {
    const { changes } = record({ ...FAST, mode: "auto", backstopIntervalMs: 30 });
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
    await sleep(200);
    expect(changes).toHaveLength(1);
  });

  it("notices a subagent folder that appears after the watch started, and files in it", async () => {
    const { changes } = record();
    const agent = join(targets.subagentsDir, "agent-a1.jsonl");
    await mkdir(targets.subagentsDir, { recursive: true });
    await writeFile(agent, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await sleep(150);
    const afterCreate = changes.length;
    expect(changes.every((c) => c.files && !c.registry)).toBe(true);

    await appendFile(agent, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 1), { timeout: 3000 });

    await writeFile(join(targets.subagentsDir, "agent-a1.meta.json"), "{}");
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 2), { timeout: 3000 });

    await writeFile(join(targets.subagentsDir, "agent-a2.jsonl"), LINE(1));
    await vi.waitFor(() => expect(changes.length).toBe(afterCreate + 3), { timeout: 3000 });
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
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
    await sleep(150);
    const afterReplace = changes.length;
    await appendFile(targets.transcript, LINE(3));
    await vi.waitFor(() => expect(changes.length).toBe(afterReplace + 1), { timeout: 3000 });
  });

  it("reports a deleted transcript and its return", async () => {
    const { changes } = record();
    await rm(targets.transcript);
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
    await writeFile(targets.transcript, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBe(2), { timeout: 3000 });
  });

  it("rewatches a subagents folder that is removed and created again", async () => {
    await mkdir(targets.subagentsDir, { recursive: true });
    const { changes } = record();
    await rm(targets.subagentsDir, { recursive: true });
    await mkdir(targets.subagentsDir, { recursive: true });
    await writeFile(join(targets.subagentsDir, "agent-b1.jsonl"), LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await sleep(150);
    const before = changes.length;
    await appendFile(join(targets.subagentsDir, "agent-b1.jsonl"), LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(before + 1), { timeout: 3000 });
  });

  it("reports registry changes separately and leaves the registry out when asked", async () => {
    const { changes } = record();
    await writeFile(join(targets.registryDir as string, "4242.json"), "{}");
    await vi.waitFor(() => expect(changes).toEqual([{ files: false, registry: true }]), {
      timeout: 3000,
    });
    await writeFile(join(targets.registryDir as string, "readme.txt"), "synthetic");
    await sleep(200);
    expect(changes).toHaveLength(1);

    const without = record(FAST, { ...targets, registryDir: null });
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
    // No folder to watch: the watch polls until one appears.
    const { changes } = record(FAST, later);
    await mkdir(projectDir, { recursive: true });
    await writeFile(later.transcript, LINE(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
  });
});

describe("watchSessionFiles fallbacks", () => {
  it("polls without opening a watcher in poll mode", async () => {
    const opener = vi.fn<DirectoryWatchOpener>();
    const { changes } = record({ ...FAST, mode: "poll", openWatcher: opener });
    await appendFile(targets.transcript, LINE(2));
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
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
    await vi.waitFor(() => expect(changes.length).toBe(1), { timeout: 3000 });
  });

  it("falls back to polling when a watcher reports an error, then opens a new one", async () => {
    const errors: (() => void)[] = [];
    const closed: string[] = [];
    const opener = vi.fn<DirectoryWatchOpener>((dir, _onEvent, onError) => {
      errors.push(onError);
      return { close: () => closed.push(dir) };
    });
    const { changes } = record({ ...FAST, mode: "events", openWatcher: opener });
    const opened = opener.mock.calls.length;
    expect(opened).toBe(2); // project folder and registry folder; the session folder is missing
    // These watchers never report an event, so in events mode nothing is noticed.
    await appendFile(targets.transcript, LINE(2));
    await sleep(200);
    expect(changes).toEqual([]);
    // One watcher breaks: the watch closes it, polls, and opens a new one on the next check.
    errors[0]?.();
    await vi.waitFor(() => expect(changes).toEqual([{ files: true, registry: false }]), {
      timeout: 3000,
    });
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
    await vi.waitFor(() => expect(closed).toEqual([targets.subagentsDir]), { timeout: 3000 });
    await vi.waitFor(() => expect(opened.at(-1)).toBe(targets.subagentsDir));

    // The project folder reports the session folder: both of its watchers are reopened.
    events.get(projectDir)?.(SESSION);
    await vi.waitFor(() => expect(closed).toHaveLength(3), { timeout: 3000 });
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
        FAST,
      );
      stops.push(stop);
      await appendFile(targets.transcript, LINE(2));
      await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 3000 });
      await sleep(150);
      await appendFile(targets.transcript, LINE(3));
      await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 3000 });
      await vi.waitFor(() => expect(rejections).toHaveLength(2));
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      for (const listener of saved) process.on("unhandledRejection", listener);
    }
  });
});

describe("stopping a watch", () => {
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

describe("openNodeDirectoryWatcher", () => {
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
      await writeFile(join(dir, "example.jsonl"), LINE(1));
      await vi.waitFor(() => expect(names).toContain("example.jsonl"), { timeout: 3000 });
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
