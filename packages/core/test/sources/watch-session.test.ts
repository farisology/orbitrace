// The Claude Code adapter's watchSession (ticket #74), on a temporary copy of a synthetic fixture
// session from the repository's `fixtures/config` tree, with lines appended and subagent files
// added while it is watched. Registry entries, process ids and the extra session id are invented.
// Nothing reads the real home or config folder.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRef, SourceRoot } from "../../src/index.js";
import {
  createClaudeCodeAdapter,
  createSessionReplayer,
  type SessionFilesChange,
  type SessionFilesWatcher,
  type SessionReplayUpdate,
  type SessionWatchOptions,
  type SessionWatchTargets,
} from "../../src/sources/node.js";
import { createMemFs } from "./helpers/mem-fs.js";

const FIXTURE_PROJECT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/config/projects/-workspace-compass-foundry",
);
const PROJECT_FOLDER = "-srv-example-project";
const LIVE_PID = 4242;
/**
 * These tests check what the adapter reports (fresh refs, live status, subagents), not how fast
 * `fs.watch` is. `fs.watch` can be slow or drop an event on a loaded machine (macOS FSEvents
 * especially), so a short backstop keeps them from depending on it. The backstop only reports
 * differences, so the call counts stay exact. The event path itself is tested in
 * watch-files.test.ts.
 */
const FAST: SessionWatchOptions = { debounceMs: 20, pollIntervalMs: 40, backstopIntervalMs: 100 };

/** Generous: a loaded CI machine or a full `npm test` run can delay timers and events. */
const WAIT = { timeout: 5000 } as const;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let base: string;
let caseNumber = 0;
let config: string;
let root: SourceRoot;
let sessionId: string;
let mainLines: string[];
let subagentFiles: { name: string; text: string }[];
let transcript: string;
const stops: (() => void)[] = [];

/** Write the live registry entry of the watched session. */
async function setRegistry(status: "busy" | "idle", id = sessionId, pid = LIVE_PID): Promise<void> {
  await writeFile(
    join(config, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, status, updatedAt: 1_000 }),
  );
}

/** Copy the fixture's subagent transcripts and meta files into the watched session. */
async function addSubagents(): Promise<void> {
  const dir = join(dirname(transcript), sessionId, "subagents");
  await mkdir(dir, { recursive: true });
  for (const file of subagentFiles) await writeFile(join(dir, file.name), file.text);
}

