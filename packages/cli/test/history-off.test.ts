/**
 * #195: history is off by default. With recording off, no command creates the data folder, the
 * settings file or the database. Every command runs in-process against a fake machine whose
 * every folder (home, config, data) is temporary, and afterwards neither the data folder nor
 * `.orbitrace` in the home folder exists.
 *
 * The two commands whose purpose is to write are the exceptions, checked at the end:
 * `history enable` (the settings file) and `history ingest` (the store, on request).
 *
 * Runs on every Node: where `node:sqlite` is missing the history commands exit with 13, and
 * still create nothing.
 */
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listSessions } from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import type { CliRuntime } from "../src/cli.js";
import { removeTempDirs } from "./helpers.js";
import {
  historyRuntime,
  makeHistoryMachine,
  orbitraceFilesExist,
  runCli,
  SQLITE_AVAILABLE,
} from "./history-helpers.js";
import { makeAppFolder } from "./server-helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("with recording off", () => {
  it("no command creates the data folder, the settings file or the database", async () => {
    const machine = makeHistoryMachine();
    const [newest] = await listSessions(
      [
        {
          runtime: "claude-code",
          root: machine.configDir,
          resolvedBy: "user-setting",
          available: true,
        },
      ],
      [claudeCodeAdapter],
    );
    const key = newest!.key;
    const app = makeAppFolder();
    const openRuntime = (): CliRuntime => {
      const controller = new AbortController();
      return {
        history: historyRuntime(),
        appDir: app.appDir,
        stopSignal: controller.signal,
        openBrowser: () => Promise.resolve({ result: "opened", close: () => Promise.resolve() }),
        onListening: () => controller.abort(),
      };
    };
    const argvs: string[][] = [
      ["--version"],
      ["help"],
      ["help", "history"],
      ["history", "--help"],
      ["list"],
      ["list", "--json"],
      ["export", "--latest"],
      ["export", key, "-o", join(machine.root, "replay.json")],
      ["doctor"],
      ["doctor", "--json"],
      ["history", "status"],
      ["history", "status", "--json"],
      ["history", "where"],
      ["history", "list"],
      ["history", "list", "--json"],
      ["history", "disable"],
      ["history", "disable", "--json"],
      ["history", "delete", key, "--yes"],
      ["history", "delete", "--all", "--yes"],
      ["history", "delete", "--all"],
    ];
    // The commands after which something existed, and those that failed unexpectedly.
    const created: string[] = [];
    const crashed: string[] = [];
    for (const argv of argvs) {
      const result = await runCli(argv, machine.host, { history: historyRuntime() });
      if (result.code === 1) crashed.push(argv.join(" "));
      if (orbitraceFilesExist(machine)) created.push(argv.join(" "));
    }
    const opened: number[] = [];
    for (const argv of [["open", "--no-browser"], ["open", key, "--json"], []]) {
      const result = await runCli(argv, machine.host, openRuntime());
      opened.push(result.code);
      if (orbitraceFilesExist(machine)) created.push(`open ${argv.join(" ")}`);
    }
    expect(created).toEqual([]);
    expect(crashed).toEqual([]);
    expect(opened).toEqual([0, 0, 0]);
  }, 60_000);

  it.skipIf(!SQLITE_AVAILABLE)(
    "only enable (the settings file) and ingest (the store) write, because that is what they are for",
    async () => {
      const machine = makeHistoryMachine();
      expect((await runCli(["history", "ingest"], machine.host)).code).toBe(0);
      expect(orbitraceFilesExist(machine)).toBe(true);
      const other = makeHistoryMachine();
      expect((await runCli(["history", "enable"], other.host)).code).toBe(0);
      expect(orbitraceFilesExist(other)).toBe(true);
    },
    30_000,
  );
});
