// @vitest-environment node
/**
 * End to end (#139): a followed session whose process exits without touching any file is reported
 * as ended. The app's HTTP transport talks to the real loopback server of the `orbitrace` command
 * (its built binary, see `cli-server.ts`), on a synthetic config tree in a temporary folder.
 * `HOME` and `CLAUDE_CONFIG_DIR` are set in the environment of every child process when it is
 * spawned, before any of its code runs, so the real home and config folders are never read.
 *
 * The session is marked running with a live registry entry (`sessions/<pid>.json`, invented
 * values) whose process id is a throwaway child process. The child is killed; neither the
 * registry entry nor any transcript is changed. The update that says `ended` can only come from
 * the server re-checking the process on its own.
 *
 * Skipped on Windows, like the other end-to-end test of this transport.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SessionSummary } from "@orbitrace/core";
import { fixturePaths } from "@orbitrace/fixtures";
import { createHttpTransport, type FetchFunction } from "../../src/http-transport";
import { chooseHost } from "../../src/startup";
import type { LiveUpdate } from "../../src/transport";
import {
  createSandbox,
  eventually,
  killIfRunning,
  removeSandbox,
  sandboxEnv,
  startCli,
  type RunningCli,
  type Sandbox,
} from "./cli-server";

const SCENARIO = "two-waves";

/** Node's `fetch` against the server's origin (the transport sends origin-relative paths). */
function fetchAt(origin: string): FetchFunction {
  return (path, init) => fetch(new URL(path, origin), init);
}

/** The token in the link the server prints, read the way the app reads it (`chooseHost`). */
function tokenFrom(link: string): string {
  const url = new URL(link);
  const choice = chooseHost({
    document: { querySelector: () => null },
    location: { hash: url.hash, pathname: url.pathname, search: url.search },
    history: { state: null, replaceState: () => {} },
  });
  if (choice.kind !== "browser") throw new Error(`chooseHost picked ${choice.kind}`);
  return choice.token;
}

/** Size and modified time of a file, to show it was not touched. */
function signature(file: string): string {
  const info = statSync(file);
  return `${info.size}:${info.mtimeMs}`;
}

describe.skipIf(process.platform === "win32")(
  "follow ends when the session's process exits without a file change (#139)",
  { timeout: 60_000 },
  () => {
    let sandbox: Sandbox;
    let owner: ChildProcess | undefined;
    let ownerExited: Promise<void>;
    let cli: RunningCli | undefined;

    beforeAll(() => {
      sandbox = createSandbox();
      // A process that does nothing until it is killed; it stands in for the session's runtime.
      owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: sandbox.home,
        env: sandboxEnv(sandbox),
        stdio: "ignore",
      });
      ownerExited = new Promise((resolve) => owner?.once("exit", () => resolve()));
    });

    afterAll(async () => {
      if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
        await ownerExited;
      }
      await killIfRunning(cli);
      removeSandbox(sandbox);
    });

    it("sends an update whose live status is ended after the process is killed", async () => {
      const pid = owner?.pid;
      if (pid === undefined) throw new Error("the throwaway process did not start");
      const paths = fixturePaths(SCENARIO, sandbox.fixturesDir);
      const registryDir = join(sandbox.configDir, "sessions");
      const registryFile = join(registryDir, `${pid}.json`);
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        registryFile,
        JSON.stringify({ pid, sessionId: paths.sessionId, status: "busy", updatedAt: Date.now() }),
      );

      cli = await startCli(sandbox);
      const token = tokenFrom(cli.document.url);
      const transport = createHttpTransport({ token, fetch: fetchAt(cli.document.origin) });
      const summary = (await transport.listSessions()).find(
        (session: SessionSummary) => session.sessionId === paths.sessionId,
      );
      expect(summary?.live).toBe("busy");

      const updates: LiveUpdate[] = [];
      const unsubscribe = transport.subscribe((summary as SessionSummary).key, (update) =>
        updates.push(update),
      );
      await eventually(() => updates.length >= 1);
      expect(updates[0]).toMatchObject({ type: "replay", live: "busy" });

      const before = [signature(registryFile), signature(paths.transcript)];
      owner?.kill("SIGKILL");
      // Reaped by this process, so the pid no longer answers a liveness check.
      await ownerExited;

      // The command's default check interval; generous for a loaded machine.
      await eventually(
        () => updates.some((update) => update.type === "replay" && update.live === "ended"),
        30_000,
      );
      const ended = updates.find((update) => update.type === "replay" && update.live === "ended");
      expect(ended).toBeDefined();
      expect(updates.every((update) => update.type === "replay")).toBe(true);
      // Nothing on disk changed: the registry entry and the transcript are as they were.
      expect([signature(registryFile), signature(paths.transcript)]).toEqual(before);
      expect(JSON.stringify(updates)).not.toContain(sandbox.root);
      unsubscribe();
    });
  },
);
