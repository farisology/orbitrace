/**
 * The history store in a real extension host (ticket #196). The extension does not call the
 * history store yet, so these steps load it from `@orbitrace/core/node` on the suite's side and
 * drive it the way a host will: check `historyCapability()`, run the ingest worker
 * (`runHistoryIngestWorker`, a `worker_threads` worker) over the sandbox's synthetic sessions,
 * check the totals, run it again, read the totals back and delete the store.
 *
 * Where `node:sqlite` is missing (VS Code before 1.101, measured in
 * docs/decisions/0001-storage.md), the capability step checks the unavailable path instead (a
 * reason, `unavailable` from the store and from the worker, nothing written) and the store steps
 * are skipped with the capability's reason.
 *
 * Before anything runs, the launcher has pointed `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and
 * `ORBITRACE_DATA_DIR` into the sandbox (`editorEnvironment` in sandbox.ts); the first step
 * checks that and refuses to go on otherwise.
 *
 * No vscode dependency, so the same steps also run in plain Node (`history-steps.test.ts`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceRoot } from "@orbitrace/core";
import {
  deleteHistoryStore,
  historyCapability,
  HISTORY_DATA_DIR_ENV,
  HISTORY_DEFAULT_FOLDER,
  HISTORY_LOCK_FILE,
  openHistoryStore,
  resolveHistoryLocation,
  runHistoryIngestWorker,
  type HistoryCapability,
  type HistoryIngestProgress,
  type HistoryIngestResult,
} from "@orbitrace/core/node";
import type { SandboxDescription } from "./sandbox-description.js";
import type { Step } from "./steps.js";

/** The transcript files and lines under a config folder, counted directly from the files. */
export interface TranscriptTotals {
  /** `.jsonl` files under `projects/`: main transcripts and subagent transcripts. */
  readonly files: number;
  /** Complete (ending in a newline), non-blank lines in those files. */
  readonly lines: number;
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

/**
 * Count the transcript files and their complete, non-blank lines under `configDir/projects`, the
 * way the ingest counts them: a last line without its newline is not counted.
 */
export function countTranscripts(configDir: string): TranscriptTotals {
  const files = jsonlFiles(join(configDir, "projects"));
  let lines = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    lines += complete.split("\n").filter((line) => line.trim() !== "").length;
  }
  return { files: files.length, lines };
}

/**
 * The worker entry of the history ingest: `dist/history/worker.js` of `@orbitrace/core`, found
 * next to the package's Node entry as resolved from `packageDir` (this extension package).
 * Throws when the file is not there (core not built).
 *
 * Core does not export the worker file yet; #188 changes how it is shipped. Until then this is
 * the file `runHistoryIngestWorker` documents as its `workerUrl`.
 */
export function coreWorkerPath(packageDir: string): string {
  const nodeEntry = createRequire(join(packageDir, "package.json")).resolve("@orbitrace/core/node");
  const worker = join(dirname(nodeEntry), "..", "history", "worker.js");
  if (!existsSync(worker)) {
    throw new Error(
      "the history worker of @orbitrace/core is not built: run 'npm run build' at the repository root",
    );
  }
  return worker;
}

/** What the history steps need. */
export interface HistoryStepsOptions {
  readonly sandbox: SandboxDescription;
  /** This extension package's folder, from which `@orbitrace/core` is resolved. */
  readonly packageDir: string;
  /** Writes one report line. */
  readonly log: (line: string) => void;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** The error code of a rejected history call, or a failure when it resolved. */
async function rejectionCode(promise: Promise<unknown>, what: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  throw new Error(`${what}: expected it to fail, it succeeded`);
}

/** The longest gap between ticks of a short interval timer while `work` runs, in ms. */
async function longestTimerGap<T>(work: () => Promise<T>): Promise<{ value: T; gapMs: number }> {
  let last = Date.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 5);
  try {
    const value = await work();
    gapMs = Math.max(gapMs, Date.now() - last);
    return { value, gapMs };
  } finally {
    clearInterval(timer);
  }
}

/** Plain text of a capability for the log. Versions only, no path. */
export function describeCapability(capability: HistoryCapability): string {
  return capability.available
    ? `available: node:sqlite in Node ${capability.nodeVersion}, SQLite ${capability.sqliteVersion}, FTS5 ${capability.fts5 ? "yes" : "no"}`
    : `unavailable in Node ${capability.nodeVersion}: ${capability.reason}`;
}

/**
 * The steps, in order. They share one state: the capability found by the second step decides
 * whether the store steps run or are skipped with its reason.
 */
