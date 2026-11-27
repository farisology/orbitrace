// The parts of the history API a host needs (#188, #189, #195): the worker's package export, the
// shared subagent layout, the ended-session option, the SQLite warning helper, and the test hooks
// kept off the public options. Hand-written sessions with invented values in temporary folders.
// The suites that need node:sqlite are skipped, with the reason in their name, without it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SessionRef } from "../../src/index.js";
import { isSqliteExperimentalWarning, withoutSqliteWarning } from "../../src/history/quiet.js";
import * as nodeEntry from "../../src/sources/node.js";
import {
  claudeCodeSubagentFileName,
  claudeCodeSubagentId,
  claudeCodeSubagentMetaName,
  claudeCodeSubagentsDir,
  CLAUDE_CODE_SUBAGENTS_FOLDER,
  checkHistoryLocation,
  HISTORY_WORKER_EXPORT,
  prepareHistoryDir,
  resolveHistoryLocation,
  ingestHistory,
  openHistoryStore,
  runHistoryIngestWorker,
  type HistoryIngestOptions,
  type HistoryWorkerOptions,
} from "../../src/sources/node.js";
import {
  DIST_WORKER,
  PACKAGE_DIR,
  requireDist,
  sandboxSessions,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  useSandbox,
  WINDOWS_NO_MODES,
  type Sandbox,
} from "./helpers.js";

const sandbox = useSandbox();

const SESSION_ID = "00000000-0000-4000-8000-0000000e0d0d";
const PROJECT = "-srv-example-ended";

/** An invented conversation line. */
function line(n: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 9, 0, n)).toISOString(),
    sessionId: SESSION_ID,
    message: { role: "user", content: `invented prompt number ${n}` },
  });
}

/** A session whose main transcript and one subagent transcript both end without a newline. */
async function writeUnfinishedSession(box: Sandbox): Promise<{ main: string; sub: string }> {
  const projectDir = join(box.config, "projects", PROJECT);
  const subDir = join(projectDir, SESSION_ID, "subagents");
  await mkdir(subDir, { recursive: true });
  const main = join(projectDir, `${SESSION_ID}.jsonl`);
  const sub = join(subDir, "agent-a1.jsonl");
  await writeFile(main, `${line(1)}\n${line(2)}\n${line(3)}`);
  await writeFile(sub, `${line(11)}\n${line(12)}`);
  await writeFile(join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "example" }));
  return { main, sub };
}

async function onlySession(box: Sandbox): Promise<SessionRef> {
  const [ref] = await sandboxSessions(box);
  if (ref === undefined) throw new Error("no session found");
  return ref;
}

describe("the worker's package export (#188)", () => {
  it("names @orbitrace/core/history-worker, which points at the built worker entry", () => {
    expect(HISTORY_WORKER_EXPORT).toBe("@orbitrace/core/history-worker");
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./history-worker"]).toBe("./dist/history/worker.js");
    requireDist();
    expect(existsSync(DIST_WORKER)).toBe(true);
  });

  it("resolves through the package exports, as a bundler resolves it", () => {
    requireDist();
    // A package may name itself through its own exports, so this resolves from inside it.
    const resolve = createRequire(join(PACKAGE_DIR, "package.json")).resolve;
    expect(resolve(HISTORY_WORKER_EXPORT)).toBe(DIST_WORKER);
  });
});

