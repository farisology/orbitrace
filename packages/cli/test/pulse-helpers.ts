/**
 * Helpers for the `orbitrace pulse` tests (#27): a fake machine whose host points HOME,
 * USERPROFILE, CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR at temporary folders before any call, an
 * in-process runner with a fixed clock, and a synthetic session with marker strings planted in
 * every place a transcript holds content.
 *
 * Nothing here reads the real home folder or config folder, and no real data folder is created.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { historyCapability, withoutSqliteWarning } from "@orbitrace/core/node";
import { generateSession, type GeneratedSession } from "@orbitrace/fixtures";
import { run, type CliIo, type CliRuntime } from "../src/cli.js";
import type { HostContext } from "../src/sessions.js";
import { BASE_TIME_MS, makeFakeMachine, type FakeMachine } from "./helpers.js";

/** Core's built history worker. `npm test` at the root builds core first. */
const CORE_WORKER = fileURLToPath(new URL("../../core/dist/history/worker.js", import.meta.url));

const probe = await withoutSqliteWarning(historyCapability);
/** Whether `node:sqlite` loads in this Node (history needs it). */
export const SQLITE_AVAILABLE = probe.available;
/** Appended to the name of a suite that needs node:sqlite: the skip reason, or nothing. */
export const SQLITE_NOTE = probe.available ? "" : ` (skipped: ${probe.reason})`;

/** The fixed clock of the in-process runs: one day after the fixture file times. */
export const NOW_MS = BASE_TIME_MS + 86_400_000;

export interface PulseMachine extends FakeMachine {
  /** The data folder (ORBITRACE_DATA_DIR). Never created by these tests unless they ingest. */
  readonly data: string;
  readonly host: HostContext;
}

/** A fake machine with the fixture sessions and a host whose every folder is temporary. */
export function makePulseMachine(order?: Parameters<typeof makeFakeMachine>[0]): PulseMachine {
  const machine = makeFakeMachine(order);
  const data = join(machine.root, "data");
  const host: HostContext = {
    platform: process.platform,
    homeDir: machine.home,
    env: {
      HOME: machine.home,
      USERPROFILE: machine.home,
      CLAUDE_CONFIG_DIR: machine.configDir,
      ORBITRACE_DATA_DIR: data,
    },
    cwd: machine.root,
  };
  return { ...machine, data, host };
}

/** The runtime of the in-process runs: core's built worker, no terminal, the fixed clock. */
export function pulseRuntime(now = NOW_MS): CliRuntime {
  return {
    history: { workerUrl: pathToFileURL(CORE_WORKER), terminal: { stdin: false, stderr: false } },
    now: () => now,
  };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `orbitrace <argv>` in-process and collect its output. */
export async function runCli(
  argv: readonly string[],
  host: HostContext,
  runtime: CliRuntime = pulseRuntime(),
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await run(argv, io, host, runtime);
  return { code, stdout, stderr };
}

/** One JSON document on one line. */
export function oneJson<T = unknown>(text: string): T {
  if (!text.endsWith("\n") || text.trimEnd().includes("\n")) {
    throw new Error("expected exactly one JSON line");
  }
  return JSON.parse(text) as T;
}

/** Whether anything Orbitrace keeps exists: the data folder, or `.orbitrace` in the home folder. */
export function orbitraceFilesExist(machine: PulseMachine): boolean {
  return existsSync(machine.data) || existsSync(join(machine.home, ".orbitrace"));
}

/** The committed fixture manifest's facts, by scenario name. */
export interface ManifestFacts {
  name: string;
  project: string;
  expected: {
    agents: { firstTimestamp: string; lastTimestamp: string }[];
    totals: {
      replies: number;
      toolCalls: number;
      failedToolCalls: number;
      unfinishedToolCalls: number;
      mcpToolCalls: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    };
  };
}

export function readManifest(fixturesDir: string): ManifestFacts[] {
  return (
    JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")) as {
      sessions: ManifestFacts[];
    }
  ).sessions;
}

/** Time of a fixture session's first line, across its transcripts, epoch milliseconds. */
export function firstOf(facts: ManifestFacts): number {
  return Math.min(...facts.expected.agents.map((a) => Date.parse(a.firstTimestamp)));
}

/** Time of a fixture session's last line, across its transcripts, epoch milliseconds. */
export function lastOf(facts: ManifestFacts): number {
  return Math.max(...facts.expected.agents.map((a) => Date.parse(a.lastTimestamp)));
}

/** Real length of a fixture session: last line minus first line, in milliseconds. */
export function spanOf(facts: ManifestFacts): number {
  return lastOf(facts) - firstOf(facts);
}

/** Every line of a text output is at most this wide, with no trailing space. */
export const TEXT_WIDTH = 80;

/** The marker planted in a session's content. Never part of a legitimate Pulse output. */
export const MARKER = "PULSE-CANARY-7f3e";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Keys whose string values are content: prompts, replies, thinking, outputs, paths. */
const CONTENT_KEYS = new Set(["text", "thinking", "content", "cwd", "description", "gitBranch"]);

/**
 * Plant `MARKER` in every content string below `value`: a string under a content key (a user
 * prompt or tool output given as a string, a text or thinking block, the working folder, a
 * subagent description) and every string of a tool input. Structural strings (block types, ids,
 * tool names, timestamps) are left alone so the session still parses the same.
 */
function plant(value: Json, key: string | null, inInput: boolean): Json {
  if (typeof value === "string") {
    return inInput || (key !== null && CONTENT_KEYS.has(key)) ? `${value} ${MARKER}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => plant(item, null, inInput));
  if (value === null || typeof value !== "object") return value;
  const out: { [name: string]: Json } = {};
  for (const [name, child] of Object.entries(value)) {
    out[name] = plant(child, name, inInput || name === "input");
  }
  return out;
}

/**
 * A generated synthetic session with `MARKER` in its prompts, replies, thinking, tool inputs,
 * tool outputs, working folder (so in its project name) and subagent descriptions.
 */
export function markedSession(): GeneratedSession {
  const session = generateSession("tool-failures", { seed: "pulse-canary" });
  return {
    ...session,
    files: session.files.map((file) => {
      if (file.path.endsWith(".jsonl")) {
        const lines = file.content
          .split("\n")
          .map((line) =>
            line.trim() === ""
              ? line
              : JSON.stringify(plant(JSON.parse(line) as Json, null, false)),
          );
        return { ...file, content: lines.join("\n") };
      }
      if (file.path.endsWith(".meta.json")) {
        return {
          ...file,
          content: JSON.stringify(plant(JSON.parse(file.content) as Json, null, false)),
        };
      }
      return file;
    }),
  };
}
