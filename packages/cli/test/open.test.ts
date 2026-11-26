/**
 * `orbitrace open` in-process: a fake host over the synthetic fixture tree, a synthetic app
 * folder, a stand-in browser opener and an AbortController as Ctrl+C. Nothing opens a real
 * browser and nothing reads the real config folder.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSessions, toSessionSummary, type SessionSummary } from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import { writeFixtureTree, CONFIG_FOLDER } from "@orbitrace/fixtures";
import { run, type CliIo } from "../src/cli.js";
import { CLI_EXIT_CODES } from "../src/errors.js";
import { processStopSignal } from "../src/index.js";
import { runOpen, waitForStop, type OpenRuntime } from "../src/open.js";
import type { BrowserOpenResult } from "../src/server/browser.js";
import type { LoopbackServer } from "../src/server/server.js";
import { createReplayer, rootsOnEveryListing, type HostContext } from "../src/sessions.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";
import {
  connectionRefused,
  fixtureSessions,
  makeAppFolder,
  rpc,
  type AppFolder,
  type FixtureSessions,
} from "./server-helpers.js";

let app: AppFolder;
let fixtures: FixtureSessions;
let summaries: readonly SessionSummary[];

beforeAll(async () => {
  app = makeAppFolder();
  fixtures = await fixtureSessions();
  summaries = (await listSessions(fixtures.roots, [claudeCodeAdapter])).map(toSessionSummary);
});

afterAll(() => {
  removeTempDirs();
});

interface OpenRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly opened: string[];
  /** How many times the stand-in opener's `close` ran (the launcher page removal). */
  readonly closed: number;
  readonly server: LoopbackServer | undefined;
}

/**
 * Run `orbitrace <argv>` in-process. `whileRunning` gets the listening server; when it returns,
 * the run is stopped as Ctrl+C would.
 */