describe("the subagent file layout (#189)", () => {
  it("is shared from the adapter: folder, transcript name, agent id and meta name", () => {
    const locator = join("/srv", "config", "projects", PROJECT, `${SESSION_ID}.jsonl`);
    expect(claudeCodeSubagentsDir(locator, SESSION_ID)).toBe(
      join("/srv", "config", "projects", PROJECT, SESSION_ID, CLAUDE_CODE_SUBAGENTS_FOLDER),
    );
    // The same layout under each OS's rules, whatever this host is. The second Windows root is
    // what join("/srv", ...) gives on Windows: rooted on the current drive, no drive letter (#210).
    for (const [p, root] of [
      [posix, "/srv/config"],
      [win32, "D:\\Profiles\\example\\.claude"],
      [win32, "\\srv\\config"],
      [win32, "\\\\server\\share\\config"],
    ] as const) {
      const projectDir = p.join(root, "projects", PROJECT);
      expect(claudeCodeSubagentsDir(p.join(projectDir, `${SESSION_ID}.jsonl`), SESSION_ID)).toBe(
        p.join(projectDir, SESSION_ID, CLAUDE_CODE_SUBAGENTS_FOLDER),
      );
    }
    expect(CLAUDE_CODE_SUBAGENTS_FOLDER).toBe("subagents");
    expect(claudeCodeSubagentFileName("a1")).toBe("agent-a1.jsonl");
    expect(claudeCodeSubagentMetaName("a1")).toBe("agent-a1.meta.json");
    expect(claudeCodeSubagentId("agent-a1.jsonl")).toBe("a1");
    expect(claudeCodeSubagentId(claudeCodeSubagentFileName("x-y.z"))).toBe("x-y.z");
    for (const name of ["agent-a1.meta.json", "agent-.jsonl", "notes.jsonl", "agent-a1.json"]) {
      expect(claudeCodeSubagentId(name)).toBeNull();
    }
  });

  it("is no longer written out in history/ingest.ts or history/store.ts", () => {
    for (const file of ["ingest.ts", "store.ts"]) {
      const text = readFileSync(join(PACKAGE_DIR, "src", "history", file), "utf8");
      expect(text).not.toMatch(/agent-\(\.\+\)/);
      expect(text).not.toContain("meta.json`");
      expect(text).not.toMatch(/sessionId, "subagents"/);
    }
  });
});

describe("the test hooks (#189)", () => {
  it("are not part of the public options and not exported from ./node", () => {
    expectTypeOf<HistoryIngestOptions>().not.toHaveProperty("testHooks");
    expectTypeOf<HistoryWorkerOptions>().not.toHaveProperty("testHooks");
    expect("ingestHistoryWithTestHooks" in nodeEntry).toBe(false);
    expect("runHistoryIngestWorkerWithTestHooks" in nodeEntry).toBe(false);
  });
});

