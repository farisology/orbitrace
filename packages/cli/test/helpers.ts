/**
 * Test helpers: a fake machine in a temporary folder (an empty home folder and a Claude Code
 * config folder written from the synthetic fixtures), and a runner for the built binary.
 *
 * Nothing here reads the real home folder or config folder: the child process gets a fresh
 * environment that names only the temporary folders.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FOLDER,
  SCENARIO_NAMES,
  fixturePaths,
  writeFixtureTree,
  type ScenarioName,
} from "@orbitrace/fixtures";

/** The built entry of the command. `npm test` at the root builds before testing. */
export const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const created: string[] = [];

/** A new empty folder under the system's temporary folder (real path, no symlinks). */
export function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-cli-")));
  created.push(dir);
  return dir;
}

/** Remove every folder makeTempDir created. Call from afterEach or afterAll. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Every file below `dir`. */
function allFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(path));
    else found.push(path);
  }
  return found;
}

/** Fixed base time for file times, so the session order does not depend on the clock. */
export const BASE_TIME_MS = Date.UTC(2026, 0, 15, 9, 0, 0);

/**
 * Write the synthetic fixture tree into `fixturesDir` and set file times so that the sessions
 * are ordered as in `order`: the last name is the newest. Files of sessions not named (and
 * every other file) get an older time. Returns the config folder.
 */
export function writeOrderedFixtures(
  fixturesDir: string,
  order: readonly ScenarioName[] = SCENARIO_NAMES,
): string {
  writeFixtureTree(fixturesDir);
  const configDir = join(fixturesDir, CONFIG_FOLDER);
  const old = new Date(BASE_TIME_MS - 86_400_000);
  for (const file of allFiles(configDir)) utimesSync(file, old, old);
  order.forEach((name, index) => {
    const time = new Date(BASE_TIME_MS + index * 60_000);
    const paths = fixturePaths(name, fixturesDir);
    utimesSync(paths.transcript, time, time);
    for (const subagent of paths.subagents) {
      utimesSync(subagent.transcript, time, time);
      utimesSync(subagent.meta, time, time);
    }
  });
  return configDir;
}

export interface FakeMachine {
  /** The temporary folder that holds everything below. */
  readonly root: string;
  /** An empty home folder: its default config folder does not exist. */
  readonly home: string;
  /** The folder the fixtures were written to. */
  readonly fixturesDir: string;
  /** A Claude Code config folder with the synthetic sessions. */
  readonly configDir: string;
}

/** A temporary home folder and a config folder with the fixtures, outside the home folder. */
export function makeFakeMachine(order?: readonly ScenarioName[]): FakeMachine {
  const root = makeTempDir();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const fixturesDir = join(root, "fixtures");
  const configDir = writeOrderedFixtures(fixturesDir, order);
  return { root, home, fixturesDir, configDir };
}

/**
 * A process environment that names only `home`: HOME, USERPROFILE, APPDATA and XDG_CONFIG_HOME
 * all point inside it, so neither the default config folder nor the desktop app folders of the
 * person running the tests are found. Only PATH (and SystemRoot on Windows) are copied.
 */
export function fakeEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    TZ: "UTC",
    ...extra,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return env;
}

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the built binary with `args` in a fresh environment. `file` runs another path to it
 * instead, for example a symlink like the one npm makes for a bin.
 */
export function runBin(
  args: readonly string[],
  options: {
    readonly home: string;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly file?: string;
  },
): CliRun {
  const result = spawnSync(process.execPath, [options.file ?? BIN, ...args], {
    cwd: options.cwd ?? options.home,
    env: fakeEnv(options.home, options.env),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