export function buildHistorySteps(options: HistoryStepsOptions): Step[] {
  const { sandbox, packageDir, log } = options;
  const root: SourceRoot = {
    runtime: "claude-code",
    root: sandbox.configDir,
    resolvedBy: "user-setting",
    available: true,
  };
  const sessionCount = sandbox.otherSessions.length + 1;
  let capability: HistoryCapability | null = null;
  let workerUrl: URL | null = null;
  let first: HistoryIngestResult | null = null;
  let expected: TranscriptTotals | null = null;

  const unavailable = (): string | undefined => {
    if (capability === null) return "the capability was not checked";
    return capability.available ? undefined : capability.reason;
  };
  const urlOf = (): URL => {
    workerUrl ??= pathToFileURL(coreWorkerPath(packageDir));
    return workerUrl;
  };

  return [
    {
      name: "history: HOME, CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR point into the sandbox",
      run() {
        assertEqual(process.env["CLAUDE_CONFIG_DIR"], sandbox.configDir, "CLAUDE_CONFIG_DIR");
        assertEqual(
          process.env[HISTORY_DATA_DIR_ENV],
          sandbox.historyDataDir,
          "ORBITRACE_DATA_DIR",
        );
        assertEqual(homedir(), sandbox.homeDir, "home folder");
        assertEqual(resolveHistoryLocation().dir, sandbox.historyDataDir, "history folder");
        assert(!existsSync(sandbox.historyDataDir), "the history folder exists before any step");
      },
    },
    {
      name: "history: historyCapability() reports what this host's Node can do",
      async run() {
        capability = await historyCapability();
        log(`            history ${describeCapability(capability)}`);
        assertEqual(capability.engine, "node:sqlite", "engine");
        assertEqual(capability.nodeVersion, process.version, "Node version");
        if (capability.available) {
          assert(/^3\.\d+\.\d+$/.test(capability.sqliteVersion), "SQLite version");
          return;
        }
        // The unavailable path: a reason without a path, and no store from either entry.
        assert(/node:sqlite/.test(capability.reason), "the reason does not name node:sqlite");
        assert(!capability.reason.includes(sandbox.root), "the reason holds a sandbox path");
        assertEqual(
          await rejectionCode(openHistoryStore({ mode: "write" }), "openHistoryStore"),
          "unavailable",
          "openHistoryStore error code",
        );
        assertEqual(
          await rejectionCode(
            runHistoryIngestWorker({ roots: [root] }, { workerUrl: urlOf() }),
            "runHistoryIngestWorker",
          ),
          "unavailable",
          "worker error code",
        );
        assert(!existsSync(sandbox.historyDataDir), "the unavailable path created the folder");
      },
    },
    {
      name: "history: the ingest worker stores every synthetic session, off the host thread",
      skip: unavailable,
      timeoutMs: 60_000,
      async run() {
        expected = countTranscripts(sandbox.configDir);
        assert(expected.lines > 0, "the sandbox has no transcript lines");
        const progress: HistoryIngestProgress[] = [];
        const started = Date.now();
        const { value: result, gapMs } = await longestTimerGap(() =>
          runHistoryIngestWorker(
            { roots: [root] },
            { workerUrl: urlOf(), onProgress: (p) => progress.push(p) },
          ),
        );
        first = result;
        assertEqual(result.sessions, sessionCount, "sessions read");
        assertEqual(result.files, expected.files, "files read");
        assertEqual(result.linesRead, expected.lines, "lines read");
        assertEqual(result.linesAdded, expected.lines, "lines added");
        assertEqual(result.linesSkipped, 0, "lines skipped");
        assertEqual(
          progress.map((p) => p.sessionsDone).join(","),
          Array.from({ length: sessionCount }, (_, i) => i + 1).join(","),
          "progress after each session",
        );
        assertEqual(progress.at(-1)?.linesAdded, expected.lines, "lines in the last progress");
        assert(
          !existsSync(join(sandbox.historyDataDir, HISTORY_LOCK_FILE)),
          "the worker left its lock behind",
        );
        log(
          `            ${result.sessions} sessions, ${result.files} files, ${result.linesAdded} lines in ${Date.now() - started} ms (worker ${result.durationMs} ms); longest host timer gap ${gapMs} ms`,
        );
      },
    },
    {
      name: "history: a second run of the worker adds nothing",
      skip: unavailable,
      timeoutMs: 60_000,
      async run() {
        assert(first !== null, "the first run did not finish");
        const second = await runHistoryIngestWorker({ roots: [root] }, { workerUrl: urlOf() });
        assertEqual(second.sessions, sessionCount, "sessions read");
        assertEqual(second.linesRead, 0, "lines read");
        assertEqual(second.linesAdded, 0, "lines added");
        assertEqual(second.filesReset, 0, "files read again from the start");
      },
    },
    {
      name: "history: a reader sees the totals of the transcripts",
      skip: unavailable,
      async run() {
        assert(expected !== null && first !== null, "the first run did not finish");
        const reader = await openHistoryStore({ mode: "read" });
        try {
          const totals = reader.totals();
          assertEqual(totals.sessions, sessionCount, "stored sessions");
          assertEqual(totals.files, expected.files, "stored files");
          assertEqual(totals.lines, expected.lines, "stored lines");
          assertEqual(reader.listSessions().length, sessionCount, "listed sessions");
        } finally {
          reader.close();
        }
      },
    },
    {
      name: "history: deleting the store removes its folder and leaves nothing elsewhere",
      skip: unavailable,
      async run() {
        assertEqual(await deleteHistoryStore(), true, "a store was deleted");
        assert(!existsSync(sandbox.historyDataDir), "the history folder is still there");
        assert(
          !existsSync(join(sandbox.homeDir, HISTORY_DEFAULT_FOLDER)),
          "a store was written to the home folder",
        );
        assertEqual(await deleteHistoryStore(), false, "a second delete");
      },
    },
  ];
}
