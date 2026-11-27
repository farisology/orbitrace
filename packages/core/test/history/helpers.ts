// Shared set-up for the history store tests (#25). Every test points HOME, USERPROFILE,
// CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR at new temporary folders before it calls anything, and
// copies synthetic sessions from the repository's `fixtures/config` tree (the committed output of
// @orbitrace/fixtures, all invented) into the temporary config folder. Nothing reads the real
// home or config folder, and no real ~/.orbitrace is created.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import type { SessionRef, SourceRoot } from "../../src/index.js";
import { loadSqlite } from "../../src/history/engine.js";
import { claudeCodeAdapter } from "../../src/sources/node.js";
import { listSessions } from "../../src/index.js";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "..", "..");
export const FIXTURES_DIR = join(REPO_DIR, "fixtures");
/** The built Node entry. `npm test` at the root builds first. */
export const DIST_NODE_ENTRY = join(PACKAGE_DIR, "dist", "sources", "node.js");
export const DIST_MAIN_ENTRY = join(PACKAGE_DIR, "dist", "index.js");
export const DIST_WORKER = join(PACKAGE_DIR, "dist", "history", "worker.js");
/** The built ingest module, for the internal test hooks (not on the ./node entry). */
export const DIST_INGEST = join(PACKAGE_DIR, "dist", "history", "ingest.js");

/** Whether `node:sqlite` loads in this Node, and why not. Checked once, before any test runs. */
const probe = await loadSqlite();
export const SQLITE_AVAILABLE = probe.capability.available;
/** Appended to the name of a suite that needs node:sqlite: the skip reason, or nothing. */
export const SKIP_NOTE = probe.capability.available ? "" : ` (skipped: ${probe.capability.reason})`;

export interface Sandbox {
  readonly base: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly root: SourceRoot;
}

const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "ORBITRACE_DATA_DIR"] as const;

/**
 * Register hooks that give each test a fresh sandbox, with the environment pointed at it before
 * the test body runs, and restore the environment afterwards. Returns a getter for the sandbox.
 */
export function useSandbox(): () => Sandbox {
  let current: Sandbox | null = null;
  const saved = new Map<string, string | undefined>();
  beforeEach(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    const base = await mkdtemp(join(tmpdir(), "orbitrace-history-"));
    const home = join(base, "home");
    const config = join(base, "config");
    const data = join(base, "data");
    await mkdir(home, { recursive: true });
    await mkdir(join(config, "projects"), { recursive: true });
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    process.env["CLAUDE_CONFIG_DIR"] = config;
    process.env["ORBITRACE_DATA_DIR"] = data;
    current = {
      base,
      home,
      config,
      data,
      root: { runtime: "claude-code", root: config, resolvedBy: "user-setting", available: true },
    };
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (current !== null) await rm(current.base, { recursive: true, force: true });
    current = null;
  });
  return () => {
    if (current === null) throw new Error("sandbox used outside a test");
    return current;
  };
}

interface ManifestSession {
  readonly name: string;
  readonly sessionId: string;
  readonly project: string;
  readonly transcript: string;
}

/** The fixture sessions listed in `fixtures/manifest.json`. */
export function fixtureSessions(): readonly ManifestSession[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
    sessions: ManifestSession[];
  };
  return manifest.sessions;
}

/**
 * Copy one fixture session (main transcript and subagents folder) into the sandbox's config
 * folder. Returns the path of its main transcript.
 */
export async function copyFixtureSession(sandbox: Sandbox, name: string): Promise<string> {
  const session = fixtureSessions().find((entry) => entry.name === name);
  if (session === undefined) throw new Error(`no fixture session ${name}`);
  const source = join(FIXTURES_DIR, session.transcript);
  const projectDir = join(sandbox.config, "projects", session.project);
  await mkdir(projectDir, { recursive: true });
  const target = join(projectDir, `${session.sessionId}.jsonl`);
  await cp(source, target);
  const subDir = join(dirname(source), session.sessionId);
  if (existsSync(subDir))
    await cp(subDir, join(projectDir, session.sessionId), { recursive: true });
  return target;
}

/** Copy every fixture session into the sandbox. */
export async function copyAllFixtures(sandbox: Sandbox): Promise<void> {
  for (const session of fixtureSessions()) await copyFixtureSession(sandbox, session.name);
}

/** Sessions under the sandbox's config folder, from the Claude Code adapter. */
export function sandboxSessions(sandbox: Sandbox): Promise<readonly SessionRef[]> {
  return listSessions([sandbox.root], [claudeCodeAdapter]);
}

/** Every transcript file under a folder, recursively. */
export async function transcriptFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await transcriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

/** A direct count of the complete, non-blank lines of every transcript under a folder. */
export async function directLineCount(dir: string): Promise<number> {
  let count = 0;
  for (const file of await transcriptFiles(dir)) {
    const text = await readFile(file, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    count += complete.split("\n").filter((line) => line.trim() !== "").length;
  }
  return count;
}

/** The raw bytes of the store's database and the files SQLite keeps beside it. */
export async function rawStoreBytes(dataDir: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const name of await readdir(dataDir)) {
    if (name.startsWith("history.sqlite")) parts.push(await readFile(join(dataDir, name)));
  }
  return Buffer.concat(parts);
}

/** The raw bytes of every file under a folder (transcripts and meta files), recursively. */
export async function rawSourceBytes(dir: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(await rawSourceBytes(path));
    else if (entry.isFile()) parts.push(await readFile(path));
  }
  return Buffer.concat(parts);
}

/** A child Node process running `script` (ES module source) with the sandbox environment. */
export function spawnNode(
  script: string,
  args: readonly string[] = [],
  nodeFlags: readonly string[] = [],
): ChildProcess {
  return spawn(process.execPath, [...nodeFlags, "--input-type=module", "-e", script, ...args], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Wait until a child writes `marker` on stdout. Rejects when it exits first. */
export function waitForOutput(
  child: ChildProcess,
  marker: string,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${marker}: ${err}`)),
      timeoutMs,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes(marker)) {
        clearTimeout(timer);
        resolveOutput(out);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!out.includes(marker))
        reject(new Error(`child exited (${code}) before ${marker}: ${err}`));
    });
  });
}

/** Wait for a child to exit; resolves with its exit code and output. */
export function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
  return new Promise((resolveExit) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("exit", (code, signal) => resolveExit({ code, signal, out, err }));
  });
}

/** Fail clearly when the built files the child-process tests need are missing. */
export function requireDist(): void {
  if (!existsSync(DIST_NODE_ENTRY) || !existsSync(DIST_WORKER)) {
    throw new Error(
      "packages/core/dist is missing: run `npm run build` at the repository root first.",
    );
  }
}
