/**
 * #188, #195: the built command finds its history worker beside itself, from a copy of the
 * package's files in a temporary folder outside the repository (as an installed package is laid
 * out, with no workspace to resolve anything from), and where `node:sqlite` is missing every
 * history command that needs the store exits with 13 while `disable`, `where` and `delete --all`
 * still run. Child processes get a fresh environment that names temporary folders
 * only; the fixture sessions are synthetic.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HISTORY_ACTIONS } from "../src/args.js";
import { BIN, fakeEnv, makeFakeMachine, removeTempDirs, runBin } from "./helpers.js";
import { SKIP_NOTE, SQLITE_AVAILABLE } from "./history-helpers.js";

afterAll(() => {
  removeTempDirs();
});

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const WORKER = join(PACKAGE_DIR, "dist", "history-worker.js");

/** A copy of the package's command files (no app) in a temporary folder outside the repository. */
function installedCopy(root: string, withWorker: boolean): string {
  const dir = join(root, "node_modules", "orbitrace");
  mkdirSync(join(dir, "dist"), { recursive: true });
  copyFileSync(join(PACKAGE_DIR, "package.json"), join(dir, "package.json"));
  copyFileSync(BIN, join(dir, "dist", "index.js"));
  if (withWorker) copyFileSync(WORKER, join(dir, "dist", "history-worker.js"));
  return join(dir, "dist", "index.js");
}

/** Whether this Node accepts `--no-experimental-sqlite` (it turns `node:sqlite` off). */
function acceptsNoSqliteFlag(): boolean {
  const probe = spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", ""], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return probe.status === 0;
}

describe("the built history worker", () => {
  it("is shipped beside the command", () => {
    expect(existsSync(WORKER)).toBe(true);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history from an installed copy${SKIP_NOTE}`, () => {
  it("finds the worker beside the command and records, with no SQLite warning on stderr", () => {
    const machine = makeFakeMachine();
    const data = join(machine.root, "data");
    const file = installedCopy(join(machine.root, "install"), true);
    const env = { CLAUDE_CONFIG_DIR: machine.configDir, ORBITRACE_DATA_DIR: data };
    const result = runBin(["history", "ingest", "--json"], { home: machine.home, env, file });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const doc = JSON.parse(result.stdout) as { sessions: number; linesAdded: number };
    expect(doc.sessions).toBe(9);
    expect(doc.linesAdded).toBeGreaterThan(0);
    expect(readdirSync(data).sort()).toEqual(["history.sqlite"]);
    const list = runBin(["history", "list", "--json"], { home: machine.home, env, file });
    expect(list.status).toBe(0);
    expect((JSON.parse(list.stdout) as { sessions: unknown[] }).sessions).toHaveLength(9);
    const status = runBin(["history", "status"], { home: machine.home, env, file });
    expect(status.stderr).toBe("");
    expect(existsSync(join(machine.home, ".orbitrace"))).toBe(false);
  }, 60_000);

  it("says so, with history-failed, when the worker file is missing", () => {
    const machine = makeFakeMachine();
    const data = join(machine.root, "data");
    const file = installedCopy(join(machine.root, "install"), false);
    const env = { CLAUDE_CONFIG_DIR: machine.configDir, ORBITRACE_DATA_DIR: data };
    const result = runBin(["history", "ingest"], { home: machine.home, env, file });
    expect(result.status).toBe(15);
    expect(result.stderr).toContain("no history worker");
    expect(existsSync(data)).toBe(false);
  }, 30_000);
});

describe("history where node:sqlite is missing", () => {
  it("explains why and exits with 13 for each command that needs the store; disable, where and delete --all still run", () => {
    // On a Node with node:sqlite, turn it off with Node's own flag; on Node 20 it is missing.
    const flags = SQLITE_AVAILABLE ? ["--no-experimental-sqlite"] : [];
    if (SQLITE_AVAILABLE && !acceptsNoSqliteFlag()) return;
    const machine = makeFakeMachine();
    const data = join(machine.root, "data");
    const env = fakeEnv(machine.home, {
      CLAUDE_CONFIG_DIR: machine.configDir,
      ORBITRACE_DATA_DIR: data,
    });
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [...flags, BIN, ...args], {
        cwd: machine.home,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
    const needsStore: Record<string, readonly string[]> = {
      status: ["status"],
      enable: ["enable"],
      ingest: ["ingest"],
      list: ["list"],
      delete: ["delete", "claude-code:abcd", "--yes"],
    };
    const statuses: Record<string, number | null> = {};
    for (const [action, args] of Object.entries(needsStore)) {
      const result = run(["history", ...args]);
      statuses[action] = result.status;
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[history-unavailable]");
      expect(result.stderr).toContain("Node 22.13 or later");
    }
    expect(statuses).toEqual(Object.fromEntries(Object.keys(needsStore).map((a) => [a, 13])));
    expect(existsSync(data)).toBe(false);
    // The opt-out, the path and the delete need no node:sqlite.
    const noSqlite = {
      disable: ["disable"],
      where: ["where"],
      "delete --all": ["delete", "--all", "--yes"],
    };
    expect(new Set([...Object.keys(needsStore), "disable", "where"])).toEqual(
      new Set(HISTORY_ACTIONS),
    );
    for (const args of Object.values(noSqlite)) {
      const result = run(["history", ...args]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("history-unavailable");
    }
    expect(existsSync(data)).toBe(false);
    // Recording on and a store, as a Node with node:sqlite leaves them (synthetic bytes).
    mkdirSync(data);
    writeFileSync(
      join(data, "settings.json"),
      `${JSON.stringify({ settings: 1, historyRecording: true })}\n`,
    );
    writeFileSync(join(data, "history.sqlite"), "synthetic");
    const disabled = run(["history", "disable", "--json"]);
    expect(disabled.status).toBe(0);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ recording: false, changed: true });
    const deleted = run(["history", "delete", "--all", "--yes", "--json"]);
    expect(deleted.status).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({
      all: true,
      deleted: true,
      sessions: null,
      recording: false,
    });
    expect(readdirSync(data)).toEqual(["settings.json"]);
    // Everything else still works.
    const list = run(["list", "--json"]);
    expect(list.status).toBe(0);
    expect((JSON.parse(list.stdout) as { sessions: unknown[] }).sessions).toHaveLength(9);
  }, 60_000);
});