describe("withoutSqliteWarning", () => {
  it("holds back the SQLite experimental warning only, and restores emitWarning", async () => {
    const original = process.emitWarning;
    const seen: unknown[] = [];
    const listener = (warning: Error): void => {
      seen.push(warning.message);
    };
    process.on("warning", listener);
    try {
      const value = await withoutSqliteWarning(async () => {
        process.emitWarning(
          "SQLite is an experimental feature and might change at any time",
          "ExperimentalWarning",
        );
        process.emitWarning("An invented warning that must pass", "ExampleWarning");
        return 42;
      });
      expect(value).toBe(42);
      expect(process.emitWarning).toBe(original);
      await new Promise((done) => setImmediate(done));
      expect(seen).toEqual(["An invented warning that must pass"]);
      await expect(
        withoutSqliteWarning(() => Promise.reject(new Error("invented failure"))),
      ).rejects.toThrow("invented failure");
      expect(process.emitWarning).toBe(original);
    } finally {
      process.off("warning", listener);
    }
  });

  it("recognises the warning by its text and type, in either form Node passes them", () => {
    const text = "SQLite is an experimental feature and might change at any time";
    expect(isSqliteExperimentalWarning(text, ["ExperimentalWarning"])).toBe(true);
    expect(isSqliteExperimentalWarning(text, [{ type: "ExperimentalWarning" }])).toBe(true);
    const error = Object.assign(new Error(text), { name: "ExperimentalWarning" });
    expect(isSqliteExperimentalWarning(error, [])).toBe(true);
    expect(isSqliteExperimentalWarning("Something else is experimental", ["Experimental"])).toBe(
      false,
    );
    expect(isSqliteExperimentalWarning("sqlite note", ["DeprecationWarning"])).toBe(false);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`ended sessions (#195)${SKIP_NOTE}`, () => {
  it("leaves a last line without a newline for later while the session may still be written", async () => {
    const box = sandbox();
    await writeUnfinishedSession(box);
    const ref = await onlySession(box);
    const store = await openHistoryStore({ mode: "write" });
    try {
      const result = await ingestHistory(store, { sessions: [ref] });
      expect(result.linesAdded).toBe(3);
      const stored = store.readSession(ref.key);
      expect(stored?.main).toHaveLength(2);
      expect(stored?.subagents[0]?.lines).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("takes that line once when the host says the session has ended", async () => {
    const box = sandbox();
    const { main } = await writeUnfinishedSession(box);
    const ref = await onlySession(box);
    const store = await openHistoryStore({ mode: "write" });
    try {
      await ingestHistory(store, { sessions: [ref] });
      const ended = await ingestHistory(store, { sessions: [ref], endedSessionKeys: [ref.key] });
      expect(ended.linesAdded).toBe(2);
      const again = await ingestHistory(store, { sessions: [ref], endedSessionKeys: [ref.key] });
      expect(again.linesAdded).toBe(0);
      expect(again.linesRead).toBe(0);
      const stored = store.readSession(ref.key);
      expect(stored?.main.map((text) => (JSON.parse(text) as { uuid: string }).uuid)).toEqual([
        JSON.parse(line(1)).uuid,
        JSON.parse(line(2)).uuid,
        JSON.parse(line(3)).uuid,
      ]);
      expect(stored?.subagents[0]?.lines).toHaveLength(2);

      // If the newline arrives after all, followed by more lines, nothing is stored twice.
      await appendFile(main, `\n${line(4)}\n`);
      const later = await ingestHistory(store, { sessions: [ref] });
      expect(later.linesAdded).toBe(1);
      expect(store.readSession(ref.key)?.main).toHaveLength(4);
      expect(later.filesReset).toBe(0);
    } finally {
      store.close();
    }
  });

  it("applies only to the sessions named", async () => {
    const box = sandbox();
    await writeUnfinishedSession(box);
    const ref = await onlySession(box);
    const store = await openHistoryStore({ mode: "write" });
    try {
      const result = await ingestHistory(store, {
        sessions: [ref],
        endedSessionKeys: ["claude-code:not-this-one"],
      });
      expect(result.linesAdded).toBe(3);
    } finally {
      store.close();
    }
  });

  it("passes through the worker", async () => {
    requireDist();
    const box = sandbox();
    await writeUnfinishedSession(box);
    const ref = await onlySession(box);
    const result = await runHistoryIngestWorker(
      { sessions: [ref], endedSessionKeys: [ref.key] },
      { workerUrl: pathToFileURL(DIST_WORKER) },
    );
    expect(result.linesAdded).toBe(5);
  }, 30_000);
});

describe("the location helpers a host needs (#195)", () => {
  it("are exported from ./node: check a folder, then create it", async () => {
    const box = sandbox();
    const location = resolveHistoryLocation();
    expect(location.dir).toBe(box.data);
    expect(() => checkHistoryLocation(location)).not.toThrow();
    expect(existsSync(box.data)).toBe(false);
    prepareHistoryDir(location);
    expect(existsSync(box.data)).toBe(true);
    const inside = { ...location, dir: join(box.config, "history") };
    expect(() => checkHistoryLocation(inside)).toThrow(
      expect.objectContaining({ code: "unsafe-location" }),
    );
    await mkdir(join(box.base, "repo", ".git"), { recursive: true });
    expect(() =>
      checkHistoryLocation({ ...location, dir: join(box.base, "repo", "data") }),
    ).toThrow(expect.objectContaining({ code: "unsafe-location" }));
  });

  it.skipIf(process.platform === "win32")(
    `create the folder owner-only (0700)${WINDOWS_NO_MODES}`,
    () => {
      const box = sandbox();
      prepareHistoryDir(resolveHistoryLocation());
      expect(statSync(box.data).mode & 0o777).toBe(0o700);
    },
  );
});
