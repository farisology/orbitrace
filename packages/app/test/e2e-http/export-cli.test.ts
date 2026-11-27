// @vitest-environment node
/**
 * End to end (issue 168): exporting from the app writes the same bytes as `orbitrace export`.
 *
 * For every synthetic session of the fixture tree, the app reads the replay the way its browser
 * tab does (its HTTP transport against the real loopback server of the built `orbitrace` command)
 * and makes the file with `makeReplayFile`, the function behind the Export dialog. The command
 * line writes the same session with `orbitrace export <key>`. With no option chosen the two are
 * equal byte for byte; with every option chosen they are equal to the command run with
 * `--opaque-names --round-times 0.1 --bucket-tokens`.
 *
 * Privacy: every child process gets the sandbox's environment (see `cli-server.ts`): `HOME` and
 * `CLAUDE_CONFIG_DIR` name a temporary folder with a synthetic config tree, set before the process
 * starts, so the real home and config folders are never read. Skipped on Windows, like the other
 * end-to-end tests of this transport.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionSummary } from "@orbitrace/core";
import { DEFAULT_EXPORT_CHOICES, makeReplayFile } from "../../src/export-replay";
import { createHttpTransport, type FetchFunction } from "../../src/http-transport";
import { chooseHost } from "../../src/startup";
import type { HostTransport } from "../../src/transport";
import {
  CLI_BIN,
  createSandbox,
  killIfRunning,
  removeSandbox,
  sandboxEnv,
  startCli,
  type RunningCli,
  type Sandbox,
} from "./cli-server";

/** Node's `fetch` against the server's origin (the transport sends origin-relative paths). */
function fetchAt(origin: string): FetchFunction {
  return (path, init) => fetch(new URL(path, origin), init);
}

/** What `orbitrace export <key> [flags]` writes to stdout, in the sandbox. */
function cliExport(sandbox: Sandbox, key: string, flags: readonly string[] = []): string {
  const result = spawnSync(process.execPath, [CLI_BIN, "export", key, ...flags], {
    cwd: sandbox.home,
    env: sandboxEnv(sandbox),
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`orbitrace export exited with ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

const ALL_CHOICES = { opaqueNames: true, roundTimes: true, roundStep: 0.1, bucketTokens: true };
const ALL_FLAGS = ["--opaque-names", "--round-times", "0.1", "--bucket-tokens"];

describe.skipIf(process.platform === "win32")(
  "exporting from the app writes what orbitrace export writes (issue 168)",
  { timeout: 120_000 },
  () => {
    let sandbox: Sandbox;
    let cli: RunningCli | undefined;
    let transport: HostTransport;
    let sessions: readonly SessionSummary[] = [];

    beforeAll(async () => {
      sandbox = createSandbox();
      cli = await startCli(sandbox);
      const url = new URL(cli.document.url);
      const choice = chooseHost({
        document: { querySelector: () => null },
        location: { hash: url.hash, pathname: url.pathname, search: url.search },
        history: { state: null, replaceState: () => {} },
      });
      if (choice.kind !== "browser") throw new Error(`chooseHost picked ${choice.kind}`);
      transport = createHttpTransport({
        token: choice.token,
        fetch: fetchAt(cli.document.origin),
      });
      sessions = await transport.listSessions();
    });

    afterAll(async () => {
      await killIfRunning(cli);
      removeSandbox(sandbox);
    });

    it("finds several synthetic sessions to compare", () => {
      expect(sessions.length).toBeGreaterThan(1);
    });

    it("with no option chosen: the same bytes for every fixture session", async () => {
      for (const session of sessions) {
        const model = await transport.loadReplay(session.key);
        const file = makeReplayFile(model, DEFAULT_EXPORT_CHOICES);
        expect(file.data).toBe(cliExport(sandbox, session.key));
        // The file name is the one core gives and names neither the session nor its project.
        expect(file.fileName).toBe("orbitrace.replay.json");
        expect(file.fileName).not.toContain(session.sessionId);
        expect(file.fileName).not.toContain(session.projectLabel);
      }
    });

    it("with every option chosen: the same bytes as the command's three flags", async () => {
      for (const session of sessions) {
        const model = await transport.loadReplay(session.key);
        const file = makeReplayFile(model, ALL_CHOICES);
        expect(file.data).toBe(cliExport(sandbox, session.key, ALL_FLAGS));
        expect(file.data).not.toBe(makeReplayFile(model, DEFAULT_EXPORT_CHOICES).data);
      }
    });
  },
);