const adapterFor = (watch: SessionWatchOptions = FAST) =>
  createClaudeCodeAdapter({ isProcessAlive: (pid) => pid === LIVE_PID, watch });

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "orbitrace-watch-session-"));
  const entries = await readdir(FIXTURE_PROJECT);
  const main = entries.find((name) => name.endsWith(".jsonl"));
  if (main === undefined) throw new Error("fixture session missing");
  sessionId = main.slice(0, -".jsonl".length);
  mainLines = (await readFile(join(FIXTURE_PROJECT, main), "utf8")).split("\n").filter(Boolean);
  const subDir = join(FIXTURE_PROJECT, sessionId, "subagents");
  subagentFiles = [];
  for (const name of (await readdir(subDir)).sort()) {
    subagentFiles.push({ name, text: await readFile(join(subDir, name), "utf8") });
  }
  if (mainLines.length <= 6 || subagentFiles.filter((f) => f.name.endsWith(".jsonl")).length < 2) {
    throw new Error("the fixture session is smaller than these tests expect");
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  caseNumber += 1;
  config = join(base, `config-${caseNumber}`);
  root = { runtime: "claude-code", root: config, resolvedBy: "user-setting", available: true };
  transcript = join(config, "projects", PROJECT_FOLDER, `${sessionId}.jsonl`);
  await mkdir(dirname(transcript), { recursive: true });
  await mkdir(join(config, "sessions"), { recursive: true });
  // The session so far: the first lines of the main transcript, no subagent folder yet.
  await writeFile(transcript, mainLines.slice(0, 4).join("\n") + "\n");
  await setRegistry("busy");
  await sleep(30);
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("Claude Code watchSession on real files", { timeout: 30_000 }, () => {
  it("reports appended lines, late subagents and live status changes with a fresh ref", async () => {
    const adapter = adapterFor();
    const [ref] = await adapter.listSessions(root);
    expect(ref).toMatchObject({ live: "busy", subagentCount: 0 });
    const seen: SessionRef[] = [];
    const stop = adapter.watchSession!(ref!, (changed) => seen.push(changed));
    stops.push(stop);

    // Appended lines: one call, same session, fresh fields.
    await appendFile(transcript, mainLines.slice(4).join("\n") + "\n");
    await vi.waitFor(() => expect(seen).toHaveLength(1), WAIT);
    await sleep(150);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      key: ref!.key,
      locator: ref!.locator,
      sessionId,
      projectLabel: ref!.projectLabel,
      source: root,
      live: "busy",
      subagentCount: 0,
    });
    expect(seen[0]!.lastActivity).toBeGreaterThanOrEqual(ref!.lastActivity);

    // The subagent folder did not exist when the watch started.
    await addSubagents();
    const transcripts = subagentFiles.filter((f) => f.name.endsWith(".jsonl")).length;
    await vi.waitFor(() => expect(seen.at(-1)?.subagentCount).toBe(transcripts), WAIT);

    // A registry change for this session that changes its live status.
    await sleep(150);
    const beforeIdle = seen.length;
    await setRegistry("idle");
    await vi.waitFor(() => expect(seen.length).toBe(beforeIdle + 1), WAIT);
    expect(seen.at(-1)?.live).toBe("idle");

    // A registry change that leaves this session's status alone is not reported.
    await setRegistry("busy", "sess-other-0001", LIVE_PID + 1);
    await sleep(250);
    expect(seen.length).toBe(beforeIdle + 1);

    // The process ends without a new line: its registry entry goes away.
    await rm(join(config, "sessions", `${LIVE_PID}.json`));
    await vi.waitFor(() => expect(seen.at(-1)?.live).toBe("ended"), WAIT);

    // Stopped: no more calls, and stopping again is safe.
    stop();
    stop();
    const atStop = seen.length;
    await appendFile(transcript, mainLines[0] + "\n");
    await addSubagents();
    await sleep(300);
    expect(seen.length).toBe(atStop);
  });

  it("feeds follow: each change rebuilds the replay with stable agent ids, and no `ended`", async () => {
    const adapter = adapterFor();
    const replayer = createSessionReplayer({ adapters: [adapter], roots: [root] });
    const [summary] = await replayer.list();
    const updates: SessionReplayUpdate[] = [];
    const stop = replayer.follow(summary!.key, (update) => updates.push(update));
    stops.push(stop);

    await vi.waitFor(() => expect(updates).toHaveLength(1), WAIT);
    const first = updates[0]!;
    if (first.type !== "replay") throw new Error(`expected a replay, got ${first.type}`);
    expect(first.live).toBe("busy");

    await appendFile(transcript, mainLines.slice(4).join("\n") + "\n");
    await addSubagents();
    await vi.waitFor(
      () => {
        const last = updates.at(-1);
        const agents = last?.type === "replay" ? last.replay.agents.length : -1;
        expect(agents).toBeGreaterThan(first.replay.agents.length);
      },
      { timeout: 10_000 },
    );
    const last = updates.at(-1);
    if (last?.type !== "replay") throw new Error("expected a replay");
    const firstIds = first.replay.agents.map((agent) => agent.id);
    expect(last.replay.agents.map((agent) => agent.id).slice(0, firstIds.length)).toEqual(firstIds);
    expect(updates.every((update) => update.type === "replay")).toBe(true);

    await setRegistry("idle");
    await vi.waitFor(() => {
      const latest = updates.at(-1);
      expect(latest?.type === "replay" && latest.live).toBe("idle");
    }, WAIT);

    stop();
    const atStop = updates.length;
    await appendFile(transcript, mainLines[0] + "\n");
    await sleep(300);
    expect(updates.length).toBe(atStop);
  });

  it("polls when asked to and still reports a fresh ref", async () => {
    const adapter = adapterFor({ ...FAST, mode: "poll" });
    const [ref] = await adapter.listSessions(root);
    const seen: SessionRef[] = [];
    stops.push(adapter.watchSession!(ref!, (changed) => seen.push(changed)));
    await addSubagents();
    await vi.waitFor(() => expect(seen.at(-1)?.subagentCount).toBeGreaterThan(0), WAIT);
  });
});

