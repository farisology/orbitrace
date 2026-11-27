/**
 * Helpers for the end-to-end test of the app's HTTP transport against the real loopback server
 * of the `orbitrace` command (#93).
 *
 * The command runs as its built binary, as a child process, so the app takes no dependency on
 * the CLI package: `orbitrace` already lists `@orbitrace/app` as a dev dependency, and the
 * reverse would be a workspace cycle that `scripts/run-workspaces.mjs` refuses. The binary is
 * found through the `orbitrace` package's name and the bin its manifest names, not through the
 * CLI's folder layout (#213). `npm test` at the repository root builds every package before any
 * test runs.
 *
 * Privacy: the child gets a fresh environment that names only a temporary folder. `HOME` (and
 * its Windows and XDG equivalents) is an empty folder there, and `CLAUDE_CONFIG_DIR` is a
 * synthetic config tree written there by `@orbitrace/fixtures`. Both are set when the process is
 * spawned, before any of its code runs, so the real home folder and config folder of the person
 * running the tests are never read.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FOLDER, writeFixtureTree } from "@orbitrace/fixtures";

/** The package that ships the `orbitrace` command, and the name of its bin. */
export const CLI_PACKAGE = "orbitrace";

/**
 * The file a package's manifest names as its `bin` called `name` (a string `bin` names the
 * package's only command), resolved from `require`'s location. Throws when the package is not
 * found or names no such bin. The file itself need not exist yet.
 */
export function resolvePackageBin(require: NodeJS.Require, pkg: string, name: string): string {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (bin === undefined) throw new Error(`The ${pkg} package names no "${name}" bin.`);
  return join(dirname(manifestPath), bin);
}

/** The built entry of the `orbitrace` command: the `orbitrace` bin of the `orbitrace` package. */
export const CLI_BIN = resolvePackageBin(createRequire(import.meta.url), CLI_PACKAGE, CLI_PACKAGE);

/** A temporary machine: an empty home folder and a synthetic Claude Code config folder. */
export interface Sandbox {
  /** The temporary folder that holds everything below. */
  readonly root: string;
  /** An empty home folder. */
  readonly home: string;
  /** The folder `writeFixtureTree` wrote into. */
  readonly fixturesDir: string;
  /** The synthetic config folder, passed as `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string;
}

/** Write a fresh sandbox under the system's temporary folder (real path, no symlinks). */
export function createSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-e2e-http-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const fixturesDir = join(root, "fixtures");
  writeFixtureTree(fixturesDir);
  return { root, home, fixturesDir, configDir: join(fixturesDir, CONFIG_FOLDER) };
}

/** Delete a sandbox and everything in it. */
export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}

/**
 * The child's whole environment: only the sandbox's folders, plus `PATH` (and `SystemRoot` on
 * Windows) from this process. Nothing else is copied, so no `CLAUDE_CONFIG_DIR` or home folder
 * of the person running the tests reaches the child.
 */
export function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    APPDATA: join(sandbox.home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(sandbox.home, ".config"),
    CLAUDE_CONFIG_DIR: sandbox.configDir,
    TZ: "UTC",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** The document `orbitrace open --json` writes once its server listens. */
export interface OpenDocument {
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  readonly key: string | null;
  readonly browser: string;
  readonly warnings: readonly unknown[];
}

/** A running `orbitrace open`. */
export interface RunningCli {
  readonly child: ChildProcess;
  readonly document: OpenDocument;
  /** Resolves when the child has exited, with its exit code and everything it wrote. */
  readonly exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * Start `orbitrace open --no-browser --json` in the sandbox and resolve once it has printed its
 * document. Rejects when the binary is missing or the child exits first. No browser is opened.
 */
export function startCli(sandbox: Sandbox, timeoutMs = 20_000): Promise<RunningCli> {
  if (!existsSync(CLI_BIN)) {
    return Promise.reject(
      new Error("The orbitrace command is not built: run 'npm run build' at the root first."),
    );
  }
  const child = spawn(process.execPath, [CLI_BIN, "open", "--no-browser", "--json"], {
    cwd: sandbox.home,
    env: sandboxEnv(sandbox),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return new Promise<RunningCli>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("orbitrace open did not print its document in time"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve({ child, document: JSON.parse(stdout.slice(0, newline)) as OpenDocument, exit });
      } catch (error) {
        child.kill("SIGKILL");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`orbitrace open exited early with ${String(code)}: ${stderr}`));
    });
  });
}

/** SIGKILL the child if it is still running, and wait until it has exited. */
export async function killIfRunning(cli: RunningCli | undefined): Promise<void> {
  if (cli === undefined) return;
  const { child } = cli;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await cli.exit;
}

type JsonLine = Record<string, unknown>;

function hasToolUse(line: JsonLine): boolean {
  const message = line.message as { content?: unknown } | undefined;
  return (
    line.type === "assistant" &&
    Array.isArray(message?.content) &&
    message.content.some((part) => (part as { type?: unknown }).type === "tool_use")
  );
}

/**
 * Append one more tool call to a synthetic transcript: a copy of its last assistant line with a
 * tool call, with new invented ids, chained to the last line, one second after the latest
 * timestamp. Every value in it comes from the synthetic file or is invented here.
 */
export function appendToolCall(transcript: string, n = 1): void {
  const lines = readFileSync(transcript, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JsonLine);
  const template = [...lines].reverse().find(hasToolUse);
  const last = lines.at(-1);
  if (template === undefined || last === undefined) throw new Error("no tool call to copy");
  const message = template.message as { content: JsonLine[] };
  const tool = message.content.find((part) => part.type === "tool_use") as JsonLine;
  const times = lines
    .map((line) => (typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) throw new Error("no timestamp to follow");
  const line = {
    ...template,
    uuid: `00000000-0000-4000-8000-${String(930000000000 + n)}`,
    parentUuid: last.uuid,
    timestamp: new Date(Math.max(...times) + 1000).toISOString(),
    requestId: `req_synthetic_e2e_${n}`,
    message: {
      ...message,
      id: `msg_synthetic_e2e_${n}`,
      content: [{ ...tool, id: `toolu_synthetic_e2e_${n}` }],
    },
  };
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}

/** Resolve once `check` is true, polling every 25 ms; reject after `timeoutMs`. */
export async function eventually(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
