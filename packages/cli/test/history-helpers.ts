/**
 * Helpers for the history tests (#195): a fake machine whose host points HOME, USERPROFILE,
 * CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR at temporary folders before any call, the synthetic
 * fixture sessions in its config folder, and an in-process runner of the command.
 *
 * Nothing here reads the real home folder or config folder, and no real ~/.orbitrace is created:
 * the command reads its environment from the host only, and the worker gets the host's
 * environment and the temporary data folder.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { historyCapability, withoutSqliteWarning } from "@orbitrace/core/node";
import { run, type CliIo, type CliRuntime } from "../src/cli.js";
import type { HistoryRuntime } from "../src/history/context.js";
import type { HostContext } from "../src/sessions.js";
import { makeFakeMachine, type FakeMachine } from "./helpers.js";

/** Core's built worker entry. `npm test` at the root builds core first. */
export const CORE_WORKER = fileURLToPath(
  new URL("../../core/dist/history/worker.js", import.meta.url),
);

const probe = await withoutSqliteWarning(historyCapability);
/** Whether `node:sqlite` loads in this Node. */
export const SQLITE_AVAILABLE = probe.available;
/** Appended to the name of a suite that needs node:sqlite: the skip reason, or nothing. */
export const SKIP_NOTE = probe.available ? "" : ` (skipped: ${probe.reason})`;

export interface HistoryMachine extends FakeMachine {
  /** The data folder (ORBITRACE_DATA_DIR). Not created by the helper. */
  readonly data: string;
  readonly host: HostContext;
}

/** A fake machine with the fixture sessions, and a host whose every folder is temporary. */
export function makeHistoryMachine(): HistoryMachine {
  const machine = makeFakeMachine();
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

/** A history runtime with core's built worker and no terminal. */
export function historyRuntime(extra: HistoryRuntime = {}): HistoryRuntime {
  return {
    workerUrl: pathToFileURL(CORE_WORKER),
    terminal: { stdin: false, stderr: false },
    ...extra,
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
  runtime: CliRuntime = { history: historyRuntime() },
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
export function oneJson(text: string): unknown {
  if (!text.endsWith("\n") || text.trimEnd().includes("\n")) {
    throw new Error("expected exactly one JSON line");
  }
  return JSON.parse(text) as unknown;
}

/** Whether anything Orbitrace keeps exists: the data folder, or `.orbitrace` in the home folder. */
export function orbitraceFilesExist(machine: HistoryMachine): boolean {
  return existsSync(machine.data) || existsSync(join(machine.home, ".orbitrace"));
}

/** The names in the data folder, sorted; empty when it does not exist. */
export function dataFiles(machine: HistoryMachine): string[] {
  return existsSync(machine.data) ? readdirSync(machine.data).sort() : [];
}