describe("Claude Code watchSession logic", () => {
  const MEM_ROOT = "/srv/example-config";
  const MEM_PROJECT = `${MEM_ROOT}/projects/-srv-example`;
  const MEM_SESSION = "sess-mem-1";
  const memRoot: SourceRoot = {
    runtime: "claude-code",
    root: MEM_ROOT,
    resolvedBy: "user-setting",
    available: true,
  };

  /** A fake file watcher: records its arguments and lets the test fire changes. */
  function fakeWatcher(): {
    watchFiles: SessionFilesWatcher;
    fire: (change: SessionFilesChange) => void;
    targets: () => SessionWatchTargets | undefined;
    options: () => SessionWatchOptions | undefined;
    stopped: () => number;
  } {
    let onChange: ((change: SessionFilesChange) => void) | undefined;
    let seenTargets: SessionWatchTargets | undefined;
    let seenOptions: SessionWatchOptions | undefined;
    let stops = 0;
    return {
      watchFiles: (watchTargets, listener, options) => {
        seenTargets = watchTargets;
        seenOptions = options;
        onChange = listener;
        return () => {
          stops += 1;
        };
      },
      fire: (change) => onChange?.(change),
      targets: () => seenTargets,
      options: () => seenOptions,
      stopped: () => stops,
    };
  }

  function memTree(status: "busy" | "idle") {
    return createMemFs("posix")
      .file(`${MEM_PROJECT}/${MEM_SESSION}.jsonl`, "{}\n", 5_000)
      .file(
        `${MEM_ROOT}/sessions/77.json`,
        JSON.stringify({ pid: 77, sessionId: MEM_SESSION, status, updatedAt: 1 }),
      );
  }

  it("watches the session's paths with the adapter's options and refreshes the ref", async () => {
    const fake = fakeWatcher();
    const fs = memTree("busy");
    const adapter = createClaudeCodeAdapter({
      fs,
      isProcessAlive: (pid) => pid === 77,
      watch: { mode: "poll", pollIntervalMs: 250 },
      watchFiles: fake.watchFiles,
    });
    const [ref] = await adapter.listSessions(memRoot);
    const seen: SessionRef[] = [];
    const stop = adapter.watchSession!(ref!, (changed) => seen.push(changed));
    expect(fake.targets()).toEqual({
      transcript: `${MEM_PROJECT}/${MEM_SESSION}.jsonl`,
      sessionDir: `${MEM_PROJECT}/${MEM_SESSION}`,
      subagentsDir: `${MEM_PROJECT}/${MEM_SESSION}/subagents`,
      registryDir: `${MEM_ROOT}/sessions`,
    });
    expect(fake.options()).toEqual({ mode: "poll", pollIntervalMs: 250 });

    fs.file(`${MEM_PROJECT}/${MEM_SESSION}/subagents/agent-a1.jsonl`, "{}\n", 9_000);
    fake.fire({ files: true, registry: false });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ ...ref, lastActivity: 9_000, subagentCount: 1, live: "busy" });

    // Registry noise without a status change: no call.
    fake.fire({ files: false, registry: true });
    await sleep(30);
    expect(seen).toHaveLength(1);

    // The status changes: one call with the new status.
    fs.file(
      `${MEM_ROOT}/sessions/77.json`,
      JSON.stringify({ pid: 77, sessionId: MEM_SESSION, status: "idle", updatedAt: 1 }),
    );
    fake.fire({ files: false, registry: true });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.live).toBe("idle");

    stop();
    stop();
    expect(fake.stopped()).toBe(1);
    fake.fire({ files: true, registry: true });
    await sleep(30);
    expect(seen).toHaveLength(2);
  });

  it("merges changes that arrive during a refresh and keeps calls in order", async () => {
    const fake = fakeWatcher();
    const adapter = createClaudeCodeAdapter({
      fs: memTree("busy"),
      isProcessAlive: (pid) => pid === 77,
      watchFiles: fake.watchFiles,
    });
    const [ref] = await adapter.listSessions(memRoot);
    let calls = 0;
    let running = 0;
    let overlapped = false;
    stops.push(
      adapter.watchSession!(ref!, () => {
        running += 1;
        if (running > 1) overlapped = true;
        calls += 1;
        running -= 1;
      }),
    );
    fake.fire({ files: true, registry: false });
    fake.fire({ files: true, registry: false });
    fake.fire({ files: false, registry: true });
    await sleep(50);
    // The first change starts a refresh; the two that arrive while it runs become one more.
    expect(calls).toBe(2);
    expect(overlapped).toBe(false);
  });

  it("makes no call while the main transcript is missing", async () => {
    const fake = fakeWatcher();
    const adapter = createClaudeCodeAdapter({
      fs: createMemFs("posix").dir(MEM_PROJECT),
      watchFiles: fake.watchFiles,
    });
    const ref: SessionRef = {
      key: "claude-code:example",
      runtime: "claude-code",
      source: memRoot,
      projectLabel: "example",
      sessionId: MEM_SESSION,
      lastActivity: 1,
      live: "unknown",
      subagentCount: 0,
      locator: `${MEM_PROJECT}/${MEM_SESSION}.jsonl`,
    };
    const seen: SessionRef[] = [];
    stops.push(adapter.watchSession!(ref, (changed) => seen.push(changed)));
    fake.fire({ files: true, registry: false });
    await sleep(30);
    expect(seen).toEqual([]);
  });
});