async function openWith(
  argv: string[],
  options: {
    host?: HostContext;
    browser?: BrowserOpenResult;
    appDir?: string | null;
    whileRunning?: (server: LoopbackServer) => Promise<void>;
  } = {},
): Promise<OpenRun> {
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
  const opened: string[] = [];
  let closed = 0;
  const controller = new AbortController();
  let listening: LoopbackServer | undefined;
  let during: Promise<void> = Promise.resolve();
  const runtime: OpenRuntime = {
    stopSignal: controller.signal,
    appDir: options.appDir === undefined ? app.appDir : options.appDir,
    openBrowser: async (link) => {
      opened.push(link);
      return {
        result: options.browser ?? "opened",
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
    },
    onListening: (server) => {
      listening = server;
      during = (options.whileRunning?.(server) ?? Promise.resolve()).finally(() =>
        controller.abort(),
      );
    },
  };
  const code = await run(argv, io, options.host ?? fixtures.host, runtime);
  await during;
  return { code, stdout, stderr, opened, closed, server: listening };
}

const configArgs = (): string[] => ["--config-dir", fixtures.machine.configDir];

describe("orbitrace open", () => {
  it("serves the newest session, opens the browser, answers with the token and stops on Ctrl+C", async () => {
    let listed: unknown;
    const result = await openWith(["open", ...configArgs()], {
      whileRunning: async (server) => {
        const reply = await rpc(server.port, server.token, {
          id: 1,
          method: "listSessions",
          params: {},
        });
        listed = JSON.parse(reply.body);
      },
    });
    expect(result.code).toBe(0);
    const server = result.server as LoopbackServer;
    const newest = (summaries[0] as SessionSummary).key;
    expect(result.stdout).toBe(`${server.link(newest)}\n`);
    expect(result.opened).toEqual([server.link(newest)]);
    expect(result.closed).toBe(1);
    expect(result.stderr).toContain(`serving on ${server.origin}`);
    expect(result.stderr).toContain("do not share it");
    expect(result.stderr).toContain("Opened the link in your default browser.");
    expect(result.stderr).toContain("Press Ctrl+C to stop.");
    expect(result.stderr).toContain("Stopped the local server.");
    expect(result.stderr).not.toContain(server.token);
    expect(listed).toEqual({ kind: "result", id: 1, result: summaries });
    expect(await connectionRefused("127.0.0.1", server.port)).toBe(true);
  });

  it("is what a bare orbitrace runs", async () => {
    const host: HostContext = {
      ...fixtures.host,
      env: { CLAUDE_CONFIG_DIR: fixtures.machine.configDir },
    };
    const result = await openWith([], { host });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${result.server?.link((summaries[0] as SessionSummary).key)}\n`);
    expect(result.opened).toHaveLength(1);
  });

  it("prints one JSON document with --json and skips the browser with --no-browser", async () => {
    const key = (summaries[1] as SessionSummary).key;
    const prefix = key.slice(0, "claude-code:".length + 8);
    const result = await openWith(["open", prefix, "--no-browser", "--json", ...configArgs()]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.opened).toEqual([]);
    expect(result.closed).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const server = result.server as LoopbackServer;
    expect(JSON.parse(lines[0] as string)).toEqual({
      url: server.link(key),
      origin: server.origin,
      port: server.port,
      key,
      browser: "skipped",
      warnings: [],
    });
  });

  it("says so when the browser could not be opened", async () => {
    const result = await openWith(["open", "--latest", ...configArgs()], { browser: "failed" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Could not open a browser. Open the link yourself.");
  });

  it("opens the session list when no session is found, and fails with --latest", async () => {
    const empty: HostContext = { ...fixtures.host, homeDir: makeTempDir() };
    const list = await openWith(["open", "--no-browser"], { host: empty });
    expect(list.code).toBe(0);
    expect(list.stdout).toBe(`${list.server?.link()}\n`);
    expect(list.stdout).not.toContain("key=");

    const latest = await openWith(["open", "--latest", "--json"], { host: empty });
    expect(latest.code).toBe(CLI_EXIT_CODES["no-sessions"]);
    expect(latest.server).toBeUndefined();
    expect(JSON.parse(latest.stderr)).toMatchObject({ error: { code: "no-sessions" } });
  });

  it("fails before listening for an unknown key, a missing app and a port in use", async () => {
    const unknown = await openWith(["open", "claude-code:ffffffff", ...configArgs()]);
    expect(unknown.code).toBe(CLI_EXIT_CODES["not-found"]);
    expect(unknown.server).toBeUndefined();

    const noApp = await openWith(["open", ...configArgs()], { appDir: null });
    expect(noApp.code).toBe(CLI_EXIT_CODES["app-missing"]);
    expect(noApp.stderr).toContain("[app-missing]");

    let busyPort = 0;
    const holder = await openWith(["open", "--no-browser", ...configArgs()], {
      whileRunning: async (server) => {
        busyPort = server.port;
        const clash = await openWith([
          "open",
          "--no-browser",
          "--port",
          String(server.port),
          "--json",
          ...configArgs(),
        ]);
        expect(clash.code).toBe(CLI_EXIT_CODES["port-unavailable"]);
        expect(JSON.parse(clash.stderr)).toMatchObject({
          error: { code: "port-unavailable", hint: "Leave out --port to use a free port." },
        });
      },
    });
    expect(holder.code).toBe(0);
    expect(busyPort).toBeGreaterThan(0);
  });

  it("warns about a --config-dir folder that cannot be read", async () => {
    const result = await openWith([
      "open",
      "--no-browser",
      "--config-dir",
      "missing-folder",
      ...configArgs(),
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "orbitrace: warning: The folder given with --config-dir was not found or cannot be read: missing-folder",
    );
  });

  it("runOpen runs the parsed command directly", async () => {
    const controller = new AbortController();
    const out: string[] = [];
    const code = await runOpen(
      {
        kind: "open",
        json: true,
        sources: { configDirs: [fixtures.machine.configDir], extraRoots: false },
        latest: true,
        browser: false,
      },
      { stdout: (text) => out.push(text), stderr: (text) => out.push(text) },
      fixtures.host,
      { appDir: app.appDir, stopSignal: controller.signal, onListening: () => controller.abort() },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ browser: "skipped" });
  });
});

describe("stopping", () => {
  it("waitForStop resolves when the signal aborts, at once when it already has", async () => {
    const controller = new AbortController();
    let stopped = false;
    const waiting = waitForStop(controller.signal).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    controller.abort();
    await waiting;
    expect(stopped).toBe(true);
    await waitForStop(controller.signal);
  });

  it("waitForStop without a signal resolves on SIGINT and removes its listeners", async () => {
    const before = process.listeners("SIGINT");
    const waiting = waitForStop();
    const added = process.listeners("SIGINT").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    await waiting;
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("processStopSignal aborts on the first SIGINT", () => {
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    const signal = processStopSignal();
    const added = process.listeners("SIGINT").filter((listener) => !beforeInt.includes(listener));
    try {
      expect(signal.aborted).toBe(false);
      (added[0] as (signal: NodeJS.Signals) => void)("SIGINT");
      expect(signal.aborted).toBe(true);
    } finally {
      for (const listener of added) process.off("SIGINT", listener);
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(listener)) process.off("SIGTERM", listener);
      }
    }
  });
});

describe("rootsOnEveryListing", () => {
  it("finds a config folder that appears after the replayer was made", async () => {
    const base = makeTempDir();
    const configDir = join(base, CONFIG_FOLDER);
    const host: HostContext = { platform: process.platform, homeDir: base, env: {}, cwd: base };
    const replayer = createReplayer(
      rootsOnEveryListing(host, { configDirs: [configDir], extraRoots: false }),
    );
    expect(await replayer.list()).toEqual([]);
    writeFixtureTree(base);
    expect((await replayer.list()).length).toBeGreaterThan(0);
  });
});
